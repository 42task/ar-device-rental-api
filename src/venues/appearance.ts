import type { RentalAuth, RentalPrincipal } from '../auth';
import { loadAccountPermissions, requireMerchantManagementScope } from '../auth/identity';
import type { Context, Row } from '../core/contracts';
import type { Database } from '../core/database';
import { ApiError } from '../core/errors';
import { parseHeroDataUrl, validateHeroUrl, type ImageAsset } from '../core/images';
import { requireUserAdmin } from '../core/roles';
import type { ApiRouter } from '../core/router';
import { currentMerchant, entryMerchant } from '../merchants/context';
import { merchantId } from '../merchants/registry';

export const VENUE_THEMES = ['aero', 'forest', 'sunset', 'ink'] as const;

export class VenueAppearanceService {
  constructor(private readonly db: Database, private readonly now: () => number = Date.now) {}
  private scope(): number {
    const id = currentMerchant()?.id;
    if (!Number.isSafeInteger(id) || !id || id < 1) throw new ApiError(503, '请先选择有效商户');
    return id;
  }
  private async actor(db: Database, principal: RentalPrincipal): Promise<void> {
    const row = await db.one('SELECT id,role,merchant_id,auth_version FROM ar_user WHERE id=? FOR UPDATE', [principal.user.id]);
    const user = row ? await loadAccountPermissions(db, row) : null;
    if (!user) throw new ApiError(403, '景点外观管理权限已变更，请重新登录');
    requireUserAdmin(user);
    requireMerchantManagementScope(user);
    if (Number(user.auth_version ?? 0) !== Number(principal.authVersion ?? principal.user.auth_version ?? 0)) throw new ApiError(401, '账号归属已变更，请重新登录');
  }
  private view(venue: Row, appearance: Row | null): Row {
    const current = currentMerchant();
    const origin = current?.id === Number(venue.merchant_id) ? current.origin : entryMerchant()?.origin;
    return { venue: { id: Number(venue.id), merchantId: Number(venue.merchant_id), name: venue.name }, appearance: {
      theme: appearance?.theme ?? 'aero',
      heroImageUrl: appearance?.image_data ? `${origin}/api/v2/rental/venues/${venue.id}/appearance/hero?v=${appearance.version}` : appearance?.image_url ?? '',
      version: Number(appearance?.version ?? 0), updatedAt: appearance ? new Date(Number(appearance.updated_ms)).toISOString() : null,
    } };
  }
  async managed(principal: RentalPrincipal, venueId: unknown): Promise<Row> {
    const ownerId = this.scope(), id = merchantId(venueId);
    return this.db.transaction(async db => {
      await this.actor(db, principal);
      const venue = await db.one('SELECT id,merchant_id,name FROM ar_venue WHERE id=? AND merchant_id=?', [id, ownerId]);
      if (!venue) throw new ApiError(404, '景点不存在');
      return this.view(venue, await db.one('SELECT * FROM ar_venue_appearance WHERE venue_id=? AND merchant_id=?', [id, ownerId]));
    });
  }
  async save(principal: RentalPrincipal, venueId: unknown, input: Row): Promise<Row> {
    const ownerId = this.scope(), id = merchantId(venueId);
    return this.db.transaction(async db => {
      await this.actor(db, principal);
      for (const key of ['merchantId', 'merchant_id']) if (Object.prototype.hasOwnProperty.call(input, key) && merchantId(input[key]) !== ownerId) throw new ApiError(422, '所属商户与当前管理范围不一致');
      for (const key of ['venueId', 'venue_id']) if (Object.prototype.hasOwnProperty.call(input, key) && merchantId(input[key]) !== id) throw new ApiError(422, '景点与当前外观设置不一致');
      const venue = await db.one('SELECT id,merchant_id,name FROM ar_venue WHERE id=? AND merchant_id=? FOR UPDATE', [id, ownerId]);
      if (!venue) throw new ApiError(404, '景点不存在');
      const previous = await db.one('SELECT * FROM ar_venue_appearance WHERE venue_id=? AND merchant_id=? FOR UPDATE', [id, ownerId]);
      if (!Number.isSafeInteger(input.version) || input.version < 0) throw new ApiError(422, '请提供当前景点外观版本');
      if (input.version !== Number(previous?.version ?? 0)) throw new ApiError(409, '景点外观已被其他管理员修改，请刷新后重试');
      for (const key of ['displayName', 'logoUrl', 'logoDataUrl']) if (Object.prototype.hasOwnProperty.call(input, key)) throw new ApiError(422, '商户名称和 Logo 请在品牌设置中配置');
      if (!VENUE_THEMES.includes(input.theme)) throw new ApiError(422, '请选择有效的景点风格');
      if (input.heroDataUrl !== undefined && input.heroImageUrl !== undefined) throw new ApiError(422, '请只选择上传主图或主图链接中的一种');
      let imageUrl = previous?.image_url ?? '', imageData = previous?.image_data ?? null, imageMime = previous?.image_mime ?? null;
      if (input.heroImageUrl !== undefined) { imageUrl = validateHeroUrl(input.heroImageUrl); imageData = null; imageMime = null; }
      if (input.heroDataUrl !== undefined) { const image = parseHeroDataUrl(input.heroDataUrl); imageUrl = ''; imageData = image.data; imageMime = image.mime; }
      const values = [input.theme, imageUrl, imageData, imageMime, input.version + 1, this.now(), principal.user.id];
      if (previous) await db.execute('UPDATE ar_venue_appearance SET theme=?,image_url=?,image_data=?,image_mime=?,version=?,updated_ms=?,updated_by=? WHERE venue_id=? AND merchant_id=?', [...values, id, ownerId]);
      else await db.execute('INSERT INTO ar_venue_appearance (theme,image_url,image_data,image_mime,version,updated_ms,updated_by,venue_id,merchant_id) VALUES (?,?,?,?,?,?,?,?,?)', [...values, id, ownerId]);
      return this.view(venue, await db.one('SELECT * FROM ar_venue_appearance WHERE venue_id=? AND merchant_id=?', [id, ownerId]));
    });
  }
  private async publicVenue(venueId: unknown): Promise<Row> {
    const entry = entryMerchant();
    if (!entry || entry.status !== 'active') throw new ApiError(404, '景点外观不可用');
    const venue = await this.db.one("SELECT v.id,v.merchant_id,v.name FROM ar_venue v INNER JOIN ar_merchant m ON m.id=v.merchant_id INNER JOIN ar_application_merchant am ON am.merchant_id=m.id WHERE v.id=? AND am.application_id=? AND m.status='active' AND v.status='active'", [merchantId(venueId), entry.id]);
    if (!venue) throw new ApiError(404, '景点外观不可用');
    return venue;
  }
  async public(venueId: unknown): Promise<Row> {
    const venue = await this.publicVenue(venueId);
    return this.view(venue, await this.db.one('SELECT * FROM ar_venue_appearance WHERE venue_id=? AND merchant_id=?', [venue.id, venue.merchant_id]));
  }
  async hero(venueId: unknown): Promise<ImageAsset> {
    const venue = await this.publicVenue(venueId);
    const row = await this.db.one('SELECT image_data,image_mime FROM ar_venue_appearance WHERE venue_id=? AND merchant_id=?', [venue.id, venue.merchant_id]);
    if (!row?.image_data || !['image/png', 'image/jpeg', 'image/webp'].includes(row.image_mime)) throw new ApiError(404, '景点主图不存在');
    return { data: Buffer.from(row.image_data), mime: row.image_mime };
  }
}

export function registerVenueAppearance(router: ApiRouter, db: Database, auth: RentalAuth): void {
  const service = new VenueAppearanceService(db);
  const principal = async (ctx: Context) => {
    const identity = await auth.authenticate(ctx);
    requireUserAdmin(identity.user);
    requireMerchantManagementScope(identity.user);
    if (identity.user.role === 'root' && (typeof ctx.req.headers['x-merchant-id'] !== 'string' || !ctx.req.headers['x-merchant-id'].trim())) throw new ApiError(422, '请先选择所属商户');
    return identity;
  };
  router.add('GET', '/v2/rental/admin/venues/:id/appearance', async ctx => service.managed(await principal(ctx), ctx.params.id));
  router.add('PATCH', '/v2/rental/admin/venues/:id/appearance', async ctx => service.save(await principal(ctx), ctx.params.id, ctx.body));
  router.add('GET', '/v2/rental/venues/:id/appearance', ctx => service.public(ctx.params.id));
  router.add('GET', '/v2/rental/venues/:id/appearance/hero', async ctx => {
    const image = await service.hero(ctx.params.id);
    ctx.res.setHeader('Content-Type', image.mime);
    ctx.res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    ctx.res.send(image.data);
  });
}
