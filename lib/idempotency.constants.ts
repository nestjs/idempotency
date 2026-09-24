export const DEFAULT_TTL = 24 * 60 * 60 * 1000;
export const DEFAULT_LOCK_TTL = 60 * 1000;
export const DEFAULT_RETRY_AFTER = 1000;
export const DEFAULT_HEADER = 'Idempotency-Key';
/** The default payload property (rpc) and argument (graphql) holding the key. */
export const DEFAULT_KEY_FIELD = 'idempotencyKey';
/**
 * Representation metadata (RFC 9110): it describes the stored body, so a replay must
 * carry the stored value, not what this request's middleware set (i18n's
 * `Content-Language` for the retry's `Accept-Language`). `Vary` is left out: it
 * describes how the platform and middleware (CORS, compression) negotiate every
 * response, the replay's included.
 */
export const DEFAULT_REPLAY_HEADERS = [
  'location',
  'content-type',
  'content-language',
  'content-location',
  'etag',
  'last-modified',
];
/**
 * Never replayed: cookies belong to the response that set them, and the
 * platform writes framing and hop-by-hop headers for each response.
 */
export const NEVER_REPLAYED_HEADERS = new Set([
  'set-cookie',
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'upgrade',
  'trailer',
  'te',
  'date',
]);
export const REPLAYED_HEADER = 'Idempotent-Replayed';
export const MAX_KEY_LENGTH = 255;

export const IDEMPOTENT_METADATA = 'nestjs:idempotent';
