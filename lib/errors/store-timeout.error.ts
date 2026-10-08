/**
 * A store call that didn't answer within `storeTimeout`. The call may still
 * land in the store later; a lock it took expires after `lockTtl`.
 */
export class IdempotencyStoreTimeoutError extends Error {
  constructor(
    readonly method: string,
    readonly timeout: number,
  ) {
    super(`IdempotencyStore.${method}() did not answer within ${timeout} ms (storeTimeout)`);
    this.name = 'IdempotencyStoreTimeoutError';
  }
}
