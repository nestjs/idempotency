/**
 * IdempotencyStorage: the app registers its store from a provider's constructor, and the
 * registry is hardened as the family conventions require (rule 2): shape validation,
 * one source (unless replaced on purpose), locked in IdempotencyModule's onModuleInit or
 * at the first read (an internal symbol), the active source logged, and no silent
 * in-memory fallback in production.
 */
import {
  Controller,
  Inject,
  Injectable,
  Logger,
  Module,
  Post,
  Scope,
  type DynamicModule,
  type OnModuleInit,
  type Type,
} from '@nestjs/common';
import { LazyModuleLoader } from '@nestjs/core';
import { Test, type TestingModule } from '@nestjs/testing';
import { setTimeout as sleep } from 'node:timers/promises';
import request from 'supertest';
import { adapters, createApp } from './support/adapters.js';
import {
  Idempotent,
  IdempotencyModule,
  IdempotencyStorage,
  InMemoryIdempotencyStore,
  type IdempotencyStore,
} from '../lib/index.js';
import { LOCK_STORAGE } from '../lib/storage/idempotency.storage.js';

const DB = Symbol('DB');

/** What an app writes: an ordinary provider that implements the interface and registers itself. */
@Injectable()
class AppIdempotencyStore extends InMemoryIdempotencyStore implements IdempotencyStore {
  readonly calls: string[] = [];
  constructor(@Inject(DB) readonly db: { name: string }, storage: IdempotencyStorage) {
    super();
    storage.registerSource(this);
  }
  override async acquire(key: string, owner: string, fingerprint: string, lockTtl: number) {
    this.calls.push(`acquire ${key}`);
    return super.acquire(key, owner, fingerprint, lockTtl);
  }
}

@Injectable()
class OtherStore extends InMemoryIdempotencyStore {
  constructor(storage: IdempotencyStorage) {
    super();
    storage.registerSource(this);
  }
}

@Module({ providers: [{ provide: DB, useValue: { name: 'db' } }], exports: [DB] })
class DatabaseModule {}

@Controller('payments')
class PaymentsController {
  calls = 0;
  @Post()
  @Idempotent()
  pay() {
    return { n: ++this.calls };
  }
}

async function compile(...metadata: { imports?: any[]; providers?: any[] }[]) {
  return Test.createTestingModule({
    imports: metadata.flatMap((m) => m.imports ?? []),
    providers: metadata.flatMap((m) => m.providers ?? []),
  }).compile();
}

