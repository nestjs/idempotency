import type {
  IdempotencyAcquireResult,
  IdempotencyStore,
  IdempotencyStoredPayload,
} from '../interfaces/idempotency-store.interface.js';

export type InMemoryEntry =
  | { state: 'in-flight'; fingerprint: string; owner: string; expiresAt: number }
  | {
      state: 'completed';
      fingerprint: string;
      response: IdempotencyStoredPayload;
      expiresAt: number;
    };

const SWEEP_EVERY = 1_000;

/**
 * Single-process store: the default when no store is registered, and the test
 * double. Every method runs its check-and-set synchronously (no `await`
 * between reading and writing the map), so two concurrent requests in the
 * same process can never both acquire a key. Responses are copied in and out
 * (`structuredClone`), so a caller can't change a stored record by mutating
 * what it passed in or got back.
 *
 * Not suitable for more than one instance: records aren't shared, and they
 * are lost on restart (see README). `peek()`, `size` and `clear()` are there
 * for tests.
 */
export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly entries = new Map<string, InMemoryEntry>();
  private operations = 0;

  async acquire(
    key: string,
    owner: string,
    fingerprint: string,
    lockTtl: number,
  ): Promise<IdempotencyAcquireResult> {
    this.maybeSweep();

    const existing = this.read(key);
    if (existing?.state === 'completed') {
      return {
        state: 'completed',
        fingerprint: existing.fingerprint,
        response: structuredClone(existing.response),
      };
    }
    if (existing?.state === 'in-flight') {
      return { state: 'in-flight', fingerprint: existing.fingerprint };
    }

    this.entries.set(key, {
      state: 'in-flight',
      fingerprint,
      owner,
      expiresAt: Date.now() + lockTtl,
    });

    return { state: 'acquired' };
  }

  async complete(
    key: string,
    owner: string,
    response: IdempotencyStoredPayload,
    ttl: number,
  ): Promise<boolean> {
    const existing = this.read(key);
    if (existing?.state !== 'in-flight' || existing.owner !== owner) {
      return false;
    }

    this.entries.set(key, {
      state: 'completed',
      fingerprint: existing.fingerprint,
      response: structuredClone(response),
      expiresAt: Date.now() + ttl,
    });
    return true;
  }

  async release(key: string, owner: string): Promise<boolean> {
    const existing = this.read(key);
    if (existing?.state !== 'in-flight' || existing.owner !== owner) {
      return false;
    }
    this.entries.delete(key);
    return true;
  }

  async extend(key: string, owner: string, lockTtl: number): Promise<boolean> {
    const existing = this.read(key);
    if (existing?.state !== 'in-flight' || existing.owner !== owner) {
      return false;
    }
    existing.expiresAt = Date.now() + lockTtl;
    return true;
  }

  /** Number of live (unexpired) records. */
  get size(): number {
    this.sweep();
    return this.entries.size;
  }

  /** The raw record stored under a store key (`<scope>:<key>`), for assertions. */
  peek(key: string): Readonly<InMemoryEntry> | undefined {
    return this.read(key);
  }

  clear(): void {
    this.entries.clear();
  }

  private read(key: string): InMemoryEntry | undefined {
    const entry = this.entries.get(key);
    if (entry && entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  private maybeSweep() {
    if (++this.operations % SWEEP_EVERY === 0) {
      this.sweep();
    }
  }

  private sweep() {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(key);
      }
    }
  }
}
