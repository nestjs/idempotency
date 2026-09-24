import {
  BadRequestException,
  Catch,
  ForbiddenException,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
  Body,
  Controller,
  Header,
  Headers,
  HttpCode,
  Module,
  RequestMethod,
  type MiddlewareConsumer,
  type NestModule,
  Param,
  Post,
  Redirect,
  Res,
  Sse,
  StreamableFile,
  type INestApplication,
} from '@nestjs/common';
import { Readable } from 'node:stream';
import { from, interval, map, take } from 'rxjs';
import request from 'supertest';
import { adapters, createApp } from './support/adapters.js';
import { APP_FILTER, HttpAdapterHost } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import {
  Idempotent,
  IdempotencyModule,
  InMemoryIdempotencyStore,
} from '../lib/index.js';
import { captureHttpOrUnknownError } from '../lib/contexts/context.adapter.js';
import type { InMemoryEntry } from '../lib/stores/in-memory-idempotency.store.js';
import { registered } from './register.js';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A transport-agnostic "the caller did something wrong" error with a numeric
 * 4xx `status` (CONVENTIONS rule 7: `AuthorizationError`), which its package
 * turns into Nest's exception outside the idempotency interceptor.
 */
class DeniedError extends Error {
  override readonly name = 'DeniedError';
  readonly status = 403;
}

@Catch(DeniedError)
class DeniedFilter implements ExceptionFilter {
  constructor(private readonly adapterHost: HttpAdapterHost) {}

  catch(_error: DeniedError, host: ArgumentsHost) {
    const exception = new ForbiddenException();
    this.adapterHost.httpAdapter.reply(host.switchToHttp().getResponse(), exception.getResponse(), 403);
  }
}

/** Per-test mutable state the controller reads; reset in beforeEach. */
const state = {
  calls: {} as Record<string, number>,
  gate: undefined as ReturnType<typeof deferred<void>> | undefined,
  started: undefined as ReturnType<typeof deferred<void>> | undefined,
  failNext: 0,
};
const hit = (name: string) => (state.calls[name] = (state.calls[name] ?? 0) + 1);

@Controller('orders')
class OrdersController {
  @Post()
  @Idempotent()
  async create(@Body() body: { amount: number }) {
    const n = hit('create');
    if (state.gate) {
      state.started?.resolve();
      await state.gate.promise;
    }
    return { id: `ord_${n}`, amount: body.amount };
  }

  @Post('required')
  @Idempotent({ required: true })
  createRequired() {
    hit('required');
    return { ok: true };
  }

  @Post('reject')
  @Idempotent()
  reject() {
    hit('reject');
    throw new BadRequestException('Insufficient funds');
  }

  /** The body's language comes from the request, as with `@nestjs/i18n`. */
  @Post('localized')
  @Idempotent()
  localized(@Headers('accept-language') language: string) {
    hit('localized');
    return { message: language === 'pl' ? 'Dziękujemy' : 'Thank you' };
  }

  @Post('denied')
  @Idempotent()
  denied() {
    hit('denied');
    throw new DeniedError('Not your order');
  }

  @Post('flaky')
  @Idempotent()
  flaky() {
    const n = hit('flaky');
    if (state.failNext > 0) {
      state.failNext--;
      throw new Error('database is down');
    }
    return { attempt: n };
  }

  @Post('short-ttl')
  @Idempotent({ ttl: 100 })
  shortTtl() {
    return { attempt: hit('short-ttl') };
  }

  @Post('short-lock')
  @Idempotent({ lockTtl: 100 })
  async shortLock() {
    const n = hit('short-lock');
    if (n === 1) {
      await state.gate!.promise; // "crashed" first attempt
    }
    return { attempt: n };
  }

  @Post('short-lock-fail')
  @Idempotent({ lockTtl: 100 })
  async shortLockFail() {
    const n = hit('short-lock-fail');
    if (n === 1) {
      await state.gate!.promise; // "crashed" first attempt, fails late
      throw new Error('connection reset');
    }
    return { attempt: n };
  }

  @Post('csv')
  @Idempotent()
  @Header('Content-Type', 'text/csv')
  csv() {
    return `id\n${hit('csv')}\n`;
  }

