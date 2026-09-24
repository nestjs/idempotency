import { channel } from 'node:diagnostics_channel';

export const channels = {
  replayed: channel('nestjs:idempotency:replayed'),
  rejected: channel('nestjs:idempotency:rejected'),
  'lock-lost': channel('nestjs:idempotency:lock-lost'),
};
