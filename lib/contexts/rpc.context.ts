import type { ExecutionContext } from '@nestjs/common';
import type * as Microservices from '@nestjs/microservices';
import { of, throwError, type Observable } from 'rxjs';
import { canonicalJson } from '../utils/fingerprint.util.js';
import type { IdempotencyStoredResponse } from '../interfaces/idempotency-store.interface.js';
import { DEFAULT_KEY_FIELD } from '../idempotency.constants.js';
import { decodeResult } from '../utils/result.util.js';
import {
  captureHttpOrUnknownError,
  pick,
  rebuildHttpException,
  successCapture,
  unsupportedSource,
  type CaptureOptions,
  type DeclarativeKeySource,
  type IdempotencyContextAdapter,
  type IdempotencyRejection,
} from './context.adapter.js';

const PATTERN_METADATA = 'microservices:pattern';

function headerValue(v: unknown): unknown {
  if (Array.isArray(v)) {
    v = v[0];
  }
  return Buffer.isBuffer(v) ? v.toString('utf8') : v;
}

/**
 * Best-effort transport header lookup. Transports expose headers in
 * different places; only TCP (which has none) is exercised in tests.
 */
function transportHeader(context: ExecutionContext, name: string): unknown {
  const rpcCtx: any = context.switchToRpc().getContext();
  const lower = name.toLowerCase();
  const candidates = [
    // NATS: MsgHdrs
    () => rpcCtx?.getHeaders?.()?.get?.(name),
    // Kafka: message.headers (Buffers)
    () => rpcCtx?.getMessage?.()?.headers?.[name] ?? rpcCtx?.getMessage?.()?.headers?.[lower],
    // RabbitMQ: message.properties.headers
    () => rpcCtx?.getMessage?.()?.properties?.headers?.[name] ??
      rpcCtx?.getMessage?.()?.properties?.headers?.[lower],
    // MQTT 5: packet.properties.userProperties
    () => rpcCtx?.getPacket?.()?.properties?.userProperties?.[name],
    // gRPC: second handler argument is Metadata
    () => {
      const metadata: any = context.getArgByIndex(1);
      return typeof metadata?.get === 'function' ? metadata.get(lower) : undefined;
    },
  ];

  for (const candidate of candidates) {
    try {
      const v = headerValue(candidate());
      if (v !== undefined && v !== null && v !== '') {
        return v;
      }
    } catch {
      // Not this transport.
    }
  }

  return undefined;
}

/**
 * `@MessagePattern()` / `@EventPattern()` handlers on any transport.
 *
 * Default key: `payload.idempotencyKey`, falling back to the transport
 * header named by the `header` option. Records are per handler
 * (`<key>:<Class>.<method>`): Nest runs every `@EventPattern()` handler for
 * an event, and each must process a delivery once, independently of the
 * others. Replays return the stored result (for events, a replay simply
 * means "skipped"). Rejections are `RpcException`s carrying a structured
 * error object.
 *
 * `@nestjs/microservices` is loaded lazily, so it stays an optional peer.
 */
export class RpcContextAdapter implements IdempotencyContextAdapter {
  readonly type = 'rpc';
  readonly sendsEveryValue = true;
  private ms?: typeof Microservices;

  async prepare() {
    this.ms ??= await import('@nestjs/microservices');
  }

  coveredByClass() {
    return true;
  }

  /** Where an authentication guard leaves the user of a message (the transport context). */
  userLocation(context: ExecutionContext) {
    const rpcCtx = context.switchToRpc().getContext();
    return rpcCtx?.user ? "the transport context's user" : undefined;
  }

  readKey(context: ExecutionContext, source: DeclarativeKeySource, header: string) {
    const data = context.switchToRpc().getData();
    if (source === 'default') {
      return pick(data, DEFAULT_KEY_FIELD) ?? transportHeader(context, header);
    }
    if ('header' in source) {
      return transportHeader(context, source.header);
    }
    if ('payload' in source) {
      return pick(data, source.payload);
    }
    throw unsupportedSource(this.type, source);
  }

  target(context: ExecutionContext) {
    return context.switchToRpc().getData();
  }

  keySuffix(context: ExecutionContext) {
    return `${context.getClass().name}.${context.getHandler().name}`;
  }

  describe(context: ExecutionContext) {
    const rpcCtx: any = context.switchToRpc().getContext();
    let pattern: unknown;
    try {
      pattern = rpcCtx?.getPattern?.();
    } catch {
      // Not every context exposes the pattern.
    }
    pattern ??= Reflect.getMetadata(PATTERN_METADATA, context.getHandler());

    return {
      identity: ['rpc', typeof pattern === 'string' ? pattern : canonicalJson(pattern)],
      payload: context.switchToRpc().getData(),
    };
  }

  captureSuccess(_context: ExecutionContext, value: unknown, opts: CaptureOptions) {
    return successCapture(value, opts);
  }

  captureError(error: unknown, opts: CaptureOptions): IdempotencyStoredResponse | null {
    if (this.ms && error instanceof this.ms.RpcException) {
      // An RpcException is the handler's deliberate rejection: a 4xx, unless
      // it says otherwise with a numeric `statusCode` (a 5xx is released).
      const body = error.getError();
      const statusCode = (body as { statusCode?: unknown } | null)?.statusCode;
      const status =
        typeof statusCode === 'number' && statusCode >= 400 && statusCode <= 599 ? statusCode : 400;

      if (!opts.storeIf(status, error)) {
        return null;
      }

      return {
        status,
        headers: {},
        body: JSON.parse(JSON.stringify(body ?? null)),
        error: 'rpc',
      };
    }

    return captureHttpOrUnknownError(error, opts);
  }

  replay(_context: ExecutionContext, stored: IdempotencyStoredResponse): Observable<unknown> {
    if (stored.error === 'rpc') {
      return throwError(() => new this.ms!.RpcException(stored.body as object));
    }
    if (stored.error) {
      return throwError(() => rebuildHttpException(stored));
    }
    return of(decodeResult(stored.body));
  }

  reject(_context: ExecutionContext, rejection: IdempotencyRejection): Error {
    return new this.ms!.RpcException({
      status: 'error',
      code: rejection.code,
      statusCode: rejection.status,
      message: rejection.message,
      ...(rejection.retryAfter !== undefined && { retryAfter: rejection.retryAfter }),
    });
  }
}
