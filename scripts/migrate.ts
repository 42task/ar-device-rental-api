import 'dotenv/config';
import { Database } from '../src/core/database';
import { migrate } from '../src/core/migrations';

async function main(): Promise<void> {
  const db = new Database();
  try { await migrate(db); console.log('Independent AR rental database schema is ready.'); }
  finally { await db.close(); }
}
void main().catch(error => { console.error(error instanceof Error ? error.message : 'Schema migration failed.'); process.exitCode = 1; });
