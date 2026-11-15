import type { RequestHandler } from 'express';

export const CLIENT_PROTOCOL = 2;
export const MIN_CLIENT_PROTOCOL = 2;
export const clientCapabilities = () => ({ currentClientProtocol: CLIENT_PROTOCOL, minClientProtocol: MIN_CLIENT_PROTOCOL,
  features: { merchantVenues: true, venuePriceVersion: true, explicitManagementScope: true, platformCustomers: true } });

/** Historical reads, authentication and signed provider notifications remain reachable. */
export const requireClientProtocol: RequestHandler = (req, res, next) => {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  const path = req.originalUrl.split('?')[0];
  const businessWrite = /^\/api\/v2\/rentals(?:\/|$)/.test(path)
    || /^\/api\/v2\/rental\/devices(?:\/|$)/.test(path)
    || /^\/api\/v2\/rental\/admin\/(?:venues|merchants|devices|users)(?:\/|$)/.test(path);
  if (!businessWrite) return next();
  const value = req.headers['x-client-protocol'];
  const protocol = typeof value === 'string' && /^\d{1,3}$/.test(value) ? Number(value) : 0;
  if (protocol >= MIN_CLIENT_PROTOCOL && protocol <= CLIENT_PROTOCOL) return next();
  res.status(426).json({ success: false, code: 'CLIENT_UPGRADE_REQUIRED', message: '当前版本需要更新，请重新打开小程序后重试',
    minClientProtocol: MIN_CLIENT_PROTOCOL, currentClientProtocol: CLIENT_PROTOCOL });
};
