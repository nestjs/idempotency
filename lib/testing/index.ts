/**
 * `@nestjs/idempotency/testing`: the `IdempotencyStore` contract as test
 * cases, for any test runner. Every store the package documents passes it
 * (the in-memory default, the Redis and Drizzle recipes); run it against
 * yours:
 *
 * ```ts
 * import { idempotencyStoreContract } from '@nestjs/idempotency/testing';
 *
 * describe('DrizzleIdempotencyStore', () => {
 *   const cases = idempotencyStoreContract(() => new DrizzleIdempotencyStore(db, storage), {
 *     concurrent: true,
 *   });
 *   for (const c of cases) it(c.name, c.run);
 * });
 * ```
 *
 * Each case throws (an `AssertionError`) on failure. The cases use their own
 * random keys, so they may share one store and one table.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type {
  IdempotencyAcquireResult,
  IdempotencySealedResponse,
  IdempotencyStore,
  IdempotencyStoredPayload,
  IdempotencyStoredResponse,
} from '../interfaces/idempotency-store.interface.js';

export interface IdempotencyStoreContractOptions {
  /**
   * Moves the clock the store reads forward by `ms`, for the expiry cases.
   * For a store that reads `Date.now()`, under Vitest:
   * `vi.useFakeTimers({ toFake: ['Date'] })` before each case, and
   * `advanceTime: (ms) => vi.setSystemTime(Date.now() + ms)`. Default: wait
   * in real time (the expiry cases then take a few seconds in total), for a
   * store whose clock can't be moved, such as a Redis server.
   */
  advanceTime?: (ms: number) => unknown;
  /**
   * Also run the concurrency cases: many callers race for one key (a free
   * one, an expired lock, an expired record) and exactly one may win, and
   * `acquire()` races `release()` and `complete()`. A store that reads and
   * then writes in two steps fails them. `true` uses 16 callers per race.
   * Run them where calls really overlap: against a pooled connection, not
   * one that serializes every statement (though that is a valid run too).
   */
  concurrent?: boolean | { callers?: number };
}

export interface IdempotencyStoreContractCase {
  name: string;
  run: () => Promise<void>;
}

/** The lock's time to live in the cases, the margin around each expiry, and a record's time to live. */
const LOCK_TTL = 600;
const MARGIN = 150;
const TTL = 3 * LOCK_TTL;
/** 30 days in ms: past a 32-bit integer (2,147,483,647). */
const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;

const response: IdempotencyStoredResponse = { status: 201, headers: {}, body: { receiptId: 'pf_ch_0001' } };

/**
 * The `IdempotencyStore` contract as runner-agnostic cases. `createStore` is
 * called once per case; it may return the same store every time.
 */
