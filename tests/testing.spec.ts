/**
 * The contract suite (`@nestjs/idempotency/testing`) itself: it passes a correct store, and
 * fails the stores it exists to catch, each on the case that names the broken rule.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { InMemoryIdempotencyStore, type IdempotencyStore, type IdempotencyStoredPayload } from '../lib/index.js';
import { idempotencyStoreContract, type IdempotencyStoreContractCase } from '../lib/testing/index.js';

type Entry = { owner?: string; fingerprint: string; response?: unknown; expiresAt: number };

/** Read, then write, with a round trip in between: what a naive SQL or Redis store does. */
class ReadThenWriteStore implements IdempotencyStore {
  readonly rows = new Map<string, Entry>();
  async acquire(key: string, owner: string, fingerprint: string, lockTtl: number) {
    const row = this.live(key);
    await sleep(1); // the round trip between the SELECT and the INSERT
    if (row) {
      return row.owner !== undefined
        ? { state: 'in-flight' as const, fingerprint: row.fingerprint }
        : { state: 'completed' as const, fingerprint: row.fingerprint, response: structuredClone(row.response) as never };
    }

    this.rows.set(key, { owner, fingerprint, expiresAt: Date.now() + lockTtl });
    return { state: 'acquired' as const };
  }
  async complete(key: string, owner: string, response: unknown, ttl: number) {
    const row = this.live(key);
    if (row?.owner !== owner) {
      return false;
    }
    this.rows.set(key, { fingerprint: row.fingerprint, response: structuredClone(response), expiresAt: Date.now() + ttl });
    return true;
  }
  async release(key: string, owner: string) {
    if (this.live(key)?.owner !== owner) {
      return false;
    }
    return this.rows.delete(key);
  }
  async extend(key: string, owner: string, lockTtl: number) {
    const row = this.live(key);
    if (row?.owner !== owner) {
      return false;
    }
    row.expiresAt = Date.now() + lockTtl;
    return true;
  }
  protected live(key: string) {
    const row = this.rows.get(key);
    return row && row.expiresAt > Date.now() ? row : undefined;
  }
}

/** Checks the owner, but not whether the lock has expired: a stale owner still writes. */
class NoExpiryCheckStore extends ReadThenWriteStore {
  override async complete(key: string, owner: string, response: unknown, ttl: number) {
    const row = this.rows.get(key);
    if (row?.owner !== owner) {
      return false;
    }
    this.rows.set(key, { fingerprint: row.fingerprint, response: structuredClone(response), expiresAt: Date.now() + ttl });
    return true;
  }
}

/** Keeps keys in a fixed-width column: long keys that share a prefix collide. */
class TruncatingStore extends InMemoryIdempotencyStore {
  override acquire(key: string, ...rest: [string, string, number]) {
    return super.acquire(key.slice(0, 255), ...rest);
  }
}

async function failures(cases: IdempotencyStoreContractCase[]) {
  const failed: string[] = [];
  for (const c of cases) {
    try {
      await c.run();
    } catch (error) {
      failed.push(`${c.name}: ${(error as Error).message.split('\n')[0]}`);
    }
  }
  return failed;
}

