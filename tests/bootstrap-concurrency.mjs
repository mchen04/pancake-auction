import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import filesystem, { access, cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { resolve } from 'node:path';
import { makeEvidenceDirectory, makeEvidenceTemporaryDirectory, writeEvidenceFile } from '../scripts/evidence.ts';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const exists = path => access(path).then(() => true, () => false);
const version = 'precompiled-concurrent-fixture';
if (process.env.BOOTSTRAP_CONCURRENCY_WORKER === '1') {
    const selected = process.argv[process.argv.indexOf('--local-backend-version') + 1];
    const binary = `${process.env.AUCTION_CLI_HOME}/.cache/convex/binaries/${selected}/convex-local-backend`;
    globalThis.fetch = async () => {
        process.send({ download: true });
        if (process.env.FIXTURE_OFFLINE === '1') throw new Error('Fixture network blocked');
        return new Response(await readFile(process.env.FIXTURE_ARCHIVE), { status: 200 });
    };
    const originalRemove = filesystem.rm;
    filesystem.rm = async (path, options) => {
        if (path === binary && process.env.PAUSE_BEFORE_REMOVE === '1') {
            process.send({ boundary: 'before-remove' });
            await new Promise(resolve => process.once('message', resolve));
        }
        return originalRemove(path, options);
    };
    const originalRename = filesystem.rename;
    filesystem.rename = async (source, destination) => {
        if (destination.endsWith('/publish.lock')) process.send({ lockAttempt: true });
        return originalRename(source, destination);
    };
    const originalStat = filesystem.lstat;
    let inspected = false;
    filesystem.lstat = async (...args) => {
        if (args[0].endsWith('/publish.lock') && !inspected) {
            inspected = true; process.send({ lockInspection: true });
        }
        return originalStat(...args);
    };
    syncBuiltinESMExports();
} else {
    const root = `${process.env.EVIDENCE_DIR}/bootstrap-concurrency`;
    await makeEvidenceDirectory(root, { recursive: true });
    const temporary = await makeEvidenceTemporaryDirectory(`${root}/cases-`);
    const children = [], results = [];
    const fixture = '#!/bin/sh\nprintf "%s\\n" isolated-fixture-key\n' + ' '.repeat(2048) + '\n';
    const archiveRoot = `${temporary}/archive`;
    await mkdir(archiveRoot);
    await writeFile(`${archiveRoot}/convex-local-backend`, fixture, { mode: 0o700 });
    const archive = `${temporary}/backend.zip`;
    execFileSync('/usr/bin/zip', ['-q', archive, 'convex-local-backend'], { cwd: archiveRoot });
    async function until(check, bound = 5000) {
        const deadline = performance.now() + bound;
        while (!check()) {
            assert(performance.now() < deadline, 'Child did not reach the fixture boundary');
            await pause(10);
        }
    }
    function start(project, home, options = {}) {
        const child = spawn(process.execPath, ['--import', import.meta.filename,
            '--import', `${project}/scripts/local-cli.mjs`, '-e', 'process.send({prepared:true})', '--',
            'dev', '--local-cloud-port', '0', '--local-site-port', '0',
            '--local-backend-version', options.version || version],
        { cwd: project, env: { PATH: process.env.PATH, AUCTION_CLI_HOME: home,
            BOOTSTRAP_CONCURRENCY_WORKER: '1', FIXTURE_ARCHIVE: archive,
            FIXTURE_OFFLINE: options.offline ? '1' : '0', PAUSE_BEFORE_REMOVE: options.paused ? '1' : '0' },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
        let output = '', complete = false;
        const events = [];
        child.stdout.on('data', data => { output += data; });
        child.stderr.on('data', data => { output += data; });
        child.on('message', message => events.push(message));
        const watchdog = setTimeout(() => child.kill('SIGKILL'), 75000);
        const closed = new Promise(resolve => child.once('close', (code, signal) => {
            clearTimeout(watchdog); complete = true;
            resolve({ code, signal, pid: child.pid, output, events,
                downloads: events.filter(event => event.download).length });
        }));
        const record = { child, closed, events, complete: () => complete };
        children.push(record);
        return record;
    }
    async function stop(worker) {
        if (!worker.complete()) worker.child.kill('SIGKILL');
        return worker.closed;
    }
    async function check(name, work) {
        const firstChild = children.length;
        const base = `${temporary}/${results.length}`, project = `${base}/source`, home = `${base}/home`;
        await mkdir(`${project}/scripts`, { recursive: true }); await mkdir(home);
        for (const name of ['local-bootstrap.mjs', 'local-cli.mjs', 'preparation-lock.ts', 'evidence.ts']) {
            await cp(resolve(process.env.BOOTSTRAP_SOURCE_DIRECTORY || 'scripts', name), `${project}/scripts/${name}`);
        }
        await writeFile(`${project}/package.json`, JSON.stringify({ type: 'module' }));
        const cache = `${home}/.cache/convex/binaries/${version}`, binary = `${cache}/convex-local-backend`;
        const proof = {};
        try {
            await work({ base, project, home, cache, binary, proof });
            const leftovers = (await readdir(base, { recursive: true })).filter(name =>
                /(?:publish\.lock(?:[/.]|$)|download-)/.test(name));
            assert.deepEqual(leftovers, [], 'No owned lock, candidate, retired directory or download remains');
            results.push({ name, result: 'passed', proof, leftovers }); console.log(`PASS ${name}`);
        } catch (error) {
            results.push({ name, result: 'failed', error: String(error), proof });
            console.log(`FAIL ${name}: ${error}`); process.exitCode = 1;
        } finally {
            for (const worker of children.slice(firstChild)) await stop(worker);
            proof.children = await Promise.all(children.slice(firstChild).map(worker => worker.closed));
            await writeEvidenceFile(`${root}/results.json`, JSON.stringify({ results }, null, 2));
        }
    }
    try {
        await check('C41 delayed missing inspection cannot delete a concurrent publication',
            async ({ project, home, binary, proof }) => {
                const delayed = start(project, home, { paused: true, offline: true });
                await until(() => delayed.events.some(event => event.boundary));
                const publisher = start(project, home);
                await until(() => publisher.events.length > 0 || publisher.complete());
                await pause(400);
                proof.publisherFinishedBeforeRelease = publisher.complete();
                if (publisher.complete()) {
                    proof.publishedBeforeRelease = await exists(binary);
                    proof.warmBeforeRelease = await start(project, home, { offline: true }).closed;
                }
                delayed.child.send('continue');
                proof.delayed = await delayed.closed;
                proof.publisher = await publisher.closed;
                proof.retained = await readFile(binary, 'utf8').then(value => value === fixture, () => false);
                proof.offlineRestart = await start(project, home, { offline: true }).closed;
                assert.equal(proof.publisher.code, 0, proof.publisher.output);
                assert(proof.retained, 'A stale missing-cache decision must not remove a valid publication');
                assert.equal(proof.offlineRestart.code, 0, proof.offlineRestart.output);
                assert.equal(proof.offlineRestart.downloads, 0);
                assert.equal(proof.publisherFinishedBeforeRelease, false, 'Publisher must wait for inspection owner');
            });
        await check('C41 concurrent direct preloads share one cold download and one configuration',
            async ({ project, home, binary, proof }) => {
                const first = start(project, home, { paused: true });
                await until(() => first.events.some(event => event.boundary));
                const second = start(project, home);
                await until(() => second.events.length > 0 || second.complete());
                await pause(200); first.child.send('continue');
                proof.callers = await Promise.all([first.closed, second.closed]);
                assert(proof.callers.every(result => result.code === 0), JSON.stringify(proof.callers));
                assert.equal(proof.callers.reduce((sum, result) => sum + result.downloads, 0), 1);
                assert.equal(await readFile(binary, 'utf8'), fixture);
                proof.warm = await start(project, home, { offline: true }).closed;
                assert.equal(proof.warm.code, 0, proof.warm.output); assert.equal(proof.warm.downloads, 0);
            });
        await check('C41 definite invalid cache is replaced under the common lock',
            async ({ project, home, cache, binary, proof }) => {
                await mkdir(cache, { recursive: true });
                await writeFile(binary, '#!/bin/sh\nexit 1\n' + ' '.repeat(2048), { mode: 0o700 });
                proof.repaired = await start(project, home).closed;
                assert.equal(proof.repaired.code, 0, proof.repaired.output); assert.equal(proof.repaired.downloads, 1);
                assert.equal(await readFile(binary, 'utf8'), fixture);
            });
        await check('C41 inconclusive validation retains the cache and releases the common lock',
            async ({ project, home, cache, binary, proof }) => {
                await mkdir(cache, { recursive: true });
                const inconclusive = '#!/bin/sh\nkill -KILL $$\n' + ' '.repeat(2048);
                await writeFile(binary, inconclusive, { mode: 0o700 });
                proof.failed = await start(project, home, { offline: true }).closed;
                assert.equal(proof.failed.code, 1); assert.equal(proof.failed.downloads, 0);
                assert(proof.failed.output.includes('Could not validate cached backend; try again.'), proof.failed.output);
                assert.equal(await readFile(binary, 'utf8'), inconclusive);
                await writeFile(binary, fixture, { mode: 0o700 });
                proof.retry = await start(project, home, { offline: true }).closed;
                assert.equal(proof.retry.code, 0, proof.retry.output); assert.equal(proof.retry.downloads, 0);
            });
        await check('C41 different cache versions and homes do not block each other',
            async ({ base, project, home, proof }) => {
                const held = start(project, home, { paused: true });
                await until(() => held.events.some(event => event.boundary));
                const otherVersionProject = `${base}/other-version`, otherHomeProject = `${base}/other-home`;
                await cp(project, otherVersionProject, { recursive: true });
                await cp(project, otherHomeProject, { recursive: true });
                const differentVersion = start(otherVersionProject, home, { version: `${version}-other` });
                const differentHome = start(otherHomeProject, `${base}/separate-home`);
                await until(() => differentVersion.complete() && differentHome.complete());
                proof.differentVersion = await differentVersion.closed; proof.differentHome = await differentHome.closed;
                assert.equal(proof.differentVersion.code, 0, proof.differentVersion.output);
                assert.equal(proof.differentHome.code, 0, proof.differentHome.output);
                assert(!held.complete()); held.child.send('continue');
                proof.held = await held.closed; assert.equal(proof.held.code, 0, proof.held.output);
            });
        await check('C41 SIGKILLed common-lock owner recovers promptly', async ({ project, home, proof }) => {
            const held = start(project, home, { paused: true });
            await until(() => held.events.some(event => event.boundary));
            proof.killed = await stop(held); assert.equal(proof.killed.signal, 'SIGKILL');
            const started = performance.now(); proof.retry = await start(project, home).closed;
            proof.elapsedMs = performance.now() - started;
            assert.equal(proof.retry.code, 0, proof.retry.output); assert(proof.elapsedMs < 5000);
        });
        await check('C41 ownerless common lock recovers after bounded grace', async ({ project, home, cache, proof }) => {
            await mkdir(`${cache}/publish.lock`, { recursive: true });
            const started = performance.now(); proof.retry = await start(project, home).closed;
            proof.elapsedMs = performance.now() - started;
            assert.equal(proof.retry.code, 0, proof.retry.output);
            assert(proof.elapsedMs >= 1000 && proof.elapsedMs < 5000);
        });
        await check('C41 live common-lock owner is excluded until the production deadline',
            async ({ project, home, proof }) => {
                const held = start(project, home, { paused: true });
                await until(() => held.events.some(event => event.boundary));
                const started = performance.now(); proof.waiter = await start(project, home).closed;
                proof.elapsedMs = performance.now() - started;
                assert.equal(proof.waiter.code, 1); assert.equal(proof.waiter.downloads, 0);
                assert(proof.waiter.output.includes('Local Convex binary preparation is still owned'), proof.waiter.output);
                assert(proof.waiter.output.includes(`"pid":${held.child.pid}`), proof.waiter.output);
                assert(proof.elapsedMs >= 60000 && proof.elapsedMs < 68000);
                held.child.send('continue'); proof.holder = await held.closed;
                assert.equal(proof.holder.code, 0, proof.holder.output);
            });
    } finally {
        for (const worker of children) await stop(worker);
        await rm(temporary, { recursive: true, force: true });
        await writeEvidenceFile(`${root}/results.json`, JSON.stringify({ results,
            semantics: 'Real child direct preloads, fixture fetches and executables, real zip/unzip; injected rm pause',
            childrenClosed: children.every(worker => worker.complete()), directoryRemoved: !await exists(temporary) }, null, 2));
    }
}
