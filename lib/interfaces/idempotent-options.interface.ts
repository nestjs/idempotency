import type { ExecutionContext } from '@nestjs/common';
import type { Duration } from '../utils/duration.util.js';

/** Execution contexts `@Idempotent()` supports (`ExecutionContext#getType()`). */
export type IdempotencyContextType = 'http' | 'graphql' | 'rpc';

/**
 * A key namespace, such as a user id. `undefined`, `null` and `''` mean the
 * global one. Anything else (an object, a boolean) fails the call, because
 * as a string every caller would get the same namespace.
 */
type Scope = string | number | bigint | null | undefined;

/**
 * Returns the key namespace (user, tenant) for one call, such as the user's
 * id. `target` is the HTTP request (`http`), the request from the GraphQL
 * context, `context.req` (`graphql`), or the message payload (`rpc`).
 */
export type IdempotencyScopeFn<TTarget = any> = (
  target: TTarget,
  context: ExecutionContext,
) => Scope | Promise<Scope>;

/**
 * One scope function per context type, each typed for what that context
 * passes in. `false`, or no entry, leaves that context unscoped.
 */
export interface IdempotencyScopes {
  /** Receives the native HTTP request (Express or Fastify). */
  http?: IdempotencyScopeFn<any> | false;
  /** Receives `context.req` from the GraphQL context. */
  graphql?: IdempotencyScopeFn<any> | false;
  /** Receives the message payload: check its shape before reading it. */
  rpc?: IdempotencyScopeFn<unknown> | false;
}

/**
 * Reads the key for one call. Returning `undefined` means "no key"
 * (rejected when `required`, otherwise the handler just runs).
 */
export type IdempotencyKeyFn = (
  context: ExecutionContext,
) => string | undefined | Promise<string | undefined>;

/**
 * Where a key comes from:
 * - `{ header }`: an HTTP header (`http`, `graphql`), or a transport header
 *   (`rpc`: NATS, Kafka, RabbitMQ and MQTT 5 headers, gRPC metadata)
 * - `{ arg }`: a GraphQL field argument (`'input.requestId'` for a nested one)
 * - `{ payload }`: a property of the RPC message payload (`'meta.eventId'`)
 * - a function, for anything else
 */
export type IdempotencyKeySource =
  | { header: string }
  | { arg: string }
  | { payload: string }
  | IdempotencyKeyFn;

/** One key source per context type. A context without an entry uses its default. */
export interface IdempotencyKeySources {
  http?: { header: string } | IdempotencyKeyFn;
  graphql?: { header: string } | { arg: string } | IdempotencyKeyFn;
  rpc?: { header: string } | { payload: string } | IdempotencyKeyFn;
}

/**
 * Options for `@Idempotent()` on a handler or a class. Each can also be set
 * module-wide. Handler options are merged over the class's, which are merged
 * over the module's, field by field.
 */
export interface IdempotentOptions {
  /** Reject calls without a key (400 `IDEMPOTENCY_KEY_REQUIRED`). Default `false`. */
  required?: boolean;
  /** How long a completed result is replayed to retries. Default `'24h'`. */
  ttl?: Duration;
  /**
   * How long an in-flight lock survives once the process holding it stops
   * renewing it. While the handler runs, and until its result is stored, the
   * lock is renewed every `lockTtl / 3`, so a slow handler keeps it;
   * `lockTtl` only bounds how long a crashed process can block a key.
   * Default `'60s'`.
   */
  lockTtl?: Duration;
  /**
   * How long a client should wait after `IDEMPOTENCY_KEY_IN_USE` before it
   * asks again. Sent in whole seconds, rounded up: the `Retry-After` header
   * (HTTP), `retryAfter` in the error (GraphQL, RPC). Default `'1s'`.
   */
  retryAfter?: Duration;
  /**
   * Where the key comes from, for every context or per context
   * (`{ rpc: { payload: 'meta.eventId' } }`). Defaults:
   * - `http`: the `header` option (`Idempotency-Key`)
   * - `graphql`: the `idempotencyKey` argument, then the `header` option
   * - `rpc`: the payload's `idempotencyKey` property, then the transport
   *   header named by the `header` option
   *
   * A key is 1 to 255 printable ASCII characters (a number is accepted as
   * its digits); anything else is rejected with `IDEMPOTENCY_KEY_INVALID`.
   */
  keyFrom?: IdempotencyKeySource | IdempotencyKeySources;
  /**
   * Namespace for keys, such as the authenticated user or tenant, so two
   * clients that pick the same key never see each other's results. Runs
   * after guards, so `req.user` is set.
   *
   * Without it, every caller shares one namespace, and the first call a
   * signed-in user makes to a handler (a `req.user` is set) logs a warning.
   * `false` shares the namespace on purpose, for keys that are unique across
   * callers (event ids, a provider's webhook ids), and silences it.
   *
   * A function runs for every context type, and its first argument differs
   * per context (see `IdempotencyScopeFn`). In an app that serves several
   * (HTTP plus microservices, say), pass one function per context instead:
   * `{ http: (req) => req.user?.id, rpc: (payload) => ... }`.
   */
  scope?: IdempotencyScopeFn | IdempotencyScopes | false;
  /**
   * Selects what a retry must repeat exactly. Receives the request body
   * (`http`), the field's arguments (`graphql`) or the message payload
   * (`rpc`), and returns any value, for example the payload without a
   * client timestamp. The value is hashed together with the method and URL
   * (`http`), the field (`graphql`) or the pattern (`rpc`), and the scope,
   * so a key reused for another resource is still rejected. Default: the
   * whole payload.
   */
  fingerprint?: (payload: any, context: ExecutionContext) => unknown;
  /**
   * Whether an outcome is final: stored, and replayed to every retry. When
   * it returns `false`, the key is released and a retry runs the handler
   * again. Receives the (HTTP-equivalent) status and, when the handler
   * threw, the error. Default `status < 500`: success and client errors are
   * final, server errors are not.
   */
  storeIf?: (status: number, error?: unknown) => boolean;
}
