/**
 * The protocol-specific halves of the interceptor, for what the e2e suites can't reach: the
 * transport headers of NATS, Kafka, RabbitMQ, MQTT and gRPC (only TCP runs there), and how
 * GraphQL and RPC errors become records.
 */
import { BadRequestException, HttpException, type ExecutionContext } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { lastValueFrom } from 'rxjs';
import { Unreplayable } from '../lib/contexts/context.adapter.js';
import { GraphqlContextAdapter } from '../lib/contexts/graphql.context.js';
import { RpcContextAdapter } from '../lib/contexts/rpc.context.js';
import { UnreplayableResult } from '../lib/errors/unreplayable-result.error.js';
import type { IdempotencyStoredResponse } from '../lib/index.js';

const always = { storeIf: () => true };
const never = { storeIf: () => false };

class Handlers {
  charge() {}
}

describe('RpcContextAdapter', () => {
  let adapter: RpcContextAdapter;
  beforeEach(async () => {
    adapter = new RpcContextAdapter();
    await adapter.prepare();
  });

  const call = (data: unknown, rpcContext: unknown = {}, args: unknown[] = []) =>
    ({
      getClass: () => Handlers,
      getHandler: () => Handlers.prototype.charge,
      getArgByIndex: (i: number) => args[i],
      switchToRpc: () => ({ getData: () => data, getContext: () => rpcContext }),
    }) as unknown as ExecutionContext;

  const header = (rpcContext: unknown, args: unknown[] = []) =>
    adapter.readKey(call({}, rpcContext, args), 'default', 'idempotency-key');

  describe('reads the key from a transport header when the payload has none', () => {
    it('NATS: the message headers', () => {
      const headers = new Map([['idempotency-key', 'nats-1']]);
      expect(header({ getHeaders: () => headers })).toBe('nats-1');
    });

    it('Kafka: message.headers, as Buffers', () => {
      expect(header({ getMessage: () => ({ headers: { 'idempotency-key': Buffer.from('kafka-1') } }) })).toBe('kafka-1');
    });

    it('RabbitMQ: message.properties.headers', () => {
      expect(header({ getMessage: () => ({ properties: { headers: { 'idempotency-key': 'amqp-1' } } }) })).toBe(
        'amqp-1',
      );
    });

    it('MQTT 5: the packet user properties', () => {
      expect(header({ getPacket: () => ({ properties: { userProperties: { 'idempotency-key': 'mqtt-1' } } }) })).toBe(
        'mqtt-1',
      );
    });

    it('gRPC: the Metadata argument, whose values are lists', () => {
      const metadata = { get: (name: string) => (name === 'idempotency-key' ? ['grpc-1', 'grpc-2'] : []) };
      expect(header({}, [{}, metadata])).toBe('grpc-1');
    });

    it('matches a mixed-case header name the transport kept as sent, then its lower-cased form', () => {
      const exact = { getMessage: () => ({ headers: { 'X-Request-Key': 'exact' } }) };
      const lower = { getMessage: () => ({ headers: { 'x-request-key': 'lower' } }) };
      const source = { header: 'X-Request-Key' };

      expect(adapter.readKey(call({}, exact), source, 'idempotency-key')).toBe('exact');
      expect(adapter.readKey(call({}, lower), source, 'idempotency-key')).toBe('lower');
    });

    it('skips a transport whose accessor throws or whose header is empty', () => {
      const context = {
        getHeaders: () => {
          throw new Error('not NATS');
        },
        getMessage: () => ({ headers: { 'idempotency-key': '' }, properties: { headers: { 'idempotency-key': 'amqp-2' } } }),
      };
      expect(header(context)).toBe('amqp-2');
      expect(header({})).toBeUndefined();
    });
  });

  it('prefers the payload property over a header, unless the source names the header', () => {
    const context = { getMessage: () => ({ headers: { 'idempotency-key': 'from-header' } }) };
    const message = call({ idempotencyKey: 'from-payload' }, context);

    expect(adapter.readKey(message, 'default', 'idempotency-key')).toBe('from-payload');
    expect(adapter.readKey(message, { header: 'Idempotency-Key' }, 'idempotency-key')).toBe('from-header');
    expect(adapter.readKey(call({ meta: { id: 'm1' } }), { payload: 'meta.id' }, 'idempotency-key')).toBe('m1');
    expect(adapter.readKey(call('a string payload'), { payload: 'meta.id' }, 'idempotency-key')).toBeUndefined();
  });

  it('refuses a GraphQL argument as the key source, saying which sources fit', () => {
    expect(() => adapter.readKey(call({}), { arg: 'input.id' }, 'idempotency-key')).toThrow(
      '@Idempotent({ keyFrom: {"arg":"input.id"} }) is not supported in the "rpc" context. Use { arg } for graphql, { payload } for rpc',
    );
  });

  it('identifies a call by its pattern, falling back to the handler metadata, key order aside', () => {
    const throwing = {
      getPattern: () => {
        throw new Error('no pattern here');
      },
    };
    Reflect.defineMetadata('microservices:pattern', [{ cmd: 'charge', v: 1 }], Handlers.prototype.charge);

    expect(adapter.describe(call({ amount: 1 }, { getPattern: () => 'payments.charge' }))).toEqual({
      identity: ['rpc', 'payments.charge'],
      payload: { amount: 1 },
    });
    expect(adapter.describe(call({}, throwing)).identity).toEqual(['rpc', '[{"cmd":"charge","v":1}]']);
    expect(adapter.describe(call({}, { getPattern: () => ({ v: 1, cmd: 'charge' }) })).identity).toEqual(
      adapter.describe(call({}, { getPattern: () => ({ cmd: 'charge', v: 1 }) })).identity,
    );
    expect(adapter.keySuffix(call({}))).toBe('Handlers.charge');
  });

  it('stores an RpcException as a 4xx, unless its statusCode is an HTTP error status', () => {
    const status = (error: object | string) => adapter.captureError(new RpcException(error), always)?.status;

    expect(status({ code: 'card_declined' })).toBe(400);
    expect(status('Card declined')).toBe(400);
    expect(status({ statusCode: 409 })).toBe(409);
    expect(status({ statusCode: 599 })).toBe(599);
    expect(status({ statusCode: 200 })).toBe(400);
    expect(status({ statusCode: 700 })).toBe(400);
    expect(status({ statusCode: '503' })).toBe(400);

    expect(adapter.captureError(new RpcException('Card declined'), always)).toEqual({
      status: 400,
      headers: {},
      body: 'Card declined',
      error: 'rpc',
    });
  });

  it('asks storeIf about an RpcException with its status and the exception itself', () => {
    const error = new RpcException({ statusCode: 422 });
    const storeIf = vi.fn(() => false);

    expect(adapter.captureError(error, { storeIf })).toBeNull();
    expect(storeIf).toHaveBeenCalledWith(422, error);
  });

  it('captures an HttpException thrown by a message handler as an HTTP error', () => {
    expect(adapter.captureError(new BadRequestException('No amount'), always)).toEqual({
      status: 400,
      headers: {},
      body: { message: 'No amount', error: 'Bad Request', statusCode: 400 },
      error: 'http',
    });
    expect(adapter.captureError(new Error('down'), never)).toBeNull();
  });

  it('replays each kind of stored outcome as what the handler produced', async () => {
    const replay = (stored: IdempotencyStoredResponse) => lastValueFrom(adapter.replay(call({}), stored));

    await expect(replay({ status: 400, headers: {}, body: { code: 'card_declined' }, error: 'rpc' })).rejects.toSatisfy(
      (err) => err instanceof RpcException && JSON.stringify(err.getError()) === '{"code":"card_declined"}',
    );
    await expect(replay({ status: 404, headers: {}, body: { message: 'Gone' }, error: 'http' })).rejects.toSatisfy(
      (err) => err instanceof HttpException && err.getStatus() === 404,
    );
    expect(
      await replay({ status: 200, headers: {}, body: { at: { __idempotencyType: 'Date', value: '2026-09-22T10:00:00.000Z' } } }),
    ).toEqual({ at: new Date('2026-09-22T10:00:00.000Z') });
  });

  it('rejects with a structured RpcException, with retryAfter only when there is one', () => {
    const reused = adapter.reject(call({}), { code: 'IDEMPOTENCY_KEY_REUSED', status: 422, message: 'Reused.' });
    const busy = adapter.reject(call({}), { code: 'IDEMPOTENCY_KEY_IN_USE', status: 409, message: 'Busy.', retryAfter: 2 });

    expect((reused as RpcException).getError()).toEqual({
      status: 'error',
      code: 'IDEMPOTENCY_KEY_REUSED',
      statusCode: 422,
      message: 'Reused.',
    });
    expect((busy as RpcException).getError()).toMatchObject({ statusCode: 409, retryAfter: 2 });
  });

  it("finds a signed-in user on the transport context, and stores a stream as unreplayable", () => {
    expect(adapter.userLocation(call({}, { user: { id: 1 } }))).toBe("the transport context's user");
    expect(adapter.userLocation(call({}, {}))).toBeUndefined();

    async function* pages() {
      yield 1;
    }
    expect(adapter.captureSuccess(call({}), pages(), always)).toEqual(new Unreplayable('it returned an async iterable'));
    expect(adapter.captureSuccess(call({}), { ok: true }, never)).toBeNull();
    expect(adapter.captureSuccess(call({}), 12n, always)).toEqual({
      status: 200,
      headers: {},
      body: { __idempotencyType: 'BigInt', value: '12' },
    });
  });
});

