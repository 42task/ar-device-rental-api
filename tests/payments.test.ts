import { createCipheriv, generateKeyPairSync, sign, verify } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WeChatClient, type WeChatOptions } from '../src/payments/wechat';

const merchant = generateKeyPairSync('rsa', { modulusLength: 2048 });
const platform = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = (key: typeof merchant.privateKey) => key.export({ format: 'pem', type: 'pkcs8' }).toString();
const pub = platform.publicKey.export({ format: 'pem', type: 'spki' }).toString();
const now = 1794542400, appId = 'wx0123456789abcdef', mchId = 'merchant-1', apiV3Key = '01234567890123456789012345678901';
const options: WeChatOptions = { appId, appSecret: 'new-app-secret', mchId, serialNo: 'merchant-serial', privateKey: pem(merchant.privateKey), apiV3Key, platformKeys: { 'PUB_KEY_ID_test': pub }, now: () => now, nonce: () => 'request-nonce', payEnabled: true };
function headers(raw: string, timestamp = now) {
  return { 'Wechatpay-Timestamp': String(timestamp), 'Wechatpay-Nonce': 'provider-nonce', 'Wechatpay-Serial': 'PUB_KEY_ID_test', 'Wechatpay-Signature': sign('RSA-SHA256', Buffer.from(`${timestamp}\nprovider-nonce\n${raw}\n`), platform.privateKey).toString('base64') };
}
function response(body: unknown, status = 200, timestamp = now): Response {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  return new Response(status === 204 ? null : raw, { status, headers: headers(raw, timestamp) });
}
function notification(resource: Record<string, unknown>, key = apiV3Key) {
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(key), Buffer.from('12-byte-iv01'));
  cipher.setAAD(Buffer.from('transaction'));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(resource)), cipher.final(), cipher.getAuthTag()]).toString('base64');
  const raw = JSON.stringify({ id: 'notice-1', event_type: 'TRANSACTION.SUCCESS', resource: { algorithm: 'AEAD_AES_256_GCM', nonce: '12-byte-iv01', associated_data: 'transaction', ciphertext } });
  return { raw, headers: headers(raw) };
}
afterEach(() => vi.unstubAllEnvs());

