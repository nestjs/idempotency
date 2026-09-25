/**
 * One IdempotencyModule registration in a hybrid app: REST, GraphQL (Apollo, on Express: the
 * workspace has no Apollo integration for Fastify) and a TCP microservice connected with
 * `inheritAppConfig`, with per-context `scope` and `keyFrom` and a custom `header`. Each context
 * reads its own key, keeps its own records, answers rejections in its native error format, and
 * reports on the same events$.
 */
import { ApolloDriver, type ApolloDriverConfig } from '@nestjs/apollo';
import { Body, Controller, Injectable, Module, Post, type INestApplication } from '@nestjs/common';
import { Args, Field, GraphQLModule, ID, Int, Mutation, ObjectType, Query, Resolver } from '@nestjs/graphql';
import {
  ClientProxyFactory,
  MessagePattern,
  Payload,
  Transport,
  type ClientProxy,
  type MicroserviceOptions,
} from '@nestjs/microservices';
import type { AddressInfo, Server } from 'node:net';
import { firstValueFrom } from 'rxjs';
import request from 'supertest';
import { createApp } from './support/adapters.js';
import {
  IdempotencyEvents,
  IdempotencyModule,
  Idempotent,
  InMemoryIdempotencyStore,
  type IdempotencyEvent,
} from '../lib/index.js';
import { registered } from './register.js';

@Injectable()
class ChargesService {
  count = 0;

  charge(amount: number) {
    return { chargeId: `ch_${++this.count}`, amount };
  }
}

@ObjectType()
class Charge {
  @Field(() => ID) chargeId!: string;
  @Field(() => Int) amount!: number;
}

@Controller('charges')
class ChargesController {
  constructor(private readonly chargesService: ChargesService) {}

  @Post()
  @Idempotent()
  create(@Body() body: { amount: number }) {
    return this.chargesService.charge(body.amount);
  }

  @MessagePattern('charges.create')
  @Idempotent()
  createFromMessage(@Payload() message: { amount: number }) {
    return this.chargesService.charge(message.amount);
  }
}

@Resolver(() => Charge)
class ChargesResolver {
  constructor(private readonly chargesService: ChargesService) {}

  @Query(() => String)
  ping() {
    return 'pong';
  }

  @Mutation(() => Charge)
  @Idempotent()
  charge(@Args('amount', { type: () => Int }) amount: number) {
    return this.chargesService.charge(amount);
  }
}

type Headers = Record<string, string | undefined>;

const store = new InMemoryIdempotencyStore();

@Module({
  imports: [
    GraphQLModule.forRoot<ApolloDriverConfig>({ driver: ApolloDriver, autoSchemaFile: true }),
    IdempotencyModule.forRoot({
      header: 'X-Idempotency-Key',
      keyFrom: { http: { header: 'X-Request-Id' }, rpc: { payload: 'meta.requestId' } },
      scope: {
        http: (req: { headers: Headers }) => req.headers['x-tenant'],
        graphql: (req: { headers: Headers }) => req.headers['x-tenant'],
        rpc: (payload) => (payload as { tenant: string }).tenant,
      },
    }),
  ],
  controllers: [ChargesController],
  providers: [ChargesService, ChargesResolver, registered(store)],
})
class HybridModule {}

