import type { RentalAuth, RentalPrincipal } from '../auth';
import { loadAccountPermissions, requireMerchantManagementScope } from '../auth/identity';
import type { Context, Row } from '../core/contracts';
import type { Database } from '../core/database';
import { ApiError } from '../core/errors';
import { requireManager, requireUserAdmin } from '../core/roles';
import type { ApiRouter } from '../core/router';
import { currentMerchant } from '../merchants/context';

const MAX_CENTS = 2147483647;
const positiveId = (value: unknown): number => {
  const id = typeof value === 'number' ? value : typeof value === 'string' && /^[1-9][0-9]*$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(id) || id < 1) throw new ApiError(422, '场地编号无效');
  return id;
};
const text = (value: unknown, label: string, max: number, required = false, multiline = false): string => {
  if (typeof value !== 'string' || [...value.trim()].length > max || (multiline ? /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/ : /[\x00-\x1f\x7f]/).test(value) || required && !value.trim()) throw new ApiError(422, label + '无效');
  return value.trim();
};
const money = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > MAX_CENTS) throw new ApiError(422, '场地费用须为非负整数分');
  return value;
};

/** Customer-facing venue details deliberately exclude contacts and internal ownership. */
export function publicVenue(row: Row): Row {
  return { id: Number(row.id), name: row.name, address: row.address, description: row.description };
}
export function managedVenue(row: Row): Row {
  return { ...publicVenue(row), merchantId: Number(row.merchant_id), contactName: row.contact_name, contactPhone: row.contact_phone,
    status: row.status, useFeeCents: Number(row.use_fee_cents), depositCents: Number(row.deposit_cents), version: Number(row.version),
    createdAt: new Date(Number(row.created_ms)).toISOString(), updatedAt: new Date(Number(row.updated_ms)).toISOString() };
}

export class VenueService {
  constructor(private readonly db: Database, private readonly now: () => number = Date.now) {}
  private scope(): number {
    const id = currentMerchant()?.id;
    if (!Number.isSafeInteger(id) || !id || id < 1) throw new ApiError(503, '请从有效商户入口管理场地');
    return id;
  }
  private async actor(db: Database, principal: RentalPrincipal, writing: boolean): Promise<void> {
    const row = await db.one('SELECT id,role,merchant_id,auth_version FROM ar_user WHERE id=? FOR UPDATE', [principal.user.id]);
    const user = row ? await loadAccountPermissions(db, row) : null;
    if (!user) throw new ApiError(403, '场地管理权限已变更，请重新登录');
    writing ? requireUserAdmin(user) : requireManager(user);
    requireMerchantManagementScope(user);
    if (Number(user.auth_version ?? 0) !== Number(principal.authVersion ?? principal.user.auth_version ?? 0)) throw new ApiError(401, '账号归属已变更，请重新登录');
  }
  private values(input: Row, previous?: Row): Row {
    const name = text(input.name ?? previous?.name, '场地名称', 128, true);
    const address = text(input.address ?? previous?.address ?? '', '场地地址', 512);
    const contact_name = text(input.contactName ?? previous?.contact_name ?? '', '联系人', 64);
    const contact_phone = text(input.contactPhone ?? previous?.contact_phone ?? '', '联系电话', 64);
    const description = text(input.description ?? previous?.description ?? '', '场地说明', 2000, false, true);
    const status = input.status ?? previous?.status ?? 'active';
    if (!['active', 'paused'].includes(status)) throw new ApiError(422, '场地状态无效');
    const use_fee_cents = money(input.useFeeCents ?? previous?.use_fee_cents), deposit_cents = money(input.depositCents ?? previous?.deposit_cents);
    if (use_fee_cents + deposit_cents > MAX_CENTS) throw new ApiError(422, '场地费用合计超出允许范围');
    return { name, address, contact_name, contact_phone, description, status, use_fee_cents, deposit_cents };
  }
  async list(principal: RentalPrincipal, query: Row = {}): Promise<Row> {
    const merchantId = this.scope();
    return this.db.transaction(async db => {
      await this.actor(db, principal, false);
      const status = query.status;
      if (status !== undefined && !['active', 'paused'].includes(status)) throw new ApiError(422, '场地状态无效');
      const rows = await db.query('SELECT * FROM ar_venue WHERE merchant_id=?' + (status ? ' AND status=?' : '') + ' ORDER BY id DESC', [merchantId, ...(status ? [status] : [])]);
      return { items: rows.map(managedVenue) };
    });
  }
  async create(principal: RentalPrincipal, input: Row): Promise<Row> {
    const merchantId = this.scope();
    return this.db.transaction(async db => {
      await this.actor(db, principal, true);
      const values = this.values(input), now = this.now();
      const row = await db.insert('ar_venue', { ...values, merchant_id: merchantId, version: 1, created_ms: now, updated_ms: now, updated_by: principal.user.id });
      return { venue: managedVenue(row) };
    });
  }
  async update(principal: RentalPrincipal, venueId: unknown, input: Row): Promise<Row> {
    const merchantId = this.scope(), id = positiveId(venueId);
    return this.db.transaction(async db => {
      await this.actor(db, principal, true);
      const previous = await db.one('SELECT * FROM ar_venue WHERE id=? AND merchant_id=? FOR UPDATE', [id, merchantId]);
      if (!previous) throw new ApiError(404, '场地不存在');
      if (!Number.isSafeInteger(input.version) || input.version < 1) throw new ApiError(422, '请提供当前场地版本');
      if (Number(previous.version) !== input.version) throw new ApiError(409, '场地已被其他管理员修改，请刷新');
      const values = this.values(input, previous), entries = Object.entries(values);
      await db.execute('UPDATE ar_venue SET ' + entries.map(([name]) => name + '=?').join(',') + ',version=version+1,updated_ms=?,updated_by=? WHERE id=? AND merchant_id=?', [...entries.map(([, value]) => value), this.now(), principal.user.id, id, merchantId]);
      return { venue: managedVenue((await db.one('SELECT * FROM ar_venue WHERE id=? AND merchant_id=?', [id, merchantId]))!) };
    });
  }
}

export function registerVenues(router: ApiRouter, db: Database, auth: RentalAuth): void {
  const service = new VenueService(db);
  const route = (method: string, path: string, handler: (ctx: Context, principal: RentalPrincipal) => Promise<Row>) => router.add(method, path, async ctx => {
    ctx.res.setHeader('Cache-Control', 'no-store');
    return handler(ctx, await auth.authenticate(ctx));
  });
  route('GET', '/v2/rental/admin/venues', (ctx, principal) => service.list(principal, ctx.query));
  route('POST', '/v2/rental/admin/venues', (ctx, principal) => service.create(principal, ctx.body));
  route('PATCH', '/v2/rental/admin/venues/:id', (ctx, principal) => service.update(principal, ctx.params.id, ctx.body));
}
