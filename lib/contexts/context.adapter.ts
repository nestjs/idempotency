import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  HttpException,
  ImATeapotException,
  MethodNotAllowedException,
  MisdirectedException,
  NotAcceptableException,
  NotFoundException,
  PayloadTooLargeException,
  PreconditionFailedException,
  RequestTimeoutException,
  UnauthorizedException,
  UnprocessableEntityException,
  UnsupportedMediaTypeException,
  type ExecutionContext,
} from '@nestjs/common';
import { STATUS_CODES } from 'node:http';
import type { Observable } from 'rxjs';
import type { IdempotencyStoredResponse } from '../interfaces/idempotency-store.interface.js';
import type { IdempotencyContextType } from '../interfaces/idempotent-options.interface.js';
import { encodeResult, unreplayableReason } from '../utils/result.util.js';
import type { IdempotencyErrorCode } from '../interfaces/idempotency-error-code.interface.js';

/** A result that can't be stored and replayed, and why (logged once per handler). */
export class Unreplayable {
  constructor(readonly reason: string) {}
}

/**
 * What a finished call leaves behind: the record to store, `null` when
 * `storeIf` says the outcome isn't final, or why it can't be replayed.
 */
export type Capture = IdempotencyStoredResponse | Unreplayable | null;

/** A protocol-neutral rejection; each context adapter renders it natively. */
export interface IdempotencyRejection {
  code: IdempotencyErrorCode;
  /** HTTP status equivalent. */
  status: number;
  message: string;
  /** Seconds, for `IDEMPOTENCY_KEY_IN_USE`. */
  retryAfter?: number;
}

export interface CaptureOptions {
  storeIf: (status: number, error?: unknown) => boolean;
}

/** A declarative key source, or `'default'` for the context's own default. */
export type DeclarativeKeySource =
  | 'default'
  | { header: string }
  | { arg: string }
  | { payload: string };

/** What a call is, for the fingerprint: who it targets, and with what. */
export interface CallDescription {
  /** Method and URL (http), field (graphql) or pattern (rpc). Always hashed. */
  identity: string[];
  /** Body (http), field arguments (graphql) or message payload (rpc). */
  payload: unknown;
}

/**
 * Everything protocol-specific. The interceptor owns the protocol-neutral
 * state machine (acquire → execute/replay/reject → complete/release) and
 * delegates here for how to read keys, fingerprint, capture and replay.
 */
export interface IdempotencyContextAdapter {
  readonly type: IdempotencyContextType;
  /**
   * Whether the caller gets every value the handler emits (a message
   * handler's reply), or only the last one, which is then the whole
   * response (an HTTP route, a GraphQL field).
   */
  readonly sendsEveryValue: boolean;
  /** Lazily loads optional peer dependencies (graphql, microservices). */
  prepare?(): Promise<void>;
  /**
   * Whether a class-level `@Idempotent()` covers this call. Safe calls (GET,
   * HEAD, OPTIONS routes, GraphQL queries, nested field resolvers) are only
   * covered by a decorator on the handler itself.
   */
  coveredByClass(context: ExecutionContext): boolean;
  /** Why `@Idempotent()` can't apply to this handler at all (it runs untouched), if it can't. */
  passThrough?(context: ExecutionContext): string | undefined;
  /** Where a signed-in user sits on this call (`req.user`), if one does. */
  userLocation(context: ExecutionContext): string | undefined;
  readKey(context: ExecutionContext, source: DeclarativeKeySource, header: string): unknown;
  /** First argument for user `scope` callbacks. */
  target(context: ExecutionContext): unknown;
  describe(context: ExecutionContext): CallDescription;
  /** Appended to the store key (GraphQL: the field path; RPC: the handler). */
  keySuffix?(context: ExecutionContext): string | undefined;
  captureSuccess(context: ExecutionContext, value: unknown, opts: CaptureOptions): Capture;
  captureError(error: unknown, opts: CaptureOptions): IdempotencyStoredResponse | null;
  replay(context: ExecutionContext, stored: IdempotencyStoredResponse): Observable<unknown>;
  reject(context: ExecutionContext, rejection: IdempotencyRejection): Error;
}

