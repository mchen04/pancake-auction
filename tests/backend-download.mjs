import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { access, chmod, readFile, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { hostname } from 'node:os';
import { makeEvidenceDirectory, makeEvidenceTemporaryDirectory, writeEvidenceFile } from '../scripts/evidence.ts';

const root = `${process.env.EVIDENCE_DIR}/backend-download`;
await makeEvidenceDirectory(root, { recursive: true });
const temporary = await makeEvidenceTemporaryDirectory(`${root}/case-`);
const helper = process.env.MINI_RUN_HELPER_SOURCE || resolve('../tools/mini-run.mjs');
const source = await readFile(helper, 'utf8');
const marker = source.indexOf('const mode = process.argv[2];');
assert(marker > 0);
await writeEvidenceFile(`${temporary}/adapter.mjs`, source.slice(0, marker) + '\nexport {backendCache,cacheLock};\n');
const { backendCache, cacheLock } = await import(pathToFileURL(`${temporary}/adapter.mjs`));
const io = { makeEvidenceDirectory, writeEvidenceFile };
const nativeFetch = globalThis.fetch;
const results = [];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function exists(path) { return access(path).then(() => true, () => false); }
async function closed(port) {
    return new Promise(resolve => {
        const socket = createConnection({ host: '127.0.0.1', port });
        socket.once('connect', () => { socket.destroy(); resolve(false); });
        socket.once('error', error => { socket.destroy(); resolve(error.code === 'ECONNREFUSED'); });
        socket.setTimeout(500, () => { socket.destroy(); resolve(false); });
    });
}
async function check(name, run) {
    const proof = {};
    try { await run(proof); results.push({ name, result: 'passed', proof }); console.log(`PASS ${name}`); }
    catch (error) {
        results.push({ name, result: 'failed', error: String(error), proof });
        console.log(`FAIL ${name}: ${error}`); process.exitCode = 1;
    }
}
const fixture = `${temporary}/fixture`;
await makeEvidenceDirectory(fixture);
await writeEvidenceFile(`${fixture}/convex-local-backend`, '#!/bin/sh\nprintf "local fixture backend\\n"\n');
await chmod(`${fixture}/convex-local-backend`, 0o755);
execFileSync('zip', ['-q', `${temporary}/fixture.zip`, 'convex-local-backend'], { cwd: fixture });
const zip = await readFile(`${temporary}/fixture.zip`);
try {
    for (const mode of ['headers', 'body', '503', 'complete']) {
        await check(`C46 ${mode} download has a total deadline and releases the lock`, async proof => {
            const remoteRoot = `${temporary}/${mode}`;
            const config = { remoteRoot, source: `${remoteRoot}/runs/one/src`, runId: `download-${mode}`,
                evidence: `${remoteRoot}/evidence`, lockWaitMs: 200, backendDownloadMs: 500 };
            await makeEvidenceDirectory(`${config.source}/convex`, { recursive: true });
            await makeEvidenceDirectory(`${config.source}/scripts`);
            await writeEvidenceFile(`${config.source}/convex/schema.ts`, '');
            await writeEvidenceFile(`${config.source}/scripts/local-version.ts`,
                "export const isolatedBackendVersion = 'precompiled-fixture';");
            let currentMode = mode;
            let chunks = 0;
            let received = 0;
            const intervals = new Set();
            const server = createServer((request, response) => {
                received++;
                if (currentMode === 'headers') return;
                if (currentMode === '503') { response.writeHead(503); response.end(); return; }
                response.writeHead(200, { 'Content-Type': 'application/zip' });
                if (currentMode === 'complete') { response.end(zip); return; }
                response.flushHeaders();
                const timer = setInterval(() => { response.write(Buffer.from([0])); chunks++; }, 20);
                intervals.add(timer);
                response.once('close', () => { clearInterval(timer); intervals.delete(timer); });
            });
            await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
            const port = server.address().port;
            proof.port = port;
            const signals = [];
            globalThis.fetch = (url, options) => {
                signals.push(Boolean(options?.signal));
                return nativeFetch(`http://127.0.0.1:${port}`, options);
            };
            let settled = false;
            let failure;
            const started = performance.now();
            const release = await cacheLock(config, io);
            const work = (async () => {
                try { return await backendCache(config, io); }
                finally { await release(); }
            })().catch(error => { failure = String(error); }).finally(() => { settled = true; });
            try {
                await Promise.race([work, pause(1700)]);
                proof.settledWithinBound = settled;
                proof.elapsedMs = performance.now() - started;
                proof.error = failure;
                proof.requests = received;
                proof.bodyChunks = chunks;
                proof.signalSupplied = signals.every(Boolean);
                proof.lockHeld = await exists(`${remoteRoot}/dependency-cache/.lock`);
                if (!settled) {
                    try { await cacheLock({ ...config, runId: 'blocked-contender' }, io); }
                    catch (error) { proof.contenderError = String(error); }
                }
                assert(settled, 'Download must finish within its total deadline, including body consumption');
                assert(!proof.lockHeld, 'Preparation lock must release');
                assert(received > 0);
                if (mode === 'headers' || mode === 'body') {
                    assert.match(failure, /download timed out after 500 ms/i);
                    assert(proof.signalSupplied);
                    if (mode === 'body') assert(chunks > 0);
                } else if (mode === '503') assert.match(failure, /HTTP 503/);
                else assert.equal(failure, undefined);
                assert(!(await readdir(`${remoteRoot}/backend-cache`)).some(name => name.startsWith('install-')));
                currentMode = 'complete';
                const second = { ...config, runId: 'successful-contender',
                    source: `${remoteRoot}/runs/two/src` };
                await makeEvidenceDirectory(dirname(second.source), { recursive: true });
                const afterRelease = await cacheLock(second, io);
                try {
                    second.source = config.source;
                    if (mode !== 'complete') await backendCache(second, io);
                } finally { await afterRelease(); }
                const binary = `${remoteRoot}/backend-cache/precompiled-fixture/convex-local-backend`;
                assert.equal(execFileSync(binary, [], { encoding: 'utf8' }).trim(), 'local fixture backend');
                proof.contenderSucceeded = true;
                const beforeReuse = received;
                await rm(`${config.source}/.convex`, { recursive: true, force: true });
                const warmRelease = await cacheLock({ ...config, runId: 'cached' }, io);
                try { await backendCache(config, io); } finally { await warmRelease(); }
                assert.equal(received, beforeReuse, 'Valid warm cache must not fetch');
                proof.warmCacheFetches = received - beforeReuse;
            } finally {
                for (const timer of intervals) clearInterval(timer);
                server.closeAllConnections();
                await new Promise(resolve => server.close(resolve));
                await work;
                globalThis.fetch = nativeFetch;
                proof.listenerClosed = await closed(port);
                proof.lockReleased = !await exists(`${remoteRoot}/dependency-cache/.lock`);
                proof.partialDirectories = (await readdir(`${remoteRoot}/backend-cache`))
                    .filter(name => name.startsWith('install-'));
                assert(proof.listenerClosed && proof.lockReleased && proof.partialDirectories.length === 0);
            }
        });
    }
} finally {
    globalThis.fetch = nativeFetch;
    await rm(temporary, { recursive: true, force: true });
    await writeEvidenceFile(`${root}/results.json`, JSON.stringify({ host: hostname(), helper,
        helperSha256: createHash('sha256').update(source).digest('hex'),
        semantics: 'Exact helper module with CLI entry removed; native fetch redirected to a local HTTP fixture server; real zip/unzip and executable shell fixture, not a Convex binary',
        temporary, temporaryRemoved: !await exists(temporary), results }, null, 2));
}
assert(results.every(row => row.result === 'passed'), 'Backend download regressions must pass');
