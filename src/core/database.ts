import mysql, { type Pool, type PoolConnection } from 'mysql2/promise';
import { AsyncLocalStorage } from 'node:async_hooks';
import { ApiError } from './errors';
import type { Row } from './contracts';

export interface Column { name: string; type: string; nullable: boolean; default?: unknown; key?: string }
const transactions = new AsyncLocalStorage<{ pool: Pool; connection: PoolConnection }>();
let savepoint = 0;
export function identifier(value: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) throw new Error('Invalid SQL identifier');
  return '`' + value + '`';
}

/** A standalone MySQL adapter: no legacy schema, PHP serialization or Redis. */
export class Database {
  readonly pool: Pool;
  private readonly schema = new Map<string, Column[]>();
  constructor(pool?: Pool, private readonly connection?: PoolConnection, private readonly transactionBound = false) {
    this.pool = pool ?? mysql.createPool({
      host: process.env.MYSQL_HOST || '127.0.0.1',
      port: Number(process.env.MYSQL_PORT || 3306),
      user: process.env.MYSQL_USER || 'ar_rental',
      password: process.env.MYSQL_PASSWORD || '',
      database: process.env.MYSQL_DATABASE || 'ar_device_rental',
      charset: 'utf8mb4', timezone: '+00:00', dateStrings: true,
      decimalNumbers: true, supportBigNumbers: true, bigNumberStrings: true,
      connectionLimit: Number(process.env.MYSQL_POOL_SIZE || 10), connectTimeout: 5000,
    });
  }
  private active(): PoolConnection | undefined {
    const ambient = transactions.getStore();
    return this.connection ?? (ambient?.pool === this.pool ? ambient.connection : undefined);
  }
  async query<T = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
    const [rows] = await (this.active() ?? this.pool).query(sql, params);
    return rows as T[];
  }
  async execute(sql: string, params: unknown[] = []): Promise<{ affectedRows: number; insertId: number }> {
    const [result] = await (this.active() ?? this.pool).query(sql, params);
    return result as { affectedRows: number; insertId: number };
  }
  async one<T = Row>(sql: string, params: unknown[] = []): Promise<T | null> {
    return (await this.query<T>(sql, params))[0] ?? null;
  }
  async columns(table: string): Promise<Column[]> {
    if (!this.schema.has(table)) {
      const rows = await this.query(`SHOW COLUMNS FROM ${identifier(table)}`);
      this.schema.set(table, rows.map(row => ({ name: row.Field, type: row.Type, nullable: row.Null === 'YES', default: row.Default, key: row.Key })));
    }
    return this.schema.get(table)!;
  }
  private value(value: unknown): unknown {
    return value !== null && typeof value === 'object' && !(value instanceof Date) && !Buffer.isBuffer(value) ? JSON.stringify(value) : value;
  }
  async insert(table: string, data: Row): Promise<Row> {
    const columns = await this.columns(table);
    const entries = Object.entries(data).filter(([key, value]) => value !== undefined && columns.some(column => column.name === key));
    const result = await this.execute(`INSERT INTO ${identifier(table)} (${entries.map(([key]) => identifier(key)).join(',')}) VALUES (${entries.map(() => '?').join(',')})`, entries.map(([, value]) => this.value(value)));
    const primary = columns.find(column => column.key === 'PRI')?.name || 'id';
    return (await this.one(`SELECT * FROM ${identifier(table)} WHERE ${identifier(primary)}=?`, [data[primary] ?? result.insertId]))!;
  }
  async update(table: string, rowId: unknown, data: Row): Promise<Row> {
    const columns = await this.columns(table);
    const primary = columns.find(column => column.key === 'PRI')?.name || 'id';
    const entries = Object.entries(data).filter(([key, value]) => key !== primary && value !== undefined && columns.some(column => column.name === key));
    if (entries.length) await this.execute(`UPDATE ${identifier(table)} SET ${entries.map(([key]) => `${identifier(key)}=?`).join(',')} WHERE ${identifier(primary)}=?`, [...entries.map(([, value]) => this.value(value)), rowId]);
    const row = await this.one(`SELECT * FROM ${identifier(table)} WHERE ${identifier(primary)}=?`, [rowId]);
    if (!row) throw new ApiError(404, '记录不存在');
    return row;
  }
  async delete(table: string, rowId: unknown): Promise<void> {
    const primary = (await this.columns(table)).find(column => column.key === 'PRI')?.name || 'id';
    await this.execute(`DELETE FROM ${identifier(table)} WHERE ${identifier(primary)}=?`, [rowId]);
  }
  async transaction<T>(operation: (db: Database) => Promise<T>): Promise<T> {
    const existing = this.active();
    const ambient = transactions.getStore();
    const nested = !!existing && (this.transactionBound || ambient?.pool === this.pool && ambient.connection === existing);
    if (existing && nested) {
      const name = `ar_tx_${++savepoint}`;
      await existing.query(`SAVEPOINT ${name}`);
      try { const value = await operation(new Database(this.pool, existing, true)); await existing.query(`RELEASE SAVEPOINT ${name}`); return value; }
      catch (error) { await existing.query(`ROLLBACK TO SAVEPOINT ${name}`); await existing.query(`RELEASE SAVEPOINT ${name}`); throw error; }
    }
    const connection = existing ?? await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const value = await transactions.run({ pool: this.pool, connection }, () => operation(new Database(this.pool, connection, true)));
      await connection.commit();
      return value;
    } catch (error) { await connection.rollback(); throw error; }
    finally { if (!existing) connection.release(); }
  }
  async withConnection<T>(operation: (db: Database) => Promise<T>): Promise<T> {
    const connection = await this.pool.getConnection();
    try { return await operation(new Database(this.pool, connection)); }
    finally { connection.release(); }
  }
  async close(): Promise<void> { await this.pool.end(); }
}
