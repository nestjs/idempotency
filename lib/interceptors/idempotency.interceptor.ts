import {
  ClassSerializerInterceptor,
  Inject,
  Injectable,
  Logger,
  Optional,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ApplicationConfig, HttpAdapterHost, Reflector } from '@nestjs/core';
import { randomUUID } from 'node:crypto';
import { Observable, type Observer, type Subscription } from 'rxjs';
import {
  Unreplayable,
  type Capture,
  type IdempotencyContextAdapter,
  type IdempotencyRejection,
} from '../contexts/context.adapter.js';
import { GraphqlContextAdapter } from '../contexts/graphql.context.js';
import { HttpContextAdapter } from '../contexts/http.context.js';
import { RpcContextAdapter } from '../contexts/rpc.context.js';
import { ResponseCipher, plaintextCodec, type ResponseCodec } from '../utils/encryption.util.js';
import { UnreadableRecordError } from '../errors/unreadable-record.error.js';
import { IdempotencyEvents } from '../events/idempotency-events.service.js';
import type { IdempotencyEvent } from '../events/idempotency-events.interface.js';
import { canonicalJson, sha256 } from '../utils/fingerprint.util.js';
import type {
  IdempotencyAcquireResult,
  IdempotencyStore,
  IdempotencyStoredResponse,
} from '../interfaces/idempotency-store.interface.js';
import { IdempotencyStorage } from '../storage/idempotency.storage.js';
import { IDEMPOTENCY_MODULE_OPTIONS } from '../idempotency.module-definition.js';
import type { IdempotencyModuleOptions } from '../interfaces/idempotency-module-options.interface.js';
import type {
  IdempotencyContextType,
  IdempotencyKeySource,
  IdempotencyKeySources,
  IdempotencyScopeFn,
  IdempotentOptions,
} from '../interfaces/idempotent-options.interface.js';
import {
  DEFAULT_HEADER,
  DEFAULT_LOCK_TTL,
  DEFAULT_REPLAY_HEADERS,
  DEFAULT_RETRY_AFTER,
  DEFAULT_TTL,
  MAX_KEY_LENGTH,
  NEVER_REPLAYED_HEADERS,
  IDEMPOTENT_METADATA,
} from '../idempotency.constants.js';
import { withDurationsInMs } from '../decorators/idempotent.decorator.js';
import { UnreplayableResult } from '../errors/unreplayable-result.error.js';

/** Effective options for one handler; durations in ms. */
interface Resolved {
  required: boolean;
  ttl: number;
  lockTtl: number;
  retryAfter: number;
  storeIf: (status: number, error?: unknown) => boolean;
  scope: IdempotentOptions['scope'];
  fingerprint: IdempotentOptions['fingerprint'];
  keyFrom: IdempotentOptions['keyFrom'];
}

/** One keyed call: what the store and the events need to know about it. */
interface Call {
  adapter: IdempotencyContextAdapter;
  context: ExecutionContext;
  /** `ClassName.methodName`. */
  handler: string;
  key: string;
  scope?: string;
  storeKey: string;
}

type Plan =
  | { run: 'passthrough' }
  | { run: 'execute'; call: Call; owner: string }
  | { run: 'replay'; call: Call; response: IdempotencyStoredResponse };

/** Renews one lock until stopped. */
interface Renewal {
  /** A renewal found the lock gone, and said so (once per attempt: `complete()`/`release()` don't repeat it). */
  readonly lost: boolean;
  /** The outcome is being stored: a renewal refused from now on only means it was. */
  recording(): void;
  stop(): void;
}

const INVALID_KEY = Symbol('invalid key');
const PRINTABLE_ASCII = /^[\x20-\x7e]+$/;
/** The longest delay `setInterval()` takes; a longer one fires every 1 ms. */
const MAX_TIMEOUT = 2 ** 31 - 1;