describe('GraphqlContextAdapter', () => {
  let adapter: GraphqlContextAdapter;
  /** The GraphQLError class the adapter loaded (the test's own `graphql` import may be another copy). */
  let GraphQLError: new (message: string, options?: { extensions?: Record<string, unknown> }) => Error;

  beforeEach(async () => {
    adapter = new GraphqlContextAdapter();
    await adapter.prepare();
    GraphQLError = adapter.reject({} as ExecutionContext, { code: 'IDEMPOTENCY_KEY_INVALID', status: 400, message: '' })
      .constructor as typeof GraphQLError;
  });

  const schema = (mutation?: string) => ({ getMutationType: () => (mutation ? { name: mutation } : undefined) });
  const field = (
    args: Record<string, unknown>,
    info: Record<string, unknown> = {},
    headers: Record<string, unknown> = {},
  ) => ({ getArgs: () => [undefined, args, { req: { headers } }, info] }) as unknown as ExecutionContext;

  it('covers root mutation fields with a class decorator, never queries or nested fields', () => {
    const on = (parentType: string, mutation?: string) =>
      adapter.coveredByClass(field({}, { schema: schema(mutation), parentType: { name: parentType } }));

    expect(on('Mutation', 'Mutation')).toBe(true);
    expect(on('RootMutation', 'RootMutation')).toBe(true);
    expect(on('Query', 'Mutation')).toBe(false);
    expect(on('Order', 'Mutation')).toBe(false);
    expect(on('Query')).toBe(false);
  });

  it('reads nested arguments, and falls back to the header only for the default argument', () => {
    const args = { idempotencyKey: null, input: { requestId: 'r1' } };
    const headers = { 'idempotency-key': 'h1', 'x-request-key': 'x1' };

    expect(adapter.readKey(field(args, {}, headers), 'default', 'idempotency-key')).toBe('h1');
    expect(adapter.readKey(field(args, {}, headers), { arg: 'input.requestId' }, 'idempotency-key')).toBe('r1');
    expect(adapter.readKey(field(args, {}, headers), { arg: 'input.missing' }, 'idempotency-key')).toBeUndefined();
    expect(adapter.readKey(field(args, {}, headers), { header: 'X-Request-Key' }, 'idempotency-key')).toBe('x1');
    expect(() => adapter.readKey(field(args), { payload: 'id' }, 'idempotency-key')).toThrow(
      'is not supported in the "graphql" context',
    );
  });

  it('keys each field by its response path, aliases and list indexes included', () => {
    const path = { key: 'second', typename: 'Payment', prev: { key: 0, prev: { key: 'batch', prev: undefined } } };
    expect(adapter.keySuffix(field({}, { path }))).toBe('batch.0.second');
    expect(adapter.keySuffix(field({}))).toBe('');
  });

  it('stores a GraphQLError with a deliberate code as a 400, and one without as a 500', () => {
    const status = (extensions?: Record<string, unknown>) =>
      adapter.captureError(new GraphQLError('No.', { extensions }), always)?.status;

    expect(status({ code: 'BAD_USER_INPUT' })).toBe(400);
    expect(status({ code: 'CARD_DECLINED' })).toBe(400);
    expect(status({ code: 'FORBIDDEN', http: { status: 403 } })).toBe(403);
    expect(status({ code: 'INTERNAL_SERVER_ERROR' })).toBe(500);
    expect(status()).toBe(500);
  });

  it('replays a stored GraphQLError with its message and extensions', async () => {
    const stored = adapter.captureError(new GraphQLError('Card declined', { extensions: { code: 'CARD_DECLINED' } }), always)!;
    expect(stored).toEqual({
      status: 400,
      headers: {},
      body: { message: 'Card declined', extensions: { code: 'CARD_DECLINED' } },
      error: 'graphql',
    });

    const replayed = await lastValueFrom(adapter.replay(field({}), stored)).catch((err) => err);
    expect(replayed).toBeInstanceOf(GraphQLError);
    expect(replayed).toMatchObject({ message: 'Card declined', extensions: { code: 'CARD_DECLINED' } });
  });

  it("refuses to store a result GraphQL would call or await, since a copy can't replay it", () => {
    expect(() => adapter.captureSuccess(field({}), { id: 1, total: () => 10 }, always)).toThrow(UnreplayableResult);
    expect(() => adapter.captureSuccess(field({}), { id: 1, total: Promise.resolve(10) }, always)).toThrow(
      UnreplayableResult,
    );
    expect(adapter.captureSuccess(field({}), { id: 1 }, always)).toEqual({ status: 200, headers: {}, body: { id: 1 } });
  });

  it('rejects with a field error whose extensions name the code, and not the HTTP status of the whole response', () => {
    const error = adapter.reject(field({}), {
      code: 'IDEMPOTENCY_KEY_IN_USE',
      status: 409,
      message: 'Busy.',
      retryAfter: 3,
    }) as Error & { extensions: Record<string, unknown> };

    expect(error.message).toBe('Busy.');
    expect(error.extensions).toEqual({ code: 'IDEMPOTENCY_KEY_IN_USE', httpStatus: 409, retryAfter: 3 });
    expect(error.extensions.http).toBeUndefined();
  });

  it('identifies a call by its parent type and field, and finds the user on context.req', () => {
    const info = { parentType: { name: 'Mutation' }, fieldName: 'pay' };
    const withUser = { getArgs: () => [undefined, { amount: 1 }, { req: { user: { id: 1 } } }, info] } as unknown as ExecutionContext;

    expect(adapter.describe(withUser)).toEqual({ identity: ['graphql', 'Mutation.pay'], payload: { amount: 1 } });
    expect(adapter.userLocation(withUser)).toBe('context.req.user');
    expect(adapter.userLocation(field({}))).toBeUndefined();
  });
});
