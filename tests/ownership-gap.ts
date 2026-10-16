import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { readFile, access, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { makeEvidenceDirectory, writeEvidenceFile, repositoryDirectory } from '../scripts/evidence';
import { spawnOwnedProcess, stopOwnedProcess, ownedProcessGroup, ownedCommandPid } from '../scripts/resources';
import { captureGroup, refreshGroup, stopGroup } from '../scripts/process-group';
import { localBackend, portListening, requireClosedPort, sleep } from '../scripts/local-backend';
import { preparationLock } from '../scripts/preparation-lock';

const root = `${process.env.EVIDENCE_DIR}/ownership-gap`;
const results: Record<string, unknown>[] = [];
async function until(check: () => boolean, limit = 5000) {
    const end = performance.now() + limit;
    while (!check()) { assert(performance.now() < end, 'Fixture condition timed out'); await sleep(20); }
}
async function check(name: string, run: (proof: Record<string, unknown>) => Promise<void>) {
    const proof: Record<string, unknown> = {};
    try { await run(proof); results.push({ name, result: 'passed', proof }); console.log(`PASS ${name}`); }
    catch (error) {
        results.push({ name, result: 'failed', error: String(error), proof });
        console.log(`FAIL ${name}: ${error}`); process.exitCode = 1;
    }
    await writeEvidenceFile(`${root}/results.json`, JSON.stringify(results, null, 2));
}
async function fastParent(proof: Record<string, unknown>) {
    const leaf = `setTimeout(()=>{const s=require('node:net').createServer();
        s.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({pid:process.pid,port:s.address().port})));},250);`;
    const parent = `process.once('message',()=>{require('node:child_process').spawn(process.execPath,
        ['-e',${JSON.stringify(leaf)}],{stdio:['ignore','inherit','inherit']});process.exit(0)});`;
    const signalListeners = ['SIGTERM', 'SIGINT'].map(signal => process.listenerCount(signal));
    const child = spawnOwnedProcess(process.execPath, ['-e', parent],
        { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    const group = ownedProcessGroup(child)!;
    let member: { pid: number; port: number } | undefined;
    child.stdout!.on('data', data => { member = JSON.parse(String(data).trim()); });
    try {
        child.send!('go');
        await until(() => Boolean(member));
        proof.commandExitBeforeListener = child.exitCode;
        proof.commandPid = ownedCommandPid(child);
        proof.anchor = { pid: group.pid, processStart: group.processStart };
        proof.member = member;
        assert.equal(child.exitCode, 0);
        refreshGroup(group);
        assert(await portListening(member!.port));
        await stopOwnedProcess(child); await stopOwnedProcess(child);
        await requireClosedPort(member!.port);
        proof.group = group; proof.listenerAfterClose = await portListening(member!.port);
        assert.equal(proof.listenerAfterClose, false); assert(group.closed);
        proof.parentSignalListenersUnchanged = ['SIGTERM', 'SIGINT'].map(signal => process.listenerCount(signal));
        assert.deepEqual(proof.parentSignalListenersUnchanged, signalListeners);
    } finally { await stopGroup(group); }
}
async function relay(proof: Record<string, unknown>) {
    const child = spawnOwnedProcess(process.execPath, ['-e',
        "let input='';process.stdin.on('data',data=>input+=data);process.stdin.on('end',()=>{"
        + "process.stdout.write('out:'+input);process.stderr.write('err');process.exitCode=7})"],
    { stdio: ['pipe', 'pipe', 'pipe'] });
    const group = ownedProcessGroup(child)!;
    let output = '', error = '';
    child.stdout!.on('data', data => { output += String(data); });
    child.stderr!.on('data', data => { error += String(data); });
    try {
        let closed = false;
        child.once('close', () => { closed = true; });
        child.stdin!.end('input');
        await until(() => closed);
        const code = child.exitCode;
        Object.assign(proof, { code, output, error });
        assert.equal(code, 7); assert.equal(child.exitCode, 7);
        assert.equal(output, 'out:input'); assert.equal(error, 'err');
    } finally { await stopOwnedProcess(child); proof.group = group; }
}
async function stalledRelease(proof: Record<string, unknown>) {
    const child = spawnOwnedProcess(process.execPath, ['-e', ''], { stdio: 'ignore' });
    const group = ownedProcessGroup(child)!;
    await until(() => child.exitCode !== null);
    const release = group.releaseAnchor!;
    let unblock: () => void = () => {};
    const delayed = new Promise<void>(resolve => { unblock = resolve; });
    group.releaseAnchor = () => delayed;
    let settled = false;
    const started = performance.now();
    const stopping = stopOwnedProcess(child).finally(() => { settled = true; });
    try {
        await Promise.race([stopping, sleep(4000)]);
        proof.settledWithinBound = settled; proof.elapsedMs = performance.now() - started;
        assert(settled, 'A stalled release acknowledgement must not defeat the group deadline');
        assert(group.closed);
    } finally {
        group.releaseAnchor = release; unblock();
        await stopping; await stopGroup(group); proof.group = group;
    }
}
async function identityControl(kind: 'uncertain' | 'reused', proof: Record<string, unknown>) {
    const child = spawnOwnedProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    const group = ownedProcessGroup(child)!;
    await until(() => Boolean(ownedCommandPid(child)));
    const original = { processStart: group.processStart, members: group.members };
    const kill = process.kill;
    let signals = 0;
    process.kill = ((pid, signal) => {
        if (pid === -group.pgid && signal !== 0) { signals++; throw new Error('Unsafe signal'); }
        return kill(pid, signal);
    }) as typeof process.kill;
    try {
        if (kind === 'reused') group.processStart = 'different process start';
        else group.members = [];
        await assert.rejects(stopOwnedProcess(child), /uncertain|identity changed/);
        proof.signals = signals; assert.equal(signals, 0);
    } finally {
        process.kill = kill; Object.assign(group, original); await stopGroup(group);
        proof.cleanedAfterRestoringTrustedIdentity = group.closed;
    }
}
async function failedGroup(proof: Record<string, unknown>) {
    const spawn = childProcess.spawn;
    const kill = process.kill;
    const workers: { role: string; group: ReturnType<typeof captureGroup>; directory: string }[] = [];
    const ports: number[] = [];
    let leafPort: number | undefined;
    const config = { deploymentName: 'anonymous-c48-fixture', backendVersion: 'fixture',
        adminKey: 'fixture-only-key', instanceSecret: 'fixture-only-secret' };
    childProcess.spawn = new Proxy(spawn, {
        apply(target, receiver, values: Parameters<typeof childProcess.spawn>) {
            const [command, outerArgs, options] = values;
            if (!Array.isArray(outerArgs) || !outerArgs[0]?.endsWith('/command-anchor.mjs')) {
                return Reflect.apply(target, receiver, values);
            }
            const actual = outerArgs[1], args = outerArgs.slice(2);
            let role: string, code: string;
            if (args.includes('--local-backend-version')) {
                role = 'bootstrap';
                code = `const f=require('node:fs');f.mkdirSync('.convex/local/default',{recursive:true});
                    f.writeFileSync('.convex/local/default/config.json',${JSON.stringify(JSON.stringify(config))});`;
            } else if (actual.endsWith('/convex-local-backend')) {
                role = 'backend';
                ports.push(Number(args[args.indexOf('--port') + 1]), Number(args[args.indexOf('--site-proxy-port') + 1]));
                code = `for(const port of ${JSON.stringify(ports)})require('node:http')
                    .createServer((q,s)=>s.end('anonymous-c48-fixture')).listen(port,'127.0.0.1');`;
            } else if (args.includes('--once')) {
                role = 'push';
                code = `const s=require('node:net').createServer();s.listen(0,'127.0.0.1',()=>
                    console.log(JSON.stringify({port:s.address().port})));setInterval(()=>{},1000);`;
            } else return Reflect.apply(target, receiver, values);
            const child = Reflect.apply(target, receiver, [command, [outerArgs[0], process.execPath, '-e', code], options]) as childProcess.ChildProcess;
            const group = captureGroup(child.pid!);
            workers.push({ role, group, directory: String(options!.cwd) });
            child.on('message', message => {
                const value = message as { type: string; value: string };
                if (role === 'push' && value.type === 'data') leafPort = JSON.parse(Buffer.from(value.value, 'base64').toString()).port;
            });
            return child;
        }
    });
    syncBuiltinESMExports();
    process.kill = ((pid, signal) => {
        if (signal !== 0 && workers.some(worker => worker.role === 'push' && -worker.group.pgid === pid)) {
            throw new Error('Injected owned push teardown failure');
        }
        return kill(pid, signal);
    }) as typeof process.kill;
    const previous = process.env.AUCTION_BACKEND_SETUP_TIMEOUT_MS;
    process.env.AUCTION_BACKEND_SETUP_TIMEOUT_MS = '1000';
    let failure: unknown;
    try {
        try { await localBackend('c48-uncertain', true); } catch (error) { failure = error; }
        proof.error = String(failure);
        assert(failure instanceof AggregateError);
        assert(failure.errors.some(error => String(error).includes('Injected owned push teardown failure')));
        const directory = workers[0].directory;
        proof.directory = directory;
        proof.statePreservedBeforeFixtureCleanup = await access(directory).then(() => true, () => false);
        assert.equal(proof.statePreservedBeforeFixtureCleanup, true);
        const record = (await readFile(`${process.env.EVIDENCE_DIR}/local-backends.jsonl`, 'utf8')).trim()
            .split('\n').map(line => JSON.parse(line)).findLast(row => row.label === 'c48-uncertain');
        proof.closeRecord = record;
        assert.equal(record.groups.length, 3);
        assert(record.groups.every((row: { attempted: boolean }) => row.attempted));
        assert(record.groups.filter((row: { role: string }) => row.role !== 'push')
            .every((row: { closed: boolean }) => row.closed));
        proof.backendListenersAfterReturn = await Promise.all(ports.map(portListening));
        assert((proof.backendListenersAfterReturn as boolean[]).every(value => !value));
        assert(leafPort); proof.leafPort = leafPort;
        proof.pushListenerPreserved = await portListening(leafPort); assert.equal(proof.pushListenerPreserved, true);
        const release = await preparationLock(resolve(repositoryDirectory, '.convex/backend-binary-cache'), { waitMs: 500 });
        await release(); proof.lockReleased = true;
    } finally {
        process.kill = kill; childProcess.spawn = spawn; syncBuiltinESMExports();
        if (previous === undefined) delete process.env.AUCTION_BACKEND_SETUP_TIMEOUT_MS;
        else process.env.AUCTION_BACKEND_SETUP_TIMEOUT_MS = previous;
        const stopped = await Promise.allSettled(workers.map(worker => stopGroup(worker.group)));
        assert(stopped.every(row => row.status === 'fulfilled'));
        await Promise.all([...ports, ...(leafPort ? [leafPort] : [])].map(requireClosedPort));
        for (const directory of new Set(workers.map(worker => worker.directory))) await rm(directory, { recursive: true, force: true });
        proof.fixtureCleanup = { groups: workers.map(worker => worker.group), ports: [...ports, leafPort], closed: true };
    }
}
async function main() {
    await makeEvidenceDirectory(root, { recursive: true });
    await check('C48 quiet fast parent exits before listener without losing owned continuity', fastParent);
    await check('C48 command streams and nonzero exit code pass through the anchor', relay);
    await check('C48 a stalled anchor release stays within the group teardown bound', stalledRelease);
    await check('C48 reused identity never receives a signal', proof => identityControl('reused', proof));
    await check('C48 uncertain ownership never receives a signal', proof => identityControl('uncertain', proof));
    await check('C48 failed push teardown still closes independent groups and preserves state', failedGroup);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