@Injectable()
export class IdempotencyInterceptor
  implements NestInterceptor, OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger('IdempotencyModule');
  private readonly defaults: IdempotencyModuleOptions;
  private readonly header: string;
  private readonly adapters: Record<IdempotencyContextType, IdempotencyContextAdapter>;
  private readonly codec: ResponseCodec;
  /** Handlers already warned about, per topic: each warning is logged once. */
  private readonly warned = new Map<string, WeakSet<Function>>();
  /** Locks being renewed, stopped at shutdown. */
  private readonly renewals = new Set<Renewal>();

  constructor(
    @Inject(IDEMPOTENCY_MODULE_OPTIONS) options: IdempotencyModuleOptions,
    private readonly storage: IdempotencyStorage,
    private readonly events: IdempotencyEvents,
    private readonly reflector: Reflector,
    adapterHost: HttpAdapterHost,
    @Optional() private readonly appConfig?: ApplicationConfig,
  ) {
    // Everything that can be misconfigured fails here, at startup.
    assertOptions(options);
    this.defaults = withDurationsInMs(options, 'IdempotencyModule');
    this.header = (options.header ?? DEFAULT_HEADER).toLowerCase();

    const replayHeaders = [
      ...new Set(
        [...DEFAULT_REPLAY_HEADERS, ...(options.replayHeaders ?? [])].map((h) =>
          h.toLowerCase(),
        ),
      ),
    ];
    assertReplayHeaders(replayHeaders);

    this.adapters = {
      http: new HttpContextAdapter(adapterHost, replayHeaders),
      graphql: new GraphqlContextAdapter(),
      rpc: new RpcContextAdapter(),
    };

    this.codec = options.encryption
      ? new ResponseCipher(options.encryption)
      : plaintextCodec;
  }

  /** The registered store (or the in-memory default), read per call: never in the constructor. */
  private get store(): IdempotencyStore {
    return this.storage.source;
  }

  /** `release()` as a promise that rejects, even when the app's store throws synchronously. */
  private async releaseQuietly(key: string, owner: string): Promise<unknown> {
    return this.store.release(key, owner);
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const classOptions = this.reflector.get<IdempotentOptions | undefined>(
      IDEMPOTENT_METADATA,
      context.getClass(),
    );
    const handlerOptions = this.reflector.get<IdempotentOptions | undefined>(
      IDEMPOTENT_METADATA,
      context.getHandler(),
    );
    if (!classOptions && !handlerOptions) {
      return next.handle();
    }

    const adapter = this.adapters[context.getType<IdempotencyContextType>()];
    if (!adapter) {
      this.warnOnce(
        context,
        'unsupported',
        `@Idempotent() has no effect on ${handlerName(context)}: ` +
          `"${context.getType()}" handlers are not supported (http, graphql and rpc are).`,
      );
      return next.handle();
    }

    // A class-level decorator doesn't reach GET routes, queries and the like.
    if (!handlerOptions && !adapter.coveredByClass(context)) {
      return next.handle();
    }

    const passThrough = adapter.passThrough?.(context);
    if (passThrough) {
      this.warnOnce(
        context,
        'pass-through',
        `@Idempotent() has no effect on ${handlerName(context)}: ${passThrough}.`,
      );
      return next.handle();
    }

    const opts = this.resolve(classOptions, handlerOptions);

    return new Observable<unknown>((subscriber) => {
      let closed = false;
      let inner: Subscription | undefined;

      this.plan(adapter, context, opts).then(
        (plan) => {
          if (!closed) {
            try {
              inner = this.run(plan, next, opts).subscribe(subscriber);
            } catch (err) {
              subscriber.error(err);
            }
          } else if (plan.run === 'execute') {
            // Unsubscribed while the lock was being taken: nothing will run.
            this.releaseQuietly(plan.call.storeKey, plan.owner).catch((err) =>
              this.logger.error(`Could not release "${plan.call.storeKey}"`, err),
            );
          }
        },
        (err) => subscriber.error(err),
      );

      return () => {
        closed = true;
        inner?.unsubscribe();
      };
    });
  }

  /**
   * Global interceptors registered before this one (as `APP_INTERCEPTOR` in
   * the root module, or in a module imported first) run outside it: they
   * see a replay as well, and get the stored copy of the result, a plain
   * object, instead of what the handler returned. For most (logging,
   * metrics, an envelope) that makes no difference. A serializer that works
   * from the class, like `ClassSerializerInterceptor`, would send the fields
   * `@Exclude()` hides, so that setup fails here, at startup.
   */
  onApplicationBootstrap() {
    const globals = this.appConfig?.getGlobalInterceptors() ?? [];
    const position = globals.indexOf(this);
    if (position <= 0) {
      return;
    }

    const outside = globals.slice(0, position);
    const serializer = outside.find((i) => i instanceof ClassSerializerInterceptor);
    if (serializer) {
      throw new Error(
        `IdempotencyModule: ${serializer.constructor.name} runs outside IdempotencyInterceptor, ` +
          `because it was registered as a global interceptor first. A replay would hand it the ` +
          `stored plain object instead of the class instance, and send the fields @Exclude() ` +
          `hides. Register it with app.useGlobalInterceptors(), or as APP_INTERCEPTOR in a ` +
          `module imported after IdempotencyModule.`,
      );
    }

    const names = outside.map((i) => i.constructor.name).join(', ');
    this.logger.warn(
      `IdempotencyInterceptor runs inside ${names}, registered as global interceptors before ` +
        `it: replays pass through them too, with the stored copy of the result. To keep ` +
        `IdempotencyInterceptor outermost, register them with app.useGlobalInterceptors(), or ` +
        `in a module imported after IdempotencyModule.`,
    );
  }

  /**
   * In-flight calls that outlive the app stop renewing their locks, which
   * then expire after `lockTtl`, as after a crash. A call that still
   * finishes records its outcome as usual.
   */
  onApplicationShutdown() {
    for (const renewal of this.renewals) {
      renewal.stop();
    }
  }

  private run(plan: Plan, next: CallHandler, opts: Resolved): Observable<unknown> {
    switch (plan.run) {
      case 'passthrough':
        return next.handle();
      case 'replay':
        return plan.call.adapter.replay(plan.call.context, plan.response);
      case 'execute':
        return this.execute(plan.call, plan.owner, next, opts);
    }
  }

  private async plan(
    adapter: IdempotencyContextAdapter,
    context: ExecutionContext,
    opts: Resolved,
  ): Promise<Plan> {
    await adapter.prepare?.();

    const handler = handlerName(context);
    const reject = (rejection: IdempotencyRejection, call?: Pick<Call, 'key' | 'scope'>) => {
      this.events.emit({
        type: 'rejected',
        context: adapter.type,
        handler,
        code: rejection.code,
        status: rejection.status,
        ...(call && { key: call.key }),
        ...(call?.scope !== undefined && { scope: call.scope }),
      });
      return adapter.reject(context, rejection);
    };

    const key = normalizeKey(await this.readKey(adapter, context, opts.keyFrom));
    if (key === INVALID_KEY) {
      throw reject({
        code: 'IDEMPOTENCY_KEY_INVALID',
        status: 400,
        message: `The idempotency key must be 1 to ${MAX_KEY_LENGTH} printable ASCII characters.`,
      });
    }
    if (key === undefined) {
      if (!opts.required) {
        return { run: 'passthrough' };
      }
      throw reject({
        code: 'IDEMPOTENCY_KEY_REQUIRED',
        status: 400,
        message: 'An idempotency key is required for this operation.',
      });
    }

    const scopeFn = scopeFor(opts.scope, adapter.type);
    if (scopeFn === undefined) {
      this.warnIfUnscoped(adapter, context);
    }

    const { identity, payload } = adapter.describe(context);
    const [rawScope, selected] = await Promise.all([
      scopeFn ? scopeFn(adapter.target(context), context) : undefined,
      opts.fingerprint ? opts.fingerprint(payload, context) : payload,
    ]);
    const scope = normalizeScope(rawScope, handler);
    // The scope is hashed in too: a record that turns up under another
    // user's key (copied in the store) is a 422, not a replay.
    const fingerprint = sha256(scope ?? '', ...identity, canonicalJson(selected));

    const call: Call = {
      adapter,
      context,
      handler,
      key,
      scope,
      storeKey: storeKey(scope, key, adapter.keySuffix?.(context)),
    };

    const owner = randomUUID();
    let acquired: IdempotencyAcquireResult;
    try {
      acquired = await this.store.acquire(call.storeKey, owner, fingerprint, opts.lockTtl);
    } catch (err) {
      // The store may have taken the lock before its reply was lost. Releasing
      // it (it's owner-checked) spares the retry a wait of `lockTtl`.
      this.releaseQuietly(call.storeKey, owner).catch(() => {});
      throw err;
    }

    if (acquired.state === 'acquired') {
      return { run: 'execute', call, owner };
    }

    if (acquired.fingerprint !== fingerprint) {
      throw reject(
        {
          code: 'IDEMPOTENCY_KEY_REUSED',
          status: 422,
          message: 'This idempotency key was already used for a different request.',
        },
        call,
      );
    }

    if (acquired.state === 'in-flight') {
      throw reject(
        {
          code: 'IDEMPOTENCY_KEY_IN_USE',
          status: 409,
          message: 'A request with this idempotency key is still being processed.',
          retryAfter: Math.ceil(opts.retryAfter / 1000),
        },
        call,
      );
    }

    let response: IdempotencyStoredResponse;
    try {
      response = this.codec.open(call.storeKey, acquired.response);
    } catch (err) {
      if (!(err instanceof UnreadableRecordError)) {
        throw err;
      }
      // Fail closed: re-executing could repeat the side effect the record
      // proves already happened. The record expires with its ttl.
      this.logger.error(`${err.message} (key "${call.storeKey}")`);
      throw reject(
        {
          code: 'IDEMPOTENCY_RECORD_UNREADABLE',
          status: 500,
          message: 'The stored result for this idempotency key could not be read.',
        },
        call,
      );
    }

    this.emit(call, { type: 'replayed', status: response.status });
    return { run: 'replay', call, response };
  }

  /**
   * Runs the handler under the lock. The result is stored (or the key
   * released) before the caller gets it, so a retry that follows the
   * response always finds the record. Where only the last value reaches the
   * caller (HTTP, GraphQL), that value is the result. Where every value
   * does (a message handler's reply), several values are a stream: they go
   * out as they come, and nothing is stored.
   */
  private execute(
    call: Call,
    owner: string,
    next: CallHandler,
    opts: Resolved,
  ): Observable<unknown> {
    const { adapter, context } = call;

    return new Observable<unknown>((subscriber) => {
      const renewal = this.renew(call, owner, opts.lockTtl);
      let recorded: Promise<void> | undefined;
      /** Stores the outcome, or releases the key when there is none, exactly once. */
      const record = (outcome?: IdempotencyStoredResponse) =>
        (recorded ??= this.record(call, owner, outcome, opts.ttl, renewal));

      const outcomeOf = (capture: () => Capture): IdempotencyStoredResponse | undefined => {
        try {
          const captured = capture();
          if (captured instanceof Unreplayable) {
            this.warnUnreplayable(call, captured.reason);
          }
          return captured instanceof Unreplayable ? undefined : (captured ?? undefined);
        } catch (err) {
          if (err instanceof UnreplayableResult) {
            this.warnUnreplayable(call, err.message);
          } else {
            this.logger.error(`Could not capture the result for "${call.storeKey}"`, err as Error);
          }
          return undefined;
        }
      };

      let held: { value: unknown } | undefined;
      let streaming = false;
      let inner: Subscription | undefined;
      let stopped = false;
      const stopStream = () => {
        stopped = true;
        inner?.unsubscribe();
        void record();
      };

      const observer: Observer<unknown> = {
        next: (value) => {
          if (!adapter.sendsEveryValue || (!streaming && !held)) {
            held = { value };
            return;
          }
          if (!streaming) {
            streaming = true;
            this.warnUnreplayable(call, 'it emitted more than one value');
            subscriber.next(held!.value);
            held = undefined;
          }
          subscriber.next(value);
          if (subscriber.closed) {
            stopStream(); // the caller left before it was a stream
          }
        },
        error: (err) => {
          const outcome = streaming ? undefined : outcomeOf(() => adapter.captureError(err, opts));
          void record(outcome).then(() => subscriber.error(err));
        },
        complete: () => {
          if (streaming) {
            void record().then(() => subscriber.complete());
            return;
          }
          const outcome = held
            ? outcomeOf(() => adapter.captureSuccess(context, held!.value, opts))
            : outcomeOf(() => new Unreplayable('it completed without a value'));
          void record(outcome).then(() => {
            if (held) {
              subscriber.next(held.value);
            }
            subscriber.complete();
          });
        },
      };

      try {
        inner = next.handle().subscribe(observer);
      } catch (err) {
        observer.error(err);
      }

      if (stopped) {
        inner?.unsubscribe();
      }

      // If the caller goes away (a sibling event handler failed, say), a
      // single result keeps running, since a promise can't be cancelled, and
      // its outcome is still recorded. A stream stops, as it would without
      // this interceptor.
      return () => {
        if (streaming) {
          stopStream();
        }
      };
    });
  }

  private async record(
    call: Call,
    owner: string,
    outcome: IdempotencyStoredResponse | undefined,
    ttl: number,
    renewal: Renewal,
  ): Promise<void> {
    // Renewals go on until the store answers: a slow write mustn't let the
    // lock lapse, or a retry could run the handler a second time.
    renewal.recording();

    try {
      if (outcome) {
        const sealed = this.codec.seal(call.storeKey, outcome);
        const ok = await this.store.complete(call.storeKey, owner, sealed, ttl);
        if (!ok && !renewal.lost) {
          this.lockLost(call, 'complete', 'the result was not stored');
        }
      } else {
        const ok = await this.store.release(call.storeKey, owner);
        if (!ok && !renewal.lost) {
          this.lockLost(call, 'release', 'the key was not released');
        }
      }
    } catch (err) {
      // The side effect already happened; failing the request now would
      // invite the exact retry we are trying to make safe. The lock stays
      // until it expires, then a retry runs the handler again: operators
      // learn about it the way they learn about a lost lock.
      this.logger.error(`Idempotency store failed for "${call.storeKey}"`, err as Error);
      if (!renewal.lost) {
        this.emit(call, { type: 'lock-lost', phase: outcome ? 'complete' : 'release' });
      }
    } finally {
      renewal.stop();
    }
  }

  /**
   * Renews the lock every `lockTtl / 3`, one renewal at a time, until
   * stopped: a handler slower than `lockTtl` keeps its lock, and a retry gets
   * a 409 instead of running the handler a second time. The timer is
   * `unref()`'d, so it never keeps the process alive.
   */
  private renew(call: Call, owner: string, lockTtl: number): Renewal {
    let stopped = false;
    let recording = false;
    let pending = false;
    let lost = false;

    const beat = async () => {
      // One renewal at a time: a slow store skips beats instead of piling them up.
      if (pending) {
        return;
      }

      pending = true;
      try {
        const ok = await this.store.extend(call.storeKey, owner, lockTtl);
        if (!ok) {
          if (!stopped && !recording) {
            lost = true;
            this.logger.warn(
              `Lost the lock for "${call.storeKey}" while the handler was running; ` +
                `a retry may run it again. Check the store's availability and lockTtl.`,
            );
            this.emit(call, { type: 'lock-lost', phase: 'extend' });
          }
          renewal.stop();
        }
      } catch (err) {
        // Keep renewing: after a transient store error, the next renewal can
        // still land before the lock expires.
        if (!stopped) {
          this.logger.error(`Could not renew the lock for "${call.storeKey}"`, err as Error);
        }
      } finally {
        pending = false;
      }
    };

    const every = Math.min(Math.max(1, Math.floor(lockTtl / 3)), MAX_TIMEOUT);
    const timer = setInterval(() => void beat(), every);
    timer.unref();

    const renewal: Renewal = {
      get lost() {
        return lost;
      },
      recording: () => {
        recording = true;
      },
      stop: () => {
        stopped = true;
        clearInterval(timer);
        this.renewals.delete(renewal);
      },
    };

    this.renewals.add(renewal);
    return renewal;
  }

  private lockLost(call: Call, phase: 'complete' | 'release', outcome: string) {
    this.logger.warn(
      `Lock for "${call.storeKey}" expired before the handler finished; ${outcome}. ` +
        `The lock is renewed while the handler runs, so this means renewals ` +
        `failed (store unavailable, blocked event loop) or lockTtl is too short.`,
    );
    this.emit(call, { type: 'lock-lost', phase });
  }

  private emit(
    call: Call,
    event:
      | { type: 'replayed'; status: number }
      | { type: 'lock-lost'; phase: 'extend' | 'complete' | 'release' },
  ) {
    this.events.emit({
      ...event,
      context: call.adapter.type,
      handler: call.handler,
      key: call.key,
      ...(call.scope !== undefined && { scope: call.scope }),
    } as IdempotencyEvent);
  }

  /**
   * Without a scope, all callers share one key namespace. That is right for
   * server-to-server keys, but on a handler that signed-in users call, one
   * user who sends another user's key gets that user's stored response.
   * Warned about rather than guessed: a user id read from the wrong property
   * would re-run handlers (too fine) or keep sharing (too coarse).
   */
  private warnIfUnscoped(adapter: IdempotencyContextAdapter, context: ExecutionContext) {
    const user = adapter.userLocation(context);
    if (!user) {
      return;
    }

    const example =
      adapter.type === 'rpc'
        ? '`scope: { rpc: (payload, context) => ... }`'
        : '`scope: (req) => req.user.id`';
    this.warnOnce(
      context,
      'unscoped',
      `${handlerName(context)} was called by a signed-in user (${user} is set), but no ` +
        `\`scope\` applies to ${adapter.type} calls, so all users share one key namespace: ` +
        `a request that reuses another user's key gets that user's stored response. ` +
        `Set \`scope\`, for example ${example}, or \`scope: false\` if keys are unique ` +
        `across users on purpose.`,
    );
  }

  private warnUnreplayable(call: Call, reason: string) {
    this.warnOnce(
      call.context,
      'unreplayable',
      `${call.handler} ran with an idempotency key, but ${reason}, so its result is not ` +
        `stored: the key was released, and a retry runs the handler again.`,
    );
  }

  private warnOnce(context: ExecutionContext, topic: string, message: string) {
    let handlers = this.warned.get(topic);
    if (!handlers) {
      this.warned.set(topic, (handlers = new WeakSet()));
    }

    const handler = context.getHandler();
    if (handlers.has(handler)) {
      return;
    }

    handlers.add(handler);
    this.logger.warn(message);
  }

  private readKey(
    adapter: IdempotencyContextAdapter,
    context: ExecutionContext,
    keyFrom: Resolved['keyFrom'],
  ): unknown {
    const source = sourceFor(keyFrom, adapter.type);
    if (typeof source === 'function') {
      return source(context);
    }
    return adapter.readKey(context, source ?? 'default', this.header);
  }

  private resolve(
    classOptions: IdempotentOptions | undefined,
    handlerOptions: IdempotentOptions | undefined,
  ): Resolved {
    // Durations are already in ms: converted by the decorator and the constructor.
    const merged = {
      ...definedOnly(this.defaults),
      ...definedOnly(classOptions),
      ...definedOnly(handlerOptions),
    } as Omit<IdempotentOptions, 'ttl' | 'lockTtl' | 'retryAfter'> & {
      ttl?: number;
      lockTtl?: number;
      retryAfter?: number;
    };

    return {
      required: merged.required ?? false,
      ttl: merged.ttl ?? DEFAULT_TTL,
      lockTtl: merged.lockTtl ?? DEFAULT_LOCK_TTL,
      retryAfter: merged.retryAfter ?? DEFAULT_RETRY_AFTER,
      storeIf: merged.storeIf ?? ((status) => status < 500),
      scope: merged.scope,
      fingerprint: merged.fingerprint,
      keyFrom: merged.keyFrom,
    };
  }
}

