/**
 * What @nestjs/resilience documents about idempotency, with IdempotencyModule imported before
 * ResilienceModule: a request's retries run under its one key, a replay never reaches an open
 * breaker, a breaker's 503 isn't stored, a fallback's result is, and a duplicate in flight gets
 * 409 before the bulkhead counts it. `downstream.ts` is resilience's own test dependency.
 */
import { Body, Controller, Module, Post, type INestApplication } from '@nestjs/common';
import { Bulkhead, CircuitBreaker, Fallback, ResilienceModule, ResilienceService, Retry, Signal } from '@nestjs/resilience';
import request from 'supertest';
import { Idempotent, IdempotencyModule } from '../lib/index.js';
import { Downstream, fast, send, until } from './downstream.js';
import { adapters, createApp } from './support/adapters.js';

const downstream = new Downstream();

@Controller('shipments')
class ShipmentsController {
  @Post()
  @Idempotent()
  @Retry({ attempts: 3, backoff: fast, idempotent: true })
  @CircuitBreaker({ name: 'carrier', minimumCalls: 5, openDuration: '30s' })
  create(@Body() _dto: { orderId: string }, @Signal() signal: AbortSignal) {
    return downstream.call('/shipments', signal);
  }

  @Post('queued')
  @Idempotent()
  @Fallback(() => ({ queued: true }))
  queue(@Body() _dto: { orderId: string }) {
    return downstream.call('/queued');
  }

  @Post('exclusive')
  @Idempotent()
  @Bulkhead({ maxConcurrent: 1 })
  exclusive(@Body() _dto: { orderId: string }) {
    return downstream.call('/exclusive');
  }
}

@Module({
  imports: [IdempotencyModule.forRoot(), ResilienceModule.forRoot()],
  controllers: [ShipmentsController],
})
class IdempotentShippingModule {}

describe.each(adapters.map((a) => a.name))('With packages/idempotency imported first (%s)', (adapter) => {
  let app: INestApplication;

  beforeAll(async () => {
    await downstream.start();
    app = await createApp(adapter, IdempotentShippingModule, { setup: (a) => a.useLogger(false) });
  });
  afterAll(async () => {
    await app.close();
    await downstream.stop();
  });
  beforeEach(() => {
    downstream.reset();
    app.get(ResilienceService).circuitBreaker('carrier').reset();
  });
  afterEach(() => downstream.release());

  const post = (path: string, key: string) =>
    request(app.getHttpServer()).post(path).set('Idempotency-Key', key).send({ orderId: '1001' });

  it('runs the retries of one request under one key, and stores their final outcome', async () => {
    downstream.next('fail');
    const first = await post('/shipments', `${adapter}-a`).expect(201);
    expect(first.body).toEqual({ ok: true, n: 2 });

    const replay = await post('/shipments', `${adapter}-a`).expect(201);
    expect(replay.body).toEqual(first.body);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(downstream.requests).toHaveLength(2);
  });

  it('replays a completed key without reaching the breaker, even while it is open', async () => {
    await post('/shipments', `${adapter}-b`).expect(201);
    app.get(ResilienceService).circuitBreaker('carrier').trip();

    await post('/shipments', `${adapter}-b`).expect(201);
    const fresh = await post('/shipments', `${adapter}-c`).expect(503);
    expect(fresh.body.code).toBe('CIRCUIT_OPEN');
    expect(downstream.requests).toHaveLength(1);
  });

  it("doesn't store a 503 from the breaker: the same key runs once the breaker closed", async () => {
    app.get(ResilienceService).circuitBreaker('carrier').trip();
    await post('/shipments', `${adapter}-d`).expect(503);

    app.get(ResilienceService).circuitBreaker('carrier').reset();
    await post('/shipments', `${adapter}-d`).expect(201, { ok: true, n: 1 });
  });

  it('stores a fallback result like any success, and replays it', async () => {
    downstream.mode = 'fail';
    await post('/shipments/queued', `${adapter}-e`).expect(201, { queued: true });

    downstream.mode = 'up';
    const replay = await post('/shipments/queued', `${adapter}-e`).expect(201, { queued: true });
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(downstream.requests).toHaveLength(1);
  });

  it('answers a duplicate in flight with 409 before the bulkhead sees it', async () => {
    downstream.mode = 'hold';
    const first = send(post('/shipments/exclusive', `${adapter}-f`));
    await until(() => downstream.requests.length === 1, 'the first request to hold the slot');

    const duplicate = await post('/shipments/exclusive', `${adapter}-f`).expect(409);
    expect(duplicate.body.code).toBe('IDEMPOTENCY_KEY_IN_USE');
    const other = await post('/shipments/exclusive', `${adapter}-g`).expect(503);
    expect(other.body.code).toBe('BULKHEAD_FULL');

    downstream.release();
    expect((await first).status).toBe(201);
    expect(downstream.requests).toHaveLength(1);
  });
});
