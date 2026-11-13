import 'dotenv/config';
import { createApplication } from './application';
import { startRentalWorker } from './rentals';
import { SCHEMA_VERSION } from './core/migrations';

async function main(): Promise<void> {
  const runtime = createApplication();
  const port = Number(process.env.PORT || 8080);
  try {
    const schema = await runtime.db.one('SELECT version FROM ar_schema_meta WHERE name=?', ['ar-device-rental-api']);
    if (Number(schema?.version) !== SCHEMA_VERSION) throw new Error('Run npm run migrate before starting the API.');
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT.');
  } catch (error) { await runtime.db.close(); throw error; }
  const server = runtime.app.listen(port, process.env.HOST || '0.0.0.0');
  try { await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); }); }
  catch (error) { await runtime.db.close(); throw error; }
  const worker = startRentalWorker(runtime.rentals);
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    const timeout = setTimeout(() => { server.closeAllConnections(); process.exitCode = 1; }, 30000);
    timeout.unref();
    try {
      await Promise.all([
        new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
        worker.stop(),
      ]);
    } finally { await runtime.db.close(); clearTimeout(timeout); }
  };
  process.once('SIGTERM', () => { void shutdown().catch(() => { process.exitCode = 1; }); });
  process.once('SIGINT', () => { void shutdown().catch(() => { process.exitCode = 1; }); });
  console.log(`AR device rental API listening on port ${port}.`);
}
void main().catch(() => { console.error('AR rental API could not start. Verify the dedicated database, migration and server configuration.'); process.exitCode = 1; });
