import type { Express, RequestHandler } from 'express';
import type { Context, Handler, Route } from './contracts';

export class ApiRouter {
  readonly routes: Route[] = [];
  add(method: string | string[], path: string, handler: Handler): void {
    for (const value of Array.isArray(method) ? method : [method]) this.routes.push({ method: value.toUpperCase(), path, handler });
  }
  mount(app: Express, prefix = '/api'): void {
    for (const route of this.routes) {
      const handler: RequestHandler = async (req, res, next) => {
        try {
          const context: Context = { req, res, body: req.body || {}, query: req.query, params: req.params as Record<string, string> };
          const value = await route.handler(context);
          if (!res.headersSent) value === undefined ? res.status(204).end() : res.json(value);
        } catch (error) { next(error); }
      };
      app.route(prefix + route.path).all((req, res, next) => req.method === route.method ? handler(req, res, next) : next());
    }
  }
}
