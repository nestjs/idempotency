import { InMemoryIdempotencyStore } from '../lib/index.js';
import { idempotencyStoreContract } from '../lib/testing/index.js';

const response = { status: 201, headers: {}, body: { id: 1 } };

describe('InMemoryIdempotencyStore', () => {
  describe('the IdempotencyStore contract', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-09-22T12:00:00.000Z'));
    });
    afterEach(() => vi.useRealTimers());

    const cases = idempotencyStoreContract(() => new InMemoryIdempotencyStore(), {
      advanceTime: (ms) => vi.setSystemTime(Date.now() + ms),
      concurrent: true,
    });
    for (const c of cases) {
      it(c.name, c.run);
    }
  });

  it('keeps the completed record for ttl (peek)', async () => {
    const store = new InMemoryIdempotencyStore();
    await store.acquire('k', 'a', 'fp', 1_000);
    await store.complete('k', 'a', response, 60_000);

    expect(store.peek('k')?.expiresAt).toBeGreaterThan(Date.now() + 59_000);
    expect(store.peek('k')).toMatchObject({ state: 'completed', fingerprint: 'fp', response });
    expect(store.size).toBe(1);

    store.clear();
    expect(store.size).toBe(0);
  });
});

describe('InMemoryIdempotencyStore expiry', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-24T12:00:00.000Z'));
  });
  afterEach(() => vi.useRealTimers());

  const advance = (ms: number) => vi.setSystemTime(Date.now() + ms);

  it('keeps a lock until exactly lockTtl, and a record until exactly ttl', async () => {
    const store = new InMemoryIdempotencyStore();
    await store.acquire('k', 'a', 'fp', 100);

    advance(99);
    expect(await store.acquire('k', 'b', 'fp', 100)).toEqual({ state: 'in-flight', fingerprint: 'fp' });
    advance(1);
    expect(await store.acquire('k', 'b', 'fp', 100)).toEqual({ state: 'acquired' });

    await store.complete('k', 'b', response, 1_000);
    advance(999);
    expect((await store.acquire('k', 'c', 'fp', 100)).state).toBe('completed');
    advance(1);
    expect(await store.acquire('k', 'c', 'fp', 100)).toEqual({ state: 'acquired' });
  });

  it('counts and peeks live records only', async () => {
    const store = new InMemoryIdempotencyStore();
    await store.acquire('short', 'a', 'fp', 10);
    await store.acquire('long', 'a', 'fp', 1_000);

    expect(store.size).toBe(2);
    advance(10);
    expect(store.peek('short')).toBeUndefined();
    expect(store.peek('long')).toMatchObject({ state: 'in-flight', owner: 'a', fingerprint: 'fp' });
    expect(store.size).toBe(1);
  });

  it('sweeps expired records of keys nobody asks for again, every thousand acquires', async () => {
    const store = new InMemoryIdempotencyStore();
    const entries = (store as unknown as { entries: Map<string, unknown> }).entries;
    for (let i = 0; i < 10; i++) {
      await store.acquire(`abandoned-${i}`, 'a', 'fp', 10);
    }
    advance(10);

    for (let i = 10; i < 999; i++) {
      await store.acquire(`live-${i}`, 'a', 'fp', 60_000);
    }
    expect(entries.has('abandoned-0')).toBe(true);

    await store.acquire('live-999', 'a', 'fp', 60_000);
    expect([...entries.keys()].some((key) => key.startsWith('abandoned-'))).toBe(false);
    expect(entries.size).toBe(990);
  });
});
