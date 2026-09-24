import { HttpException, type ExecutionContext } from '@nestjs/common';
import {
  REDIRECT_METADATA,
  RESPONSE_PASSTHROUGH_METADATA,
  ROUTE_ARGS_METADATA,
  SSE_METADATA,
} from '@nestjs/common/constants.js';
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum.js';
import type { HttpAdapterHost } from '@nestjs/core';
import { of, throwError, type Observable } from 'rxjs';
import type { IdempotencyStoredResponse } from '../interfaces/idempotency-store.interface.js';
import { REPLAYED_HEADER } from '../idempotency.constants.js';
import { decodeResult, encodeResult, unreplayableReason } from '../utils/result.util.js';
import {
  Unreplayable,
  captureHttpOrUnknownError,
  rebuildHttpException,
  unsupportedSource,
  type Capture,
  type CaptureOptions,
  type DeclarativeKeySource,
  type IdempotencyContextAdapter,
  type IdempotencyRejection,
} from './context.adapter.js';

const REASON: Record<number, string> = {
  400: 'Bad Request',
  409: 'Conflict',
  422: 'Unprocessable Entity',
  500: 'Internal Server Error',
};

/** Methods that don't change state (RFC 9110 "safe"). */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** `@Res()` and `@Next()`, which make the handler responsible for the response. */
const RESPONSE_PARAMS = new Set([String(RouteParamtypes.RESPONSE), String(RouteParamtypes.NEXT)]);

export class HttpContextAdapter implements IdempotencyContextAdapter {
  readonly type = 'http';
  readonly sendsEveryValue = false;

  constructor(
    private readonly adapterHost: HttpAdapterHost,
    private readonly replayHeaders: string[],
  ) {}

  private get adapter() {
    return this.adapterHost.httpAdapter;
  }

  coveredByClass(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest();
    return !SAFE_METHODS.has(String(this.adapter.getRequestMethod(req)).toUpperCase());
  }

  passThrough(context: ExecutionContext) {
    if (Reflect.getMetadata(SSE_METADATA, context.getHandler())) {
      return "Server-Sent Events are a stream, which can't be replayed";
    }
    return undefined;
  }

  userLocation(context: ExecutionContext) {
    return context.switchToHttp().getRequest()?.user ? 'req.user' : undefined;
  }

  readKey(context: ExecutionContext, source: DeclarativeKeySource, header: string) {
    const req = context.switchToHttp().getRequest();
    if (source === 'default') {
      return req.headers[header];
    }
    if ('header' in source) {
      return req.headers[source.header.toLowerCase()];
    }
    throw unsupportedSource(this.type, source);
  }

  target(context: ExecutionContext) {
    return context.switchToHttp().getRequest();
  }

  describe(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest();
    return {
      // The concrete URL (not the route pattern), so the same key sent to
      // `/orders/1/refund` and `/orders/2/refund` is detected as misuse.
      identity: [
        String(this.adapter.getRequestMethod(req)).toUpperCase(),
        this.adapter.getRequestUrl(req),
      ],
      payload: req.body,
    };
  }

  captureSuccess(context: ExecutionContext, value: unknown, opts: CaptureOptions): Capture {
    const res = context.switchToHttp().getResponse();
    // With `@Res()` (no passthrough), Nest leaves the response to the handler,
    // which may write it after returning: a replay would never answer.
    if (this.handlerWritesResponse(context) || this.adapter.isHeadersSent(res)) {
      return new Unreplayable('it writes the response itself, with @Res()');
    }

    const reason = unreplayableReason(value);
    if (reason) {
      return new Unreplayable(reason);
    }

    let status: number = res.statusCode;
    const headers: IdempotencyStoredResponse['headers'] = {};
    const redirect = Reflect.getMetadata(REDIRECT_METADATA, context.getHandler());
    if (redirect) {
      // The router applies @Redirect() after interceptors; mirror its logic.
      const r = value as { url?: string; statusCode?: number } | undefined;
      status = r?.statusCode ?? redirect.statusCode ?? 302;
      headers.location = r?.url ?? redirect.url;
    }

    if (!opts.storeIf(status)) {
      return null;
    }

    for (const name of this.replayHeaders) {
      const v = this.adapter.getHeader(res, name);
      if (v !== undefined && v !== null && headers[name] === undefined) {
        headers[name] = Array.isArray(v) ? v.map(String) : String(v);
      }
    }

    return { status, headers, body: encodeResult(value) };
  }

  captureError(error: unknown, opts: CaptureOptions) {
    return captureHttpOrUnknownError(error, opts);
  }

  replay(context: ExecutionContext, stored: IdempotencyStoredResponse): Observable<unknown> {
    const res = context.switchToHttp().getResponse();
    for (const [name, value] of Object.entries(stored.headers)) {
      this.adapter.setHeader(res, name, value as string);
    }
    this.adapter.setHeader(res, REPLAYED_HEADER, 'true');

    if (stored.error) {
      // Re-thrown through the app's exception filters, so a custom error
      // format applies to replays exactly as it did to the original.
      return throwError(() => rebuildHttpException(stored));
    }

    this.adapter.status(res, stored.status);
    return of(decodeResult(stored.body));
  }

  reject(context: ExecutionContext, rejection: IdempotencyRejection): Error {
    if (rejection.retryAfter !== undefined) {
      const res = context.switchToHttp().getResponse();
      this.adapter.setHeader(res, 'Retry-After', String(rejection.retryAfter));
    }

    return new HttpException(
      {
        statusCode: rejection.status,
        error: REASON[rejection.status],
        code: rejection.code,
        message: rejection.message,
      },
      rejection.status,
    );
  }

  /** Nest's own rule (RouterExecutionContext): `@Res()` or `@Next()` without `passthrough: true`. */
  private handlerWritesResponse(context: ExecutionContext): boolean {
    const handler = context.getHandler();
    const params: Record<string, unknown> =
      Reflect.getMetadata(ROUTE_ARGS_METADATA, context.getClass(), handler.name) ?? {};
    const takesResponse = Object.keys(params).some((key) => RESPONSE_PARAMS.has(key.split(':')[0]));
    return (
      takesResponse &&
      !Reflect.getMetadata(RESPONSE_PASSTHROUGH_METADATA, context.getClass(), handler.name)
    );
  }
}
