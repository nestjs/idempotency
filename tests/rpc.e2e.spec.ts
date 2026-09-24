import { Controller, Module, type INestMicroservice } from '@nestjs/common';
import {
  ClientProxyFactory,
  EventPattern,
  MessagePattern,
  Payload,
  RpcException,
  Transport,
  type ClientProxy,
} from '@nestjs/microservices';
import { Test } from '@nestjs/testing';
import type { AddressInfo, Server } from 'node:net';
import { firstValueFrom, from, lastValueFrom, toArray } from 'rxjs';
import { Idempotent, IdempotencyModule, InMemoryIdempotencyStore } from '../lib/index.js';
import { registered } from './register.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(check: () => boolean, timeout = 2_000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeout) {
      throw new Error('Timed out waiting');
    }
    await sleep(5);
  }
}

const state = {
  calls: {} as Record<string, number>,
  events: [] as string[],
  audited: [] as string[],
  gate: undefined as ReturnType<typeof deferred> | undefined,
  started: undefined as ReturnType<typeof deferred> | undefined,
};
const hit = (name: string) => (state.calls[name] = (state.calls[name] ?? 0) + 1);

@Controller()
class PaymentsHandlers {
  @MessagePattern('payments.charge')
  @Idempotent()
  charge(@Payload() data: { amount: number }) {
    return { chargeId: `ch_${hit('charge')}`, amount: data.amount };
  }

  @MessagePattern({ cmd: 'payments.slow' })
  @Idempotent({ required: true })
  async slow() {
    hit('slow');
    state.started?.resolve();
    await state.gate?.promise;
    return { ok: true };
  }

  @MessagePattern('payments.decline')
  @Idempotent()
  decline() {
    hit('decline');
    throw new RpcException({ code: 'card_declined', message: 'Card declined' });
  }

  @MessagePattern('payments.unavailable')
  @Idempotent()
  unavailable() {
    // A deliberate RpcException that says the failure is temporary.
    if (hit('unavailable') === 1) {
      throw new RpcException({ statusCode: 503, message: 'Ledger unavailable' });
    }
    return { ok: true };
  }

  @MessagePattern('payments.history')
  @Idempotent()
  history() {
    hit('history');
    return from([{ page: 1 }, { page: 2 }, { page: 3 }]);
  }

  @MessagePattern('payments.nested')
  @Idempotent({ keyFrom: { payload: 'meta.requestId' } })
  nested(@Payload() data: { amount: number }) {
    return { n: hit('nested'), amount: data.amount };
  }

  @EventPattern('order.created')
  @Idempotent()
  async orderCreated(@Payload() data: { idempotencyKey: string; orderId: number }) {
    state.events.push(data.idempotencyKey);
    await sleep(10); // keep the lock held briefly, like real work would
  }
}

/** A second consumer of `order.created`: Nest runs every handler of an event. */
@Controller()
class AuditHandlers {
  @EventPattern('order.created')
  @Idempotent()
  async orderCreated(@Payload() data: { idempotencyKey: string }) {
    state.audited.push(data.idempotencyKey);
    await sleep(10);
  }
}

const store = new InMemoryIdempotencyStore();

@Module({
  imports: [
    IdempotencyModule.forRoot({
      scope: {
        // Would throw if it ran for messages: they carry no req.user.
        http: (req: { user: { id: string } }) => req.user.id,
        rpc: (payload) => (payload as { tenant?: string } | undefined)?.tenant,
      },
    }),
  ],
  controllers: [PaymentsHandlers, AuditHandlers],
  providers: [registered(store)],
})
class RpcAppModule {}

