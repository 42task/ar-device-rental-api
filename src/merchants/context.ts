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
  miniappOwnerId?: number | null;
}
/** Login belongs to an application, independently of any merchant's payments. */
export interface ApplicationEntry {
  id: number;
  legacyMerchantId: number;
  name: string;
  appId: string;
  origin: string;
  status: 'active' | 'paused' | 'draft';
  client: WeChatClient;
}
export interface MerchantRequestContext { entry: ApplicationEntry; merchant: MerchantRuntime }
const contexts = new AsyncLocalStorage<MerchantRequestContext>();
export const currentMerchant = (): MerchantRuntime | undefined => contexts.getStore()?.merchant;
export const entryMerchant = (): ApplicationEntry | undefined => contexts.getStore()?.entry;
export function publicEntry(entry: ApplicationEntry) {
  return { id: entry.id, legacyMerchantId: entry.legacyMerchantId, name: entry.name, appId: entry.appId, origin: entry.origin, status: entry.status };
}
/** Explicit adapter for pre-application fixtures and migrations only. */
export function withMerchant<T>(context: { entry: ApplicationEntry | MerchantRuntime; merchant: MerchantRuntime }, operation: () => T): T {
  const entry: ApplicationEntry = 'legacyMerchantId' in context.entry ? context.entry : { ...context.entry, legacyMerchantId: context.entry.id };
  return contexts.run({ entry, merchant: context.merchant }, operation);
}
export function runWithMerchant<T>(merchant: MerchantRuntime, operation: () => T): T { return withMerchant({ entry: merchant, merchant }, operation); }
export function publicMerchant(merchant: MerchantRuntime) {
  return { id: merchant.id, code: merchant.code, name: merchant.name, status: merchant.status, origin: merchant.origin, appId: merchant.appId, configId: merchant.configId, miniappOwnerId: merchant.miniappOwnerId ?? null };
}
