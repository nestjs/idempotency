import { SetMetadata } from '@nestjs/common';
import { toMs, type Duration } from '../utils/duration.util.js';
import type { IdempotentOptions } from '../interfaces/idempotent-options.interface.js';
import { IDEMPOTENT_METADATA } from '../idempotency.constants.js';

/**
 * Makes retries of the decorated handler safe: calls that carry the same
 * idempotency key run the handler once, and every retry gets the stored
 * result. Works on HTTP routes, GraphQL mutations and microservice handlers.
 *
 * On a class, it covers every handler that changes state: not GET, HEAD or
 * OPTIONS routes, GraphQL queries or nested field resolvers, unless they
 * have their own `@Idempotent()`. Handler options are merged over the
 * class's, and both over the `IdempotencyModule` options, field by field.
 */
export const Idempotent = (options: IdempotentOptions = {}) =>
  SetMetadata(IDEMPOTENT_METADATA, withDurationsInMs(options, '@Idempotent()'));

/**
 * Validates and converts `ttl`, `lockTtl` and `retryAfter` to milliseconds
 * where they are declared, so a typo fails at startup with the option's name.
 * Rounded up to whole milliseconds: stores pass them on as is, and Redis
 * `PEXPIRE` rejects a fraction halfway through a script, after its writes.
 */
export function withDurationsInMs<T extends IdempotentOptions>(options: T, where: string): T {
  const result = { ...options };
  const convert = (name: 'ttl' | 'lockTtl' | 'retryAfter', min: number) => {
    const value: Duration | undefined = options[name];
    if (value === undefined) {
      return;
    }

    let ms: number;
    try {
      ms = Math.ceil(toMs(value));
    } catch (err) {
      throw new TypeError(`${where}: invalid \`${name}\`. ${(err as Error).message}`);
    }

    if (ms < min) {
      throw new TypeError(`${where}: \`${name}\` must be at least ${min} ms, got ${JSON.stringify(value)}.`);
    }
    result[name] = ms;
  };

  convert('ttl', 1);
  convert('lockTtl', 1);
  convert('retryAfter', 0);

  return result;
}
