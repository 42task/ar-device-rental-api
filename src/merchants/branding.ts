import type { RentalAuth, RentalPrincipal } from '../auth';
import { loadAccountPermissions, requireMerchantManagementScope } from '../auth/identity';
import type { Context, Row } from '../core/contracts';
import type { Database } from '../core/database';
import { ApiError } from '../core/errors';
import { requireUserAdmin } from '../core/roles';
import type { ApiRouter } from '../core/router';
import { currentMerchant, entryMerchant } from './context';
import { merchantId } from './registry';
import { parseLogoDataUrl, validateLogoUrl, type ImageAsset } from '../core/images';
export { MAX_LOGO_BYTES, parseLogoDataUrl, validateLogoUrl } from '../core/images';

export class BrandingService {
  constructor(private readonly db: Database, private readonly now: () => number = Date.now) {}
  private scope(): number {
    const id = currentMerchant()?.id;
    if (!Number.isSafeInteger(id) || !id || id < 1) throw new ApiError(503, '请先选择有效商户');
    return id;
  }
  private async actor(db: Database, principal: RentalPrincipal): Promise<void> {
    const row = await db.one('SELECT id,role,merchant_id,auth_version FROM ar_user WHERE id=? FOR UPDATE', [principal.user.id]);
    const user = row ? await loadAccountPermissions(db, row) : null;
    if (!user) throw new ApiError(403, '品牌管理权限已变更，请重新登录');
    requireUserAdmin(user);
    requireMerchantManagementScope(user);
    if (Number(user.auth_version ?? 0) !== Number(principal.authVersion ?? principal.user.auth_version ?? 0)) throw new ApiError(401, '账号归属已变更，请重新登录');
  }
  private view(merchant: Row, branding: Row | null): Row {
    const current = currentMerchant();
    const origin = current?.id === Number(merchant.id) ? current.origin : entryMerchant()?.origin;
    return { merchant: { id: Number(merchant.id), name: merchant.name, code: merchant.code }, branding: {
      displayName: branding?.display_name ?? (merchant.code === 'default' && Number(merchant.id) === 1 ? 'AR设备租赁' : merchant.name),
      logoUrl: branding?.logo_data ? `${origin}/api/v2/rental/branding/${merchant.id}/logo?v=${branding.version}` : branding?.logo_url ?? '',
      version: Number(branding?.version ?? 0), updatedAt: branding ? new Date(Number(branding.updated_ms)).toISOString() : null,
    } };
  }
  async managed(principal: RentalPrincipal): Promise<Row> {
    const id = this.scope();
    return this.db.transaction(async db => {
      await this.actor(db, principal);
      const merchant = await db.one('SELECT id,name,code FROM ar_merchant WHERE id=?', [id]);
      if (!merchant) throw new ApiError(404, '商户不存在');
      return this.view(merchant, await db.one('SELECT * FROM ar_merchant_branding WHERE merchant_id=?', [id]));
    });
  }
  async save(principal: RentalPrincipal, input: Row): Promise<Row> {
    const id = this.scope();
    return this.db.transaction(async db => {
      await this.actor(db, principal);
      for (const key of ['merchantId', 'merchant_id']) if (Object.prototype.hasOwnProperty.call(input, key) && merchantId(input[key]) !== id) throw new ApiError(422, '所属商户与当前管理范围不一致');
      // Locking the owner also serializes two first saves before a branding row exists.
      const merchant = await db.one('SELECT id,name,code FROM ar_merchant WHERE id=? FOR UPDATE', [id]);
      if (!merchant) throw new ApiError(404, '商户不存在');
      const previous = await db.one('SELECT * FROM ar_merchant_branding WHERE merchant_id=? FOR UPDATE', [id]);
      if (!Number.isSafeInteger(input.version) || input.version < 0) throw new ApiError(422, '请提供当前品牌配置版本');
      if (input.version !== Number(previous?.version ?? 0)) throw new ApiError(409, '品牌配置已被其他管理员修改，请刷新后重试');
      const name = input.displayName;
      if (typeof name !== 'string' || !name.trim() || [...name.trim()].length > 32 || /[\x00-\x1f\x7f]/.test(name)) throw new ApiError(422, '显示名称须为 1 至 32 个字符');
      for (const key of ['theme', 'heroImageUrl', 'heroDataUrl']) if (Object.prototype.hasOwnProperty.call(input, key)) throw new ApiError(422, '配色和主图请在景点外观设置中配置');
      if (input.logoDataUrl !== undefined && input.logoUrl !== undefined) throw new ApiError(422, '请只选择上传图片或 Logo 链接中的一种');
      let logoUrl = previous?.logo_url ?? '', logoData = previous?.logo_data ?? null, logoMime = previous?.logo_mime ?? null;
      if (input.logoUrl !== undefined) { logoUrl = validateLogoUrl(input.logoUrl); logoData = null; logoMime = null; }
      if (input.logoDataUrl !== undefined) { const logo = parseLogoDataUrl(input.logoDataUrl); logoData = logo.data; logoMime = logo.mime; logoUrl = ''; }
      const values = [name.trim(), logoUrl, logoData, logoMime, input.version + 1, this.now(), principal.user.id];
      if (previous) await db.execute('UPDATE ar_merchant_branding SET display_name=?,logo_url=?,logo_data=?,logo_mime=?,version=?,updated_ms=?,updated_by=? WHERE merchant_id=?', [...values, id]);
      else await db.execute('INSERT INTO ar_merchant_branding (display_name,logo_url,logo_data,logo_mime,version,updated_ms,updated_by,merchant_id) VALUES (?,?,?,?,?,?,?,?)', [...values, id]);
      return this.view(merchant, await db.one('SELECT * FROM ar_merchant_branding WHERE merchant_id=?', [id]));
    });
  }
  private async publicMerchant(id: unknown): Promise<Row> {
    const entry = entryMerchant();
    if (!entry || entry.status !== 'active') throw new ApiError(404, '商户品牌不可用');
    const merchant = await this.db.one("SELECT m.id,m.name,m.code FROM ar_merchant m INNER JOIN ar_application_merchant am ON am.merchant_id=m.id WHERE m.id=? AND am.application_id=? AND m.status='active'", [merchantId(id), entry.id]);
    if (!merchant) throw new ApiError(404, '商户品牌不可用');
    return merchant;
  }
  async public(id: unknown): Promise<Row> {
    const merchant = await this.publicMerchant(id);
    return this.view(merchant, await this.db.one('SELECT * FROM ar_merchant_branding WHERE merchant_id=?', [merchant.id]));
  }
  async logo(id: unknown): Promise<ImageAsset> {
    const merchant = await this.publicMerchant(id);
    const row = await this.db.one('SELECT logo_data,logo_mime FROM ar_merchant_branding WHERE merchant_id=?', [merchant.id]);
    if (!row?.logo_data || !['image/png', 'image/jpeg', 'image/webp'].includes(row.logo_mime)) throw new ApiError(404, 'Logo 不存在');
    return { data: Buffer.from(row.logo_data), mime: row.logo_mime };
  }
}

export function registerBranding(router: ApiRouter, db: Database, auth: RentalAuth): void {
  const service = new BrandingService(db);
  const principal = async (ctx: Context) => {
    const identity = await auth.authenticate(ctx);
    requireUserAdmin(identity.user);
    requireMerchantManagementScope(identity.user);
    if (identity.user.role === 'root' && (typeof ctx.req.headers['x-merchant-id'] !== 'string' || !ctx.req.headers['x-merchant-id'].trim())) throw new ApiError(422, '请先选择所属商户');
    return identity;
  };
  router.add('GET', '/v2/rental/admin/branding', async ctx => service.managed(await principal(ctx)));
  router.add('PATCH', '/v2/rental/admin/branding', async ctx => service.save(await principal(ctx), ctx.body));
  router.add('GET', '/v2/rental/branding/:id', ctx => service.public(ctx.params.id));
  router.add('GET', '/v2/rental/branding/:id/logo', async ctx => {
    const logo = await service.logo(ctx.params.id);
    ctx.res.setHeader('Content-Type', logo.mime);
    ctx.res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    ctx.res.send(logo.data);
  });
}
