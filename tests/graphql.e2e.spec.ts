import { ApolloDriver, type ApolloDriverConfig } from '@nestjs/apollo';
import { BadRequestException, Module, type INestApplication } from '@nestjs/common';
import {
  Args,
  Field,
  GraphQLISODateTime,
  GraphQLModule,
  ID,
  Int,
  Mutation,
  ObjectType,
  Parent,
  Query,
  ResolveField,
  Resolver,
} from '@nestjs/graphql';
import { GraphQLError, Kind, type GraphQLScalarType } from 'graphql';
import request from 'supertest';
import { createApp } from './support/adapters.js';
import { Idempotent, IdempotencyModule, InMemoryIdempotencyStore } from '../lib/index.js';
import { registered } from './register.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

const state = {
  calls: {} as Record<string, number>,
  gate: undefined as ReturnType<typeof deferred> | undefined,
  started: undefined as ReturnType<typeof deferred> | undefined,
};
const hit = (name: string) => (state.calls[name] = (state.calls[name] ?? 0) + 1);

@ObjectType()
class Order {
  @Field(() => ID) id!: string;
  @Field(() => Int) amount!: number;
}

@ObjectType()
class Receipt {
  @Field(() => ID) id!: string;
  /** The DateTime scalar, which serializes Date instances only. */
  @Field() paidAt!: Date;
}

/**
 * What graphql-scalars' BigInt does: parses to a `bigint`. Built from the
 * `graphql` copy @nestjs/graphql loaded (vitest resolves the test's own
 * `graphql` import to its development build, a different class).
 */
const ScalarType = GraphQLISODateTime.constructor as typeof GraphQLScalarType;
const BigIntScalar = new ScalarType({
  name: 'BigInt',
  serialize: (value) => String(value),
  parseValue: (value) => BigInt(value as string),
  parseLiteral: (ast) =>
    ast.kind === Kind.INT || ast.kind === Kind.STRING ? BigInt(ast.value) : null,
});

@Resolver(() => Order)
class OrdersResolver {
  @Query(() => String)
  ping() {
    return 'pong';
  }

  @Mutation(() => Order)
  @Idempotent()
  async createOrder(@Args('amount', { type: () => Int }) amount: number) {
    const n = hit('createOrder');
    if (state.gate) {
      state.started?.resolve();
      await state.gate.promise;
    }
    return { id: `ord_${n}`, amount };
  }

  @Mutation(() => Order)
  @Idempotent({ keyFrom: { arg: 'idempotencyKey' }, required: true })
  createOrderByArg(
    @Args('amount', { type: () => Int }) amount: number,
    @Args('idempotencyKey', { type: () => String, nullable: true }) _key?: string,
  ) {
    return { id: `arg_${hit('createOrderByArg')}`, amount };
  }

  @Mutation(() => Order)
  @Idempotent({ required: true }) // default: the idempotencyKey argument, then the header
  createOrderByDefault(
    @Args('amount', { type: () => Int }) amount: number,
    @Args('idempotencyKey', { type: () => String, nullable: true }) _key?: string,
  ) {
    return { id: `default_${hit('createOrderByDefault')}`, amount };
  }

  @Mutation(() => Order)
  @Idempotent({ fingerprint: (args: { amount: number }) => ({ amount: args.amount }) })
  noteOrder(
    @Args('amount', { type: () => Int }) amount: number,
    @Args('note', { type: () => String, nullable: true }) _note?: string,
  ) {
    return { id: `note_${hit('noteOrder')}`, amount };
  }

  @Mutation(() => Order)
  @Idempotent({ retryAfter: '7s' })
  async slowOrder(@Args('amount', { type: () => Int }) amount: number) {
    hit('slowOrder');
    state.started?.resolve();
    await state.gate?.promise;
    return { id: 'slow', amount };
  }

  @Mutation(() => Order)
  @Idempotent()
  declinedOrder(@Args('amount', { type: () => Int }) _amount: number): Order {
    hit('declinedOrder');
    throw new BadRequestException('Card declined');
  }

  @Mutation(() => Receipt)
  @Idempotent()
  payOrder() {
    return { id: `rcpt_${hit('payOrder')}`, paidAt: new Date('2026-09-22T10:00:00.000Z') };
  }

  @Mutation(() => String)
  @Idempotent()
  transfer(@Args('amount', { type: () => BigIntScalar }) amount: bigint) {
    return `transfer ${hit('transfer')}: ${amount}`;
  }

  @Mutation(() => String)
  @Idempotent()
  flakyOrder() {
    // A GraphQLError without a code: Apollo reports it as INTERNAL_SERVER_ERROR.
    if (hit('flakyOrder') === 1) {
      throw new GraphQLError('The payment provider timed out');
    }
    return 'ok';
  }
}

