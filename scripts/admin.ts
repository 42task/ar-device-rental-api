import 'dotenv/config';
import { Database } from '../src/core/database';
import { bootstrapRoot } from '../src/auth';

async function main(): Promise<void> {
  const args = process.argv.slice(2), command = args[0];
  const appId = process.env.WECHAT_APP_ID || '';
  if (!/^wx[0-9a-f]{16}$/i.test(appId)) throw Error('WECHAT_APP_ID must identify AR设备租赁.');
  if (!['list-users', 'bootstrap-root'].includes(command || '')) throw Error('Usage: admin.ts list-users | bootstrap-root --user-id N');
  const db = new Database();
  try {
    if (command === 'list-users') {
      const users = await db.query('SELECT id,role,nickname,created_at FROM ar_user WHERE appid=? ORDER BY id DESC LIMIT 100', [appId]);
      console.table(users);
    } else {
      if (args.length !== 3 || args[1] !== '--user-id' || !/^[1-9][0-9]*$/.test(args[2])) throw Error('Usage: admin.ts bootstrap-root --user-id N');
      const userId = Number(args[2]);
      await bootstrapRoot(db, userId, appId);
      console.log(`Initial root created for user ${userId}; operation recorded in ar_role_audit.`);
    }
  } finally { await db.close(); }
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Administrator operation failed.'); process.exitCode = 1; });
