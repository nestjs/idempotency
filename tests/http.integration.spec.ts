/**
 * HTTP behaviour the README documents that the other e2e specs leave out, on Express and
 * Fastify: PATCH, PUT and DELETE routes and the methods a class decorator skips, per-handler key
 * sources, the Content-Digest fingerprint recipe, pipes and interceptors that run inside the
 * interceptor, exception filters on replays, and a store that fails once the handler ran.
 */
import {
  Body,
  CallHandler,
  Catch,
  Controller,
  Delete,
  ExecutionContext,
  Head,
  Headers,
  HttpException,
  HttpStatus,
  Logger,
  Module,
  NestInterceptor,
  Options,
  Patch,
  Post,
  Put,
  UseInterceptors,
  ValidationPipe,
  type ArgumentsHost,
  type INestApplication,
} from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { IsInt, IsPositive } from 'class-validator';
import { createHash } from 'node:crypto';
import { map } from 'rxjs';
import request from 'supertest';
import { adapters, createApp } from './support/adapters.js';
import {
  IdempotencyEvents,
  IdempotencyModule,
  Idempotent,
  InMemoryIdempotencyStore,
  type IdempotencyEvent,
} from '../lib/index.js';
import { registered } from './register.js';

const calls: Record<string, number> = {};
const hit = (name: string) => (calls[name] = (calls[name] ?? 0) + 1);

class CreateTransferDto {
  @IsInt()
  @IsPositive()
  amount!: number;
}

class PaymentDeclinedException extends HttpException {
  constructor() {
    super({ statusCode: 402, message: 'Card declined' }, HttpStatus.PAYMENT_REQUIRED);
  }
}

/** Adds what only the original exception class knows: a replay re-throws the base class. */
@Catch(PaymentDeclinedException)
class PaymentDeclinedFilter extends BaseExceptionFilter {
  override catch(exception: PaymentDeclinedException, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse();
    const body = { ...(exception.getResponse() as object), declineCode: 'insufficient_funds' };
    this.applicationRef!.reply(response, body, exception.getStatus());
  }
}

/** The app's own error format, for every HttpException. */
@Catch(HttpException)
class ErrorEnvelopeFilter extends BaseExceptionFilter {
  override catch(exception: HttpException, host: ArgumentsHost) {
    const body = exception.getResponse() as { message?: unknown; code?: string };
    const envelope = { error: { status: exception.getStatus(), code: body.code ?? null, message: body.message } };
    this.applicationRef!.reply(host.switchToHttp().getResponse(), envelope, exception.getStatus());
  }
}

class EnvelopeInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler) {
    hit('envelope');
    return next.handle().pipe(map((data) => ({ data, meta: { version: 2 } })));
  }
}

@Controller('accounts')
@Idempotent({ required: true })
class AccountsController {
  @Post()
  open() {
    return { id: `acc_${hit('open')}` };
  }

  @Put('limits')
  setLimits(@Body() body: { daily: number }) {
    return { daily: body.daily, version: hit('put') };
  }

  @Patch('profile')
  rename(@Body() body: { name: string }) {
    return { name: body.name, version: hit('patch') };
  }

  @Delete()
  close() {
    return { closed: hit('delete') };
  }

  /** Safe methods: the class decorator leaves them alone. */
  @Head()
  head() {
    hit('head');
  }

  @Options()
  options() {
    hit('options');
    return {};
  }
}

@Controller('transfers')
class TransfersController {
  @Post()
  @Idempotent({ keyFrom: { header: 'X-Request-Id' } })
  create(@Body() dto: CreateTransferDto) {
    return { id: `tr_${hit('transfer')}`, amount: dto.amount };
  }

  /** `skipRequest` from `@node-idempotency/nestjs`: a keyFrom function returns undefined. */
  @Post('internal')
  @Idempotent({
    keyFrom: (context) => {
      const req = context.switchToHttp().getRequest();
      return req.headers['x-internal'] ? undefined : req.headers['idempotency-key'];
    },
  })
  internal() {
    return { n: hit('internal') };
  }

  @Post('declined')
  @Idempotent()
  declined() {
    hit('declined');
    throw new PaymentDeclinedException();
  }

  @Post('enveloped')
  @Idempotent()
  @UseInterceptors(EnvelopeInterceptor)
  enveloped() {
    return { id: `env_${hit('enveloped')}` };
  }
}

