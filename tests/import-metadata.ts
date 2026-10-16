import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import fixture from './fixtures/sleeper-pool.json';
import { sourceUrls } from '../lib/import-data';
import type { Player } from '../lib/types';
import { makeEvidenceDirectory, writeEvidenceFile } from '../scripts/evidence';
import { withResources } from '../scripts/resources';
import { createIsolated, currentBackend, dropIsolated, inspect, seedPlayers } from './support';

async function main() {
    const root = `${process.env.EVIDENCE_DIR}/import-metadata`;
    await makeEvidenceDirectory(root, { recursive: true });
    const isolated = await createIsolated('sim');
    const results: Record<string, unknown>[] = [];
    const metadata = { fetchedAt: fixture.fetchedAt, sources: sourceUrls, counts: fixture.counts,
        coverage: fixture.coverage };
    try {
        try {
            await Reflect.apply(seedPlayers, null, [fixture.players as Player[], metadata]);
            const stored = (await inspect()).imports.at(-1);
            results.push({ name: 'C34 recorded pool retains immutable fetch metadata in Convex',
                result: 'failed', expected: metadata, stored });
            assert.equal(stored.fetchedAt, '2026-10-14T21:21:00.000Z');
            assert.deepEqual(stored.sources, sourceUrls);
            assert.deepEqual(stored.counts, fixture.counts);
            assert.deepEqual(stored.coverage, fixture.coverage);
            results.at(-1)!.result = 'passed';
            console.log('PASS C34 recorded pool retains immutable fetch metadata in Convex');
        } catch (error) { results.at(-1)!.error = String(error); }
        try {
            const name = 'C34 actual simulation seeding preserves recorded pool provenance';
            results.push({ name, result: 'failed' });
            const source = await readFile(resolve('scripts/sim.ts'), 'utf8');
            assert(source.includes("process.argv.includes('--check-import')"),
                'The actual simulation must expose an import-only check before running a full draft');
            const checked = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/sim.ts', '--runs', '1',
                '--timing', 'fast', '--seed', '42', '--skip-build', '--check-import'], {
                cwd: resolve('.'), encoding: 'utf8', timeout: 90000,
                env: { PATH: process.env.PATH, NODE_ENV: 'test', EVIDENCE_DIR: `${root}/simulation` }
            });
            await writeEvidenceFile(`${root}/simulation.log`, checked.stdout + checked.stderr);
            assert.equal(checked.status, 0, checked.stderr);
            const reported = JSON.parse(await readFile(`${root}/simulation/sim/run-fast-42-1.json`, 'utf8'));
            const stored = reported.seededImport;
            Object.assign(results.at(-1)!, { reported, stored });
            assert.equal(reported.check, 'import-only; no draft started');
            assert.equal(reported.clients, 0);
            assert.equal(stored.fetchedAt, fixture.fetchedAt);
            assert.deepEqual(stored.sources, sourceUrls);
            assert.deepEqual(stored.counts, fixture.counts);
            assert.deepEqual(stored.coverage, fixture.coverage);
            assert.deepEqual(reported.importMetadata, metadata);
            assert(reported.source.includes(fixture.fetchedAt));
            results.at(-1)!.result = 'passed';
            console.log(`PASS ${name}`);
        } catch (error) { results.at(-1)!.error = String(error); }
        const freshAt = Date.now();
        const imported = spawnSync(process.execPath, ['--import', 'tsx', '--import', resolve('tests/import-fetch.mjs'),
            'scripts/import.ts', '--apply'], { cwd: resolve('.'), encoding: 'utf8', timeout: 30000,
            env: { PATH: process.env.PATH, NODE_ENV: 'test', EVIDENCE_DIR: `${root}/fresh`,
                IMPORT_TEST_NOW: String(freshAt), IMPORT_TEST_FETCH_LOG: `${root}/fetch.jsonl`,
                CONVEX_LOCAL_DIR: `${currentBackend().identity.directory}/.convex/local/default` } });
        await writeEvidenceFile(`${root}/fresh.log`, imported.stdout + imported.stderr);
        assert.equal(imported.status, 0);
        const fresh = (await inspect()).imports.at(-1);
        assert.equal(fresh.fetchedAt, new Date(freshAt).toISOString());
        assert.deepEqual(fresh.sources, sourceUrls);
        results.push({ name: 'Fresh fixture-only importer records its current fetch time', result: 'passed',
            stored: fresh, startedAt: new Date(freshAt).toISOString() });
        console.log('PASS Fresh fixture-only importer records its current fetch time');
    } finally {
        await dropIsolated(isolated);
        await writeEvidenceFile(`${root}/results.json`, JSON.stringify(results, null, 2));
    }
    assert(results.every(row => row.result === 'passed'), 'Import metadata regressions must pass');
}
withResources(main).catch(error => { console.error(error); process.exitCode = 1; });
