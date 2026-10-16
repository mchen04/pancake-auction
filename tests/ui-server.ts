import { makeEvidenceDirectory as mkdir, writeEvidenceFile as writeFile } from '../scripts/evidence';
import { withResources, ownProcess } from '../scripts/resources';
import { spawn } from 'node:child_process';

import recorded from './fixtures/sleeper-pool.json';
import type { Player } from '../lib/types';
import { freePort, stopProcess } from '../scripts/local-backend';
import { safeError } from '../scripts/env';
import { createIsolated, dropIsolated, seedManagers, seedPlayers, configure, currentBackend } from './support';
async function main() {
    const name = await createIsolated('test');
    await seedManagers();
    await seedPlayers(recorded.players as Player[]);
    await configure({ draft: { nominationMs: 120000, biddingMs: 120000, capMs: 150000 } });
    const port = await freePort();
    const server = ownProcess(spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-p', String(port)],
        { env: { ...process.env, CONVEX_URL: currentBackend().url }, stdio: 'inherit' }));
    const dir = `${process.env.EVIDENCE_DIR}/ui`;
    await mkdir(dir, { recursive: true });
    await writeFile(`${dir}/active.json`, JSON.stringify({ backend: currentBackend().identity, port }));
    let closing = false;
    const close = async () => {
        if (closing) return;
        closing = true;
        await stopProcess(server);
        await dropIsolated(name);
    };
    process.once('SIGTERM', () => void close());
    process.once('SIGINT', () => void close());
    await new Promise(resolve => server.once('exit', resolve));
    await close();
}
withResources(main).catch(error => { console.error(safeError(error)); process.exitCode = 1; });
