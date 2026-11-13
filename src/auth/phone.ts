import { createHash } from 'node:crypto';
import type { RentalAuth, RentalPrincipal } from './index';
import type { Context, Row } from '../core/contracts';
import type { Database } from '../core/database';
import { ApiError } from '../core/errors';
import type { ApiRouter } from '../core/router';
import type { WeChatClient } from '../payments/wechat';

/** Console input normalization only; this never establishes ownership. */
export function normalizePhoneInput(value: unknown): string {
  if (typeof value !== 'string') throw new ApiError(422, '请输入完整的已验证手机号');
  const number = /^1[3-9][0-9]{9}$/.test(value) ? '+86' + value : value;
  if (!/^\+[1-9][0-9]{6,14}$/.test(number) || number.startsWith('+86') && !/^\+861[3-9][0-9]{9}$/.test(number)) throw new ApiError(422, '手机号格式无效，请使用完整国际号码或大陆11位手机号');
  return number;
}

export function maskedPhone(phone: string, countryCode: string): string {
  const local = phone.slice(countryCode.length + 1);
  return '+' + countryCode + ' ' + (local.length >= 8 ? local.slice(0, 3) + '****' + local.slice(-4) : '****' + local.slice(-2));
}

function publicStatus(row: Row | null): Row {
  return row ? { verified: true, maskedNumber: maskedPhone(row.phone_e164, row.country_code), countryCode: row.country_code, verifiedAt: new Date(Number(row.verified_ms)).toISOString() } : { verified: false };
}

async function binding(db: Database, principal: RentalPrincipal): Promise<Row | null> {
  return db.one('SELECT * FROM ar_user_phone WHERE user_id=? AND appid=? AND verified_ms>0', [principal.user.id, principal.appid]);
}

/** Only this provenance table establishes a verified phone, never ar_user.tel. */
export async function requireVerifiedPhone(db: Database, principal: RentalPrincipal): Promise<Row> {
  const row = await binding(db, principal);
  if (!row) throw new ApiError(403, '请先在小程序授权验证手机号', 'PHONE_VERIFICATION_REQUIRED');
  return row;
}

export class PhoneBinding {
  constructor(private readonly db: Database, private readonly client: WeChatClient, private readonly auth: RentalAuth, private readonly now: () => number = Date.now) {}
  async statusFor(principal: RentalPrincipal): Promise<Row> { return publicStatus(await binding(this.db, principal)); }
  async requireVerifiedPhone(principal: RentalPrincipal): Promise<Row> { return requireVerifiedPhone(this.db, principal); }
  async bind(principal: RentalPrincipal, code: unknown): Promise<Row> {
    if (principal.appid !== this.auth.appId) throw new ApiError(401, '当前小程序身份无效，请重新登录');
    try {
      return await this.db.transaction(async db => {
        const user = await db.one('SELECT * FROM ar_user WHERE id=? AND appid=? FOR UPDATE', [principal.user.id, this.auth.appId]);
        if (!user || user.openid !== principal.openid) throw new ApiError(401, '当前微信账号已失效，请重新登录');
        const current = await binding(db, principal);
        if (current) return publicStatus(current);
        if (typeof code !== 'string' || !/^[^\s\x00-\x1f\x7f]{1,1024}$/.test(code)) throw new ApiError(422, '手机号授权 code 无效，请重新授权');
        const codeHash = createHash('sha256').update(code).digest('hex');
        const previousCode = await db.one('SELECT user_id FROM ar_user_phone WHERE code_hash=?', [codeHash]);
        if (previousCode) throw new ApiError(409, '手机号授权凭据已使用，请重新授权');
        // Serialize first binding before consuming WeChat's one-use code. Same-user retries return above.
        const phone = await this.client.phoneNumber(code);
        const phoneE164 = normalizePhoneInput(phone.phoneE164);
        if (!/^[1-9][0-9]{0,2}$/.test(phone.countryCode) || !phoneE164.startsWith('+' + phone.countryCode)) throw new ApiError(502, '微信手机号验证结果无效，请重新授权');
        if (await db.one('SELECT user_id FROM ar_user_phone WHERE appid=? AND phone_e164=?', [this.auth.appId, phoneE164])) throw new ApiError(409, '该手机号已绑定其他微信账号，请联系管理员核实');
        const row = { user_id: user.id, appid: this.auth.appId, phone_e164: phoneE164, country_code: phone.countryCode, verified_ms: this.now(), code_hash: codeHash };
        await db.execute('INSERT INTO ar_user_phone (user_id,appid,phone_e164,country_code,verified_ms,code_hash) VALUES (?,?,?,?,?,?)', Object.values(row));
        return publicStatus(row);
      });
    } catch (error: any) {
      if (error?.code === 'ER_DUP_ENTRY') throw new ApiError(409, '手机号或授权凭据已绑定，请刷新并重新核实');
      throw error;
    }
  }
  register(router: ApiRouter): void {
    const route = (method: string, handler: (ctx: Context) => Promise<Row>) => router.add(method, '/v2/rental/auth/phone', ctx => {
      ctx.res.setHeader('Cache-Control', 'no-store'); return handler(ctx);
    });
    route('GET', async ctx => this.statusFor(await this.auth.authenticateBearer(ctx)));
    route('POST', async ctx => {
      const principal = await this.auth.authenticateBearer(ctx);
      if (Object.keys(ctx.body).some(key => key !== 'code')) throw new ApiError(422, '手机号绑定仅接受微信授权 code');
      return this.bind(principal, ctx.body.code);
    });
  }
}
