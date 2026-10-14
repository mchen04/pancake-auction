import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { begin, closeDatabase, dbNow } from '../lib/db';
import { releaseSeat } from '../lib/engine';
import { leagueManagers, validateManagers } from '../lib/league';
import { loadEnvironment, safeError } from './env';
import { migrate } from './migrate';
import { checkLeague } from './readiness';

async function configureManagers() {
  const fileIndex = process.argv.indexOf('--file');
  const file = fileIndex < 0 ? null : process.argv[fileIndex + 1];
  if (fileIndex >= 0 && !file) throw new Error('Use --file <path.json>');
  const source = file ? JSON.parse(await readFile(file, 'utf8')) : leagueManagers;
  const entries = validateManagers(source);
  const client = await begin();
  try {
    const draft = (await client.query('SELECT status FROM draft WHERE id=1 FOR UPDATE')).rows[0];
    const hasLots = (await client.query('SELECT 1 FROM lots LIMIT 1')).rowCount;
    if (draft.status !== 'setup' || hasLots) throw new Error('Managers cannot change after the draft starts');
    const existing = (await client.query('SELECT id FROM managers ORDER BY id')).rows;
    if (existing.length && existing.length !== 10) throw new Error('Existing configuration needs ten managers');
    if (existing.length) {
      await client.query(`
        UPDATE managers SET commissioner=false,name='__replacement__' || id,
        token_hash=NULL,claimed_at=NULL
      `);
      for (const [index, entry] of entries.entries()) {
        await client.query('UPDATE managers SET name=$1,commissioner=$2 WHERE id=$3',
          [entry.name, entry.commissioner, existing[index].id]);
      }
    } else {
      for (const entry of entries) {
        await client.query('INSERT INTO managers(name,commissioner) VALUES($1,$2)',
          [entry.name, entry.commissioner]);
      }
    }
    const data = { now: await dbNow(client), names: entries.map(entry => entry.name) };
    await client.query("INSERT INTO events(type,data) VALUES('managers-configured',$1)", [data]);
    await client.query('COMMIT');
    console.log('Configured ten managers: ' + entries.map(entry => entry.name).join(', '));
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
async function releaseByName() {
  const index = process.argv.indexOf('--name');
  const name = index < 0 ? null : process.argv[index + 1];
  if (!name) throw new Error('Use --name <manager name>');
  const client = await begin();
  try {
    await client.query('SELECT id FROM draft WHERE id=1 FOR UPDATE');
    const manager = (await client.query('SELECT id FROM managers WHERE name=$1', [name])).rows[0];
    if (!manager) throw new Error('Manager not found');
    await releaseSeat(client, manager.id, null, await dbNow(client));
    await client.query('COMMIT');
    console.log('Released seat');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
function startApp(command: 'dev' | 'start') {
  const child = spawn('node', ['node_modules/next/dist/bin/next', command, ...process.argv.slice(3)], {
    stdio: 'inherit', env: process.env
  });
  process.on('SIGINT', () => child.kill('SIGINT'));
  process.on('SIGTERM', () => child.kill('SIGTERM'));
  child.on('exit', code => process.exit(code ?? 1));
}
async function main() {
  loadEnvironment();
  const command = process.argv[2];
  if (command === 'dev' || command === 'start') return startApp(command);
  if (command === 'migrate') return migrate();
  if (command === 'managers') return configureManagers();
  if (command === 'release') return releaseByName();
  if (command === 'check') {
    const report = await checkLeague();
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.ready ? 0 : 1;
    return;
  }
  throw new Error('Unknown command');
}
main().catch(error => {
  console.error(safeError(error));
  process.exitCode = 1;
}).finally(closeDatabase);
