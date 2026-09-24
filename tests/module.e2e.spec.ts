import {
  Body,
  ClassSerializerInterceptor,
  Controller,
  Get,
  Injectable,
  InternalServerErrorException,
  Logger,
  Module,
  Post,
  UseGuards,
  type CallHandler,
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
  type NestInterceptor,
  type Type,
} from '@nestjs/common';
import { APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { Exclude } from 'class-transformer';
import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import { from, lastValueFrom, of } from 'rxjs';
import request from 'supertest';
import { createApp } from './support/adapters.js';
import { IdempotencyInterceptor } from '../lib/interceptors/idempotency.interceptor.js';
import { registered } from './register.js';
import {
  Idempotent,
  IdempotencyEvents,
  IdempotencyModule,
  IdempotencyStorage,
  InMemoryIdempotencyStore,
  type IdempotencyEvent,
  type IdempotencyModuleOptions,
  type IdempotencyOptionsFactory,
} from '../lib/index.js';

const calls: Record<string, number> = {};
const hit = (name: string) => (calls[name] = (calls[name] ?? 0) + 1);

/** Thrown after the charge went through: a 500 that must not run twice. */
class ChargeCapturedError extends InternalServerErrorException {}

@Controller('payments')
class PaymentsController {
  @Post()
  @Idempotent()
  create() {
    return { n: hit('create') };
  }

  @Post('receipts')
  @Idempotent({
    // A client timestamp changes on every retry; it isn't part of the request's identity.
    fingerprint: (body: { amount: number; sentAt?: string }) => ({ ...body, sentAt: undefined }),
  })
  receipt(@Body() body: { amount: number }) {
    return { n: hit('receipt'), amount: body.amount };
  }

  @Post('receipts/other')
  @Idempotent({ fingerprint: (body: { amount: number }) => ({ amount: body.amount }) })
  otherReceipt(@Body() body: { amount: number }) {
    return { n: hit('otherReceipt'), amount: body.amount };
  }

  @Post('captured')
  @Idempotent({
    storeIf: (status, error) => status < 500 || error instanceof ChargeCapturedError,
  })
  captured() {
    hit('captured');
    throw new ChargeCapturedError('Charged, but the receipt could not be saved');
  }

  @Post('busy')
  @Idempotent({ retryAfter: '2500ms' })
  async busy() {
    hit('busy');
    await gate.promise;
    return { ok: true };
  }
}

/** Class-level: covers the POST, not the GET, unless the GET opts in itself. */
@Controller('gift-cards')
@Idempotent({ required: true })
class GiftCardsController {
  @Get()
  list() {
    return { n: hit('list') };
  }

  @Get('export')
  @Idempotent()
  export() {
    return { n: hit('export') };
  }

  @Post()
  issue() {
    return { n: hit('issue') };
  }
}

let gate = deferred();
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

async function boot(module: Type<unknown>) {
  return createApp('express', module, { setup: (a) => a.useLogger(false) });
}

describe('IdempotencyModule registration', () => {
  const apps: INestApplication[] = [];
  const start = async (...imports: any[]) => {
    @Module({ imports, controllers: [PaymentsController] })
    class AppModule {}
    const app = await boot(AppModule);
    apps.push(app);
    return app;
  };
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it('forRootAsync resolves the options, and the in-memory default serves without a registered store', async () => {
    const app = await start(IdempotencyModule.forRootAsync({ useFactory: () => ({ ttl: '1h' }) }));
    const post = () => request(app.getHttpServer()).post('/payments').set('Idempotency-Key', 'k1');
    await post();
    expect((await post()).headers['idempotent-replayed']).toBe('true');
    expect(app.get(IdempotencyStorage).source).toBeInstanceOf(InMemoryIdempotencyStore);
  });

  it('forRootAsync({ useClass }) calls createIdempotencyOptions()', async () => {
    @Injectable()
    class IdempotencyConfig implements IdempotencyOptionsFactory {
      createIdempotencyOptions(): IdempotencyModuleOptions {
        return { header: 'X-Request-Key', ttl: '1h' };
      }
    }

    const app = await start(IdempotencyModule.forRootAsync({ useClass: IdempotencyConfig }));
    const post = () => request(app.getHttpServer()).post('/payments').set('X-Request-Key', 'k1');
    await post();
    expect((await post()).headers['idempotent-replayed']).toBe('true');

    class Misnamed {
      createOptions(): IdempotencyModuleOptions {
        return {};
      }
    }
    // @ts-expect-error: a useClass class implements createIdempotencyOptions()
    IdempotencyModule.forRootAsync({ useClass: Misnamed });
  });

  it('fails at startup when replayHeaders lists Set-Cookie or a framing header', async () => {
    for (const header of ['Set-Cookie', 'content-length', 'Transfer-Encoding']) {
      await expect(
        Test.createTestingModule({
          imports: [IdempotencyModule.forRoot({ replayHeaders: ['x-request-cost', header] })],
        }).compile(),
      ).rejects.toThrow(`IdempotencyModule: \`replayHeaders\` can't include "${header.toLowerCase()}"`);
    }
  });

  it('fails at startup when the factory returns isGlobal or imports', async () => {
    for (const [extra, value] of [
      ['isGlobal', false],
      ['imports', []],
    ] as const) {
      await expect(
        Test.createTestingModule({
          imports: [IdempotencyModule.forRootAsync({ useFactory: () => ({ [extra]: value }) })],
        }).compile(),
      ).rejects.toThrow(
        `IdempotencyModule: pass \`${extra}\` to forRootAsync() next to useFactory, not in the object the factory returns.`,
      );
    }
  });

  it('fails at startup, naming the mistake, when the factory returns nothing (a missing `return`)', async () => {
    for (const [returned, named] of [
      [undefined, 'undefined'],
      [null, 'null'],
      ['ttl=1h', 'a string'],
    ] as const) {
      await expect(
        Test.createTestingModule({
          imports: [IdempotencyModule.forRootAsync({ useFactory: () => returned as never })],
        }).compile(),
      ).rejects.toThrow(
        `IdempotencyModule: the options factory returned ${named}; return an object (\`{}\` for the defaults).`,
      );
    }
  });

  it('fails at startup when `store` is passed as an option, pointing at registerSource()', async () => {
    const message =
      'IdempotencyModule: `store` is not a module option. Register the store instead: a provider that ' +
      'implements IdempotencyStore, injects IdempotencyStorage and calls `storage.registerSource(this)` ' +
      'in its constructor.';

    await expect(
      Test.createTestingModule({
        // @ts-expect-error: not an option
        imports: [IdempotencyModule.forRoot({ store: new InMemoryIdempotencyStore() })],
      }).compile(),
    ).rejects.toThrow(message);

    await expect(
      Test.createTestingModule({
        imports: [
          // @ts-expect-error: not an option
          IdempotencyModule.forRootAsync({ useFactory: () => ({ store: new InMemoryIdempotencyStore() }) }),
        ],
      }).compile(),
    ).rejects.toThrow(message);
  });
});

describe('durations', () => {
  it('names the option when a duration is invalid, at startup', async () => {
    expect(() => Idempotent({ ttl: '3 days' as never })).toThrow(
      '@Idempotent(): invalid `ttl`. Invalid duration "3 days".',
    );
    await expect(
      Test.createTestingModule({ imports: [IdempotencyModule.forRoot({ lockTtl: 0 })] }).compile(),
    ).rejects.toThrow('IdempotencyModule: `lockTtl` must be at least 1 ms, got 0.');
  });

  it('sends retryAfter as whole seconds, rounded up', async () => {
    @Module({ imports: [IdempotencyModule.forRoot()], controllers: [PaymentsController] })
    class AppModule {}
    const app = await boot(AppModule);

    try {
      gate = deferred();
      const post = () => request(app.getHttpServer()).post('/payments/busy').set('Idempotency-Key', 'k1');
      const first = post().then((r) => r);
      await until(() => calls.busy === 1);

      const dup = await post();
      expect(dup.status).toBe(409);
      expect(dup.headers['retry-after']).toBe('3');

      gate.resolve();
      expect((await first).status).toBe(201);
    } finally {
      gate.resolve();
      await app.close();
    }
  });
});

describe('@Idempotent() options', () => {
  let app: INestApplication;
  let store: InMemoryIdempotencyStore;

  beforeAll(async () => {
    store = new InMemoryIdempotencyStore();
    @Module({
      imports: [IdempotencyModule.forRoot()],
      controllers: [PaymentsController, GiftCardsController],
      providers: [registered(store)],
    })
    class AppModule {}
    app = await boot(AppModule);
  });
  afterAll(() => app.close());
  beforeEach(() => {
    store.clear();
    for (const name of Object.keys(calls)) {
      delete calls[name];
    }
  });

  const post = (path: string, key: string, body: object = {}) =>
    request(app.getHttpServer()).post(path).set('Idempotency-Key', key).send(body);

  it('fingerprint: a retry may change what the fingerprint leaves out', async () => {
    await post('/payments/receipts', 'k1', { amount: 10, sentAt: '10:00:00' });
    const retry = await post('/payments/receipts', 'k1', { amount: 10, sentAt: '10:00:05' });
    expect(retry.headers['idempotent-replayed']).toBe('true');

    const changed = await post('/payments/receipts', 'k1', { amount: 11, sentAt: '10:00:09' });
    expect(changed.status).toBe(422);
    expect(calls.receipt).toBe(1);
  });

  it('fingerprint: the method and URL stay bound, so another route is still a 422', async () => {
    await post('/payments/receipts', 'k1', { amount: 10 });
    const other = await post('/payments/receipts/other', 'k1', { amount: 10 });
    expect(other.status).toBe(422);
    expect(other.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(calls.otherReceipt).toBeUndefined();
  });

  it('storeIf receives the error, so a specific 5xx can be final', async () => {
    const first = await post('/payments/captured', 'k1');
    expect(first.status).toBe(500);

    const retry = await post('/payments/captured', 'k1');
    expect(retry.status).toBe(500);
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(retry.body.message).toBe('Charged, but the receipt could not be saved');
    expect(calls.captured).toBe(1);
  });

  it('a class-level decorator skips GET routes; a GET with its own decorator is covered', async () => {
    const list = () => request(app.getHttpServer()).get('/gift-cards').set('Idempotency-Key', 'k1');
    expect((await list()).body).toEqual({ n: 1 });
    expect((await list()).body).toEqual({ n: 2 });
    expect((await request(app.getHttpServer()).get('/gift-cards')).status).toBe(200); // not required

    const exp = () => request(app.getHttpServer()).get('/gift-cards/export').set('Idempotency-Key', 'k2');
    await exp();
    expect((await exp()).headers['idempotent-replayed']).toBe('true');
    expect(calls.export).toBe(1);

    expect((await request(app.getHttpServer()).post('/gift-cards')).status).toBe(400);
    expect((await post('/gift-cards', 'k3')).status).toBe(201);
  });
});

describe('scope', () => {
  it('accepts a numeric id, as `req.user.id` often is', async () => {
    const store = new InMemoryIdempotencyStore();
    @Module({
      imports: [
        IdempotencyModule.forRoot({
          // What `(req) => req.user.id` returns for a numeric primary key.
          scope: (req) => Number(req.headers['x-user-id']),
        }),
      ],
      controllers: [PaymentsController],
      providers: [registered(store)],
    })
    class AppModule {}

    const app = await boot(AppModule);
    try {
      const post = () =>
        request(app.getHttpServer()).post('/payments').set('x-user-id', '42').set('Idempotency-Key', 'k1');

      expect((await post()).status).toBe(201);
      expect((await post()).headers['idempotent-replayed']).toBe('true');
      expect(store.peek('42:k1')?.state).toBe('completed');
    } finally {
      await app.close();
    }
  });
});

describe('scope and signed-in users', () => {
  /** Stands in for an authentication guard: sets `req.user`. */
  class FakeAuthGuard implements CanActivate {
    canActivate(context: ExecutionContext) {
      const req = context.switchToHttp().getRequest();
      req.user = { id: req.headers['x-user'], name: `User ${req.headers['x-user']}` };
      return true;
    }
  }

  @Controller('accounts')
  @UseGuards(FakeAuthGuard)
  class AccountsController {
    @Post('topup')
    @Idempotent()
    topUp() {
      return { n: hit('topUp') };
    }

    @Post('webhook')
    @Idempotent({ scope: false })
    webhook() {
      return { n: hit('webhook') };
    }
  }

  const apps: INestApplication[] = [];
  const start = async (options: Parameters<typeof IdempotencyModule.forRoot>[0], store?: InMemoryIdempotencyStore) => {
    @Module({
      imports: [IdempotencyModule.forRoot(options)],
      controllers: [AccountsController],
      providers: store ? [registered(store)] : [],
    })
    class AppModule {}
    const app = await boot(AppModule);
    apps.push(app);
    return app;
  };
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const name of Object.keys(calls)) {
      delete calls[name];
    }
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });
  const post = (app: INestApplication, path: string, user: string) =>
    request(app.getHttpServer()).post(path).set('x-user', user).set('Idempotency-Key', 'k1');

  it('warns once per handler when a signed-in user reaches it and no scope is set', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    const app = await start({});

    await post(app, '/accounts/topup', 'alice');
    await post(app, '/accounts/topup', 'bob');

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('AccountsController.topUp');
    expect(warn.mock.calls[0][0]).toContain('`scope`');
  });

  it("doesn't warn when scope is set, or set to false on purpose", async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});

    const scoped = await start({ scope: (req) => req.user.id });
    await post(scoped, '/accounts/topup', 'alice');

    const shared = await start({ scope: false });
    await post(shared, '/accounts/topup', 'alice');
    await post(shared, '/accounts/webhook', 'alice');

    expect(warn).not.toHaveBeenCalled();
  });

  it('scope: false on a handler overrides the module scope', async () => {
    const store = new InMemoryIdempotencyStore();
    const app = await start({ scope: (req) => req.user.id }, store);

    await post(app, '/accounts/webhook', 'alice');
    expect((await post(app, '/accounts/webhook', 'bob')).headers['idempotent-replayed']).toBe('true');

    await post(app, '/accounts/topup', 'alice');
    expect(store.peek('alice:k1')?.state).toBe('completed');
    expect(store.peek('k1')?.state).toBe('completed');
  });

  it('fails the call, naming the option, when scope returns an object', async () => {
    const errors = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    // A common slip: the user object instead of its id. As a string, every
    // user would be "[object Object]", one shared namespace.
    const app = await start({ scope: (req) => req.user });
    const res = await post(app, '/accounts/topup', 'alice');

    expect(res.status).toBe(500);
    expect(calls.topUp).toBeUndefined();

    const logged = errors.mock.calls.flat().map((arg) => (arg instanceof Error ? arg.message : arg));
    expect(logged).toContainEqual(
      expect.stringContaining('`scope` returned an object for AccountsController.topUp'),
    );
  });
});

