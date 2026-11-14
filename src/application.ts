import express, { type ErrorRequestHandler } from 'express';
import { resolve } from 'node:path';
import { Database } from './core/database';
import { ApiError } from './core/errors';
import { ApiRouter } from './core/router';
import { RentalAuth } from './auth';
import { WeChatClient } from './payments/wechat';
import { registerRentals } from './rentals';
import { AdminAuth } from './admin/auth';
import { registerManagement } from './admin/management';
import { SCHEMA_VERSION } from './core/migrations';
import { PhoneBinding } from './auth/phone';
import { MerchantRegistry, merchantId } from './merchants/registry';
import { publicMerchant, withMerchant } from './merchants/context';
import { registerMerchants } from './merchants/management';
import { requireRoot } from './core/roles';

interface ApplicationOptions { db?: Database; client?: WeChatClient; auth?: RentalAuth; merchants?: MerchantRegistry | false }

export function createApplication(options: ApplicationOptions = {}) {
  const db = options.db ?? new Database();
  const client = options.client ?? new WeChatClient();
  const auth = options.auth ?? new RentalAuth(db, client);
  const admin = new AdminAuth(db, client, auth);
  const phone = new PhoneBinding(db, client, auth);
  const merchants = options.merchants === false ? undefined : options.merchants ?? new MerchantRegistry(db, client);
  auth.webAuthenticate = admin.authenticate;
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', process.env.TRUST_PROXY === '1' ? 1 : false);
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use(express.json({ limit: '64kb', verify(req, _res, raw) { (req as express.Request & { rawBody?: Buffer }).rawBody = Buffer.from(raw); } }));
  app.use((req, _res, next) => {
    if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
      if (!req.is('application/json')) return next(new ApiError(415, '请使用 application/json 请求格式'));
      if (req.body !== undefined && (req.body === null || Array.isArray(req.body) || typeof req.body !== 'object')) return next(new ApiError(400, '请求内容必须是 JSON 对象'));
    }
    next();
  });
  const attempts = new Map<string, { count: number; reset: number }>();
  const limitAuthentication = (namespace: string, limit: (req: express.Request) => number): express.RequestHandler => (req, _res, next) => {
    const now = Date.now();
    if (attempts.size >= 10000) for (const [key, value] of attempts) if (value.reset <= now) attempts.delete(key);
    const key = namespace + ':' + (req.method === 'GET' ? 'read:' : 'write:') + (req.ip || req.socket.remoteAddress || 'unknown');
    const previous = attempts.get(key);
    if (previous && previous.reset > now) {
      previous.count++;
      if (previous.count > limit(req)) return next(new ApiError(429, '登录请求过于频繁，请稍后再试'));
    } else {
      if (attempts.size >= 10000) return next(new ApiError(429, '登录服务繁忙，请稍后重试'));
      attempts.set(key, { count: 1, reset: now + 60000 });
    }
    next();
  };
  app.use('/api/v2/rental/auth', limitAuthentication('mini', () => 30));
  app.use('/api/v2/rental/admin/auth', limitAuthentication('admin', req => req.method === 'GET' ? 180 : 30));
  const router = new ApiRouter();
  if (merchants) {
    app.use('/api/v2', async (req, res, next) => {
      try {
        const remote = req.socket.remoteAddress || '';
        const directLoopback = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote) && !req.headers['x-forwarded-host'];
        // Host is accepted only after lookup in the merchant allowlist. Forwarded host is never used.
        const entry = await merchants.resolveHost(req.headers.host || '', directLoopback);
        await withMerchant({ entry, merchant: entry }, async () => {
          const selected = req.headers['x-merchant-id'];
          let merchant = entry;
          if (selected !== undefined) {
            if (typeof selected !== 'string') throw new ApiError(422, '商户编号无效');
            const principal = await auth.authenticate({ req, res, body: req.body || {}, query: req.query, params: req.params as Record<string, string> });
            requireRoot(principal.user);
            merchant = await merchants.runtime(merchantId(selected));
          }
          withMerchant({ entry, merchant }, () => next());
        });
      } catch (error) { next(error); }
    });
    router.add('GET', '/v2/rental/merchant', async () => {
      const { currentMerchant } = await import('./merchants/context');
      return { merchant: publicMerchant(currentMerchant()!) };
    });
    registerMerchants(router, merchants, auth);
  }
  auth.registerAuth(router);
  phone.register(router);
  admin.register(router);
  const rentals = registerRentals(router, { db }, { appId: client.config.appId || '', payment: client, authenticate: auth.authenticate,
    ...(merchants ? { resolvePaymentForOrder: (row: import('./core/contracts').Row) => merchants.paymentForOrder(row), resolvePaymentConfig: (id: number) => merchants.clientForConfig(id) } : {}) });
  registerManagement(router, db, auth, rentals);
  router.mount(app);
  app.get(/^\/admin$/, (_req, res) => res.redirect(302, '/admin/'));
  app.use('/admin/', (_req, res, next) => {
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'");
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    next();
  }, express.static(resolve('admin'), { index: 'index.html', dotfiles: 'deny', redirect: false, etag: false }));
  app.get(['/health', '/api/health'], async (_req, res) => {
    try {
      await db.query('SELECT 1');
      const schema = await db.one('SELECT version FROM ar_schema_meta WHERE name=?', ['ar-device-rental-api']);
      const healthy = Number(schema?.version) === SCHEMA_VERSION;
      let paymentReady = client.isPaymentReady();
      if (merchants && healthy) {
        try { const merchant = await merchants.runtime(1); paymentReady = merchant.status === 'active' && merchant.client.isPaymentReady(); }
        catch { paymentReady = false; }
      }
      res.status(healthy ? 200 : 503).json({ status: healthy ? 'healthy' : 'unhealthy', service: 'ar-device-rental-api', database: 'up', schema: healthy ? 'ready' : 'migration-required', payments: paymentReady ? 'enabled' : 'disabled', ...(process.env.GIT_COMMIT ? { gitCommit: process.env.GIT_COMMIT } : {}) });
    } catch { res.status(503).json({ status: 'unhealthy', service: 'ar-device-rental-api', database: 'unavailable' }); }
  });
  app.use((_req, _res, next) => next(new ApiError(404, '接口不存在')));
  const errorHandler: ErrorRequestHandler = (error, _req, res, next) => {
    if (res.headersSent) return next(error);
    const known = error instanceof ApiError;
    const bodyError = error?.type === 'entity.parse.failed';
    const tooLarge = error?.type === 'entity.too.large';
    const status = known ? error.status : bodyError ? 400 : tooLarge ? 413 : 500;
    res.status(status).json({ success: false, message: known ? error.message : bodyError ? 'JSON 格式无效' : tooLarge ? '请求内容过大' : '服务暂时不可用，请稍后重试', ...(known && error.code ? { code: error.code } : {}) });
  };
  app.use(errorHandler);
  return { app, db, client, auth, admin, phone, rentals, merchants };
}