describe('idempotencyStoreContract()', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-22T12:00:00.000Z'));
  });
  afterEach(() => vi.useRealTimers());
  const advanceTime = (ms: number) => vi.setSystemTime(Date.now() + ms);

  it('returns plain { name, run } cases; the concurrency ones only when asked', () => {
    const basic = idempotencyStoreContract(() => new InMemoryIdempotencyStore());
    const all = idempotencyStoreContract(() => new InMemoryIdempotencyStore(), { concurrent: { callers: 4 } });

    expect(basic.length).toBe(13);
    expect(all.length).toBe(19);
    expect(all.filter((c) => c.name.startsWith('concurrency:')).map((c) => c.name)).toEqual([
      'concurrency: of 4 callers acquiring a free key at once, exactly one wins',
      'concurrency: of 4 callers acquiring an expired lock at once, exactly one takes it over',
      'concurrency: of 4 callers acquiring an expired record at once, exactly one wins',
      'concurrency: 4 callers on 2 keys at once: one winner per key',
      'concurrency: acquire() racing release() never fails, and at most one caller wins',
      'concurrency: acquire() racing complete() sees the lock or the record, never a free key',
    ]);

    expect(() => idempotencyStoreContract(() => new InMemoryIdempotencyStore(), { concurrent: { callers: 1 } })).toThrow(
      'concurrent.callers must be an integer of at least 2, got 1',
    );
  });

  it('passes the in-memory store, sharing one store across cases', async () => {
    const shared = new InMemoryIdempotencyStore();
    expect(await failures(idempotencyStoreContract(() => shared, { advanceTime, concurrent: true }))).toEqual([]);
  });

  it('waits in real time without advanceTime', async () => {
    vi.useRealTimers();
    const [expiry] = idempotencyStoreContract(() => new InMemoryIdempotencyStore()).filter((c) =>
      c.name.startsWith('an owner whose lock expired'),
    );

    const started = Date.now();
    await expiry!.run();
    expect(Date.now() - started).toBeGreaterThanOrEqual(740);
  });

  it('fails a read-then-write store on the races only', async () => {
    const failed = await failures(idempotencyStoreContract(() => new ReadThenWriteStore(), { advanceTime, concurrent: true }));
    expect(failed.length).toBeGreaterThanOrEqual(3);
    expect(failed.every((f) => f.startsWith('concurrency:'))).toBe(true);
    expect(failed[0]).toMatch(/^concurrency: of 16 callers acquiring a free key at once, exactly one wins: .*16 of 16 concurrent callers acquired/);
  });

  it('fails a store whose stale owner can still complete', async () => {
    const failed = await failures(idempotencyStoreContract(() => new NoExpiryCheckStore(), { advanceTime }));
    expect(failed).toEqual([
      expect.stringMatching(/^an owner whose lock expired can no longer complete or release it: complete\(\) of an expired lock/),
    ]);
  });

  it('fails a store that truncates keys', async () => {
    const failed = await failures(idempotencyStoreContract(() => new TruncatingStore(), { advanceTime }));
    expect(failed).toEqual([expect.stringMatching(/^keeps keys apart exactly, however similar or long: acquire\(\) of key #16/)]);
  });
});

/** Answers with the caller's fingerprint instead of the stored one: every key reuse would look like a retry. */
class EchoFingerprintStore extends InMemoryIdempotencyStore {
  override async acquire(key: string, owner: string, fingerprint: string, lockTtl: number) {
    const result = await super.acquire(key, owner, fingerprint, lockTtl);
    return result.state === 'acquired' ? result : { ...result, fingerprint };
  }
}

/** Hands out the stored object itself, so a caller that changes its copy changes the record. */
class SharedReferenceStore extends InMemoryIdempotencyStore {
  private readonly refs = new Map<string, IdempotencyStoredPayload>();
  override async complete(key: string, owner: string, response: IdempotencyStoredPayload, ttl: number) {
    const done = await super.complete(key, owner, response, ttl);
    if (done) {
      this.refs.set(key, response);
    }
    return done;
  }
  override async acquire(key: string, owner: string, fingerprint: string, lockTtl: number) {
    const result = await super.acquire(key, owner, fingerprint, lockTtl);
    return result.state === 'completed' ? { ...result, response: this.refs.get(key)! } : result;
  }
}

/** Renews a completed record too, cutting its ttl down to lockTtl. */
class ExtendsRecordsStore extends InMemoryIdempotencyStore {
  override async extend(key: string, owner: string, lockTtl: number) {
    const entry = this.peek(key) as { state: string; expiresAt: number } | undefined;
    if (entry?.state === 'completed') {
      entry.expiresAt = Date.now() + lockTtl;
      return true;
    }
    return super.extend(key, owner, lockTtl);
  }
}

describe('idempotencyStoreContract() against broken stores', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-24T12:00:00.000Z'));
  });
  afterEach(() => vi.useRealTimers());
  const advanceTime = (ms: number) => vi.setSystemTime(Date.now() + ms);

  it("fails a store that answers with the caller's fingerprint, not the stored one", async () => {
    const failed = await failures(idempotencyStoreContract(() => new EchoFingerprintStore(), { advanceTime }));
    expect(failed).toContainEqual(
      expect.stringMatching(/^acquire\(\) takes a free key, .*: acquire\(\) of a locked key \(the stored fingerprint, not the caller's\)/),
    );
    expect(failed).toContainEqual(expect.stringMatching(/^keeps keys apart exactly/));
  });

  it('fails a store that shares the stored response with its callers, on the copy case only', async () => {
    const failed = await failures(idempotencyStoreContract(() => new SharedReferenceStore(), { advanceTime }));
    expect(failed).toEqual([
      expect.stringMatching(/^stores every payload as given, and returns an equal copy: payload #0/),
    ]);
  });

  it("fails a store whose extend() renews a completed record, cutting its ttl", async () => {
    const failed = await failures(idempotencyStoreContract(() => new ExtendsRecordsStore(), { advanceTime }));
    expect(failed).toEqual([
      expect.stringMatching(/^a completed record is final: .*: extend\(\) of a completed record/),
      expect.stringMatching(/^extend\(\) leaves a completed record's ttl alone: extend\(\) of a completed record/),
    ]);
  });

  it('takes an async store factory and an async clock, and awaits both', async () => {
    const shared = new InMemoryIdempotencyStore();
    let created = 0;
    const cases = idempotencyStoreContract(
      async () => {
        created++;
        await Promise.resolve();
        return shared;
      },
      { advanceTime: async (ms) => advanceTime(ms), concurrent: { callers: 3 } },
    );

    expect(await failures(cases)).toEqual([]);
    expect(created).toBe(cases.length);
    expect(cases.map((c) => c.name)).toContain('concurrency: 3 callers on 2 keys at once: one winner per key');
  });

  it('refuses a concurrency setting that is not a whole number of callers', () => {
    const fresh = () => new InMemoryIdempotencyStore();
    expect(() => idempotencyStoreContract(fresh, { concurrent: { callers: 2.5 } })).toThrow(RangeError);
    expect(idempotencyStoreContract(fresh, { concurrent: false })).toHaveLength(13);
    expect(idempotencyStoreContract(fresh, { concurrent: {} })).toHaveLength(19);
  });
});