describe('one registration in a hybrid app (REST, GraphQL, TCP)', () => {
  let app: INestApplication;
  let client: ClientProxy;
  let events: IdempotencyEvent[];

  beforeAll(async () => {
    app = await createApp('express', HybridModule, {
      setup: async (a) => {
        a.useLogger(false);
        a.connectMicroservice<MicroserviceOptions>(
          { transport: Transport.TCP, options: { host: '127.0.0.1', port: 0 } },
          { inheritAppConfig: true },
        );
        await a.startAllMicroservices();
      },
    });

    const [microservice] = app.getMicroservices();
    const { port } = microservice!.unwrap<Server>().address() as AddressInfo;
    client = ClientProxyFactory.create({ transport: Transport.TCP, options: { host: '127.0.0.1', port } });
    await client.connect();
    app.get(IdempotencyEvents).events$.subscribe((event) => events.push(event));
  });
  afterAll(async () => {
    await client?.close();
    await app?.close();
  });
  beforeEach(() => {
    store.clear();
    app.get(ChargesService).count = 0;
    events = [];
  });

  const rest = (key: string, amount = 10) =>
    request(app.getHttpServer())
      .post('/charges')
      .set('x-tenant', 'acme')
      .set('X-Request-Id', key)
      .set('Idempotency-Key', 'ignored-here')
      .send({ amount });
  const graphql = (key: string, amount = 10) =>
    request(app.getHttpServer())
      .post('/graphql')
      .set('x-tenant', 'acme')
      .set('X-Idempotency-Key', key)
      .send({ query: `mutation { charge(amount: ${amount}) { chargeId amount } }` });
  const rpc = (key: string, amount = 10) =>
    firstValueFrom(client.send('charges.create', { tenant: 'acme', meta: { requestId: key }, amount })).catch((error) => ({ error }));

  it('replays in every context, each reading its own key source and keeping its own records', async () => {
    const first = [await rest('r1'), await graphql('g1'), await rpc('m1')];
    const retries = [await rest('r1'), await graphql('g1'), await rpc('m1')];

    expect(first[0]!.body).toEqual({ chargeId: 'ch_1', amount: 10 });
    expect(first[1]!.body).toEqual({ data: { charge: { chargeId: 'ch_2', amount: 10 } } });
    expect(first[2]).toEqual({ chargeId: 'ch_3', amount: 10 });
    expect(retries[0]!.headers['idempotent-replayed']).toBe('true');
    expect(retries[0]!.body).toEqual(first[0]!.body);
    // GraphQL replays set no header: other fields of the operation may have run for real.
    expect(retries[1]!.headers['idempotent-replayed']).toBeUndefined();
    expect(retries[1]!.body).toEqual(first[1]!.body);
    expect(retries[2]).toEqual(first[2]);
    expect(app.get(ChargesService).count).toBe(3);

    expect(store.peek('acme:r1')?.state).toBe('completed');
    expect(store.peek('acme:g1:charge')?.state).toBe('completed');
    expect(store.peek('acme:m1:ChargesController.createFromMessage')?.state).toBe('completed');
    expect(events).toEqual([
      { type: 'replayed', context: 'http', handler: 'ChargesController.create', key: 'r1', scope: 'acme', status: 201 },
      { type: 'replayed', context: 'graphql', handler: 'ChargesResolver.charge', key: 'g1', scope: 'acme', status: 200 },
      { type: 'replayed', context: 'rpc', handler: 'ChargesController.createFromMessage', key: 'm1', scope: 'acme', status: 200 },
    ]);
  });

  it('answers a reused key in each context with its native error, and reports each rejection', async () => {
    await rest('k1');
    await graphql('k1');
    await rpc('k1');

    const http = await rest('k1', 11);
    expect(http.status).toBe(422);
    expect(http.body.code).toBe('IDEMPOTENCY_KEY_REUSED');

    const gql = await graphql('k1', 11);
    expect(gql.status).toBe(200);
    expect(gql.body.errors[0].extensions).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED', httpStatus: 422 });

    expect(await rpc('k1', 11)).toEqual({
      error: {
        status: 'error',
        code: 'IDEMPOTENCY_KEY_REUSED',
        statusCode: 422,
        message: 'This idempotency key was already used for a different request.',
      },
    });

    expect(events.map((event) => [event.type, event.context])).toEqual([
      ['rejected', 'http'],
      ['rejected', 'graphql'],
      ['rejected', 'rpc'],
    ]);
    expect(app.get(ChargesService).count).toBe(3);
  });

  it('reads no key from the default Idempotency-Key header where keyFrom or header replaced it', async () => {
    await request(app.getHttpServer()).post('/charges').set('Idempotency-Key', 'k1').send({ amount: 1 });
    await request(app.getHttpServer())
      .post('/graphql')
      .set('Idempotency-Key', 'k1')
      .send({ query: 'mutation { charge(amount: 1) { chargeId } }' });

    expect(store.size).toBe(0);
    expect(app.get(ChargesService).count).toBe(2);
  });
});
