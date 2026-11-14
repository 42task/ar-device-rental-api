import type { RentalAuth } from '../auth';
import type { Context, Row } from '../core/contracts';
import { ApiError } from '../core/errors';
import type { ApiRouter } from '../core/router';
import { requireRoot } from '../core/roles';
import { DeviceService } from '../devices/service';
import { currentMerchant } from './context';
import { MerchantRegistry, merchantId, merchantOrigin } from './registry';

const field = (value: unknown, label: string, max: number) => {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max || /[\x00-\x1f\x7f]/.test(value)) throw new ApiError(422, label + '无效');
  return value.trim();
};
export function registerMerchants(router: ApiRouter, registry: MerchantRegistry, auth: RentalAuth): void {
  const root = async (ctx: Context) => { const identity = await auth.authenticate(ctx); requireRoot(identity.user); return identity; };
  router.add('GET', '/v2/rental/admin/merchants', async ctx => {
    await root(ctx);
    const rows = await registry.db.query('SELECT * FROM ar_merchant ORDER BY id');
    return { items: await Promise.all(rows.map(row => registry.describe(row))), currentMerchantId: currentMerchant()?.id ?? 1 };
  });
  router.add('GET', '/v2/rental/admin/merchants/:id', async ctx => { await root(ctx); return { merchant: await registry.describe(await registry.row(merchantId(ctx.params.id))) }; });
  const save = async (ctx: Context, editing: boolean) => {
    const actor = await root(ctx), input = ctx.body;
    const id = editing ? merchantId(ctx.params.id) : undefined;
    let savedId: number;
    try {
      savedId = await registry.db.transaction(async db => {
        const actorRow = await db.one('SELECT * FROM ar_user WHERE id=? FOR UPDATE', [actor.user.id]);
        if (!actorRow) throw new ApiError(403, '平台权限已变更');
        requireRoot(actorRow);
        const previous = id ? await db.one('SELECT * FROM ar_merchant WHERE id=? FOR UPDATE', [id]) : null;
        if (id && !previous) throw new ApiError(404, '商户不存在');
        const name = field(input.name ?? previous?.name, '商户名称', 128);
        const code = field(input.code ?? previous?.code, '商户编号', 64);
        if (!/^[a-z][a-z0-9_-]{0,63}$/.test(code)) throw new ApiError(422, '商户编号须为小写字母开头的英文、数字、下划线或连字符');
        const { origin, hostname } = merchantOrigin(input.origin ?? previous?.origin);
        const appId = input.appId ?? previous?.app_id;
        if (typeof appId !== 'string' || !/^wx[0-9a-f]{16}$/.test(appId)) throw new ApiError(422, '小程序 AppID 无效');
        const status = input.status ?? previous?.status ?? 'draft';
        if (!['draft', 'active', 'paused'].includes(status)) throw new ApiError(422, '商户状态无效');
        if (previous && (origin !== previous.origin || appId !== previous.app_id)) {
          const used = await db.one('SELECT (SELECT COUNT(*) FROM ar_user WHERE merchant_id=?) + (SELECT COUNT(*) FROM ar_device WHERE merchant_id=?) + (SELECT COUNT(*) FROM ar_rental_order WHERE merchant_id=?) AS total', [id, id, id]);
          if (Number(used?.total) || id === 1) throw new ApiError(409, '已有业务的商户须保留原域名和小程序身份');
        }
        const now = Date.now();
        const merchant = previous ?? await db.insert('ar_merchant', { code, name, origin, hostname, app_id: appId, status, created_ms: now, updated_ms: now });
        const ownerId = Number(merchant.id);
        const oldConfig = previous ? await db.one('SELECT * FROM ar_merchant_wechat_config WHERE id=? AND merchant_id=?', [previous.active_config_id, ownerId]) : null;
        const credentials = input.credentials;
        if (credentials !== undefined && (!credentials || typeof credentials !== 'object' || Array.isArray(credentials))) throw new ApiError(422, '商户凭据格式无效');
        const supplied: Record<string, string> = {};
        for (const key of ['appSecret', 'privateKey', 'apiV3Key', 'serialNo', 'platformKeyId', 'platformPublicKey']) {
          const value = credentials?.[key];
          if (value !== undefined && (typeof value !== 'string' || value.length > 16000)) throw new ApiError(422, '商户凭据格式无效');
          if (typeof value === 'string' && value.trim()) supplied[key] = value.trim();
        }
        const mchId = input.mchId ?? oldConfig?.mch_id ?? (oldConfig?.source === 'legacy' ? registry.defaultClient.config.mchId : '') ?? '';
        if (typeof mchId !== 'string' || mchId && !/^[0-9]{1,32}$/.test(mchId)) throw new ApiError(422, '微信商户号无效');
        if (input.payEnabled !== undefined && typeof input.payEnabled !== 'boolean') throw new ApiError(422, '支付开关无效');
        const previousMchId = oldConfig?.mch_id || (oldConfig?.source === 'legacy' ? registry.defaultClient.config.mchId || '' : '');
        const accountChanged = !!oldConfig && mchId !== previousMchId;
        const payEnabled = input.payEnabled ?? (accountChanged ? false : oldConfig?.pay_enabled === null ? registry.defaultClient.config.payEnabled : !!oldConfig?.pay_enabled) ?? false;
        const configChanged = !oldConfig || Object.keys(supplied).length > 0 || input.payEnabled !== undefined && input.payEnabled !== (oldConfig.pay_enabled === null ? !!registry.defaultClient.config.payEnabled : !!oldConfig.pay_enabled)
          || mchId !== (oldConfig.mch_id || (oldConfig.source === 'legacy' ? registry.defaultClient.config.mchId || '' : '')) || appId !== oldConfig.app_id || origin !== previous?.origin;
        let configId = Number(oldConfig?.id);
        if (configChanged) {
          const priorValues = oldConfig ? await registry.credentials(oldConfig) : {};
          if (oldConfig && appId !== oldConfig.app_id) delete priorValues.appSecret;
          // A new receiving account needs its own payment credentials. Only the mini-program secret carries over.
          const values = { ...(accountChanged ? { appSecret: priorValues.appSecret || '' } : priorValues), ...supplied };
          if (accountChanged && payEnabled && ['privateKey', 'apiV3Key', 'serialNo', 'platformKeyId', 'platformPublicKey'].some(key => !values[key])) throw new ApiError(422, '更换微信商户号后须配置该账户完整支付凭据，或先关闭支付');
          const legacy = oldConfig?.source === 'legacy' && !Object.keys(supplied).length && mchId === (registry.defaultClient.config.mchId || '') && appId === registry.defaultClient.config.appId;
          const ciphertext = !legacy && Object.keys(values).some(key => values[key]) ? registry.secrets.encrypt(values, String(ownerId)) : null;
          const config = await db.insert('ar_merchant_wechat_config', { merchant_id: ownerId, version: Number(oldConfig?.version || 0) + 1,
            source: legacy ? 'legacy' : 'managed', app_id: appId, mch_id: mchId || null, pay_enabled: payEnabled ? 1 : 0,
            secret_ciphertext: ciphertext, created_ms: now });
          configId = Number(config.id);
        }
        await db.execute('UPDATE ar_merchant SET code=?,name=?,origin=?,hostname=?,app_id=?,status=?,active_config_id=?,updated_ms=? WHERE id=?', [code, name, origin, hostname, appId, status, configId, now, ownerId]);
        await db.insert('ar_merchant_audit', { actor_user_id: actor.user.id, merchant_id: ownerId, action: editing ? 'MERCHANT_UPDATED' : 'MERCHANT_CREATED', target_id: ownerId, reason: typeof input.reason === 'string' ? input.reason.slice(0, 255) : '平台管理商户配置', created_ms: now });
        return ownerId;
      });
    } catch (error: any) { if (error?.code === 'ER_DUP_ENTRY') throw new ApiError(409, '商户编号、域名或小程序 AppID 已被使用'); throw error; }
    return { merchant: await registry.describe(await registry.row(savedId)) };
  };
  router.add('POST', '/v2/rental/admin/merchants', ctx => save(ctx, false));
  router.add('PATCH', '/v2/rental/admin/merchants/:id', ctx => save(ctx, true));
  router.add('POST', '/v2/rental/admin/devices/:id/merchant', async ctx => {
    const actor = await root(ctx), id = merchantId(ctx.params.id), target = merchantId(ctx.body.merchantId);
    await registry.row(target);
    const reason = field(ctx.body.reason, '调拨原因', 255);
    const device = await registry.db.transaction(async db => {
      // Match rental settlement's device -> account lock order.
      const row = await db.one('SELECT * FROM ar_device WHERE id=? FOR UPDATE', [id]);
      if (!row) throw new ApiError(404, '设备不存在');
      const user = await db.one('SELECT * FROM ar_user WHERE id=? FOR UPDATE', [actor.user.id]);
      if (!user) throw new ApiError(403, '平台权限已变更');
      requireRoot(user);
      if (Number(row.merchant_id) === target) return row;
      const slot = await db.one('SELECT * FROM ar_rental_slot WHERE device_id=?', [id]);
      const unresolved = await db.one("SELECT id FROM ar_rental_order WHERE device_id=? AND (status IN ('PENDING_PAYMENT','ACTIVE') OR ((status='COMPENSATING' OR refund_amount_cents>0) AND (refund_status IS NULL OR refund_status<>'SUCCESS'))) LIMIT 1", [id]);
      if (slot || unresolved) throw new ApiError(409, '设备仍有租赁、待支付或未完成退款，暂不能调拨');
      await db.execute('UPDATE ar_device SET merchant_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=?', [target, id]);
      await db.execute('UPDATE ar_rental_config SET merchant_id=?,enabled=0,version=version+1,updated_by=?,updated_ms=? WHERE device_id=?', [target, actor.user.id, Date.now(), id]);
      await db.insert('ar_merchant_audit', { actor_user_id: actor.user.id, merchant_id: target, previous_merchant_id: row.merchant_id, target_id: id, action: 'DEVICE_TRANSFERRED', reason, created_ms: Date.now() });
      return { ...row, merchant_id: target };
    });
    return { device: { ...DeviceService.display(device), merchantId: target }, requiresNewQr: true, requiresRentalConfiguration: true };
  });
}
