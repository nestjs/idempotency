import { Controller, Header, HttpCode, Module, Post, Res, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { adapters, createApp } from './support/adapters.js';
import { Idempotent, IdempotencyModule, InMemoryIdempotencyStore } from '../lib/index.js';
import { registered } from './register.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

const state = {
  calls: {} as Record<string, number>,
  gate: undefined as ReturnType<typeof deferred> | undefined,
  started: undefined as ReturnType<typeof deferred> | undefined,
};
const hit = (name: string) => (state.calls[name] = (state.calls[name] ?? 0) + 1);

/** More than a megabyte of JSON. */
const statement = Array.from({ length: 20_000 }, (_, i) => ({ line: i, memo: `payment #${i} to account PL61 1090 1014` }));

@Controller('transfers')
class TransfersController {
  @Post()
  @Idempotent({ required: true })
  async create() {
    const n = hit('create');
    state.started?.resolve();
    await state.gate?.promise;
    return { id: `tr_${n}` };
  }

  @Post('headers')
  @Idempotent()
  @Header('X-Request-Cost', '3')
  @Header('X-Trace-Id', 'trace-1')
  withHeaders(@Res({ passthrough: true }) res: any) {
    const n = hit('headers');
    res.header('Set-Cookie', `session=s${n}`);
    return { n };
  }

  @Post('statement')
  @Idempotent()
  statement() {
    hit('statement');
    return statement;
  }

  @Post('void')
  @Idempotent()
  @HttpCode(204)
  cancel() {
    hit('void');
  }

  @Post('crash')
  @Idempotent({ storeIf: () => true })
  crash() {
    hit('crash');
    throw new Error('ledger write failed after the money moved');
  }

  @Post('short')
  @Idempotent({ ttl: '1s' })
  short() {
    return { n: hit('short') };
  }
}

const store = new InMemoryIdempotencyStore();

@Module({
  imports: [IdempotencyModule.forRoot({ replayHeaders: ['X-Request-Cost'] })],
  controllers: [TransfersController],
  providers: [registered(store)],
})
class AppModule {}

describe.each(adapters.map((a) => a.name))('Idempotency over HTTP (%s)', (adapter) => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createApp(adapter, AppModule, { setup: (a) => a.useLogger(false) });
  });
  afterAll(async () => {
    state.gate?.resolve();
    await app.close();
  });
  beforeEach(() => {
    store.clear();
    state.calls = {};
    state.gate = undefined;
    state.started = undefined;
  });
  afterEach(() => vi.useRealTimers());

  const post = (path: string, key?: string, body: object = { amount: 10 }) => {
    const r = request(app.getHttpServer()).post(path).send(body);
    return key ? r.set('Idempotency-Key', key) : r;
  };

  describe('rejections', () => {
    it('answer with a body naming the code, and Retry-After only for a key in use', async () => {
      const missing = await post('/transfers');
      expect(missing.status).toBe(400);
      expect(missing.body).toEqual({
        statusCode: 400,
        error: 'Bad Request',
        code: 'IDEMPOTENCY_KEY_REQUIRED',
        message: 'An idempotency key is required for this operation.',
      });
      expect(missing.headers['retry-after']).toBeUndefined();

      const invalid = await post('/transfers', 'x'.repeat(256));
      expect(invalid.body).toEqual({
        statusCode: 400,
        error: 'Bad Request',
        code: 'IDEMPOTENCY_KEY_INVALID',
        message: 'The idempotency key must be 1 to 255 printable ASCII characters.',
      });

      await post('/transfers', 'k1');
      const reused = await post('/transfers', 'k1', { amount: 11 });
      expect(reused.status).toBe(422);
      expect(reused.body).toEqual({
        statusCode: 422,
        error: 'Unprocessable Entity',
        code: 'IDEMPOTENCY_KEY_REUSED',
        message: 'This idempotency key was already used for a different request.',
      });
      expect(reused.headers['retry-after']).toBeUndefined();
      expect(reused.headers['idempotent-replayed']).toBeUndefined();

      state.gate = deferred();
      state.started = deferred();
      const first = post('/transfers', 'k2').then((r) => r);
      await state.started.promise;
      const busy = await post('/transfers', 'k2');
      state.gate.resolve();
      await first;

      expect(busy.body).toEqual({
        statusCode: 409,
        error: 'Conflict',
        code: 'IDEMPOTENCY_KEY_IN_USE',
        message: 'A request with this idempotency key is still being processed.',
      });
      expect(busy.headers['retry-after']).toBe('1');
    });

    it('lets exactly one of many concurrent requests with one key run, and the others retry into the replay', async () => {
      state.gate = deferred();
      state.started = deferred();
      const first = post('/transfers', 'k1').then((r) => r);
      await state.started.promise;

      const duplicates = await Promise.all(Array.from({ length: 8 }, () => post('/transfers', 'k1')));
      expect(duplicates.map((r) => r.status)).toEqual(Array(8).fill(409));

      state.gate.resolve();
      expect((await first).body).toEqual({ id: 'tr_1' });

      const retries = await Promise.all(Array.from({ length: 8 }, () => post('/transfers', 'k1')));
      expect(retries.every((r) => r.status === 201 && r.body.id === 'tr_1')).toBe(true);
      expect(retries.every((r) => r.headers['idempotent-replayed'] === 'true')).toBe(true);
      expect(state.calls.create).toBe(1);
    });
  });

  describe('replayed responses', () => {
    it('carry the replayHeaders the app added, not its other headers or cookies', async () => {
      const first = await post('/transfers/headers', 'k1');
      expect(first.headers['x-request-cost']).toBe('3');
      expect(first.headers['set-cookie']).toEqual([expect.stringContaining('session=s1')]);

      const stored = store.peek('k1');
      expect(stored?.state === 'completed' && stored.response).toMatchObject({
        headers: { 'x-request-cost': '3' },
      });
      expect(JSON.stringify(stored)).not.toContain('trace-1');
      expect(JSON.stringify(stored)).not.toContain('session=');

      const retry = await post('/transfers/headers', 'k1');
      expect(retry.headers['idempotent-replayed']).toBe('true');
      expect(retry.headers['x-request-cost']).toBe('3');
      expect(retry.headers['set-cookie']).toBeUndefined();
      // Set on every response by the route itself, so the replay's comes from @Header(), not the record.
      expect(retry.headers['x-trace-id']).toBe('trace-1');
      expect(state.calls.headers).toBe(1);
    });

    it('replay a large body in full', async () => {
      const first = await post('/transfers/statement', 'k1');
      const retry = await post('/transfers/statement', 'k1');

      expect(retry.headers['idempotent-replayed']).toBe('true');
      expect(retry.text.length).toBeGreaterThan(1_000_000);
      expect(retry.text).toBe(first.text);
      expect(state.calls.statement).toBe(1);
    });

    it('replay a 204 without a body', async () => {
      const first = await post('/transfers/void', 'k1');
      const retry = await post('/transfers/void', 'k1');

      expect(first.status).toBe(204);
      expect(retry.status).toBe(204);
      expect(retry.text).toBe('');
      expect(retry.headers['idempotent-replayed']).toBe('true');
      expect(state.calls.void).toBe(1);
    });

    it("replay an unknown error that storeIf made final as Nest's 500, without its message", async () => {
      const first = await post('/transfers/crash', 'k1');
      const retry = await post('/transfers/crash', 'k1');

      expect(first.status).toBe(500);
      expect(retry.status).toBe(500);
      expect(retry.body).toEqual({ statusCode: 500, message: 'Internal server error' });
      expect(retry.body).toEqual(first.body);
      expect(retry.headers['idempotent-replayed']).toBe('true');
      expect(state.calls.crash).toBe(1);
    });
  });

  it('replays until ttl has passed to the millisecond, then runs the handler again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-24T12:00:00.000Z'));

    await post('/transfers/short', 'k1');
    vi.setSystemTime(Date.now() + 999);
    expect((await post('/transfers/short', 'k1')).body).toEqual({ n: 1 });

    vi.setSystemTime(Date.now() + 1);
    const expired = await post('/transfers/short', 'k1');
    expect(expired.body).toEqual({ n: 2 });
    expect(expired.headers['idempotent-replayed']).toBeUndefined();
  });
});
