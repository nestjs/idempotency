import { Global, Module } from '@nestjs/common';
import type { RedisClient } from '../idempotency/redis-idempotency.store.js';

export const REDIS = Symbol('REDIS');

/**
 * Stand-in for the app's Redis module. In the tutorial app, REDIS is an
 * ioredis client (`new Redis(process.env.REDIS_URL)`). ioredis isn't
 * installed in this workspace, so this client rejects every command, and the
 * tests override REDIS with the in-process fake in test/fake-redis.ts.
 */
@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      useFactory: (): RedisClient => ({
        eval: () => Promise.reject(new Error('No Redis in this example; override REDIS')),
      }),
    },
  ],
  exports: [REDIS],
})
export class RedisModule {}
