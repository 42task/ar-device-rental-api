import type { Context, Row } from '../core/contracts';
import type { WeChatClient } from '../payments/wechat';
import type { MerchantRuntime } from '../merchants/context';

export interface RentalPrincipal { user: Row; appid: string; openid: string; merchantId?: number; authVersion?: number; identityId?: number }
export interface RentalOptions {
  authenticate: (ctx: Context) => Promise<RentalPrincipal>;
  payment: WeChatClient;
  appId: string;
  resolvePaymentForOrder?: (order: Row) => Promise<WeChatClient>;
  resolvePaymentConfig?: (configId: number) => Promise<WeChatClient>;
  resolveMerchant?: (merchantId: number) => Promise<MerchantRuntime>;
  now?: () => number;
  callbackBaseUrl?: string;
}
export type RentalState = 'AVAILABLE' | 'RESERVED' | 'RENTED' | 'SETTLING' | 'DISABLED' | 'UNREGISTERED';
