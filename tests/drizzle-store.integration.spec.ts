/**
 * The documented Drizzle recipe (DrizzleIdempotencyStore in tests/fixtures, on its migration) under
 * whole apps: HTTP on both platforms, GraphQL and TCP microservices, on PGlite and on a real
 * PostgreSQL (tests/support/postgres.ts; skipped with the reason when there is none), with two
 * app instances sharing one database as two production instances do.
 */
import { ApolloDriver, type ApolloDriverConfig } from '@nestjs/apollo';
import {
  Body,
  Controller,
  Header,
  HttpCode,
  HttpException,
  Module,
  Post,
  ServiceUnavailableException,
  type INestApplication,
  type INestMicroservice,
} from '@nestjs/common';
import { getDrizzleToken } from '@nestjs/drizzle';
import { Args, Field, GraphQLModule, ID, Int, Mutation, ObjectType, Query, Resolver } from '@nestjs/graphql';
import {
  ClientProxyFactory,
  EventPattern,
  MessagePattern,
  Payload,
  Transport,
  type ClientProxy,
} from '@nestjs/microservices';
import { Test } from '@nestjs/testing';
import type { AddressInfo, Server } from 'node:net';
import { firstValueFrom } from 'rxjs';
import request from 'supertest';
import { createApp, type AdapterName } from './support/adapters.js';
import { startPostgres } from './support/postgres.js';
import {
  IdempotencyEvents,
  IdempotencyModule,
  IdempotencyStorage,
  Idempotent,
  InMemoryIdempotencyStore,
  type IdempotencyEvent,
  type IdempotencyModuleOptions,
} from '../lib/index.js';
import { loadDrizzleRecipe, pgliteDatabase, postgresDatabase, type RecordsDatabase } from './recipes.js';

const { DrizzleIdempotencyStore } = await loadDrizzleRecipe();

// A WebAssembly database, and a PostgreSQL cluster started for the file.
vi.setConfig({ testTimeout: 20_000, hookTimeout: 60_000 });

const OLD_KEY = 'idempotency-test-key-2025-not-a-secret-0001';
const NEW_KEY = 'idempotency-test-key-2026-not-a-secret-0002';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