export function jsonClone<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

/** Reads a nested property (`meta.eventId`) from a payload or arguments. */
export function pick(data: unknown, path: string): unknown {
  let cur: any = data;
  for (const part of path.split('.')) {
    if (cur == null || typeof cur !== 'object') {
      return undefined;
    }
    cur = cur[part];
  }
  return cur;
}

/**
 * `HttpException`s by status. Another error with a numeric 4xx `status` (or
 * `statusCode`) is the caller's fault by the family's convention
 * (`AuthenticationError`, `AuthorizationError`), and the package that owns
 * it turns it into Nest's exception for that status, possibly in an
 * interceptor outside this one: it is captured as that exception, with
 * Nest's default body. Any other error as a 500 (if stored at all).
 */
export function captureHttpOrUnknownError(
  error: unknown,
  opts: CaptureOptions,
): IdempotencyStoredResponse | null {
  const exception = error instanceof HttpException ? error : clientErrorException(error);
  if (exception) {
    const status = exception.getStatus();
    if (!opts.storeIf(status, error)) {
      return null;
    }
    return { status, headers: {}, body: jsonClone(exception.getResponse()), error: 'http' };
  }

  if (!opts.storeIf(500, error)) {
    return null;
  }

  // Mirrors BaseExceptionFilter's response for unknown errors.
  return {
    status: 500,
    headers: {},
    body: { statusCode: 500, message: 'Internal server error' },
    error: 'http',
  };
}

/** Nest's own exception classes, for the default body of a status. */
const NEST_EXCEPTIONS: Record<number, new () => HttpException> = {
  400: BadRequestException,
  401: UnauthorizedException,
  403: ForbiddenException,
  404: NotFoundException,
  405: MethodNotAllowedException,
  406: NotAcceptableException,
  408: RequestTimeoutException,
  409: ConflictException,
  410: GoneException,
  412: PreconditionFailedException,
  413: PayloadTooLargeException,
  415: UnsupportedMediaTypeException,
  418: ImATeapotException,
  421: MisdirectedException,
  422: UnprocessableEntityException,
};

/** The `HttpException` for an error with a numeric 4xx `status` or `statusCode`, if it has one. */
function clientErrorException(error: unknown): HttpException | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }

  const { status, statusCode } = error as { status?: unknown; statusCode?: unknown };
  const code = typeof status === 'number' ? status : statusCode;
  if (typeof code !== 'number' || !Number.isInteger(code) || code < 400 || code > 499) {
    return undefined;
  }

  const Exception = NEST_EXCEPTIONS[code];
  if (Exception) {
    return new Exception();
  }

  const message = STATUS_CODES[code] ?? 'Error';
  return new HttpException(HttpException.createBody(null, message, code), code);
}

export function rebuildHttpException(stored: IdempotencyStoredResponse): HttpException {
  return new HttpException(stored.body as string | object, stored.status);
}

/** A successful GraphQL or RPC result, as a 200. */
export function successCapture(
  value: unknown,
  opts: CaptureOptions,
  { strict = false } = {},
): Capture {
  const reason = unreplayableReason(value);
  if (reason) {
    return new Unreplayable(reason);
  }
  if (!opts.storeIf(200)) {
    return null;
  }
  return { status: 200, headers: {}, body: encodeResult(value, { strict }) };
}

export function unsupportedSource(type: string, source: unknown): Error {
  const fits =
    'Use { arg } for graphql, { payload } for rpc, { header } or a function for any context, ' +
    'or one source per context: { graphql: { arg: ... }, rpc: { payload: ... } }.';
  return new Error(
    `@Idempotent({ keyFrom: ${JSON.stringify(source)} }) is not supported in the "${type}" context. ${fits}`,
  );
}