describe('IdempotencyStorage', () => {
  let log: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  describe.each(adapters.map((a) => a.name))('a registered store (%s)', (adapter) => {
    it('serves every @Idempotent() handler, with the dependencies Nest injected into it', async () => {
      @Module({
        imports: [DatabaseModule, IdempotencyModule.forRoot()],
        controllers: [PaymentsController],
        providers: [AppIdempotencyStore],
      })
      class AppModule {}

      const app = await createApp(adapter, AppModule, { setup: (a) => a.useLogger(false) });
      try {
        const post = () => request(app.getHttpServer()).post('/payments').set('Idempotency-Key', 'k1');
        expect((await post()).body).toEqual({ n: 1 });
        const retry = await post();
        expect(retry.body).toEqual({ n: 1 });
        expect(retry.headers['idempotent-replayed']).toBe('true');

        const store = app.get(AppIdempotencyStore);
        expect(store.db).toEqual({ name: 'db' });
        expect(store.calls).toEqual(['acquire k1', 'acquire k1']);
        expect(app.get(IdempotencyStorage).source).toBe(store);
      } finally {
        await app.close();
      }
    });
  });

  it('works with forRootAsync, and from a module that imports IdempotencyModule itself (isGlobal: false)', async () => {
    @Module({
      imports: [DatabaseModule, IdempotencyModule.forRootAsync({ isGlobal: false, useFactory: () => ({ ttl: '1h' }) })],
      providers: [AppIdempotencyStore],
    })
    class StoreModule {}

    const moduleRef = await compile({ imports: [StoreModule] });
    await moduleRef.init();
    expect(moduleRef.get(IdempotencyStorage).source).toBe(moduleRef.get(AppIdempotencyStore));
    await moduleRef.close();
  });

  it('validates the shape at once, naming the missing methods', () => {
    const storage = new IdempotencyStorage();
    const partial = { acquire: async () => ({ state: 'acquired' as const }), extend: 'no' };
    expect(() => storage.registerSource(partial as unknown as IdempotencyStore)).toThrow(
      "IdempotencyStorage.registerSource(): an object doesn't implement IdempotencyStore: complete(), release(), extend() are missing.",
    );

    class LegacyStore {
      async acquire() {
        return { state: 'acquired' as const };
      }
    }

    expect(() => storage.registerSource(new LegacyStore() as unknown as IdempotencyStore)).toThrow(
      "IdempotencyStorage.registerSource(): LegacyStore doesn't implement IdempotencyStore: complete(), release(), extend() are missing.",
    );
    expect(() => storage.registerSource(InMemoryIdempotencyStore as unknown as IdempotencyStore)).toThrow(
      'IdempotencyStorage.registerSource(): expected an object implementing IdempotencyStore, got the class InMemoryIdempotencyStore (pass an instance).',
    );
    expect(() => storage.registerSource(undefined as unknown as IdempotencyStore)).toThrow(
      'IdempotencyStorage.registerSource(): expected an object implementing IdempotencyStore, got undefined.',
    );
  });

  it('throws on a second registration, naming both classes', async () => {
    await expect(
      compile({ imports: [DatabaseModule, IdempotencyModule.forRoot()], providers: [AppIdempotencyStore, OtherStore] }),
    ).rejects.toThrow(
      "IdempotencyStorage.registerSource(): OtherStore can't register, AppIdempotencyStore already did. " +
        'Register one store, or pass { replace: true } to replace it on purpose (tests, wrappers).',
    );

    const storage = new IdempotencyStorage();
    const store = new InMemoryIdempotencyStore();
    storage.registerSource(store);
    expect(() => storage.registerSource(store)).toThrow(
      "IdempotencyStorage.registerSource(): InMemoryIdempotencyStore can't register, it already did (the same instance, twice).",
    );
  });

  it('replaces the source with { replace: true }, before init', async () => {
    const moduleRef = await compile({
      imports: [DatabaseModule, IdempotencyModule.forRoot()],
      providers: [AppIdempotencyStore],
    });

    const fake = new InMemoryIdempotencyStore();
    moduleRef.get(IdempotencyStorage).registerSource(fake, { replace: true });

    await moduleRef.init();
    expect(moduleRef.get(IdempotencyStorage).source).toBe(fake);
    await moduleRef.close();
  });

  it("lets a test override the app's store provider with a plain instance: the in-memory default applies", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [DatabaseModule, IdempotencyModule.forRoot()],
      providers: [AppIdempotencyStore],
    })
      .overrideProvider(AppIdempotencyStore)
      .useValue(new InMemoryIdempotencyStore())
      .compile();

    await moduleRef.init();

    const source = moduleRef.get(IdempotencyStorage).source;
    expect(source).toBeInstanceOf(InMemoryIdempotencyStore);
    expect(source).not.toBeInstanceOf(AppIdempotencyStore);
    expect(source).not.toBe(moduleRef.get(AppIdempotencyStore));
    await moduleRef.close();
  });

  it('locks in onModuleInit: registering from a lifecycle hook, or later, throws', async () => {
    @Injectable()
    class HookStore extends InMemoryIdempotencyStore implements OnModuleInit {
      constructor(private readonly storage: IdempotencyStorage) {
        super();
      }
      onModuleInit() {
        this.storage.registerSource(this);
      }
    }

    // IdempotencyModule is imported, so Nest initializes it (and locks) before the importer's providers.
    const moduleRef = await compile({ imports: [IdempotencyModule.forRoot()], providers: [HookStore] });
    await expect(moduleRef.init()).rejects.toThrow(
      'IdempotencyStorage.registerSource(): HookStore registered after IdempotencyModule initialized (or after its ' +
        'storage was first read), which already uses InMemoryIdempotencyStore (the default: state is lost on restart ' +
        'and not shared between instances). Register from the constructor of a singleton provider: providers of ' +
        'lazy-loaded modules, request-scoped and transient providers, and lifecycle hooks run too late.',
    );

    const initialized = await compile({ imports: [IdempotencyModule.forRoot()] });
    await initialized.init();
    expect(() => initialized.get(IdempotencyStorage).registerSource(new InMemoryIdempotencyStore())).toThrow(
      'IdempotencyStorage.registerSource(): InMemoryIdempotencyStore registered after IdempotencyModule initialized',
    );
    await initialized.close();
  });

  it('refuses a store in a lazy-loaded module', async () => {
    @Module({ providers: [OtherStore] })
    class LazyStoreModule {}

    const moduleRef = await compile({ imports: [IdempotencyModule.forRoot()] });
    const app = moduleRef.createNestApplication({ logger: false });
    await app.init();

    try {
      await expect(app.get(LazyModuleLoader).load(() => LazyStoreModule)).rejects.toThrow(
        'IdempotencyStorage.registerSource(): OtherStore registered after IdempotencyModule initialized',
      );
      expect(app.get(IdempotencyStorage).source).toBeInstanceOf(InMemoryIdempotencyStore);
    } finally {
      await app.close();
    }
  });

  it('refuses a request-scoped store: its constructor runs per request, after the lock', async () => {
    @Injectable({ scope: Scope.REQUEST })
    class PerRequestStore extends OtherStore {}
    @Controller('scoped')
    class ScopedController {
      constructor(readonly store: PerRequestStore) {}
      @Post()
      post() {
        return { ok: true };
      }
    }

    @Module({ imports: [IdempotencyModule.forRoot()], controllers: [ScopedController], providers: [PerRequestStore] })
    class AppModule {}

    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    const app = await createApp('express', AppModule);
    try {
      expect((await request(app.getHttpServer()).post('/scoped')).status).toBe(500);
      expect(String(error.mock.calls.flat().join(' '))).toContain(
        'IdempotencyStorage.registerSource(): PerRequestStore registered after IdempotencyModule initialized',
      );
      expect(app.get(IdempotencyStorage).source).toBeInstanceOf(InMemoryIdempotencyStore);
    } finally {
      await app.close();
    }
  });

  it('fails the call, and leaves nothing unhandled, when a store throws synchronously', async () => {
    class BrokenStore extends InMemoryIdempotencyStore {
      override acquire(): never {
        throw new Error('acquire: connection refused');
      }
      override release(): never {
        throw new Error('release: connection refused');
      }
    }

    const store = new BrokenStore();
    @Module({ imports: [IdempotencyModule.forRoot()], controllers: [PaymentsController] })
    class AppModule {}

    const moduleRef = await compile({ imports: [AppModule] });
    moduleRef.get(IdempotencyStorage).registerSource(store);

    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    const app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    try {
      const res = await request(app.getHttpServer()).post('/payments').set('Idempotency-Key', 'k1');
      expect(res.status).toBe(500);
      // The acquire's error, not the cleanup's.
      expect(error.mock.calls.flat().map(String).join('\n')).toContain('acquire: connection refused');
      expect(error.mock.calls.flat().map(String).join('\n')).not.toContain('release: connection refused');
      await sleep(10); // an unhandled rejection from the cleanup would fail the run here
    } finally {
      await app.close();
    }
  });

  it("locks at the first read when that comes before IdempotencyModule's onModuleInit", async () => {
    const seen: string[] = [];
    let moduleRef!: TestingModule;

    /** A provider of a module initialized before IdempotencyModule's hook reads the store. */
    @Injectable()
    class EarlyReader implements OnModuleInit {
      onModuleInit() {
        seen.push(moduleRef.get(IdempotencyStorage).source.constructor.name);
        expect(() => moduleRef.get(IdempotencyStorage).registerSource(new InMemoryIdempotencyStore(), { replace: true })).toThrow(
          'IdempotencyStorage.registerSource(): InMemoryIdempotencyStore registered after IdempotencyModule initialized ' +
            '(or after its storage was first read), which already uses AppIdempotencyStore.',
        );
      }
    }

    @Module({ providers: [EarlyReader] })
    class EarlyModule {}
    @Module({ imports: [EarlyModule] })
    class FeatureModule {}

    moduleRef = await compile({ imports: [DatabaseModule, IdempotencyModule.forRoot(), FeatureModule], providers: [AppIdempotencyStore] });
    await moduleRef.init();

    expect(seen).toEqual(['AppIdempotencyStore']);
    expect(moduleRef.get(IdempotencyStorage).source).toBe(moduleRef.get(AppIdempotencyStore));
    expect(log.mock.calls.filter(([message]: unknown[]) => String(message).startsWith('IdempotencyStorage:'))).toHaveLength(1);
    await moduleRef.close();

    // Outside a Nest app too: the first read locks.
    const storage = new IdempotencyStorage();
    expect(storage.source).toBeInstanceOf(InMemoryIdempotencyStore);
    expect(() => storage.registerSource(new InMemoryIdempotencyStore())).toThrow('registered after IdempotencyModule initialized');
  });

  it('keeps the lock internal: no public lock method, and locking again changes nothing', () => {
    const storage = new IdempotencyStorage();
    expect(Object.getOwnPropertyNames(IdempotencyStorage.prototype)).not.toContain('lock');

    const store = new InMemoryIdempotencyStore();
    storage.registerSource(store);
    storage[LOCK_STORAGE]();
    storage[LOCK_STORAGE]();
    expect(storage.source).toBe(store);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('logs the active source when it locks', async () => {
    const registeredApp = await compile({ imports: [DatabaseModule, IdempotencyModule.forRoot()], providers: [AppIdempotencyStore] });
    await registeredApp.init();
    expect(log).toHaveBeenCalledWith('IdempotencyStorage: AppIdempotencyStore');
    await registeredApp.close();

    log.mockClear();
    const defaultApp = await compile({ imports: [IdempotencyModule.forRoot()] });
    await defaultApp.init();
    expect(log).toHaveBeenCalledWith(
      'IdempotencyStorage: InMemoryIdempotencyStore (the default: state is lost on restart and not shared between instances)',
    );
    expect(log.mock.calls.filter(([message]: unknown[]) => String(message).startsWith('IdempotencyStorage:'))).toHaveLength(1);
    await defaultApp.close();
  });

  describe('in production', () => {
    beforeEach(() => vi.stubEnv('NODE_ENV', 'production'));

    const boot = async (module: Type<unknown> | DynamicModule) => {
      const moduleRef = await compile({ imports: [module] });
      try {
        await moduleRef.init();
        return moduleRef.get(IdempotencyStorage).source;
      } finally {
        await moduleRef.close();
      }
    };

    it('fails startup without a registered store, saying what to implement and how to register it', async () => {
      await expect(boot(IdempotencyModule.forRoot())).rejects.toThrow(
        'IdempotencyStorage: no IdempotencyStore is registered, and NODE_ENV is "production": in memory, idempotency ' +
          'records would be lost on restart and not shared between instances. Implement IdempotencyStore in a ' +
          'provider that injects IdempotencyStorage and calls `storage.registerSource(this)` in its constructor, or ' +
          'set `allowInMemoryStorage: true` in the IdempotencyModule options to run in memory anyway.',
      );
      await expect(boot(IdempotencyModule.forRootAsync({ useFactory: () => ({}) }))).rejects.toThrow(
        'no IdempotencyStore is registered',
      );
    });

    it('starts on the in-memory store with allowInMemoryStorage, from forRoot or the factory', async () => {
      expect(await boot(IdempotencyModule.forRoot({ allowInMemoryStorage: true }))).toBeInstanceOf(InMemoryIdempotencyStore);
      expect(
        await boot(IdempotencyModule.forRootAsync({ useFactory: async () => ({ allowInMemoryStorage: true }) })),
      ).toBeInstanceOf(InMemoryIdempotencyStore);
    });

    it('starts with a registered store', async () => {
      @Module({ imports: [DatabaseModule, IdempotencyModule.forRoot()], providers: [AppIdempotencyStore] })
      class AppModule {}
      expect(await boot(AppModule)).toBeInstanceOf(AppIdempotencyStore);
    });
  });
});
