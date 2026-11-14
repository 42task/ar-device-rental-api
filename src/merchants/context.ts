import { AsyncLocalStorage } from 'node:async_hooks';
import type { WeChatClient } from '../payments/wechat';

export interface MerchantRuntime {
  id: number;
  code: string;
  name: string;
  status: 'active' | 'paused' | 'draft';
  origin: string;
  appId: string;
  client: WeChatClient;
  configId: number;
}
export interface MerchantRequestContext { entry: MerchantRuntime; merchant: MerchantRuntime }
const contexts = new AsyncLocalStorage<MerchantRequestContext>();
export const currentMerchant = (): MerchantRuntime | undefined => contexts.getStore()?.merchant;
export const entryMerchant = (): MerchantRuntime | undefined => contexts.getStore()?.entry;
export function withMerchant<T>(context: MerchantRequestContext, operation: () => T): T { return contexts.run(context, operation); }
export function runWithMerchant<T>(merchant: MerchantRuntime, operation: () => T): T { return withMerchant({ entry: merchant, merchant }, operation); }
export function publicMerchant(merchant: MerchantRuntime) {
  return { id: merchant.id, code: merchant.code, name: merchant.name, status: merchant.status, origin: merchant.origin, appId: merchant.appId, configId: merchant.configId };
}
