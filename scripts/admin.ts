import 'dotenv/config';
import { Database } from '../src/core/database';
import { bootstrapRootByPhone, findUserByVerifiedPhone } from '../src/auth/admin';
import { ApiError } from '../src/core/errors';

async function phoneFromStdin(): Promise<string> {
  const input = process.stdin;
  if (!input.isTTY) {
    let value = '';
    for await (const chunk of input) { value += String(chunk); if (value.length > 64) throw Error('手机号输入无效'); }
    const phone = value.replace(/\r?\n$/, '');
    if (!phone || /[\r\n]/.test(phone)) throw Error('请通过标准输入提供一个完整的已验证手机号');
    return phone;
  }
  process.stdout.write('已验证手机号（输入不回显）：');
  const wasRaw = input.isRaw;
  input.setRawMode(true); input.resume(); input.setEncoding('utf8');
  try {
    return await new Promise<string>((resolve, reject) => {
      let value = '';
      const finish = (error?: Error) => { input.removeListener('data', onData); error ? reject(error) : resolve(value); };
      const onData = (chunk: string) => {
        for (const character of chunk) {
          if (character === '\u0003' || character === '\u0004') return finish(Error('手机号输入已取消'));
          if (character === '\r' || character === '\n') return finish();
          if (character === '\u007f' || character === '\b') value = value.slice(0, -1);
          else value += character;
          if (value.length > 32) return finish(Error('手机号输入无效'));
        }
      };
      input.on('data', onData);
    });
  } finally { input.setRawMode(wasRaw); input.pause(); process.stdout.write('\n'); }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2), command = args[0];
  const appId = process.env.WECHAT_APP_ID || '';
  if (!/^wx[0-9a-f]{16}$/i.test(appId)) throw Error('WECHAT_APP_ID must identify AR设备租赁.');
  if (!['list-users', 'bootstrap-root', 'find-user-by-phone'].includes(command || '')) throw Error('Usage: admin.ts list-users | bootstrap-root --phone-stdin | find-user-by-phone --phone-stdin');
  const byPhone = args.length === 2 && args[1] === '--phone-stdin' && ['bootstrap-root', 'find-user-by-phone'].includes(command);
  if (!byPhone && !(command === 'list-users' && args.length === 1)) throw Error('Usage: admin.ts list-users | bootstrap-root --phone-stdin | find-user-by-phone --phone-stdin');
  const phone = byPhone ? await phoneFromStdin() : undefined;
  const db = new Database();
  try {
    if (byPhone) {
      const match = command === 'bootstrap-root' ? await bootstrapRootByPhone(db, phone!, appId) : await findUserByVerifiedPhone(db, phone!, appId);
      console.log(JSON.stringify({ maskedNumber: match.maskedNumber, role: match.role }));
    } else if (command === 'list-users' && args.length === 1) {
      const users = await db.query('SELECT id,role,nickname,created_at FROM ar_user WHERE appid=? ORDER BY id DESC LIMIT 100', [appId]);
      console.table(users);
    } else throw Error('Usage: admin.ts find-user-by-phone --phone-stdin');
  } finally { await db.close(); }
}
main().catch(error => {
  const safe = error instanceof ApiError || error instanceof Error && /^(Usage:|WECHAT_APP_ID |手机号输入|请通过标准输入)/.test(error.message);
  console.error(safe ? error.message : 'Administrator operation failed. Verify the server configuration.');
  process.exitCode = 1;
});
