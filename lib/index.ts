// Module and options
export { IdempotencyModule } from './idempotency.module.js';
export { IDEMPOTENCY_MODULE_OPTIONS } from './idempotency.module-definition.js';
export type { Duration } from './utils/index.js';
export type {
  IdempotencyModuleAsyncOptions,
  IdempotencyModuleOptions,
  IdempotencyOptionsFactory,
  IdempotentOptions,
} from './interfaces/index.js';

// Marking handlers
export { Idempotent } from './decorators/index.js';

// Storage: implement `IdempotencyStore` in a provider and register it with
// `IdempotencyStorage`; the in-memory store is the default and the test double.
// The contract suite is in `@nestjs/idempotency/testing`.
export type {
  IdempotencyAcquireResult,
  IdempotencySealedResponse,
  IdempotencyStorageRegisterOptions,
  IdempotencyStore,
  IdempotencyStoredPayload,
  IdempotencyStoredResponse,
} from './interfaces/index.js';
export { IdempotencyStorage } from './storage/index.js';
export { InMemoryIdempotencyStore } from './stores/index.js';

// Rejections: the `code` in HTTP bodies, GraphQL extensions and RPC errors
export type { IdempotencyErrorCode } from './interfaces/index.js';

// Events: `IdempotencyEvents.events$`, and `nestjs:idempotency:*` diagnostics channels
export {
  IdempotencyEvents,
  type IdempotencyEvent,
  type IdempotencyLockLostEvent,
  type IdempotencyRejectedEvent,
  type IdempotencyReplayedEvent,
} from './events/index.js';
