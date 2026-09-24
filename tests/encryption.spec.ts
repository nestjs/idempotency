import { Body, Controller, Logger, Module, Post, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { adapters, createApp } from './support/adapters.js';
import { registered } from './register.js';
import { ResponseCipher, plaintextCodec } from '../lib/utils/encryption.util.js';
import { UnreadableRecordError } from '../lib/errors/unreadable-record.error.js';
import type { IdempotencyEncryptionOptions } from '../lib/interfaces/idempotency-module-options.interface.js';
import {
  Idempotent,
  IdempotencyModule,
  InMemoryIdempotencyStore,
  type IdempotencyStore,
  type IdempotencyAcquireResult,
  type IdempotencySealedResponse,
  type IdempotencyStoredPayload,
  type IdempotencyStoredResponse,
} from '../lib/index.js';

const response: IdempotencyStoredResponse = {
  status: 201,
  headers: { location: '/cards/4242' },
  body: { pan: '4242 4242 4242 4242' },
};

const SECRET = 'a-high-entropy-secret-of-32-chars+';
const OTHER_SECRET = 'another-high-entropy-secret-32-chars';

/**
 * Flips the first ciphertext character. (Not the last character of a
 * segment: its low bits are base64 padding and may decode to the same bytes.)
 */
function tamper(sealed: string) {
  const parts = sealed.split('.');
  parts[3] = (parts[3][0] === 'A' ? 'B' : 'A') + parts[3].slice(1);
  return parts.join('.');
}

describe('ResponseCipher', () => {
  it('seals to an opaque envelope and opens it again', () => {
    const cipher = new ResponseCipher({ keys: [SECRET] });
    const sealed = cipher.seal('scope:k1', response) as IdempotencySealedResponse;
    expect(sealed.sealed).toMatch(/^v1\.[\w-]{8}\.[\w-]+\.[\w-]+\.[\w-]+$/);
    expect(sealed.sealed).not.toContain('4242');
    expect(cipher.open('scope:k1', sealed)).toEqual(response);
  });

  it('uses a fresh IV per record', () => {
    const cipher = new ResponseCipher({ keys: [randomBytes(32)] });
    const a = cipher.seal('k', response) as IdempotencySealedResponse;
    const b = cipher.seal('k', response) as IdempotencySealedResponse;
    expect(a.sealed).not.toBe(b.sealed);
  });

  it('binds the record to its store key (AAD)', () => {
    const cipher = new ResponseCipher({ keys: [SECRET] });
    const sealed = cipher.seal('alice:k1', response);
    expect(() => cipher.open('bob:k1', sealed)).toThrow(UnreadableRecordError);
  });

  it('rotates: seals with the first key, opens with any listed key', () => {
    const oldKey = randomBytes(32);
    const newKey = randomBytes(32);
    const before = new ResponseCipher({ keys: [oldKey] });
    const after = new ResponseCipher({ keys: [newKey, oldKey] });
    const legacy = before.seal('k', response);
    expect(after.open('k', legacy)).toEqual(response);

    const fresh = after.seal('k', response) as IdempotencySealedResponse;
    expect(fresh.sealed.split('.')[1]).not.toBe(
      (legacy as IdempotencySealedResponse).sealed.split('.')[1],
    );
    expect(() => before.open('k', fresh)).toThrow(/unknown key id/);
  });

  it('rejects tampered, malformed and plaintext records', () => {
    const cipher = new ResponseCipher({ keys: [SECRET] });
    const sealed = cipher.seal('k', response) as IdempotencySealedResponse;

    expect(() => cipher.open('k', { sealed: tamper(sealed.sealed) })).toThrow(
      /authentication failed/,
    );
    expect(() => cipher.open('k', { sealed: 'v1.nope' })).toThrow(/malformed/);
    expect(() => cipher.open('k', response)).toThrow(/not sealed/);
  });

  it('rejects weak keys, naming the option', () => {
    expect(() => new ResponseCipher({ keys: [randomBytes(16)] })).toThrow(
      /`encryption.keys\[0\]` is a Buffer of 16 bytes; it must be 32 bytes/,
    );
    expect(() => new ResponseCipher({ keys: [SECRET, 'hunter2'] })).toThrow(
      /`encryption.keys\[1\]` must be 32 random bytes, or a random string of at least 32 characters/,
    );
    expect(() => new ResponseCipher({ keys: [] })).toThrow(
      /`encryption.keys` must list at least one key/,
    );
  });

  it('rejects a string key with surrounding whitespace, as `split(\',\')` leaves after a space', () => {
    // "new, old": the second key would be " old", a different key, and every
    // record sealed with "old" would fail to open after the rotation.
    expect(() => new ResponseCipher({ keys: [SECRET, ` ${OTHER_SECRET}`] })).toThrow(
      /`encryption.keys\[1\]` starts or ends with whitespace/,
    );
  });

  it('fails at startup, not at the first request, when a key is weak', async () => {
    @Module({ imports: [IdempotencyModule.forRoot({ encryption: { keys: ['changeme'] } })] })
    class WeakKeyModule {}

    await expect(Test.createTestingModule({ imports: [WeakKeyModule] }).compile()).rejects.toThrow(
      /IdempotencyModule: `encryption.keys\[0\]`/,
    );
  });
});

/** Delegating store that records writes and can corrupt what it reads back. */
class SpyStore implements IdempotencyStore {
  readonly inner = new InMemoryIdempotencyStore();
  readonly written: IdempotencyStoredPayload[] = [];
  tamper = false;

  async acquire(key: string, owner: string, fingerprint: string, lockTtl: number) {
    const r: IdempotencyAcquireResult = await this.inner.acquire(key, owner, fingerprint, lockTtl);
    if (this.tamper && r.state === 'completed' && 'sealed' in r.response) {
      return { ...r, response: { sealed: tamper(r.response.sealed) } };
    }
    return r;
  }
  complete(key: string, owner: string, response: IdempotencyStoredPayload, ttl: number) {
    this.written.push(response);
    return this.inner.complete(key, owner, response, ttl);
  }
  release(key: string, owner: string) {
    return this.inner.release(key, owner);
  }
  extend(key: string, owner: string, lockTtl: number) {
    return this.inner.extend(key, owner, lockTtl);
  }
}

let calls = 0;

@Controller('cards')
class CardsController {
  @Post()
  @Idempotent()
  create(@Body() body: { pan: string }) {
    calls++;
    return { id: `card_${calls}`, pan: body.pan };
  }
}

function appModule(store: IdempotencyStore, encryption: IdempotencyEncryptionOptions) {
  @Module({
    imports: [IdempotencyModule.forRoot({ encryption })],
    providers: [registered(store)],
    controllers: [CardsController],
  })
  class EncryptedAppModule {}
  return EncryptedAppModule;
}

describe.each(adapters.map((a) => a.name))('encrypted records (%s)', (adapter) => {
  const apps: INestApplication[] = [];
  const boot = async (store: IdempotencyStore, encryption: IdempotencyEncryptionOptions) => {
    const app = await createApp(adapter, appModule(store, encryption), {
      setup: (a) => a.useLogger(false),
    });
    apps.push(app);
    return app.getHttpServer();
  };
  const post = (server: any, key: string) =>
    request(server)
      .post('/cards')
      .set('Idempotency-Key', key)
      .send({ pan: '4111 1111 1111 1111' });

  beforeEach(() => {
    calls = 0;
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(apps.splice(0).map((a) => a.close()));
  });

  it('stores ciphertext only and replays transparently', async () => {
    const store = new SpyStore();
    const server = await boot(store, { keys: [SECRET] });

    const first = await post(server, 'k1');
    const retry = await post(server, 'k1');
    expect(retry.body).toEqual(first.body);
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(calls).toBe(1);

    expect(store.written).toHaveLength(1);
    const raw = JSON.stringify(store.written[0]);
    expect(raw).not.toContain('4111');
    expect(raw).not.toContain('card_1');
    expect(Object.keys(store.written[0])).toEqual(['sealed']);
  });

  it('replays records sealed with a rotated-out key', async () => {
    const store = new SpyStore();
    const oldKey = randomBytes(32);
    await post(await boot(store, { keys: [oldKey] }), 'k1');

    const rotated = await boot(store, { keys: [randomBytes(32), oldKey] });
    const retry = await post(rotated, 'k1');

    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(retry.body.id).toBe('card_1');
    expect(calls).toBe(1);
  });

  it('fails closed (500, logged) on a tampered record instead of re-executing', async () => {
    const errors = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    const store = new SpyStore();
    const server = await boot(store, { keys: [OTHER_SECRET] });
    await post(server, 'k1');
    store.tamper = true;

    const res = await post(server, 'k1');
    expect(res.status).toBe(500);
    expect(res.body.code).toBe('IDEMPOTENCY_RECORD_UNREADABLE');
    expect(calls).toBe(1);
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('authentication failed'));
  });
});

