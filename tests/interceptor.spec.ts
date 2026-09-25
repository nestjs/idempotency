/**
 * The interceptor's protocol-neutral rules, driven with message-handler calls: which keys
 * and scopes it accepts, how options merge, what it stores (and refuses to), and the
 * events it reports.
 */
import { Logger, type CallHandler, type ExecutionContext } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { Test, type TestingModule } from '@nestjs/testing';
import { EMPTY, lastValueFrom, of, throwError } from 'rxjs';
import { channels } from '../lib/events/idempotency.channels.js';
import { IdempotencyInterceptor } from '../lib/interceptors/idempotency.interceptor.js';
import {
  Idempotent,
  IdempotencyEvents,
  IdempotencyModule,
  InMemoryIdempotencyStore,
  type IdempotencyEvent,
  type IdempotencyModuleOptions,
} from '../lib/index.js';
import { registered } from './register.js';

@Idempotent({ ttl: '1h' })
class Consumers {
  @Idempotent()
  charge() {}

  @Idempotent({ required: true })
  refund() {}

  @Idempotent({ ttl: undefined, lockTtl: '5s' })
  capture() {}

  @Idempotent({ storeIf: (status) => status !== 200 })
  poll() {}

  @Idempotent({ keyFrom: async (context) => `fn-${context.switchToRpc().getData().orderId}` })
  ship() {}

  @Idempotent({ scope: { http: (req) => req.user.id, rpc: false } })
  webhook() {}

  /** Covered by the class decorator alone. */
  settle() {}
}

type Handler = Exclude<keyof Consumers, 'constructor'>;

/** A message-handler call of `Consumers[handler]` with `data` as its payload. */
const message = (data: unknown, handler: Handler = 'charge', rpcContext: object = {}) =>
  ({
    getType: () => 'rpc',
    getClass: () => Consumers,
    getHandler: () => Consumers.prototype[handler],
    getArgs: () => [data, rpcContext],
    getArgByIndex: (i: number) => [data, rpcContext][i],
    switchToRpc: () => ({ getData: () => data, getContext: () => ({ getPattern: () => handler, ...rpcContext }) }),
  }) as unknown as ExecutionContext;

/**
 * The same payload, keyed by a transport header (as Kafka carries it): a key in the payload
 * is part of what is fingerprinted, so two spellings of it there are two different requests.
 */
const headed = (key: unknown) =>
  message({ amount: 1 }, 'charge', { getMessage: () => ({ headers: { 'idempotency-key': key } }) });

