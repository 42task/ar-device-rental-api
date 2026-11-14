import { randomBytes } from 'node:crypto';
import type { Context, Row, Services } from '../core/contracts';
import type { Database } from '../core/database';
import { ApiError } from '../core/errors';
import { hasDeviceManagement, requireManager } from '../core/roles';
import { DeviceService, deviceUuid } from '../devices/service';
import { rentalOrderNumber, rentalRefundNumber } from './numbers';
import type { RentalOptions, RentalPrincipal } from './types';
import { currentMerchant, entryMerchant, withMerchant } from '../merchants/context';
import type { WeChatClient } from '../payments/wechat';
import { publicVenue } from '../venues';
import { loadAccountPermissions } from '../auth/identity';
import { refundStatusAfterObservation } from './refund-state';
import { quoteForDevice, rentalCents as cents, venueForDevice } from './quotes';
import { readDevicePage } from './device-queries';

const iso = (value: unknown): string | null => value === null || value === undefined ? null : new Date(Number(value)).toISOString();
const id = (value: unknown): number => {
  if (!((typeof value === 'number' && Number.isSafeInteger(value)) || typeof value === 'string' && /^[1-9][0-9]*$/.test(value))) throw new ApiError(422, '编号无效');
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new ApiError(422, '编号无效');
  return number;
};
const requestKey = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{8,80}$/.test(value)) throw new ApiError(422, '请求标识无效');
  return value;
};
const manager = (principal: RentalPrincipal) => hasDeviceManagement(principal.user);
const pagination = (query: Row): { page: number; pageSize: number } => {
  const requested = Number(query.page), size = Number(query.pageSize || query['per-page'] || 20);
  const page = Number.isSafeInteger(requested) && requested > 0 ? Math.min(requested, 10000000) : 1;
  const pageSize = Number.isFinite(size) && size > 0 ? Math.min(50, Math.max(1, Math.floor(size))) : 20;
  return { page, pageSize };
};

