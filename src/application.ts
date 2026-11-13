import express, { type ErrorRequestHandler } from 'express';
import { Database } from './core/database';
import { ApiError } from './core/errors';
import { ApiRouter } from './core/router';
import { RentalAuth } from './auth';
import { WeChatClient } from './payments/wechat';
import { registerRentals } from './rentals';

interface ApplicationOptions { db?: Database; client?: WeChatClient; auth?: RentalAuth }

export function createApplication(options: ApplicationOptions = {}) {
  const db = options.db ?? new Database();
  const client = options.client ?? new WeChatClient();
  const auth = options.auth ?? new RentalAuth(db, client);
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
  app.use('/api/v2/rental/auth', (req, _res, next) => {
    const now = Date.now();
    if (attempts.size >= 10000) for (const [key, value] of attempts) if (value.reset <= now) attempts.delete(key);
    const key = req.ip || req.socket.remoteAddress || 'unknown';
    const previous = attempts.get(key);
    if (previous && previous.reset > now) {
      previous.count++;
      if (previous.count > 30) return next(new ApiError(429, '登录请求过于频繁，请稍后再试'));
    } else {
      if (attempts.size >= 10000) return next(new ApiError(429, '登录服务繁忙，请稍后重试'));
      attempts.set(key, { count: 1, reset: now + 60000 });
    }
    next();
  });
  const router = new ApiRouter();
  auth.registerAuth(router);
  const rentals = registerRentals(router, { db }, { appId: client.config.appId || '', payment: client, authenticate: auth.authenticate });
  router.mount(app);
  app.get(['/health', '/api/health'], async (_req, res) => {
    try {
      await db.query('SELECT 1');
      const schema = await db.one('SELECT version FROM ar_schema_meta WHERE name=?', ['ar-device-rental-api']);
      const healthy = Number(schema?.version) === 1;
      res.status(healthy ? 200 : 503).json({ status: healthy ? 'healthy' : 'unhealthy', service: 'ar-device-rental-api', database: 'up', schema: healthy ? 'ready' : 'migration-required', payments: client.isPaymentReady() ? 'enabled' : 'disabled', ...(process.env.GIT_COMMIT ? { gitCommit: process.env.GIT_COMMIT } : {}) });
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
  return { app, db, client, auth, rentals };
}
