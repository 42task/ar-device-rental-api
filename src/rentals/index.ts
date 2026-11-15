import type { Context, Services } from '../core/contracts';
import type { ApiRouter } from '../core/router';
import { RentalService } from './service';
import type { RentalOptions } from './types';

export { RentalService } from './service';
export type { RentalOptions, RentalPrincipal } from './types';
export { isRentalOrderNumber, isRentalRefundNumber } from './numbers';

export function registerRentals(router: ApiRouter, services: Services, options: RentalOptions): RentalService {
  const service = new RentalService(services, options);
  const route = (method: string, path: string, handler: (ctx: Context) => Promise<unknown>) => router.add(method, path, ctx => {
    ctx.res.setHeader('Cache-Control', 'no-store');
    return handler(ctx);
  });
  const identity = options.authenticate;
  route('GET', '/v2/rental/devices/context', async ctx => service.context(await identity(ctx), ctx.query.uuid));
  route('GET', '/v2/rental/admin/devices', async ctx => service.devices(await identity(ctx), ctx.query));
  route('POST', '/v2/rental/devices', async ctx => service.createDevice(await identity(ctx), ctx.body));
  route('PATCH', '/v2/rental/devices/:id/config', async ctx => service.configure(await identity(ctx), ctx.params.id, ctx.body));
  route('GET', '/v2/rentals', async ctx => service.list(await identity(ctx), ctx.query));
  route('POST', '/v2/rentals', async ctx => {
    const result = await service.create(await identity(ctx), ctx.body);
    ctx.res.status(201);
    return result;
  });
  route('GET', '/v2/rentals/:id', async ctx => service.get(await identity(ctx), ctx.params.id));
  route('POST', '/v2/rentals/:id/payment', async ctx => service.payment(await identity(ctx), ctx.params.id));
  route('POST', '/v2/rentals/:id/sync-payment', async ctx => service.syncPayment(await identity(ctx), ctx.params.id));
  route('POST', '/v2/rentals/:id/cancel', async ctx => service.cancel(await identity(ctx), ctx.params.id));
  route('POST', '/v2/rentals/:id/end', async ctx => service.end(await identity(ctx), ctx.params.id, ctx.body));
  route('POST', '/v2/rentals/:id/sync-refund', async ctx => service.syncRefund(await identity(ctx), ctx.params.id));
  route('POST', '/v2/rentals/:id/retry-refund', async ctx => service.retryRefund(await identity(ctx), ctx.params.id));
  route('POST', '/v2/rental/payment-notify', ctx => service.paymentNotification(ctx));
  route('POST', '/v2/rental/refund-notify', ctx => service.refundNotification(ctx));
  route('POST', '/v2/rental/payment-notify/:configId', ctx => service.paymentNotification(ctx));
  route('POST', '/v2/rental/refund-notify/:configId', ctx => service.refundNotification(ctx));
  return service;
}

/** Two backend nodes compete for durable job leases; provider writes stay idempotent. */
export function startRentalWorker(service: RentalService, intervalMs = 10000): { stop: () => Promise<void> } {
  let stopped = false;
  let active: Promise<void> | null = null;
  let lastFailureLog = 0;
  const run = () => {
    if (stopped || active) return;
    active = service.processJobs().catch(() => {
      // A bounded fixed message avoids leaking provider responses, payer IDs,
      // signatures or configuration through unexpected transport/SQL errors.
      if (Date.now() - lastFailureLog > 60000) {
        console.warn('[rental-worker] task processing unavailable; retry scheduled');
        lastFailureLog = Date.now();
      }
    }).finally(() => { active = null; });
  };
  const interval = setInterval(run, Math.max(1000, intervalMs));
  interval.unref();
  run();
  return { async stop() { stopped = true; clearInterval(interval); await active; } };
}
