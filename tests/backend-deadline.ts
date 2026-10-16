import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { createHash } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { resolve } from 'node:path';
import { localBackend, sleep, requireClosedPort, portListening } from '../scripts/local-backend';
import { captureGroup, refreshGroup, stopGroup, type OwnedGroup } from '../scripts/process-group';
import { preparationLock } from '../scripts/preparation-lock';
import { withResources } from '../scripts/resources';
import { makeEvidenceDirectory, writeEvidenceFile, repositoryDirectory } from '../scripts/evidence';

type Fixture = { child: childProcess.ChildProcess; group: OwnedGroup; kind: string; directory: string };
const root = `${process.env.EVIDENCE_DIR}/backend-deadline`;
const results: Record<string, unknown>[] = [];
const exists = (path: string) => access(path).then(() => true, () => false);
const originalSpawn = childProcess.spawn;
let mode = 'success';
let children: Fixture[] = [];
let ports = new Set<number>();
let pushStarted = false;
const configuration = { deploymentName: 'anonymous-deadline-fixture', backendVersion: 'precompiled-fixture',
    adminKey: 'generated-fixture-key', instanceSecret: 'generated-fixture-secret' };
let source = '';
const backendCode = `
const http=require('node:http');
for(const port of process.argv.slice(1).map(Number)) {
    const server=http.createServer((request,response)=>{
        if(request.url==='/instance_name') {
            if(process.env.FIXTURE_MODE==='readiness-stall'){response.writeHead(200);response.write('partial');return;}
            response.end('anonymous-deadline-fixture');
        } else if(process.env.FIXTURE_MODE!=='smoke-stall') {
            response.setHeader('Content-Type','application/json');
            response.end(JSON.stringify({status:'success',value:{ok:true}}));
        }
    });
    server.listen(port,'127.0.0.1',()=>console.log(JSON.stringify({kind:'native',port})));
}`;
const descendantCode = `
const server=require('node:net').createServer();
server.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({kind:'descendant',port:server.address().port})));
if(process.env.FIXTURE_MODE==='stall') {
    process.on('SIGINT',()=>{});process.on('SIGTERM',()=>{});
}`;
childProcess.spawn = new Proxy(originalSpawn, {
    apply(target, receiver, values: Parameters<typeof childProcess.spawn>) {
        const [command, args, options] = values;
        if (!Array.isArray(args) || typeof options?.cwd !== 'string') return Reflect.apply(target, receiver, values);
        let kind: string;
        let fixtureArgs: string[];
        if (args.includes('--local-backend-version')) {
            kind = 'bootstrap';
            const code = `const fs=require('node:fs');
                fs.mkdirSync('.convex/local/default',{recursive:true});
                fs.writeFileSync('.convex/local/default/config.json',${JSON.stringify(JSON.stringify(configuration))});
                ${mode === 'bootstrap-stall' ? 'setInterval(()=>{},1000);' : 'setTimeout(()=>process.exit(0),100);'}`;
            fixtureArgs = ['-e', code];
        } else if (String(command).endsWith('/convex-local-backend')) {
            kind = 'native';
            fixtureArgs = ['-e', backendCode, String(args[args.indexOf('--port') + 1]),
                String(args[args.indexOf('--site-proxy-port') + 1])];
        } else if (args.includes('--once')) {
            kind = 'push'; pushStarted = true;
            fixtureArgs = ['-e', mode === 'success' || mode === 'reject'
                ? `setTimeout(()=>process.exit(${mode === 'success' ? 0 : 2}),100)`
                : `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendantCode)}],
                    {stdio:['ignore','inherit','inherit']});
                   if(process.env.FIXTURE_MODE==='stall') {
                       process.on('SIGINT',()=>{});process.on('SIGTERM',()=>{});
                   }
                   setInterval(()=>{},1000);`];
        } else return Reflect.apply(target, receiver, values);
        const child = Reflect.apply(target, receiver, [process.execPath, fixtureArgs, {
            ...options, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
            env: { PATH: process.env.PATH, FIXTURE_MODE: mode }
        }]) as childProcess.ChildProcess;
        const group = captureGroup(child.pid!);
        children.push({ child, group, kind, directory: options.cwd });
        child.stdout!.on('data', data => {
            for (const line of String(data).trim().split('\n')) {
                try { const value = JSON.parse(line); if (Number.isInteger(value.port)) ports.add(value.port); } catch {}
            }
            refreshGroup(group);
        });
        return child;
    }
});
syncBuiltinESMExports();
async function check(name: string, run: (proof: Record<string, unknown>) => Promise<void>) {
    const proof: Record<string, unknown> = {};
    try { await run(proof); results.push({ name, result: 'passed', proof }); console.log(`PASS ${name}`); }
    catch (error) {
        results.push({ name, result: 'failed', error: String(error), proof });
        console.log(`FAIL ${name}: ${error}`); process.exitCode = 1;
    }
}
async function exercise(selected: string, proof: Record<string, unknown>) {
    mode = selected; children = []; ports = new Set(); pushStarted = false;
    const started = performance.now();
    let settled = false;
    let failure: unknown;
    let backend: Awaited<ReturnType<typeof localBackend>> | undefined;
    const running = localBackend(`deadline-${selected}`, true).then(value => { backend = value; }, error => {
        failure = error;
    }).finally(() => { settled = true; });
    try {
        if (selected === 'external') {
            while (!pushStarted || !ports.size || !children.some(value => value.kind === 'push')) {
                assert(performance.now() - started < 6000, 'Push starts before external shutdown'); await sleep(20);
            }
            await sleep(100);
            const push = children.find(value => value.kind === 'push')!;
            refreshGroup(push.group); await stopGroup(push.group);
        }
        await Promise.race([running, sleep(5000)]);
        proof.settledWithinBound = settled;
        proof.elapsedMs = performance.now() - started;
        proof.error = failure instanceof Error ? failure.message : String(failure);
        if (!settled) {
            try { await preparationLock(resolve(repositoryDirectory, '.convex/backend-binary-cache'), { waitMs: 150 }); }
            catch (error) { proof.contenderError = String(error); }
        }
        assert(settled, 'Setup must finish within its deadline plus owned-group teardown');
        if (selected === 'success') {
            assert(backend); assert.equal(failure, undefined);
            await backend.close(); await backend.close(); proof.idempotentClose = true;
        } else if (selected === 'reject' || selected === 'external') {
            assert(failure instanceof Error); assert.match(failure.message, /function push failed/);
        } else {
            assert(failure instanceof Error); assert.match(failure.message, /setup timed out after 1000 ms/i);
        }
        for (const { group } of children) refreshGroup(group);
        proof.groupsClosedAtReturn = children.every(value => value.group.closed);
        proof.listenersAtReturn = await Promise.all([...ports].map(portListening));
        proof.directoriesRemovedAtReturn = await Promise.all([...new Set(children.map(value => value.directory))]
            .map(async path => !await exists(path)));
        assert.equal(proof.groupsClosedAtReturn, true, 'Setup closes groups before returning or rejecting');
        assert((proof.listenersAtReturn as boolean[]).every(value => !value), 'Setup closes all owned listeners');
        assert((proof.directoriesRemovedAtReturn as boolean[]).every(Boolean), 'Setup removes its owned state');
        const release = await preparationLock(resolve(repositoryDirectory, '.convex/backend-binary-cache'), { waitMs: 500 });
        await release(); proof.contenderAcquired = true;
    } finally {
        for (const { group } of children.toReversed()) await stopGroup(group);
        await Promise.race([running, sleep(3000)]);
        assert(settled, 'Fixture cleanup must settle setup');
        await backend?.close();
        await Promise.all([...ports].map(requireClosedPort));
        proof.groups = children.map(({ kind, group }) => ({ kind, ...group }));
        proof.ports = [...ports]; proof.listenersClosed = true;
        proof.directories = await Promise.all([...new Set(children.map(value => value.directory))]
            .map(async path => ({ path, removed: !await exists(path) })));
        assert((proof.directories as { removed: boolean }[]).every(value => value.removed));
        assert(children.every(value => value.group.closed));
        const records = (await readFile(`${process.env.EVIDENCE_DIR}/local-backends.jsonl`, 'utf8'))
            .trim().split('\n').map(line => JSON.parse(line));
        proof.closeRecords = records.filter(row => row.label === `deadline-${selected}` && row.action === 'close').length;
        assert.equal(proof.closeRecords, 1, 'Cleanup records one close even when called repeatedly');
    }
}
async function main() {
    source = await readFile(resolve('scripts/local-backend.ts'), 'utf8');
    await makeEvidenceDirectory(root, { recursive: true });
    const previous = process.env.AUCTION_BACKEND_SETUP_TIMEOUT_MS;
    process.env.AUCTION_BACKEND_SETUP_TIMEOUT_MS = '1000';
    try {
        const modes = process.argv.includes('--push-only') ? ['stall', 'success', 'reject', 'external']
            : ['stall', 'success', 'reject', 'external', 'bootstrap-stall', 'readiness-stall', 'smoke-stall'];
        for (const selected of modes) await check(`C47 ${selected} setup releases owned resources and the lock`,
            proof => exercise(selected, proof));
    } finally {
        if (previous === undefined) delete process.env.AUCTION_BACKEND_SETUP_TIMEOUT_MS;
        else process.env.AUCTION_BACKEND_SETUP_TIMEOUT_MS = previous;
        childProcess.spawn = originalSpawn; syncBuiltinESMExports();
        await writeEvidenceFile(`${root}/results.json`, JSON.stringify({ host: hostname(),
            sourceSha256: createHash('sha256').update(source).digest('hex'),
            semantics: 'Actual localBackend setup and preparation lock; real owned Node children and listeners; bootstrap config, readiness and push are fixture implementations, not a Convex outage',
            results }, null, 2));
    }
}
withResources(main).catch(error => { console.error(error); process.exitCode = 1; });