/** Class-level: covers the root mutation, not the query or the nested field. */
@ObjectType()
class Card {
  @Field(() => ID) id!: string;
}

@Resolver(() => Card)
@Idempotent({ required: true })
class CardsResolver {
  @Query(() => Card)
  card() {
    hit('card');
    return { id: 'card_1' };
  }

  @Mutation(() => Card)
  issueCard() {
    return { id: `card_${hit('issueCard')}` };
  }

  @ResolveField(() => String)
  label(@Parent() card: Card) {
    return `Card ${card.id}`;
  }
}

const store = new InMemoryIdempotencyStore();

@Module({
  imports: [
    GraphQLModule.forRoot<ApolloDriverConfig>({
      driver: ApolloDriver,
      autoSchemaFile: true,
      resolvers: { BigInt: BigIntScalar },
    }),
    IdempotencyModule.forRoot(),
  ],
  providers: [OrdersResolver, CardsResolver, registered(store)],
})
class GraphqlAppModule {}

describe('Idempotency (graphql, apollo on express)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createApp('express', GraphqlAppModule, {
      setup: (a) => a.useLogger(false),
    });
  });
  afterAll(async () => {
    state.gate?.resolve();
    await app.close();
  });
  beforeEach(() => {
    store.clear();
    state.calls = {};
    state.gate = undefined;
    state.started = undefined;
  });

  const gql = (query: string, key?: string) => {
    const r = request(app.getHttpServer()).post('/graphql').send({ query });
    return key ? r.set('Idempotency-Key', key) : r;
  };

  it('replays a mutation keyed by the HTTP header', async () => {
    const q = 'mutation { createOrder(amount: 10) { id amount } }';
    const first = await gql(q, 'k1');
    expect(first.body).toEqual({ data: { createOrder: { id: 'ord_1', amount: 10 } } });

    const retry = await gql(q, 'k1');
    expect(retry.body).toEqual(first.body);
    expect(state.calls.createOrder).toBe(1);
  });

  it('runs normally without a key when not required', async () => {
    const q = 'mutation { createOrder(amount: 10) { id } }';
    await gql(q);
    await gql(q);
    expect(state.calls.createOrder).toBe(2);
  });

  it('fingerprints field + canonical args: different args → IDEMPOTENCY_KEY_REUSED', async () => {
    await gql('mutation { createOrder(amount: 10) { id } }', 'k1');
    const res = await gql('mutation { createOrder(amount: 99) { id } }', 'k1');
    expect(res.body.data).toBeNull();
    expect(res.body.errors[0].extensions).toMatchObject({
      code: 'IDEMPOTENCY_KEY_REUSED',
      httpStatus: 422,
    });
    expect(state.calls.createOrder).toBe(1);
  });

  it('scopes records per field path: aliased mutations in one operation', async () => {
    const q = `mutation {
      a: createOrder(amount: 1) { id }
      b: createOrder(amount: 1) { id }
    }`;

    const first = await gql(q, 'k1');
    expect(first.body.data).toEqual({ a: { id: 'ord_1' }, b: { id: 'ord_2' } });

    const retry = await gql(q, 'k1');
    expect(retry.body.data).toEqual(first.body.data);
    expect(state.calls.createOrder).toBe(2);
    expect(store.peek('k1:a')?.state).toBe('completed');
    expect(store.peek('k1:b')?.state).toBe('completed');
  });

  it('reads the key from a mutation argument', async () => {
    const q = 'mutation { createOrderByArg(amount: 5, idempotencyKey: "arg-1") { id } }';
    await gql(q);
    const retry = await gql(q);
    expect(retry.body.data).toEqual({ createOrderByArg: { id: 'arg_1' } });
    expect(state.calls.createOrderByArg).toBe(1);
  });

  it('reads the idempotencyKey argument by default, then the header', async () => {
    const byArg = 'mutation { createOrderByDefault(amount: 5, idempotencyKey: "arg-1") { id } }';
    await gql(byArg, 'header-is-ignored');
    const retry = await gql(byArg);
    expect(retry.body.data).toEqual({ createOrderByDefault: { id: 'default_1' } });
    expect(store.peek('arg-1:createOrderByDefault')?.state).toBe('completed');

    const byHeader = 'mutation { createOrderByDefault(amount: 5) { id } }';
    await gql(byHeader, 'h-1');
    expect((await gql(byHeader, 'h-1')).body.data).toEqual({
      createOrderByDefault: { id: 'default_2' },
    });
    expect(state.calls.createOrderByDefault).toBe(2);

    const missing = await gql(byHeader);
    expect(missing.body.errors[0].extensions.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  it('fingerprints what `fingerprint` selects from the arguments', async () => {
    await gql('mutation { noteOrder(amount: 5, note: "first try") { id } }', 'k1');
    const retry = await gql('mutation { noteOrder(amount: 5, note: "second try") { id } }', 'k1');
    expect(retry.body.data).toEqual({ noteOrder: { id: 'note_1' } });

    const changed = await gql('mutation { noteOrder(amount: 6, note: "first try") { id } }', 'k1');
    expect(changed.body.errors[0].extensions.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(state.calls.noteOrder).toBe(1);
  });

  it('a class-level @Idempotent() covers root mutations, not queries or nested fields', async () => {
    const query = await gql('{ card { id label } }');
    expect(query.body).toEqual({ data: { card: { id: 'card_1', label: 'Card card_1' } } });

    const noKey = await gql('mutation { issueCard { id } }');
    expect(noKey.body.errors[0].extensions.code).toBe('IDEMPOTENCY_KEY_REQUIRED');

    const q = 'mutation { issueCard { id label } }';
    const first = await gql(q, 'k1');
    expect(first.body.data).toEqual({ issueCard: { id: 'card_1', label: 'Card card_1' } });
    expect((await gql(q, 'k1')).body).toEqual(first.body);
    expect(state.calls.issueCard).toBe(1);
    expect(store.size).toBe(1); // no record for the nested `label` field
  });

  it('rejects a missing required key with IDEMPOTENCY_KEY_REQUIRED', async () => {
    const res = await gql('mutation { createOrderByArg(amount: 5) { id } }', 'header-is-ignored');
    expect(res.body.errors[0].extensions).toMatchObject({
      code: 'IDEMPOTENCY_KEY_REQUIRED',
      httpStatus: 400,
    });
    expect(state.calls.createOrderByArg).toBeUndefined();
  });

  it('rejects a concurrent duplicate with IDEMPOTENCY_KEY_IN_USE and retryAfter', async () => {
    state.gate = deferred();
    state.started = deferred();
    const q = 'mutation { slowOrder(amount: 1) { id } }';
    const first = gql(q, 'k1').then((r) => r);
    await state.started.promise;

    const dup = await gql(q, 'k1');
    expect(dup.status).toBe(200); // per-field error, not a transport failure
    expect(dup.body.errors[0].extensions).toMatchObject({
      code: 'IDEMPOTENCY_KEY_IN_USE',
      httpStatus: 409,
      retryAfter: 7,
    });

    state.gate.resolve();
    expect((await first).body.data).toEqual({ slowOrder: { id: 'slow' } });
    expect(state.calls.slowOrder).toBe(1);
  });

  it('replays Date fields: the DateTime scalar gets a Date again, not a string', async () => {
    const q = 'mutation { payOrder { id paidAt } }';
    const first = await gql(q, 'k1');
    expect(first.body).toEqual({
      data: { payOrder: { id: 'rcpt_1', paidAt: '2026-09-22T10:00:00.000Z' } },
    });

    const retry = await gql(q, 'k1');
    expect(retry.body).toEqual(first.body);
    expect(state.calls.payOrder).toBe(1);
  });

  it('fingerprints BigInt arguments', async () => {
    const first = await gql('mutation { transfer(amount: "9007199254740993") }', 'k1');
    expect(first.body).toEqual({ data: { transfer: 'transfer 1: 9007199254740993' } });

    const retry = await gql('mutation { transfer(amount: "9007199254740993") }', 'k1');
    expect(retry.body).toEqual(first.body);

    const other = await gql('mutation { transfer(amount: "9007199254740994") }', 'k1');
    expect(other.body.errors[0].extensions.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(state.calls.transfer).toBe(1);
  });

  it('releases the key on a GraphQLError without a code, like any unknown error', async () => {
    const q = 'mutation { flakyOrder }';
    const first = await gql(q, 'k1');
    expect(first.body.errors[0].message).toBe('The payment provider timed out');

    const retry = await gql(q, 'k1');
    expect(retry.body).toEqual({ data: { flakyOrder: 'ok' } });
    expect(state.calls.flakyOrder).toBe(2);
  });

  it('falls back to the header when the idempotencyKey argument is empty', async () => {
    const q = 'mutation { createOrderByDefault(amount: 5, idempotencyKey: "") { id } }';
    await gql(q, 'h-1');
    const retry = await gql(q, 'h-1');
    expect(retry.body.data).toEqual({ createOrderByDefault: { id: 'default_1' } });
    expect(store.peek('h-1:createOrderByDefault')?.state).toBe('completed');
  });

  it('stores and replays deterministic 4xx errors', async () => {
    const q = 'mutation { declinedOrder(amount: 1) { id } }';
    const first = await gql(q, 'k1');
    const retry = await gql(q, 'k1');

    expect(first.body.errors[0].message).toBe('Card declined');
    expect(retry.body.errors[0].message).toBe('Card declined');
    expect(retry.body.errors[0].extensions.code).toBe(first.body.errors[0].extensions.code);
    expect(state.calls.declinedOrder).toBe(1);
  });
});
