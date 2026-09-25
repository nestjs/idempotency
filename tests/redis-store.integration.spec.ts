/**
 * The documented Redis recipe (RedisIdempotencyStore in tests/fixtures) under whole apps on both
 * platforms. There is no Redis server in the workspace: the store runs against the fixtures'
 * FakeRedis, its four Lua scripts transliterated, which expires keys by a clock of its own, as
 * Redis does. Two app instances share one "server".
 */
import { Body, Controller, Module, Post, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { adapters, createApp, type AdapterName } from './support/adapters.js';
import {
  IdempotencyEvents,
  IdempotencyModule,
  IdempotencyStorage,
  Idempotent,
  type IdempotencyEvent,
  type IdempotencyModuleOptions,
} from '../lib/index.js';
import { loadRedisRecipe, type FakeRedis } from './recipes.js';

const { RedisIdempotencyStore, REDIS, FakeRedis: FakeRedisClass } = await loadRedisRecipe();

const KEY = 'idempotency-test-key-redis-not-a-secret-0001';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

async function until(check: () => boolean, timeout = 5_000) {
  const start = performance.now();
  while (!check()) {
    if (performance.now() - start > timeout) {
      throw new Error('Timed out waiting');
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

const state = {
  calls: 0,
  /** Held by the next call only, so a retry that takes over runs straight through. */
  gate: undefined as ReturnType<typeof deferred> | undefined,
  started: undefined as ReturnType<typeof deferred> | undefined,
};

@Controller('refunds')
class RefundsController {
  @Post()
  @Idempotent()
  async create(@Body() body: { amount: number }) {
    const n = ++state.calls;
    const gate = state.gate;
    state.gate = undefined;
    if (gate) {
      state.started?.resolve();
      await gate.promise;
    }
    return { id: `re_${n}`, amount: body.amount };
  }
}

function boot(adapter: AdapterName, redis: FakeRedis, options: IdempotencyModuleOptions = {}) {
  @Module({
    imports: [
      IdempotencyModule.forRoot({
        scope: (req: { headers: Record<string, string | undefined> }) => req.headers['x-user-id'],
        ttl: '1h',
        lockTtl: '30s',
        ...options,
      }),
    ],
    controllers: [RefundsController],
    providers: [{ provide: REDIS, useValue: redis }, RedisIdempotencyStore],
  })
  class AppModule {}
  return createApp(adapter, AppModule, { setup: (app) => app.useLogger(false) });
}

function refund(app: INestApplication, key: string, { user = 'alice', amount = 10 } = {}) {
  return request(app.getHttpServer()).post('/refunds').set('x-user-id', user).set('Idempotency-Key', key).send({ amount });
}

describe.each(adapters.map((a) => a.name))('the Redis recipe, two instances on one server (%s)', (adapter) => {
  let redis: FakeRedis;
  let a: INestApplication;
  let b: INestApplication;

  beforeEach(async () => {
    state.calls = 0;
    state.gate = undefined;
    state.started = undefined;
    redis = new FakeRedisClass();
    a = await boot(adapter, redis);
    b = await boot(adapter, redis);
  });
  afterEach(async () => {
    state.gate?.resolve();
    await a.close();
    await b.close();
  });

  it('serves every call from the recipe store, which registered itself', () => {
    expect(a.get(IdempotencyStorage).source).toBe(a.get(RedisIdempotencyStore));
  });

  it('keeps the record in one hash, expiring after ttl on the server, and replays it on either instance', async () => {
    const first = await refund(a, 'k1');
    expect(first.status).toBe(201);

    const hash = redis.hgetall('idem:alice:k1');
    expect(hash).toEqual({ state: 'completed', fp: expect.stringMatching(/^[0-9a-f]{64}$/), resp: expect.any(String) });
    expect(JSON.parse(hash!.resp)).toEqual({ status: 201, headers: {}, body: { id: 're_1', amount: 10 } });
    expect(redis.ttlOf('idem:alice:k1')).toBeGreaterThan(3_590_000);

    for (const app of [a, b]) {
      const replay = await refund(app, 'k1');
      expect(replay.status).toBe(201);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(replay.body).toEqual(first.body);
    }
    expect(state.calls).toBe(1);

    redis.advance(3_600_000);
    expect(redis.keys()).toEqual([]);
    const expired = await refund(b, 'k1');
    expect(expired.headers['idempotent-replayed']).toBeUndefined();
    expect(expired.body.id).toBe('re_2');
  });

  it('answers duplicates on the other instance with 409 while the lock hash lives, and another body with 422', async () => {
    const gate = (state.gate = deferred());
    state.started = deferred();
    const first = refund(a, 'k1').then((r) => r);
    await state.started.promise;

    expect(redis.hgetall('idem:alice:k1')).toEqual({ state: 'in-flight', fp: expect.any(String), owner: expect.any(String) });
    expect(redis.ttlOf('idem:alice:k1')).toBeGreaterThan(29_000);
    const busy = await refund(b, 'k1');
    expect(busy.status).toBe(409);
    expect(busy.body.code).toBe('IDEMPOTENCY_KEY_IN_USE');

    gate.resolve();
    expect((await first).status).toBe(201);
    const reused = await refund(b, 'k1', { amount: 11 });
    expect(reused.status).toBe(422);
    expect(reused.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(state.calls).toBe(1);
  });

  it('lets exactly one of many duplicates racing across both instances run', async () => {
    const gate = (state.gate = deferred());
    let answered = 0;
    const racing = Array.from({ length: 10 }, (_, i) =>
      refund(i % 2 ? a : b, 'k-race').then((r) => {
        answered++;
        return r;
      }),
    );

    await until(() => answered === 9);
    gate.resolve();
    const statuses = (await Promise.all(racing)).map((r) => r.status).sort();

    expect(statuses).toEqual([201, ...Array(9).fill(409)]);
    expect(state.calls).toBe(1);
  });

  it('lets a retry take over once the lock of a stalled instance expires on the server, and fences the stalled one off', async () => {
    const events: IdempotencyEvent[] = [];
    a.get(IdempotencyEvents).events$.subscribe((event) => events.push(event));

    const gate = (state.gate = deferred());
    state.started = deferred();
    const stalled = refund(a, 'k1').then((r) => r);
    await state.started.promise;

    redis.advance(30_000);
    const takeover = await refund(b, 'k1');
    expect(takeover.body.id).toBe('re_2');

    gate.resolve();
    expect((await stalled).body.id).toBe('re_1');
    expect(events).toEqual([expect.objectContaining({ type: 'lock-lost', phase: 'complete', key: 'k1', scope: 'alice' })]);
    expect(JSON.parse(redis.hgetall('idem:alice:k1')!.resp).body.id).toBe('re_2');
  });

  it("encodes each part of the key, so a client can't place its record with a Redis Cluster hash tag", async () => {
    await refund(a, '{alice}:k1', { user: 'bob' });

    expect(redis.keys()).toEqual(['idem:bob:%7Balice%7D%3Ak1']);
  });
});

describe('the Redis recipe with encryption at rest', () => {
  it('keeps only a sealed envelope in the hash, which another instance with the key opens', async () => {
    state.calls = 0;
    const redis = new FakeRedisClass();
    const a = await boot('express', redis, { encryption: { keys: [KEY] } });
    const b = await boot('fastify', redis, { encryption: { keys: [KEY] } });
    try {
      const first = await refund(a, 'k1');

      const resp = redis.hgetall('idem:alice:k1')!.resp;
      expect(JSON.parse(resp)).toEqual({ sealed: expect.stringMatching(/^v1\./) });
      expect(resp).not.toContain('re_1');

      const replay = await refund(b, 'k1');
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(replay.body).toEqual(first.body);
      expect(state.calls).toBe(1);
    } finally {
      await a.close();
      await b.close();
    }
  });
});