function handlerName(context: ExecutionContext) {
  return `${context.getClass().name}.${context.getHandler().name}`;
}

/** The key source for one context: a single source, or that context's entry. */
function sourceFor(
  keyFrom: IdempotencyKeySource | IdempotencyKeySources | undefined,
  type: IdempotencyContextType,
): IdempotencyKeySource | undefined {
  if (!keyFrom || typeof keyFrom === 'function') {
    return keyFrom;
  }
  if ('header' in keyFrom || 'arg' in keyFrom || 'payload' in keyFrom) {
    return keyFrom;
  }
  return (keyFrom as IdempotencyKeySources)[type];
}

/** The scope function for one context: `false` when unscoped on purpose, `undefined` when not configured. */
function scopeFor(
  scope: Resolved['scope'],
  type: IdempotencyContextType,
): IdempotencyScopeFn | false | undefined {
  if (scope === undefined || scope === false || typeof scope === 'function') {
    return scope;
  }
  return scope[type];
}

/**
 * A key is 1 to 255 printable ASCII characters (the draft's sf-string
 * alphabet), so it can't smuggle control characters into logs and events.
 * A number is taken as its digits; anything else is invalid.
 */
function normalizeKey(raw: unknown): string | undefined | typeof INVALID_KEY {
  if (Array.isArray(raw)) {
    raw = raw[0];
  }
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if ((typeof raw === 'number' && Number.isFinite(raw)) || typeof raw === 'bigint') {
    raw = String(raw);
  }
  if (typeof raw !== 'string') {
    return INVALID_KEY;
  }

  // The draft defines the header as an RFC 8941 sf-string ("..."); accept
  // the bare token form too, since that is what most clients send.
  const key = raw.trim().replace(/^"(.*)"$/, '$1');
  if (!key) {
    return undefined;
  }

  return key.length <= MAX_KEY_LENGTH && PRINTABLE_ASCII.test(key) ? key : INVALID_KEY;
}

