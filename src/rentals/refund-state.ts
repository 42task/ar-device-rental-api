import { ApiError } from '../core/errors';

export type ProviderRefundStatus = 'PROCESSING' | 'SUCCESS' | 'ABNORMAL' | 'CLOSED';
/** Call only after authenticating the provider response and verifying the
 * original refund/order identifiers and amounts. A confirmed SUCCESS wins even
 * after an exceptional observation; an older PROCESSING must never erase it.
 */
export function refundStatusAfterObservation(current: unknown, observed: unknown): ProviderRefundStatus {
  if (!['PROCESSING', 'SUCCESS', 'ABNORMAL', 'CLOSED'].includes(observed as string)) throw new ApiError(502, '退款状态暂时无法确认');
  const incoming = observed as ProviderRefundStatus;
  if (current === 'SUCCESS' || incoming === 'SUCCESS') return 'SUCCESS';
  if (current === 'CLOSED') return 'CLOSED';
  if (current === 'ABNORMAL' && incoming === 'PROCESSING') return 'ABNORMAL';
  return incoming;
}
