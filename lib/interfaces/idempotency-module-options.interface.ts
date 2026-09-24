import type { ConfigurableModuleAsyncOptions, Type } from '@nestjs/common';
import type { IdempotentOptions } from './idempotent-options.interface.js';

export interface IdempotencyEncryptionOptions {
  /**
   * AES-256-GCM keys: 32-byte `Buffer`s, or strings of at least 32
   * characters (random secrets, expanded with HKDF-SHA256; not passwords).
   * The first key seals new records, and every key opens them. Prepend a
   * new key to rotate.
   */
  keys: (string | Buffer)[];
}

/**
 * Configuration values: what `forRootAsync()`'s `useFactory` returns, and
 * what `forRoot()` takes next to the structural options.
 */
export interface IdempotencyModuleOptions extends IdempotentOptions {
  /**
   * The header carrying the key (HTTP and GraphQL requests, RPC transport
   * headers). Default `Idempotency-Key`.
   */
  header?: string;
  /**
   * Response headers captured and replayed in addition to the defaults
   * (`location`, `content-type`, `content-language`, `content-location`, `etag`,
   * `last-modified`).
   * `set-cookie` and the headers the platform writes for every response
   * (`content-length`, `transfer-encoding`, `date`, hop-by-hop headers) are
   * refused at startup.
   */
  replayHeaders?: string[];
  /** Encrypts stored results (body and headers) at rest. Off by default. */
  encryption?: IdempotencyEncryptionOptions;
  /**
   * Lets a production app (`NODE_ENV=production`) start without a registered
   * store, on the in-memory default. Only for a single instance that may
   * forget its records on restart. Default `false`: startup fails, saying
   * which interface to implement and how to register it.
   */
  allowInMemoryStorage?: boolean;
}

/**
 * Structural options, given at the top level of both `forRoot()` and
 * `forRootAsync()` (never returned by `useFactory`), because they decide how
 * the module is registered.
 */
export interface IdempotencyModuleExtras {
  /** Register the module globally. Default `true`. */
  isGlobal?: boolean;
}

export type IdempotencyModuleForRootOptions = IdempotencyModuleOptions & IdempotencyModuleExtras;

/**
 * What a `forRootAsync({ useClass })` (or `useExisting`) class implements,
 * like `JwtOptionsFactory` for `JwtModule`.
 */
export interface IdempotencyOptionsFactory {
  createIdempotencyOptions(): IdempotencyModuleOptions | Promise<IdempotencyModuleOptions>;
}

/**
 * What `forRootAsync()` takes: `useFactory` (with `inject`), `useClass` or
 * `useExisting`, next to the structural options.
 */
export interface IdempotencyModuleAsyncOptions
  extends Omit<
      ConfigurableModuleAsyncOptions<IdempotencyModuleOptions, 'createIdempotencyOptions'>,
      'useClass' | 'useExisting'
    >,
    IdempotencyModuleExtras {
  useClass?: Type<IdempotencyOptionsFactory>;
  useExisting?: Type<IdempotencyOptionsFactory>;
}
