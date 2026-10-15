import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { AuctionClient } from '../lib/client';
import { buildPool } from '../lib/import-data';
import { safeError } from '../scripts/env';
import { importFixture } from './import-fixture';
import { createIsolated, dropIsolated, seedManagers, seedPlayers, claimSeat, configure,
    currentBackend, sleep } from './support';
async function child(args: string[], input: unknown, environment: Record<string, string> = {}) {
    const process_ = spawn(process.execPath, ['--import', 'tsx', ...args], {
        env: { PATH: process.env.PATH, NODE_ENV: 'test', ...environment }, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    let error = '';
    process_.stdout.on('data', part => { output += String(part); });
    process_.stderr.on('data', part => { error += String(part); });
    process_.stdin.end(JSON.stringify(input));
    const code = await new Promise(resolve => process_.once('exit', resolve));
    assert.equal(code, 0, error);
    return output;
}
async function main() {
    const isolated = await createIsolated('test');
    const dir = `${process.env.EVIDENCE_DIR}/pool-process`;
    await mkdir(`${dir}/import`, { recursive: true });
    try {
        const raw = importFixture();
        await seedManagers();
        await seedPlayers(buildPool(raw).players);
        const token = await claimSeat(1);
        const warmClient = new AuctionClient(currentBackend().url);
        const warm = await warmClient.state();
        const removed = warm.players[0].id;
        delete raw[0][removed];
        await writeFile(`${dir}/fixture.json`, JSON.stringify(raw));
        await writeFile(`${dir}/import/sleeper-2026.json`, JSON.stringify({
            fetchedAt: new Date().toISOString(), data: raw }));
        const args = ['--import', resolve('tests/import-fetch.mjs'), 'scripts/import.ts', '--apply'];
        const imported = await child(args, {}, {
            EVIDENCE_DIR: dir, IMPORT_TEST_FIXTURE: `${dir}/fixture.json`,
            CONVEX_LOCAL_DIR: `${currentBackend().identity.directory}/.convex/local/default` });
        await writeFile(`${dir}/import.log`, imported);
        await configure({ draft: { nominationMs: 200 } });
        await child(['tests/review-worker.ts'], { url: currentBackend().url, token, mode: 'start' });
        await sleep(300);
        const current = await warmClient.state();
        const fresh = JSON.parse(await child(['tests/review-worker.ts'], { url: currentBackend().url, mode: 'read' }));
        assert.notEqual(current.poolRevision, warm.poolRevision);
        assert.equal(current.players.length, warm.players.length - 1);
        assert(!current.players.some(player => player.id === removed));
        assert.equal(current.draft.phase, 'bidding');
        assert.notEqual(current.lot!.playerId, removed);
        assert.equal(fresh.phase, 'bidding');
        assert.notEqual(fresh.playerId, removed);
        await writeFile(`${dir}/result.json`, JSON.stringify({
            name: 'B3/C5 warm client observes cross-process import and start',
            warmRevision: warm.poolRevision, revision: current.poolRevision, warmPool: warm.players.length,
            currentPool: current.players.length, removedStillCached: false, freshProcessControl: true }, null, 2));
        console.log('PASS B3/C5 warm client observes another process import and start before expiry');
    } finally { await dropIsolated(isolated); }
}
main().catch(error => { console.error(safeError(error)); process.exitCode = 1; });
