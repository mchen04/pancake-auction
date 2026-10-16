import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { access, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { evidenceDirectory, makeEvidenceDirectory, makeEvidenceTemporaryDirectory,
    writeEvidenceFile } from '../scripts/evidence';
import { localBackend, portListening } from '../scripts/local-backend';
import { isolatedBackendVersion } from '../scripts/local-version';
import { withResources } from '../scripts/resources';

async function main() {
    const root = evidenceDirectory(`${process.env.EVIDENCE_DIR}/backend-network`, true)!;
    await makeEvidenceDirectory(root, { recursive: true });
    const log = `${root}/network.jsonl`;
    const rows = async () => (await readFile(log, 'utf8').catch(() => '')).trim().split('\n')
        .filter(Boolean).map(line => JSON.parse(line));
    const controlHome = await makeEvidenceTemporaryDirectory(`${root}/control-`);
    try {
        const control = childProcess.spawnSync(process.execPath, ['--import', resolve('scripts/local-cli.mjs'),
            '--import', resolve('tests/backend-fetch.mjs'), '-e',
            "fetch('https://version.convex.dev/v1/local_backend_version').then(()=>process.exit(2),error=>process.exit(error.cause?.code==='ENOTFOUND'?0:3))"],
        { encoding: 'utf8', timeout: 10000, env: { PATH: process.env.PATH, NODE_ENV: 'test',
            AUCTION_CLI_HOME: controlHome, AUCTION_NETWORK_LOG: log } });
        assert.equal(control.status, 0);
        assert((await rows()).some(row => row.hostname === 'version.convex.dev' && row.blocked));
    } finally { await rm(controlHome, { recursive: true, force: true }); }
    const originalSpawn = childProcess.spawn;
    let emptyCache: string | undefined;
    let dashboardState = 'missing';
    childProcess.spawn = new Proxy(originalSpawn, {
        apply(target, receiver, values) {
            const [command, args, options] = values;
            if (Array.isArray(args) && args.includes('dev')
                && options?.env?.AUCTION_CLI_HOME) {
                return Reflect.apply(target, receiver, [command,
                    ['--import', resolve('tests/backend-fetch.mjs'), ...args],
                    { ...options, env: { ...options?.env, AUCTION_NETWORK_LOG: log,
                        AUCTION_DASHBOARD_STATE: dashboardState,
                        ...(emptyCache ? { AUCTION_EMPTY_CACHE: emptyCache } : {}) } }]);
            }
            return Reflect.apply(target, receiver, values);
        }
    });
    syncBuiltinESMExports();
    const results: Record<string, unknown>[] = [];
    try {
        const states = process.argv.includes('--one') ? ['missing'] : ['missing', 'mismatched', 'missing'];
        for (const [index, state] of states.entries()) {
            dashboardState = state;
            const before = (await rows()).length;
            try {
                const backend = await localBackend(`offline-cached-${index}`);
                const identity = backend.identity;
                await backend.close();
                const listeners = await Promise.all([identity.port, identity.sitePort].map(portListening));
                const removed = !await access(identity.directory).then(() => true, () => false);
                const requests = (await rows()).slice(before);
                const dashboardAfter = await readFile(resolve('.convex/backend-binary-cache/dashboard/config.json'), 'utf8')
                    .then(JSON.parse, error => {
                        if (error.code === 'ENOENT') return null;
                        throw error;
                    });
                const proof = { name: 'Pinned cached backend starts with remote DNS blocked', result: 'passed', state,
                    version: identity.version, requests, listeners, directoryRemoved: removed, dashboardAfter };
                assert.equal(identity.version, isolatedBackendVersion);
                assert(!requests.some(row => row.kind === 'backend-version'), 'Pinned startup must skip backend-version lookup');
                assert.deepEqual(listeners, [false, false]);
                assert(removed);
                assert(requests.some(row => row.kind === 'dashboard-state' && row.forced === state));
                assert.deepEqual(dashboardAfter, state === 'mismatched' ? { version: 'fixture-mismatched-version' } : null);
                assert(!requests.some(row => row.kind === 'fetch' && row.hostname === 'github.com'));
                const startupLog = await readFile(`${process.env.EVIDENCE_DIR}/backend-offline-cached-${index}.log`, 'utf8');
                assert(!/Unexpected Error|UnhandledPromiseRejection|uncaughtException/i.test(startupLog));
                results.push(proof);
                console.log('PASS Pinned cached backend starts with remote DNS blocked');
            } catch (error) {
                results.push({ name: 'Pinned cached backend starts with remote DNS blocked',
                    result: 'failed', state, error: String(error), requests: (await rows()).slice(before) });
                process.exitCode = 1;
            }
        }
        dashboardState = '';
        emptyCache = await makeEvidenceTemporaryDirectory(`${root}/empty-cache-`);
        const missingBefore = (await rows()).length;
        try {
            let failure: unknown;
            try { await localBackend('offline-missing'); } catch (error) { failure = error; }
            const requests = (await rows()).slice(missingBefore);
            const proof = { name: 'Missing binary reports a clear failure when download is blocked',
                result: 'failed', error: String(failure), requests };
            results.push(proof);
            assert(failure instanceof Error);
            assert(failure.message.includes(isolatedBackendVersion));
            assert.match(failure.message, /cached|download/);
            assert(requests.some(row => row.hostname === 'github.com' && row.blocked));
            assert(!requests.some(row => row.kind === 'backend-version'));
            proof.result = 'passed';
            console.log('PASS Missing pinned binary reports failure without a version lookup');
        } finally { await rm(emptyCache, { recursive: true, force: true }); }
    } finally {
        childProcess.spawn = originalSpawn;
        syncBuiltinESMExports();
        await writeEvidenceFile(`${root}/results.json`, JSON.stringify(results, null, 2));
    }
}
withResources(main).catch(error => { console.error(error); process.exitCode = 1; });
