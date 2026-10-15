import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { getState } from '../lib/engine';
import { buildPool } from '../lib/import-data';
import { loadEnvironment, safeError } from '../scripts/env';
import { createIsolated, dropIsolated, seedManagers, seedPlayers, recordFixtureImport, sql } from './support';
import { importFixture } from './import-fixture';

function child(args: string[], env: Record<string, string> = {}) {
    const result = spawnSync(process.execPath, ['--import', 'tsx', ...args], {
        encoding: 'utf8', timeout: 30000, env: { ...process.env, ...env }
    });
    assert.equal(result.status, 0, safeError(new Error(result.stderr)));
    return result.stdout;
}
async function main() {
    loadEnvironment();
    const root = process.env.EVIDENCE_DIR;
    if (!root) throw new Error('Set EVIDENCE_DIR');
    const dir = `${root}/pool-process`;
    await mkdir(`${dir}/import`, { recursive: true });
    const schema = await createIsolated('test');
    try {
        const raw = importFixture();
        await seedManagers();
        await seedPlayers(buildPool(raw).players);
        for (let i = 0; i < 8; i++) await recordFixtureImport();
        const warm = await getState();
        assert.equal(warm.poolRevision, "9");
        const removed = warm.players[0].id;
        delete raw[0][removed];
        const fixture = `${dir}/fixture.json`;
        await writeFile(fixture, JSON.stringify(raw));
        await writeFile(`${dir}/import/sleeper-2026.json`, JSON.stringify({
            fetchedAt: new Date().toISOString(), data: raw
        }));
        child(['--import', resolve('tests/import-fetch.mjs'), 'scripts/import.ts', '--apply'], {
            EVIDENCE_DIR: dir, IMPORT_TEST_FIXTURE: fixture
        });
        child(['tests/review-worker.ts', 'start']);
        const current = await getState();
        await sql("UPDATE draft SET deadline=clock_timestamp()-interval '1 second'");
        const errors: string[] = [];
        for (let i = 0; i < 2; i++) {
            try { await getState(); } catch (error) { errors.push(safeError(error)); }
        }
        const fresh = JSON.parse(child(['tests/review-worker.ts', 'read']));
        const receipt = {
            name: 'B3/C5 warm setup process observes another process import and start before expiry',
            warmPool: warm.players.length, currentPool: current.players.length,
            warmRevision: warm.poolRevision, currentRevision: current.poolRevision,
            removedStillCached: current.players.some(player => player.id === removed), expiredReadErrors: errors,
            freshProcessControl: fresh.phase === 'bidding' && fresh.playerId !== removed
        };
        await writeFile(`${dir}/result.json`, JSON.stringify(receipt, null, 2));
        assert.equal(current.poolRevision, "10");
        assert.equal(receipt.removedStillCached, false);
        assert.deepEqual(errors, []);
        assert.equal(current.players.length, warm.players.length - 1);
        assert.equal(receipt.freshProcessControl, true);
        console.log(`PASS ${receipt.name}`);
    } finally {
        await dropIsolated(schema);
    }
}
main().catch(error => { console.error(safeError(error)); process.exitCode = 1; });
