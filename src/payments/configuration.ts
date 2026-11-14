import { createPrivateKey, createPublicKey, X509Certificate, type KeyObject } from 'node:crypto';
import { ApiError } from '../core/errors';

export interface PaymentConfigurationCandidate { appId: unknown; mchId: unknown; credentials: unknown }
export interface ValidatedPaymentConfiguration { credentials: Record<string, string>; complete: boolean }
const FIELDS = new Set(['appSecret', 'privateKey', 'serialNo', 'apiV3Key', 'platformKeyId', 'platformPublicKey', 'platformKeysJson']);
const serial = (value: string): boolean => /^[0-9a-f]{1,128}$/i.test(value);
const platformId = (value: string): boolean => serial(value) || /^PUB_KEY_ID_[A-Za-z0-9]{1,128}$/.test(value);
const canonicalId = (value: string): string => serial(value) ? value.toUpperCase() : value;
function fail(field: string): never { throw new ApiError(422, field + '配置无效，请核对后重新保存'); }
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function rsa(key: KeyObject, field: string): KeyObject {
  if (key.asymmetricKeyType !== 'rsa' || Number(key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) fail(field);
  return key;
}
function publicPem(value: string, id?: string): string {
  try {
    let key: KeyObject;
    if (value.startsWith('-----BEGIN CERTIFICATE-----')) {
      const certificate = new X509Certificate(value);
      if (id && (!serial(id) || certificate.serialNumber.replace(/^0+/, '').toUpperCase() !== id.replace(/^0+/, '').toUpperCase())) fail('平台证书序列号');
      key = certificate.publicKey;
    } else {
      if (!/^-----BEGIN (?:RSA )?PUBLIC KEY-----/.test(value)) fail('微信支付公钥');
      key = createPublicKey(value);
    }
    return rsa(key, '微信支付公钥').export({ format: 'pem', type: 'spki' }).toString();
  } catch { return fail('微信支付公钥或平台证书'); }
}

/** Local syntax/key validation only: a public-key ID or merchant certificate
 * serial cannot prove remote account ownership without the provider's proof.
 * Missing fields may be stored as a draft; malformed supplied fields never are.
 */
export function validatePaymentConfiguration(input: PaymentConfigurationCandidate, options: { requireComplete?: boolean } = {}): ValidatedPaymentConfiguration {
  const appId = input.appId == null ? '' : input.appId;
  const mchId = input.mchId == null ? '' : input.mchId;
  if (typeof appId !== 'string' || appId && !/^wx[0-9a-f]{16}$/i.test(appId)) fail('小程序 AppID');
  if (typeof mchId !== 'string' || mchId && !/^[0-9]{1,32}$/.test(mchId)) fail('微信商户号');
  if (!record(input.credentials)) fail('支付凭据');
  const credentials: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.credentials)) {
    if (!FIELDS.has(name) || typeof value !== 'string' || value.length > (name === 'platformKeysJson' ? 128000 : 16000)) fail('支付凭据');
    if (value.trim()) credentials[name] = value.trim();
  }
  if (credentials.appSecret && (credentials.appSecret.length > 256 || /[\s\x00-\x1f\x7f]/.test(credentials.appSecret))) fail('小程序 AppSecret');
  if (credentials.serialNo && !serial(credentials.serialNo)) fail('商户证书序列号');
  if (credentials.serialNo) credentials.serialNo = credentials.serialNo.toUpperCase();
  if (credentials.apiV3Key && !/^[A-Za-z0-9]{32}$/.test(credentials.apiV3Key)) fail('APIv3 密钥');
  if (credentials.platformKeyId && !platformId(credentials.platformKeyId)) fail('微信支付公钥 ID');
  if (credentials.platformKeyId) credentials.platformKeyId = canonicalId(credentials.platformKeyId);
  let merchantPublic: string | undefined;
  if (credentials.privateKey) {
    try {
      if (!/^-----BEGIN (?:RSA )?PRIVATE KEY-----/.test(credentials.privateKey)) fail('商户 RSA 私钥');
      const key = rsa(createPrivateKey(credentials.privateKey), '商户 RSA 私钥');
      credentials.privateKey = key.export({ format: 'pem', type: 'pkcs8' }).toString();
      merchantPublic = createPublicKey(key).export({ format: 'pem', type: 'spki' }).toString();
    } catch { fail('商户 RSA 私钥'); }
  }
  const keys: Record<string, string> = {};
  const materials: Record<string, string> = {};
  if (credentials.platformKeysJson) {
    let parsed: unknown;
    try { parsed = JSON.parse(credentials.platformKeysJson); } catch { fail('微信支付验签公钥列表'); }
    if (!record(parsed) || Object.keys(parsed).length > 64) fail('微信支付验签公钥列表');
    for (const [id, value] of Object.entries(parsed)) {
      if (!platformId(id) || typeof value !== 'string' || value.length > 16000) fail('微信支付验签公钥列表');
      const name = canonicalId(id), normalized = publicPem(value.trim(), name);
      if (keys[name] && keys[name] !== normalized) fail('同一 ID 的微信支付公钥');
      keys[name] = normalized;
      materials[name] = value.trim().startsWith('-----BEGIN CERTIFICATE-----') ? new X509Certificate(value.trim()).toString() : normalized;
    }
  }
  if (credentials.platformPublicKey) {
    const normalized = publicPem(credentials.platformPublicKey, credentials.platformKeyId);
    if (normalized === merchantPublic) fail('商户签名与微信支付验签公钥不得混用');
    const material = credentials.platformPublicKey.startsWith('-----BEGIN CERTIFICATE-----') ? new X509Certificate(credentials.platformPublicKey).toString() : normalized;
    credentials.platformPublicKey = material;
    if (credentials.platformKeyId) {
      const previous = keys[credentials.platformKeyId];
      if (previous && previous !== normalized) fail('同一 ID 的微信支付公钥');
      keys[credentials.platformKeyId] = normalized;
      // Retain certificate identity for the next edit, including drafts that
      // receive their declared ID later. Otherwise a mismatched future ID could
      // no longer be checked after reducing a certificate to its public key.
      if (material.startsWith('-----BEGIN CERTIFICATE-----') || !materials[credentials.platformKeyId]) materials[credentials.platformKeyId] = material;
    }
  }
  if (merchantPublic && Object.values(keys).some(key => key === merchantPublic)) fail('商户签名与微信支付验签公钥不得混用');
  if (Object.keys(keys).length) credentials.platformKeysJson = JSON.stringify(materials);
  const complete = !!(appId && mchId && credentials.privateKey && credentials.serialNo && credentials.apiV3Key
    && Object.keys(keys).length && (!credentials.platformKeyId || keys[credentials.platformKeyId]));
  if ((options.requireComplete ?? true) && !complete) throw new ApiError(422, '支付凭据尚未完整，请补齐后再启用收款');
  return { credentials, complete };
}
