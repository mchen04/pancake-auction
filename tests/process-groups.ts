import assert from 'node:assert/strict';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createConnection } from 'node:net';
import { makeEvidenceDirectory, writeEvidenceFile } from '../scripts/evidence';
import { ownProcess, spawnOwnedProcess, withResources } from '../scripts/resources';

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const root = `${process.env.EVIDENCE_DIR}/process-groups`;
const results: Record<string, unknown>[] = [];
async function listening(port: number) {
    return new Promise<boolean>(resolve => {
        const socket = createConnection({ host: '127.0.0.1', port });
        socket.once('connect', () => { socket.destroy(); resolve(true); });
        socket.once('error', error => { socket.destroy(); resolve(!('code' in error && error.code === 'ECONNREFUSED')); });
        socket.setTimeout(500, () => { socket.destroy(); resolve(true); });
    });
}
function identity(pid: number) {
    try { return execFileSync('ps', ['-p', String(pid), '-o', 'pgid=,lstart='], { encoding: 'utf8' }).trim(); }
    catch { return null; }
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
async function listener(killLeader: boolean, resist: boolean, proof: Record<string, unknown>) {
    const leaf = `const s=require('node:net').createServer();${resist ? "process.on('SIGTERM',()=>{});" : ''}
        s.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({pid:process.pid,port:s.address().port})));`;
    const parent = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(leaf)}],
        {stdio:['ignore','inherit','inherit']});setInterval(()=>{},1000)`;
    let child: ChildProcess | undefined, member: { pid: number; port: number } | undefined;
    const ownership: { identity?: string } = {};
    const started = performance.now();
    try {
        await withResources(async () => {
            child = spawnOwnedProcess(process.execPath, ['-e', parent],
                { detached: true, stdio: ['ignore', 'pipe', 'pipe'] }, 'SIGTERM');
            const startedMember = await new Promise<{ pid: number; port: number }>((resolve, reject) => {
                let text = '';
                const timer = setTimeout(() => reject(new Error('Owned listener did not start')), 5000);
                child!.stdout!.on('data', data => {
                    text += data;
                    if (text.includes('\n')) { clearTimeout(timer); resolve(JSON.parse(text.split('\n')[0])); }
                });
            });
            member = startedMember;
            ownership.identity = identity(startedMember.pid) ?? undefined;
            if (killLeader) {
                const ended = new Promise(resolve => child!.once('exit', resolve));
                child.kill('SIGKILL'); await ended;
            }
        });
        proof.listenerAlive = await listening(member!.port);
        let groupAlive = true;
        try { process.kill(-child!.pid!, 0); } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ESRCH') groupAlive = false;
        }
        Object.assign(proof, { groupAlive, port: member!.port, pgid: child!.pid, memberPid: member!.pid,
            elapsedMs: performance.now() - started });
        assert.equal(proof.listenerAlive, false); assert.equal(groupAlive, false);
        assert(performance.now() - started < 10000);
    } finally {
        if (member && ownership.identity && identity(member.pid) === ownership.identity) {
            assert.equal(Number(ownership.identity.split(/\s+/)[0]), child!.pid);
            process.kill(-child!.pid!, 'SIGKILL');
        } else if (child?.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        if (child && child.exitCode === null && child.signalCode === null) {
            await new Promise(resolve => child!.once('exit', resolve));
        }
        if (member) {
            const deadline = performance.now() + 5000;
            while (await listening(member.port)) { assert(performance.now() < deadline); await pause(20); }
            proof.portClosedAfterOwnedCleanup = true;
        }
    }
}
async function main() {
    await makeEvidenceDirectory(root, { recursive: true });
    await check('C42 normal group teardown closes its descendant listener', proof => listener(false, false, proof));
    await check('C42 exited leader does not abandon its descendant listener', proof => listener(true, false, proof));
    await check('C42 a resistant descendant is killed within the teardown bound', proof => listener(true, true, proof));
    await check('C42 already-exited leader without descendants needs no signal', async proof => {
        await withResources(async () => {
            const child = spawnOwnedProcess(process.execPath, ['-e', ''], { detached: true, stdio: 'ignore' }, 'SIGTERM');
            await new Promise(resolve => child.once('exit', resolve));
            proof.pid = child.pid;
        });
    });
    await check('C42 an unowned process group is never signalled', async proof => {
        const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
        const original = process.kill;
        let groupSignals = 0;
        process.kill = ((pid, signal) => {
            if (pid < 0 && signal !== 0) { groupSignals++; throw new Error('Unowned group must not be signalled'); }
            return original(pid, signal);
        }) as typeof process.kill;
        try {
            await assert.rejects(withResources(async () => { ownProcess(child, 'SIGTERM', true); }));
            proof.groupSignals = groupSignals; assert.equal(groupSignals, 0);
            assert.equal(child.exitCode, null);
        } finally {
            process.kill = original;
            const ended = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGKILL'); await ended;
        }
    });
    await check('C42 transient closure probes retry without treating EPERM as closed', async proof => {
        const original = process.kill;
        let target = 0, signalled = false, transients = 0;
        process.kill = ((pid, signal) => {
            if (pid === -target && signal === 0 && signalled && transients < 3) {
                transients++; throw Object.assign(new Error('Injected transient probe'), { code: 'EPERM' });
            }
            if (pid === -target && signal !== 0) signalled = true;
            return original(pid, signal);
        }) as typeof process.kill;
        let child: ChildProcess | undefined;
        try {
            await withResources(async () => {
                child = spawnOwnedProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'],
                    { detached: true, stdio: 'ignore' }, 'SIGTERM');
                target = child.pid!;
            });
            proof.transients = transients; assert.equal(transients, 3);
            assert.throws(() => original(-target, 0), { code: 'ESRCH' });
        } finally {
            process.kill = original;
            if (child && child.exitCode === null && child.signalCode === null) {
                const ended = new Promise(resolve => child!.once('exit', resolve)); child.kill('SIGKILL'); await ended;
            }
        }
    });
}
main().catch(error => { console.error(error); process.exitCode = 1; });
