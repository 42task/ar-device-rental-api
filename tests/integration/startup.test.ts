import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import mysql from 'mysql2/promise';
import { describe, expect, it } from 'vitest';
import { Database } from '../../src/core/database';
import { migrate, SCHEMA_VERSION } from '../../src/core/migrations';

async function unusedLoopbackPort(): Promise<number> {
  const socket = createServer();
  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', resolve);
  });
  const address = socket.address();
  if (!address || typeof address === 'string') throw new Error('Could not allocate a loopback test port.');
  await new Promise<void>((resolve, reject) => socket.close(error => error ? reject(error) : resolve()));
  return address.port;
}

describe.skipIf(process.env.RUN_INTEGRATION !== '1')('compiled API process startup', () => {
  it('starts against the current migrated schema, becomes healthy and shuts down on SIGTERM', async () => {
    if (!['127.0.0.1', 'localhost'].includes(process.env.MYSQL_HOST || '') || process.env.MYSQL_DATABASE !== 'ar_rental_test') throw new Error('Use the dedicated localhost AR rental test environment.');
    const settings = { host: process.env.MYSQL_HOST, port: Number(process.env.MYSQL_PORT || 3306), user: process.env.MYSQL_USER, password: process.env.MYSQL_PASSWORD };
    const control = await mysql.createConnection(settings);
    const database = 'ar_startup_test_' + randomBytes(10).toString('hex');
    let db: Database | undefined, created = false, fixtureDirectory: string | undefined, child: ChildProcess | undefined;
    let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    let spawnFailure: Error | undefined;
    let exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;
    try {
      await control.query(`CREATE DATABASE ${database} CHARACTER SET utf8mb4`); created = true;
      db = new Database(mysql.createPool({ ...settings, database, connectionLimit: 2 }));
      await migrate(db);
      expect(Number((await db.one('SELECT version FROM ar_schema_meta WHERE name=?', ['ar-device-rental-api']))!.version)).toBe(SCHEMA_VERSION);
      const port = await unusedLoopbackPort();
      fixtureDirectory = await mkdtemp(join(tmpdir(), 'ar-startup-fixture-'));
      // Whitelist this child's environment and disable dotenv loading, so neither
      // developer .env files nor inherited merchant credentials can reach it.
      child = spawn(process.execPath, [resolve('dist/src/main.js')], {
        cwd: process.cwd(), stdio: 'ignore', env: {
          NODE_ENV: 'test', DOTENV_CONFIG_PATH: join(fixtureDirectory, 'absent.env'),
          HOST: '127.0.0.1', PORT: String(port), TRUST_PROXY: '0', PUBLIC_ORIGIN: `http://127.0.0.1:${port}`,
          MYSQL_HOST: settings.host, MYSQL_PORT: String(settings.port), MYSQL_DATABASE: database,
          MYSQL_USER: settings.user, MYSQL_PASSWORD: settings.password, MYSQL_POOL_SIZE: '2',
          JWT_SECRET: 'synthetic-startup-test-signing-key-at-least-32-bytes',
          WECHAT_APP_ID: 'wx03dbf50c15cac06f', WECHAT_PAY_ENABLED: '0',
          GIT_COMMIT: 'synthetic-startup-regression',
        },
      });
      child.once('error', error => { spawnFailure = error; });
      exited = new Promise(resolve => child!.once('exit', (code, signal) => { exit = { code, signal }; resolve(exit); }));
      const deadline = Date.now() + 10_000;
      let health: Record<string, unknown> | undefined;
      while (Date.now() < deadline) {
        if (spawnFailure) throw new Error('The compiled API process could not be spawned.');
        if (exit) throw new Error(`The compiled API exited before becoming ready (code ${exit.code}, signal ${exit.signal}).`);
        try {
          const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) });
          if (response.ok) { health = await response.json() as Record<string, unknown>; break; }
        } catch { /* The real listener may not be bound yet. */ }
        await delay(100);
      }
      expect(health).toMatchObject({ status: 'healthy', schema: 'ready', database: 'up', payments: 'disabled', gitCommit: 'synthetic-startup-regression' });
      expect(child.kill('SIGTERM')).toBe(true);
      const stopped = await Promise.race([exited, delay(5000).then(() => { throw new Error('The compiled API did not stop after SIGTERM.'); })]);
      expect(stopped).toEqual({ code: 0, signal: null });
    } finally {
      if (child?.pid && !exit) {
        child.kill('SIGTERM');
        await Promise.race([exited, delay(1000)]);
        if (!exit) { child.kill('SIGKILL'); await Promise.race([exited, delay(1000)]); }
      }
      await db?.close();
      if (created) await control.query(`DROP DATABASE ${database}`);
      await control.end();
      if (fixtureDirectory) await rm(fixtureDirectory, { recursive: true, force: true });
    }
  }, 20_000);
});
