import { randomBytes } from 'node:crypto';

// Server-generated provider identifiers distinguish rental orders and refunds.
export const isRentalOrderNumber = (value: unknown): boolean => typeof value === 'string' && value.startsWith('ARL_');
export const isRentalRefundNumber = (value: unknown): boolean => typeof value === 'string' && value.startsWith('ARF_');
export const rentalOrderNumber = (): string => 'ARL_' + randomBytes(12).toString('hex');
export const rentalRefundNumber = (): string => 'ARF_' + randomBytes(12).toString('hex');
