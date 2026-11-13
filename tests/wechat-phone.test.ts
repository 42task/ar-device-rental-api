import { describe, expect, it, vi } from 'vitest';
import { WeChatClient, type WeChatOptions } from '../src/payments/wechat';

const now = 1_800_000_000, appId = 'wx03dbf50c15cac06f';
const purePhoneNumber = '13800138000', countryCode = '86';
const valid = () => ({ errcode: 0, errmsg: 'ok', phone_info: { phoneNumber: purePhoneNumber, purePhoneNumber, countryCode, watermark: { appid: appId, timestamp: now } } });
const token = () => new Response(JSON.stringify({ access_token: 'synthetic-phone-test-token', expires_in: 7200 }));
function build(result: unknown = valid(), overrides: Partial<WeChatOptions> = {}) {
  const fetcher = vi.fn(async (input: string | URL | Request, _init?: RequestInit): Promise<Response> => String(input).endsWith('/stable_token') ? token() : new Response(JSON.stringify(result)));
  return { client: new WeChatClient({ appId, appSecret: 'synthetic-phone-test-secret', now: () => now, fetch: fetcher, ...overrides }), fetcher };
}

describe('server-verified WeChat phone authorization', () => {
  it('uses the phone authorization endpoint with only code and returns canonical internal data', async () => {
    const f = build();
    expect(await f.client.phoneNumber('synthetic-phone-code')).toEqual({ phoneE164: '+8613800138000', countryCode });
    const [input, init] = f.fetcher.mock.calls[1];
    const url = new URL(String(input));
    expect(url.origin).toBe('https://api.weixin.qq.com');
    expect(url.pathname).toBe('/wxa/business/getuserphonenumber');
    expect(url.searchParams.get('access_token')).toBe('synthetic-phone-test-token');
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' } });
    expect(init!.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(init!.body as string)).toEqual({ code: 'synthetic-phone-code' });
    expect(f.fetcher.mock.calls.every(call => !String(call[0]).includes('/sns/jscode2session'))).toBe(true);
  });
  it('accepts matching international E.164 and exact watermark time boundaries', async () => {
    for (const offset of [-300, 60]) {
      const result = valid(); result.phone_info.watermark.timestamp = now + offset;
      expect(await build(result).client.phoneNumber('phone-code')).toEqual({ phoneE164: '+8613800138000', countryCode });
    }
    const result = { errcode: 0, phone_info: { phoneNumber: '+447700900123', purePhoneNumber: '7700900123', countryCode: '44', watermark: { appid: appId, timestamp: now } } };
    expect(await build(result).client.phoneNumber('phone-code')).toEqual({ phoneE164: '+447700900123', countryCode: '44' });
    result.phone_info.phoneNumber = '447700900123';
    expect(await build(result).client.phoneNumber('phone-code')).toEqual({ phoneE164: '+447700900123', countryCode: '44' });
    const mainland = valid(); mainland.phone_info.phoneNumber = '8613800138000';
    expect(await build(mainland).client.phoneNumber('phone-code')).toEqual({ phoneE164: '+8613800138000', countryCode: '86' });
  });
  it.each([-301, 61])('rejects an authorization timestamp offset by %s seconds', async offset => {
    const result = valid(); result.phone_info.watermark.timestamp += offset;
    await expect(build(result).client.phoneNumber('phone-code')).rejects.toMatchObject({ status: 400, message: '微信手机号验证失败，请重新授权' });
  });
  it('rejects mismatched AppIDs and missing or malformed watermarks', async () => {
    for (const watermark of [undefined, null, [], { appid: 'wxaaaaaaaaaaaaaaaa', timestamp: now }, { appid: appId, timestamp: String(now) }, { appid: appId, timestamp: now + 0.5 }]) {
      const result: any = valid(); result.phone_info.watermark = watermark;
      await expect(build(result).client.phoneNumber('phone-code')).rejects.toMatchObject({ status: 400 });
    }
  });
  it('rejects noncanonical numbers, unexpected country codes and inconsistent provider fields', async () => {
    const changes = [
      { countryCode: 86 }, { countryCode: '086' }, { countryCode: '+86' }, { countryCode: '1234' },
      { purePhoneNumber: 13800138000 }, { purePhoneNumber: '138 0013 8000' }, { purePhoneNumber: '13800138000\n' },
      { purePhoneNumber: '12800138000', phoneNumber: '12800138000' }, { purePhoneNumber: '1380013800', phoneNumber: '1380013800' },
      { countryCode: '1', purePhoneNumber: '123', phoneNumber: '123' },
      { countryCode: '44', purePhoneNumber: '1234', phoneNumber: '1234' },
      { countryCode: '44', purePhoneNumber: '12345678901234', phoneNumber: '12345678901234' },
      { countryCode: '44', purePhoneNumber: '0000000000', phoneNumber: '0000000000' },
      { phoneNumber: '13900139000' }, { phoneNumber: '+8613800138001' },
    ];
    for (const change of changes) {
      const result = valid(); Object.assign(result.phone_info, change);
      await expect(build(result).client.phoneNumber('phone-code')).rejects.toMatchObject({ status: 400 });
    }
  });
  it('rejects cancelled, absent, malformed and used codes without exposing provider content', async () => {
    const invalid: unknown[] = ['', ' ', 'code\n', 'a'.repeat(1025), null, {}, 7];
    for (const code of invalid) {
      const f = build();
      await expect(f.client.phoneNumber(code as string)).rejects.toMatchObject({ status: 400 });
      expect(f.fetcher).not.toHaveBeenCalled();
    }
    for (const errcode of [40029, 40163, 40013]) {
      const f = build({ errcode, errmsg: 'synthetic-private-provider-message' });
      await expect(f.client.phoneNumber('used-code')).rejects.toMatchObject({ status: 400, message: '微信手机号授权已失效或未成功，请重新授权' });
      expect(f.fetcher).toHaveBeenCalledTimes(2);
    }
  });
  it('refreshes an invalid cached token once and does not retry an already-used phone code', async () => {
    let tokenCalls = 0, phoneCalls = 0;
    const f = build(undefined, { fetch: async input => {
      if (String(input).endsWith('/stable_token')) { tokenCalls++; return token(); }
      phoneCalls++; return new Response(JSON.stringify(phoneCalls === 1 ? { errcode: 40001 } : valid()));
    } });
    expect(await f.client.phoneNumber('phone-code')).toEqual({ phoneE164: '+8613800138000', countryCode });
    expect(tokenCalls).toBe(2); expect(phoneCalls).toBe(2);
    const used = build({ errcode: 40163, errmsg: 'code been used' });
    await expect(used.client.phoneNumber('phone-code')).rejects.toMatchObject({ status: 400 });
    expect(used.fetcher).toHaveBeenCalledTimes(2);
  });
  it('preserves honest transport and malformed-response failures without a success result', async () => {
    const unreachable = build(undefined, { fetch: async input => {
      if (String(input).endsWith('/stable_token')) return token();
      throw new Error('synthetic-code-and-token-must-not-be-reflected');
    } });
    await expect(unreachable.client.phoneNumber('phone-code')).rejects.toMatchObject({ status: 503, message: '微信服务暂时不可用' });
    const malformed = build(undefined, { fetch: async input => String(input).endsWith('/stable_token') ? token() : new Response('provider-private-body', { status: 502 }) });
    await expect(malformed.client.phoneNumber('phone-code')).rejects.toMatchObject({ status: 502, message: '微信手机号响应格式无效，请重新授权' });
    for (const result of [null, [], {}, { errcode: 0, phone_info: [] }, { errcode: '0', phone_info: valid().phone_info }]) await expect(build(result).client.phoneNumber('phone-code')).rejects.toMatchObject({ status: 400 });
  });
});