export function idempotencyStoreContract(
  createStore: () => IdempotencyStore | Promise<IdempotencyStore>,
  options: IdempotencyStoreContractOptions = {},
): IdempotencyStoreContractCase[] {
  const advanceTime = options.advanceTime ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const advance = async (ms: number) => {
    await advanceTime(ms);
  };

  const callers =
    options.concurrent === true ? 16 : options.concurrent ? (options.concurrent.callers ?? 16) : 0;
  if (options.concurrent && (!Number.isInteger(callers) || callers < 2)) {
    throw new RangeError(`idempotencyStoreContract(): concurrent.callers must be an integer of at least 2, got ${callers}`);
  }

  const cases: IdempotencyStoreContractCase[] = [];
  /** A case gets a fresh store and a key prefix of its own. */
  const test = (name: string, body: (store: IdempotencyStore, key: (name: string) => string) => Promise<void>) => {
    cases.push({
      name,
      run: async () => {
        const prefix = `contract-${randomUUID()}:`;
        await body(await createStore(), (name) => prefix + name);
      },
    });
  };

  test('acquire() takes a free key, and later callers see the lock with its fingerprint', async (store, key) => {
    const k = key('k');
    expectResult(await store.acquire(k, 'a', 'fp-a', LOCK_TTL), { state: 'acquired' }, 'acquire() of a free key');
    expectResult(
      await store.acquire(k, 'b', 'fp-b', LOCK_TTL),
      { state: 'in-flight', fingerprint: 'fp-a' },
      'acquire() of a locked key (the stored fingerprint, not the caller\'s)',
    );
    expectResult(
      await store.acquire(k, 'a', 'fp-a', LOCK_TTL),
      { state: 'in-flight', fingerprint: 'fp-a' },
      'acquire() by the owner itself (a lock is taken once)',
    );
  });

  test('complete() stores the response for the owner only, and acquire() returns it', async (store, key) => {
    const k = key('k');
    await store.acquire(k, 'a', 'fp-a', LOCK_TTL);

    assert.equal(await store.complete(k, 'b', response, TTL), false, 'complete() by another owner');
    assert.equal(await store.complete(k, 'a', response, TTL), true, 'complete() by the owner');

    expectResult(
      await store.acquire(k, 'c', 'fp-c', LOCK_TTL),
      { state: 'completed', fingerprint: 'fp-a', response },
      'acquire() of a completed key',
    );
  });

  test('a completed record is final: complete(), release() and extend() leave it alone', async (store, key) => {
    const k = key('k');
    await store.acquire(k, 'a', 'fp-a', LOCK_TTL);
    await store.complete(k, 'a', response, TTL);

    const other = { status: 500, headers: {}, body: 'overwritten' };
    assert.equal(await store.complete(k, 'a', other, TTL), false, 'complete() of a completed record');
    assert.equal(await store.release(k, 'a'), false, 'release() of a completed record');
    assert.equal(await store.extend(k, 'a', LOCK_TTL), false, 'extend() of a completed record');
    expectResult(
      await store.acquire(k, 'b', 'fp-a', LOCK_TTL),
      { state: 'completed', fingerprint: 'fp-a', response },
      'acquire() after those calls',
    );
  });

  test('release() deletes the lock for the owner only, and frees the key', async (store, key) => {
    const k = key('k');
    await store.acquire(k, 'a', 'fp-a', LOCK_TTL);

    assert.equal(await store.release(k, 'b'), false, 'release() by another owner');
    assert.equal(await store.release(k, 'a'), true, 'release() by the owner');
    assert.equal(await store.release(k, 'a'), false, 'release() of a released lock');

    expectResult(await store.acquire(k, 'b', 'fp-b', LOCK_TTL), { state: 'acquired' }, 'acquire() after release()');
    expectResult(
      await store.acquire(k, 'c', 'fp-c', LOCK_TTL),
      { state: 'in-flight', fingerprint: 'fp-b' },
      'acquire() of the new lock',
    );
  });

  test('complete(), release() and extend() on a key without a record change nothing', async (store, key) => {
    const k = key('missing');
    assert.equal(await store.complete(k, 'a', response, TTL), false, 'complete() of a missing key');
    assert.equal(await store.extend(k, 'a', LOCK_TTL), false, 'extend() of a missing key');
    assert.equal(await store.release(k, 'a'), false, 'release() of a missing key');
    expectResult(await store.acquire(k, 'a', 'fp-a', LOCK_TTL), { state: 'acquired' }, 'acquire() afterwards');
  });

  test('extend() renews the lock for the owner only', async (store, key) => {
    const k = key('k');
    await store.acquire(k, 'a', 'fp-a', LOCK_TTL);
    await advance(LOCK_TTL - MARGIN);
    assert.equal(await store.extend(k, 'b', LOCK_TTL), false, 'extend() by another owner');
    assert.equal(await store.extend(k, 'a', LOCK_TTL), true, 'extend() by the owner');

    await advance(LOCK_TTL - MARGIN); // past the first expiry, before the renewed one
    expectResult(
      await store.acquire(k, 'b', 'fp-b', LOCK_TTL),
      { state: 'in-flight', fingerprint: 'fp-a' },
      'acquire() after the renewal, before the renewed expiry',
    );

    await advance(2 * MARGIN); // past the renewed expiry
    assert.equal(await store.extend(k, 'a', LOCK_TTL), false, 'extend() of an expired lock');
    expectResult(await store.acquire(k, 'b', 'fp-b', LOCK_TTL), { state: 'acquired' }, 'acquire() once it expired');
  });

  test('extend() leaves a completed record\'s ttl alone', async (store, key) => {
    const k = key('k');
    await store.acquire(k, 'a', 'fp-a', LOCK_TTL);
    await store.complete(k, 'a', response, TTL);
    assert.equal(await store.extend(k, 'a', LOCK_TTL), false, 'extend() of a completed record');

    await advance(TTL - MARGIN); // past lockTtl, before ttl
    expectResult(
      await store.acquire(k, 'b', 'fp-a', LOCK_TTL),
      { state: 'completed', fingerprint: 'fp-a', response },
      'acquire() before ttl passed (the record must keep ttl, not lockTtl)',
    );

    await advance(2 * MARGIN);
    expectResult(await store.acquire(k, 'b', 'fp-b', LOCK_TTL), { state: 'acquired' }, 'acquire() after ttl passed');
  });

  test('an expired lock is taken over by the next acquire(), and the stale owner is fenced off', async (store, key) => {
    const k = key('k');
    await store.acquire(k, 'crashed', 'fp-a', LOCK_TTL);
    await advance(LOCK_TTL + MARGIN);

    expectResult(await store.acquire(k, 'retry', 'fp-b', LOCK_TTL), { state: 'acquired' }, 'acquire() of an expired lock');
    assert.equal(await store.extend(k, 'crashed', LOCK_TTL), false, 'extend() by the stale owner');
    assert.equal(await store.complete(k, 'crashed', response, TTL), false, 'complete() by the stale owner');
    assert.equal(await store.release(k, 'crashed'), false, 'release() by the stale owner');

    expectResult(
      await store.acquire(k, 'other', 'fp-c', LOCK_TTL),
      { state: 'in-flight', fingerprint: 'fp-b' },
      'acquire() of the new owner\'s lock',
    );

    const retried = { ...response, body: { receiptId: 'pf_ch_0002' } };
    assert.equal(await store.complete(k, 'retry', retried, TTL), true, 'complete() by the new owner');
    expectResult(
      await store.acquire(k, 'other', 'fp-b', LOCK_TTL),
      { state: 'completed', fingerprint: 'fp-b', response: retried },
      'acquire() of the new owner\'s record',
    );
  });

  test('an owner whose lock expired can no longer complete or release it', async (store, key) => {
    const k = key('k');
    await store.acquire(k, 'a', 'fp-a', LOCK_TTL);
    await advance(LOCK_TTL + MARGIN);

    assert.equal(await store.complete(k, 'a', response, TTL), false, 'complete() of an expired lock');
    assert.equal(await store.release(k, 'a'), false, 'release() of an expired lock');
    expectResult(await store.acquire(k, 'b', 'fp-b', LOCK_TTL), { state: 'acquired' }, 'acquire() afterwards');
  });

  test('a completed record expires after ttl, and its key is free again', async (store, key) => {
    const k = key('k');
    await store.acquire(k, 'a', 'fp-a', LOCK_TTL);
    await store.complete(k, 'a', response, TTL);

    await advance(TTL - MARGIN);
    expectResult(
      await store.acquire(k, 'b', 'fp-a', LOCK_TTL),
      { state: 'completed', fingerprint: 'fp-a', response },
      'acquire() before ttl passed',
    );

    await advance(2 * MARGIN);
    expectResult(await store.acquire(k, 'c', 'fp-c', LOCK_TTL), { state: 'acquired' }, 'acquire() after ttl passed');
    expectResult(
      await store.acquire(k, 'd', 'fp-d', LOCK_TTL),
      { state: 'in-flight', fingerprint: 'fp-c' },
      'acquire() of the new lock',
    );
  });

  test('takes durations of weeks, past a 32-bit integer', async (store, key) => {
    const k = key('k');
    expectResult(await store.acquire(k, 'a', 'fp-a', THIRTY_DAYS), { state: 'acquired' }, 'acquire() with a 30-day lockTtl');
    assert.equal(await store.extend(k, 'a', THIRTY_DAYS), true, 'extend() with a 30-day lockTtl');
    assert.equal(await store.complete(k, 'a', response, THIRTY_DAYS), true, 'complete() with a 30-day ttl');

    await advance(TTL);
    expectResult(
      await store.acquire(k, 'b', 'fp-a', LOCK_TTL),
      { state: 'completed', fingerprint: 'fp-a', response },
      'acquire() of a record with a 30-day ttl',
    );
  });

  test('keeps keys apart exactly, however similar or long', async (store, key) => {
    const long = printable(4_000);
    const names = [
      'k', 'K', 'k ', ' k', 'k\t', 'usr_alice:k', 'usr_alice%3Ak', 'ключ', 'klucz-ż', '🔑', 'é', 'é',
      '__proto__', 'constructor', 'toString', `${long}x`, `${long}y`, `y${long}`,
    ];

    for (const [i, name] of names.entries()) {
      expectResult(await store.acquire(key(name), 'a', `fp-${i}`, LOCK_TTL), { state: 'acquired' }, `acquire() of key #${i}`);
    }

    for (const [i, name] of names.entries()) {
      expectResult(
        await store.acquire(key(name), 'b', 'fp', LOCK_TTL),
        { state: 'in-flight', fingerprint: `fp-${i}` },
        `acquire() of key #${i} again (${JSON.stringify(name.slice(0, 20))}): another key's record came back`,
      );
    }
  });

  test('stores every payload as given, and returns an equal copy', async (store, key) => {
    const payloads: IdempotencyStoredPayload[] = [
      {
        status: 402,
        headers: { location: '/payments/1', 'content-language': ['en', 'pl'] },
        body: {
          message: "O'Reilly ü \u0000 \\ \" 💳  ",
          nested: [{ at: { __idempotencyType: 'Date', value: '2026-09-22T12:00:00.000Z' } }],
          numbers: [0, -1, 1.5, 9007199254740991],
          empty: {},
        },
        error: 'http',
      } satisfies IdempotencyStoredResponse,
      { status: 200, headers: {}, body: null },
      { status: 204, headers: {}, body: '' },
      { status: 201, headers: {}, body: { text: printable(100_000) } },
      { sealed: `v1.abcd1234.${'A'.repeat(16)}.${'B'.repeat(50_000)}.${'C'.repeat(22)}` } satisfies IdempotencySealedResponse,
    ];

    for (const [i, payload] of payloads.entries()) {
      const k = key(`k${i}`);
      const given = structuredClone(payload);
      await store.acquire(k, 'a', 'fp', LOCK_TTL);
      assert.equal(await store.complete(k, 'a', given, TTL), true, `complete() with payload #${i}`);

      mutate(given); // the caller's object is not the stored record
      const first = await store.acquire(k, 'b', 'fp', LOCK_TTL);
      expectResult(first, { state: 'completed', fingerprint: 'fp', response: payload }, `payload #${i}`);
      if (first.state === 'completed') {
        mutate(first.response); // nor is what a caller got back
      }

      expectResult(
        await store.acquire(k, 'b', 'fp', LOCK_TTL),
        { state: 'completed', fingerprint: 'fp', response: payload },
        `payload #${i}, read again after the caller changed its copies`,
      );
    }
  });

  if (!callers) {
    return cases;
  }

  /** What each racing caller passes as its fingerprint (its owner is `owner-<i>`). */
  const fps = Array.from({ length: callers }, (_, i) => `fp-${i}`);
  const acquires = (store: IdempotencyStore, k: string) =>
    fps.map((fp, i) => store.acquire(k, `owner-${i}`, fp, LOCK_TTL));
  const race = (store: IdempotencyStore, k: string) => Promise.all(acquires(store, k));

  test(`concurrency: of ${callers} callers acquiring a free key at once, exactly one wins`, async (store, key) => {
    const k = key('race');
    const results = await race(store, k);
    expectOneWinner(results, fps, 'acquire() of a free key');
  });

  test(`concurrency: of ${callers} callers acquiring an expired lock at once, exactly one takes it over`, async (store, key) => {
    const k = key('race');
    await store.acquire(k, 'crashed', 'fp-crashed', LOCK_TTL);
    await advance(LOCK_TTL + MARGIN);

    const results = await race(store, k);
    expectOneWinner(results, fps, 'acquire() of an expired lock');
    assert.equal(await store.complete(k, 'crashed', response, TTL), false, 'complete() by the stale owner');
  });

  test(`concurrency: of ${callers} callers acquiring an expired record at once, exactly one wins`, async (store, key) => {
    const k = key('race');
    await store.acquire(k, 'first', 'fp-first', LOCK_TTL);
    await store.complete(k, 'first', response, TTL);
    await advance(TTL + MARGIN);

    const results = await race(store, k);
    expectOneWinner(results, fps, 'acquire() of an expired record');
  });

  test(`concurrency: ${callers} callers on ${Math.ceil(callers / 2)} keys at once: one winner per key`, async (store, key) => {
    const keys = Array.from({ length: Math.ceil(callers / 2) }, (_, i) => key(`key-${i}`));
    const results = await Promise.all(
      keys.flatMap((k, i) => [
        store.acquire(k, `owner-${i}-a`, `fp-${i}-a`, LOCK_TTL),
        store.acquire(k, `owner-${i}-b`, `fp-${i}-b`, LOCK_TTL),
      ]),
    );

    keys.forEach((_, i) =>
      expectOneWinner(results.slice(2 * i, 2 * i + 2), [`fp-${i}-a`, `fp-${i}-b`], `acquire() of key #${i}`),
    );
  });

  test('concurrency: acquire() racing release() never fails, and at most one caller wins', async (store, key) => {
    const k = key('race');
    await store.acquire(k, 'owner', 'fp-owner', LOCK_TTL);

    const [released, ...results] = await Promise.all([
      store.release(k, 'owner'),
      ...acquires(store, k),
    ]);
    assert.equal(released, true, 'release() by the owner');

    const winners = results.flatMap((r, i) => (r.state === 'acquired' ? [i] : []));
    assert.ok(winners.length <= 1, `acquire() racing release(): ${winners.length} callers acquired the key`);
    for (const r of results) {
      assert.ok(
        r.state === 'acquired' || (r.state === 'in-flight' && ['fp-owner', ...winners.map((i) => `fp-${i}`)].includes(r.fingerprint)),
        `acquire() racing release() returned ${JSON.stringify(r)}`,
      );
    }

    expectResult(
      await store.acquire(k, 'late', 'fp-late', LOCK_TTL),
      winners.length ? { state: 'in-flight', fingerprint: `fp-${winners[0]}` } : { state: 'acquired' },
      'acquire() once the race settled',
    );
  });

  test('concurrency: acquire() racing complete() sees the lock or the record, never a free key', async (store, key) => {
    const k = key('race');
    await store.acquire(k, 'owner', 'fp-owner', LOCK_TTL);

    const [completed, ...results] = await Promise.all([
      store.complete(k, 'owner', response, TTL),
      ...acquires(store, k),
    ]);
    assert.equal(completed, true, 'complete() by the owner');

    for (const r of results) {
      if (r.state === 'completed') {
        expectResult(r, { state: 'completed', fingerprint: 'fp-owner', response }, 'acquire() racing complete()');
      } else {
        expectResult(r, { state: 'in-flight', fingerprint: 'fp-owner' }, 'acquire() racing complete()');
      }
    }
  });

  return cases;
}

