import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
import type {
  IdempotencySealedResponse,
  IdempotencyStoredPayload,
  IdempotencyStoredResponse,
} from '../interfaces/idempotency-store.interface.js';
import type { IdempotencyEncryptionOptions } from '../interfaces/idempotency-module-options.interface.js';
import { UnreadableRecordError } from '../errors/unreadable-record.error.js';

const VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // 96-bit IV, the GCM recommendation
const HKDF_INFO = 'nestjs-idempotency:v1';
const MIN_SECRET_LENGTH = 32;

interface DerivedKey {
  id: string;
  key: Buffer;
}

function deriveKey(material: Buffer | string, index: number): DerivedKey {
  const option = `encryption.keys[${index}]`;
  let key: Buffer;
  if (Buffer.isBuffer(material)) {
    if (material.length !== 32) {
      throw new TypeError(
        `IdempotencyModule: \`${option}\` is a Buffer of ${material.length} bytes; it must be 32 bytes.`,
      );
    }
    key = material;
  } else if (typeof material === 'string' && material.trim() !== material) {
    // `'new, old'.split(',')` gives ' old': a different key, and every record
    // sealed with 'old' would fail to open.
    throw new TypeError(
      `IdempotencyModule: \`${option}\` starts or ends with whitespace, so it isn't the key ` +
        `you meant. Trim the keys, for example \`split(',').map((key) => key.trim())\`.`,
    );
  } else if (typeof material === 'string' && material.length >= MIN_SECRET_LENGTH) {
    key = Buffer.from(hkdfSync('sha256', material, Buffer.alloc(0), HKDF_INFO, 32));
  } else {
    throw new TypeError(
      `IdempotencyModule: \`${option}\` must be 32 random bytes, or a random string of at least ` +
        `${MIN_SECRET_LENGTH} characters (for example \`openssl rand -base64 32\`), not a password.`,
    );
  }

  // The key id only lets rotation pick the right key; it reveals nothing
  // useful about the key (truncated hash of it).
  const id = createHash('sha256').update(key).digest('base64url').slice(0, 8);
  return { id, key };
}

/**
 * Seals `IdempotencyStoredResponse`s with AES-256-GCM. The store key is bound
 * in as additional authenticated data, so a record copied to another key
 * (another user's scope, say) fails authentication instead of replaying there.
 */
export class ResponseCipher {
  private readonly keys: DerivedKey[];

  constructor(options: IdempotencyEncryptionOptions) {
    const list: unknown = options?.keys;
    if (!Array.isArray(list) || list.length === 0) {
      throw new TypeError(
        'IdempotencyModule: `encryption.keys` must list at least one key (newest first).',
      );
    }
    this.keys = list.map(deriveKey);
  }

  seal(storeKey: string, response: IdempotencyStoredResponse): IdempotencySealedResponse {
    const { id, key } = this.keys[0];
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, key, iv);
    cipher.setAAD(Buffer.from(storeKey, 'utf8'));

    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(response), 'utf8'),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();

    return {
      sealed: [VERSION, id, iv, ciphertext, tag]
        .map((p) => (typeof p === 'string' ? p : p.toString('base64url')))
        .join('.'),
    };
  }

  open(storeKey: string, payload: IdempotencyStoredPayload): IdempotencyStoredResponse {
    if (!('sealed' in payload) || typeof payload.sealed !== 'string') {
      // Accepting plaintext would let anyone with store write access plant
      // arbitrary responses, defeating the authentication.
      throw new UnreadableRecordError('record is not sealed');
    }

    const [version, id, iv, ciphertext, tag, ...rest] = payload.sealed.split('.');
    if (version !== VERSION || rest.length || !tag) {
      throw new UnreadableRecordError('malformed envelope');
    }

    const entry = this.keys.find((k) => k.id === id);
    if (!entry) {
      throw new UnreadableRecordError(`unknown key id "${id}"`);
    }

    try {
      const decipher = createDecipheriv(
        ALGORITHM,
        entry.key,
        Buffer.from(iv, 'base64url'),
      );
      decipher.setAAD(Buffer.from(storeKey, 'utf8'));
      decipher.setAuthTag(Buffer.from(tag, 'base64url'));

      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(ciphertext, 'base64url')),
        decipher.final(),
      ]);

      return JSON.parse(plaintext.toString('utf8'));
    } catch {
      throw new UnreadableRecordError('authentication failed');
    }
  }
}

/** Pass-through used when encryption is off. Rejects sealed records. */
export const plaintextCodec = {
  seal: (_key: string, response: IdempotencyStoredResponse): IdempotencyStoredPayload => response,
  open(_key: string, payload: IdempotencyStoredPayload): IdempotencyStoredResponse {
    if ('sealed' in payload) {
      throw new UnreadableRecordError('record is sealed but encryption is not configured');
    }
    return payload;
  },
};

export type ResponseCodec = Pick<ResponseCipher, 'open'> & {
  seal(storeKey: string, response: IdempotencyStoredResponse): IdempotencyStoredPayload;
};
