/**
 * What gets persisted for a completed request and replayed for every retry
 * carrying the same key. Everything in it is JSON-safe, so a network store
 * (Redis, Postgres) can serialize it with `JSON.stringify` as-is.
 */
export interface IdempotencyStoredResponse {
  /**
   * HTTP status (after `@HttpCode`, `@Redirect`, `res.status()`). For
   * GraphQL and RPC results it is the HTTP-equivalent status (200 on success).
   */
  status: number;
  /** Allowlisted response headers, lower-cased names. HTTP only. */
  headers: Record<string, string | string[]>;
  /**
   * The handler's result, or the error payload. JSON-safe: Dates, BigInts,
   * Buffers, Maps and Sets are tagged (`{ "__idempotencyType": "Date", ... }`)
   * so a replay restores them, and everything else is kept the way
   * `JSON.stringify` would keep it.
   */
  body: unknown;
  /**
   * Set when the stored outcome is an error to re-throw on replay, naming
   * which exception type to rebuild: `HttpException`, `RpcException` or
   * `GraphQLError`.
   */
  error?: 'http' | 'rpc' | 'graphql';
}

/**
 * An `IdempotencyStoredResponse` encrypted with `encryption.keys`
 * (AES-256-GCM). The format is `v1.<keyId>.<iv>.<ciphertext>.<tag>`
 * (base64url segments).
 */
export interface IdempotencySealedResponse {
  sealed: string;
}

/**
 * What a store persists: plaintext, or sealed when encryption is enabled.
 * Stores never look inside it.
 */
export type IdempotencyStoredPayload = IdempotencyStoredResponse | IdempotencySealedResponse;

/** What `IdempotencyStore#acquire()` found: nothing (the lock is now the caller's), a lock, or a record. */
export type IdempotencyAcquireResult =
  | { state: 'acquired' }
  | { state: 'in-flight'; fingerprint: string }
  | { state: 'completed'; fingerprint: string; response: IdempotencyStoredPayload };

/**
 * Where idempotency records live: the contract a store implements. The package
 * owns the rules (below); the store owns data access. Write it as an ordinary
 * provider that injects whatever it needs (a Drizzle database, a Redis client,
 * a TypeORM repository) and registers itself with `IdempotencyStorage` in its
 * constructor:
 *
 * ```ts
 * @Injectable()
 * export class RedisIdempotencyStore implements IdempotencyStore {
 *   constructor(@Inject(REDIS) private readonly redis: Redis, storage: IdempotencyStorage) {
 *     storage.registerSource(this);
 *   }
 * }
 * ```
 *
 * A record is either an in-flight **lock** (it has an `owner`, and expires
 * `lockTtl` ms after it was taken or last extended) or a **completed record**
 * (it has a response, no owner, and expires `ttl` ms after `complete()`). An
 * expired lock or record doesn't exist, for every method, whether or not it
 * has been deleted yet.
 *
 * `owner` is a per-attempt fencing token. While the handler runs, and until
 * its outcome is stored, the interceptor renews the lock with `extend()`
 * every `lockTtl / 3`, one call at a time, so a lock only expires when the
 * process holding it stops renewing it (crash, partition, blocked event loop).
 * A retry can then take the key over; when the original attempt finally
 * finishes, its `extend()`/`complete()`/`release()` with the stale token must
 * change nothing, instead of clobbering the new owner's record.
 *
 * Calls for different keys, and for the same key, arrive concurrently, from
 * one process or many. `acquire()` must let exactly one of any number of
 * concurrent callers win a free or expired key; the other three are a single
 * compare-and-set on `owner` (write only if `owner` still holds a live lock).
 *
 * Durations (`lockTtl`, `ttl`) are whole milliseconds, at least 1, and up to
 * weeks (`ttl: '30d'` is 2,592,000,000, past a 32-bit integer): a store can
 * hand them to Redis `PEXPIRE` or SQL `bigint` arithmetic as they are. Keys are
 * arbitrary strings (a scope, the client's key, a handler suffix: several
 * hundred characters, any Unicode), and must be kept apart exactly (`k` and
 * `K` are two keys). Test a store with the contract suite from
 * `@nestjs/idempotency/testing`.
 */
export interface IdempotencyStore {
  /**
   * Takes the lock on `key` for `owner`, expiring `lockTtl` ms from now, if
   * no live lock or record exists (none at all, or an expired one), and
   * resolves `{ state: 'acquired' }`. Otherwise it changes nothing and
   * resolves what it found: `{ state: 'in-flight', fingerprint }` for a live
   * lock, `{ state: 'completed', fingerprint, response }` for a completed
   * record, with the fingerprint that was stored with it (not the caller's).
   *
   * **Atomic.** Two concurrent calls for the same free (or expired) key must
   * never both resolve `acquired`: a read followed by a separate write lets
   * both requests run the handler, which is the double charge the package
   * exists to prevent. Use one atomic operation (a Lua script, `INSERT ... ON
   * CONFLICT`), and take over an expired lock or record with a write that
   * re-checks the expiry, so that of many concurrent retries only one takes
   * it. A caller that loses reads the winner's record.
   */
  acquire(key: string, owner: string, fingerprint: string, lockTtl: number): Promise<IdempotencyAcquireResult>;

  /**
   * Turns `owner`'s live lock into a completed record: stores `response`
   * (store it as given, and return an equal copy from `acquire()`: it is
   * JSON-safe, so `JSON.stringify` round-trips it), drops the owner, and sets
   * the record to expire `ttl` ms from now. Resolves `true` when it did, and
   * `false`, changing nothing, when `owner` doesn't hold a live lock on `key`
   * (no record, a lock taken over by another owner, an expired lock, an
   * already completed record).
   *
   * **A compare-and-set:** the owner check and the write are one operation
   * (`UPDATE ... WHERE owner = ? AND expires_at > ?`, a Lua script), or a
   * stale owner could overwrite the record of the retry that took over.
   */
  complete(key: string, owner: string, response: IdempotencyStoredPayload, ttl: number): Promise<boolean>;

  /**
   * Deletes `owner`'s live lock, so a retry can run the handler again (the
   * outcome wasn't final, or the call never ran). Resolves `true` when it did,
   * `false` (changing nothing) when `owner` doesn't hold a live lock on `key`.
   * A completed record is never released.
   *
   * **A compare-and-set**, like `complete()`: a stale owner must not delete
   * the lock or the record of the retry that took over.
   */
  release(key: string, owner: string): Promise<boolean>;

  /**
   * Heartbeat: sets `owner`'s live lock to expire `lockTtl` ms from now.
   * Resolves `true` when it did, `false` (changing nothing) when `owner`
   * doesn't hold a live lock on `key`: it expired (and may have been taken
   * over), or the record was completed, whose expiry stays `ttl`.
   *
   * **A compare-and-set**, like `complete()`: renewing a lock that was taken
   * over would keep the new owner's lock alive after the new owner crashed,
   * and renewing a completed record would cut its `ttl` down to `lockTtl`.
   */
  extend(key: string, owner: string, lockTtl: number): Promise<boolean>;
}