/**
 * Numeric user ids are common; `null` and '' mean "no scope". Anything else
 * is a mistake that would put every caller in one namespace (every object
 * is "[object Object]"), so it fails the call instead.
 */
function normalizeScope(raw: unknown, handler: string): string | undefined {
  if (raw === undefined || raw === null || raw === '') {
    return undefined;
  }
  if (typeof raw === 'string') {
    return raw;
  }
  if ((typeof raw === 'number' && Number.isFinite(raw)) || typeof raw === 'bigint') {
    return String(raw);
  }

  const what =
    typeof raw === 'number' ? String(raw) : typeof raw === 'object' ? 'an object' : `a ${typeof raw}`;
  throw new TypeError(
    `IdempotencyModule: \`scope\` returned ${what} for ${handler}. Return a string or a ` +
      `number that identifies the caller, such as the user's id: \`scope: (req) => req.user.id\`.`,
  );
}

/**
 * `[scope:]key[:suffix]`, each part URI-encoded so a `:` inside a client
 * key can't make an unscoped key look like a scoped one.
 */
function storeKey(scope: string | undefined, key: string, suffix: string | undefined) {
  return [scope || undefined, key, suffix || undefined]
    .filter((part): part is string => part !== undefined)
    .map(encodeURIComponent)
    .join(':');
}

