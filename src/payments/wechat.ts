import { createDecipheriv, createPrivateKey, createPublicKey, randomBytes, sign, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Row } from '../core/contracts';
import { ApiError } from '../core/errors';

export interface WeChatOptions {
  allowEnvironmentFallback?: boolean;
  appId?: string; appSecret?: string; appSecretPath?: string;
  mchId?: string; serialNo?: string; privateKey?: string; apiV3Key?: string;
  apiV3Keys?: string[];
  platformKeys?: Record<string, string>; platformKeyId?: string;
  notifyUrl?: string; refundNotifyUrl?: string; payEnabled?: boolean;
  fetch?: typeof fetch; now?: () => number; nonce?: () => string;
}
const object = (value: unknown): value is Row => !!value && typeof value === 'object' && !Array.isArray(value);
const identity = (value: unknown): value is string => typeof value === 'string' && /^[^\s\x00-\x1f\x7f]{1,128}$/u.test(value);
const secret = (value?: string, path?: string): string | undefined => value?.trim() || (path ? readFileSync(path, 'utf8').trim() || undefined : undefined);
const pem = (value?: string, path?: string): string | undefined => secret(value, path)?.replace(/\\n/g, '\n');

/** Narrow API client for this application's login and merchant account only. */
export class WeChatClient {
  readonly config: WeChatOptions;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly nonce: () => string;
  private loginConfigurationError = false;
  private paymentConfigurationError = false;
  private accessToken?: { value: string; expires: number };
  private accessTokenRequest?: Promise<string>;

  constructor(options: WeChatOptions = {}) {
    // Managed merchants must supply their entire configuration. A missing
    // credential must never borrow another merchant's default environment.
    const env: NodeJS.ProcessEnv = options.allowEnvironmentFallback === false ? {} : process.env;
    let appSecret: string | undefined, privateKey: string | undefined, apiV3Key: string | undefined;
    let apiV3Keys: string[] = [];
    let platformKeys: Record<string, string> = {};
    try { appSecret = secret(options.appSecret ?? env.WECHAT_APP_SECRET, options.appSecretPath ?? env.WECHAT_APP_SECRET_PATH); }
    catch { this.loginConfigurationError = true; }
    const platformKeyId = options.platformKeyId ?? env.WECHAT_PAY_PLATFORM_SERIAL_NO;
    try {
      privateKey = options.privateKey ?? pem(env.WECHAT_PAY_PRIVATE_KEY, env.WECHAT_PAY_PRIVATE_KEY_PATH);
      apiV3Key = options.apiV3Key ?? secret(env.WECHAT_PAY_API_V3_KEY, env.WECHAT_PAY_API_V3_KEY_PATH);
      if (options.platformKeys) platformKeys = { ...options.platformKeys };
      else {
        const keys: unknown = env.WECHAT_PAY_PLATFORM_KEYS_JSON ? JSON.parse(env.WECHAT_PAY_PLATFORM_KEYS_JSON) : {};
        if (!object(keys) || Object.values(keys).some(value => typeof value !== 'string')) throw Error();
        platformKeys = { ...keys };
        const key = pem(env.WECHAT_PAY_PLATFORM_PUBLIC_KEY, env.WECHAT_PAY_PLATFORM_PUBLIC_KEY_PATH);
        if (key) { if (!platformKeyId) throw Error(); platformKeys[platformKeyId] = key; }
      }
      if (privateKey && createPrivateKey(privateKey).asymmetricKeyType !== 'rsa') throw Error();
      for (const key of Object.values(platformKeys)) if (createPublicKey(key).asymmetricKeyType !== 'rsa') throw Error();
      if (apiV3Key && Buffer.byteLength(apiV3Key) !== 32) throw Error();
      if (options.apiV3Keys !== undefined) {
        if (!Array.isArray(options.apiV3Keys) || options.apiV3Keys.length > 8
          || options.apiV3Keys.some(key => typeof key !== 'string' || Buffer.byteLength(key) !== 32)) throw Error();
        apiV3Keys = [...new Set(options.apiV3Keys)];
        if (new Set([...(apiV3Key ? [apiV3Key] : []), ...apiV3Keys]).size > 8) throw Error();
      }
    } catch { this.paymentConfigurationError = true; }
    this.config = {
      appId: options.appId ?? env.WECHAT_APP_ID, appSecret,
      mchId: options.mchId ?? env.WECHAT_PAY_MCH_ID, serialNo: options.serialNo ?? env.WECHAT_PAY_SERIAL_NO,
      privateKey, apiV3Key, apiV3Keys, platformKeys, platformKeyId,
      notifyUrl: options.notifyUrl ?? env.WECHAT_PAY_NOTIFY_URL,
      refundNotifyUrl: options.refundNotifyUrl ?? env.WECHAT_PAY_REFUND_NOTIFY_URL,
      payEnabled: options.payEnabled ?? env.WECHAT_PAY_ENABLED === '1',
    };
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.nonce = options.nonce ?? (() => randomBytes(16).toString('hex'));
  }

