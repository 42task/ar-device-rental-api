import type { Context, Row } from '../core/contracts';
import type { WeChatClient } from '../payments/wechat';

export interface RentalPrincipal { user: Row; appid: string; openid: string }
export interface RentalOptions {
  authenticate: (ctx: Context) => Promise<RentalPrincipal>;
  payment: WeChatClient;
  appId: string;
  now?: () => number;
  callbackBaseUrl?: string;
}
export type RentalState = 'AVAILABLE' | 'RESERVED' | 'RENTED' | 'SETTLING' | 'DISABLED' | 'UNREGISTERED';
