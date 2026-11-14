import type { Database } from '../core/database';
import type { Row } from '../core/contracts';
import { ApiError } from '../core/errors';
import type { ApplicationEntry } from '../merchants/context';
import { MerchantSecrets } from '../merchants/secrets';
import { WeChatClient } from '../payments/wechat';

export class ApplicationRegistry {
  private readonly clients = new Map<string, WeChatClient>();
  constructor(readonly db: Database, private readonly defaultClient: WeChatClient, private readonly secrets: MerchantSecrets) {}
  async row(id: number): Promise<Row> {
    const row = await this.db.one('SELECT * FROM ar_application WHERE id=?', [id]);
    if (!row) throw new ApiError(404, '小程序入口不存在');
    return row;
  }
  async forMerchant(merchantId: number): Promise<Row> {
    const row = await this.db.one('SELECT a.* FROM ar_application a INNER JOIN ar_application_merchant am ON am.application_id=a.id WHERE am.merchant_id=?', [merchantId]);
    if (!row) throw new ApiError(503, '商户未关联小程序入口');
    return row;
  }
  async resolveHost(host: string, directLoopback = false): Promise<ApplicationEntry> {
    if (!host || /[\s,/@\\]/.test(host)) throw new ApiError(404, '小程序域名未登记');
    let hostname: string;
    try { hostname = new URL('https://' + host).hostname.toLowerCase(); } catch { throw new ApiError(404, '小程序域名未登记'); }
    const row = directLoopback && ['127.0.0.1', 'localhost', '[::1]'].includes(hostname)
      ? await this.db.one('SELECT * FROM ar_application WHERE legacy_merchant_id=1')
      : await this.db.one('SELECT * FROM ar_application WHERE hostname=?', [hostname]);
    if (!row) throw new ApiError(404, '小程序域名未登记');
    return this.entry(row);
  }
  createLoginClient(row: Row, appSecret: string): WeChatClient {
    return new WeChatClient({ allowEnvironmentFallback: false, appId: row.app_id, appSecret, payEnabled: false });
  }
  entry(row: Row): ApplicationEntry {
    const key = `${row.id}:${row.secret_revision}`;
    let client = this.clients.get(key);
    if (!client) {
      let appSecret = '';
      try {
        appSecret = row.credential_source === 'legacy' ? this.defaultClient.config.appSecret || ''
          : row.secret_ciphertext ? this.secrets.decrypt(row.secret_ciphertext, row.secret_account).appSecret || '' : '';
      } catch { /* Existing authenticated operators can replace a broken login secret. */ }
      if (row.credential_source === 'legacy' && row.app_id === this.defaultClient.config.appId) {
        // Login methods may be injected in local integration tests; payment is
        // deliberately not exposed through the entry client.
        client = this.createLoginClient(row, appSecret);
        if (typeof this.defaultClient.codeSession === 'function') client.codeSession = this.defaultClient.codeSession.bind(this.defaultClient);
        if (typeof this.defaultClient.phoneNumber === 'function') client.phoneNumber = this.defaultClient.phoneNumber.bind(this.defaultClient);
        if (typeof this.defaultClient.unlimitedCode === 'function') client.unlimitedCode = this.defaultClient.unlimitedCode.bind(this.defaultClient);
      } else client = this.createLoginClient(row, appSecret);
      if (this.clients.size > 100) this.clients.clear();
      this.clients.set(key, client);
    }
    return { id: Number(row.id), legacyMerchantId: Number(row.legacy_merchant_id), name: row.name, appId: row.app_id, origin: row.origin, status: row.status, client };
  }
  async saveForMerchant(db: Database, merchant: Row, appSecret?: string, existingOwnerId?: number | null, settings: { name?: string; status?: 'active' | 'paused' } = {}): Promise<void> {
    const now = Date.now();
    let entry: Row | null;
    if (existingOwnerId != null) {
      entry = await db.one('SELECT * FROM ar_application WHERE legacy_merchant_id=?', [existingOwnerId]);
      if (!entry) throw new ApiError(422, '请选择有效小程序入口');
    } else {
      entry = await db.one('SELECT * FROM ar_application WHERE legacy_merchant_id=?', [merchant.id]);
      const account = `application:${merchant.id}`;
      const ciphertext = appSecret ? this.secrets.encrypt({ appSecret }, account) : undefined;
      if (!entry) {
        entry = await db.insert('ar_application', { legacy_merchant_id: merchant.id, name: settings.name ?? merchant.name, app_id: merchant.app_id, origin: merchant.origin,
          hostname: merchant.hostname, status: settings.status ?? 'active', credential_source: 'managed', secret_ciphertext: ciphertext ?? null, secret_account: account,
          secret_revision: 1, created_ms: now, updated_ms: now });
      } else {
        const changedApp = entry.app_id !== merchant.app_id;
        await db.execute('UPDATE ar_application SET name=?,status=?,app_id=?,origin=?,hostname=?,updated_ms=?' + (ciphertext || changedApp ? ',credential_source=\'managed\',secret_ciphertext=?,secret_account=?,secret_revision=secret_revision+1' : '') + ' WHERE id=?',
          [settings.name ?? entry.name, settings.status ?? entry.status, merchant.app_id, merchant.origin, merchant.hostname, now, ...(ciphertext || changedApp ? [ciphertext ?? null, account] : []), entry.id]);
      }
    }
    await db.execute('INSERT INTO ar_application_merchant (application_id,merchant_id) VALUES (?,?) ON DUPLICATE KEY UPDATE application_id=VALUES(application_id)', [entry.id, merchant.id]);
    if (existingOwnerId != null) {
      // Only unused independent merchants may change entry (checked by the
      // management transaction). Release their old AppID/domain after relinking.
      await db.execute('DELETE a FROM ar_application a LEFT JOIN ar_application_merchant am ON am.application_id=a.id WHERE a.legacy_merchant_id=? AND am.merchant_id IS NULL', [merchant.id]);
    }
  }
}
