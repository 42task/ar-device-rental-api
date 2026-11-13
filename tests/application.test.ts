import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApplication } from '../src/application';
import type { Database } from '../src/core/database';
import { ApiRouter } from '../src/core/router';
import { WeChatClient } from '../src/payments/wechat';
import { RentalAuth } from '../src/auth';
import express from 'express';
import { SCHEMA_VERSION } from '../src/core/migrations';

const appId = 'wx03dbf50c15cac06f';
const fakeDb = () => ({ query: async () => [{ one: 1 }], one: async () => ({ version: SCHEMA_VERSION }) }) as unknown as Database;
const build = () => {
  const db = fakeDb();
  const client = new WeChatClient({ appId, appSecret: '', payEnabled: false });
  const auth = new RentalAuth(db, client, { jwtSecret: 'unit-test-signing-key-with-32-bytes-minimum' });
  return createApplication({ db, client, auth });
};

describe('standalone API HTTP boundary', () => {
  it('mounts the actual mini-program login route and reports missing credentials as 503 rather than 404', async () => {
    const { app } = build();
    const result = await request(app).post('/api/v2/rental/auth/login').send({ code: 'unit-login-code' });
    expect(result.status).toBe(503);
    expect(result.body.message).toContain('AppSecret');
    expect(result.headers['cache-control']).toBe('no-store');
    expect(result.headers['x-powered-by']).toBeUndefined();
    const protectedDevice = await request(app).get('/api/v2/rental/devices/context?uuid=test-device');
    expect(protectedDevice.status).toBe(401);
  });
  it('checks its own schema and exposes no legacy backend endpoints', async () => {
    const { app } = build();
    expect((await request(app).get('/health')).body).toMatchObject({ status: 'healthy', schema: 'ready', payments: 'disabled' });
    expect((await request(app).get('/api/health')).status).toBe(200);
    expect((await request(app).get('/api/v2/files')).status).toBe(404);
    expect((await request(app).get('/api/v2/root/managers')).status).toBe(404);
    expect((await request(app).post('/api/v2/rental/payment-notify').send({})).status).not.toBe(200);
  });
  it('protects management reads and leaves static admin hosting to the separate frontend', async () => {
    const { app } = build();
    expect((await request(app).get('/admin/')).status).toBe(404);
    expect((await request(app).get('/api/v2/rental/admin/auth/session')).status).toBe(401);
    expect((await request(app).get('/api/v2/rental/admin/overview')).status).toBe(401);
    expect((await request(app).get('/api/v2/rental/admin/orders')).status).toBe(401);
  });
  it('rejects invalid JSON and oversized bodies without reflecting raw content', async () => {
    const { app } = build();
    const invalid = await request(app).post('/api/v2/rental/auth/login').set('Content-Type', 'application/json').send('{"code":"secret-not-for-response"');
    expect(invalid.status).toBe(400);
    expect(JSON.stringify(invalid.body)).not.toContain('secret-not-for-response');
    expect((await request(app).post('/api/v2/rental/auth/login').send({ code: 'x'.repeat(70000) })).status).toBe(413);
    expect((await request(app).post('/api/v2/rental/auth/login').send('code=test')).status).toBe(415);
  });
  it('limits login attempts without making provider requests', async () => {
    const { app } = build();
    for (let attempt = 0; attempt < 30; attempt++) expect((await request(app).post('/api/v2/rental/auth/login').send({ code: 'test' })).status).toBe(503);
    expect((await request(app).post('/api/v2/rental/auth/login').send({ code: 'test' })).status).toBe(429);
  });
  it('preserves callback raw bytes and matches the registered method only', async () => {
    const app = express();
    app.use(express.json({ verify(req, _res, bytes) { (req as any).rawBody = Buffer.from(bytes); } }));
    const router = new ApiRouter();
    router.add('POST', '/v2/callback', ctx => ({ raw: ctx.req.rawBody?.toString() }));
    router.mount(app);
    const raw = '{ "resource": 1 }\n';
    expect((await request(app).post('/api/v2/callback').set('Content-Type', 'application/json').send(raw)).body).toEqual({ raw });
    expect((await request(app).get('/api/v2/callback')).status).toBe(404);
  });
});