describe('global interceptors registered before IdempotencyInterceptor', () => {
  class Account {
    id = 'acc_1';
    @Exclude() passwordHash = 'bcrypt$secret';
  }

  @Controller('accounts')
  class AccountsController {
    @Post()
    @Idempotent()
    open() {
      hit('open');
      return new Account();
    }
  }

  @Injectable()
  class TimingInterceptor implements NestInterceptor {
    intercept(_context: ExecutionContext, next: CallHandler) {
      return next.handle();
    }
  }

  afterEach(() => vi.restoreAllMocks());

  it('fails at startup when ClassSerializerInterceptor runs outside it: a replay would skip @Exclude()', async () => {
    // APP_INTERCEPTOR providers of the root module register before those of the modules it imports.
    @Module({
      imports: [IdempotencyModule.forRoot()],
      controllers: [AccountsController],
      providers: [{ provide: APP_INTERCEPTOR, useClass: ClassSerializerInterceptor }],
    })
    class AppModule {}

    await expect(boot(AppModule)).rejects.toThrow(
      /ClassSerializerInterceptor runs outside IdempotencyInterceptor/,
    );
  });

  it('keeps @Exclude() fields out of records and replays when the serializer runs inside it', async () => {
    const store = new InMemoryIdempotencyStore();
    @Module({
      imports: [IdempotencyModule.forRoot()],
      controllers: [AccountsController],
      providers: [registered(store)],
    })
    class AppModule {}

    const app = await createApp('express', AppModule, {
      setup: (a) => {
        a.useLogger(false);
        a.useGlobalInterceptors(new ClassSerializerInterceptor(a.get(Reflector)));
      },
    });

    try {
      const post = () => request(app.getHttpServer()).post('/accounts').set('Idempotency-Key', 'k1');
      expect((await post()).body).toEqual({ id: 'acc_1' });

      const retry = await post();
      expect(retry.headers['idempotent-replayed']).toBe('true');
      expect(retry.body).toEqual({ id: 'acc_1' });
      expect(JSON.stringify(store.peek('k1'))).not.toContain('bcrypt');
    } finally {
      await app.close();
    }
  });

  it('warns once when another global interceptor runs outside it', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});

    @Module({
      imports: [IdempotencyModule.forRoot()],
      controllers: [AccountsController],
      providers: [{ provide: APP_INTERCEPTOR, useClass: TimingInterceptor }],
    })
    class AppModule {}

    const app = await createApp('express', AppModule);
    await app.close();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('TimingInterceptor');
  });
});

