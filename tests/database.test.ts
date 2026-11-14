import { expect, it, vi } from 'vitest';
import { Database } from '../src/core/database';

it('starts a real transaction on a leased connection before using nested savepoints', async () => {
  const commands: string[] = [];
  const connection: any = { query: vi.fn(async (sql: string) => { commands.push(sql); return [[], []]; }),
    beginTransaction: vi.fn(async () => { commands.push('BEGIN'); }), commit: vi.fn(async () => { commands.push('COMMIT'); }),
    rollback: vi.fn(async () => { commands.push('ROLLBACK'); }), release: vi.fn() };
  const db = new Database({ getConnection: async () => connection } as any);
  await db.withConnection(async lease => {
    await lease.transaction(async tx => {
      await tx.execute('SELECT 1');
      await tx.transaction(inner => inner.execute('SELECT 2'));
    });
    expect(connection.release).not.toHaveBeenCalled();
  });
  expect(commands[0]).toBe('BEGIN');
  expect(commands.some(sql => sql.startsWith('SAVEPOINT '))).toBe(true);
  expect(commands.at(-1)).toBe('COMMIT');
  expect(connection.beginTransaction).toHaveBeenCalledTimes(1);
  expect(connection.rollback).not.toHaveBeenCalled();
  expect(connection.release).toHaveBeenCalledTimes(1);
});

it('rolls back a failed leased transaction without releasing another owner’s connection early', async () => {
  const connection: any = { beginTransaction: vi.fn(async () => {}), commit: vi.fn(), rollback: vi.fn(async () => {}), release: vi.fn() };
  const db = new Database({ getConnection: async () => connection } as any);
  await db.withConnection(async lease => {
    await expect(lease.transaction(async () => { throw new Error('synthetic failure'); })).rejects.toThrow('synthetic failure');
    expect(connection.rollback).toHaveBeenCalledTimes(1);
    expect(connection.release).not.toHaveBeenCalled();
  });
  expect(connection.commit).not.toHaveBeenCalled();
  expect(connection.release).toHaveBeenCalledTimes(1);
});
