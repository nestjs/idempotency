import type { ExecutionContext } from '@nestjs/common';
import type * as GraphQL from 'graphql';
import { of, throwError, type Observable } from 'rxjs';
import type { IdempotencyStoredResponse } from '../interfaces/idempotency-store.interface.js';
import { DEFAULT_KEY_FIELD } from '../idempotency.constants.js';
import { decodeResult } from '../utils/result.util.js';
import {
  captureHttpOrUnknownError,
  pick,
  rebuildHttpException,
  successCapture,
  unsupportedSource,
  type CaptureOptions,
  type DeclarativeKeySource,
  type IdempotencyContextAdapter,
  type IdempotencyRejection,
} from './context.adapter.js';

type ResolverArgs = [
  root: unknown,
  args: Record<string, unknown>,
  context: { req?: { headers?: Record<string, unknown>; user?: unknown } } | undefined,
  info: GraphQL.GraphQLResolveInfo | undefined,
];

/** `a.b.0.c` from graphql-js' linked-list `info.path` (response keys/aliases). */
function fieldPath(path: GraphQL.GraphQLResolveInfo['path'] | undefined) {
  const keys: (string | number)[] = [];
  for (let p = path; p; p = p.prev) {
    keys.unshift(p.key);
  }
  return keys.join('.');
}

/**
 * GraphQL resolvers (`@Mutation()` + `@Idempotent()`). Idempotency is per
 * *field*: each idempotent mutation in an operation gets its own record at
 * `<scope>:<key>:<fieldPath>`, where the field path uses the response key
 * (alias), so `a: pay(...)` and `b: pay(...)` sharing one header key are
 * two separate, individually replayable records.
 *
 * `graphql` is loaded lazily, so it stays an optional peer dependency.
 */
export class GraphqlContextAdapter implements IdempotencyContextAdapter {
  readonly type = 'graphql';
  readonly sendsEveryValue = false;
  private graphql?: typeof GraphQL;

  async prepare() {
    this.graphql ??= await import('graphql');
  }

  private args(context: ExecutionContext) {
    return context.getArgs() as ResolverArgs;
  }

  /** Root mutation fields only: not queries, not nested field resolvers. */
  coveredByClass(context: ExecutionContext) {
    const info = this.args(context)[3];
    const mutation = info?.schema?.getMutationType();
    return !!mutation && info?.parentType?.name === mutation.name;
  }

  userLocation(context: ExecutionContext) {
    return this.args(context)[2]?.req?.user ? 'context.req.user' : undefined;
  }

  readKey(context: ExecutionContext, source: DeclarativeKeySource, header: string) {
    const [, args, gqlContext] = this.args(context);
    const headers = gqlContext?.req?.headers ?? {};

    if (source === 'default') {
      const arg = pick(args, DEFAULT_KEY_FIELD);
      return arg === undefined || arg === null || arg === '' ? headers[header] : arg;
    }
    if ('header' in source) {
      return headers[source.header.toLowerCase()];
    }
    if ('arg' in source) {
      return pick(args, source.arg);
    }
    throw unsupportedSource(this.type, source);
  }

  target(context: ExecutionContext) {
    return this.args(context)[2]?.req;
  }

  keySuffix(context: ExecutionContext) {
    return fieldPath(this.args(context)[3]?.path);
  }

  describe(context: ExecutionContext) {
    const [, args, , info] = this.args(context);
    return {
      identity: ['graphql', `${info?.parentType?.name}.${info?.fieldName}`],
      payload: args ?? {},
    };
  }

  captureSuccess(_context: ExecutionContext, value: unknown, opts: CaptureOptions) {
    // Strict: GraphQL awaits promises and calls functions it finds in the
    // result, so a result holding any can't be replayed from a copy.
    return successCapture(value, opts, { strict: true });
  }

  captureError(error: unknown, opts: CaptureOptions): IdempotencyStoredResponse | null {
    if (this.graphql && error instanceof this.graphql.GraphQLError) {
      const ext = error.extensions ?? {};
      // A code other than INTERNAL_SERVER_ERROR marks a deliberate rejection
      // (BAD_USER_INPUT, a custom code). Without one, Apollo reports the error
      // as INTERNAL_SERVER_ERROR, so it is treated like any unknown error.
      const deliberate = typeof ext.code === 'string' && ext.code !== 'INTERNAL_SERVER_ERROR';
      const status =
        (ext.http as { status?: number } | undefined)?.status ?? (deliberate ? 400 : 500);
      if (!opts.storeIf(status, error)) {
        return null;
      }

      return {
        status,
        headers: {},
        body: JSON.parse(JSON.stringify({ message: error.message, extensions: ext })),
        error: 'graphql',
      };
    }
    return captureHttpOrUnknownError(error, opts);
  }

  replay(_context: ExecutionContext, stored: IdempotencyStoredResponse): Observable<unknown> {
    if (stored.error === 'graphql') {
      const body = stored.body as { message: string; extensions?: Record<string, unknown> };
      return throwError(
        () => new this.graphql!.GraphQLError(body.message, { extensions: body.extensions }),
      );
    }

    if (stored.error) {
      return throwError(() => rebuildHttpException(stored));
    }

    // A per-field replay can't set a response header (other fields in the
    // same operation may have executed); see README.
    return of(decodeResult(stored.body));
  }

  reject(_context: ExecutionContext, rejection: IdempotencyRejection): Error {
    return new this.graphql!.GraphQLError(rejection.message, {
      extensions: {
        code: rejection.code,
        // Not `extensions.http`: Apollo would apply it to the whole HTTP
        // response, although only this field was rejected.
        httpStatus: rejection.status,
        ...(rejection.retryAfter !== undefined && { retryAfter: rejection.retryAfter }),
      },
    });
  }
}