/** The README's recipe for bodies no parser reads: clients send an RFC 9530 digest, the fingerprint hashes it. */
@Controller('uploads')
class UploadsController {
  @Post()
  @Idempotent({
    fingerprint: (_body, context) => context.switchToHttp().getRequest().headers['content-digest'],
  })
  upload(@Headers('content-digest') digest: string) {
    return { upload: hit('upload'), digest };
  }
}

@Controller('ledger')
class LedgerController {
  @Post()
  @Idempotent({ lockTtl: '10s' })
  post() {
    return { entry: hit('ledger') };
  }
}

const digest = (text: string) => `sha-256=:${createHash('sha256').update(text).digest('base64')}:`;

describe.each(adapters.map((a) => a.name))('HTTP features (%s)', (adapter) => {
  const store = new InMemoryIdempotencyStore();
  let app: INestApplication;
  let events: IdempotencyEvent[];

  beforeAll(async () => {
    @Module({
      imports: [IdempotencyModule.forRoot()],
      controllers: [AccountsController, TransfersController, UploadsController, LedgerController],
      providers: [registered(store)],
    })
    class AppModule {}

    app = await createApp(adapter, AppModule, {
      setup: (a) => {
        a.useLogger(false);
        a.useGlobalPipes(new ValidationPipe());
        // Nest runs the filter registered last first: the specific one before the envelope.
        a.useGlobalFilters(new ErrorEnvelopeFilter(a.getHttpAdapter()), new PaymentDeclinedFilter(a.getHttpAdapter()));
      },
    });
    app.get(IdempotencyEvents).events$.subscribe((event) => events.push(event));
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(() => {
    store.clear();
    events = [];
    for (const name of Object.keys(calls)) {
      delete calls[name];
    }
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  const http = () => request(app.getHttpServer());

  describe('methods', () => {
    it('covers the POST, PUT, PATCH and DELETE routes of a decorated class', async () => {
      const sends = [
        () => http().post('/accounts').set('Idempotency-Key', 'k1'),
        () => http().put('/accounts/limits').set('Idempotency-Key', 'k2').send({ daily: 500 }),
        () => http().patch('/accounts/profile').set('Idempotency-Key', 'k3').send({ name: 'Savings' }),
        () => http().delete('/accounts').set('Idempotency-Key', 'k4'),
      ];

      for (const send of sends) {
        const first = await send();
        const retry = await send();
        expect(first.status).toBeLessThan(300);
        expect(retry.headers['idempotent-replayed']).toBe('true');
        expect(retry.body).toEqual(first.body);
      }
      expect(calls).toEqual({ open: 1, put: 1, patch: 1, delete: 1 });
    });

    it('refuses a key reused for another method on the same URL', async () => {
      await http().post('/accounts').set('Idempotency-Key', 'k1');
      const reused = await http().delete('/accounts').set('Idempotency-Key', 'k1');

      expect(reused.status).toBe(422);
      expect(reused.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
      expect(calls.delete).toBeUndefined();
    });

    it('leaves HEAD and OPTIONS routes of a decorated class alone, even with a required key missing', async () => {
      expect((await http().head('/accounts')).status).toBe(200);
      expect((await http().head('/accounts').set('Idempotency-Key', 'k1')).headers['idempotent-replayed']).toBeUndefined();
      expect((await http().options('/accounts')).status).toBe(200);
      expect((await http().options('/accounts').set('Idempotency-Key', 'k1')).headers['idempotent-replayed']).toBeUndefined();

      expect(calls).toEqual({ head: 2, options: 2 });
      expect(store.size).toBe(0);
    });

    it('requires the key the class decorator asks for on the routes it covers', async () => {
      const missing = await http().patch('/accounts/profile').send({ name: 'Savings' });
      expect(missing.status).toBe(400);
      expect(missing.body).toEqual({ error: { status: 400, code: 'IDEMPOTENCY_KEY_REQUIRED', message: expect.any(String) } });
      expect(calls.patch).toBeUndefined();
    });
  });

  describe('key sources', () => {
    it("reads a handler's keyFrom header, and ignores Idempotency-Key there", async () => {
      const first = await http().post('/transfers').set('X-Request-Id', 'req-1').send({ amount: 5 });
      const retry = await http().post('/transfers').set('X-Request-Id', 'req-1').set('Idempotency-Key', 'other').send({ amount: 5 });
      const unkeyed = await http().post('/transfers').set('Idempotency-Key', 'req-1').send({ amount: 5 });

      expect(retry.headers['idempotent-replayed']).toBe('true');
      expect(retry.body).toEqual(first.body);
      expect(unkeyed.headers['idempotent-replayed']).toBeUndefined();
      expect(calls.transfer).toBe(2);
    });

    it('runs a call whose keyFrom function returns undefined without a record', async () => {
      await http().post('/transfers/internal').set('Idempotency-Key', 'k1').set('x-internal', '1');
      await http().post('/transfers/internal').set('Idempotency-Key', 'k1').set('x-internal', '1');
      expect(store.size).toBe(0);

      await http().post('/transfers/internal').set('Idempotency-Key', 'k1');
      const replay = await http().post('/transfers/internal').set('Idempotency-Key', 'k1');
      expect(replay.body).toEqual({ n: 3 });
      expect(calls.internal).toBe(3);
    });
  });

  describe('the Content-Digest recipe', () => {
    const upload = (key: string, text: string) =>
      http().post('/uploads').set('Idempotency-Key', key).set('Content-Type', 'text/plain').set('Content-Digest', digest(text)).send(text);

    it('replays a retry of the same unparsed body, and refuses another body under the same key', async () => {
      const first = await upload('k1', 'invoice line 1');
      const retry = await upload('k1', 'invoice line 1');
      const other = await upload('k1', 'invoice line 2');

      expect(first.status).toBe(201);
      expect(retry.headers['idempotent-replayed']).toBe('true');
      expect(retry.body).toEqual(first.body);
      expect(other.status).toBe(422);
      expect(other.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
      expect(calls.upload).toBe(1);
    });
  });

  describe('what runs inside the interceptor', () => {
    it('stores a ValidationPipe 400 like any 4xx, so the fixed body needs a new key', async () => {
      const invalid = await http().post('/transfers').set('X-Request-Id', 'req-1').send({ amount: -5 });
      const again = await http().post('/transfers').set('X-Request-Id', 'req-1').send({ amount: -5 });
      const fixed = await http().post('/transfers').set('X-Request-Id', 'req-1').send({ amount: 5 });
      const fresh = await http().post('/transfers').set('X-Request-Id', 'req-2').send({ amount: 5 });

      expect(invalid.status).toBe(400);
      expect(again.status).toBe(400);
      expect(again.headers['idempotent-replayed']).toBe('true');
      expect(again.body).toEqual(invalid.body);
      expect(fixed.status).toBe(422);
      expect(fresh.status).toBe(201);
      expect(calls.transfer).toBe(1);
    });

    it("stores what a handler's own interceptor made of the result, and skips that interceptor on replay", async () => {
      const first = await http().post('/transfers/enveloped').set('Idempotency-Key', 'k1');
      const retry = await http().post('/transfers/enveloped').set('Idempotency-Key', 'k1');

      expect(first.body).toEqual({ data: { id: 'env_1' }, meta: { version: 2 } });
      expect(retry.body).toEqual(first.body);
      expect(calls).toEqual({ enveloped: 1, envelope: 1 });
    });

    it("passes replayed errors through the app's filters again, as the base exception class", async () => {
      const first = await http().post('/transfers/declined').set('Idempotency-Key', 'k1');
      const retry = await http().post('/transfers/declined').set('Idempotency-Key', 'k1');

      expect(first.status).toBe(402);
      expect(first.body).toEqual({ statusCode: 402, message: 'Card declined', declineCode: 'insufficient_funds' });
      expect(retry.status).toBe(402);
      expect(retry.headers['idempotent-replayed']).toBe('true');
      expect(retry.body).toEqual({ error: { status: 402, code: null, message: 'Card declined' } });
      expect(calls.declined).toBe(1);
    });
  });

  describe('a store that fails once the handler ran', () => {
    it('still answers, reports lock-lost, answers 409 until the lock expires, then runs again', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-09-24T12:00:00.000Z'));
      vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
      vi.spyOn(store, 'complete').mockRejectedValueOnce(new Error('connection reset'));

      const first = await http().post('/ledger').set('Idempotency-Key', 'k1');
      expect(first.status).toBe(201);
      expect(first.body).toEqual({ entry: 1 });
      expect(events).toEqual([
        { type: 'lock-lost', context: 'http', handler: 'LedgerController.post', key: 'k1', phase: 'complete' },
      ]);

      expect((await http().post('/ledger').set('Idempotency-Key', 'k1')).status).toBe(409);

      vi.setSystemTime(Date.now() + 10_000);
      const retry = await http().post('/ledger').set('Idempotency-Key', 'k1');
      expect(retry.status).toBe(201);
      expect(retry.body).toEqual({ entry: 2 });
    });
  });
});