describe('standalone WeChat client', () => {
  it('never borrows default credentials or callback URLs for a managed merchant', async () => {
    vi.stubEnv('WECHAT_APP_ID', appId); vi.stubEnv('WECHAT_APP_SECRET', 'another-merchant-secret');
    vi.stubEnv('WECHAT_PAY_MCH_ID', mchId); vi.stubEnv('WECHAT_PAY_SERIAL_NO', 'another-serial');
    vi.stubEnv('WECHAT_PAY_PRIVATE_KEY', options.privateKey!); vi.stubEnv('WECHAT_PAY_API_V3_KEY', apiV3Key);
    vi.stubEnv('WECHAT_PAY_PLATFORM_KEYS_JSON', JSON.stringify(options.platformKeys)); vi.stubEnv('WECHAT_PAY_ENABLED', '1');
    vi.stubEnv('WECHAT_PAY_NOTIFY_URL', 'https://other.example/payment'); vi.stubEnv('WECHAT_PAY_REFUND_NOTIFY_URL', 'https://other.example/refund');
    const fetcher = vi.fn();
    const client = new WeChatClient({ allowEnvironmentFallback: false, appId: 'wxaaaaaaaaaaaaaaaa', fetch: fetcher });
    expect(client.config).toMatchObject({ appId: 'wxaaaaaaaaaaaaaaaa', platformKeys: {}, payEnabled: false });
    for (const field of ['appSecret', 'mchId', 'serialNo', 'privateKey', 'apiV3Key', 'notifyUrl', 'refundNotifyUrl'] as const) expect(client.config[field]).toBeUndefined();
    expect(client.isPaymentReady()).toBe(false);
    await expect(client.codeSession('code')).rejects.toMatchObject({ status: 503 });
    await expect(client.payment('GET', '/v3/refund/domestic/refunds/old')).rejects.toMatchObject({ status: 503 });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('exchanges only server-configured app credentials and returns no session key', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ openid: 'confirmed-user', unionid: 'confirmed-union', session_key: 'never-return-this' })));
    const client = new WeChatClient({ ...options, payEnabled: false, fetch: fetcher });
    expect(await client.codeSession('wx-login-code')).toEqual({ openid: 'confirmed-user', unionid: 'confirmed-union' });
    const request = new URL(fetcher.mock.calls[0][0] as string);
    expect(request.origin).toBe('https://api.weixin.qq.com');
    expect(request.searchParams.get('appid')).toBe(appId); expect(request.searchParams.get('secret')).toBe('new-app-secret');
    expect(request.searchParams.get('js_code')).toBe('wx-login-code');
  });
  it('reports absent AppSecret as 503 and provider denial as 401 without secret details', async () => {
    vi.stubEnv('WECHAT_APP_SECRET', ''); vi.stubEnv('WECHAT_APP_SECRET_PATH', '');
    const client = new WeChatClient({ appId });
    await expect(client.codeSession('code')).rejects.toMatchObject({ status: 503 });
    const denied = new WeChatClient({ ...options, fetch: async () => new Response(JSON.stringify({ errcode: 40029, errmsg: 'provider-secret-details' })) });
    await expect(denied.codeSession('code')).rejects.toMatchObject({ status: 401, message: '微信登录失败，请重新授权' });
  });
  it('defaults payment off while keeping signed query/refund reconciliation available', async () => {
    vi.stubEnv('WECHAT_PAY_ENABLED', '0');
    const fetcher = vi.fn(async () => response({ status: 'PROCESSING' }));
    const client = new WeChatClient({ ...options, payEnabled: undefined, fetch: fetcher });
    expect(client.isPaymentReady()).toBe(false);
    await expect(client.order({ amount: 100, openid: 'user-1' }, 'https://d.4mr.cn/api/v2/rental/payment-notify')).rejects.toMatchObject({ status: 503 });
    expect(fetcher).not.toHaveBeenCalled();
    expect(await client.payment('GET', '/v3/refund/domestic/refunds/ARF_123')).toMatchObject({ status: 'PROCESSING' });
    expect(await client.payment('POST', '/v3/refund/domestic/refunds', { out_refund_no: 'ARF_123', amount: { refund: 100, total: 100, currency: 'CNY' } })).toMatchObject({ status: 'PROCESSING' });
  });
  it('signs the exact request and pay invocation, forwarding the original payment expiry', async () => {
    let capturedUrl = '', capturedInit: RequestInit = {};
    const client = new WeChatClient({ ...options, fetch: async (url, init) => { capturedUrl = String(url); capturedInit = init!; return response({ prepay_id: 'provider-prepay' }); } });
    const result = await client.order({ out_trade_no: 'ARL_123', openid: 'user-1', amount: 1234, time_expire: '2026-11-13T06:05:00Z' }, 'https://d.4mr.cn/api/v2/rental/payment-notify');
    expect(capturedUrl).toBe('https://api.mch.weixin.qq.com/v3/pay/transactions/jsapi');
    const body = JSON.parse(capturedInit.body as string);
    expect(body).toMatchObject({ appid: appId, mchid: mchId, payer: { openid: 'user-1' }, amount: { total: 1234, currency: 'CNY' }, time_expire: '2026-11-13T06:05:00Z' });
    expect(capturedInit.redirect).toBe('error'); expect(capturedInit.signal).toBeInstanceOf(AbortSignal);
    const authorization = (capturedInit.headers as Record<string, string>).Authorization;
    const requestSignature = /signature="([^"]+)"/.exec(authorization)![1];
    expect(verify('RSA-SHA256', Buffer.from(`POST\n/v3/pay/transactions/jsapi\n${now}\nrequest-nonce\n${capturedInit.body}\n`), merchant.publicKey, Buffer.from(requestSignature, 'base64'))).toBe(true);
    expect(verify('RSA-SHA256', Buffer.from(`${appId}\n${result.timeStamp}\n${result.nonceStr}\n${result.package}\n`), merchant.publicKey, Buffer.from(result.paySign, 'base64'))).toBe(true);
  });
  it('only exposes verified provider error classifications and accepts signed close 204', async () => {
    const signed = new WeChatClient({ ...options, fetch: async () => response({ code: 'ORDER_NOT_EXIST', message: 'private-provider-message' }, 404) });
    await expect(signed.payment('GET', '/v3/pay/transactions/out-trade-no/ARL_123?mchid=merchant-1')).rejects.toMatchObject({ status: 502, providerCode: 'ORDER_NOT_EXIST' });
    const unsigned = new WeChatClient({ ...options, fetch: async () => new Response(JSON.stringify({ code: 'ORDER_NOT_EXIST' }), { status: 404 }) });
    try { await unsigned.payment('GET', '/v3/pay/transactions/out-trade-no/ARL_123'); throw Error('Expected failure'); }
    catch (error: any) { expect(error.status).toBe(403); expect(error.providerCode).toBeUndefined(); }
    const close = new WeChatClient({ ...options, fetch: async () => response('', 204) });
    expect(await close.payment('POST', '/v3/pay/transactions/out-trade-no/ARL_123/close', { mchid: mchId })).toEqual({});
  });
  it.each([-301, 301])('rejects signed provider clocks offset by %s seconds', async offset => {
    const client = new WeChatClient({ ...options, fetch: async () => response({ trade_state: 'SUCCESS' }, 200, now + offset) });
    await expect(client.payment('GET', '/v3/pay/transactions/out-trade-no/ARL_123')).rejects.toMatchObject({ status: 403 });
  });
  it('verifies raw notification bytes before AES-GCM and binds decrypted merchant/app', async () => {
    const client = new WeChatClient(options), notice = notification({ mchid: mchId, appid: appId, out_trade_no: 'ARL_123', trade_state: 'SUCCESS' });
    expect((await client.notification(notice.raw, notice.headers)).resource).toMatchObject({ mchid: mchId, appid: appId });
    await expect(client.notification(notice.raw + '\n', notice.headers)).rejects.toMatchObject({ status: 403 });
    const otherMerchant = notification({ mchid: 'another-merchant', appid: appId });
    await expect(client.notification(otherMerchant.raw, otherMerchant.headers)).rejects.toMatchObject({ status: 403 });
    const otherApp = notification({ mchid: mchId, appid: 'wxaaaaaaaaaaaaaaaa' });
    await expect(client.notification(otherApp.raw, otherApp.headers)).rejects.toMatchObject({ status: 403 });
  });
  it('decrypts delayed signed notifications with bounded historical APIv3 keys after rotation', async () => {
    const currentKey = '98765432109876543210987654321098';
    const client = new WeChatClient({ ...options, apiV3Key: currentKey, apiV3Keys: [apiV3Key] });
    const old = notification({ mchid: mchId, appid: appId, out_trade_no: 'ARL_old' });
    expect((await client.notification(old.raw, old.headers)).resource.out_trade_no).toBe('ARL_old');
    const current = notification({ mchid: mchId, appid: appId, out_trade_no: 'ARL_current' }, currentKey);
    expect((await client.notification(current.raw, current.headers)).resource.out_trade_no).toBe('ARL_current');
    await expect(client.notification(old.raw + ' ', old.headers)).rejects.toMatchObject({ status: 403 });
    const otherMerchant = notification({ mchid: 'other-merchant', appid: appId });
    await expect(client.notification(otherMerchant.raw, otherMerchant.headers)).rejects.toMatchObject({ status: 403 });
    const unknownKey = notification({ mchid: mchId, appid: appId }, '11111111111111111111111111111111');
    await expect(client.notification(unknownKey.raw, unknownKey.headers)).rejects.toMatchObject({ status: 400 });
  });
  it('rejects malformed or oversized historical key rings without exposing key material', async () => {
    for (const apiV3Keys of [['invalid-historical-key'], Array.from({ length: 8 }, (_, index) => String(index).padStart(32, '0'))]) {
      const client = new WeChatClient({ ...options, apiV3Keys });
      expect(client.isPaymentReady()).toBe(false);
      const notice = notification({ mchid: mchId, appid: appId });
      await expect(client.notification(notice.raw, notice.headers)).rejects.toMatchObject({ status: 503, message: '微信支付验证或商户配置不完整' });
    }
  });
  it('keeps malformed payment configuration isolated from normal login', async () => {
    const client = new WeChatClient({ ...options, privateKey: 'broken-key-must-not-leak', fetch: async () => new Response(JSON.stringify({ openid: 'user-1' })) });
    expect(client.isPaymentReady()).toBe(false);
    expect(await client.codeSession('code')).toEqual({ openid: 'user-1' });
    await expect(client.payment('GET', '/v3/refund/domestic/refunds/ARF_123')).rejects.toMatchObject({ status: 503, message: '微信支付验证或商户配置不完整' });
  });
});
