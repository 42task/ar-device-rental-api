import type { Database } from '../core/database';
import type { Row } from '../core/contracts';
import { ApiError } from '../core/errors';
import { WeChatClient } from '../payments/wechat';
import type { ApplicationEntry, MerchantRuntime } from './context';
import { MerchantSecrets } from './secrets';
import { ApplicationRegistry } from '../applications/registry';
import { validatePaymentConfiguration } from '../payments/configuration';

export const DEFAULT_ORIGIN = 'https://d.4mr.cn';
export function merchantOrigin(value: unknown): { origin: string; hostname: string } {
  try {
    if (typeof value !== 'string' || value.length > 255) throw Error();
    const url = new URL(value);
    if (url.origin !== value || url.protocol !== 'https:' || url.username || url.password || url.port || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(url.hostname)) throw Error();
    return { origin: url.origin, hostname: url.hostname };
  } catch { throw new ApiError(422, '商户域名须为不带路径的 HTTPS 域名'); }
}
export function merchantId(value: unknown): number {
  const id = typeof value === 'number' ? value : typeof value === 'string' && /^[1-9][0-9]*$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(id) || id < 1) throw new ApiError(422, '商户编号无效');
  return id;
}

export class MerchantRegistry {
  private readonly clients = new Map<string, WeChatClient>();
  readonly applications: ApplicationRegistry;
  constructor(readonly db: Database, readonly defaultClient: WeChatClient, readonly secrets = new MerchantSecrets()) {
    this.applications = new ApplicationRegistry(db, defaultClient, secrets);
  }
  async row(id: number): Promise<Row> {
    const row = await this.db.one('SELECT * FROM ar_merchant WHERE id=?', [id]);
    if (!row) throw new ApiError(404, '商户不存在');
    return row;
  }
  async resolveHost(host: string, directLoopback = false): Promise<ApplicationEntry> {
    return this.applications.resolveHost(host, directLoopback);
  }
  async runtime(id: number, existing?: Row): Promise<MerchantRuntime> {
    const row = existing ?? await this.row(id);
    const entry = await this.applications.forMerchant(id);
    const config = await this.db.one('SELECT * FROM ar_merchant_wechat_config WHERE id=? AND merchant_id=?', [row.active_config_id, id]);
    // Metadata and administration stay available if this merchant's payment
    // configuration is absent or corrupt. Only financial operations load history.
    let client = new WeChatClient({ allowEnvironmentFallback: false, appId: entry.app_id, payEnabled: false });
    if (config && config.app_id === entry.app_id) {
      try { client = await this.activeClient(config, row); } catch { /* Fail closed for new payments, not metadata. */ }
    }
    return { id, code: row.code, name: row.name, status: row.status, origin: entry.origin, appId: entry.app_id, configId: Number(config?.id || 0), miniappOwnerId: row.miniapp_owner_id == null ? null : Number(row.miniapp_owner_id), client };
  }
  private assertLegacyAccount(config: Row): void {
    if (Number(config.merchant_id) !== 1) throw new ApiError(503, '商户配置来源无效');
    if (config.app_id !== this.defaultClient.config.appId || config.mch_id && config.mch_id !== this.defaultClient.config.mchId) {
      throw new ApiError(503, '原支付账户与服务器默认凭据不一致，请由平台管理员修复');
    }
  }
  private async activeClient(config: Row, owner: Row): Promise<WeChatClient> {
    if (config.source === 'legacy') this.assertLegacyAccount(config);
    if (config.source === 'legacy' && Number(config.id) === 1 && config.pay_enabled === null) return this.defaultClient;
    const material = await this.credentials(config);
    if (config.source !== 'legacy') validatePaymentConfiguration({ appId: config.app_id, mchId: config.mch_id || '', credentials: material }, { requireComplete: !!config.pay_enabled });
    return this.buildClient(config, config, owner, material, [material]);
  }
  private buildClient(original: Row, effective: Row, owner: Row, values: Record<string, string>, history: Record<string, string>[]): WeChatClient {
    let platformKeys: Record<string, string> = {};
    const apiKeys: string[] = [];
    for (const material of history) {
      if (material.platformKeysJson) platformKeys = { ...platformKeys, ...JSON.parse(material.platformKeysJson) };
      if (material.platformKeyId && material.platformPublicKey) platformKeys[material.platformKeyId] = material.platformPublicKey;
      if (material.apiV3Key) apiKeys.push(material.apiV3Key);
    }
    if (values.platformKeysJson) platformKeys = { ...platformKeys, ...JSON.parse(values.platformKeysJson) };
    if (values.platformKeyId && values.platformPublicKey) platformKeys[values.platformKeyId] = values.platformPublicKey;
    return new WeChatClient({ allowEnvironmentFallback: false, appId: original.app_id, mchId: original.mch_id || (original.source === 'legacy' ? this.defaultClient.config.mchId || '' : ''),
      privateKey: values.privateKey || '', apiV3Key: values.apiV3Key || '', apiV3Keys: [...new Set([values.apiV3Key, ...apiKeys].filter(Boolean))].slice(0, 8),
      serialNo: values.serialNo || '', platformKeys, platformKeyId: values.platformKeyId || '',
      payEnabled: effective.pay_enabled === null ? this.defaultClient.config.payEnabled : !!effective.pay_enabled,
      notifyUrl: `${owner.origin}/api/v2/rental/payment-notify/${original.id}`, refundNotifyUrl: `${owner.origin}/api/v2/rental/refund-notify/${original.id}` });
  }
  async clientForConfig(id: number, existing?: Row, merchant?: Row): Promise<WeChatClient> {
    if (!Number.isSafeInteger(id) || id < 1) throw new ApiError(404, '支付配置不存在');
    const config = existing ?? await this.db.one('SELECT * FROM ar_merchant_wechat_config WHERE id=?', [id]);
    if (!config) throw new ApiError(503, '原订单支付配置不可用');
    if (config.source === 'legacy' && Number(config.merchant_id) !== 1) throw new ApiError(503, '商户配置来源无效');
    if (config.source === 'legacy' && !config.mch_id && this.defaultClient.config.mchId) {
      this.assertLegacyAccount(config);
      await this.db.execute('UPDATE ar_merchant_wechat_config SET mch_id=? WHERE id=? AND mch_id IS NULL', [this.defaultClient.config.mchId, id]);
      config.mch_id = this.defaultClient.config.mchId;
    }
    const accountId = config.mch_id || '';
    const versions = await this.db.query('SELECT * FROM ar_merchant_wechat_config WHERE merchant_id=? AND app_id=? ORDER BY version DESC', [config.merchant_id, config.app_id]);
    const history = versions.filter(row => (row.mch_id || (row.source === 'legacy' ? this.defaultClient.config.mchId || '' : '')) === accountId);
    const latest = history[0] ?? config;
    const usable: { row: Row; material: Record<string, string> }[] = [];
    for (const candidate of history.length ? history : [config]) {
      try {
        const material = await this.credentials(candidate);
        if (candidate.source !== 'legacy') validatePaymentConfiguration({ appId: candidate.app_id, mchId: accountId, credentials: material });
        else this.defaultClient.assertPaymentApplication();
        usable.push({ row: candidate, material });
      } catch { /* A broken historical version never substitutes a different account. */ }
    }
    if (!usable.length) throw new ApiError(503, '原收款账户没有有效的支付凭据，请由平台管理员修复');
    const { row: effective, material: values } = usable[0];
    const cacheKey = `${id}:${effective.id}:${latest.id}`;
    const cached = this.clients.get(cacheKey);
    if (cached) return cached;
    let client: WeChatClient;
    if (effective.source === 'legacy' && Number(effective.id) === 1 && latest.pay_enabled === null
      && (!effective.mch_id || effective.mch_id === this.defaultClient.config.mchId)) {
      client = this.defaultClient;
    } else {
      const owner = merchant ?? await this.row(Number(config.merchant_id));
      // Keep the original key in the bounded key ring even after many rotations.
      const original = usable.find(value => Number(value.row.id) === id);
      const materials = [values, ...(original ? [original.material] : []), ...usable.map(value => value.material)];
      client = this.buildClient(config, latest, owner, values, materials);
    }
    if (this.clients.size > 500) this.clients.clear();
    this.clients.set(cacheKey, client);
    return client;
  }
  private defaultCredentials(): Record<string, string> {
    const c = this.defaultClient.config;
    return { appSecret: c.appSecret || '', privateKey: c.privateKey || '', apiV3Key: c.apiV3Key || '', serialNo: c.serialNo || '', platformKeyId: c.platformKeyId || '', platformKeysJson: JSON.stringify(c.platformKeys || {}) };
  }
  async credentials(config: Row): Promise<Record<string, string>> {
    if (config.source === 'legacy') {
      this.assertLegacyAccount(config);
      return this.defaultCredentials();
    }
    return config.secret_ciphertext ? this.secrets.decrypt(config.secret_ciphertext, String(config.merchant_id)) : {};
  }
  async paymentForOrder(order: Row): Promise<WeChatClient> {
    const id = Number(order.payment_config_id || 1);
    const config = await this.db.one('SELECT * FROM ar_merchant_wechat_config WHERE id=?', [id]);
    if (!config || Number(config.merchant_id) !== Number(order.merchant_id ?? 1)) throw new ApiError(503, '原订单商户配置不一致');
    const client = await this.clientForConfig(id, config);
    if (client.config.appId !== order.appid || client.config.mchId !== order.mch_id) throw new ApiError(503, '原订单支付账户不一致');
    return client;
  }
  async describe(row: Row): Promise<Row> {
    const config = await this.db.one('SELECT * FROM ar_merchant_wechat_config WHERE id=? AND merchant_id=?', [row.active_config_id, row.id]);
    let values: Record<string, string> = {}, client: WeChatClient | undefined;
    try { if (config) { values = await this.credentials(config); client = await this.activeClient(config, row); } } catch { /* One incomplete merchant never disables the platform list. */ }
    let hasAppSecret = false;
    let entry: ApplicationEntry | undefined;
    try { entry = this.applications.entry(await this.applications.forMerchant(Number(row.id))); hasAppSecret = !!entry.client.config.appSecret; } catch { /* Report an unconfigured entry without hiding other merchants. */ }
    return { id: Number(row.id), code: row.code, name: row.name, status: row.status, origin: entry?.origin ?? row.origin, appId: entry?.appId ?? row.app_id,
      entry: entry ? { id: entry.id, legacyMerchantId: entry.legacyMerchantId, name: entry.name, appId: entry.appId, origin: entry.origin, status: entry.status } : null,
      miniappOwnerId: row.miniapp_owner_id == null ? null : Number(row.miniapp_owner_id),
      mchId: config?.mch_id || (config?.source === 'legacy' ? this.defaultClient.config.mchId || '' : ''),
      payEnabled: !!client?.config.payEnabled, paymentReady: !!client?.isPaymentReady(), configId: Number(row.active_config_id),
      configuration: { hasAppSecret, hasPrivateKey: !!values.privateKey, hasApiV3Key: !!values.apiV3Key,
        hasPlatformKeys: !!values.platformPublicKey || !!values.platformKeysJson && values.platformKeysJson !== '{}' } };
  }
}