  @Post('accepted')
  @Idempotent()
  @HttpCode(202)
  @Header('Location', '/orders/jobs/42')
  accepted() {
    return { job: hit('accepted') };
  }

  @Post('passthrough')
  @Idempotent()
  passthrough(@Res({ passthrough: true }) res: any) {
    res.status(203);
    res.header('ETag', '"v1"');
    res.header('X-Not-Allowlisted', 'nope');
    return { n: hit('passthrough') };
  }

  @Post('redirect')
  @Idempotent()
  @Redirect('/default', 303)
  redirect() {
    return { url: `/orders/ord_${hit('redirect')}` };
  }

  @Post('file')
  @Idempotent()
  file() {
    hit('file');
    return new StreamableFile(Readable.from([Buffer.from('pdf-bytes')]));
  }

  @Post('last')
  @Idempotent()
  last() {
    const n = hit('last');
    // The router sends the last value: that is the whole response.
    return from([{ step: 1, n }, { step: 2, n }]);
  }

  @Post('bytes')
  @Idempotent()
  bytes() {
    return Buffer.from(`receipt-${hit('bytes')}`);
  }

  @Post('manual')
  @Idempotent()
  manual(@Res() res: any) {
    const n = hit('manual');
    // Writes the response itself, after the handler returned.
    setTimeout(() => res.status(201).send({ n }), 10);
  }

  @Sse('events')
  @Idempotent()
  events() {
    hit('events');
    return interval(5).pipe(
      take(3),
      map((i) => ({ data: { i } })),
    );
  }

  @Post(':id/refund')
  @Idempotent()
  refund(@Param('id') id: string) {
    return { refunded: id, n: hit('refund') };
  }

  @Post('plain')
  plain() {
    return { n: hit('plain') };
  }
}

@Controller('gift-cards')
@Idempotent({ required: true })
class GiftCardsController {
  @Post()
  issue() {
    return { issued: hit('issue') };
  }

  @Post('bulk')
  @Idempotent({ ttl: 100 })
  issueMany() {
    return { issued: hit('bulk') };
  }
}

const store = new InMemoryIdempotencyStore();

@Module({
  imports: [
    IdempotencyModule.forRoot({
      scope: (req) => req.headers['x-user-id'] as string | undefined,
    }),
  ],
  controllers: [OrdersController, GiftCardsController],
  providers: [{ provide: APP_FILTER, useClass: DeniedFilter }, registered(store)],
})
class AppModule implements NestModule {
  // Labels every response with the request's language, as i18n's middleware does.
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply((req: any, res: any, next: () => void) => {
        res.setHeader('Content-Language', req.headers['accept-language'] ?? 'en');
        next();
      })
      .forRoutes({ path: 'orders/localized', method: RequestMethod.POST });
  }
}

