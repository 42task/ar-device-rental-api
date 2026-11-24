import type { RentalAuth } from '../auth';
import { requireMerchantManagementScope } from '../auth/identity';
import type { Context } from '../core/contracts';
import { ApiError } from '../core/errors';
import { requireUserAdmin } from '../core/roles';
import { currentMerchant, type MerchantRuntime } from '../merchants/context';

export async function requireRentalHistoryScope(ctx: Context, auth: RentalAuth, requireRole = requireUserAdmin): Promise<MerchantRuntime> {
  const { user } = await auth.authenticate(ctx);
  requireRole(user);
  requireMerchantManagementScope(user);
  const merchant = currentMerchant();
  if (!merchant) throw new ApiError(503, '缺少商户管理范围');
  if (user.role === 'root' && typeof ctx.req.headers['x-merchant-id'] !== 'string') {
    throw new ApiError(422, '请先选择所属商户');
  }
  return merchant;
}