  isPaymentReady(): boolean {
    return this.config.payEnabled === true && !this.paymentConfigurationError
      && /^wx[0-9a-f]{16}$/i.test(this.config.appId || '') && !!this.config.mchId && !!this.config.serialNo
      && !!this.config.privateKey && !!this.config.apiV3Key && !!Object.keys(this.config.platformKeys || {}).length;
  }
  assertPaymentApplication(): void {
    if (this.paymentConfigurationError || !this.config.mchId || !this.config.serialNo || !this.config.privateKey || !Object.keys(this.config.platformKeys || {}).length) {
      throw new ApiError(503, '微信支付验证或商户配置不完整');
    }
  }
  private async transport(url: string, init: RequestInit = {}): Promise<Response> {
    try { return await this.fetcher(url, { ...init, signal: AbortSignal.timeout(15_000), redirect: 'error' }); }
    catch { throw new ApiError(503, '微信服务暂时不可用'); }
  }
  async codeSession(code: string): Promise<Row> {
    if (this.loginConfigurationError || !/^wx[0-9a-f]{16}$/i.test(this.config.appId || '') || !this.config.appSecret) throw new ApiError(503, '小程序 AppID 或 AppSecret 未配置');
    if (typeof code !== 'string' || !code.trim() || Buffer.byteLength(code) > 1024) throw new ApiError(400, '微信登录 code 无效');
    const query = new URLSearchParams({ appid: this.config.appId!, secret: this.config.appSecret, js_code: code, grant_type: 'authorization_code' });
    const response = await this.transport(`https://api.weixin.qq.com/sns/jscode2session?${query}`);
    let result: unknown;
    try { result = await response.json(); } catch { throw new ApiError(502, '微信登录响应格式无效'); }
    if (!response.ok || !object(result) || result.errcode !== undefined && result.errcode !== 0 || !identity(result.openid)) throw new ApiError(401, '微信登录失败，请重新授权');
    if (result.unionid !== undefined && !identity(result.unionid)) throw new ApiError(401, '微信登录身份无效');
    return { openid: result.openid, ...(result.unionid ? { unionid: result.unionid } : {}) };
  }
  async stableToken(): Promise<string> {
    if (this.loginConfigurationError || !/^wx[0-9a-f]{16}$/i.test(this.config.appId || '') || !this.config.appSecret) throw new ApiError(503, '小程序 AppID 或 AppSecret 未配置');
    if (this.accessToken && this.accessToken.expires > this.now()) return this.accessToken.value;
    if (this.accessTokenRequest) return this.accessTokenRequest;
    const request = (async () => {
      const response = await this.transport('https://api.weixin.qq.com/cgi-bin/stable_token', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ grant_type: 'client_credential', appid: this.config.appId, secret: this.config.appSecret, force_refresh: false }),
      });
      let result: unknown;
      try { result = await response.json(); } catch { throw new ApiError(502, '微信凭据响应格式无效'); }
      if (!response.ok || !object(result) || result.errcode !== undefined && result.errcode !== 0
        || typeof result.access_token !== 'string' || !/^[^\s\x00-\x1f\x7f]{16,2048}$/.test(result.access_token)
        || !Number.isSafeInteger(result.expires_in) || result.expires_in < 1) throw new ApiError(503, '微信小程序码服务暂时不可用，请检查后台凭据及IP白名单');
      this.accessToken = { value: result.access_token, expires: this.now() + Math.max(0, result.expires_in - 120) };
      return result.access_token;
    })();
    this.accessTokenRequest = request;
    try { return await request; } finally { if (this.accessTokenRequest === request) this.accessTokenRequest = undefined; }
  }
  /** Phone authorization uses getPhoneNumber's one-use code, never wx.login's code. */
  async phoneNumber(code: string): Promise<{ phoneE164: string; countryCode: string }> {
    if (typeof code !== 'string' || !/^[\x21-\x7e]{1,1024}$/.test(code)) throw new ApiError(400, '微信手机号授权 code 无效，请重新授权');
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.stableToken();
      const response = await this.transport(`https://api.weixin.qq.com/wxa/business/getuserphonenumber?access_token=${encodeURIComponent(token)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }),
      });
      let result: unknown;
      try { result = await response.json(); } catch { throw new ApiError(502, '微信手机号响应格式无效，请重新授权'); }
      if (attempt === 0 && object(result) && [40001, 40014, 42001].includes(result.errcode)) {
        if (this.accessToken?.value === token) this.accessToken = undefined;
        continue;
      }
      if (!response.ok || !object(result) || result.errcode !== 0 || !object(result.phone_info)) throw new ApiError(400, '微信手机号授权已失效或未成功，请重新授权');
      const info = result.phone_info, watermark = info.watermark;
      const countryCode: unknown = info.countryCode, pure: unknown = info.purePhoneNumber, phone: unknown = info.phoneNumber;
      const now = this.now();
      if (!object(watermark) || watermark.appid !== this.config.appId || !Number.isSafeInteger(watermark.timestamp)
        || watermark.timestamp < now - 300 || watermark.timestamp > now + 60
        || typeof countryCode !== 'string' || !/^[1-9][0-9]{0,2}$/.test(countryCode)
        || typeof pure !== 'string' || !/^[0-9]{4,14}$/.test(pure) || !/[1-9]/.test(pure)
        || countryCode.length + pure.length < 7 || countryCode.length + pure.length > 15
        || countryCode === '86' && !/^1[3-9][0-9]{9}$/.test(pure)
        || typeof phone !== 'string' || phone !== pure && phone !== countryCode + pure && phone !== '+' + countryCode + pure) throw new ApiError(400, '微信手机号验证失败，请重新授权');
      return { phoneE164: '+' + countryCode + pure, countryCode };
    }
    throw new ApiError(503, '微信手机号服务暂时不可用，请重新授权');
  }
  async unlimitedCode(scene: string, envVersion: 'release' | 'trial' | 'develop' = 'release'): Promise<Buffer> {
    if (!/^[a-f0-9]{32}$/.test(scene) || !['release', 'trial', 'develop'].includes(envVersion)) throw new ApiError(422, '登录二维码参数无效');
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.stableToken();
      const response = await this.transport(`https://api.weixin.qq.com/wxa/getwxacodeunlimit?access_token=${encodeURIComponent(token)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scene, page: 'pages/admin/login', check_path: envVersion === 'release', env_version: envVersion, width: 430, is_hyaline: false }),
      });
      let bytes: Buffer;
      try { bytes = Buffer.from(await response.arrayBuffer()); } catch { throw new ApiError(503, '微信小程序码读取失败'); }
      const png = bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      const jpeg = bytes.length >= 5 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 && bytes.at(-2) === 255 && bytes.at(-1) === 217;
      if (response.ok && bytes.length <= 2 * 1024 * 1024 && (png || jpeg)) return bytes;
      let error: unknown;
      try { error = JSON.parse(bytes.subarray(0, 4096).toString('utf8')); } catch { /* Never forward provider output. */ }
      if (attempt === 0 && object(error) && [40001, 40014, 42001].includes(error.errcode)) {
        if (this.accessToken?.value === token) this.accessToken = undefined;
        continue;
      }
      throw new ApiError(503, '微信登录二维码生成失败，请确认小程序确认页已发布及版本配置');
    }
    throw new ApiError(503, '微信登录二维码暂时不可用');
  }
  private verifyPayment(raw: string, headers: Headers | Record<string, unknown>): void {
    const get = (name: string): string => {
      if (headers instanceof Headers) return headers.get(name) || '';
      const values = Object.entries(headers).filter(([key]) => key.toLowerCase() === name);
      return values.length === 1 && typeof values[0][1] === 'string' ? values[0][1] : '';
    };
    const timestamp = get('wechatpay-timestamp'), nonce = get('wechatpay-nonce');
    const serial = get('wechatpay-serial'), signature = get('wechatpay-signature');
    const key = Object.prototype.hasOwnProperty.call(this.config.platformKeys || {}, serial) ? this.config.platformKeys![serial] : undefined;
    if (!/^\d{1,12}$/.test(timestamp) || Math.abs(this.now() - Number(timestamp)) > 300 || !nonce || !signature || !key || signature.startsWith('WECHATPAY/SIGNTEST/')) throw new ApiError(403, '微信支付签名验证失败');
    let valid = false;
    try { valid = verify('RSA-SHA256', Buffer.from(`${timestamp}\n${nonce}\n${raw}\n`), key, Buffer.from(signature, 'base64')); } catch { /* Fail closed. */ }
    if (!valid) throw new ApiError(403, '微信支付签名验证失败');
  }
  async payment(method: string, path: string, data?: Row): Promise<Row> {
    this.assertPaymentApplication();
    // Callers choose the documented merchant paths; no host or redirect input.
    if (!['GET', 'POST'].includes(method) || !/^\/v3\/[A-Za-z0-9_/?=&.%~-]+$/.test(path) || path.includes('..')) throw new ApiError(400, '支付请求路径无效');
    const body = data === undefined ? '' : JSON.stringify(data), timestamp = String(this.now()), nonce = this.nonce();
    const signature = sign('RSA-SHA256', Buffer.from(`${method}\n${path}\n${timestamp}\n${nonce}\n${body}\n`), this.config.privateKey!).toString('base64');
    const authorization = `WECHATPAY2-SHA256-RSA2048 mchid="${this.config.mchId}",nonce_str="${nonce}",timestamp="${timestamp}",serial_no="${this.config.serialNo}",signature="${signature}"`;
    const platformKeyId = this.config.platformKeyId || Object.keys(this.config.platformKeys || {}).find(id => id.startsWith('PUB_KEY_ID_'));
    const response = await this.transport(`https://api.mch.weixin.qq.com${path}`, { method, headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: authorization, ...(platformKeyId ? { 'Wechatpay-Serial': platformKeyId } : {}) }, ...(body ? { body } : {}) });
    let raw: string;
    try { raw = await response.text(); } catch { throw new ApiError(503, '微信支付响应读取失败'); }
    // Even an error code cannot drive a financial transition unless signed.
    this.verifyPayment(raw, response.headers);
    if (!response.ok) {
      let result: unknown;
      try { result = JSON.parse(raw); } catch { /* Generic failure below. */ }
      const error = new ApiError(502, '微信支付请求未成功，请查询订单状态');
      if (object(result) && typeof result.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(result.code)) Object.defineProperty(error, 'providerCode', { value: result.code });
      throw error;
    }
    if (response.status === 204 && method === 'POST' && /^\/v3\/pay\/transactions\/out-trade-no\/[^/?#]+\/close$/.test(path) && raw === '') return {};
    let result: unknown;
    try { result = JSON.parse(raw); } catch { throw new ApiError(502, '微信支付响应格式无效'); }
    if (!object(result)) throw new ApiError(502, '微信支付响应格式无效');
    return result;
  }
  async order(input: Row, fallbackNotifyUrl?: string): Promise<Row> {
    if (!this.isPaymentReady()) throw new ApiError(503, '设备租赁支付暂未开放');
    if (!Number.isSafeInteger(input.amount) || input.amount <= 0 || input.amount > 2147483647 || !identity(input.openid)) throw new ApiError(422, '支付金额或付款身份无效');
    const notifyUrl = this.config.notifyUrl || fallbackNotifyUrl;
    if (!notifyUrl || !notifyUrl.startsWith('https://')) throw new ApiError(503, '支付回调地址未配置');
    const result = await this.payment('POST', '/v3/pay/transactions/jsapi', {
      appid: this.config.appId, mchid: this.config.mchId, description: input.description ?? 'AR设备租赁',
      out_trade_no: input.out_trade_no, notify_url: notifyUrl,
      ...(typeof input.attach === 'string' ? { attach: input.attach } : {}),
      ...(typeof input.time_expire === 'string' ? { time_expire: input.time_expire } : {}),
      amount: { total: input.amount, currency: 'CNY' }, payer: { openid: input.openid },
    });
    if (typeof result.prepay_id !== 'string' || !result.prepay_id) throw new ApiError(502, '微信支付未返回预支付信息');
    const timeStamp = String(this.now()), nonceStr = this.nonce(), packageValue = `prepay_id=${result.prepay_id}`;
    const paySign = sign('RSA-SHA256', Buffer.from(`${this.config.appId}\n${timeStamp}\n${nonceStr}\n${packageValue}\n`), this.config.privateKey!).toString('base64');
    return { appId: this.config.appId, timeStamp, nonceStr, package: packageValue, signType: 'RSA', paySign };
  }
  async notification(raw: string | Buffer, headers: Headers | Record<string, unknown>): Promise<Row> {
    this.assertPaymentApplication();
    if (!this.config.apiV3Key || Buffer.byteLength(this.config.apiV3Key) !== 32) throw new ApiError(503, '微信支付 APIv3 密钥未配置');
    const text = raw.toString();
    this.verifyPayment(text, headers);
    let notice: unknown;
    try { notice = JSON.parse(text); } catch { throw new ApiError(400, '微信通知格式无效'); }
    if (!object(notice) || !object(notice.resource)) throw new ApiError(400, '微信通知格式无效');
    const resource = notice.resource;
    if (resource.algorithm !== 'AEAD_AES_256_GCM' || typeof resource.ciphertext !== 'string' || typeof resource.nonce !== 'string' || resource.associated_data !== undefined && typeof resource.associated_data !== 'string') throw new ApiError(400, '微信通知加密格式无效');
    const encrypted = Buffer.from(resource.ciphertext, 'base64');
    if (encrypted.length < 17) throw new ApiError(400, '微信通知解密失败');
    let decoded: unknown, decrypted = false;
    // Signature verification above always precedes the bounded key ring. Old
    // ciphertext may arrive after rotation, while new requests use the live key.
    const keys = [...new Set([this.config.apiV3Key, ...(this.config.apiV3Keys || [])])].slice(0, 8);
    for (const key of keys) {
      try {
        const decipher = createDecipheriv('aes-256-gcm', Buffer.from(key), Buffer.from(resource.nonce));
        decipher.setAuthTag(encrypted.subarray(-16));
        decipher.setAAD(Buffer.from(resource.associated_data || ''));
        decoded = JSON.parse(Buffer.concat([decipher.update(encrypted.subarray(0, -16)), decipher.final()]).toString('utf8'));
        decrypted = true;
        break;
      } catch { /* Only an authenticated, decrypted resource can change state. */ }
    }
    if (!decrypted) throw new ApiError(400, '微信通知解密失败');
    if (!object(decoded) || decoded.mchid !== this.config.mchId || decoded.appid !== undefined && decoded.appid !== this.config.appId) throw new ApiError(403, '微信通知商户或小程序不一致');
    return { ...notice, resource: decoded };
  }
}
