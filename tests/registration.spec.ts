import { Controller, Inject, Injectable, Module, Post } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { createApp } from './support/adapters.js';
import {
  IDEMPOTENCY_MODULE_OPTIONS,
  Idempotent,
  IdempotencyEvents,
  IdempotencyModule,
  IdempotencyStorage,
  type IdempotencyModuleOptions,
  type IdempotencyOptionsFactory,
} from '../lib/index.js';

const CONFIG = Symbol('CONFIG');

@Module({ providers: [{ provide: CONFIG, useValue: { header: 'X-Request-Key', ttl: '1h' } }], exports: [CONFIG] })
class ConfigModule {}

@Injectable()
class IdempotencyConfig implements IdempotencyOptionsFactory {
  constructor(@Inject(CONFIG) private readonly config: IdempotencyModuleOptions) {}
  createIdempotencyOptions() {
    return { ...this.config, required: true };
  }
}

@Module({ imports: [ConfigModule], providers: [IdempotencyConfig], exports: [IdempotencyConfig] })
class IdempotencyConfigModule {}

/** A feature module that doesn't import IdempotencyModule. */
@Injectable()
class Metrics {
  constructor(readonly events: IdempotencyEvents, readonly storage: IdempotencyStorage) {}
}

@Module({ providers: [Metrics] })
class MetricsModule {}

describe('IdempotencyModule registration', () => {
  it('forRootAsync({ imports, inject, useFactory }) resolves the options from another module', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        IdempotencyModule.forRootAsync({
          imports: [ConfigModule],
          inject: [CONFIG],
          useFactory: async (config: IdempotencyModuleOptions) => ({ ...config, retryAfter: '5s' }),
        }),
      ],
    }).compile();

    expect(moduleRef.get(IDEMPOTENCY_MODULE_OPTIONS)).toEqual({
      header: 'X-Request-Key',
      ttl: '1h',
      retryAfter: '5s',
    });
    await moduleRef.close();
  });

  it('forRootAsync({ useExisting }) reuses a factory another module provides, and its options apply', async () => {
    @Controller('payments')
    class PaymentsController {
      calls = 0;
      @Post()
      @Idempotent()
      pay() {
        return { n: ++this.calls };
      }
    }

    @Module({
      imports: [
        IdempotencyModule.forRootAsync({ imports: [IdempotencyConfigModule], useExisting: IdempotencyConfig }),
      ],
      controllers: [PaymentsController],
    })
    class AppModule {}

    const app = await createApp('express', AppModule, { setup: (a) => a.useLogger(false) });
    try {
      const post = () => request(app.getHttpServer()).post('/payments');

      const missing = await post().set('Idempotency-Key', 'k1');
      expect(missing.status).toBe(400);
      expect(missing.body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');

      await post().set('X-Request-Key', 'k1');
      const retry = await post().set('x-request-key', 'k1');
      expect(retry.headers['idempotent-replayed']).toBe('true');
      expect(retry.body).toEqual({ n: 1 });
    } finally {
      await app.close();
    }
  });

  it('is global by default: any module injects IdempotencyEvents and IdempotencyStorage', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [IdempotencyModule.forRoot(), MetricsModule],
    }).compile();

    const metrics = moduleRef.get(Metrics);
    expect(metrics.events).toBe(moduleRef.get(IdempotencyEvents));
    expect(metrics.storage).toBe(moduleRef.get(IdempotencyStorage));
    await moduleRef.close();
  });

  it('with isGlobal: false, only modules that import it can inject its providers', async () => {
    for (const module of [
      IdempotencyModule.forRoot({ isGlobal: false }),
      IdempotencyModule.forRootAsync({ isGlobal: false, useFactory: () => ({}) }),
    ]) {
      await expect(Test.createTestingModule({ imports: [module, MetricsModule] }).compile()).rejects.toThrow(
        /Nest can't resolve dependencies of the Metrics/,
      );
    }
  });
});