/**
 * What `forRoot()`'s types rule out, but a `forRootAsync()` factory (or
 * JavaScript) can still get wrong.
 */
function assertOptions(options: IdempotencyModuleOptions) {
  if (options === null || typeof options !== 'object') {
    // A factory without a `return`, or one that returns the wrong thing.
    const what = options === null ? 'null' : options === undefined ? 'undefined' : `a ${typeof options}`;
    throw new TypeError(
      `IdempotencyModule: the options factory returned ${what}; return an object (\`{}\` for the defaults).`,
    );
  }

  for (const extra of ['isGlobal', 'imports']) {
    if (extra in options) {
      // The module is already defined when the factory runs: it would be ignored.
      throw new TypeError(
        `IdempotencyModule: pass \`${extra}\` to forRootAsync() next to useFactory, ` +
          `not in the object the factory returns.`,
      );
    }
  }

  if ('store' in options) {
    throw new TypeError(
      'IdempotencyModule: `store` is not a module option. Register the store instead: a ' +
        'provider that implements IdempotencyStore, injects IdempotencyStorage and calls ' +
        '`storage.registerSource(this)` in its constructor.',
    );
  }
}

function assertReplayHeaders(headers: string[]) {
  for (const header of headers) {
    if (NEVER_REPLAYED_HEADERS.has(header)) {
      const why =
        header === 'set-cookie'
          ? 'cookies belong to the response that set them'
          : 'the platform writes it for every response';
      throw new TypeError(`IdempotencyModule: \`replayHeaders\` can't include "${header}": ${why}.`);
    }
  }
}

/** Drops `undefined` values, so `{ ttl: undefined }` doesn't erase a default. */
function definedOnly<T extends object>(options: T | undefined): Partial<T> {
  if (!options) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(options).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}
