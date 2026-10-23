/**
 * A body no parser had read when the key is checked isn't in the default fingerprint: multipart,
 * which `FileInterceptor()` parses inside the global interceptor, or a type no body parser
 * handles. The interceptor warns once per handler without a custom `fingerprint`, and still
 * replays. A body the fingerprint does see (JSON, a raw Buffer) and a request without a body stay
 * quiet.
 */
import { Body, Controller, Logger, Module, Post, Req, UseInterceptors, type INestApplication } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import express from 'express';
import request from 'supertest';
import { adapters, createApp } from './support/adapters.js';
import { IdempotencyModule, Idempotent, InMemoryIdempotencyStore } from '../lib/index.js';
import { registered } from './register.js';

const calls: Record<string, number> = {};
const hit = (name: string) => (calls[name] = (calls[name] ?? 0) + 1);

/** One handler per test: each warning is logged once per handler, for the app's lifetime. */
@Controller()
class UploadsController {
  @Post('receipts')
  @Idempotent()
  @UseInterceptors(FileInterceptor('file'))
  receipt(@Req() req: any) {
    hit('receipt');
    return { note: req.body.note, file: req.file.buffer.toString() };
  }

  @Post('avatars')
  @Idempotent()
  @UseInterceptors(FileInterceptor('file'))
  avatar() {
    return { avatar: hit('avatar') };
  }

  /** What the warning suggests: a hash of the field values and file bytes, sent by the client. */
  @Post('hashed')
  @Idempotent({ fingerprint: (_body, context) => context.switchToHttp().getRequest().headers['x-content-hash'] })
  @UseInterceptors(FileInterceptor('file'))
  hashed() {
    return { hashed: hit('hashed') };
  }

  @Post('notes')
  @Idempotent()
  note(@Body() body: unknown) {
    return { note: hit('note'), body };
  }

  @Post('blobs')
  @Idempotent()
  blob(@Body() body: Buffer) {
    return { blob: hit('blob'), length: body.length };
  }

  @Post('pings')
  @Idempotent()
  ping() {
    return { ping: hit('ping') };
  }

  @Post('key-values')
  @Idempotent()
  keyValues(@Body() body: unknown) {
    return { keyValues: hit('keyValues'), body };
  }
}

@Controller('orders')
class OrdersController {
  @Post()
  @Idempotent()
  create(@Body() body: unknown) {
    return { order: hit('order'), body };
  }
}

const unread = (warn: { mock: { calls: unknown[][] } }) =>
  warn.mock.calls.map(([message]) => String(message)).filter((m) => m.includes('no parser had read'));

describe('a body no parser had read (express)', () => {
  const store = new InMemoryIdempotencyStore();
  let app: INestApplication;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    @Module({
      imports: [IdempotencyModule.forRoot()],
      controllers: [UploadsController],
      providers: [registered(store)],
    })
    class AppModule {}

    app = await createApp('express', AppModule, {
      setup: (a) => {
        a.useLogger(false);
        a.use('/blobs', express.raw({ type: 'application/octet-stream' }));
        // What `attachFieldsToBody: 'keyValues'` (Fastify) leaves for a form whose only part is a file `onFile` didn't buffer.
        a.use('/key-values', (req: any, _res: unknown, next: () => void) => {
          req.body = {};
          next();
        });
      },
    });
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(() => {
    store.clear();
    for (const name of Object.keys(calls)) {
      delete calls[name];
    }
    warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const upload = (path: string, note: string, file: string, key?: string) => {
    const req = request(app.getHttpServer()).post(path);
    if (key) {
      req.set('Idempotency-Key', key);
    }
    return req.field('note', note).attach('file', Buffer.from(file), 'receipt.txt');
  };

  it('warns once about a multipart body, and still replays a key reused with other content', async () => {
    const first = await upload('/receipts', 'first', 'one', 'k1');
    const reused = await upload('/receipts', 'second', 'two', 'k1');
    await upload('/receipts', 'third', 'three', 'k2');

    expect(first.status).toBe(201);
    expect(reused.status).toBe(201);
    expect(reused.headers['idempotent-replayed']).toBe('true');
    expect(reused.body).toEqual({ note: 'first', file: 'one' });
    expect(calls.receipt).toBe(2);
    expect(unread(warn)).toEqual([
      expect.stringContaining('UploadsController.receipt received a body (multipart/form-data) that no parser had read'),
    ]);
  });

  it('stays quiet for a request without a key, which runs unprotected', async () => {
    expect((await upload('/avatars', 'a', 'b')).status).toBe(201);
    expect(unread(warn)).toEqual([]);
  });

  it('stays quiet with a custom fingerprint, which rejects the reused key', async () => {
    expect((await upload('/hashed', 'a', 'b', 'k1').set('x-content-hash', 'h1')).status).toBe(201);
    const reused = await upload('/hashed', 'c', 'd', 'k1').set('x-content-hash', 'h2');
    expect(reused.status).toBe(422);
    expect(reused.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(unread(warn)).toEqual([]);
  });

  it('names a type no body parser handles, whatever its case and parameters', async () => {
    await request(app.getHttpServer()).post('/notes').set('Idempotency-Key', 'k1').set('Content-Type', 'Text/Plain; charset=utf-8').send('hello');
    expect(unread(warn)).toEqual([expect.stringContaining('UploadsController.note received a body (text/plain)')]);
  });

  it('stays quiet for a body a parser read into a Buffer', async () => {
    const res = await request(app.getHttpServer()).post('/blobs').set('Idempotency-Key', 'k1').set('Content-Type', 'application/octet-stream').send(Buffer.from('bytes'));
    expect(res.body).toEqual({ blob: 1, length: 5 });
    expect(unread(warn)).toEqual([]);
  });

  it('stays quiet for a request without a body', async () => {
    const res = await request(app.getHttpServer()).post('/pings').set('Idempotency-Key', 'k1').set('Content-Type', 'multipart/form-data; boundary=x').send('');
    expect(res.status).toBe(201);
    expect(unread(warn)).toEqual([]);
  });

  it('warns about an empty body object on a multipart request', async () => {
    const boundary = 'b0undary';
    const body = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.txt"\r\n\r\nabc\r\n--${boundary}--\r\n`;
    await request(app.getHttpServer()).post('/key-values').set('Idempotency-Key', 'k1').set('Content-Type', `MULTIPART/FORM-DATA; boundary=${boundary}`).send(body);
    expect(unread(warn)).toEqual([expect.stringContaining('UploadsController.keyValues received a body (multipart/form-data)')]);
  });
});

describe.each(adapters.map((a) => a.name))('a parsed body (%s)', (adapter) => {
  let app: INestApplication;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    @Module({
      imports: [IdempotencyModule.forRoot()],
      controllers: [OrdersController],
      providers: [registered(new InMemoryIdempotencyStore())],
    })
    class AppModule {}

    app = await createApp(adapter, AppModule, { setup: (a) => a.useLogger(false) });
    warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  it('stays quiet for a JSON object, and for an empty one', async () => {
    expect((await request(app.getHttpServer()).post('/orders').set('Idempotency-Key', 'k1').send({ amount: 1 })).status).toBe(201);
    expect((await request(app.getHttpServer()).post('/orders').set('Idempotency-Key', 'k2').send({})).status).toBe(201);
    expect(unread(warn)).toEqual([]);
  });
});
