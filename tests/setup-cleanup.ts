import { makeEvidenceDirectory as mkdir, writeEvidenceFile as writeFile } from '../scripts/evidence';
import assert from 'node:assert/strict';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { readFile, rm, access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { portListening, requireClosedPort, sleep } from '../scripts/local-backend';

const root = resolve(process.env.EVIDENCE_DIR!, 'setup-cleanup');
const results: Record<string, unknown>[] = [];
const protectedPorts = [3100,3210,3211,6790,3220,3221,3917];
type Ready = { action: string; pid: number; port: number; sitePort: number; directory: string };
async function records(directory: string): Promise<Ready[]> {
    return (await readFile(`${directory}/local-backends.jsonl`, 'utf8').catch(() => '')).trim()
        .split('\n').filter(Boolean).map(line => JSON.parse(line));
}
async function run(entry: string, failure: 'admin' | 'bundle' | 'before' | 'browser' | 'none') {
    const directory = `${root}/${entry}-${failure}`;
    await mkdir(directory, { recursive: true });
    if (failure === 'bundle') await mkdir(`${directory}/roster-slots/bundle.js`, { recursive: true });
    if (failure === 'before') await writeFile(`${directory}/roster-slots`, 'blocked');
    const started = performance.now();
    const timeoutMs = failure === 'none' ? 600000 : 120000;
    const child = spawn(process.execPath, ['--import', 'tsx', '--import', resolve('tests/setup-failure.mjs'),
        `tests/${entry}.ts`], { env: { PATH: process.env.PATH, NODE_ENV: 'test', EVIDENCE_DIR: directory,
            AUCTION_NEXT_DEV: '1', AUCTION_TEST_FAIL_ADMIN: failure === 'admin' ? '1' : '0',
            AUCTION_TEST_FAIL_BROWSER: failure === 'browser' ? '1' : '0' }, stdio: ['ignore','pipe','pipe'] });
    let output = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { output += data; });
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
    let failureAt: number | null = null;
    let ready: Ready | undefined;
    let timedOut = false;
    try {
        while (child.exitCode === null && child.signalCode === null) {
            ready ??= (await records(directory)).find(row => row.action === 'ready');
            if (failureAt === null && /Injected post-acquisition|Injected browser|Build failed|EEXIST/.test(output)) {
                failureAt = performance.now();
            }
            if (performance.now() - started > timeoutMs
                || failureAt !== null && performance.now() - failureAt > 15000) {
                timedOut = true;
                break;
            }
            await sleep(50);
        }
        ready ??= (await records(directory)).find(row => row.action === 'ready');
        const ports = ready ? [ready.port, ready.sitePort] : [];
        assert(ports.every(port => !protectedPorts.includes(port)));
        const reports = (await readFile(`${directory}/resources.jsonl`,'utf8').catch(()=>''))
            .trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
        const uiEvidence = JSON.parse(await readFile(`${directory}/chromium/evidence.json`, 'utf8').catch(() => '{}'));
        const nextPort = uiEvidence.frontend ? Number(new URL(uiEvidence.frontend).port) : undefined;
        const frontendPorts = reports.flatMap(report=>report.servers.map((server:{port:number|null})=>server.port))
            .filter((port:unknown):port is number=>typeof port==='number'&&!ports.includes(port));
        if (nextPort) frontendPorts.push(nextPort);
        assert(frontendPorts.every((port:number)=>!protectedPorts.includes(port)));
        if(child.exitCode!==null||child.signalCode!==null) {
            await Promise.all([...ports,...frontendPorts].map(requireClosedPort));
        }
        const listeners = await Promise.all(ports.map(portListening));
        let backendCliAlive = false;
        if(ready) { try { process.kill(ready.pid,0); backendCliAlive=true; } catch {} }
        const frontendsClosed = !(await Promise.all(frontendPorts.map(portListening))).some(Boolean);
        const proof = { entry, failure, exitCode: child.exitCode, timedOut,
            elapsedMs: performance.now() - started, failureToExitMs: failureAt === null ? null : performance.now()-failureAt,
            backendAcquired: Boolean(ready), backendCliAlive, listeners, ports, frontendPorts, frontendsClosed, reports,
            directory: ready?.directory,
            directoryRemoved: ready ? !await access(ready.directory).then(() => true, () => false) : true,
            closeRecord: (await records(directory)).some(row => row.action === 'close') };
        results.push(proof);
        await writeFile(`${directory}/output.log`, output);
        if (failure === 'none') assert.equal(child.exitCode, 0, output);
        else assert(child.exitCode !== null && child.exitCode !== 0, 'Setup failure must exit promptly with a nonzero code');
        assert(!timedOut, 'A setup failure must not hang');
        assert(!backendCliAlive,'The owned backend CLI must exit');
        assert(listeners.every(value => !value), 'Both owned backend ports must close');
        assert(proof.directoryRemoved, 'The owned backend state must be removed');
        assert(frontendsClosed,'Owned frontend listeners must close');
        if(failure==='browser') {
            assert(frontendPorts.length>0,'The browser failure control must acquire a real frontend listener');
            assert(reports.some(report=>report.browsers.some((browser:{started:boolean;closed:boolean})=>
                browser.started&&browser.closed)),'The owned browser must close after setup fails');
        }
        assert(reports.every(report=>report.processes.every((child:{closed:boolean})=>child.closed)));
        assert.equal(proof.backendAcquired, failure !== 'before');
        if (ready) assert(proof.closeRecord);
        console.log(`PASS ${entry} ${failure} cleans every acquired resource`);
    } finally {
        if (child.exitCode === null && child.signalCode === null) {
            if (ready) {
                const processInfo=spawnSync('/bin/ps',['-p',String(ready.pid),'-o','ppid='],{encoding:'utf8'});
                if(processInfo.status===0) {
                    const ppid=Number(processInfo.stdout.trim());
                    if(ppid!==child.pid) {
                        const cwd=execFileSync('/usr/sbin/lsof',['-a','-p',String(ready.pid),'-d','cwd','-Fn'],
                            {encoding:'utf8'});
                        assert(cwd.split('\n').includes('n'+ready.directory),'The recorded CLI must own this workspace');
                    }
                    process.kill(ready.pid,'SIGINT');
                }
                await Promise.all([requireClosedPort(ready.port), requireClosedPort(ready.sitePort)]);
            }
            await Promise.race([exited, sleep(2000)]);
            if (child.exitCode === null && child.signalCode === null) {
                child.kill('SIGTERM'); await exited;
            }
        }
        if (ready) {
            assert(ready.directory.startsWith(directory+'/backend-'));
            await rm(ready.directory, { recursive: true, force: true });
            await Promise.all([requireClosedPort(ready.port), requireClosedPort(ready.sitePort)]);
        }
        await writeFile(`${directory}/output.log`, output);
        await writeFile(`${directory}/cleanup.json`, JSON.stringify({ mainExited:child.exitCode!==null
            ||child.signalCode!==null, portsClosed:ready?!(await portListening(ready.port))
            &&!(await portListening(ready.sitePort)):true,
            directoryRemoved:ready?!await access(ready.directory).then(()=>true,()=>false):true },null,2));
    }
}
async function main() {
    await mkdir(root, { recursive: true });
    for (const [entry, failure] of [['roster-slots','before'],['roster-slots','bundle'],
        ['roster-slots','admin'],['sealed-ui','admin'],['connection','admin'],['sealed-ui','browser'],['sealed-ui','none']] as const) {
        try { await run(entry, failure); }
        catch (error) {
            console.error(`FAIL ${entry} ${failure}: ${error}`);
            results.push({ entry, failure, error: String(error) });
            process.exitCode = 1;
        }
    }
    await writeFile(`${root}/results.json`, JSON.stringify(results,null,2));
}
main().catch(error => { console.error(error); process.exitCode=1; });
