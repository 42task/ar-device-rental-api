import type { RentalAuth } from '../auth';
import type { Context, Row } from '../core/contracts';
import { ApiError } from '../core/errors';
import type { ApiRouter } from '../core/router';
import { requireRoot } from '../core/roles';
import { DeviceService } from '../devices/service';
import { currentMerchant } from './context';
import { MerchantRegistry, merchantId, merchantOrigin } from './registry';
import { validatePaymentConfiguration } from '../payments/configuration';

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
        const ownerIdInput = input.miniappOwnerId === undefined ? (previous ? previous.miniapp_owner_id ?? null : 1) : input.miniappOwnerId;
        const miniappOwnerId = ownerIdInput === null ? null : merchantId(ownerIdInput);
        const owner = miniappOwnerId === null ? null : await db.one('SELECT * FROM ar_merchant WHERE id=? FOR UPDATE', [miniappOwnerId]);
        if (miniappOwnerId !== null && (!owner || Number(owner.id) === id || owner.miniapp_owner_id != null)) throw new ApiError(422, '请选择独立小程序入口所属商户');
        const { origin, hostname } = merchantOrigin(owner?.origin ?? input.origin ?? previous?.origin);
        const appId = owner?.app_id ?? input.appId ?? previous?.app_id;
        if (typeof appId !== 'string' || !/^wx[0-9a-f]{16}$/.test(appId)) throw new ApiError(422, '小程序 AppID 无效');
        const status = input.status ?? previous?.status ?? 'draft';
        if (!['draft', 'active', 'paused'].includes(status)) throw new ApiError(422, '商户状态无效');
        const entryName = input.entryName === undefined ? undefined : field(input.entryName, '小程序入口名称', 128);
        const entryStatus = input.entryStatus;
        if (entryStatus !== undefined && !['active', 'paused'].includes(entryStatus)) throw new ApiError(422, '小程序入口注册状态无效');
        if (miniappOwnerId !== null && (entryName !== undefined || entryStatus !== undefined)) throw new ApiError(422, '共享入口请在入口所属商户维护');
        if (previous && (origin !== previous.origin || appId !== previous.app_id || miniappOwnerId !== (previous.miniapp_owner_id ?? null))) {
          const used = await db.one('SELECT (SELECT COUNT(*) FROM ar_user WHERE merchant_id=?) + (SELECT COUNT(*) FROM ar_device WHERE merchant_id=?) + (SELECT COUNT(*) FROM ar_rental_order WHERE merchant_id=?) + (SELECT COUNT(*) FROM ar_venue WHERE merchant_id=?) AS total', [id, id, id, id]);
          if (Number(used?.total) || id === 1) throw new ApiError(409, '已有业务的商户须保留原域名和小程序身份');
          if (previous.miniapp_owner_id == null && await db.one('SELECT id FROM ar_user_wechat_identity WHERE appid=? LIMIT 1', [previous.app_id])) throw new ApiError(409, '已有用户登录的小程序入口不能直接更换');
          const dependents = await db.one('SELECT id FROM ar_merchant WHERE miniapp_owner_id=? LIMIT 1', [id]);
          if (dependents) throw new ApiError(409, '该小程序入口已被其他商户使用，不能更换入口');
        }
        const now = Date.now();
        const merchant = previous ?? await db.insert('ar_merchant', { code, name, origin, hostname, app_id: appId, miniapp_owner_id: miniappOwnerId, status, created_ms: now, updated_ms: now });
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
        if (miniappOwnerId !== null && supplied.appSecret) throw new ApiError(422, '共享小程序的 AppSecret 请在入口所属商户配置');
        const appSecret = supplied.appSecret;
        if (appSecret && (appSecret.length > 256 || /[\s\x00-\x1f\x7f]/.test(appSecret))) throw new ApiError(422, '小程序 AppSecret 格式无效');
        delete supplied.appSecret;
        if (input.replaceCredentials !== undefined && typeof input.replaceCredentials !== 'boolean') throw new ApiError(422, '完整替换凭据选项无效');
        const mchId = input.mchId ?? oldConfig?.mch_id ?? (oldConfig?.source === 'legacy' ? registry.defaultClient.config.mchId : '') ?? '';
        if (typeof mchId !== 'string' || mchId && !/^[0-9]{1,32}$/.test(mchId)) throw new ApiError(422, '微信商户号无效');
        if (input.payEnabled !== undefined && typeof input.payEnabled !== 'boolean') throw new ApiError(422, '支付开关无效');
        const previousMchId = oldConfig?.mch_id || (oldConfig?.source === 'legacy' ? registry.defaultClient.config.mchId || '' : '');
        const accountChanged = !!oldConfig && mchId !== previousMchId;
        const payEnabled = input.payEnabled ?? (accountChanged ? false : oldConfig?.pay_enabled === null ? registry.defaultClient.config.payEnabled : !!oldConfig?.pay_enabled) ?? false;
        const configChanged = !oldConfig || input.replaceCredentials === true || Object.keys(supplied).length > 0 || miniappOwnerId !== (previous?.miniapp_owner_id ?? null) || input.payEnabled !== undefined && input.payEnabled !== (oldConfig.pay_enabled === null ? !!registry.defaultClient.config.payEnabled : !!oldConfig.pay_enabled)
          || mchId !== (oldConfig.mch_id || (oldConfig.source === 'legacy' ? registry.defaultClient.config.mchId || '' : '')) || appId !== oldConfig.app_id || origin !== previous?.origin;
        let configId = Number(oldConfig?.id);
        if (configChanged) {
          const priorValues = oldConfig && !input.replaceCredentials && !accountChanged ? await registry.credentials(oldConfig) : {};
          delete priorValues.appSecret;
          const candidate = validatePaymentConfiguration({ appId, mchId, credentials: { ...priorValues, ...supplied } }, { requireComplete: payEnabled || input.replaceCredentials === true });
          const values = candidate.credentials;
          const legacy = !input.replaceCredentials && oldConfig?.source === 'legacy' && !Object.keys(supplied).length && mchId === (registry.defaultClient.config.mchId || '') && appId === registry.defaultClient.config.appId;
          const ciphertext = !legacy && Object.keys(values).some(key => values[key]) ? registry.secrets.encrypt(values, String(ownerId)) : null;
          const config = await db.insert('ar_merchant_wechat_config', { merchant_id: ownerId, version: Number(oldConfig?.version || 0) + 1,
            source: legacy ? 'legacy' : 'managed', app_id: appId, mch_id: mchId || null, pay_enabled: payEnabled ? 1 : 0,
            secret_ciphertext: ciphertext, validated_ms: candidate.complete ? now : null, created_ms: now });
          configId = Number(config.id);
        }
        await db.execute('UPDATE ar_merchant SET code=?,name=?,origin=?,hostname=?,app_id=?,miniapp_owner_id=?,status=?,active_config_id=?,updated_ms=? WHERE id=?', [code, name, origin, hostname, appId, miniappOwnerId, status, configId, now, ownerId]);
        await registry.applications.saveForMerchant(db, { ...merchant, name, code, origin, hostname, app_id: appId }, appSecret, miniappOwnerId, { name: entryName, status: entryStatus });
        await db.insert('ar_merchant_audit', { actor_user_id: actor.user.id, merchant_id: ownerId, action: editing ? 'MERCHANT_UPDATED' : 'MERCHANT_CREATED', target_id: ownerId, reason: typeof input.reason === 'string' ? input.reason.slice(0, 255) : '平台管理商户配置', created_ms: now });
        return ownerId;
      });
    } catch (error: any) { if (error?.code === 'ER_DUP_ENTRY') throw new ApiError(409, '商户编号或独立小程序入口已被使用；共用小程序请选择已有入口'); throw error; }
    return { merchant: await registry.describe(await registry.row(savedId)) };
  };
  router.add('POST', '/v2/rental/admin/merchants', ctx => save(ctx, false));
  router.add('PATCH', '/v2/rental/admin/merchants/:id', ctx => save(ctx, true));
  router.add('POST', '/v2/rental/admin/devices/:id/merchant', async ctx => {
    const actor = await root(ctx), id = merchantId(ctx.params.id), target = merchantId(ctx.body.merchantId), targetVenueId = merchantId(ctx.body.venueId);
    const reason = field(ctx.body.reason, '调拨原因', 255);
    const device = await registry.db.transaction(async db => {
      // Match rental settlement's device -> account lock order.
      const row = await db.one('SELECT * FROM ar_device WHERE id=? FOR UPDATE', [id]);
      if (!row) throw new ApiError(404, '设备不存在');
      const user = await db.one('SELECT * FROM ar_user WHERE id=? FOR UPDATE', [actor.user.id]);
      if (!user) throw new ApiError(403, '平台权限已变更');
      requireRoot(user);
      // The unique root actor lock above also serializes entry metadata edits.
      const targetMerchant = await db.one('SELECT * FROM ar_merchant WHERE id=?', [target]);
      if (!targetMerchant) throw new ApiError(404, '目标商户不存在');
      const targetVenue = await db.one('SELECT * FROM ar_venue WHERE id=? AND merchant_id=? FOR UPDATE', [targetVenueId, target]);
      if (!targetVenue || targetVenue.status !== 'active') throw new ApiError(422, '请选择目标商户已启用的场地');
      const sourceMerchant = await db.one('SELECT * FROM ar_merchant WHERE id=?', [row.merchant_id]);
      const requiresNewQr = !sourceMerchant || sourceMerchant.origin !== targetMerchant.origin || sourceMerchant.app_id !== targetMerchant.app_id;
      if (Number(row.merchant_id) === target && Number(row.venue_id) === targetVenueId) return { ...row, venue_name: targetVenue.name, requiresNewQr: false, requiresRentalConfiguration: false };
      const slot = await db.one('SELECT * FROM ar_rental_slot WHERE device_id=?', [id]);
      const unresolved = await db.one("SELECT id FROM ar_rental_order WHERE device_id=? AND (status IN ('PENDING_PAYMENT','ACTIVE') OR ((status='COMPENSATING' OR refund_amount_cents>0) AND (refund_status IS NULL OR refund_status<>'SUCCESS'))) LIMIT 1", [id]);
      if (slot || unresolved) throw new ApiError(409, '设备仍有租赁、待支付或未完成退款，暂不能调拨');
      await db.execute('UPDATE ar_device SET merchant_id=?,venue_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=?', [target, targetVenueId, id]);
      await db.execute('UPDATE ar_rental_config SET merchant_id=?,enabled=0,version=version+1,updated_by=?,updated_ms=? WHERE device_id=?', [target, actor.user.id, Date.now(), id]);
      await db.insert('ar_merchant_audit', { actor_user_id: actor.user.id, merchant_id: target, previous_merchant_id: row.merchant_id, target_id: id, action: 'DEVICE_TRANSFERRED', reason, created_ms: Date.now() });
      return { ...row, merchant_id: target, venue_id: targetVenueId, venue_name: targetVenue.name, requiresNewQr, requiresRentalConfiguration: true };
    });
    return { device: { ...DeviceService.display(device), merchantId: target }, requiresNewQr: device.requiresNewQr, requiresRentalConfiguration: device.requiresRentalConfiguration };
  });
}