describe.each(adapters.map((a) => a.name))('Idempotency (%s)', (adapter) => {
  let app: INestApplication;
  let server: any;

  beforeAll(async () => {
    app = await createApp(adapter, AppModule, { setup: (a) => a.useLogger(false) });
    server = app.getHttpServer();
  });
  afterAll(async () => {
    state.gate?.resolve();
    await app.close();
  });
  afterEach(() => vi.restoreAllMocks());
  beforeEach(() => {
    store.clear();
    state.calls = {};
    state.gate = undefined;
    state.started = undefined;
    state.failNext = 0;
  });

  const post = (path: string, key?: string, body: object = { amount: 10 }) => {
    const r = request(server).post(path).send(body);
    return key ? r.set('Idempotency-Key', key) : r;
  };

  it('executes the first request and replays retries', async () => {
    const first = await post('/orders', 'k1');
    expect(first.status).toBe(201);
    expect(first.body).toEqual({ id: 'ord_1', amount: 10 });
    expect(first.headers['idempotent-replayed']).toBeUndefined();

    const retry = await post('/orders', 'k1');
    expect(retry.status).toBe(201);
    expect(retry.body).toEqual({ id: 'ord_1', amount: 10 });
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(retry.headers['content-type']).toMatch(/application\/json/);
    expect(state.calls.create).toBe(1);
  });

  it('fingerprints the body independently of key order', async () => {
    await post('/orders', 'k1', { amount: 10, currency: 'eur' });
    const retry = await post('/orders', 'k1', { currency: 'eur', amount: 10 });
    expect(retry.status).toBe(201);
    expect(state.calls.create).toBe(1);
  });

  it('accepts the RFC 8941 quoted-string form of the key', async () => {
    await post('/orders', 'k1');
    const retry = await post('/orders', '"k1"');
    expect(retry.headers['idempotent-replayed']).toBe('true');
  });

  it('rejects the same key with a different payload (422)', async () => {
    await post('/orders', 'k1', { amount: 10 });
    const res = await post('/orders', 'k1', { amount: 99 });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(state.calls.create).toBe(1);
  });

  it('rejects the same key on a different resource (422)', async () => {
    await post('/orders/1/refund', 'k1');
    const res = await post('/orders/2/refund', 'k1');
    expect(res.status).toBe(422);
    expect(state.calls.refund).toBe(1);
  });

  it('rejects a concurrent duplicate while the first is in flight (409)', async () => {
    state.gate = deferred();
    state.started = deferred();
    const first = post('/orders', 'k1').then((r) => r);
    await state.started.promise;

    const dup = await post('/orders', 'k1');
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('IDEMPOTENCY_KEY_IN_USE');
    expect(dup.headers['retry-after']).toBe('1'); // the default, not the 60 s lock

    state.gate.resolve();
    expect((await first).status).toBe(201);
    expect(state.calls.create).toBe(1);

    const retry = await post('/orders', 'k1');
    expect(retry.headers['idempotent-replayed']).toBe('true');
  });

  it('requires the key when configured (400) without running the handler', async () => {
    const res = await post('/orders/required');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    expect(state.calls.required).toBeUndefined();
    expect((await post('/orders/required', 'k1')).status).toBe(201);
  });

  it('rejects over-long keys (400)', async () => {
    expect((await post('/orders', 'x'.repeat(256))).status).toBe(400);
  });

  it('just executes when the key is optional and missing', async () => {
    await post('/orders');
    await post('/orders');
    expect(state.calls.create).toBe(2);
  });

  it('ignores the header on handlers without @Idempotent()', async () => {
    await post('/orders/plain', 'k1');
    const res = await post('/orders/plain', 'k1');
    expect(res.headers['idempotent-replayed']).toBeUndefined();
    expect(state.calls.plain).toBe(2);
  });

  it('stores and replays deterministic 4xx outcomes', async () => {
    const first = await post('/orders/reject', 'k1');
    expect(first.status).toBe(400);

    const retry = await post('/orders/reject', 'k1');
    expect(retry.status).toBe(400);
    expect(retry.body).toEqual(first.body);
    expect(retry.body.message).toBe('Insufficient funds');
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(state.calls.reject).toBe(1);
  });

  it("stores another error's 4xx status as Nest's exception for it, and replays that", async () => {
    const first = await post('/orders/denied', 'k1');
    expect(first.status).toBe(403);

    const retry = await post('/orders/denied', 'k1');

    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(retry.status).toBe(403);
    expect(retry.body).toEqual(first.body);
    expect(retry.body).toEqual({ message: 'Forbidden', statusCode: 403 });
    expect(state.calls.denied).toBe(1);
  });

  it('releases the key on 5xx so a retry re-executes', async () => {
    state.failNext = 1;
    expect((await post('/orders/flaky', 'k1')).status).toBe(500);

    const retry = await post('/orders/flaky', 'k1');
    expect(retry.status).toBe(201);
    expect(retry.body).toEqual({ attempt: 2 });
    expect(retry.headers['idempotent-replayed']).toBeUndefined();
    expect(state.calls.flaky).toBe(2);
  });

  it('isolates scopes: two users with the same key', async () => {
    const alice = await post('/orders', 'k1').set('x-user-id', 'alice');
    const bob = await post('/orders', 'k1', { amount: 99 }).set('x-user-id', 'bob');

    expect(alice.body.id).toBe('ord_1');
    expect(bob.status).toBe(201);
    expect(bob.body).toEqual({ id: 'ord_2', amount: 99 });

    const aliceRetry = await post('/orders', 'k1').set('x-user-id', 'alice');
    expect(aliceRetry.body.id).toBe('ord_1');
    expect(state.calls.create).toBe(2);
  });

  it('forgets completed responses after ttl', async () => {
    await post('/orders/short-ttl', 'k1');
    expect((await post('/orders/short-ttl', 'k1')).body).toEqual({ attempt: 1 });

    await sleep(150);
    const res = await post('/orders/short-ttl', 'k1');
    expect(res.body).toEqual({ attempt: 2 });
    expect(res.headers['idempotent-replayed']).toBeUndefined();
  });

  it('keeps the lock while a handler slower than lockTtl runs (heartbeat)', async () => {
    state.gate = deferred();
    const slow = post('/orders/short-lock', 'k1').then((r) => r);
    await sleep(350); // 3.5x lockTtl

    const dup = await post('/orders/short-lock', 'k1');
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('IDEMPOTENCY_KEY_IN_USE');

    state.gate.resolve();
    expect((await slow).body).toEqual({ attempt: 1 });

    const retry = await post('/orders/short-lock', 'k1');
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(retry.body).toEqual({ attempt: 1 });
    expect(state.calls['short-lock']).toBe(1);
  });

  it('frees an abandoned lock after lockTtl; the stale owner cannot overwrite', async () => {
    // The process holding the lock died: its renewals never reach the store.
    vi.spyOn(store, 'extend').mockResolvedValue(true);
    state.gate = deferred();
    const crashed = post('/orders/short-lock', 'k1').then((r) => r);
    await sleep(20);

    const busy = await post('/orders/short-lock', 'k1');
    expect(busy.status).toBe(409);
    expect(busy.headers['retry-after']).toBe('1'); // < 1s left, floored at 1

    await sleep(120);
    const retry = await post('/orders/short-lock', 'k1');
    expect(retry.status).toBe(201);
    expect(retry.body).toEqual({ attempt: 2 });

    // The "dead" first attempt finishes late: its complete() is fenced off.
    state.gate.resolve();
    await crashed;

    const replay = await post('/orders/short-lock', 'k1');
    expect(replay.body).toEqual({ attempt: 2 });
    expect(replay.headers['idempotent-replayed']).toBe('true');
  });

  it('logs when a stale owner fails and cannot release the new owner\'s lock', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    vi.spyOn(store, 'extend').mockResolvedValue(true); // renewals are lost
    state.gate = deferred();
    const crashed = post('/orders/short-lock-fail', 'k1').then((r) => r);
    await sleep(150);

    const retry = await post('/orders/short-lock-fail', 'k1');
    expect(retry.body).toEqual({ attempt: 2 });

    state.gate.resolve();
    expect((await crashed).status).toBe(500);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('the key was not released'));
    expect((await post('/orders/short-lock-fail', 'k1')).body).toEqual({ attempt: 2 });
  });

  it('merges handler options over class options', async () => {
    const noKey = await post('/gift-cards/bulk');
    expect(noKey.status).toBe(400); // required: true from the class
    expect(noKey.body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');

    await post('/gift-cards/bulk', 'k1');
    expect((await post('/gift-cards/bulk', 'k1')).body).toEqual({ issued: 1 });

    await sleep(150); // ttl: 100 from the handler
    expect((await post('/gift-cards/bulk', 'k1')).body).toEqual({ issued: 2 });
    expect((await post('/gift-cards')).status).toBe(400);
  });

  it('builds record keys without a leading colon, encoding each part', async () => {
    await post('/orders', 'k1');
    await post('/orders', 'k1').set('x-user-id', 'alice');
    await post('/orders', 'alice:k1');

    expect(store.peek('k1')?.state).toBe('completed');
    expect(store.peek('alice:k1')?.state).toBe('completed');
    expect(store.peek('alice%3Ak1')?.state).toBe('completed');
    expect(state.calls.create).toBe(3); // three separate records
  });

  it('binds the scope into the fingerprint: a copied record is not replayed', async () => {
    const alice = await post('/orders', 'k1').set('x-user-id', 'alice');
    expect(alice.status).toBe(201);

    // Someone with write access copies Alice's record under Bob's key.
    const entries = (store as unknown as { entries: Map<string, InMemoryEntry> }).entries;
    entries.set('bob:k1', entries.get('alice:k1')!);

    const bob = await post('/orders', 'k1').set('x-user-id', 'bob');
    expect(bob.status).toBe(422);
    expect(bob.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(state.calls.create).toBe(1);
  });

  it('captures a Content-Type set by the handler', async () => {
    const first = await post('/orders/csv', 'k1');
    expect(first.headers['content-type']).toMatch(/^text\/csv/);

    const retry = await post('/orders/csv', 'k1');
    expect(retry.headers['content-type']).toMatch(/^text\/csv/);
    expect(retry.text).toBe('id\n1\n');

    const stored = store.peek('k1');
    expect(stored?.state === 'completed' && stored.response).toMatchObject({
      headers: { 'content-type': expect.stringMatching(/^text\/csv/) },
    });
  });

  it("replays the stored body's Content-Language, not the retry's", async () => {
    const first = await post('/orders/localized', 'k1').set('Accept-Language', 'pl');
    expect(first.headers['content-language']).toBe('pl');

    const retry = await post('/orders/localized', 'k1').set('Accept-Language', 'en');

    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(retry.body).toEqual({ message: 'Dziękujemy' });
    expect(retry.headers['content-language']).toBe('pl');
  });

  it('replays @HttpCode() and @Header() values', async () => {
    const first = await post('/orders/accepted', 'k1');
    expect(first.status).toBe(202);

    const retry = await post('/orders/accepted', 'k1');
    expect(retry.status).toBe(202);
    expect(retry.headers.location).toBe('/orders/jobs/42');
    expect(retry.body).toEqual({ job: 1 });
    expect(state.calls.accepted).toBe(1);
  });

  it('replays status and allowlisted headers set via @Res({ passthrough: true })', async () => {
    const first = await post('/orders/passthrough', 'k1');
    expect(first.status).toBe(203);

    const retry = await post('/orders/passthrough', 'k1');
    expect(retry.status).toBe(203);
    expect(retry.headers.etag).toBe('"v1"');
    expect(retry.headers['x-not-allowlisted']).toBeUndefined();
    expect(state.calls.passthrough).toBe(1);
  });

  it('replays @Redirect() responses', async () => {
    const first = await post('/orders/redirect', 'k1');
    expect(first.status).toBe(303);
    expect(first.headers.location).toBe('/orders/ord_1');

    const retry = await post('/orders/redirect', 'k1');
    expect(retry.status).toBe(303);
    expect(retry.headers.location).toBe('/orders/ord_1');
    expect(state.calls.redirect).toBe(1);
  });

  it('stores the last value of an Observable, which is what the router sends', async () => {
    const first = await post('/orders/last', 'k1');
    expect(first.body).toEqual({ step: 2, n: 1 });

    const retry = await post('/orders/last', 'k1');
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(retry.body).toEqual({ step: 2, n: 1 });
    expect(state.calls.last).toBe(1);
  });

  it('replays a Buffer result as the same Buffer, whatever the adapter makes of it', async () => {
    const first = await post('/orders/bytes', 'k1');
    const retry = await post('/orders/bytes', 'k1');
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(retry.headers['content-type']).toBe(first.headers['content-type']);
    expect(retry.body).toEqual(first.body);
    expect(state.calls.bytes).toBe(1);
  });

  it('never stores a response the handler wrote itself with @Res()', async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    const first = await post('/orders/manual', 'k1').timeout(2_000);
    expect(first.body).toEqual({ n: 1 });

    // Replaying would hang: with @Res(), Nest leaves writing the response to the handler.
    const retry = await post('/orders/manual', 'k1').timeout(2_000);
    expect(retry.body).toEqual({ n: 2 });
    expect(store.size).toBe(0);
  });

  it('streams Server-Sent Events as they come instead of holding them back', async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});

    const res = await request(server).get('/orders/events').set('Idempotency-Key', 'k1');
    expect(res.text.match(/^data: .*$/gm)).toEqual([
      'data: {"i":0}',
      'data: {"i":1}',
      'data: {"i":2}',
    ]);
    expect(store.size).toBe(0);
  });

  it('rejects a key with characters outside printable ASCII (400)', async () => {
    const res = await post('/orders', 'clé-1');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('IDEMPOTENCY_KEY_INVALID');
    expect(state.calls.create).toBeUndefined();
  });

  it('does not cache streamed responses and releases the key', async () => {
    const first = await post('/orders/file', 'k1');
    expect(first.status).toBe(201);
    await post('/orders/file', 'k1');
    expect(state.calls.file).toBe(2);
    expect(store.size).toBe(0);
  });
});