describe('module-level keyFrom', () => {
  it('reads the key from a per-context source', async () => {
    @Module({
      imports: [IdempotencyModule.forRoot({ keyFrom: { http: { header: 'X-Request-Id' } } })],
      controllers: [PaymentsController],
    })
    class AppModule {}

    const app = await boot(AppModule);
    try {
      const post = (headers: Record<string, string>) =>
        request(app.getHttpServer()).post('/payments').set(headers);

      await post({ 'X-Request-Id': 'r1' });
      expect((await post({ 'X-Request-Id': 'r1' })).headers['idempotent-replayed']).toBe('true');
      expect((await post({ 'Idempotency-Key': 'r1' })).headers['idempotent-replayed']).toBeUndefined();
    } finally {
      await app.close();
    }
  });
});

describe('IdempotencyEvents', () => {
  let app: INestApplication;
  let store: InMemoryIdempotencyStore;
  let events: IdempotencyEvent[];
  let published: unknown[];
  const onPublish = (message: unknown, name: string | symbol) => published.push({ name, message });

  beforeAll(async () => {
    store = new InMemoryIdempotencyStore();
    @Module({
      imports: [
        IdempotencyModule.forRoot({
          scope: (req) => req.headers['x-user-id'] as string | undefined,
        }),
      ],
      controllers: [PaymentsController],
      providers: [registered(store)],
    })
    class AppModule {}
    app = await boot(AppModule);

    app.get(IdempotencyEvents).events$.subscribe((event) => events.push(event));
    for (const name of ['replayed', 'rejected', 'lock-lost']) {
      subscribe(`nestjs:idempotency:${name}`, onPublish);
    }
  });
  afterAll(async () => {
    for (const name of ['replayed', 'rejected', 'lock-lost']) {
      unsubscribe(`nestjs:idempotency:${name}`, onPublish);
    }
    await app.close();
  });
  beforeEach(() => {
    events = [];
    published = [];
    store.clear();
  });
  afterEach(() => vi.restoreAllMocks());

  const post = (path: string, key?: string, body: object = {}) => {
    const r = request(app.getHttpServer()).post(path).set('x-user-id', 'alice').send(body);
    return key ? r.set('Idempotency-Key', key) : r;
  };

  it('reports replays and rejections, on events$ and on diagnostics channels', async () => {
    await post('/payments', 'k1');
    await post('/payments', 'k1');
    await post('/payments/receipts', 'k1', { amount: 1 });

    expect(events).toEqual([
      {
        type: 'replayed',
        context: 'http',
        handler: 'PaymentsController.create',
        key: 'k1',
        scope: 'alice',
        status: 201,
      },
      {
        type: 'rejected',
        context: 'http',
        handler: 'PaymentsController.receipt',
        code: 'IDEMPOTENCY_KEY_REUSED',
        status: 422,
        key: 'k1',
        scope: 'alice',
      },
    ]);
    expect(published).toEqual([
      { name: 'nestjs:idempotency:replayed', message: events[0] },
      { name: 'nestjs:idempotency:rejected', message: events[1] },
    ]);
  });

  it('reports a lock lost while the handler ran', async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    vi.spyOn(store, 'complete').mockResolvedValue(false); // taken over meanwhile

    await post('/payments', 'k1');

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
  });
});

