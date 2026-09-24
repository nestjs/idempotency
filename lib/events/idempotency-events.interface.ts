import type { IdempotencyErrorCode } from '../interfaces/idempotency-error-code.interface.js';
import type { IdempotencyContextType } from '../interfaces/idempotent-options.interface.js';

interface EventBase {
  /** `ExecutionContext#getType()`: `http`, `graphql` or `rpc`. */
  context: IdempotencyContextType;
  /** The handler, as `ClassName.methodName`. */
  handler: string;
  /** The key the client sent. */
  key: string;
  /** The scope the key belongs to, if `scope` returned one. */
  scope?: string;
}

/**
 * A retry got the stored result, and the handler didn't run. For an event
 * handler, this is a skipped duplicate delivery.
 */
export interface IdempotencyReplayedEvent extends EventBase {
  type: 'replayed';
  /** The replayed (HTTP-equivalent) status. */
  status: number;
}

/** A call was refused before its handler ran. */
export interface IdempotencyRejectedEvent extends Omit<EventBase, 'key'> {
  type: 'rejected';
  code: IdempotencyErrorCode;
  /** The HTTP-equivalent status: 400, 409, 422 or 500. */
  status: number;
  /** Missing for `IDEMPOTENCY_KEY_REQUIRED` and `IDEMPOTENCY_KEY_INVALID`. */
  key?: string;
}

/**
 * An attempt's outcome isn't in the store, so a retry may run (or have run)
 * the handler too: the attempt found that it no longer held its lock, or the
 * store failed when the outcome was written. `phase` is the store call that
 * found out: `extend` (while the handler ran), `complete` (the result wasn't
 * stored) or `release`. Reported once per attempt.
 */
export interface IdempotencyLockLostEvent extends EventBase {
  type: 'lock-lost';
  phase: 'extend' | 'complete' | 'release';
}

export type IdempotencyEvent =
  | IdempotencyReplayedEvent
  | IdempotencyRejectedEvent
  | IdempotencyLockLostEvent;
