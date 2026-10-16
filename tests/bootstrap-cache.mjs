import assert from 'node:assert/strict';
import childProcesses, { spawn, execFileSync } from 'node:child_process';
import filesystem, { access, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { syncBuiltinESMExports } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { makeEvidenceDirectory, makeEvidenceTemporaryDirectory, writeEvidenceFile } from '../scripts/evidence.ts';

const modulePath = process.env.BOOTSTRAP_MODULE || resolve('scripts/local-bootstrap.mjs');
const version = 'precompiled-cache-fixture';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const exists = path => access(path).then(() => true, () => false);
if (process.argv[2] === '--worker') {
    const [project, home, archive, fault] = process.argv.slice(3);
    process.chdir(project);
    process.env.AUCTION_CLI_HOME = home;
    globalThis.fetch = async () => {
        process.send({ download: true });
        if (['offline', 'spawn-resource'].includes(fault)) throw new Error('Fixture network blocked');
        return new Response(await readFile(archive), { status: 200 });
    };
    if (fault === 'spawn-resource') {
        const original = childProcesses.execFile;
        const execute = promisify(original);
        const replacement = (...args) => original(...args);
        replacement[promisify.custom] = (file, ...args) => {
            if (file.endsWith('/convex-local-backend')) {
                return Promise.reject(Object.assign(new Error('Injected spawn capacity failure'), { code: 'EAGAIN' }));
            }
            return execute(file, ...args);
        };
        childProcesses.execFile = replacement;
        syncBuiltinESMExports();
    }
    if (fault === 'publication') {
        const originalCopy = filesystem.copyFile;
        filesystem.copyFile = async (source, destination, flags) => {
            if (destination.endsWith('/convex-local-backend')) {
                await writeFile(destination, (await readFile(source)).subarray(0, 4), { mode: 0o700 });
                process.send({ boundary: 'final-copy' });
                await new Promise(() => setInterval(() => {}, 1000));
            }
            return originalCopy(source, destination, flags);
        };
        const originalRename = filesystem.rename;
        filesystem.rename = async (source, destination) => {
            if (destination.endsWith('/convex-local-backend')) {
                process.send({ boundary: 'validated-before-rename' });
                await new Promise(() => setInterval(() => {}, 1000));
            }
            return originalRename(source, destination);
        };
        syncBuiltinESMExports();
    }
    try {
        const { preparePinnedDeployment } = await import(pathToFileURL(modulePath));
        await preparePinnedDeployment(version);
        process.send({ prepared: true });
    } catch (error) { console.error(error.message); process.exitCode = 1; }
} else {
    const root = `${process.env.EVIDENCE_DIR}/bootstrap-cache`;
    await makeEvidenceDirectory(root, { recursive: true });
    const temporary = await makeEvidenceTemporaryDirectory(`${root}/cases-`);
    const results = [];
    const children = [];
    const fixture = '#!/bin/sh\nprintf "%s\\n" isolated-fixture-key\n' + '#'.repeat(2048) + '\n';
    const archiveRoot = `${temporary}/archive`;
    await mkdir(archiveRoot);
    await writeFile(`${archiveRoot}/convex-local-backend`, fixture, { mode: 0o700 });
    const archive = `${temporary}/backend.zip`;
    execFileSync('/usr/bin/zip', ['-q', archive, 'convex-local-backend'], { cwd: archiveRoot });
    function start(project, home, fault = '') {
        const child = spawn(process.execPath, [import.meta.filename, '--worker', project, home, archive, fault],
            { env: { PATH: process.env.PATH, BOOTSTRAP_MODULE: modulePath }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
        let output = '', downloads = 0, boundary;
        child.stdout.on('data', data => { output += data; });
        child.stderr.on('data', data => { output += data; });
        child.on('message', message => { if (message.download) downloads++; if (message.boundary) boundary = message.boundary; });
        const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
        const closed = new Promise(resolve => child.once('close', (code, signal) => {
            clearTimeout(timer); resolve({ code, signal, output, downloads, boundary });
        }));
        const record = { child, closed, boundary: () => boundary };
        children.push(record);
        return record;
    }
    async function check(name, work) {
        const base = `${temporary}/${results.length}`;
        const project = `${base}/project`, home = `${base}/home`;
        await mkdir(project, { recursive: true }); await mkdir(home);
        const cache = `${home}/.cache/convex/binaries/${version}`;
        const binary = `${cache}/convex-local-backend`;
        try {
            const proof = await work({ project, home, cache, binary });
            const leftovers = (await readdir(home, { recursive: true })).filter(name =>
                name.includes('download-') || name.includes('prepare-'));
            assert.deepEqual(leftovers, [], 'Preparation must not leave temporary files');
            results.push({ name, result: 'passed', proof, leftovers }); console.log(`PASS ${name}`);
        } catch (error) {
            results.push({ name, result: 'failed', error: String(error) });
            console.log(`FAIL ${name}: ${error}`); process.exitCode = 1;
        }
    }
    try {
        await check('C38 cold publication validates and warm reuse never fetches', async ({ project, home, binary }) => {
            const cold = await start(project, home).closed;
            assert.equal(cold.code, 0, cold.output); assert.equal(cold.downloads, 1);
            assert.equal(await readFile(binary, 'utf8'), fixture);
            await rm(`${project}/.convex`, { recursive: true });
            const warm = await start(project, home, 'offline').closed;
            assert.equal(warm.code, 0, warm.output); assert.equal(warm.downloads, 0);
            return { cold, warm };
        });
        await check('C38 SIGKILL at publication recovers on the next attempt', async ({ project, home, binary }) => {
            const interrupted = start(project, home, 'publication');
            const end = performance.now() + 5000;
            while (!interrupted.boundary()) { assert(performance.now() < end, 'Publication boundary reached'); await pause(10); }
            interrupted.child.kill('SIGKILL');
            const killed = await interrupted.closed;
            assert.equal(killed.signal, 'SIGKILL');
            const retry = await start(project, home).closed;
            assert.equal(retry.code, 0, retry.output); assert.equal(await readFile(binary, 'utf8'), fixture);
            return { killed, retry };
        });
        for (const executable of [true, false]) {
            await check(`C38 ${executable ? 'executable' : 'non-executable'} fragment recovers`,
                async ({ project, home, cache, binary }) => {
                    await mkdir(cache, { recursive: true });
                    await writeFile(binary, '#!/b', { mode: executable ? 0o700 : 0o600 });
                    const retry = await start(project, home).closed;
                    assert.equal(retry.code, 0, retry.output); assert.equal(retry.downloads, 1);
                    assert.equal(await readFile(binary, 'utf8'), fixture); return retry;
                });
        }
        await check('C38 full-size executable failing validation is replaced', async ({ project, home, cache, binary }) => {
            await mkdir(cache, { recursive: true });
            await writeFile(binary, '#!/bin/sh\nexit 1\n' + '#'.repeat(2048), { mode: 0o700 });
            const retry = await start(project, home).closed;
            assert.equal(retry.code, 0, retry.output); assert.equal(retry.downloads, 1); return retry;
        });
        await check('Inconclusive cached validation timeout preserves the binary without fetching',
            async ({ project, home, cache, binary }) => {
                await mkdir(cache, { recursive: true });
                const marker = `${home}/validation-started`;
                const code = `const fs=require('node:fs');const marker=${JSON.stringify(marker)};
                    const print=()=>process.stdout.write('isolated-fixture-key');
                    if(fs.existsSync(marker))print();else{fs.writeFileSync(marker,'started');setTimeout(print,6000)}`;
                const quote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'";
                const slow = `#!/bin/sh\nexec ${quote(process.execPath)} -e ${quote(code)}\n` + ' '.repeat(2048);
                await writeFile(binary, slow, { mode: 0o700 });
                const started = performance.now();
                const first = await start(project, home, 'offline').closed;
                const observed = { first, elapsedMs: performance.now() - started,
                    binaryPreserved: await readFile(binary, 'utf8').then(value => value === slow, () => false) };
                await writeEvidenceFile(`${root}/validation-timeout.json`, JSON.stringify(observed, null, 2));
                assert(observed.binaryPreserved, 'Inconclusive validation must preserve the cached binary');
                assert.equal(first.code, 1); assert.equal(first.downloads, 0);
                assert(first.output.includes('Could not validate cached backend; try again.'), first.output);
                assert(observed.elapsedMs >= 5000 && observed.elapsedMs < 8000);
                const retry = await start(project, home, 'offline').closed;
                assert.equal(retry.code, 0, retry.output); assert.equal(retry.downloads, 0);
                assert.equal(await readFile(binary, 'utf8'), slow);
                return { ...observed, retry };
            });
        await check('Inconclusive signal-killed cached validation preserves the binary without fetching',
            async ({ project, home, cache, binary }) => {
                await mkdir(cache, { recursive: true });
                const code = "process.kill(process.pid,'SIGKILL')";
                const killed = `#!/bin/sh\nexec "${process.execPath}" -e "${code}"\n` + ' '.repeat(2048);
                await writeFile(binary, killed, { mode: 0o700 });
                const failed = await start(project, home, 'offline').closed;
                assert.equal(await readFile(binary, 'utf8').catch(() => null), killed);
                assert.equal(failed.code, 1); assert.equal(failed.downloads, 0);
                assert(failed.output.includes('Could not validate cached backend; try again.'), failed.output);
                return failed;
            });
        await check('Inconclusive injected EAGAIN preserves the binary without fetching',
            async ({ project, home, cache, binary }) => {
                await mkdir(cache, { recursive: true }); await writeFile(binary, fixture, { mode: 0o700 });
                const failed = await start(project, home, 'spawn-resource').closed;
                assert.equal(await readFile(binary, 'utf8').catch(() => null), fixture);
                assert.equal(failed.code, 1); assert.equal(failed.downloads, 0);
                assert(failed.output.includes('Could not validate cached backend; try again.'), failed.output);
                const retry = await start(project, home, 'offline').closed;
                assert.equal(retry.code, 0, retry.output); assert.equal(retry.downloads, 0);
                return { failed, retry, semantics: 'Injected execFile EAGAIN; actual bootstrap and real cached file' };
            });
        await check('Definite empty-output validation still replaces the cached binary',
            async ({ project, home, cache, binary }) => {
                await mkdir(cache, { recursive: true });
                await writeFile(binary, '#!/bin/sh\nexit 0\n' + ' '.repeat(2048), { mode: 0o700 });
                const retry = await start(project, home).closed;
                assert.equal(retry.code, 0, retry.output); assert.equal(retry.downloads, 1);
                assert.equal(await readFile(binary, 'utf8'), fixture); return retry;
            });
        await check('C38 impossible recovery fails clearly within its bound', async ({ project, home, cache, binary }) => {
            await mkdir(cache, { recursive: true }); await writeFile(binary, '#!/b', { mode: 0o600 });
            const started = performance.now();
            const failed = await start(project, home, 'offline').closed;
            assert.equal(failed.code, 1); assert(failed.output.includes('is not cached and cannot be downloaded'), failed.output);
            assert(performance.now() - started < 5000); return { ...failed, elapsedMs: performance.now() - started };
        });
    } finally {
        for (const { child, closed } of children) {
            if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
            await closed;
        }
        await rm(temporary, { recursive: true, force: true });
        await writeEvidenceFile(`${root}/results.json`, JSON.stringify({ modulePath, results,
            childrenClosed: children.every(({ child }) => child.exitCode !== null || child.signalCode !== null),
            directoryRemoved: !await exists(temporary), semantics: 'Real unzip, fixture fetch, real SIGKILL at injected publication boundary' }, null, 2));
    }
}