export class RentalService {
  private readonly now: () => number;
  private readonly callbackBase: string;
  constructor(private readonly services: Services, readonly options: RentalOptions) {
    this.now = options.now ?? Date.now;
    this.callbackBase = (options.callbackBaseUrl || process.env.RENTAL_CALLBACK_BASE_URL || 'https://d.4mr.cn/api/v2/rental').replace(/\/+$/, '');
  }
  private sharedApplication(): boolean {
    const entry = entryMerchant(), merchant = currentMerchant();
    return !!this.options.resolveMerchant && !!entry && !!merchant && entry.appId === merchant.appId;
  }
  private async withOwner<T>(owner: unknown, hidden: boolean, operation: () => Promise<T>): Promise<T> {
    const entry = entryMerchant(), resolve = this.options.resolveMerchant;
    if (!resolve || !entry) return operation();
    const merchantId = Number(owner);
    if (!Number.isSafeInteger(merchantId) || merchantId < 1) throw new ApiError(503, '设备或订单商户归属无效');
    if (currentMerchant()?.id === merchantId) return operation();
    const target = await resolve(merchantId);
    if (target.id !== merchantId) throw new ApiError(503, '商户配置归属不一致');
    if (target.appId !== entry.appId) {
      if (hidden) throw new ApiError(404, '设备或租赁订单不存在');
      throw new ApiError(409, '设备属于其他小程序，请使用对应小程序', 'MERCHANT_MISMATCH');
    }
    return withMerchant({ entry, merchant: target }, operation);
  }
  private async withDeviceMerchant<T>(principal: RentalPrincipal, column: 'id' | 'uuid', value: unknown, hidden: boolean, operation: () => Promise<T>): Promise<T> {
    if (!this.options.resolveMerchant || !entryMerchant()) return operation();
    this.assertPrincipal(principal);
    const device = await this.services.db.one(`SELECT merchant_id FROM ar_device WHERE ${column}=?`, [column === 'id' ? id(value) : deviceUuid(value)]);
    if (device) return this.withOwner(device.merchant_id, hidden, operation);
    // An employee can register a new scan for their own merchant from the shared
    // application. Client roles and merchant identifiers never choose ownership.
    if (column === 'uuid' && hasDeviceManagement(principal.user) && principal.user.role !== 'root') {
      const row = await this.services.db.one('SELECT id,role,merchant_id,auth_version FROM ar_user WHERE id=?', [principal.user.id]);
      const user = row ? await loadAccountPermissions(this.services.db, row) : null;
      if (user && hasDeviceManagement(user) && Number(user.auth_version) === Number(principal.authVersion ?? principal.user.auth_version)) {
        return this.withOwner(user.merchant_id, hidden, operation);
      }
    }
    return operation();
  }
  private async withOrderMerchant<T>(principal: RentalPrincipal, orderId: unknown, operation: () => Promise<T>): Promise<T> {
    if (!this.options.resolveMerchant || !entryMerchant()) return operation();
    this.assertPrincipal(principal);
    const order = await this.services.db.one('SELECT merchant_id FROM ar_rental_order WHERE id=?', [id(orderId)]);
    if (!order) throw new ApiError(404, '租赁订单不存在');
    return this.withOwner(order.merchant_id, true, operation);
  }
  paymentReady(): boolean {
    const merchant = currentMerchant(), client = merchant?.client ?? this.options.payment;
    return (!merchant || merchant.status === 'active') && client.config.appId === (merchant?.appId ?? this.options.appId) && client.isPaymentReady();
  }
  private assertReady(): void {
    if (!this.paymentReady()) throw new ApiError(503, '租赁微信支付尚未配置完成');
    (currentMerchant()?.client ?? this.options.payment).assertPaymentApplication();
  }
  private assertPrincipal(principal: RentalPrincipal): void {
    const merchant = currentMerchant();
    const shared = this.sharedApplication() && principal.appid === merchant?.appId;
    if (!principal.user || !Number.isSafeInteger(Number(principal.user.id)) || Number(principal.user.id) < 1 || !principal.openid
      || (merchant ? !shared && (Number(principal.merchantId) !== merchant.id || principal.user.role !== 'root' && principal.appid !== merchant.appId) : principal.appid !== this.options.appId)) throw new ApiError(401, '租赁登录信息无效，请重新登录');
  }
  private async orderPayment(row: Row): Promise<WeChatClient> {
    const client = this.options.resolvePaymentForOrder
      ? await this.options.resolvePaymentForOrder(row)
      : currentMerchant()?.client ?? this.options.payment;
    if (client.config.appId !== row.appid || client.config.mchId !== row.mch_id) throw new ApiError(503, '原订单支付配置不可用');
    return client;
  }
  private async assertCurrentPayer(principal: RentalPrincipal, db: Database): Promise<void> {
    const merchant = currentMerchant();
    if (!merchant) return;
    if (principal.appid !== merchant.appId) throw new ApiError(403, '请使用该商户的小程序身份租赁设备');
    const row = await db.one('SELECT id,role,merchant_id,auth_version FROM ar_user WHERE id=? FOR UPDATE', [principal.user.id]);
    const user = row ? await loadAccountPermissions(db, row) : null;
    if (!user || Number(user.auth_version) !== Number(principal.authVersion ?? principal.user.auth_version)) throw new ApiError(403, '用户归属已变更，请重新登录');
  }
  private async currentManager(principal: RentalPrincipal, db = this.services.db, lock = false): Promise<boolean> {
    if (!manager(principal)) return false;
    const merchant = currentMerchant();
    const row = merchant
      ? await db.one('SELECT id,role,merchant_id,auth_version FROM ar_user WHERE id=?' + (lock ? ' FOR UPDATE' : ''), [principal.user.id])
      : await db.one('SELECT id,role FROM ar_user WHERE id = ? AND appid = ?' + (lock ? ' FOR UPDATE' : ''), [principal.user.id, principal.appid]);
    const current = row ? await loadAccountPermissions(db, row) : null;
    return !!current && hasDeviceManagement(current) && (!merchant || Number(current.auth_version) === Number(principal.authVersion ?? principal.user.auth_version)
      && (current.role === 'root' || Number(current.merchant_id) === merchant.id));
  }
  private async requireCurrentManager(principal: RentalPrincipal, db = this.services.db, lock = false): Promise<void> {
    requireManager(principal.user);
    if (!await this.currentManager(principal, db, lock)) throw new ApiError(403, '管理员权限已变更，请重新登录');
  }
  private refundActions(row: Row | null, canManage: boolean): Row {
    const unsettled = !!row?.out_refund_no && row.refund_status !== 'SUCCESS';
    return {
      canEndRental: canManage && row?.status === 'ACTIVE' && row.payment_status === 'SUCCESS',
      canSyncRefund: canManage && unsettled,
      canRetryRefund: canManage && unsettled && ['PENDING', 'PROCESSING'].includes(row!.refund_status),
    };
  }
  private mine(row: Row, principal: RentalPrincipal): boolean { return Number(row.user_id) === Number(principal.user.id) && row.appid === principal.appid && (!currentMerchant() || this.sharedApplication() || Number(row.merchant_id) === currentMerchant()!.id); }
  private async readOrder(orderId: unknown, principal?: RentalPrincipal): Promise<Row> {
    const merchant = principal ? currentMerchant() : undefined;
    const row = await this.services.db.one('SELECT * FROM ar_rental_order WHERE id = ?' + (merchant ? ' AND merchant_id = ?' : ''), [id(orderId), ...(merchant ? [merchant.id] : [])]);
    if (!row || principal && !merchant && row.appid !== principal.appid) throw new ApiError(404, '租赁订单不存在');
    if (principal && !this.mine(row, principal) && !await this.currentManager(principal)) throw new ApiError(403, '不可查看他人的租赁订单');
    return row;
  }
  view(row: Row, principal?: RentalPrincipal): Row {
    const merchant = currentMerchant();
    return {
      id: Number(row.id), deviceId: Number(row.device_id), uuid: row.device_uuid, deviceName: row.device_name,
      venueId: row.venue_id == null ? null : Number(row.venue_id), venueName: row.venue_name ?? null,
      venuePriceVersion: row.venue_price_version == null ? null : Number(row.venue_price_version),
      ...(row.merchant_id === undefined ? {} : { merchantId: Number(row.merchant_id), merchantName: row.merchant_name ?? (Number(row.merchant_id) === merchant?.id ? merchant.name : undefined) }),
      status: row.status, paymentStatus: row.payment_status, refundStatus: row.refund_status ?? null,
      useFeeCents: Number(row.use_fee_cents), depositCents: Number(row.deposit_cents), totalCents: Number(row.total_cents),
      priceVersion: Number(row.price_version), refundMode: row.refund_mode ?? null, refundAmountCents: Number(row.refund_amount_cents || 0),
      createdAt: iso(row.created_ms), expiresAt: iso(row.expires_ms), paidAt: iso(row.paid_ms), startedAt: iso(row.started_ms), endedAt: iso(row.ended_ms), settledAt: iso(row.settled_ms),
      mine: principal ? this.mine(row, principal) : false,
    };
  }
  private displayDevice(device: Row): Row {
    const merchant = currentMerchant();
    return { ...DeviceService.display(device), ...(device.merchant_id === undefined ? {} : { merchantId: Number(device.merchant_id), merchantName: Number(device.merchant_id) === merchant?.id ? merchant.name : undefined }) };
  }
  async context(principal: RentalPrincipal, uuid: unknown): Promise<Row> {
    return this.withDeviceMerchant(principal, 'uuid', uuid, false, () => this.contextInMerchant(principal, uuid));
  }
  private async contextInMerchant(principal: RentalPrincipal, uuid: unknown): Promise<Row> {
    this.assertPrincipal(principal);
    const merchant = currentMerchant();
    const device = await this.services.db.one('SELECT * FROM ar_device WHERE uuid = ?', [deviceUuid(uuid)]);
    if (device && merchant && Number(device.merchant_id) !== merchant.id) throw new ApiError(409, '设备属于其他商户，请使用对应小程序', 'MERCHANT_MISMATCH');
    const canManage = await this.currentManager(principal);
    const owner = merchant ? { merchant: { id: merchant.id, name: merchant.name } } : {};
    if (!device) return { ...owner, device: null, state: 'UNREGISTERED', relation: 'none', pricing: null, rental: null, paymentReady: this.paymentReady(), actions: { canRent: false, canContinuePayment: false, canCancelPayment: false, ...this.refundActions(null, false), canConfigure: false, canCreate: canManage }, serverTime: iso(this.now()) };
    const config = await this.services.db.one('SELECT * FROM ar_rental_config WHERE device_id = ?' + (merchant ? ' AND merchant_id = ?' : ''), [device.id, ...(merchant ? [merchant.id] : [])]);
    const venue = await venueForDevice(this.services.db, device);
    const price = quoteForDevice(config, venue);
    const slot = await this.services.db.one('SELECT * FROM ar_rental_slot WHERE device_id = ?', [device.id]);
    const current = slot ? await this.services.db.one('SELECT * FROM ar_rental_order WHERE id = ?', [slot.rental_id]) : null;
    if (merchant && slot && (Number(slot.merchant_id) !== merchant.id || Number(current?.merchant_id) !== merchant.id)) throw new ApiError(503, '设备租赁状态暂时无法确认');
    if (slot && !current) throw new ApiError(503, '设备租赁状态暂时无法确认');
    const relation = current ? this.mine(current, principal) ? 'mine' : 'other' : 'none';
    const state = slot ? slot.state : price.enabled ? 'AVAILABLE' : 'DISABLED';
    const visible = current && (relation === 'mine' || canManage) ? this.view(current, principal) : null;
    return { ...owner, device: this.displayDevice({ ...device, venue_name: venue.name }), venue: publicVenue(venue), state, relation, pricing: price, rental: visible, paymentReady: this.paymentReady(), actions: {
      canRent: !slot && price.enabled && price.totalCents > 0 && this.paymentReady(),
      canContinuePayment: current?.status === 'PENDING_PAYMENT' && relation === 'mine' && Number(current.expires_ms) > this.now(),
      canCancelPayment: current?.status === 'PENDING_PAYMENT' && relation === 'mine',
      ...this.refundActions(current, canManage), canConfigure: canManage, canCreate: false,
    }, serverTime: iso(this.now()) };
  }
  async get(principal: RentalPrincipal, orderId: unknown): Promise<Row> {
    return this.withOrderMerchant(principal, orderId, () => this.getInMerchant(principal, orderId));
  }
  private async getInMerchant(principal: RentalPrincipal, orderId: unknown): Promise<Row> {
    this.assertPrincipal(principal);
    const row = await this.readOrder(orderId, principal);
    return { rental: this.view(row, principal), actions: this.refundActions(row, await this.currentManager(principal)) };
  }
  async list(principal: RentalPrincipal, query: Row): Promise<Row> {
    this.assertPrincipal(principal);
    const { page, pageSize } = pagination(query);
    const merchant = currentMerchant(), shared = this.sharedApplication();
    const scope = merchant && !shared ? ' AND merchant_id = ?' : '', values = [principal.user.id, principal.appid, ...(merchant && !shared ? [merchant.id] : [])];
    const count = await this.services.db.one('SELECT COUNT(*) AS total FROM ar_rental_order WHERE user_id = ? AND appid = ?' + scope, values);
    const rows = await this.services.db.query(shared
      ? `SELECT o.*,m.name AS merchant_name FROM ar_rental_order o LEFT JOIN ar_merchant m ON m.id=o.merchant_id WHERE o.user_id = ? AND o.appid = ? ORDER BY o.id DESC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`
      : `SELECT * FROM ar_rental_order WHERE user_id = ? AND appid = ?${scope} ORDER BY id DESC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`, values);
    return { items: rows.map(row => this.view(row, principal)), page, pageSize: Math.floor(pageSize), total: Number(count?.total || 0) };
  }
  async create(principal: RentalPrincipal, input: Row): Promise<Row> {
    return this.withDeviceMerchant(principal, 'id', input.deviceId, false, () => this.createInMerchant(principal, input));
  }
  private async createInMerchant(principal: RentalPrincipal, input: Row): Promise<Row> {
    this.assertPrincipal(principal); this.assertReady();
    const merchant = currentMerchant();
    const deviceId = id(input.deviceId), key = requestKey(input.idempotencyKey);
    const version = Number(input.priceVersion);
    const venueVersion = Number(input.venuePriceVersion);
    if (!Number.isSafeInteger(version) || version < 1 || !Number.isSafeInteger(venueVersion) || venueVersion < 1) throw new ApiError(422, '设备或场地费用版本无效，请刷新后确认');
    const row = await this.services.db.transaction(async db => {
      const device = await db.one('SELECT * FROM ar_device WHERE id = ? FOR UPDATE', [deviceId]);
      if (!device) throw new ApiError(404, '设备不存在');
      if (merchant && Number(device.merchant_id) !== merchant.id) throw new ApiError(409, '设备属于其他商户，请使用对应小程序', 'MERCHANT_MISMATCH');
      await this.assertCurrentPayer(principal, db);
      const previous = await db.one('SELECT * FROM ar_rental_order WHERE user_id = ? AND appid = ? AND idempotency_key = ?', [principal.user.id, principal.appid, key]);
      if (previous) {
        if (Number(previous.device_id) !== deviceId || merchant && Number(previous.merchant_id) !== merchant.id) throw new ApiError(409, '请求标识已用于其他设备或商户');
        return previous;
      }
      const slot = await db.one('SELECT * FROM ar_rental_slot WHERE device_id = ?', [deviceId]);
      if (slot) {
        if (merchant && Number(slot.merchant_id) !== merchant.id) throw new ApiError(503, '设备租赁状态暂时无法确认');
        const occupying = await db.one('SELECT * FROM ar_rental_order WHERE id = ?', [slot.rental_id]);
        if (occupying && this.mine(occupying, principal) && ['PENDING_PAYMENT', 'ACTIVE'].includes(occupying.status)) return occupying;
        throw new ApiError(409, '设备已被占用，请刷新设备状态');
      }
      const config = await db.one('SELECT * FROM ar_rental_config WHERE device_id = ?', [deviceId]);
      if (merchant && config && Number(config.merchant_id) !== merchant.id) throw new ApiError(503, '设备租赁配置暂时不可用');
      const venue = await venueForDevice(db, device, true);
      const pricing = quoteForDevice(config, venue);
      if (!pricing.enabled) throw new ApiError(409, '该设备尚未开放租赁');
      if (version !== pricing.version || venueVersion !== pricing.venuePriceVersion) throw new ApiError(409, '设备或场地费用已变更，请刷新后确认');
      cents(pricing.useFeeCents); cents(pricing.depositCents);
      if (pricing.totalCents <= 0 || pricing.totalCents > 2147483647) throw new ApiError(422, '场地租赁费用配置无效');
      const now = this.now();
      const info = this.displayDevice(device);
      const order = await db.insert('ar_rental_order', {
        device_id: deviceId, device_uuid: device.uuid, device_name: info.name, user_id: Number(principal.user.id), appid: principal.appid,
        venue_id: Number(venue.id), venue_name: venue.name, venue_price_version: Number(venue.version),
        payer_openid: principal.openid, mch_id: (merchant?.client ?? this.options.payment).config.mchId, use_fee_cents: pricing.useFeeCents, deposit_cents: pricing.depositCents,
        ...(merchant ? { merchant_id: merchant.id, payment_config_id: merchant.configId } : {}),
        total_cents: pricing.totalCents, price_version: version, status: 'PENDING_PAYMENT', payment_status: 'NOTPAY', out_trade_no: rentalOrderNumber(),
        idempotency_key: key, expires_ms: now + 300000, created_ms: now, updated_ms: now,
      });
      await db.insert('ar_rental_slot', { device_id: deviceId, rental_id: order.id, state: 'RESERVED', expires_ms: order.expires_ms, ...(merchant ? { merchant_id: merchant.id } : {}) });
      await this.event(db, order.id, principal.user.id, 'RESERVED', { venueId: Number(venue.id), venuePriceVersion: Number(venue.version), useFeeCents: pricing.useFeeCents, depositCents: pricing.depositCents });
      await this.enqueue(db, order.id, 'PAYMENT_SYNC', now + 30000);
      return order;
    });
    return { rental: this.view(row, principal) };
  }
  async payment(principal: RentalPrincipal, orderId: unknown): Promise<Row> {
    return this.withOrderMerchant(principal, orderId, () => this.paymentInMerchant(principal, orderId));
  }
  private async paymentInMerchant(principal: RentalPrincipal, orderId: unknown): Promise<Row> {
    this.assertPrincipal(principal); this.assertReady();
    const row = await this.readOrder(orderId, principal);
    const payment = await this.orderPayment(row);
    if (!payment.isPaymentReady()) throw new ApiError(503, '原订单支付暂未开放');
    if (!this.mine(row, principal) || row.payer_openid !== principal.openid) throw new ApiError(403, '只能支付本人的租赁订单');
    if (row.status !== 'PENDING_PAYMENT' || Number(row.expires_ms) <= this.now()) throw new ApiError(409, '订单已失效或不需要支付，请刷新状态');
    const slot = await this.services.db.one('SELECT * FROM ar_rental_slot WHERE device_id = ?', [row.device_id]);
    if (Number(slot?.rental_id) !== Number(row.id)) throw new ApiError(409, '设备占用已失效');
    let parameters = row.pay_params;
    if (typeof parameters === 'string') { try { parameters = JSON.parse(parameters); } catch { parameters = null; } }
    if (!parameters) {
      // Persist before the network call: a timeout is not proof that no order exists.
      const ready = await this.lockOrder(row.id, async (db, current) => {
        await this.assertCurrentPayer(principal, db);
        if (current.status !== 'PENDING_PAYMENT') throw new ApiError(409, '订单状态已变化');
        if (Number(current.prepay_pending_until_ms || 0) > this.now()) throw new ApiError(409, '微信支付正在初始化，请稍后重新查询');
        // Production provider fetch is bounded at 15 seconds. The durable fence
        // survives process death and prevents cancel from racing order creation.
        await db.execute('UPDATE ar_rental_order SET prepay_attempted = 1, prepay_pending_until_ms = ?, updated_ms = ? WHERE id = ?', [this.now() + 30000, this.now(), row.id]);
        return current;
      });
      parameters = await payment.order({ out_trade_no: ready.out_trade_no, openid: ready.payer_openid, amount: Number(ready.total_cents), description: 'AR设备租赁', attach: JSON.stringify({ business: 'ar_rental', rental_id: Number(row.id) }), time_expire: new Date(Number(row.expires_ms)).toISOString() }, this.notificationUrl('payment', ready));
      if (parameters.appId !== principal.appid) throw new ApiError(503, '租赁支付应用配置不一致');
      await this.lockOrder(row.id, async (db, current) => {
        if (current.status !== 'PENDING_PAYMENT') throw new ApiError(409, '订单状态已变化，请查询支付结果');
        await db.execute('UPDATE ar_rental_order SET pay_params = ?, prepay_pending_until_ms = NULL, updated_ms = ? WHERE id = ?', [JSON.stringify(parameters), this.now(), row.id]);
        return current;
      });
    }
    return { rental: this.view(await this.readOrder(row.id), principal), payParams: parameters };
  }
  private async providerOrder(row: Row): Promise<Row> {
    const client = await this.orderPayment(row);
    try { return await client.payment('GET', `/v3/pay/transactions/out-trade-no/${encodeURIComponent(row.out_trade_no)}?mchid=${encodeURIComponent(row.mch_id)}`); }
    catch (error: any) {
      // Only the integration's verified provider classification can establish this.
      if (error?.providerCode === 'ORDER_NOT_EXIST') return { out_trade_no: row.out_trade_no, trade_state: 'ORDER_NOT_EXIST' };
      throw error;
    }
  }
  private verifyPaid(row: Row, payment: Row): void {
    if (payment.out_trade_no !== row.out_trade_no || payment.appid !== row.appid || payment.mchid !== row.mch_id || payment.payer?.openid !== row.payer_openid
      || !Number.isSafeInteger(payment.amount?.total) || payment.amount.total !== Number(row.total_cents) || payment.amount.currency !== 'CNY' || typeof payment.transaction_id !== 'string' || !payment.transaction_id) {
      throw new ApiError(403, '租赁支付收款方、金额或付款账号核验失败');
    }
  }
  private async applyPayment(orderId: number, payment: Row): Promise<Row> {
    return this.lockOrder(orderId, async (db, row, device) => {
      if (payment.out_trade_no !== row.out_trade_no) throw new ApiError(403, '支付订单编号不一致');
      if (payment.trade_state === 'SUCCESS') {
        this.verifyPaid(row, payment);
        if (['ACTIVE', 'ENDED', 'COMPENSATING'].includes(row.status)) return row;
        const slot = await db.one('SELECT * FROM ar_rental_slot WHERE device_id = ?', [row.device_id]);
        const paid = Number.isFinite(Date.parse(payment.success_time)) ? Date.parse(payment.success_time) : this.now();
        const sameMerchant = row.merchant_id === undefined || Number(device.merchant_id) === Number(row.merchant_id);
        if (row.status === 'PENDING_PAYMENT' && Number(slot?.rental_id) === Number(row.id) && sameMerchant) {
          await db.execute("UPDATE ar_rental_order SET status='ACTIVE',payment_status='SUCCESS',transaction_id=?,paid_ms=?,started_ms=?,updated_ms=? WHERE id=?", [payment.transaction_id, paid, this.now(), this.now(), row.id]);
          await db.execute("UPDATE ar_rental_slot SET state='RENTED',expires_ms=NULL WHERE device_id=? AND rental_id=?", [row.device_id, row.id]);
          await this.event(db, row.id, null, 'PAYMENT_CONFIRMED', {});
        } else {
          await db.execute("UPDATE ar_rental_order SET status='COMPENSATING',payment_status='SUCCESS',transaction_id=?,paid_ms=?,ended_ms=?,refund_mode='full',refund_amount_cents=total_cents,refund_status='PENDING',out_refund_no=?,updated_ms=? WHERE id=?", [payment.transaction_id, paid, this.now(), rentalRefundNumber(), this.now(), row.id]);
          await this.enqueue(db, row.id, 'REFUND_APPLY', this.now());
          await this.event(db, row.id, null, 'LATE_PAYMENT_REFUND', {});
        }
      } else if (['CLOSED', 'REVOKED', 'PAYERROR', 'ORDER_NOT_EXIST'].includes(payment.trade_state)) {
        if (row.status === 'PENDING_PAYMENT') {
          // A correctly signed "not found" can still race a prepay request
          // that has not reached WeChat yet. Only after the provider payment
          // expiry plus transport grace can absence terminate an attempted order.
          if (payment.trade_state === 'ORDER_NOT_EXIST' && Number(row.prepay_attempted)
            && (this.now() <= Number(row.expires_ms) + 30000 || Number(row.prepay_pending_until_ms || 0) > this.now())) return row;
          await db.execute("UPDATE ar_rental_order SET status='CANCELLED',payment_status='CLOSED',updated_ms=? WHERE id=?", [this.now(), row.id]);
          await db.execute('DELETE FROM ar_rental_slot WHERE device_id=? AND rental_id=?', [row.device_id, row.id]);
          await this.event(db, row.id, null, 'PAYMENT_CLOSED', {});
        }
      } else if (['NOTPAY', 'USERPAYING'].includes(payment.trade_state)) {
        if (row.status === 'PENDING_PAYMENT') await db.execute('UPDATE ar_rental_order SET payment_status=?,updated_ms=? WHERE id=?', [payment.trade_state, this.now(), row.id]);
      } else if (payment.trade_state !== 'REFUND') throw new ApiError(502, '微信支付状态暂时无法确认');
      return (await db.one('SELECT * FROM ar_rental_order WHERE id=?', [row.id]))!;
    });
  }
  async syncPayment(principal: RentalPrincipal, orderId: unknown): Promise<Row> {
    return this.withOrderMerchant(principal, orderId, () => this.syncPaymentInMerchant(principal, orderId));
  }
  private async syncPaymentInMerchant(principal: RentalPrincipal, orderId: unknown): Promise<Row> {
    this.assertPrincipal(principal);
    const row = await this.readOrder(orderId, principal);
    const updated = await this.syncPaymentInternal(row);
    return { rental: this.view(updated, principal) };
  }
  private async syncPaymentInternal(row: Row): Promise<Row> {
    if (!Number(row.prepay_attempted) && row.status === 'PENDING_PAYMENT') return row;
    return this.applyPayment(Number(row.id), await this.providerOrder(row));
  }
  async cancel(principal: RentalPrincipal, orderId: unknown): Promise<Row> {
    return this.withOrderMerchant(principal, orderId, () => this.cancelInMerchant(principal, orderId));
  }
  private async cancelInMerchant(principal: RentalPrincipal, orderId: unknown): Promise<Row> {
    this.assertPrincipal(principal);
    const row = await this.readOrder(orderId, principal);
    if (!this.mine(row, principal)) throw new ApiError(403, '只能取消本人的待支付订单');
    return { rental: this.view(await this.cancelInternal(row), principal) };
  }
  private async cancelInternal(initial: Row): Promise<Row> {
    if (initial.status !== 'PENDING_PAYMENT') return initial;
    if (!Number(initial.prepay_attempted)) {
      return this.lockOrder(initial.id, async (db, row) => {
        if (row.status !== 'PENDING_PAYMENT' || Number(row.prepay_attempted)) return row;
        await db.execute("UPDATE ar_rental_order SET status='CANCELLED',payment_status='CLOSED',updated_ms=? WHERE id=?", [this.now(), row.id]);
        await db.execute('DELETE FROM ar_rental_slot WHERE device_id=? AND rental_id=?', [row.device_id, row.id]);
        await this.event(db, row.id, row.user_id, 'LOCAL_ORDER_CANCELLED', {});
        return (await db.one('SELECT * FROM ar_rental_order WHERE id=?', [row.id]))!;
      });
    }
    if (Number(initial.prepay_pending_until_ms || 0) > this.now()) return initial;
    const payment = await this.providerOrder(initial);
    if (payment.trade_state === 'NOTPAY') {
      await (await this.orderPayment(initial)).payment('POST', `/v3/pay/transactions/out-trade-no/${encodeURIComponent(initial.out_trade_no)}/close`, { mchid: initial.mch_id });
      return this.applyPayment(Number(initial.id), await this.providerOrder(initial));
    }
    return this.applyPayment(Number(initial.id), payment);
  }
  async end(principal: RentalPrincipal, orderId: unknown, input: Row): Promise<Row> {
    return this.withOrderMerchant(principal, orderId, () => this.endInMerchant(principal, orderId, input));
  }
  private async endInMerchant(principal: RentalPrincipal, orderId: unknown, input: Row): Promise<Row> {
    this.assertPrincipal(principal); requireManager(principal.user);
    const mode = input.refundMode;
    if (mode !== 'deposit' && mode !== 'full') throw new ApiError(422, '请选择退押金或全额退款');
    if (typeof input.reason !== 'string' || !input.reason.trim() || [...input.reason.trim()].length > 255) throw new ApiError(422, '请填写不超过255字的归还原因');
    const key = requestKey(input.idempotencyKey);
    const existing = await this.readOrder(orderId, principal);
    const row = await this.lockOrder(existing.id, async (db, current) => {
      // Serialize the authorization decision with role revocation. Payer
      // ownership never grants permission to choose or initiate a refund.
      await this.requireCurrentManager(principal, db, true);
      if (current.status === 'ENDED') {
        if (current.refund_mode !== mode) throw new ApiError(409, '该租赁已选择其他退款方式，请刷新结果');
        return current;
      }
      const reused = await db.one('SELECT id FROM ar_rental_order WHERE ended_by=? AND end_key=? AND id<>? LIMIT 1', [principal.user.id, key, current.id]);
      if (reused) throw new ApiError(409, '归还请求标识已用于其他订单，请重新确认');
      if (current.status !== 'ACTIVE' || current.payment_status !== 'SUCCESS') throw new ApiError(409, '该订单不处于可结束的租赁状态');
      const amount = mode === 'deposit' ? Number(current.deposit_cents) : Number(current.total_cents);
      const refundStatus = amount === 0 ? 'SUCCESS' : 'PENDING';
      await db.execute("UPDATE ar_rental_order SET status='ENDED',ended_ms=?,ended_by=?,end_reason=?,end_key=?,refund_mode=?,refund_amount_cents=?,refund_status=?,out_refund_no=?,settled_ms=?,updated_ms=? WHERE id=?", [this.now(), principal.user.id, input.reason.trim(), key, mode, amount, refundStatus, amount ? rentalRefundNumber() : null, amount ? null : this.now(), this.now(), current.id]);
      if (amount) {
        await db.execute("UPDATE ar_rental_slot SET state='SETTLING',expires_ms=NULL WHERE device_id=? AND rental_id=?", [current.device_id, current.id]);
        await this.enqueue(db, current.id, 'REFUND_APPLY', this.now());
      } else await db.execute('DELETE FROM ar_rental_slot WHERE device_id=? AND rental_id=?', [current.device_id, current.id]);
      await this.event(db, current.id, principal.user.id, 'RENTAL_ENDED', { refundMode: mode, refundAmountCents: amount, reason: input.reason.trim() });
      return (await db.one('SELECT * FROM ar_rental_order WHERE id=?', [current.id]))!;
    }).catch((error: unknown) => {
      // The database rolls back before this translation. Concurrent or legacy
      // callers therefore receive a conflict without creating a second refund.
      if (typeof error === 'object' && error && 'code' in error && error.code === 'ER_DUP_ENTRY') throw new ApiError(409, '归还请求标识已用于其他订单，请重新确认');
      throw error;
    });
    // The durable job remains available after a timeout or process crash.
    if (row.refund_status === 'PENDING') {
      try { return { rental: this.view(await this.applyRefundInternal(row), principal) }; }
      catch { /* Persisted pending settlement is presented honestly and retried by the worker. */ }
    }
    return { rental: this.view(await this.readOrder(row.id), principal) };
  }
  private async applyRefundInternal(row: Row): Promise<Row> {
    if (row.refund_status === 'SUCCESS' || !Number(row.refund_amount_cents)) return row;
    if (!row.out_refund_no || !['ENDED', 'COMPENSATING'].includes(row.status)) throw new ApiError(409, '退款结算状态无效');
    if (row.refund_status === 'ABNORMAL' || row.refund_status === 'CLOSED') return row;
    const client = await this.orderPayment(row);
    const notifyUrl = client.config.refundNotifyUrl || this.notificationUrl('refund', row);
    if (!notifyUrl.startsWith('https://')) throw new ApiError(503, '退款回调地址未配置');
    const result = await client.payment('POST', '/v3/refund/domestic/refunds', {
      out_trade_no: row.out_trade_no, out_refund_no: row.out_refund_no,
      reason: row.status === 'COMPENSATING' ? '设备占用失效，租赁未成立' : row.end_reason,
      notify_url: notifyUrl, amount: { refund: Number(row.refund_amount_cents), total: Number(row.total_cents), currency: 'CNY' },
    });
    const updated = await this.applyRefundResult(Number(row.id), result);
    if (updated.refund_status === 'PROCESSING') await this.enqueue(this.services.db, row.id, 'REFUND_SYNC', this.now() + 30000);
    return updated;
  }
  private async applyRefundResult(orderId: number, refund: Row): Promise<Row> {
    return this.lockOrder(orderId, async (db, row) => {
      if (refund.out_refund_no !== row.out_refund_no || refund.out_trade_no && refund.out_trade_no !== row.out_trade_no
        || !Number.isSafeInteger(refund.amount?.refund) || refund.amount.refund !== Number(row.refund_amount_cents)
        || !Number.isSafeInteger(refund.amount?.total) || refund.amount.total !== Number(row.total_cents)
        || refund.amount.currency && refund.amount.currency !== 'CNY') throw new ApiError(403, '退款订单或金额核验失败');
      const status = refundStatusAfterObservation(row.refund_status, refund.status ?? refund.refund_status);
      if (row.refund_status === 'SUCCESS' || row.refund_status === status && ['ABNORMAL', 'CLOSED'].includes(status)) return row;
      if (!['ENDED', 'COMPENSATING'].includes(row.status)) throw new ApiError(409, '租赁尚未进入退款结算');
      await db.execute('UPDATE ar_rental_order SET refund_status=?,refund_id=?,settled_ms=?,updated_ms=? WHERE id=?', [status, refund.refund_id || row.refund_id || null, status === 'SUCCESS' ? this.now() : null, this.now(), row.id]);
      if (status === 'SUCCESS') {
        await db.execute('DELETE FROM ar_rental_slot WHERE device_id=? AND rental_id=?', [row.device_id, row.id]);
        await this.event(db, row.id, null, 'REFUND_SUCCESS', { refundAmountCents: Number(row.refund_amount_cents) });
      } else if (status === 'ABNORMAL' || status === 'CLOSED') await this.event(db, row.id, null, 'REFUND_EXCEPTION', { status });
      return (await db.one('SELECT * FROM ar_rental_order WHERE id=?', [row.id]))!;
    });
  }
  async syncRefund(principal: RentalPrincipal, orderId: unknown): Promise<Row> {
    return this.withOrderMerchant(principal, orderId, () => this.syncRefundInMerchant(principal, orderId));
  }
  private async syncRefundInMerchant(principal: RentalPrincipal, orderId: unknown): Promise<Row> {
    this.assertPrincipal(principal);
    // A missing provider refund can be re-applied by this operation, so it is
    // administrative. Customers read the persisted result through GET instead.
    await this.requireCurrentManager(principal);
    const row = await this.readOrder(orderId, principal);
    return { rental: this.view(await this.syncRefundInternal(row), principal) };
  }
  private async syncRefundInternal(row: Row): Promise<Row> {
    if (!row.out_refund_no || row.refund_status === 'SUCCESS') return row;
    let result: Row;
    try { result = await (await this.orderPayment(row)).payment('GET', `/v3/refund/domestic/refunds/${encodeURIComponent(row.out_refund_no)}`); }
    catch (error: any) {
      if (error?.providerCode === 'RESOURCE_NOT_EXISTS' || error?.providerCode === 'REFUND_NOT_EXIST') return this.applyRefundInternal(row);
      throw error;
    }
    return this.applyRefundResult(Number(row.id), result);
  }
  async retryRefund(principal: RentalPrincipal, orderId: unknown): Promise<Row> {
    return this.withOrderMerchant(principal, orderId, () => this.retryRefundInMerchant(principal, orderId));
  }
  private async retryRefundInMerchant(principal: RentalPrincipal, orderId: unknown): Promise<Row> {
    this.assertPrincipal(principal); await this.requireCurrentManager(principal);
    const row = await this.readOrder(orderId, principal);
    if (row.refund_status === 'ABNORMAL' || row.refund_status === 'CLOSED') throw new ApiError(409, '退款已进入异常或关闭状态，请在微信商户平台处理并同步结果');
    return { rental: this.view(await this.syncRefundInternal(row), principal) };
  }
  async createDevice(principal: RentalPrincipal, input: Row): Promise<Row> {
    this.assertPrincipal(principal); requireManager(principal.user);
    if (this.options.resolveMerchant) {
      const merchant = currentMerchant();
      if (!merchant || !Number.isSafeInteger(merchant.id) || merchant.id < 1) throw new ApiError(503, '请先选择有效的设备所属商户');
      const registered = await this.options.resolveMerchant(merchant.id);
      if (registered.id !== merchant.id || registered.appId !== merchant.appId) throw new ApiError(503, '设备所属商户配置无效');
    }
    await this.requireCurrentManager(principal);
    return new DeviceService(this.services).create({ ...principal.user, appid: principal.appid, ...(currentMerchant() ? { auth_version: principal.authVersion ?? principal.user.auth_version } : {}) }, input);
  }
  async configure(principal: RentalPrincipal, deviceId: unknown, input: Row): Promise<Row> {
    return this.withDeviceMerchant(principal, 'id', deviceId, true, () => this.configureInMerchant(principal, deviceId, input));
  }
  private async configureInMerchant(principal: RentalPrincipal, deviceId: unknown, input: Row): Promise<Row> {
    this.assertPrincipal(principal); requireManager(principal.user);
    const merchant = currentMerchant();
    if (typeof input.enabled !== 'boolean') throw new ApiError(422, '请选择是否开放租赁');
    if (['useFeeCents', 'depositCents', 'totalCents', 'use_fee_cents', 'deposit_cents', 'total_cents'].some(key => Object.prototype.hasOwnProperty.call(input, key))) throw new ApiError(422, '租赁费用请在场地设置中调整');
    const version = Number(input.version);
    if (!Number.isSafeInteger(version) || version < 0) throw new ApiError(422, '配置版本无效，请刷新设备');
    const device = await this.services.db.transaction(async db => {
      const current = await db.one('SELECT * FROM ar_device WHERE id = ?' + (merchant ? ' AND merchant_id = ?' : '') + ' FOR UPDATE', [id(deviceId), ...(merchant ? [merchant.id] : [])]);
      if (!current) throw new ApiError(404, '设备不存在');
      await this.requireCurrentManager(principal, db, true);
      const config = await db.one('SELECT * FROM ar_rental_config WHERE device_id = ?', [current.id]);
      if (merchant && config && Number(config.merchant_id) !== merchant.id) throw new ApiError(503, '设备租赁配置暂时不可用');
      if (Number(config?.version || 0) !== version) throw new ApiError(409, '设备配置已被其他管理员修改，请刷新');
      const venueId = input.venueId === undefined ? Number(current.venue_id) : id(input.venueId);
      const changed = venueId !== Number(current.venue_id);
      if (changed) {
        const slot = await db.one('SELECT device_id FROM ar_rental_slot WHERE device_id=?', [current.id]);
        const unresolved = await db.one("SELECT id FROM ar_rental_order WHERE device_id=? AND (status IN ('PENDING_PAYMENT','ACTIVE') OR ((status='COMPENSATING' OR refund_amount_cents>0) AND (refund_status IS NULL OR refund_status<>'SUCCESS'))) LIMIT 1", [current.id]);
        if (slot || unresolved) throw new ApiError(409, '设备仍有租赁、待支付或未完成退款，暂不能调整场地');
      }
      const venue = input.venueId === undefined ? await venueForDevice(db, current, true)
        : await db.one('SELECT * FROM ar_venue WHERE id=? AND merchant_id=? FOR UPDATE', [venueId, current.merchant_id]);
      if (!venue) throw new ApiError(422, '请选择本商户已启用的场地');
      if ((changed || input.enabled) && venue.status !== 'active') throw new ApiError(409, '场地已停用，请选择本商户已启用的场地');
      if (input.enabled && !changed) {
        const total = cents(Number(venue.use_fee_cents)) + cents(Number(venue.deposit_cents));
        if (total <= 0 || total > 2147483647) throw new ApiError(422, '场地租赁费用必须大于零且在有效范围内');
      }
      const enabled = changed ? 0 : Number(input.enabled);
      if (changed) await db.execute('UPDATE ar_device SET venue_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=?', [venueId, current.id]);
      if (config) await db.execute('UPDATE ar_rental_config SET enabled=?,version=version+1,updated_ms=?,updated_by=? WHERE device_id=?', [enabled, this.now(), principal.user.id, current.id]);
      else await db.insert('ar_rental_config', { device_id: current.id, enabled, version: 1, updated_ms: this.now(), updated_by: principal.user.id, ...(merchant ? { merchant_id: merchant.id } : {}) });
      return current;
    });
    return this.context(principal, device.uuid);
  }
  async devices(principal: RentalPrincipal, query: Row): Promise<Row> {
    this.assertPrincipal(principal); await this.requireCurrentManager(principal);
    const { page, pageSize } = pagination(query);
    const search = typeof query.search === 'string' ? query.search.trim().slice(0, 100) : '';
    const merchant = currentMerchant();
    const result = await readDevicePage(this.services.db, { merchantId: merchant?.id, search, page, pageSize });
    return { items: result.items.map(item => ({ device: this.displayDevice(item.device), venue: publicVenue(item.venue), pricing: item.pricing, state: item.state })), page, pageSize, total: result.total };
  }
  async paymentNotification(ctx: Context): Promise<Row> {
    const { notice, client, configId } = await this.notification(ctx);
    if (notice.event_type !== 'TRANSACTION.SUCCESS') return { code: 'SUCCESS', message: '成功' };
    const number = notice.resource?.out_trade_no;
    const row = typeof number === 'string' ? await this.services.db.one('SELECT * FROM ar_rental_order WHERE out_trade_no = ?', [number]) : null;
    this.assertNotificationOrder(row, client, configId);
    await this.applyPayment(Number(row.id), await this.providerOrder(row));
    return { code: 'SUCCESS', message: '成功' };
  }
  async refundNotification(ctx: Context): Promise<Row> {
    const { notice, client, configId } = await this.notification(ctx);
    if (!['REFUND.SUCCESS', 'REFUND.ABNORMAL', 'REFUND.CLOSED'].includes(notice.event_type)) return { code: 'SUCCESS', message: '成功' };
    const number = notice.resource?.out_refund_no;
    const row = typeof number === 'string' ? await this.services.db.one('SELECT * FROM ar_rental_order WHERE out_refund_no = ?', [number]) : null;
    this.assertNotificationOrder(row, client, configId);
    await this.syncRefundInternal(row);
    return { code: 'SUCCESS', message: '成功' };
  }
  private notificationUrl(kind: 'payment' | 'refund', order: Row): string {
    const configId = Number(order.payment_config_id);
    return this.callbackBase + '/' + kind + '-notify' + (Number.isSafeInteger(configId) && configId > 0 ? '/' + configId : '');
  }
  private async notification(ctx: Context): Promise<{ notice: Row; client: WeChatClient; configId: number }> {
    const configId = ctx.params?.configId === undefined ? 1 : id(ctx.params.configId);
    if (!this.options.resolvePaymentConfig && configId !== 1) throw new ApiError(503, '支付通知配置不可用');
    const client = this.options.resolvePaymentConfig ? await this.options.resolvePaymentConfig(configId) : this.options.payment;
    const notice = await client.notification(ctx.req.rawBody ?? '', ctx.req.headers);
    return { notice, client, configId };
  }
  private assertNotificationOrder(row: Row | null, client: WeChatClient, configId: number): asserts row is Row {
    if (!row) throw new ApiError(404, '租赁支付或退款订单不存在');
    if (row.appid !== client.config.appId || row.mch_id !== client.config.mchId
      || this.options.resolvePaymentConfig && Number(row.payment_config_id) !== configId) throw new ApiError(403, '支付通知与原订单商户配置不一致');
  }
  private async lockOrder<T>(orderId: number, operation: (db: Database, row: Row, device: Row) => Promise<T>): Promise<T> {
    const initial = await this.readOrder(orderId);
    return this.services.db.transaction(async db => {
      // Every operation locks device before order, including callbacks and workers.
      const device = await db.one('SELECT * FROM ar_device WHERE id = ? FOR UPDATE', [initial.device_id]);
      if (!device) throw new ApiError(503, '设备租赁状态暂时无法确认');
      const current = await db.one('SELECT * FROM ar_rental_order WHERE id = ? FOR UPDATE', [orderId]);
      if (!current) throw new ApiError(404, '租赁订单不存在');
      return operation(db, current, device);
    });
  }
  private async event(db: Database, rentalId: number, actor: number | null, event: string, details: Row): Promise<void> {
    const owner = currentMerchant() || this.options.resolvePaymentForOrder ? await db.one('SELECT merchant_id FROM ar_rental_order WHERE id=?', [rentalId]) : null;
    await db.insert('ar_rental_event', { rental_id: rentalId, actor_user_id: actor, event, details, created_ms: this.now(), ...(owner ? { merchant_id: owner.merchant_id } : {}) });
  }
  private async enqueue(db: Database, rentalId: number, kind: string, available: number): Promise<void> {
    const owner = currentMerchant() || this.options.resolvePaymentForOrder ? await db.one('SELECT merchant_id FROM ar_rental_order WHERE id=?', [rentalId]) : null;
    const columns = owner ? 'rental_id,kind,available_ms,merchant_id' : 'rental_id,kind,available_ms';
    await db.execute(`INSERT INTO ar_rental_job (${columns}) VALUES (${owner ? '?,?,?,?' : '?,?,?'}) ON DUPLICATE KEY UPDATE available_ms=LEAST(available_ms,VALUES(available_ms)),finished=0`, [rentalId, kind, available, ...(owner ? [owner.merchant_id] : [])]);
  }
  async processJobs(limit = 10): Promise<void> {
    const token = randomBytes(12).toString('hex');
    const due = await this.services.db.query(`SELECT * FROM ar_rental_job WHERE finished=0 AND available_ms<=? AND (locked_until_ms IS NULL OR locked_until_ms<?) ORDER BY id LIMIT ${Math.max(1, Math.min(50, Math.floor(limit)))}`, [this.now(), this.now()]);
    for (const job of due) {
      const lock = await this.services.db.execute('UPDATE ar_rental_job SET locked_by=?,locked_until_ms=?,attempts=attempts+1 WHERE id=? AND finished=0 AND (locked_until_ms IS NULL OR locked_until_ms<?)', [token, this.now() + 120000, job.id, this.now()]);
      if (lock.affectedRows !== 1) continue;
      let finished = false;
      let failure: string | null = null;
      try {
        let row = await this.readOrder(job.rental_id);
        if (job.merchant_id !== undefined && Number(job.merchant_id) !== Number(row.merchant_id)) throw new ApiError(503, '租赁任务归属不一致');
        if (job.kind === 'PAYMENT_SYNC') {
          if (row.status === 'PENDING_PAYMENT') row = Number(row.expires_ms) <= this.now() ? await this.cancelInternal(row) : await this.syncPaymentInternal(row);
          finished = row.status !== 'PENDING_PAYMENT';
        } else if (job.kind === 'REFUND_APPLY') {
          row = row.refund_status === 'PENDING' ? await this.applyRefundInternal(row) : row;
          finished = ['SUCCESS', 'PROCESSING', 'ABNORMAL', 'CLOSED'].includes(row.refund_status);
          if (row.refund_status === 'PROCESSING') await this.enqueue(this.services.db, row.id, 'REFUND_SYNC', this.now() + 30000);
        } else if (job.kind === 'REFUND_SYNC') {
          row = await this.syncRefundInternal(row);
          finished = ['SUCCESS', 'ABNORMAL', 'CLOSED'].includes(row.refund_status);
        } else finished = true;
      } catch (cause) { failure = cause instanceof ApiError ? cause.message.slice(0, 255) : '服务暂时不可用，等待重试'; }
      const delay = Math.min(1800000, 30000 * 2 ** Math.min(6, Number(job.attempts || 0)));
      await this.services.db.execute('UPDATE ar_rental_job SET finished=?,available_ms=?,locked_by=NULL,locked_until_ms=NULL,last_error=? WHERE id=? AND locked_by=?', [Number(finished), this.now() + delay, failure, job.id, token]);
    }
  }
}
