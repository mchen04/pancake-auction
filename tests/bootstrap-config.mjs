import assert from 'node:assert/strict';
import filesystem, { access, cp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { makeEvidenceDirectory, makeEvidenceTemporaryDirectory, writeEvidenceFile } from '../scripts/evidence.ts';
import { captureGroup, stopGroup } from '../scripts/process-group.ts';

const version = 'precompiled-2026-10-06-a3538c6';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const digest = value => createHash('sha256').update(value).digest('hex');
if (process.env.CONFIG_INTERRUPT === '1') {
    const original = filesystem.writeFile;
    filesystem.writeFile = async (path, data, options) => {
        if (path === process.env.CONFIG_TARGET || String(path).includes(`/.config-${version}-`)) {
            await original(path, '{"deploymentName":', options);
            process.send({ boundary: true });
            await new Promise(() => setInterval(() => {}, 1000));
        }
        return original(path, data, options);
    };
    syncBuiltinESMExports();
} else {
    const root = `${process.env.EVIDENCE_DIR}/bootstrap-config`;
    await makeEvidenceDirectory(root, { recursive: true });
    const directory = await makeEvidenceTemporaryDirectory(`${root}/source-`);
    const children = [], results = [];
    async function until(check, bound = 15000) {
        const deadline = performance.now() + bound;
        while (!await check()) { assert(performance.now() < deadline, 'Isolated CLI did not become ready'); await pause(50); }
    }
    try {
        for (const name of ['scripts', 'convex', 'lib', 'league']) await cp(name, `${directory}/${name}`, { recursive: true });
        if (process.env.CONFIG_BOOTSTRAP_SOURCE) {
            await cp(process.env.CONFIG_BOOTSTRAP_SOURCE, `${directory}/scripts/local-bootstrap.mjs`);
        }
        await cp('package.json', `${directory}/package.json`);
        await symlink(resolve('node_modules'), `${directory}/node_modules`, 'dir');
        await mkdir(`${directory}/tests`);
        await cp('tests/backend-fetch.mjs', `${directory}/tests/backend-fetch.mjs`);
        const home = `${directory}/cli-home`;
        await mkdir(`${home}/.cache`, { recursive: true });
        await symlink(resolve('.convex/backend-binary-cache'), `${home}/.cache/convex`, 'dir');
        const { createServer, createConnection } = await import('node:net');
        async function free() {
            const server = createServer();
            await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
            const port = server.address().port;
            await new Promise(resolve => server.close(resolve));
            assert(![3100,3210,3211,3220,3221,3917].includes(port)); return port;
        }
        const port = await free(), sitePort = await free();
        const configuration = `${directory}/.convex/local/default/config.json`;
        const args = ['dev', '--local-cloud-port', String(port), '--local-site-port', String(sitePort),
            '--local-backend-version', version, '--typecheck', 'disable', '--codegen', 'disable'];
        function start(name, interrupt = false, prepareOnly = false) {
            const log = `${root}/${name}-network.jsonl`;
            const child = spawn(process.execPath, ['--import', `${directory}/tests/backend-fetch.mjs`,
                ...(interrupt ? ['--import', import.meta.filename] : []),
                '--import', `${directory}/scripts/local-cli.mjs`,
                ...(prepareOnly ? ['-e', '', '--'] : [`${directory}/node_modules/convex/bin/main.js`]), ...args],
            { cwd: directory, detached: true, env: { PATH: process.env.PATH, NODE_ENV: 'test',
                AUCTION_CLI_HOME: home, CONVEX_AGENT_MODE: 'anonymous', CONVEX_DISABLE_TELEMETRY: '1',
                AUCTION_NETWORK_LOG: log, TMPDIR: directory,
                ...(interrupt ? { CONFIG_INTERRUPT: '1', CONFIG_TARGET: configuration } : {}) },
            stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
            const group = captureGroup(child.pid);
            let boundary = false, output = '';
            child.on('message', message => { if (message.boundary) boundary = true; });
            child.stdout.on('data', data => { output += data; });
            child.stderr.on('data', data => { output += data; });
            const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
            const worker = { child, group, closed, log, boundary: () => boundary, output: () => output };
            children.push(worker); return worker;
        }
        async function requests(worker) {
            return (await readFile(worker.log, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(JSON.parse);
        }
        async function listening(value) {
            return new Promise(resolve => {
                const socket = createConnection({ host: '127.0.0.1', port: value });
                socket.once('connect', () => { socket.destroy(); resolve(true); });
                socket.once('error', error => { socket.destroy(); resolve(error.code !== 'ECONNREFUSED'); });
                socket.setTimeout(500, () => { socket.destroy(); resolve(true); });
            });
        }
        async function check(name, work) {
            const proof = {};
            try { await work(proof); results.push({ name, result: 'passed', proof }); console.log(`PASS ${name}`); }
            catch (error) {
                results.push({ name, result: 'failed', error: String(error), proof });
                console.log(`FAIL ${name}: ${error}`); process.exitCode = 1;
            }
            for (const worker of children) await stopGroup(worker.group, 'SIGINT');
            assert.equal(await listening(port), false); assert.equal(await listening(sitePort), false);
            await writeEvidenceFile(`${root}/results.json`, JSON.stringify(results, null, 2));
        }
        await check('C43 killed configuration writer recovers offline through the installed CLI', async proof => {
            const writer = start('interrupted', true, true);
            await until(writer.boundary);
            writer.child.kill('SIGKILL'); proof.writer = await writer.closed;
            assert.equal(proof.writer.signal, 'SIGKILL');
            proof.partialFinal = await readFile(configuration, 'utf8').then(text => {
                try { JSON.parse(text); return false; } catch { return true; }
            }, () => false);
            const restart = start('restart');
            try {
                await until(async () => {
                    const logs = await requests(restart);
                    if (logs.some(row => row.kind === 'backend-version')) return true;
                    return listening(port);
                });
                proof.requests = await requests(restart); proof.listenerStarted = await listening(port);
                proof.latestLookup = proof.requests.some(row => row.kind === 'backend-version');
                assert.equal(proof.latestLookup, false, 'Recovery must not request a latest backend version');
                assert.equal(proof.listenerStarted, true);
                const value = JSON.parse(await readFile(configuration, 'utf8'));
                assert.equal(value.backendVersion, version);
                assert.equal((await stat(configuration)).mode & 0o777, 0o600);
            } finally { await stopGroup(restart.group, 'SIGINT'); }
        });
        await check('C43 complete configuration is reused byte-for-byte without a version lookup', async proof => {
            await rm(`${directory}/.convex/local`, { recursive: true, force: true });
            const prepare = start('complete-prepare', false, true);
            assert.equal((await prepare.closed).code, 0);
            const before = await readFile(configuration);
            const reuse = start('complete-reuse', false, true);
            assert.equal((await reuse.closed).code, 0);
            proof.unchanged = digest(before) === digest(await readFile(configuration));
            assert(proof.unchanged);
            const restart = start('complete-restart');
            try {
                await until(() => listening(port));
                proof.cliIdentityUnchanged = isDeepStrictEqual(JSON.parse(before), JSON.parse(await readFile(configuration)));
                proof.requests = await requests(restart);
                assert(proof.cliIdentityUnchanged);
                assert(!proof.requests.some(row => row.kind === 'backend-version'));
            } finally { await stopGroup(restart.group, 'SIGINT'); }
        });
        await check('C43 abandoned configuration temporary files are removed under the lock', async proof => {
            const state = `${directory}/.convex/local/default`;
            await writeFile(`${state}/.config-${version}-abandoned`, '{');
            const prepare = start('temporary-cleanup', false, true);
            assert.equal((await prepare.closed).code, 0);
            proof.temporaryFiles = (await readdir(state)).filter(name => name.startsWith('.config-'));
            assert.deepEqual(proof.temporaryFiles, []);
        });
    } finally {
        for (const worker of children) await stopGroup(worker.group, 'SIGINT');
        await rm(directory, { recursive: true, force: true });
        await writeEvidenceFile(`${root}/cleanup.json`, JSON.stringify({ directory,
            directoryRemoved: !await access(directory).then(() => true, () => false),
            groups: children.map(worker => worker.group) }, null, 2));
    }
}