/** Compares what `acquire()` resolved, ignoring extra properties a store may add. */
function expectResult(actual: IdempotencyAcquireResult, expected: IdempotencyAcquireResult, what: string) {
  assert.ok(
    actual !== null && typeof actual === 'object' && ['acquired', 'in-flight', 'completed'].includes(actual.state),
    `${what}: acquire() must resolve { state: 'acquired' | 'in-flight' | 'completed' }, got ${JSON.stringify(actual)}`,
  );

  const pick = (r: IdempotencyAcquireResult) =>
    r.state === 'acquired'
      ? { state: r.state }
      : r.state === 'in-flight'
        ? { state: r.state, fingerprint: r.fingerprint }
        : { state: r.state, fingerprint: r.fingerprint, response: r.response };
  assert.deepStrictEqual(pick(actual), pick(expected), what);
}

/**
 * Exactly one caller acquired, and every other one saw the winner's lock.
 * `fingerprints[i]` is what caller `i` passed.
 */
function expectOneWinner(results: IdempotencyAcquireResult[], fingerprints: string[], what: string) {
  const winners = results.flatMap((r, i) => (r.state === 'acquired' ? [i] : []));
  assert.equal(winners.length, 1, `${what}: ${winners.length} of ${results.length} concurrent callers acquired the key`);

  const winner = winners[0]!;
  for (const [i, r] of results.entries()) {
    if (i === winner) {
      continue;
    }
    expectResult(r, { state: 'in-flight', fingerprint: fingerprints[winner]! }, `${what}: a losing caller`);
  }
}

/** Changes a payload in place, wherever it can. */
function mutate(payload: IdempotencyStoredPayload) {
  if ('sealed' in payload) {
    (payload as { sealed: string }).sealed = 'tampered';
  } else {
    payload.status = 599;
    payload.headers['x-mutated'] = 'yes';
    if (payload.body && typeof payload.body === 'object') {
      (payload.body as Record<string, unknown>).mutated = true;
    }
  }
}

/** A deterministic string of `length` varied characters (ASCII and beyond), which doesn't compress. */
function printable(length: number): string {
  let seed = 0x2545f491;
  let out = '';
  while (out.length < length) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const n = seed % 100;
    out += n < 94 ? String.fromCharCode(33 + n) : ['ą', 'ß', 'ж', '中', 'é', 'ø'][n - 94];
  }
  return out.slice(0, length);
}
