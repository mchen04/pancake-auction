import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, readFile, readdir, rm } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { hostname } from 'node:os';
import { resolve } from 'node:path';
import { evidenceDirectory, makeEvidenceDirectory, writeEvidenceFile } from '../scripts/evidence';
import { portListening, requireClosedPort, sleep } from '../scripts/local-backend';
import { captureGroup, refreshGroup, stopGroup, type OwnedGroup } from '../scripts/process-group';
import { withResources } from '../scripts/resources';
import { localWorkflow } from './local-dev';

const exists = (path: string) => access(path).then(() => true, () => false);
const hash = (data: Buffer) => createHash('sha256').update(data).digest('hex');
async function sourceFiles(directory: string, prefix = 'scripts'): Promise<Record<string, string>> {
    const files: Record<string, string> = {};
    if (!await exists(`${directory}/${prefix}`)) return files;
    for (const entry of await readdir(`${directory}/${prefix}`, { withFileTypes: true })) {
        const name = `${prefix}/${entry.name}`;
        if (entry.isDirectory()) Object.assign(files, await sourceFiles(directory, name));
        else files[name] = hash(await readFile(`${directory}/${name}`));
    }
    return files;
}
async function snapshot(directory: string) {
    const files: Record<string, { bytes: number; sha256: string } | null> = {};
    for (const name of ['SENTINEL', 'package.json', '.convex/local/default/convex_local_backend.sqlite3']) {
        files[name] = await readFile(`${directory}/${name}`).then(data => ({ bytes: data.length, sha256: hash(data) }),
            error => { if (error.code === 'ENOENT') return null; throw error; });
    }
    return { files, scripts: await sourceFiles(directory) };
}
function messages(error: unknown): string[] {
    if (error instanceof AggregateError) return [error.message, ...error.errors.flatMap(messages)];
    return [String(error)];
}
async function exercise(failFrontend: boolean, root: string, proof: Record<string, unknown>) {
    await makeEvidenceDirectory(root, { recursive: true });
    const outside = `${root}/outside-sentinel`;
    await writeEvidenceFile(outside, 'Only the workflow directory belongs to cleanup.');
    const outsideHash = hash(await readFile(outside));
    const originalSpawn = childProcess.spawn, originalKill = process.kill;
    const previous = process.env.EVIDENCE_DIR;
    const groups: { role: string; group: OwnedGroup }[] = [];
    const attempts: number[] = [];
    let directory = '', frontend: OwnedGroup | undefined;
    let before: Awaited<ReturnType<typeof snapshot>> | undefined;
    let failure: unknown, innerFailure: unknown;
    let injected = 0;
    process.env.EVIDENCE_DIR = root;
    childProcess.spawn = new Proxy(originalSpawn, {
        apply(target, receiver, args) {
            const child = Reflect.apply(target, receiver, args);
            const [, values, options] = args;
            if (values?.[0]?.endsWith('/command-anchor.mjs') && values[1] === 'npm' && values[2] === 'run'
                && ['dev', 'backend:local'].includes(values[3])) {
                const group = captureGroup(child.pid!);
                const role = values[3] === 'dev' ? 'frontend' : 'backend';
                groups.push({ role, group }); directory = String(options.cwd);
                if (role === 'frontend') frontend = group;
            }
            return child;
        }
    });
    syncBuiltinESMExports();
    process.kill = ((pid, signal) => {
        if (signal !== 0 && groups.some(row => -row.group.pgid === pid)) attempts.push(-pid);
        if (failFrontend && frontend && pid === -frontend.pgid && signal !== 0) {
            injected++;
            throw new Error('C50 injected owned frontend teardown failure');
        }
        return originalKill(pid, signal);
    }) as typeof process.kill;
    let sentinel: Promise<void> | undefined;
    try {
        const scoped = withResources(async () => {
            try { await localWorkflow(); }
            catch (error) { innerFailure = error; throw error; }
            finally { if (directory) before = await snapshot(directory); }
        }).catch(error => { failure = error; });
        while (!directory && !failure) await sleep(25);
        assert(directory, 'The native workflow must acquire its own directory');
        sentinel = writeEvidenceFile(`${directory}/SENTINEL`, 'C50 retained state marker.');
        await sentinel;
        await scoped;
        const report = JSON.parse(await readFile(`${root}/local-workflow.json`, 'utf8'));
        assert.equal(report.result, 'passed', 'The actual backend and Next workflow must finish before cleanup');
        assert.equal(report.restartPreservesDataAndIdentity, true);
        const ports = [report.port, report.sitePort, report.frontendPort] as number[];
        assert(ports.every(port => ![3100, 3210, 3211, 3220, 3221, 3917].includes(port)));
        const after = await snapshot(directory);
        const listeners = await Promise.all(ports.map(portListening));
        Object.assign(proof, { semantics: 'Actual pinned backend, actual Next dev server, actual workflow and outer resource scope',
            directory, report, beforeScope: before, afterScope: after, listenersAtScopeExit: listeners,
            innerFailure: messages(innerFailure), scopeFailure: messages(failure), injectedSignals: injected,
            groupAttempts: attempts, groups: structuredClone(groups) });
        if (failFrontend) {
            assert(innerFailure instanceof AggregateError);
            assert(failure instanceof AggregateError);
            assert(messages(failure).some(value => value.includes('C50 injected')));
            assert(injected > 0);
            assert(before?.files.SENTINEL);
            assert(before.files['.convex/local/default/convex_local_backend.sqlite3']!.bytes > 1024);
            assert(Object.keys(before.scripts).length > 0);
            assert.deepEqual(after, before, 'The outer scope must preserve every retained state and source byte');
            assert.deepEqual(listeners, [false, false, true]);
            assert(groups.filter(row => row.role === 'backend').every(row => attempts.includes(row.group.pgid)));
            assert(attempts.includes(frontend!.pgid));
            proof.retainedBytesUnchanged = true;
        } else {
            assert.equal(innerFailure, undefined); assert.equal(failure, undefined);
            assert.equal(await exists(directory), false);
            assert.deepEqual(listeners, [false, false, false]);
            assert.equal(report.directoryRemoved, true);
            proof.explicitAndScopeCloseIdempotent = true;
        }
        assert.equal(hash(await readFile(outside)), outsideHash);
        proof.outsideStateUnchanged = true;
    } finally {
        process.kill = originalKill; childProcess.spawn = originalSpawn; syncBuiltinESMExports();
        await sentinel;
        const stopped = await Promise.allSettled(groups.map(row => stopGroup(row.group)));
        const errors = stopped.filter(row => row.status === 'rejected').map(row => row.reason);
        if (previous === undefined) delete process.env.EVIDENCE_DIR;
        else process.env.EVIDENCE_DIR = previous;
        if (errors.length) throw new AggregateError(errors, 'C50 fixture cleanup failed; retained state preserved');
        const report = await readFile(`${root}/local-workflow.json`, 'utf8').then(JSON.parse, () => null);
        if (report) await Promise.all([report.port, report.sitePort, report.frontendPort].map(requireClosedPort));
        for (const row of groups) refreshGroup(row.group);
        assert(groups.every(row => row.group.closed));
        if (directory) await rm(directory, { recursive: true, force: true });
        proof.fixtureCleanup = { groups, portsClosed: true, directoryRemoved: !await exists(directory),
            outsideStateUnchanged: hash(await readFile(outside)) === outsideHash };
    }
}
async function main() {
    const root = evidenceDirectory(`${process.env.EVIDENCE_DIR}/local-state`, true)!;
    await makeEvidenceDirectory(root, { recursive: true });
    const results: Record<string, unknown>[] = [];
    for (const fail of process.argv.includes('--failure-only') ? [true] : [true, false]) {
        const name = fail ? 'C50 failed frontend stop preserves native state through the outer scope'
            : 'C50 successful native workflow removes state after idempotent explicit and scope closure';
        const proof: Record<string, unknown> = {};
        try {
            await exercise(fail, `${root}/${fail ? 'failure' : 'success'}`, proof);
            results.push({ name, result: 'passed', proof }); console.log(`PASS ${name}`);
        } catch (error) {
            results.push({ name, result: 'failed', error: messages(error), proof });
            console.error(`FAIL ${name}:`, error); process.exitCode = 1;
        }
        await writeEvidenceFile(`${root}/results.json`, JSON.stringify({ host: hostname(),
            workflowSourceSha256: hash(await readFile(resolve('tests/local-dev.ts'))), results }, null, 2));
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
