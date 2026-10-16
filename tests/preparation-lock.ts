import assert from 'node:assert/strict';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { makeEvidenceDirectory, makeEvidenceTemporaryDirectory, writeEvidenceFile } from '../scripts/evidence';

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const events: Record<string, unknown>[] = [];
const modulePath = process.env.PREPARATION_LOCK_MODULE || resolve('scripts/preparation-lock.ts');
async function worker() {
    const { preparationLock } = await import(pathToFileURL(modulePath).href);
    const release = await preparationLock(process.argv[3], JSON.parse(process.argv[4]));
    process.send!({ acquired: true, pid: process.pid });
    try {
        await new Promise<void>((resolve, reject) => process.once('message', message => {
            if (message === 'fail') reject(new Error('Injected preparation failure'));
            else resolve();
        }));
    } finally { await release(); }
}
function start(cache: string, waitMs = 700, graceMs = 200) {
    const child = spawn(process.execPath, ['--import', 'tsx', resolve('tests/preparation-lock.ts'),
        '--worker', cache, JSON.stringify({ waitMs, graceMs, pollMs: 20 })],
    { env: { PATH: process.env.PATH, NODE_ENV: 'test', PREPARATION_LOCK_MODULE: modulePath },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    events.push({ action: 'spawn', pid: child.pid, cache, waitMs, graceMs });
    let output = '';
    let acquired = false;
    child.stdout!.on('data', data => { output += data; });
    child.stderr!.on('data', data => { output += data; });
    child.on('message', () => { acquired = true; events.push({ action: 'acquired', pid: child.pid }); });
    const closed = new Promise<number | null>(resolve => child.once('close', (code, signal) => {
        events.push({ action: 'closed', pid: child.pid, code, signal, output });
        resolve(code);
    }));
    return { child, closed, acquired: () => acquired, output: () => output };
}
type Worker = ReturnType<typeof start>;
const children: Worker[] = [];
function owned(cache: string, waitMs?: number, graceMs?: number) {
    const worker = start(cache, waitMs, graceMs);
    children.push(worker);
    return worker;
}
async function until(check: () => boolean, timeout = 2500) {
    const end = performance.now() + timeout;
    while (!check()) {
        assert(performance.now() < end, 'Preparation did not finish within its bounded test deadline');
        await pause(10);
    }
}
async function stop(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM') {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const stopped = new Promise<void>(resolve => child.once('close', () => resolve()));
    events.push({ action: 'kill', pid: child.pid, signal });
    child.kill(signal);
    await stopped;
}
async function main() {
    const root = `${process.env.EVIDENCE_DIR}/preparation-lock`;
    await makeEvidenceDirectory(root, { recursive: true });
    const directory = await makeEvidenceTemporaryDirectory(`${root}/cases-`);
    const results: Record<string, unknown>[] = [];
    async function check(name: string, work: (cache: string) => Promise<unknown>) {
        const cache = `${directory}/${results.length}`;
        await mkdir(cache);
        try {
            const proof = await work(cache);
            results.push({ name, result: 'passed', proof });
            console.log(`PASS ${name}`);
        } catch (error) {
            results.push({ name, result: 'failed', error: String(error) });
            console.log(`FAIL ${name}: ${error}`);
            process.exitCode = 1;
        } finally {
            for (const worker of children) await stop(worker.child);
        }
    }
    try {
        await check('C35 SIGKILL owner recovers on the next preparation startup', async cache => {
            const first = owned(cache);
            await until(first.acquired);
            await stop(first.child, 'SIGKILL');
            const started = performance.now();
            const second = owned(cache);
            await until(second.acquired);
            second.child.send('release');
            assert.equal(await second.closed, 0, second.output());
            assert(!await access(`${cache}/prepare.lock`).then(() => true, () => false));
            return { killedPid: first.child.pid, elapsedMs: performance.now() - started, recovered: true };
        });
        await check('C35 unchanged ownerless legacy lock recovers after grace', async cache => {
            await mkdir(`${cache}/prepare.lock`);
            const started = performance.now();
            const next = owned(cache);
            await until(next.acquired);
            assert(performance.now() - started >= 200);
            next.child.send('release');
            assert.equal(await next.closed, 0, next.output());
            return { elapsedMs: performance.now() - started };
        });
        await check('C35 live owner remains excluded and the deadline names its identity', async cache => {
            const first = owned(cache);
            await until(first.acquired);
            const next = owned(cache, 350);
            await until(() => next.child.exitCode !== null);
            assert.equal(await next.closed, 1);
            assert(!next.acquired());
            assert(next.output().includes(String(first.child.pid)), next.output());
            first.child.send('release');
            assert.equal(await first.closed, 0);
            return { livePid: first.child.pid, waiterOutput: next.output() };
        });
        await check('C35 two dead-lock waiters have exactly one acquisition', async cache => {
            const killed = owned(cache);
            await until(killed.acquired);
            await stop(killed.child, 'SIGKILL');
            const first = owned(cache, 500);
            const second = owned(cache, 500);
            await until(() => first.acquired() || second.acquired());
            const winner = first.acquired() ? first : second;
            const loser = winner === first ? second : first;
            await until(() => loser.child.exitCode !== null);
            assert(!loser.acquired(), 'A live critical section must never be acquired twice');
            assert.equal(await loser.closed, 1);
            winner.child.send('release');
            assert.equal(await winner.closed, 0);
            return { acquisitions: [first.acquired(), second.acquired()], winnerPid: winner.child.pid };
        });
        await check('C35 a reused PID does not preserve dead preparation ownership', async cache => {
            await mkdir(`${cache}/prepare.lock`);
            await writeFile(`${cache}/prepare.lock/owner.json`, JSON.stringify({ host: hostname(), pid: process.pid,
                startedAt: Date.now(), processStart: 'an earlier process start', token: 'dead-reused-pid' }));
            const next = owned(cache);
            await until(next.acquired);
            next.child.send('release');
            assert.equal(await next.closed, 0);
            return { reusedPid: process.pid, recovered: true };
        });
        await check('C35 a young partial acquisition stays excluded before grace', async cache => {
            await mkdir(`${cache}/prepare.lock`);
            const next = owned(cache, 100, 500);
            await until(() => next.child.exitCode !== null);
            assert.equal(await next.closed, 1);
            assert(!next.acquired());
            assert(await access(`${cache}/prepare.lock`).then(() => true, () => false));
            return { waiterOutput: next.output(), partialPreserved: true };
        });
        await check('C35 a foreign owner is never assumed dead', async cache => {
            await mkdir(`${cache}/prepare.lock`);
            const owner = { host: hostname() + '-other', pid: 2147483647, startedAt: Date.now(),
                processStart: execFileSync('ps', ['-p', String(process.pid), '-o', 'lstart=']).toString().trim(),
                token: 'foreign-owner' };
            await writeFile(`${cache}/prepare.lock/owner.json`, JSON.stringify(owner));
            const next = owned(cache, 100);
            await until(() => next.child.exitCode !== null);
            assert.equal(await next.closed, 1);
            assert(!next.acquired());
            assert.deepEqual(JSON.parse(await readFile(`${cache}/prepare.lock/owner.json`, 'utf8')), owner);
            return { owner, waiterOutput: next.output() };
        });
        await check('C35 an incomplete record with a live PID keeps exclusion', async cache => {
            await mkdir(`${cache}/prepare.lock`);
            const owner = { host: hostname(), pid: process.pid };
            await writeFile(`${cache}/prepare.lock/owner.json`, JSON.stringify(owner));
            const next = owned(cache, 400, 100);
            await until(() => next.child.exitCode !== null);
            assert.equal(await next.closed, 1);
            assert(!next.acquired());
            assert(next.output().includes(String(process.pid)), next.output());
            assert.deepEqual(JSON.parse(await readFile(`${cache}/prepare.lock/owner.json`, 'utf8')), owner);
            return { owner, waiterOutput: next.output() };
        });
        await check('C35 normal failure releases preparation ownership', async cache => {
            const first = owned(cache);
            await until(first.acquired);
            first.child.send('fail');
            assert.equal(await first.closed, 1);
            const next = owned(cache);
            await until(next.acquired);
            next.child.send('release');
            assert.equal(await next.closed, 0);
            assert(!await access(`${cache}/prepare.lock`).then(() => true, () => false));
            return { failure: first.output(), retry: 'acquired' };
        });
        await check('C35 every published acquisition already contains its owner', async cache => {
            const next = owned(cache);
            let published = false;
            const deadline = performance.now() + 2500;
            while (!next.acquired()) {
                assert(performance.now() < deadline, 'Owner publication must finish within the test bound');
                try {
                    const owner = JSON.parse(await readFile(`${cache}/prepare.lock/owner.json`, 'utf8'));
                    assert.equal(owner.pid, next.child.pid);
                    assert(owner.host && owner.processStart && owner.startedAt && owner.token);
                    published = true;
                } catch (error) {
                    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
                }
                await pause(1);
            }
            const owner = JSON.parse(await readFile(`${cache}/prepare.lock/owner.json`, 'utf8'));
            next.child.send('release');
            assert.equal(await next.closed, 0);
            return { published, owner };
        });
    } finally {
        for (const worker of children) await stop(worker.child);
        await rm(directory, { recursive: true, force: true });
        await writeEvidenceFile(`${root}/results.json`, JSON.stringify({ modulePath, results, events,
            childrenClosed: children.every(worker => worker.child.exitCode !== null || worker.child.signalCode !== null),
            directoryRemoved: !await access(directory).then(() => true, () => false) }, null, 2));
    }
}
if (process.argv[2] === '--worker') worker().catch(error => { console.error(error); process.exitCode = 1; });
else main().catch(error => { console.error(error); process.exitCode = 1; });
