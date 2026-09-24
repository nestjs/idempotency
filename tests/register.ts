import type { Provider } from '@nestjs/common';
import { IdempotencyStorage, type IdempotencyStore } from '../lib/index.js';

/**
 * A provider that registers `store` as the app's source while Nest creates
 * it, as an app's store provider does in its constructor. For tests that
 * hold on to a store instance (to `peek()` into it, or spy on it).
 */
export function registered(store: IdempotencyStore): Provider {
  return {
    provide: Symbol(`registered ${store.constructor.name}`),
    inject: [IdempotencyStorage],
    useFactory: (storage: IdempotencyStorage) => {
      storage.registerSource(store);
      return store;
    },
  };
}
