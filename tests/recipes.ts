/**
 * The store recipes the docs document (copied into tests/fixtures), with the databases they
 * run on in tests.
 */
import { PGlite } from '@electric-sql/pglite';
import type { Type } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import { migrate as migratePg } from 'drizzle-orm/node-postgres/migrator';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { IdempotencyStore, IdempotencyStoredPayload } from '../lib/index.js';

export const migrationsFolder = fileURLToPath(new URL('./fixtures/drizzle', import.meta.url));

export interface DrizzleIdempotencyStoreClass extends Type<IdempotencyStore> {
  new (...args: any[]): IdempotencyStore & { prune(limit?: number): Promise<number> };
}

export interface RedisClient {
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
}

/** The in-process Redis (tests/fixtures/redis/fake-redis.ts): the store's four Lua scripts, transliterated, on a clock of its own. */
export interface FakeRedis extends RedisClient {
  advance(ms: number): void;
  hgetall(key: string): Record<string, string> | undefined;
  keys(): string[];
  put(key: string, fields: Record<string, string>): void;
  ttlOf(key: string): number;
}

export async function loadDrizzleRecipe(): Promise<{ DrizzleIdempotencyStore: DrizzleIdempotencyStoreClass }> {
  return import('./fixtures/idempotency/drizzle-idempotency.store.js');
}

export async function loadRedisRecipe(): Promise<{
  RedisIdempotencyStore: Type<IdempotencyStore>;
  REDIS: symbol;
  FakeRedis: new () => FakeRedis;
}> {
  const [store, module, fake] = await Promise.all([
    import('./fixtures/idempotency/redis-idempotency.store.js'),
    import('./fixtures/redis/redis.module.js'),
    import('./fixtures/redis/fake-redis.js'),
  ]);
  return { RedisIdempotencyStore: store.RedisIdempotencyStore, REDIS: module.REDIS, FakeRedis: fake.FakeRedis };
}

/** A row of `idempotency_keys`, as the migration creates it. */
export interface IdempotencyRow {
  key: string;
  fingerprint: string;
  owner: string | null;
  response: IdempotencyStoredPayload | null;
  expiresAt: number;
}

/** The `idempotency_keys` table on a migrated database, and the Drizzle database the store injects. */
export interface RecordsDatabase {
  /** What `@InjectDrizzle()` hands the store: register it under `getDrizzleToken()`. */
  db: unknown;
  rows(): Promise<IdempotencyRow[]>;
  row(key: string): Promise<IdempotencyRow | undefined>;
  /** The row's `response` column as stored, JSON text. */
  rawResponse(key: string): Promise<string | null>;
  /** Overwrites a row's response, as someone with write access to the table could. */
  setResponse(key: string, response: unknown): Promise<void>;
  /** Copies a row under another record key, as someone with write access to the table could. */
  copy(from: string, to: string): Promise<void>;
  clear(): Promise<void>;
  close(): Promise<void>;
}

/** An in-process PostgreSQL (PGlite) with the recipe's migration applied. */
export async function pgliteDatabase(): Promise<RecordsDatabase> {
  const pglite = new PGlite();
  const db = drizzlePglite(pglite);
  await migratePglite(db, { migrationsFolder });
  return records(db, () => pglite.close());
}

/** A migrated PostgreSQL database on a `pg` pool: one per app instance, as in production. */
export async function postgresDatabase(url: string, migrated = false): Promise<RecordsDatabase> {
  const pool = new pg.Pool({ connectionString: url, max: 8 });
  const db = drizzlePg(pool);
  if (!migrated) {
    await migratePg(db, { migrationsFolder });
  }
  return records(db, () => pool.end());
}

type Executor = { execute(query: ReturnType<typeof sql>): Promise<{ rows: Record<string, unknown>[] }> };

function records(db: unknown, close: () => Promise<void>): RecordsDatabase {
  const run = async (query: ReturnType<typeof sql>) => (await (db as Executor).execute(query)).rows;
  const toRow = (row: Record<string, unknown>): IdempotencyRow => ({
    key: row.key as string,
    fingerprint: row.fingerprint as string,
    owner: row.owner as string | null,
    response: (typeof row.response === 'string' ? JSON.parse(row.response) : row.response) as IdempotencyStoredPayload | null,
    // bigint: node-postgres hands it over as a string.
    expiresAt: Number(row.expires_at),
  });

  return {
    db,
    rows: async () => (await run(sql`SELECT * FROM idempotency_keys ORDER BY key`)).map(toRow),
    row: async (key) => {
      const [row] = await run(sql`SELECT * FROM idempotency_keys WHERE key = ${key}`);
      return row && toRow(row);
    },
    rawResponse: async (key) => {
      const [row] = await run(sql`SELECT response::text AS response FROM idempotency_keys WHERE key = ${key}`);
      return (row?.response as string | null | undefined) ?? null;
    },
    setResponse: async (key, response) => {
      await run(sql`UPDATE idempotency_keys SET response = ${JSON.stringify(response)}::json WHERE key = ${key}`);
    },
    copy: async (from, to) => {
      await run(sql`
        INSERT INTO idempotency_keys (key_hash, key, fingerprint, owner, response, expires_at)
        SELECT encode(sha256(convert_to(${to}, 'UTF8')), 'hex'), ${to}, fingerprint, owner, response, expires_at
          FROM idempotency_keys WHERE key = ${from}`);
    },
    clear: async () => {
      await run(sql`DELETE FROM idempotency_keys`);
    },
    close,
  };
}
