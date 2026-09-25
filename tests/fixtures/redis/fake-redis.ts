import type { RedisClient } from '../idempotency/redis-idempotency.store.js';

/**
 * In-process stand-in for Redis, for the four Lua scripts that
 * `RedisIdempotencyStore` sends with EVAL. There is no Redis server in this
 * workspace, so each script is transliterated line by line to JavaScript
 * over a tiny implementation of the Redis commands it calls (hashes with
 * millisecond expiry). A script runs synchronously, so like a Lua script in
 * Redis it is atomic with respect to every other call. Like Redis, it is not
 * a transaction: a command that fails (PEXPIRE with a fraction) aborts the
 * script and keeps the writes made before it.
 *
 * The Lua source is kept here verbatim and compared with what the store
 * sends: if the store's scripts change, `eval` throws "unknown script" until
 * the transliteration below is updated to match.
 */

type Reply = number | string | null | Reply[];
type Script = (keys: string[], argv: string[]) => Reply;

const LUA = {
  acquire: `
if redis.call('EXISTS', KEYS[1]) == 0 then
  redis.call('HSET', KEYS[1], 'state', 'in-flight', 'fp', ARGV[1], 'owner', ARGV[2])
  redis.call('PEXPIRE', KEYS[1], ARGV[3])
  return {1}
end
local r = redis.call('HMGET', KEYS[1], 'state', 'fp', 'resp')
return {0, r[1], r[2], r[3]}
`,
  complete: `
if redis.call('HGET', KEYS[1], 'owner') ~= ARGV[1] then return 0 end
redis.call('HSET', KEYS[1], 'state', 'completed', 'resp', ARGV[2])
redis.call('HDEL', KEYS[1], 'owner')
redis.call('PEXPIRE', KEYS[1], ARGV[3])
return 1
`,
  release: `
if redis.call('HGET', KEYS[1], 'owner') == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`,
  extend: `
if redis.call('HGET', KEYS[1], 'owner') ~= ARGV[1] then return 0 end
redis.call('PEXPIRE', KEYS[1], ARGV[2])
return 1
`,
};

const normalize = (script: string) => script.replace(/\s+/g, ' ').trim();

interface Entry {
  hash: Map<string, string>;
  /** Epoch ms on the fake clock; undefined = no expiry. */
  expiresAt?: number;
}

export class FakeRedis implements RedisClient {
  private readonly data = new Map<string, Entry>();
  private offset = 0;
  /** Every EVAL, by script name, for assertions. */
  readonly calls: { script: keyof typeof LUA; key: string }[] = [];

  private readonly scripts = new Map<string, [keyof typeof LUA, Script]>([
    [normalize(LUA.acquire), ['acquire', (KEYS, ARGV) => {
      if (this.exists(KEYS[0]) === 0) {
        this.hset(KEYS[0], 'state', 'in-flight', 'fp', ARGV[0], 'owner', ARGV[1]);
        this.pexpire(KEYS[0], ARGV[2]);
        return [1];
      }
      const r = this.hmget(KEYS[0], 'state', 'fp', 'resp');
      return [0, r[0], r[1], r[2]];
    }]],
    [normalize(LUA.complete), ['complete', (KEYS, ARGV) => {
      if (this.hget(KEYS[0], 'owner') !== ARGV[0]) return 0;
      this.hset(KEYS[0], 'state', 'completed', 'resp', ARGV[1]);
      this.hdel(KEYS[0], 'owner');
      this.pexpire(KEYS[0], ARGV[2]);
      return 1;
    }]],
    [normalize(LUA.release), ['release', (KEYS, ARGV) => {
      if (this.hget(KEYS[0], 'owner') === ARGV[0]) {
        return this.del(KEYS[0]);
      }
      return 0;
    }]],
    [normalize(LUA.extend), ['extend', (KEYS, ARGV) => {
      if (this.hget(KEYS[0], 'owner') !== ARGV[0]) return 0;
      this.pexpire(KEYS[0], ARGV[1]);
      return 1;
    }]],
  ]);

  async eval(script: string, numKeys: number, ...args: (string | number)[]) {
    const entry = this.scripts.get(normalize(script));
    if (!entry) throw new Error(`FakeRedis: unknown script\n${script}`);
    const [name, run] = entry;
    // Redis hands every key and argument to Lua as a string.
    const strings = args.map(String);
    const keys = strings.slice(0, numKeys);
    this.calls.push({ script: name, key: keys[0] });
    return run(keys, strings.slice(numKeys));
  }

  /** Moves the fake clock forward, to expire locks and records. */
  advance(ms: number) {
    this.offset += ms;
  }

  /** The raw hash stored at `key` (for assertions), or undefined. */
  hgetall(key: string): Record<string, string> | undefined {
    const entry = this.live(key);
    return entry && Object.fromEntries(entry.hash);
  }

  keys(): string[] {
    return [...this.data.keys()].filter((key) => this.live(key));
  }

  /** Overwrites a hash, keeping its TTL (to simulate someone writing to Redis). */
  put(key: string, fields: Record<string, string>) {
    const entry = this.live(key);
    this.data.set(key, { hash: new Map(Object.entries(fields)), expiresAt: entry?.expiresAt });
  }

  /** Remaining time to live in ms, like PTTL: -2 = no key, -1 = no expiry. */
  ttlOf(key: string): number {
    return this.pttl(key);
  }

  // --- the Redis commands the scripts use -------------------------------

  private now() {
    return Date.now() + this.offset;
  }

  private live(key: string): Entry | undefined {
    const entry = this.data.get(key);
    if (entry?.expiresAt !== undefined && entry.expiresAt <= this.now()) {
      this.data.delete(key);
      return undefined;
    }
    return entry;
  }

  private exists(key: string) {
    return this.live(key) ? 1 : 0;
  }

  private hset(key: string, ...fieldValues: string[]) {
    const entry = this.live(key) ?? { hash: new Map<string, string>() };
    this.data.set(key, entry);
    for (let i = 0; i < fieldValues.length; i += 2) {
      entry.hash.set(fieldValues[i], fieldValues[i + 1]);
    }
  }

  private hget(key: string, field: string): string | null {
    return this.live(key)?.hash.get(field) ?? null;
  }

  private hmget(key: string, ...fields: string[]): (string | null)[] {
    return fields.map((field) => this.hget(key, field));
  }

  private hdel(key: string, field: string) {
    this.live(key)?.hash.delete(field);
  }

  private pexpire(key: string, ms: string) {
    if (!/^-?\d+$/.test(ms)) {
      throw new Error('ERR value is not an integer or out of range'); // what Redis replies
    }
    const entry = this.live(key);
    if (entry) entry.expiresAt = this.now() + Number(ms);
  }

  private pttl(key: string): number {
    const entry = this.live(key);
    if (!entry) return -2;
    if (entry.expiresAt === undefined) return -1;
    return entry.expiresAt - this.now();
  }

  private del(key: string) {
    const existed = this.live(key) !== undefined;
    this.data.delete(key);
    return existed ? 1 : 0;
  }
}
