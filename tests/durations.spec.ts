import { Controller, Post } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Idempotent, IdempotencyModule } from '../lib/index.js';
import { withDurationsInMs } from '../lib/decorators/idempotent.decorator.js';
import { IDEMPOTENT_METADATA } from '../lib/idempotency.constants.js';
import { toMs } from '../lib/utils/duration.util.js';

describe('toMs()', () => {
  it('reads every unit, and fractions of one', () => {
    expect(toMs('250ms')).toBe(250);
    expect(toMs('30s')).toBe(30_000);
    expect(toMs('15m')).toBe(900_000);
    expect(toMs('6h')).toBe(21_600_000);
    expect(toMs('3d')).toBe(259_200_000);
    expect(toMs('1w')).toBe(604_800_000);
    expect(toMs('1.5s')).toBe(1_500);
    expect(toMs(0)).toBe(0);
    expect(toMs(12.5)).toBe(12.5);
  });

  it('rejects negative, non-finite and unparsable durations', () => {
    for (const value of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => toMs(value)).toThrow('Use a non-negative number of milliseconds.');
    }
    for (const value of ['-1s', '1 s', '1S', '1y', 's', '', '1e3ms', '.5s']) {
      expect(() => toMs(value as never)).toThrow(`Invalid duration "${value}".`);
    }
  });
});

describe('withDurationsInMs()', () => {
  it('converts ttl, lockTtl and retryAfter, and leaves the other options and the input alone', () => {
    const storeIf = () => true;
    const options = { ttl: '1h', lockTtl: '30s', retryAfter: '2s', required: true, storeIf } as const;

    expect(withDurationsInMs(options, 'X')).toEqual({
      ttl: 3_600_000,
      lockTtl: 30_000,
      retryAfter: 2_000,
      required: true,
      storeIf,
    });
    expect(options.ttl).toBe('1h');
    expect(withDurationsInMs({}, 'X')).toEqual({});
  });

  it('rounds fractions of a millisecond up, so a store never gets a fraction', () => {
    expect(withDurationsInMs({ ttl: 0.2, lockTtl: 1000 / 3, retryAfter: 0.1 }, 'X')).toEqual({
      ttl: 1,
      lockTtl: 334,
      retryAfter: 1,
    });
  });

  it('lets retryAfter be zero, but not ttl or lockTtl', () => {
    expect(withDurationsInMs({ retryAfter: 0 }, 'X')).toEqual({ retryAfter: 0 });
    expect(() => withDurationsInMs({ ttl: '0s' }, '@Idempotent()')).toThrow(
      '@Idempotent(): `ttl` must be at least 1 ms, got "0s".',
    );
    expect(() => withDurationsInMs({ lockTtl: 0 }, 'IdempotencyModule')).toThrow(
      'IdempotencyModule: `lockTtl` must be at least 1 ms, got 0.',
    );
    expect(() => withDurationsInMs({ retryAfter: -1 }, 'X')).toThrow('X: invalid `retryAfter`.');
  });
});

describe('@Idempotent()', () => {
  it('stores its options with the durations already in milliseconds', () => {
    @Controller()
    @Idempotent({ ttl: '1d' })
    class PaymentsController {
      @Post()
      @Idempotent({ lockTtl: '2m', required: true })
      pay() {}
    }

    expect(Reflect.getMetadata(IDEMPOTENT_METADATA, PaymentsController)).toEqual({ ttl: 86_400_000 });
    expect(Reflect.getMetadata(IDEMPOTENT_METADATA, PaymentsController.prototype.pay)).toEqual({
      lockTtl: 120_000,
      required: true,
    });
  });

  it('fails where it is applied, naming the option, when a duration is out of range', () => {
    expect(() => Idempotent({ lockTtl: -5 })).toThrow('@Idempotent(): invalid `lockTtl`.');
    expect(() => Idempotent({ retryAfter: 'soon' as never })).toThrow(
      '@Idempotent(): invalid `retryAfter`. Invalid duration "soon".',
    );
  });

  it('fails module startup on an invalid module-wide duration, naming the module', async () => {
    await expect(
      Test.createTestingModule({
        imports: [IdempotencyModule.forRootAsync({ useFactory: () => ({ retryAfter: '1 minute' as never }) })],
      }).compile(),
    ).rejects.toThrow('IdempotencyModule: invalid `retryAfter`. Invalid duration "1 minute".');
  });
});