describe('ResponseCipher envelopes', () => {
  it('derives the same key from the same secret, so every instance opens what another sealed', () => {
    const sealed = new ResponseCipher({ keys: [SECRET] }).seal('k', response);
    expect(new ResponseCipher({ keys: [SECRET] }).open('k', sealed)).toEqual(response);
    expect(() => new ResponseCipher({ keys: [OTHER_SECRET] }).open('k', sealed)).toThrow(/unknown key id/);
  });

  it('rejects an envelope of another version, with extra segments, or a seal that is not a string', () => {
    const cipher = new ResponseCipher({ keys: [SECRET] });
    const { sealed } = cipher.seal('k', response) as IdempotencySealedResponse;

    expect(() => cipher.open('k', { sealed: sealed.replace(/^v1/, 'v2') })).toThrow(/malformed envelope/);
    expect(() => cipher.open('k', { sealed: `${sealed}.extra` })).toThrow(/malformed envelope/);
    expect(() => cipher.open('k', { sealed: 42 } as never)).toThrow(/record is not sealed/);
    expect(() => cipher.open('k', { sealed: sealed.replace(/[^.]+$/, '') })).toThrow(/malformed envelope/);
  });

  it('names the error UnreadableRecordError, with the reason in its message', () => {
    let error: Error | undefined;
    try {
      new ResponseCipher({ keys: [SECRET] }).open('k', { sealed: 'v1.nope' });
    } catch (err) {
      error = err as Error;
    }

    expect(error).toBeInstanceOf(UnreadableRecordError);
    expect(error?.name).toBe('UnreadableRecordError');
    expect(error?.message).toBe('Idempotency record could not be opened: malformed envelope');
  });
});

describe('without encryption', () => {
  it('passes plaintext records through, and refuses a sealed one', () => {
    expect(plaintextCodec.seal('k', response)).toBe(response);
    expect(plaintextCodec.open('k', response)).toBe(response);
    expect(() => plaintextCodec.open('k', { sealed: 'v1.a.b.c.d' })).toThrow(
      'Idempotency record could not be opened: record is sealed but encryption is not configured',
    );
  });
});