describe('IdempotencyInterceptor', () => {
  let store: InMemoryIdempotencyStore;
  let moduleRef: TestingModule;
  let interceptor: IdempotencyInterceptor;
  let events: IdempotencyEvent[];
  let runs: number;
  let warn: ReturnType<typeof vi.spyOn>;

  async function boot(options: IdempotencyModuleOptions = {}) {
    store = new InMemoryIdempotencyStore();
    moduleRef = await Test.createTestingModule({
      imports: [IdempotencyModule.forRoot(options)],
      providers: [registered(store)],
    }).compile();
    moduleRef.useLogger(false);
    await moduleRef.init();

    interceptor = moduleRef.get(IdempotencyInterceptor);
    events = [];
    moduleRef.get(IdempotencyEvents).events$.subscribe((event) => events.push(event));
  }

  beforeEach(async () => {
    runs = 0;
    warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    await boot();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await moduleRef.close();
  });

  const counting = (value: unknown = 'charged'): CallHandler => ({
    handle: () => {
      runs++;
      return of(value);
    },
  });
  const run = (context: ExecutionContext, next: CallHandler = counting()) =>
    lastValueFrom(interceptor.intercept(context, next), { defaultValue: undefined });
  const rejection = (context: ExecutionContext, next?: CallHandler) =>
    run(context, next).then(
      () => {
        throw new Error('expected a rejection');
      },
      (err: RpcException) => err.getError() as { code: string; statusCode: number },
    );

  describe('keys', () => {
    it('takes a number or a BigInt as its digits', async () => {
      await run(headed(42));
      await run(headed('42'));
      await run(headed(7n));

      expect(runs).toBe(2);
      expect(store.peek('42:Consumers.charge')?.state).toBe('completed');
      expect(store.peek('7:Consumers.charge')?.state).toBe('completed');
    });

    it('trims the key and unquotes the sf-string form, so both name the same record', async () => {
      await run(headed('  k1\t'));
      await run(headed('"k1"'));
      expect(runs).toBe(1);
      expect(store.peek('k1:Consumers.charge')?.state).toBe('completed');
    });

    it('fingerprints a key carried in the payload with the rest of it', async () => {
      await run(message({ idempotencyKey: 42 }));
      expect(await rejection(message({ idempotencyKey: '42' }))).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
      expect(runs).toBe(1);
    });

    it('takes the first of several values', async () => {
      await run(message({ idempotencyKey: ['k1', 'k2'] }));
      expect(store.peek('k1:Consumers.charge')?.state).toBe('completed');
      expect(store.peek('k2:Consumers.charge')).toBeUndefined();
    });

    it('treats a blank or empty quoted key as no key: the handler runs, or a required key is missing', async () => {
      for (const idempotencyKey of ['   ', '""', '', null]) {
        await run(message({ idempotencyKey }));
        expect(await rejection(message({ idempotencyKey }, 'refund'))).toMatchObject({
          code: 'IDEMPOTENCY_KEY_REQUIRED',
          statusCode: 400,
        });
      }

      expect(runs).toBe(4);
      expect(store.size).toBe(0);
    });

    it('accepts 255 printable ASCII characters, and nothing longer, non-printable or not a string', async () => {
      await run(message({ idempotencyKey: 'a'.repeat(255) }));
      await run(message({ idempotencyKey: `   ${'b'.repeat(255)} ` }));
      await run(message({ idempotencyKey: ' x ~' }));
      expect(runs).toBe(3);
      expect(store.peek(`${'b'.repeat(255)}:Consumers.charge`)?.state).toBe('completed');
      expect(store.peek('x%20~:Consumers.charge')?.state).toBe('completed');

      for (const idempotencyKey of ['a'.repeat(256), 'line\nbreak', 'nul\u0000', 'tab\tinside', true, { id: 1 }, Number.NaN]) {
        expect(await rejection(message({ idempotencyKey }))).toMatchObject({
          code: 'IDEMPOTENCY_KEY_INVALID',
          statusCode: 400,
        });
      }
      expect(runs).toBe(3);
    });

    it('reads the key with a keyFrom function, which may be async', async () => {
      await run(message({ orderId: 7 }, 'ship'));
      await run(message({ orderId: 7 }, 'ship'));

      expect(runs).toBe(1);
      expect(store.peek('fn-7:Consumers.ship')?.state).toBe('completed');
    });

    it('fails the call when keyFrom names a source the context has no such thing as', async () => {
      await moduleRef.close();
      await boot({ keyFrom: { arg: 'input.key' } });

      await expect(run(message({ idempotencyKey: 'k1' }))).rejects.toThrow(
        'is not supported in the "rpc" context',
      );
      expect(runs).toBe(0);
    });
  });

  describe('scope', () => {
    const scoped = async (scope: (payload: any) => unknown) => {
      await moduleRef.close();
      await boot({ scope: scope as never });
    };

    it('takes a BigInt id, and an async scope function', async () => {
      await scoped(async (payload) => BigInt(payload.tenant));
      await run(message({ idempotencyKey: 'k1', tenant: '9007199254740993' }));
      expect(store.peek('9007199254740993:k1:Consumers.charge')?.state).toBe('completed');
    });

    it("treats '' and null as the global namespace", async () => {
      await scoped((payload) => payload.tenant);
      await run(message({ idempotencyKey: 'k1', tenant: '' }));
      await run(message({ idempotencyKey: 'k2', tenant: null }));

      expect(store.peek('k1:Consumers.charge')?.state).toBe('completed');
      expect(store.peek('k2:Consumers.charge')?.state).toBe('completed');
    });

    it('fails the call, naming what it got, for a scope that is not an id', async () => {
      for (const [value, named] of [
        [Number.NaN, 'NaN'],
        [true, 'a boolean'],
        [Symbol('tenant'), 'a symbol'],
        [['t1'], 'an object'],
      ] as const) {
        await scoped(() => value);
        await expect(run(message({ idempotencyKey: 'k1' }))).rejects.toThrow(
          `IdempotencyModule: \`scope\` returned ${named} for Consumers.charge.`,
        );
      }
      expect(runs).toBe(0);
    });

    it('warns about an unscoped message from a signed-in user, with the rpc example, once', async () => {
      const signedIn = { user: { id: 'u1' } };
      await run(message({ idempotencyKey: 'k1' }, 'charge', signedIn));
      await run(message({ idempotencyKey: 'k2' }, 'charge', signedIn));
      await run(message({ idempotencyKey: 'k3' }, 'webhook', signedIn));

      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain("the transport context's user is set");
      expect(warn.mock.calls[0][0]).toContain('`scope: { rpc: (payload, context) => ... }`');
    });
  });

  describe('options', () => {
    it("merges handler over class over module options, and an undefined option doesn't erase one", async () => {
      await moduleRef.close();
      await boot({ ttl: '2h', lockTtl: '10s' });
      const acquire = vi.spyOn(store, 'acquire');
      const complete = vi.spyOn(store, 'complete');

      await run(message({ idempotencyKey: 'k1' }, 'capture'));

      expect(acquire.mock.calls[0][3]).toBe(5_000);
      expect(complete.mock.calls[0][3]).toBe(3_600_000); // the class's ttl, not the module's
    });

    it('stores a success only when storeIf says it is final', async () => {
      await run(message({ idempotencyKey: 'k1' }, 'poll'));
      await run(message({ idempotencyKey: 'k1' }, 'poll'));

      expect(runs).toBe(2);
      expect(store.size).toBe(0);
    });

    it('covers every message handler of a decorated class, with the class options', async () => {
      const complete = vi.spyOn(store, 'complete');
      await run(message({ idempotencyKey: 'k1' }, 'settle'));
      await run(message({ idempotencyKey: 'k1' }, 'settle'));

      expect(runs).toBe(1);
      expect(complete.mock.calls[0][3]).toBe(3_600_000);
    });
  });

  describe('results that are not stored', () => {
    it('releases the key, and warns once per handler, for a call that completes without a value', async () => {
      const empty = { handle: () => (runs++, EMPTY) };
      await run(message({ idempotencyKey: 'k1' }), empty);
      await run(message({ idempotencyKey: 'k1' }), empty);

      expect(runs).toBe(2);
      expect(store.size).toBe(0);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        'Consumers.charge ran with an idempotency key, but it completed without a value, so its result is not ' +
          'stored: the key was released, and a retry runs the handler again.',
      );
    });

    it('still returns a circular result, released instead of stored', async () => {
      const order: Record<string, unknown> = { id: 'ord_1' };
      order.self = order;

      expect(await run(message({ idempotencyKey: 'k1' }), counting(order))).toBe(order);
      expect(store.size).toBe(0);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('its result has a circular reference'));
    });

    it('releases the key on an unknown error, and stores a 4xx RpcException for replay', async () => {
      await expect(run(message({ idempotencyKey: 'k1' }), { handle: () => throwError(() => new Error('down')) })).rejects.toThrow(
        'down',
      );
      expect(store.size).toBe(0);

      const declined = { handle: () => (runs++, throwError(() => new RpcException({ code: 'card_declined' }))) };
      expect(await rejection(message({ idempotencyKey: 'k2' }), declined)).toEqual({ code: 'card_declined' });
      expect(await rejection(message({ idempotencyKey: 'k2' }), declined)).toEqual({ code: 'card_declined' });
      expect(runs).toBe(1);
    });
  });

  describe('records it cannot read', () => {
    it('refuses a sealed record when encryption is not configured, instead of running the handler again', async () => {
      await run(message({ idempotencyKey: 'k1' }));
      const { fingerprint } = store.peek('k1:Consumers.charge')!;
      vi.spyOn(store, 'acquire').mockResolvedValue({
        state: 'completed',
        fingerprint,
        response: { sealed: 'v1.a.b.c.d' },
      });

      expect(await rejection(message({ idempotencyKey: 'k1' }))).toMatchObject({
        code: 'IDEMPOTENCY_RECORD_UNREADABLE',
        statusCode: 500,
      });
      expect(runs).toBe(1);
      expect(events).toEqual([
        {
          type: 'rejected',
          context: 'rpc',
          handler: 'Consumers.charge',
          code: 'IDEMPOTENCY_RECORD_UNREADABLE',
          status: 500,
          key: 'k1',
        },
      ]);
    });

    it('fails the call with the store error when acquire() fails', async () => {
      vi.spyOn(store, 'acquire').mockRejectedValue(new Error('connection refused'));
      await expect(run(message({ idempotencyKey: 'k1' }))).rejects.toThrow('connection refused');
      expect(runs).toBe(0);
    });
  });

  describe('events', () => {
    it('reports a missing or invalid key without the key, and a replay with its status', async () => {
      await rejection(message({}, 'refund'));
      await rejection(message({ idempotencyKey: 'bad\nkey' }));
      await run(message({ idempotencyKey: 'k1' }));
      await run(message({ idempotencyKey: 'k1' }));

      expect(events).toEqual([
        { type: 'rejected', context: 'rpc', handler: 'Consumers.refund', code: 'IDEMPOTENCY_KEY_REQUIRED', status: 400 },
        { type: 'rejected', context: 'rpc', handler: 'Consumers.charge', code: 'IDEMPOTENCY_KEY_INVALID', status: 400 },
        { type: 'replayed', context: 'rpc', handler: 'Consumers.charge', key: 'k1', status: 200 },
      ]);
    });

    it('reports an in-flight duplicate and a reused key with the key and scope', async () => {
      await moduleRef.close();
      await boot({ scope: (payload: { tenant: string }) => payload.tenant });
      await store.acquire('t1:k1:Consumers.charge', 'other', 'another fingerprint', 60_000);

      await rejection(message({ idempotencyKey: 'k1', tenant: 't1' }));

      expect(events).toEqual([
        {
          type: 'rejected',
          context: 'rpc',
          handler: 'Consumers.charge',
          code: 'IDEMPOTENCY_KEY_REUSED',
          status: 422,
          key: 'k1',
          scope: 't1',
        },
      ]);
    });

    it("doesn't publish on the diagnostics channels while nobody subscribes to them", async () => {
      const publish = vi.spyOn(channels.rejected, 'publish');
      await rejection(message({}, 'refund'));

      expect(events).toHaveLength(1);
      expect(publish).not.toHaveBeenCalled();
    });

    it('completes events$ when the app shuts down', async () => {
      let completed = false;
      moduleRef.get(IdempotencyEvents).events$.subscribe({ complete: () => (completed = true) });

      await moduleRef.close();
      expect(completed).toBe(true);
    });
  });
});
