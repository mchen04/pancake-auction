import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { createServer } from 'node:net';
import { Client } from 'pg';
import { loadEnvironment, safeError } from '../scripts/env';
import { schemaName } from '../lib/db';
import { createIsolated, dropIsolated, seedManagers, seedPlayers, sleep, sql } from './support';

async function freePort() {
  return new Promise<number>(resolve => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Cannot reserve a port');
      server.close(() => resolve(address.port));
    });
  });
}
async function stop(server: ChildProcess) {
  if (server.exitCode !== null || server.signalCode !== null) return;
  const stopped = new Promise(resolve => server.once('exit', resolve));
  server.kill('SIGTERM');
  await stopped;
}
async function main() {
  loadEnvironment();
  const dir = process.env.EVIDENCE_DIR;
  if (!dir) throw new Error('Set EVIDENCE_DIR');
  await mkdir(`${dir}/ui`, { recursive: true });
  const source = schemaName();
  const schema = await createIsolated('test');
  const direct = new Client({ connectionString: process.env.DATABASE_URL });
  await direct.connect();
  const players = (await direct.query(`SELECT data FROM "${source}".players`)).rows.map(row => row.data);
  await direct.end();
  await seedPlayers(players);
  await seedManagers();
  await sql('UPDATE draft SET nomination_ms=120000,bidding_ms=120000,extension_ms=5000,cap_ms=150000');
  const port = await freePort();
  const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-p', String(port)], {
    env: { ...process.env, SEAT_COOKIE_SECURE: 'false' }, stdio: ['ignore', 'pipe', 'pipe']
  });
  const log = createWriteStream(`${dir}/ui/server.log`);
  server.stdout.pipe(log);
  server.stderr.pipe(log);
  await writeFile(`${dir}/ui/active.json`, JSON.stringify({ schema, pid: process.pid, serverPid: server.pid, port }));
  let cleaning = false;
  async function cleanup() {
    if (cleaning) return;
    cleaning = true;
    await stop(server);
    await dropIsolated(schema);
    log.end();
    process.exit();
  }
  process.once('SIGTERM', () => void cleanup());
  process.once('SIGINT', () => void cleanup());
  for (let attempt = 0; attempt < 50; attempt++) {
    if (server.exitCode !== null) break;
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/state`)).ok) {
        console.log(`UI test ready at http://127.0.0.1:${port}`);
        return;
      }
    } catch {}
    await sleep(200);
  }
  await stop(server);
  await dropIsolated(schema);
  log.end();
  throw new Error('UI server failed');
}
main().catch(error => { console.error(safeError(error)); process.exitCode = 1; });