describe('IdempotencyModule.forRootAsync', () => {
  it('resolves options from a factory', async () => {
    const asyncStore = new InMemoryIdempotencyStore();

    @Controller()
    class C {
      calls = 0;
      @Post()
      @Idempotent()
      create() {
        return { n: ++this.calls };
      }
    }

    @Module({
      imports: [
        IdempotencyModule.forRootAsync({
          useFactory: async () => ({ header: 'X-Request-Key', ttl: '1h' }),
        }),
      ],
      controllers: [C],
      providers: [registered(asyncStore)],
    })
    class AsyncModule {}

    const app = await createApp('express', AsyncModule);
    try {
      const server = app.getHttpServer();
      await request(server).post('/').set('X-Request-Key', 'a');
      const retry = await request(server).post('/').set('X-Request-Key', 'a');
      expect(retry.body).toEqual({ n: 1 });
      expect(retry.headers['idempotent-replayed']).toBe('true');
      expect(asyncStore.size).toBe(1);
    } finally {
      await app.close();
    }
  });
});

describe('IdempotencyModule.forRoot()', () => {
  @Controller('things')
  class ThingsController {
    @Post()
    @Idempotent()
    create() {
      return { n: hit('things') };
    }
  }

  it('works without an options argument', async () => {
    @Module({ imports: [IdempotencyModule.forRoot()], controllers: [ThingsController] })
    class MinimalModule {}

    const moduleRef = await Test.createTestingModule({ imports: [MinimalModule] }).compile();
    const app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');

    try {
      state.calls = {};
      const send = () =>
        request(app.getHttpServer()).post('/things').set('Idempotency-Key', 'k1');

      await send().expect(201);
      const retry = await send().expect(201);
      expect(retry.headers['idempotent-replayed']).toBe('true');
      expect(state.calls.things).toBe(1);
    } finally {
      await app.close();
    }
  });
});

