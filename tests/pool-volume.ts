import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { types } from 'pg';
import { NextRequest } from 'next/server';
import { GET } from '../app/api/state/route';
import { loadEnvironment, safeError } from '../scripts/env';
import { createIsolated, dropIsolated, recordFixtureImport, seedManagers, sql } from './support';

let bytes = 0;
let playerBytes = 0;
types.setTypeParser(114, raw => {
    bytes += Buffer.byteLength(raw);
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed[0]?.positions) playerBytes += Buffer.byteLength(raw);
    return parsed;
});
async function main() {
    loadEnvironment();
    const root = process.env.EVIDENCE_DIR;
    if (!root) throw new Error('Set EVIDENCE_DIR');
    await mkdir(root, { recursive: true });
    const schema = await createIsolated('test');
    try {
        await seedManagers();
        await sql('INSERT INTO players SELECT * FROM auction.players');
        await sql(`INSERT INTO import_runs(started_at,sources,counts,coverage)
            VALUES(clock_timestamp(),'["local source copy"]',
            json_build_object('pool',(SELECT count(*) FROM players)),'{}')`);
        const first = await GET(new NextRequest('http://localhost/api/state'));
        const initial = await first.json();
        const results = [];
        for (const status of ['setup', 'setup', 'setup', 'running', 'running', 'running']) {
            await sql('UPDATE draft SET status=$1', [status]);
            bytes = 0;
            playerBytes = 0;
            const response = await GET(new NextRequest(
                `http://localhost/api/state?players=0&poolRevision=${initial.poolRevision ?? '0'}`));
            const body = await response.text();
            results.push({ status, responseStatus: response.status, dbJsonBytes: bytes,
                dbPlayerJsonBytes: playerBytes, responseBytes: Buffer.byteLength(body),
                responsePlayerCount: JSON.parse(body).players.length });
        }
        await writeFile(`${root}/pool-volume.json`, JSON.stringify(results, null, 2));
        console.log(JSON.stringify(results));
        if (!process.argv.includes('--measure-only')) {
            assert(results.every(result => result.dbPlayerJsonBytes === 0),
                'Warm state polls must not transfer the pool');
            assert(results.every(result => result.dbJsonBytes < 10000));
            await recordFixtureImport();
            const changed = await GET(new NextRequest(
                `http://localhost/api/state?poolRevision=${initial.poolRevision}`));
            const refreshed = await changed.json();
            assert.notEqual(refreshed.poolRevision, initial.poolRevision);
            assert.equal(refreshed.players.length, initial.players.length);
            const known = await GET(new NextRequest(
                `http://localhost/api/state?poolRevision=${refreshed.poolRevision}`));
            const knownPool = await known.json();
            assert.equal(knownPool.players.length, 0);
            const newClient = await GET(new NextRequest('http://localhost/api/state'));
            assert.equal((await newClient.json()).players.length, initial.players.length);
            await writeFile(`${root}/pool-protocol.json`, JSON.stringify({
                firstPool: initial.players.length, staleRevisionPool: refreshed.players.length,
                knownRevisionPool: knownPool.players.length, newClientPool: initial.players.length
            }, null, 2));
        }
    } finally {
        await dropIsolated(schema);
    }
}
main().catch(error => { console.error(safeError(error)); process.exitCode = 1; });
