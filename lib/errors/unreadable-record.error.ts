/** Raised when a stored record cannot be opened (tampered, unknown key, ...). */
export class UnreadableRecordError extends Error {
  constructor(reason: string) {
    super(`Idempotency record could not be opened: ${reason}`);
    this.name = 'UnreadableRecordError';
  }
}