describe('capturing an error that is not an HttpException', () => {
  const capture = (error: unknown, storeIf = (_status: number, _error?: unknown) => true) =>
    captureHttpOrUnknownError(error, { storeIf });

  it("uses a numeric 4xx `status` or `statusCode`, with Nest's default body for it", () => {
    expect(capture(Object.assign(new Error('nope'), { status: 401 }))).toEqual({
      status: 401,
      headers: {},
      body: { message: 'Unauthorized', statusCode: 401 },
      error: 'http',
    });

    expect(capture({ statusCode: 404 })).toMatchObject({ status: 404, body: { message: 'Not Found', statusCode: 404 } });
    expect(capture({ status: 429 })).toMatchObject({ status: 429, body: { message: 'Too Many Requests', statusCode: 429 } });
  });

  it('asks storeIf about that status, with the original error', () => {
    const error = Object.assign(new Error('denied'), { status: 403 });
    const storeIf = vi.fn(() => false);
    expect(capture(error, storeIf)).toBeNull();
    expect(storeIf).toHaveBeenCalledWith(403, error);
  });

  it('treats anything else as a 500: no status, a 5xx one, or one that is not a number', () => {
    for (const error of [new Error('down'), { status: 503 }, { status: '403' }, { status: 403.5 }, 'a string']) {
      expect(capture(error)).toMatchObject({ status: 500, body: { statusCode: 500, message: 'Internal server error' } });
    }
  });
});
