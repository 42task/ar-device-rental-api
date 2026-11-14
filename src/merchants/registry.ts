import type { Database } from '../core/database';
import type { Row } from '../core/contracts';
import { ApiError } from '../core/errors';
import { WeChatClient } from '../payments/wechat';
import type { MerchantRuntime } from './context';
import { MerchantSecrets } from './secrets';

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
  constructor(readonly db: Database, readonly defaultClient: WeChatClient, readonly secrets = new MerchantSecrets()) {}
  async row(id: number): Promise<Row> {
    const row = await this.db.one('SELECT * FROM ar_merchant WHERE id=?', [id]);
    if (!row) throw new ApiError(404, '商户不存在');
    return row;
  }
  async resolveHost(host: string, directLoopback = false): Promise<MerchantRuntime> {
    if (!host || /[\s,/@\\]/.test(host)) throw new ApiError(404, '商户域名未登记');
    let hostname: string;
    try { hostname = new URL('https://' + host).hostname.toLowerCase(); } catch { throw new ApiError(404, '商户域名未登记'); }
    if (directLoopback && ['127.0.0.1', 'localhost', '[::1]'].includes(hostname)) return this.runtime(1);
    const row = await this.db.one('SELECT * FROM ar_merchant WHERE hostname=?', [hostname]);
    if (!row) throw new ApiError(404, '商户域名未登记');
    return this.runtime(Number(row.id), row);
  }
  async runtime(id: number, existing?: Row): Promise<MerchantRuntime> {
    const row = existing ?? await this.row(id);
    const config = await this.db.one('SELECT * FROM ar_merchant_wechat_config WHERE id=? AND merchant_id=?', [row.active_config_id, id]);
    if (!config) throw new ApiError(503, '商户微信配置未就绪');
    const client = await this.clientForConfig(Number(config.id), config, row);
    return { id, code: row.code, name: row.name, status: row.status, origin: row.origin, appId: row.app_id, configId: Number(config.id), client };
  }
  async clientForConfig(id: number, existing?: Row, merchant?: Row): Promise<WeChatClient> {
    if (!Number.isSafeInteger(id) || id < 1) throw new ApiError(404, '支付配置不存在');
    const config = existing ?? await this.db.one('SELECT * FROM ar_merchant_wechat_config WHERE id=?', [id]);
    if (!config) throw new ApiError(503, '原订单支付配置不可用');
    if (config.source === 'legacy' && Number(config.merchant_id) !== 1) throw new ApiError(503, '商户配置来源无效');
    if (config.source === 'legacy' && !config.mch_id && this.defaultClient.config.mchId) {
      await this.db.execute('UPDATE ar_merchant_wechat_config SET mch_id=? WHERE id=? AND mch_id IS NULL', [this.defaultClient.config.mchId, id]);
      config.mch_id = this.defaultClient.config.mchId;
    }
    const accountId = config.mch_id || '';
    const versions = await this.db.query('SELECT * FROM ar_merchant_wechat_config WHERE merchant_id=? AND app_id=? ORDER BY version DESC', [config.merchant_id, config.app_id]);
    const history = versions.filter(row => (row.mch_id || (row.source === 'legacy' ? this.defaultClient.config.mchId || '' : '')) === accountId);
    const effective = history[0] ?? config;
    const cacheKey = `${id}:${effective.id}`;
    const cached = this.clients.get(cacheKey);
    if (cached) return cached;
    let client: WeChatClient;
    if (effective.source === 'legacy' && Number(effective.id) === 1 && effective.pay_enabled === null
      && (!effective.mch_id || effective.mch_id === this.defaultClient.config.mchId)) {
      client = this.defaultClient;
    } else {
      const owner = merchant ?? await this.row(Number(config.merchant_id));
      const values = await this.credentials(effective);
      let platformKeys: Record<string, string> = {};
      const historicalApiKeys: string[] = [];
      // An order pins its receiving account, while valid signing keys may rotate.
      for (const prior of [...history].reverse()) {
        const material = await this.credentials(prior);
        if (material.platformKeysJson) {
          try { platformKeys = { ...platformKeys, ...JSON.parse(material.platformKeysJson) }; } catch { throw new ApiError(503, '商户验签配置无效'); }
        }
        if (material.platformKeyId && material.platformPublicKey) platformKeys[material.platformKeyId] = material.platformPublicKey;
        if (material.apiV3Key) historicalApiKeys.push(material.apiV3Key);
      }
      const originalMaterial = await this.credentials(config);
      // Limit distinct keys, not configuration edits; always retain this order's original key.
      const apiV3Keys = [...new Set([values.apiV3Key, originalMaterial.apiV3Key, ...historicalApiKeys.reverse()].filter((key): key is string => !!key))].slice(0, 8);
      if (values.platformKeyId && values.platformPublicKey) platformKeys[values.platformKeyId] = values.platformPublicKey;
      client = new WeChatClient({ allowEnvironmentFallback: false, appId: config.app_id, appSecret: values.appSecret || '',
        mchId: config.mch_id || '',
        privateKey: values.privateKey || '', apiV3Key: values.apiV3Key || '', apiV3Keys, serialNo: values.serialNo || '',
        platformKeys, platformKeyId: values.platformKeyId || '', payEnabled: effective.pay_enabled === null ? this.defaultClient.config.payEnabled : !!effective.pay_enabled,
        notifyUrl: `${owner.origin}/api/v2/rental/payment-notify/${id}`, refundNotifyUrl: `${owner.origin}/api/v2/rental/refund-notify/${id}` });
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
    return config.source === 'legacy' ? this.defaultCredentials() : config.secret_ciphertext ? this.secrets.decrypt(config.secret_ciphertext, String(config.merchant_id)) : {};
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
    try { if (config) { values = await this.credentials(config); client = await this.clientForConfig(Number(config.id), config, row); } } catch { /* One incomplete merchant never disables the platform list. */ }
    return { id: Number(row.id), code: row.code, name: row.name, status: row.status, origin: row.origin, appId: row.app_id,
      mchId: config?.mch_id || (config?.source === 'legacy' ? this.defaultClient.config.mchId || '' : ''),
      payEnabled: !!client?.config.payEnabled, paymentReady: !!client?.isPaymentReady(), configId: Number(row.active_config_id),
      configuration: { hasAppSecret: !!values.appSecret, hasPrivateKey: !!values.privateKey, hasApiV3Key: !!values.apiV3Key,
        hasPlatformKeys: !!values.platformPublicKey || !!values.platformKeysJson && values.platformKeysJson !== '{}' } };
  }
}
