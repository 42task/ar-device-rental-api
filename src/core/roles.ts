import type { Row } from './contracts';
import { ApiError } from './errors';

export type UserRole = 'user' | 'manager' | 'root';
export function userRole(user: Row): UserRole {
  return user.role === 'root' || user.role === 'manager' ? user.role : 'user';
}
export function requireManager(user: Row): void {
  if (userRole(user) === 'user') throw new ApiError(403, '仅管理员可以执行此操作');
}
export function requireRoot(user: Row): void {
  if (userRole(user) !== 'root') throw new ApiError(403, '仅 root 可以执行此操作');
}
