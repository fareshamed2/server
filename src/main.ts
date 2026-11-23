import { config } from './config.ts';
import { startServer } from './net/server.ts';

const server = await startServer({
  databaseUrl: config.databaseUrl,
  port: config.port,
  worldPath: config.worldPath,
  adminUsernames: config.adminUsernames,
  sessionTtlHours: config.sessionTtlHours,
  authAttemptsPerMinute: config.authAttemptsPerMinute,
});

let stopping = false;
async function shutdown(sig: string) {
  if (stopping) return;
  stopping = true;
  console.log(`${sig} received, saving world and shutting down…`);
  await server.close();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
