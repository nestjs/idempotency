import { StreamableFile } from '@nestjs/common';
import { UnreplayableResult } from '../errors/unreplayable-result.error.js';

/**
 * How a handler's result is kept in a record, so that a replay hands the
 * platform (the HTTP adapter, GraphQL's field resolution, a transport's
 * serializer) the same kind of value the handler returned. A GraphQL
 * `DateTime` field, for one, only serializes `Date` instances, and a string
 * in its place turns the replay into an error.
 *
 * The encoded form is JSON-safe, so any store can persist it. Values JSON
 * can't carry are tagged, as in
 * `{ "__idempotencyType": "Date", "value": "2026-09-22T10:00:00.000Z" }`:
 * Dates, BigInts, Buffers and Uint8Arrays, Maps and Sets. Everything else
 * follows `JSON.stringify`: `toJSON()` is applied, a class instance keeps
 * its own enumerable properties (not its prototype's getters and methods),
 * and `undefined`, functions and symbols are left out of objects.
 */
const TYPE = '__idempotencyType';

/** Why a result, as returned, can't be stored and replayed; `undefined` if it can. */
export function unreplayableReason(value: unknown): string | undefined {
  if (value instanceof StreamableFile) {
    return 'it returned a StreamableFile';
  }
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  if (typeof (value as { pipe?: unknown }).pipe === 'function') {
    return 'it returned a stream';
  }
  if (typeof (value as AsyncIterable<unknown>)[Symbol.asyncIterator] === 'function') {
    return 'it returned an async iterable';
  }
  return undefined;
}

/**
 * `strict` is for GraphQL, which awaits promises and calls functions it
 * finds in a result: a copy without them would replay something else, so
 * they make the result unreplayable instead of being left out.
 */
export function encodeResult(value: unknown, { strict = false } = {}): unknown {
  const encoded = encode(value, strict, new Set());
  return encoded === OMIT ? undefined : encoded;
}

const OMIT = Symbol('omit');

function encode(value: unknown, strict: boolean, ancestors: Set<object>): unknown {
  if (value instanceof Date) {
    return { [TYPE]: 'Date', value: Number.isNaN(value.getTime()) ? null : value.toISOString() };
  }
  if (value instanceof Uint8Array) {
    const bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    return { [TYPE]: 'Bytes', value: bytes.toString('base64') };
  }
  if (isObject(value) && typeof value.toJSON === 'function') {
    value = value.toJSON();
  }

  switch (typeof value) {
    case 'bigint':
      return { [TYPE]: 'BigInt', value: value.toString() };
    case 'number':
      return Number.isFinite(value) ? value : null;
    case 'string':
    case 'boolean':
      return value;
    case 'function':
      if (strict) {
        throw new UnreplayableResult('its result holds a function, which GraphQL calls');
      }
      return OMIT;
    case 'undefined':
    case 'symbol':
      return OMIT;
  }

  if (value === null) {
    return null;
  }

  const object = value as Record<string, unknown>;
  if (strict && (typeof object.then === 'function' || unreplayableReason(object))) {
    throw new UnreplayableResult('its result holds a promise or a stream, which GraphQL awaits');
  }
  if (ancestors.has(object)) {
    throw new UnreplayableResult('its result has a circular reference');
  }

  ancestors.add(object);
  try {
    const item = (entry: unknown) => {
      const encoded = encode(entry, strict, ancestors);
      return encoded === OMIT ? null : encoded;
    };

    if (Array.isArray(object)) {
      return object.map(item);
    }
    if (object instanceof Map) {
      return { [TYPE]: 'Map', value: [...object].map(([k, v]) => [item(k), item(v)]) };
    }
    if (object instanceof Set) {
      return { [TYPE]: 'Set', value: [...object].map(item) };
    }

    const members: Record<string, unknown> = {};
    for (const key of Object.keys(object)) {
      const encoded = encode(object[key], strict, ancestors);
      if (encoded !== OMIT) {
        assign(members, key, encoded);
      }
    }

    // An object that happens to use the tag key is wrapped, so it can't pass for a tagged value.
    return TYPE in members ? { [TYPE]: 'Object', value: members } : members;
  } finally {
    ancestors.delete(object);
  }
}

/** The inverse of `encodeResult()`. */
export function decodeResult(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(decodeResult);
  }
  if (!isObject(value)) {
    return value;
  }

  const tagged = value as { [TYPE]?: unknown; value?: any };
  switch (tagged[TYPE]) {
    case 'Date':
      return new Date(tagged.value ?? Number.NaN);
    case 'BigInt':
      return BigInt(tagged.value);
    case 'Bytes':
      return Buffer.from(tagged.value, 'base64');
    case 'Map':
      return new Map(tagged.value.map(([k, v]: [unknown, unknown]) => [decodeResult(k), decodeResult(v)]));
    case 'Set':
      return new Set(tagged.value.map(decodeResult));
    case 'Object':
      return decodeMembers(tagged.value);
    default:
      return decodeMembers(value);
  }
}

function decodeMembers(value: Record<string, unknown>) {
  const members: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    assign(members, key, decodeResult(value[key]));
  }
  return members;
}

/** Plain assignment, except that an own `__proto__` key stays a key instead of setting the prototype. */
function assign(target: Record<string, unknown>, key: string, value: unknown) {
  if (key === '__proto__') {
    Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
  } else {
    target[key] = value;
  }
}

function isObject(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null;
}
