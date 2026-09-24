import { createHash } from 'node:crypto';

/**
 * A deterministic text form of a payload, only ever hashed. It is JSON, with
 * object keys sorted at every level (array order still counts), and like
 * JSON it applies `toJSON()` (Dates become ISO strings) and drops
 * `undefined`, functions and symbols. Where `JSON.stringify` would throw or
 * lose information, it has its own tokens, so no payload makes a request
 * fail and different payloads don't collide:
 * - BigInts (a GraphQL BigInt scalar) as `123n`;
 * - binary data (Buffer, typed arrays, ArrayBuffer) as the SHA-256 of its bytes;
 * - Maps and Sets by their contents (a Set's order doesn't count);
 * - streams and promises, which have no content to compare, as fixed tokens;
 * - a reference back to an enclosing object as a cycle token.
 */
export function canonicalJson(value: unknown): string {
  return write(value, new Set()) ?? '';
}

/** `undefined` for what JSON leaves out of an object (and writes as `null` in an array). */
function write(value: unknown, ancestors: Set<object>): string | undefined {
  if (isObject(value) && !isBinary(value) && typeof value.toJSON === 'function') {
    value = value.toJSON();
  }

  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'number':
      return Number.isFinite(value) ? String(value) : 'null';
    case 'boolean':
      return String(value);
    case 'bigint':
      return `${value}n`;
    case 'undefined':
    case 'function':
    case 'symbol':
      return undefined;
  }

  if (value === null) {
    return 'null';
  }

  const object = value as Record<string, unknown>;
  if (isBinary(object)) {
    return `<bytes ${digest(object)}>`;
  }
  if (typeof object.pipe === 'function') {
    return '<stream>';
  }
  if (typeof object.then === 'function') {
    return '<promise>';
  }
  if (ancestors.has(object)) {
    return '<cycle>';
  }

  ancestors.add(object);
  try {
    if (Array.isArray(object)) {
      return `[${object.map((item) => write(item, ancestors) ?? 'null').join(',')}]`;
    }
    if (object instanceof Map) {
      const entries = [...object].map(
        ([k, v]) => `[${write(k, ancestors) ?? 'null'},${write(v, ancestors) ?? 'null'}]`,
      );
      return `<map [${entries.sort().join(',')}]>`;
    }
    if (object instanceof Set) {
      const items = [...object].map((item) => write(item, ancestors) ?? 'null');
      return `<set [${items.sort().join(',')}]>`;
    }

    const members: string[] = [];
    for (const key of Object.keys(object).sort()) {
      const member = write(object[key], ancestors);
      if (member !== undefined) {
        members.push(`${JSON.stringify(key)}:${member}`);
      }
    }

    return `{${members.join(',')}}`;
  } finally {
    ancestors.delete(object);
  }
}

function isObject(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null;
}

function isBinary(value: object): value is ArrayBuffer | ArrayBufferView {
  return ArrayBuffer.isView(value) || value instanceof ArrayBuffer;
}

function digest(value: ArrayBuffer | ArrayBufferView): string {
  const bytes = ArrayBuffer.isView(value)
    ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    : new Uint8Array(value);
  return createHash('sha256').update(bytes).digest('base64url');
}

/** SHA-256 over the parts, each prefixed with its byte length, so parts can't run into each other. */
export function sha256(...parts: string[]): string {
  const hash = createHash('sha256');
  for (const part of parts) {
    hash.update(`${Buffer.byteLength(part)}:`).update(part);
  }
  return hash.digest('hex');
}