async function until(check: () => boolean | Promise<boolean>, timeout = 5_000) {
  const start = performance.now();
  while (!(await check())) {
    if (performance.now() - start > timeout) {
      throw new Error('Timed out waiting');
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

const state = {
  calls: {} as Record<string, number>,
  /** Held by the next call of `create` only, so a retry that takes over runs straight through. */
  gate: undefined as ReturnType<typeof deferred> | undefined,
  started: undefined as ReturnType<typeof deferred> | undefined,
  ledger: [] as string[],
  emails: [] as string[],
};
const hit = (name: string) => (state.calls[name] = (state.calls[name] ?? 0) + 1);

function reset() {
  state.calls = {};
  state.gate = undefined;
  state.started = undefined;
  state.ledger = [];
  state.emails = [];
}

@Controller('payments')
class PaymentsController {
  @Post()
  @Idempotent()
  @HttpCode(202)
  @Header('Location', '/payments/pending')
  async create(@Body() body: { amount: number }) {
    const n = hit('create');
    const gate = state.gate;
    state.gate = undefined;
    if (gate) {
      state.started?.resolve();
      await gate.promise;
    }
    // "\u0000" is why the recipe's column is json: jsonb refuses it.
    return { id: `pay_${n}`, amount: body.amount, memo: 'Zażółć \u0000 gęślą' };
  }

  @Post('receipt')
  @Idempotent()
  receipt() {
    return Buffer.from(`%PDF-1.7 receipt ${hit('receipt')}`);
  }

  @Post('declined')
  @Idempotent()
  declined() {
    hit('declined');
    throw new HttpException({ statusCode: 402, message: 'Card declined', code: 'card_declined' }, 402);
  }

  @Post('outage')
  @Idempotent()
  outage() {
    if (hit('outage') === 1) {
      throw new ServiceUnavailableException('Ledger unavailable');
    }
    return { ok: true };
  }
}

function appModule(db: unknown, options: IdempotencyModuleOptions) {
  @Module({
    imports: [
      IdempotencyModule.forRoot({
        scope: (req: { headers: Record<string, string | undefined> }) => req.headers['x-user-id'],
        ...options,
      }),
    ],
    controllers: [PaymentsController],
    providers: [{ provide: getDrizzleToken(), useValue: db }, DrizzleIdempotencyStore],
  })
  class AppModule {}
  return AppModule;
}

const boot = (adapter: AdapterName, db: unknown, options: IdempotencyModuleOptions = {}) =>
  createApp(adapter, appModule(db, options), { setup: (app) => app.useLogger(false) });

function pay(app: INestApplication, key: string, { user = 'alice', body = { amount: 10 }, path = '/payments' } = {}) {
  return request(app.getHttpServer()).post(path).set('x-user-id', user).set('Idempotency-Key', key).send(body);
}

function eventsOf(app: INestApplication) {
  const events: IdempotencyEvent[] = [];
  app.get(IdempotencyEvents).events$.subscribe((event) => events.push(event));
  return events;
}

const started = await startPostgres();
const server = started.postgres;
afterAll(() => server?.stop());
if (!server) {
  console.warn(`DrizzleIdempotencyStore on PostgreSQL skipped: ${started.reason}`);
}

describe.each(['express', 'fastify'] as const)('the Drizzle recipe on PGlite, one app (%s)', (adapter) => {
  let database: RecordsDatabase;
  let app: INestApplication;

  beforeAll(async () => {
    database = await pgliteDatabase();
    app = await boot(adapter, database.db, { ttl: '1h' });
  });
  afterAll(async () => {
    state.gate?.resolve();
    await app?.close();
    await database?.close();
  });
  beforeEach(async () => {
    reset();
    await database.clear();
  });
  afterEach(() => vi.useRealTimers());

  it('serves every call from the recipe store, which registered itself on the database it was given', () => {
    expect(app.get(IdempotencyStorage).source).toBe(app.get(DrizzleIdempotencyStore));
  });

  it('keeps the first response in idempotency_keys and replays status, Location and body from the row', async () => {
    const first = await pay(app, 'k1');
    expect(first.status).toBe(202);
    expect(first.headers.location).toBe('/payments/pending');
    expect(first.headers['idempotent-replayed']).toBeUndefined();
    expect(first.body).toEqual({ id: 'pay_1', amount: 10, memo: 'Zażółć \u0000 gęślą' });

    expect(await database.rows()).toEqual([
      {
        key: 'alice:k1',
        fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
        owner: null,
        response: { status: 202, headers: { location: '/payments/pending' }, body: first.body },
        expiresAt: expect.any(Number),
      },
    ]);

    const retry = await pay(app, 'k1');
    expect(retry.status).toBe(202);
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(retry.headers.location).toBe('/payments/pending');
    expect(retry.body).toEqual(first.body);
    expect(state.calls.create).toBe(1);
  });

  it('replays a binary body through the json column, tagged so it comes back as bytes', async () => {
    const first = await pay(app, 'k1', { path: '/payments/receipt' });
    const retry = await pay(app, 'k1', { path: '/payments/receipt' });

    expect(await database.rawResponse('alice:k1')).toContain('"__idempotencyType":"Bytes"');
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(retry.headers['content-type']).toBe(first.headers['content-type']);
    expect(retry.body).toEqual(first.body);
    expect(state.calls.receipt).toBe(1);
  });

  it('answers a duplicate with 409 while the lock row is held, and the same key with another body with 422', async () => {
    const gate = (state.gate = deferred());
    state.started = deferred();
    const first = pay(app, 'k1').then((r) => r);
    await state.started.promise;

    const lock = await database.row('alice:k1');
    expect(lock).toMatchObject({ owner: expect.any(String), response: null });
    expect(lock!.expiresAt).toBeGreaterThan(Date.now() + 55_000); // lockTtl: 60 s by default

    const duplicate = await pay(app, 'k1');
    expect(duplicate.status).toBe(409);
    expect(duplicate.headers['retry-after']).toBe('1');
    expect(duplicate.body.code).toBe('IDEMPOTENCY_KEY_IN_USE');

    gate.resolve();
    expect((await first).status).toBe(202);
    expect(await database.row('alice:k1')).toMatchObject({ owner: null });

    const reused = await pay(app, 'k1', { body: { amount: 11 } });
    expect(reused.status).toBe(422);
    expect(reused.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(state.calls.create).toBe(1);
  });

  it('keeps one row per user for the same client key', async () => {
    await pay(app, 'k1', { user: 'alice' });
    const bob = await pay(app, 'k1', { user: 'bob' });

    expect(bob.headers['idempotent-replayed']).toBeUndefined();
    expect(bob.body.id).toBe('pay_2');
    expect((await database.rows()).map((row) => row.key)).toEqual(['alice:k1', 'bob:k1']);
  });

  it("refuses a row copied under another user's key (the scope is in the fingerprint)", async () => {
    await pay(app, 'k1', { user: 'alice' });
    await database.copy('alice:k1', 'bob:k1');

    const bob = await pay(app, 'k1', { user: 'bob' });
    expect(bob.status).toBe(422);
    expect(bob.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(state.calls.create).toBe(1);
  });

  it('stores a 4xx and replays it from the row, and deletes the lock after a 5xx so the retry runs', async () => {
    const declined = await pay(app, 'k1', { path: '/payments/declined' });
    const again = await pay(app, 'k1', { path: '/payments/declined' });
    expect(declined.status).toBe(402);
    expect(again.status).toBe(402);
    expect(again.body).toEqual({ statusCode: 402, message: 'Card declined', code: 'card_declined' });
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(state.calls.declined).toBe(1);
    expect(await database.row('alice:k1')).toMatchObject({ response: { status: 402, error: 'http' } });

    expect((await pay(app, 'k2', { path: '/payments/outage' })).status).toBe(503);
    expect(await database.row('alice:k2')).toBeUndefined();
    const retried = await pay(app, 'k2', { path: '/payments/outage' });
    expect(retried.status).toBe(201);
    expect(retried.headers['idempotent-replayed']).toBeUndefined();
    expect(state.calls.outage).toBe(2);
  });

  it('forgets a record once ttl has passed on the process clock, and the next call overwrites the row', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-24T12:00:00.000Z'));

    await pay(app, 'k1');
    expect((await database.row('alice:k1'))!.expiresAt).toBe(Date.now() + 3_600_000);

    vi.setSystemTime(Date.now() + 3_599_999);
    expect((await pay(app, 'k1')).headers['idempotent-replayed']).toBe('true');

    vi.setSystemTime(Date.now() + 1);
    const expired = await pay(app, 'k1');
    expect(expired.headers['idempotent-replayed']).toBeUndefined();
    expect(expired.body.id).toBe('pay_2');
    expect(await database.rows()).toEqual([expect.objectContaining({ key: 'alice:k1', response: expect.objectContaining({ body: expired.body }) })]);
  });
});

describe("the README's Testing section, for an app wired to the Drizzle recipe", () => {
  it('overrides the store provider with a plain in-memory instance: the default applies, and the database is never touched', async () => {
    const database = await pgliteDatabase();
    const app = await createApp('express', appModule(database.db, {}), {
      override: (builder) => builder.overrideProvider(DrizzleIdempotencyStore).useValue(new InMemoryIdempotencyStore()),
      setup: (a) => a.useLogger(false),
    });
    try {
      reset();
      await pay(app, 'k1');
      const replay = await pay(app, 'k1');

      const source = app.get(IdempotencyStorage).source;
      expect(source).toBeInstanceOf(InMemoryIdempotencyStore);
      expect((source as InMemoryIdempotencyStore).peek('alice:k1')?.state).toBe('completed');
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(await database.rows()).toEqual([]);
    } finally {
      await app.close();
      await database.close();
    }
  });
});

describe.each(['express', 'fastify'] as const)('the Drizzle recipe on PGlite with encryption at rest (%s)', (adapter) => {
  let database: RecordsDatabase;
  /** Deployed before the rotation: seals with the old key. */
  let before: INestApplication;
  /** After the rotation: seals with the new key, still opens the old one's records. */
  let after: INestApplication;

  beforeAll(async () => {
    database = await pgliteDatabase();
    before = await boot(adapter, database.db, { encryption: { keys: [OLD_KEY] } });
    after = await boot(adapter, database.db, { encryption: { keys: [NEW_KEY, OLD_KEY] } });
  });
  afterAll(async () => {
    await before?.close();
    await after?.close();
    await database?.close();
  });
  beforeEach(async () => {
    reset();
    await database.clear();
  });

  const envelope = async (key: string) => {
    const row = await database.row(key);
    return (row!.response as { sealed: string }).sealed;
  };

  it('stores a sealed envelope only, and an instance with the rotated keys replays it', async () => {
    const first = await pay(before, 'k1');

    expect((await database.row('alice:k1'))!.response).toEqual({ sealed: expect.stringMatching(/^v1\.[^.]{8}\./) });
    const raw = await database.rawResponse('alice:k1');
    for (const plaintext of ['pay_1', 'payments/pending', 'location', '202']) {
      expect(raw).not.toContain(plaintext);
    }

    const replay = await pay(after, 'k1');
    expect(replay.status).toBe(202);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.headers.location).toBe('/payments/pending');
    expect(replay.body).toEqual(first.body);
    expect(state.calls.create).toBe(1);
  });

  it('seals new records with the first key, and an instance without it fails closed (500) and keeps the row', async () => {
    await pay(before, 'k1');
    await pay(after, 'k2');
    expect((await envelope('alice:k2')).split('.')[1]).not.toBe((await envelope('alice:k1')).split('.')[1]);
    const sealed = await envelope('alice:k2');

    const unreadable = await pay(before, 'k2');
    expect(unreadable.status).toBe(500);
    expect(unreadable.body.code).toBe('IDEMPOTENCY_RECORD_UNREADABLE');
    expect(unreadable.headers['idempotent-replayed']).toBeUndefined();
    expect(state.calls.create).toBe(2);
    expect(await envelope('alice:k2')).toBe(sealed);
  });

  it('fails closed on a tampered envelope and on a plaintext response planted in the row', async () => {
    await pay(before, 'k1');
    await pay(before, 'k2');

    const sealed = await envelope('alice:k1');
    const [version, keyId, iv, ciphertext, tag] = sealed.split('.');
    const flipped = (ciphertext![0] === 'A' ? 'B' : 'A') + ciphertext!.slice(1);
    await database.setResponse('alice:k1', { sealed: [version, keyId, iv, flipped, tag].join('.') });
    await database.setResponse('alice:k2', { status: 200, headers: {}, body: { planted: true } });

    for (const key of ['k1', 'k2']) {
      const res = await pay(after, key);
      expect(res.status).toBe(500);
      expect(res.body.code).toBe('IDEMPOTENCY_RECORD_UNREADABLE');
      expect(JSON.stringify(res.body)).not.toContain('planted');
    }
    expect(state.calls.create).toBe(2);
  });
});

// PostgreSQL only where there is one (the reason is logged above).
const databases = [
  {
    name: 'PGlite',
    open: async (): Promise<[RecordsDatabase, RecordsDatabase]> => {
      const shared = await pgliteDatabase();
      return [shared, shared];
    },
  },
  {
    name: 'PostgreSQL (a pg pool per instance)',
    open: async (): Promise<[RecordsDatabase, RecordsDatabase]> => {
      const url = await server!.createDatabase('idempotency_integration');
      const a = await postgresDatabase(url);
      return [a, await postgresDatabase(url, true)];
    },
  },
].slice(0, server ? 2 : 1);

describe.each(databases)('two app instances on one $name database', ({ open }) => {
  let a: INestApplication;
  let b: INestApplication;
  let dbs: [RecordsDatabase, RecordsDatabase];

  beforeAll(async () => {
    dbs = await open();
    // One on each platform: a record either stores, the other replays.
    a = await boot('express', dbs[0].db);
    b = await boot('fastify', dbs[1].db);
  });
  afterAll(async () => {
    state.gate?.resolve();
    await a?.close();
    await b?.close();
    for (const db of new Set(dbs ?? [])) {
      await db.close();
    }
  });
  beforeEach(async () => {
    reset();
    await dbs[0].clear();
  });
  afterEach(() => vi.useRealTimers());

  it('lets exactly one of many duplicates racing across both instances run; the others get 409, then replays on either', async () => {
    const gate = (state.gate = deferred());
    let answered = 0;
    const racing = Array.from({ length: 12 }, (_, i) =>
      pay(i % 2 ? a : b, 'k-race').then((r) => {
        answered++;
        return r;
      }),
    );

    // The winner waits at the gate until every duplicate has been answered.
    await until(() => answered === 11);
    gate.resolve();
    const responses = await Promise.all(racing);

    const winners = responses.filter((r) => r.status === 202);
    const busy = responses.filter((r) => r.status === 409);
    expect(winners).toHaveLength(1);
    expect(busy).toHaveLength(11);
    expect(busy.every((r) => r.body.code === 'IDEMPOTENCY_KEY_IN_USE' && r.headers['retry-after'] === '1')).toBe(true);
    expect(state.calls.create).toBe(1);

    for (const app of [a, b]) {
      const replay = await pay(app, 'k-race');
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(replay.body).toEqual(winners[0]!.body);
    }
  });

  it('fences off an instance whose lock expired: the retry on the other one takes over, and the stale result is not stored', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-24T12:00:00.000Z'));
    const events = eventsOf(a);

    const gate = (state.gate = deferred());
    state.started = deferred();
    const stale = pay(a, 'k1').then((r) => r);
    await state.started.promise;
    expect((await pay(b, 'k1')).status).toBe(409);

    // Instance a stops renewing (a blocked event loop, say) for lockTtl.
    vi.setSystemTime(Date.now() + 60_000);
    const takeover = await pay(b, 'k1');
    expect(takeover.status).toBe(202);
    expect(takeover.headers['idempotent-replayed']).toBeUndefined();
    expect(takeover.body.id).toBe('pay_2');

    gate.resolve();
    const late = await stale;
    expect(late.status).toBe(202);
    expect(late.body.id).toBe('pay_1');

    expect(events).toEqual([
      {
        type: 'lock-lost',
        context: 'http',
        handler: 'PaymentsController.create',
        key: 'k1',
        scope: 'alice',
        phase: 'complete',
      },
    ]);
    expect((await dbs[0].row('alice:k1'))!.response).toMatchObject({ body: { id: 'pay_2' } });
    expect((await pay(a, 'k1')).body.id).toBe('pay_2');
  });

  it('replays on one instance what the other stored, until ttl passes on either clock', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-24T12:00:00.000Z'));

    const first = await pay(a, 'k1');
    vi.setSystemTime(Date.now() + 24 * 3_600_000 - 1); // ttl: 24 h by default
    expect((await pay(b, 'k1')).body).toEqual(first.body);

    vi.setSystemTime(Date.now() + 1);
    const expired = await pay(b, 'k1');
    expect(expired.headers['idempotent-replayed']).toBeUndefined();
    expect(state.calls.create).toBe(2);
  });
});

@ObjectType()
class Receipt {
  @Field(() => ID) id!: string;
  @Field(() => Int) amount!: number;
  /** The DateTime scalar serializes Date instances only: a replay must hand one back. */
  @Field() paidAt!: Date;
}

@Resolver(() => Receipt)
class PaymentsResolver {
  @Query(() => String)
  ping() {
    return 'pong';
  }

  @Mutation(() => Receipt)
  @Idempotent()
  pay(
    @Args('amount', { type: () => Int }) amount: number,
    @Args('idempotencyKey', { type: () => String, nullable: true }) _key?: string,
  ) {
    return { id: `rcpt_${hit('pay')}`, amount, paidAt: new Date('2026-09-24T12:00:00.000Z') };
  }
}

describe('the Drizzle recipe on PGlite behind GraphQL (apollo on express)', () => {
  let database: RecordsDatabase;
  let app: INestApplication;

  beforeAll(async () => {
    database = await pgliteDatabase();

    @Module({
      imports: [
        GraphQLModule.forRoot<ApolloDriverConfig>({ driver: ApolloDriver, autoSchemaFile: true }),
        IdempotencyModule.forRoot({ scope: (req: { headers: Record<string, string> }) => req.headers['x-user-id'] }),
      ],
      providers: [PaymentsResolver, { provide: getDrizzleToken(), useValue: database.db }, DrizzleIdempotencyStore],
    })
    class GraphqlModule {}
    app = await createApp('express', GraphqlModule, { setup: (a) => a.useLogger(false) });
  });
  afterAll(async () => {
    await app?.close();
    await database?.close();
  });
  beforeEach(reset);

  const operation = (key: string) =>
    request(app.getHttpServer())
      .post('/graphql')
      .set('x-user-id', 'alice')
      .set('Idempotency-Key', key)
      .send({ query: 'mutation { a: pay(amount: 1) { id amount paidAt } b: pay(amount: 2) { id amount paidAt } }' });

  it('keeps a row per aliased field, and replays both, Dates included, from the json column', async () => {
    const first = await operation('k1');
    expect(first.body).toEqual({
      data: {
        a: { id: 'rcpt_1', amount: 1, paidAt: '2026-09-24T12:00:00.000Z' },
        b: { id: 'rcpt_2', amount: 2, paidAt: '2026-09-24T12:00:00.000Z' },
      },
    });
    expect((await database.rows()).map((row) => [row.key, row.owner])).toEqual([
      ['alice:k1:a', null],
      ['alice:k1:b', null],
    ]);
    expect(await database.rawResponse('alice:k1:a')).toContain('"__idempotencyType":"Date"');

    const retry = await operation('k1');
    expect(retry.body).toEqual(first.body);
    expect(state.calls.pay).toBe(2);
  });
});

@Controller()
class LedgerConsumer {
  @EventPattern('payment.captured')
  @Idempotent({ keyFrom: { payload: 'meta.eventId' } })
  onCaptured(@Payload() event: { meta: { eventId: string } }) {
    state.ledger.push(event.meta.eventId);
  }

  @MessagePattern('refunds.create')
  @Idempotent()
  refund(@Payload() data: { idempotencyKey: string; amount: number }) {
    return { refundId: `re_${hit('refund')}`, amount: data.amount };
  }
}

/** A second handler of the same event, which must run once too. */
@Controller()
class ReceiptsConsumer {
  @EventPattern('payment.captured')
  @Idempotent({ keyFrom: { payload: 'meta.eventId' } })
  onCaptured(@Payload() event: { meta: { eventId: string } }) {
    state.emails.push(event.meta.eventId);
  }
}

describe('the Drizzle recipe on PGlite behind two TCP consumers (at-least-once delivery)', () => {
  let database: RecordsDatabase;
  const consumers: { microservice: INestMicroservice; client: ClientProxy; events: IdempotencyEvent[] }[] = [];

  beforeAll(async () => {
    database = await pgliteDatabase();

    @Module({
      imports: [IdempotencyModule.forRoot()],
      controllers: [LedgerConsumer, ReceiptsConsumer],
      providers: [{ provide: getDrizzleToken(), useValue: database.db }, DrizzleIdempotencyStore],
    })
    class ConsumerModule {}

    for (let i = 0; i < 2; i++) {
      const moduleRef = await Test.createTestingModule({ imports: [ConsumerModule] }).compile();
      const microservice = moduleRef.createNestMicroservice({
        transport: Transport.TCP,
        options: { host: '127.0.0.1', port: 0 },
      });
      microservice.useLogger(false);
      await microservice.listen();
      const events: IdempotencyEvent[] = [];
      microservice.get(IdempotencyEvents).events$.subscribe((event) => events.push(event));

      const { port } = microservice.unwrap<Server>().address() as AddressInfo;
      const client = ClientProxyFactory.create({ transport: Transport.TCP, options: { host: '127.0.0.1', port } });
      await client.connect();
      consumers.push({ microservice, client, events });
    }
  });
  afterAll(async () => {
    for (const { client, microservice } of consumers) {
      await client.close();
      await microservice.close();
    }
    await database?.close();
  });
  beforeEach(async () => {
    reset();
    await database.clear();
  });

  const emit = (client: ClientProxy, eventId: string) =>
    firstValueFrom(client.emit('payment.captured', { meta: { eventId }, amount: 10 }), { defaultValue: undefined });

  it('runs every handler of an event once, when the broker redelivers it to the other instance', async () => {
    const [first, second] = consumers;
    await emit(first!.client, 'evt_1');
    await until(async () => (await database.rows()).filter((row) => row.owner === null).length === 2);

    await emit(second!.client, 'evt_1');
    await until(() => second!.events.filter((event) => event.type === 'replayed').length === 2);

    expect(state.ledger).toEqual(['evt_1']);
    expect(state.emails).toEqual(['evt_1']);
    expect((await database.rows()).map((row) => row.key)).toEqual([
      'evt_1:LedgerConsumer.onCaptured',
      'evt_1:ReceiptsConsumer.onCaptured',
    ]);
    expect(second!.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'replayed', context: 'rpc', handler: 'ReceiptsConsumer.onCaptured', key: 'evt_1' }),
      ]),
    );
  });

  it('replays a message reply stored by the other instance', async () => {
    const [first, second] = consumers;
    const message = { idempotencyKey: 'rf-1', amount: 5 };

    const reply = await firstValueFrom(first!.client.send('refunds.create', message));
    const replayed = await firstValueFrom(second!.client.send('refunds.create', message));

    expect(reply).toEqual({ refundId: 're_1', amount: 5 });
    expect(replayed).toEqual(reply);
    expect(state.calls.refund).toBe(1);
    expect(await database.row('rf-1:LedgerConsumer.refund')).toMatchObject({ owner: null });
  });
});
