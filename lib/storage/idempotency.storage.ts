import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { IdempotencyStore } from '../interfaces/idempotency-store.interface.js';
import { IDEMPOTENCY_MODULE_OPTIONS } from '../idempotency.module-definition.js';
import type { IdempotencyModuleOptions } from '../interfaces/idempotency-module-options.interface.js';
import { InMemoryIdempotencyStore } from '../stores/in-memory-idempotency.store.js';
import type { IdempotencyStorageRegisterOptions } from '../interfaces/idempotency-storage.interface.js';

/** Internal: locks the registry. `IdempotencyModule.onModuleInit()` and the first read call it. */
export const LOCK_STORAGE = Symbol('IdempotencyStorage.lock');

const STORE_METHODS = ['acquire', 'complete', 'release', 'extend'] as const;
const DEFAULT = 'InMemoryIdempotencyStore (the default: state is lost on restart and not shared between instances)';

/**
 * Where the app registers its idempotency store. Inject it into the provider
 * that implements `IdempotencyStore` and register in the constructor:
 *
 * ```ts
 * constructor(@InjectDrizzle() private readonly db: Database, storage: IdempotencyStorage) {
 *   storage.registerSource(this);
 * }
 * ```
 *
 * With nothing registered, the module uses an `InMemoryIdempotencyStore`,
 * which fails startup in production unless `allowInMemoryStorage` is set.
 * The registry locks in `IdempotencyModule`'s `onModuleInit`, after every
 * provider constructor has run and before any request is served, or at the
 * first read of the store if that is earlier (another module's `onModuleInit`).
 */
@Injectable()
export class IdempotencyStorage {
  private readonly logger = new Logger('IdempotencyModule');
  private registered?: IdempotencyStore;
  private active?: IdempotencyStore;

  constructor(
    @Optional() @Inject(IDEMPOTENCY_MODULE_OPTIONS) private readonly options?: IdempotencyModuleOptions,
  ) {}

  /**
   * Makes `source` the store every `@Idempotent()` handler uses. Call it once,
   * from the constructor of a singleton provider. Throws when `source` is
   * missing a method, when a source is already registered (unless
   * `{ replace: true }`), and once the registry has locked.
   */
  registerSource(source: IdempotencyStore, options: IdempotencyStorageRegisterOptions = {}): void {
    validate(source);

    if (this.active) {
      throw new Error(
        `IdempotencyStorage.registerSource(): ${nameOf(source)} registered after IdempotencyModule initialized (or ` +
          `after its storage was first read), which already uses ${this.registered ? nameOf(this.active) : DEFAULT}. ` +
          'Register from the constructor of a singleton provider: providers of lazy-loaded modules, request-scoped ' +
          'and transient providers, and lifecycle hooks run too late.',
      );
    }

    if (this.registered && !options.replace) {
      throw new Error(
        `IdempotencyStorage.registerSource(): ${nameOf(source)} can't register, ` +
          `${this.registered === source ? 'it already did (the same instance, twice)' : `${nameOf(this.registered)} already did`}. ` +
          'Register one store, or pass { replace: true } to replace it on purpose (tests, wrappers).',
      );
    }

    this.registered = source;
  }

  /**
   * The store in use: the registered source, or the in-memory default.
   * Reading it locks the registry.
   */
  get source(): IdempotencyStore {
    if (!this.active) {
      this[LOCK_STORAGE]();
    }
    return this.active!;
  }

  /** Fixes the source, logs it, and enforces the production guard (which leaves the registry open). */
  [LOCK_STORAGE](): void {
    if (this.active) {
      return;
    }

    if (!this.registered && process.env.NODE_ENV === 'production' && !this.options?.allowInMemoryStorage) {
      throw new Error(
        'IdempotencyStorage: no IdempotencyStore is registered, and NODE_ENV is "production": in memory, idempotency ' +
          'records would be lost on restart and not shared between instances. Implement IdempotencyStore in a ' +
          'provider that injects IdempotencyStorage and calls `storage.registerSource(this)` in its constructor, or set ' +
          '`allowInMemoryStorage: true` in the IdempotencyModule options to run in memory anyway.',
      );
    }

    this.active = this.registered ?? new InMemoryIdempotencyStore();
    this.logger.log(`IdempotencyStorage: ${this.registered ? nameOf(this.registered) : DEFAULT}`);
  }
}

function validate(source: IdempotencyStore): void {
  if (source === null || typeof source !== 'object') {
    throw new TypeError(
      `IdempotencyStorage.registerSource(): expected an object implementing IdempotencyStore, got ${nameOf(source)}.`,
    );
  }

  const missing = STORE_METHODS.filter((method) => typeof (source as unknown as Record<string, unknown>)[method] !== 'function');
  if (missing.length > 0) {
    throw new TypeError(
      `IdempotencyStorage.registerSource(): ${nameOf(source)} doesn't implement IdempotencyStore: ` +
        `${missing.map((m) => `${m}()`).join(', ')} ${missing.length === 1 ? 'is' : 'are'} missing.`,
    );
  }
}

/** How a message names a value: its class, or what it is instead of an instance. */
function nameOf(value: unknown): string {
  if (typeof value === 'function') {
    return `the class ${value.name || '(anonymous)'} (pass an instance)`;
  }
  if (value === null || typeof value !== 'object') {
    return String(value);
  }
  const name = (value as object).constructor?.name;
  return name && name !== 'Object' ? name : 'an object';
}