describe('unsupported contexts', () => {
  it('warns once that @Idempotent() has no effect on a WebSocket handler', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [IdempotencyModule.forRoot()],
    }).compile();
    const idempotency = moduleRef.get(IdempotencyInterceptor);
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});

    class ChatGateway {
      @Idempotent()
      send() {}
    }

    const context = {
      getType: () => 'ws',
      getClass: () => ChatGateway,
      getHandler: () => ChatGateway.prototype.send,
    } as unknown as ExecutionContext;
    const next = { handle: () => of('sent') };

    expect(await lastValueFrom(idempotency.intercept(context, next))).toBe('sent');
    await lastValueFrom(idempotency.intercept(context, next));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      '@Idempotent() has no effect on ChatGateway.send: "ws" handlers are not supported (http, graphql and rpc are).',
    );

    warn.mockRestore();
  });
});

describe('a caller that unsubscribes', () => {
  class Consumers {
    @Idempotent()
    charge() {}
  }
  const rpcContext = (key: string) =>
    ({
      getType: () => 'rpc',
      getClass: () => Consumers,
      getHandler: () => Consumers.prototype.charge,
      getArgs: () => [{ idempotencyKey: key }],
      getArgByIndex: () => undefined,
      switchToRpc: () => ({
        getData: () => ({ idempotencyKey: key }),
        getContext: () => ({ getPattern: () => 'charge' }),
      }),
    }) as unknown as ExecutionContext;

  let store: InMemoryIdempotencyStore;
  let interceptor: IdempotencyInterceptor;
  beforeEach(async () => {
    store = new InMemoryIdempotencyStore();
    const moduleRef = await Test.createTestingModule({
      imports: [IdempotencyModule.forRoot()],
      providers: [registered(store)],
    }).compile();
    await moduleRef.init();
    interceptor = moduleRef.get(IdempotencyInterceptor);
  });

  it("doesn't stop the handler: its outcome is still stored for the retry", async () => {
    const charged = deferred();
    let charges = 0;
    const next = {
      handle: () => {
        charges++;
        return from(charged.promise.then(() => ({ chargeId: 'ch_1' })));
      },
    };

    // A sibling event handler failed, say, and forkJoin unsubscribed.
    const subscription = interceptor.intercept(rpcContext('k1'), next).subscribe();
    await until(() => charges === 1);
    subscription.unsubscribe();
    charged.resolve();
    await until(() => store.peek('k1:Consumers.charge')?.state === 'completed');

    const retry = await lastValueFrom(interceptor.intercept(rpcContext('k1'), next));
    expect(retry).toEqual({ chargeId: 'ch_1' });
    expect(charges).toBe(1);
  });

  it('releases a lock taken after it unsubscribed, since nothing will run', async () => {
    const acquired = vi.spyOn(store, 'acquire');
    const next = { handle: () => of('never') };

    interceptor.intercept(rpcContext('k2'), next).subscribe().unsubscribe();
    await until(() => acquired.mock.calls.length === 1);
    await acquired.mock.results[0].value;
    await until(() => store.size === 0);
    expect(store.peek('k2:Consumers.charge')).toBeUndefined();
  });
});

async function until(check: () => boolean, timeout = 2_000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeout) {
      throw new Error('Timed out waiting');
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}
