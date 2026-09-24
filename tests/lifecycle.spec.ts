import { Logger, type CallHandler, type ExecutionContext } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { lastValueFrom, NEVER, Observable, of, take, throwError, toArray } from 'rxjs';
import { IdempotencyInterceptor } from '../lib/interceptors/idempotency.interceptor.js';
import {
  Idempotent,
  IdempotencyEvents,
  IdempotencyModule,
  InMemoryIdempotencyStore,
  type IdempotencyEvent,
  type IdempotencyModuleOptions,
} from '../lib/index.js';
import { registered } from './register.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(check: () => boolean, timeout = 2_000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeout) {
      throw new Error('Timed out waiting');
    }
    await sleep(5);
  }
}

class Consumers {
  @Idempotent()
  charge() {}
}

/** A message-handler call carrying `key` in its payload. */
const rpcCall = (key: string) =>
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

const storeKey = (key: string) => `${key}:Consumers.charge`;

describe('the lock while a call runs', () => {
  let store: InMemoryIdempotencyStore;
  let moduleRef: TestingModule;
  let interceptor: IdempotencyInterceptor;

  async function boot(options: IdempotencyModuleOptions = {}) {
    store = new InMemoryIdempotencyStore();
    moduleRef = await Test.createTestingModule({
      imports: [IdempotencyModule.forRoot(options)],
      providers: [registered(store)],
    }).compile();
    await moduleRef.init();
    interceptor = moduleRef.get(IdempotencyInterceptor);
  }

  afterEach(async () => {
    vi.restoreAllMocks();
    await moduleRef?.close();
  });

  const run = (key: string, next: CallHandler) =>
    lastValueFrom(interceptor.intercept(rpcCall(key), next));

  it('stays renewed until the result is stored, even when the store is slow to store it', async () => {
    await boot({ lockTtl: 60 });

    const complete = store.complete.bind(store);
    vi.spyOn(store, 'complete').mockImplementation(async (...args) => {
      await sleep(250); // a slow write, four times lockTtl
      return complete(...args);
    });
    let runs = 0;
    const next = { handle: () => (runs++, of({ charged: runs })) };

    const first = run('k1', next);
    await sleep(150); // the handler finished; its result is still being written
    const duplicate: any = await run('k1', next).catch((err) => err);
    expect(duplicate.getError()).toMatchObject({ code: 'IDEMPOTENCY_KEY_IN_USE' });
    expect(await first).toEqual({ charged: 1 });
    expect(runs).toBe(1);
    expect(store.peek(storeKey('k1'))?.state).toBe('completed');
  });

  it('renews one call at a time, however slow the store is', async () => {
    await boot({ lockTtl: 30 }); // a renewal every 10 ms

    let inFlight = 0;
    let most = 0;
    const extend = store.extend.bind(store);
    vi.spyOn(store, 'extend').mockImplementation(async (...args) => {
      most = Math.max(most, ++inFlight);
      await sleep(40);
      inFlight--;
      return extend(...args);
    });

    const next = {
      handle: () => new Observable((s) => void sleep(200).then(() => (s.next('ok'), s.complete()))),
    };

    expect(await run('k1', next)).toBe('ok');
    expect(store.extend).toHaveBeenCalled();
    expect(most).toBe(1);
  });

  it('stops renewing at shutdown, even for a handler that never finishes', async () => {
    await boot({ lockTtl: 30 });
    const extend = vi.spyOn(store, 'extend');
    void run('k1', { handle: () => NEVER }).catch(() => {});
    await until(() => extend.mock.calls.length > 0);

    await moduleRef.close();
    const renewals = extend.mock.calls.length;
    await sleep(60);
    expect(extend.mock.calls.length).toBe(renewals);
  });

  it('releases the key and stops renewing when calling the handler throws synchronously', async () => {
    await boot({ lockTtl: 30 });
    const extend = vi.spyOn(store, 'extend');
    const next = {
      handle: (): Observable<unknown> => {
        throw new Error('boom');
      },
    };

    await expect(run('k1', next)).rejects.toThrow('boom');
    await until(() => store.peek(storeKey('k1')) === undefined);

    const renewals = extend.mock.calls.length;
    await sleep(60);
    expect(extend.mock.calls.length).toBe(renewals);
  });

  it('releases a lock the store took before its reply was lost, instead of blocking the key', async () => {
    await boot();
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});

    const acquire = store.acquire.bind(store);
    vi.spyOn(store, 'acquire').mockImplementationOnce(async (...args) => {
      await acquire(...args); // the lock is taken ...
      throw new Error('connection reset'); // ... but the reply never arrives
    });

    await expect(run('k1', { handle: () => of('ok') })).rejects.toThrow('connection reset');
    await until(() => store.peek(storeKey('k1')) === undefined);
    expect(await run('k1', { handle: () => of('retried') })).toBe('retried');
  });

  it('stops a streamed reply when its caller leaves, and releases the key', async () => {
    await boot({ lockTtl: 30 });
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});

    let emitted = 0;
    const next = { handle: () => new Observable<number>((s) => {
      const timer = setInterval(() => s.next(++emitted), 5);
      return () => clearInterval(timer);
    }) };

    const values = await lastValueFrom(
      interceptor.intercept(rpcCall('k1'), next).pipe(take(3), toArray()),
    );
    expect(values).toEqual([1, 2, 3]);

    await until(() => store.peek(storeKey('k1')) === undefined);
    const stoppedAt = emitted;
    await sleep(40);
    expect(emitted).toBe(stoppedAt);
    expect(await run('k1', { handle: () => of('again') })).toBe('again');
  });

  it('reports a lost lock once: the renewal that found out, not the store of the result too', async () => {
    await boot({ lockTtl: 30 }); // a renewal every 10 ms
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    const events: IdempotencyEvent[] = [];
    moduleRef.get(IdempotencyEvents).events$.subscribe((event) => events.push(event));

    // The lock is gone (a store outage let it expire, and a retry took it over).
    vi.spyOn(store, 'extend').mockResolvedValue(false);
    vi.spyOn(store, 'complete').mockResolvedValue(false);
    const next = { handle: () => new Observable((s) => void sleep(60).then(() => (s.next('ok'), s.complete()))) };

    expect(await run('k1', next)).toBe('ok');
    expect(events).toEqual([
      { type: 'lock-lost', phase: 'extend', context: 'rpc', handler: 'Consumers.charge', key: 'k1' },
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('reports a store that fails to keep the outcome as a lost lock, and still returns the result', async () => {
    await boot();
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    const events: IdempotencyEvent[] = [];
    moduleRef.get(IdempotencyEvents).events$.subscribe((event) => events.push(event));

    vi.spyOn(store, 'complete').mockRejectedValueOnce(new Error('connection reset'));
    expect(await run('k1', { handle: () => of('charged') })).toBe('charged');

    expect(events).toEqual([
      { type: 'lock-lost', phase: 'complete', context: 'rpc', handler: 'Consumers.charge', key: 'k1' },
    ]);
    expect(error).toHaveBeenCalledTimes(1);

    // The same for a release (a 5xx outcome): the retry that follows re-runs the handler.
    vi.spyOn(store, 'release').mockRejectedValueOnce(new Error('connection reset'));
    await expect(run('k2', { handle: () => throwError(() => new Error('down')) })).rejects.toThrow('down');
    expect(events[1]).toEqual({ type: 'lock-lost', phase: 'release', context: 'rpc', handler: 'Consumers.charge', key: 'k2' });
    expect(error).toHaveBeenCalledTimes(2);
  });

  it('hands the store whole milliseconds, which Redis PEXPIRE requires', async () => {
    await boot({ lockTtl: 1000 / 3, ttl: 10_000 / 3 });
    const acquire = vi.spyOn(store, 'acquire');
    const complete = vi.spyOn(store, 'complete');

    await run('k1', { handle: () => of('ok') });
    expect(acquire.mock.calls[0][3]).toBe(334);
    expect(complete.mock.calls[0][3]).toBe(3334);
  });
});