describe('Idempotency (rpc over TCP)', () => {
  let microservice: INestMicroservice;
  let client: ClientProxy;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [RpcAppModule] }).compile();
    microservice = moduleRef.createNestMicroservice({
      transport: Transport.TCP,
      options: { host: '127.0.0.1', port: 0 },
    });
    microservice.useLogger(false);
    await microservice.listen();

    const { port } = microservice.unwrap<Server>().address() as AddressInfo;
    client = ClientProxyFactory.create({
      transport: Transport.TCP,
      options: { host: '127.0.0.1', port },
    });
    await client.connect();
  });
  afterAll(async () => {
    state.gate?.resolve();
    await client?.close();
    await microservice?.close();
  });
  beforeEach(() => {
    store.clear();
    state.calls = {};
    state.events = [];
    state.audited = [];
    state.gate = undefined;
    state.started = undefined;
  });

  const send = (pattern: unknown, data: unknown) =>
    firstValueFrom(client.send(pattern, data));
  const sendError = (pattern: unknown, data: unknown) =>
    send(pattern, data).then(
      () => {
        throw new Error('expected an error');
      },
      (err) => err,
    );

  it('replays the stored result for a duplicate message (key in payload)', async () => {
    const first = await send('payments.charge', { idempotencyKey: 'k1', amount: 10 });
    const retry = await send('payments.charge', { idempotencyKey: 'k1', amount: 10 });
    expect(first).toEqual({ chargeId: 'ch_1', amount: 10 });
    expect(retry).toEqual(first);
    expect(state.calls.charge).toBe(1);
  });

  it('rejects the same key with a different payload as a structured RpcException', async () => {
    await send('payments.charge', { idempotencyKey: 'k1', amount: 10 });
    const err = await sendError('payments.charge', { idempotencyKey: 'k1', amount: 99 });
    expect(err).toMatchObject({
      status: 'error',
      code: 'IDEMPOTENCY_KEY_REUSED',
      statusCode: 422,
    });
    expect(state.calls.charge).toBe(1);
  });

  it('rejects a missing required key', async () => {
    const err = await sendError({ cmd: 'payments.slow' }, {});
    expect(err).toMatchObject({ code: 'IDEMPOTENCY_KEY_REQUIRED', statusCode: 400 });
    expect(state.calls.slow).toBeUndefined();
  });

  it('rejects a concurrent duplicate with the default retryAfter (1 s)', async () => {
    state.gate = deferred();
    state.started = deferred();
    const first = send({ cmd: 'payments.slow' }, { idempotencyKey: 'k1' });
    await state.started.promise;

    const err = await sendError({ cmd: 'payments.slow' }, { idempotencyKey: 'k1' });
    expect(err).toMatchObject({ code: 'IDEMPOTENCY_KEY_IN_USE', statusCode: 409 });
    expect(err.retryAfter).toBe(1);

    state.gate.resolve();
    expect(await first).toEqual({ ok: true });
    expect(state.calls.slow).toBe(1);
  });

  it('applies only the rpc entry of a per-context scope', async () => {
    const a = await send('payments.charge', { idempotencyKey: 'k1', tenant: 't1', amount: 1 });
    const b = await send('payments.charge', { idempotencyKey: 'k1', tenant: 't2', amount: 1 });
    expect(a).toEqual({ chargeId: 'ch_1', amount: 1 });
    expect(b).toEqual({ chargeId: 'ch_2', amount: 1 });

    // Records are per handler: <scope>:<key>:<Class>.<method>.
    expect(store.peek('t1:k1:PaymentsHandlers.charge')?.state).toBe('completed');
    expect(store.peek('t2:k1:PaymentsHandlers.charge')?.state).toBe('completed');
  });

  it('stores and replays an RpcException (deterministic rejection)', async () => {
    const first = await sendError('payments.decline', { idempotencyKey: 'k1' });
    const retry = await sendError('payments.decline', { idempotencyKey: 'k1' });
    expect(first).toEqual({ code: 'card_declined', message: 'Card declined' });
    expect(retry).toEqual(first);
    expect(state.calls.decline).toBe(1);
  });

  it('releases the key on an RpcException with a 5xx statusCode', async () => {
    const first = await sendError('payments.unavailable', { idempotencyKey: 'k1' });
    expect(first).toEqual({ statusCode: 503, message: 'Ledger unavailable' });
    expect(await send('payments.unavailable', { idempotencyKey: 'k1' })).toEqual({ ok: true });
    expect(state.calls.unavailable).toBe(2);
  });

  it('streams every value of a multi-value reply, and does not store half of it', async () => {
    const all = () =>
      lastValueFrom(client.send('payments.history', { idempotencyKey: 'k1' }).pipe(toArray()));

    expect(await all()).toEqual([{ page: 1 }, { page: 2 }, { page: 3 }]);
    expect(await all()).toEqual([{ page: 1 }, { page: 2 }, { page: 3 }]);
    expect(state.calls.history).toBe(2); // not replayable, so the key was released
    expect(store.size).toBe(0);
  });

  it('rejects a key that is not a string or a number', async () => {
    const err = await sendError('payments.charge', { idempotencyKey: { id: 1 }, amount: 1 });
    expect(err).toMatchObject({ code: 'IDEMPOTENCY_KEY_INVALID', statusCode: 400 });
    expect(state.calls.charge).toBeUndefined();
  });

  it('reads the key from a configured payload path', async () => {
    const data = { meta: { requestId: 'r1' }, amount: 5 };
    await send('payments.nested', data);
    expect(await send('payments.nested', data)).toEqual({ n: 1, amount: 5 });
    expect(state.calls.nested).toBe(1);
  });

  it('skips duplicate events (fire-and-forget dedup)', async () => {
    const emit = (key: string) =>
      firstValueFrom(client.emit('order.created', { idempotencyKey: key, orderId: 1 }), {
        defaultValue: undefined,
      });

    // Duplicates arriving while the first is still processing (rejected as
    // in flight) and after it completed (replayed = no-op) are both skipped.
    await emit('e1');
    await emit('e1');
    await until(() => state.events.includes('e1'));
    await sleep(30);

    await emit('e1');
    await emit('e2');
    await until(() => state.events.includes('e2'));
    await sleep(30);

    expect(state.events.filter((k) => k === 'e1')).toHaveLength(1);
    expect(state.events.filter((k) => k === 'e2')).toHaveLength(1);
  });

  it('keeps one record per handler, so every handler of an event runs once', async () => {
    const emit = () =>
      firstValueFrom(client.emit('order.created', { idempotencyKey: 'e1', orderId: 1 }), {
        defaultValue: undefined,
      });

    await emit();
    await until(() => state.events.length === 1 && state.audited.length === 1);
    await sleep(30);

    await emit(); // redelivered: both handlers skip it
    await sleep(50);

    expect(state.events).toEqual(['e1']);
    expect(state.audited).toEqual(['e1']);
    expect(store.peek('e1:PaymentsHandlers.orderCreated')?.state).toBe('completed');
    expect(store.peek('e1:AuditHandlers.orderCreated')?.state).toBe('completed');
  });
});
