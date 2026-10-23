/**
 * How a handler's result is kept in a record: JSON-safe, with the values JSON can't carry
 * tagged, so that a replay hands the platform the same kind of value the handler returned.
 */
import { StreamableFile } from '@nestjs/common';
import { Readable } from 'node:stream';
import { UnreplayableResult } from '../lib/errors/unreplayable-result.error.js';
import { decodeResult, encodeResult, unreplayableReason } from '../lib/utils/result.util.js';

/** What a store does to a record: a JSON round trip. */
const throughStore = (value: unknown) => {
  const encoded = encodeResult(value);
  return decodeResult(encoded === undefined ? undefined : JSON.parse(JSON.stringify(encoded)));
};

describe('encodeResult() and decodeResult()', () => {
  it('restores Dates, BigInts, Buffers, Maps and Sets after a JSON round trip, however deeply nested', () => {
    const value = {
      paidAt: new Date('2026-09-22T10:00:00.000Z'),
      amount: 12345678901234567890n,
      receipt: Buffer.from('pdf-bytes'),
      lines: [new Map<unknown, unknown>([['sku', new Set([1, 2])], [3n, 'three']])],
    };

    const restored = throughStore(value) as typeof value;

    expect(restored.paidAt).toBeInstanceOf(Date);
    expect(restored.paidAt.toISOString()).toBe('2026-09-22T10:00:00.000Z');
    expect(restored.amount).toBe(12345678901234567890n);
    expect(Buffer.isBuffer(restored.receipt)).toBe(true);
    expect(restored.receipt.toString()).toBe('pdf-bytes');
    expect(restored.lines[0]).toEqual(new Map<unknown, unknown>([['sku', new Set([1, 2])], [3n, 'three']]));
  });

  it('keeps an invalid Date an invalid Date, instead of throwing on toISOString()', () => {
    const restored = throughStore({ at: new Date(Number.NaN) }) as { at: Date };
    expect(restored.at).toBeInstanceOf(Date);
    expect(Number.isNaN(restored.at.getTime())).toBe(true);
  });

  it('encodes a Uint8Array view by its own bytes, not the whole underlying buffer', () => {
    const backing = Buffer.from('xxHELLOxx');
    const view = new Uint8Array(backing.buffer, backing.byteOffset + 2, 5);
    expect((throughStore(view) as Buffer).toString()).toBe('HELLO');
  });

  it('follows JSON.stringify for everything else', () => {
    class Money {
      constructor(readonly amount: number) {}
      get formatted() {
        return `${this.amount} EUR`;
      }
    }

    expect(
      throughStore({
        missing: undefined,
        fn: () => 1,
        sym: Symbol('s'),
        list: [undefined, () => 1, 1],
        nan: Number.NaN,
        inf: Number.POSITIVE_INFINITY,
        id: { toJSON: () => 'ord_1' },
        money: new Money(10),
      }),
    ).toEqual({ list: [null, null, 1], nan: null, inf: null, id: 'ord_1', money: { amount: 10 } });
    expect(encodeResult(undefined)).toBeUndefined();
    expect(encodeResult(() => 1)).toBeUndefined();
  });

  it("doesn't let an object that uses the tag key pass for a tagged value", () => {
    const lookalike = { __idempotencyType: 'Date', value: 'not a date' };
    const encoded = encodeResult(lookalike);

    expect(encoded).toEqual({ __idempotencyType: 'Object', value: lookalike });
    expect(throughStore(lookalike)).toEqual(lookalike);
  });

  it('keeps an own __proto__ key as a key, without changing the prototype', () => {
    const value = JSON.parse('{"__proto__": {"polluted": true}, "id": 1}');
    const restored = throughStore(value) as Record<string, unknown>;

    expect(Object.getPrototypeOf(restored)).toBe(Object.prototype);
    expect(Object.keys(restored)).toEqual(['__proto__', 'id']);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('refuses a circular result, and allows the same object twice when it is not a cycle', () => {
    const order: Record<string, unknown> = { id: 1 };
    order.self = order;
    expect(() => encodeResult(order)).toThrow(UnreplayableResult);
    expect(() => encodeResult(order)).toThrow('its result has a circular reference');

    const shared = { currency: 'EUR' };
    expect(throughStore({ a: shared, b: shared })).toEqual({ a: shared, b: shared });
  });

  it('in strict mode (GraphQL), refuses functions, promises and streams it would otherwise drop', () => {
    expect(() => encodeResult({ total: () => 10 }, { strict: true })).toThrow(
      'its result holds a function, which GraphQL calls',
    );
    expect(() => encodeResult({ total: Promise.resolve(10) }, { strict: true })).toThrow(
      'its result holds a promise or a stream, which GraphQL awaits',
    );
    expect(() => encodeResult({ file: Readable.from([]) }, { strict: true })).toThrow(UnreplayableResult);

    expect(encodeResult({ total: () => 10, id: 1 })).toEqual({ id: 1 });
    expect(encodeResult({ missing: undefined }, { strict: true })).toEqual({});
  });

  describe('getters on a class instance', () => {
    class Money {
      constructor(readonly cents: number) {}
      get formatted() {
        return `${(this.cents / 100).toFixed(2)} EUR`;
      }
      get label() {
        return 'money';
      }
      format() {
        return this.formatted;
      }
    }
    class Refund extends Money {
      override get label() {
        return 'refund';
      }
    }

    /** A strict-mode record after a store's JSON round trip. */
    const throughStrictStore = (value: unknown) =>
      decodeResult(JSON.parse(JSON.stringify(encodeResult(value, { strict: true }))));

    it('in strict mode (GraphQL), stores their values, as GraphQL reads them, however deeply nested', () => {
      const value = { total: new Money(1250), lines: [new Money(250)], refund: { of: new Refund(100) } };

      expect(throughStrictStore(value)).toEqual({
        total: { cents: 1250, formatted: '12.50 EUR', label: 'money' },
        lines: [{ cents: 250, formatted: '2.50 EUR', label: 'money' }],
        // The inherited getter is kept, and the subclass's shadows the base class's.
        refund: { of: { cents: 100, formatted: '1.00 EUR', label: 'refund' } },
      });
    });

    it('in strict mode, refuses a getter that throws or returns a promise', () => {
      class Unloaded {
        get amount(): string {
          throw new Error('not loaded');
        }
      }
      class Lazy {
        get customer() {
          return Promise.resolve({ id: 1 });
        }
      }

      expect(() => encodeResult({ receipt: new Unloaded() }, { strict: true })).toThrow(
        'its result has a getter that throws ("amount")',
      );
      expect(() => encodeResult(new Lazy(), { strict: true })).toThrow(
        'its result holds a promise or a stream, which GraphQL awaits',
      );
    });

    it('otherwise leaves them out, as JSON.stringify does', () => {
      class Unloaded {
        id = 1;
        get amount(): string {
          throw new Error('not loaded');
        }
      }
      const value = { total: new Money(1250), lines: [new Refund(100)], unloaded: new Unloaded() };

      expect(throughStore(value)).toEqual(JSON.parse(JSON.stringify(value)));
      expect(throughStore(value)).toEqual({
        total: { cents: 1250 },
        lines: [{ cents: 100 }],
        unloaded: { id: 1 },
      });
    });
  });
});

describe('unreplayableReason()', () => {
  it('names what the handler returned that has no content to store', () => {
    async function* pages() {
      yield 1;
    }

    expect(unreplayableReason(new StreamableFile(Buffer.from('x')))).toBe('it returned a StreamableFile');
    expect(unreplayableReason(Readable.from([]))).toBe('it returned a stream');
    expect(unreplayableReason(pages())).toBe('it returned an async iterable');
  });

  it('accepts plain values, including null and Buffers', () => {
    for (const value of [undefined, null, 0, 'text', { id: 1 }, [1], Buffer.from('x'), new Map()]) {
      expect(unreplayableReason(value)).toBeUndefined();
    }
  });
});
