import { canonicalJson, sha256 } from '../lib/utils/fingerprint.util.js';

describe('canonicalJson', () => {
  it('is key-order independent at every depth, array-order dependent', () => {
    expect(canonicalJson({ b: 1, a: { d: 1, c: 2 } })).toBe(
      canonicalJson({ a: { c: 2, d: 1 }, b: 1 }),
    );
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it('follows JSON for undefined, Dates and toJSON()', () => {
    // A `fingerprint` that blanks a field with `undefined` removes it.
    expect(canonicalJson({ a: 1, sentAt: undefined })).toBe(canonicalJson({ a: 1 }));
    expect(canonicalJson([undefined])).toBe(canonicalJson([null]));
    const at = '2026-09-22T10:00:00.000Z';
    expect(canonicalJson({ at: new Date(at) })).toBe(canonicalJson({ at }));
    expect(canonicalJson({ id: { toJSON: () => 'x' } })).toBe(canonicalJson({ id: 'x' }));
  });

  it('fingerprints BigInts (GraphQL BigInt scalars) instead of throwing', () => {
    expect(() => canonicalJson({ amount: 10n })).not.toThrow();
    expect(canonicalJson({ amount: 10n })).not.toBe(canonicalJson({ amount: 11n }));
    expect(canonicalJson({ amount: 10n })).not.toBe(canonicalJson({ amount: 10 }));
    expect(canonicalJson({ amount: 10n })).not.toBe(canonicalJson({ amount: '10' }));
  });

  it('fingerprints binary data by content, compactly', () => {
    const big = Buffer.alloc(1_000_000, 1);
    expect(canonicalJson({ file: big }).length).toBeLessThan(200);
    expect(canonicalJson({ file: Buffer.from('a') })).not.toBe(
      canonicalJson({ file: Buffer.from('b') }),
    );
    expect(canonicalJson({ file: new Uint8Array([1, 2]) })).toBe(
      canonicalJson({ file: Buffer.from([1, 2]) }),
    );
  });

  it('tells Maps and Sets apart by their contents', () => {
    expect(canonicalJson(new Map([['a', 1]]))).not.toBe(canonicalJson(new Map([['a', 2]])));
    expect(canonicalJson(new Set([1]))).not.toBe(canonicalJson(new Set([2])));
    expect(canonicalJson(new Set([1, 2]))).toBe(canonicalJson(new Set([2, 1])));
  });

  it('survives circular references and values JSON cannot represent', () => {
    const body: Record<string, unknown> = { a: 1 };
    body.self = body;

    expect(() => canonicalJson(body)).not.toThrow();
    expect(canonicalJson(body)).toBe(canonicalJson(body));

    // What a `fingerprint` function might return by mistake.
    expect(typeof canonicalJson(() => 1)).toBe('string');
    expect(typeof canonicalJson(Symbol('x'))).toBe('string');
  });

  it('keeps a missing payload apart from an empty string or null', () => {
    const values = [undefined, '', null, {}, []].map(canonicalJson);
    expect(new Set(values).size).toBe(values.length);
  });
});

describe('sha256', () => {
  it('is unambiguous about where one part ends', () => {
    expect(sha256('a\0b', 'c')).not.toBe(sha256('a', 'b\0c'));
    expect(sha256('ab', 'c')).not.toBe(sha256('a', 'bc'));
  });
});
