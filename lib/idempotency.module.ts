import { Module, type DynamicModule, type OnModuleInit } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { IdempotencyEvents } from './events/idempotency-events.service.js';
import { IdempotencyStorage, LOCK_STORAGE } from './storage/idempotency.storage.js';
import { IdempotencyInterceptor } from './interceptors/idempotency.interceptor.js';
import {
  ConfigurableModuleClass,
  type ASYNC_OPTIONS_TYPE,
  type OPTIONS_TYPE,
} from './idempotency.module-definition.js';
import type {
  IdempotencyModuleAsyncOptions,
  IdempotencyModuleForRootOptions,
} from './interfaces/idempotency-module-options.interface.js';

/**
 * `IdempotencyModule.forRoot(options?)` or `forRootAsync({ isGlobal, imports,
 * inject, useFactory | useClass | useExisting })`, where the factory returns
 * the options.
 *
 * Registers one app-wide interceptor that is a no-op for every handler not
 * marked with `@Idempotent()`. Being global, it runs outside controller and
 * handler interceptors, so it stores what the client actually receives
 * (after serializers ran) and a replay short-circuits them. A global
 * interceptor registered before it runs outside it: see
 * `IdempotencyInterceptor#onApplicationBootstrap()`.
 *
 * Records live in the store the app registers with `IdempotencyStorage`, or
 * in memory. The registry locks in `onModuleInit`, when every provider
 * constructor (where stores register) has run and no request is served yet,
 * or at the first read of the store if that comes earlier.
 */
@Module({
  providers: [
    IdempotencyStorage,
    IdempotencyEvents,
    IdempotencyInterceptor,
    { provide: APP_INTERCEPTOR, useExisting: IdempotencyInterceptor },
  ],
  exports: [IdempotencyStorage, IdempotencyEvents],
})
export class IdempotencyModule extends ConfigurableModuleClass implements OnModuleInit {
  constructor(private readonly storage: IdempotencyStorage) {
    super();
  }

  static forRoot(options: IdempotencyModuleForRootOptions = {}): DynamicModule {
    return super.forRoot(options as typeof OPTIONS_TYPE);
  }

  /**
   * Options from `useFactory` (with `inject`), or from a class that
   * implements `IdempotencyOptionsFactory` (`useClass`, `useExisting`).
   */
  static forRootAsync(options: IdempotencyModuleAsyncOptions): DynamicModule {
    return super.forRootAsync(options as typeof ASYNC_OPTIONS_TYPE);
  }

  /**
   * Every provider constructor has run (so the store provider has registered), and no
   * request is served yet: the registry locks here, if a read in another module's
   * `onModuleInit` hasn't locked it already.
   */
  onModuleInit() {
    this.storage[LOCK_STORAGE]();
  }
}
