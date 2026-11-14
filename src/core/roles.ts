import type { Row } from './contracts';
import { ApiError } from './errors';

export type UserRole = 'user' | 'manager' | 'adminer' | 'root';
export type AssignableRole = Exclude<UserRole, 'root'>;
export function userRole(user: Row): UserRole {
  return user.role === 'root' || user.role === 'adminer' || user.role === 'manager' ? user.role : 'user';
}
export function hasDeviceManagement(user: Row): boolean {
  return ['manager', 'adminer', 'root'].includes(userRole(user));
}
export function canManageUsers(user: Row): boolean {
  return ['adminer', 'root'].includes(userRole(user));
}
/** A role hierarchy grants business capabilities, never the actor's own role. */
export function assignableRoles(actor: Row, target: Row): AssignableRole[] {
  if (Number(actor.id) === Number(target.id) || userRole(target) === 'root') return [];
  if (userRole(actor) === 'root') return ['user', 'manager', 'adminer'];
  if (userRole(actor) === 'adminer' && ['user', 'manager'].includes(userRole(target))) return ['user', 'manager'];
  return [];
}
export function requireManager(user: Row): void {
  if (!hasDeviceManagement(user)) throw new ApiError(403, '仅设备管理员及以上身份可以执行此操作');
}
export function requireUserAdmin(user: Row): void {
  if (!canManageUsers(user)) throw new ApiError(403, '仅系统管理员或 root 可以管理用户');
}
export function requireRoot(user: Row): void {
  if (userRole(user) !== 'root') throw new ApiError(403, '仅 root 可以执行此操作');
}
