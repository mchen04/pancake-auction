import { mkdir as mkdirCache } from 'node:fs/promises';
import {
    appendEvidenceFile as appendFile, copyEvidence as cp, makeEvidenceDirectory as mkdir,
    makeEvidenceTemporaryDirectory as mkdtemp, writeEvidenceFile as writeFile
} from './evidence';
import { ownCleanup, onceAsync, ownServer, listen, spawnOwnedProcess, stopOwnedProcess } from './resources';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFile, rm, symlink } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { resolve } from 'node:path';
import { ConvexHttpClient } from 'convex/browser';
import { makeFunctionReference } from 'convex/server';
import { evidenceDirectory, repositoryDirectory } from './evidence';
import { isolatedBackendVersion } from './local-version';

class BackendCleanupError extends AggregateError {
    constructor(errors: unknown[], public directory: string) {
        super(errors, `Isolated backend cleanup failed; state preserved at ${directory}`);
    }
}

export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
export async function freePort(): Promise<number> {
    const server = ownServer(createServer());
    await listen(server);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No local port');
    await new Promise<void>(resolve => server.close(() => resolve()));
    return address.port;
}
export async function stopProcess(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM') {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const stopped = new Promise<void>(resolve => child.once('exit', () => resolve()));
    child.kill(signal);
    await stopped;
}
export async function portListening(port: number) {
    return new Promise<boolean>(resolve => {
        const socket = createConnection({ host: '127.0.0.1', port });
        socket.once('connect', () => {
            socket.destroy();
            resolve(true);
        });
        socket.once('error', error => {
            socket.destroy();
            resolve(!('code' in error && error.code === 'ECONNREFUSED'));
        });
        socket.setTimeout(2000, () => { socket.destroy(); resolve(true); });
    });
}
export async function requireClosedPort(port: number) {
    const deadline = performance.now() + 10000;
    while (await portListening(port)) {
        if (performance.now() >= deadline) throw new Error(`Local backend listener ${port} did not stop`);
        await sleep(25);
    }
}
export async function localBackend(label: string, fixtures = false) {
    const evidence = evidenceDirectory(process.env.EVIDENCE_DIR, true)!;
    await mkdir(evidence, { recursive: true });
    const directory = await mkdtemp(`${evidence}/backend-${label}-`);
    try {
        const backend = await startBackend(label, fixtures, directory, evidence);
        ownCleanup(backend.close);
        return backend;
    } catch (error) {
        if (!(error instanceof BackendCleanupError)) await rm(directory, { recursive: true, force: true });
        throw error;
    }
}
async function startBackend(label: string, fixtures: boolean, directory: string, evidence: string) {
    const port = await freePort();
    const sitePort = await freePort();
    for (const name of ['convex', 'lib', 'league']) {
        await cp(resolve(repositoryDirectory, name), `${directory}/${name}`, { recursive: true });
    }
    if (fixtures) await cp(resolve(repositoryDirectory, 'tests/fixture-functions.ts'), `${directory}/convex/testOnly.ts`);
    await cp(resolve(repositoryDirectory, 'package.json'), `${directory}/package.json`);
    await symlink(resolve(repositoryDirectory, 'node_modules'), `${directory}/node_modules`, 'dir');
    await writeFile(`${directory}/convex.json`, JSON.stringify({ functions: 'convex/' }));
    const environment: NodeJS.ProcessEnv = { PATH: process.env.PATH, NODE_ENV: 'test', CONVEX_AGENT_MODE: 'anonymous',
        AUCTION_CLI_HOME: `${directory}/cli-home`, CONVEX_DISABLE_TELEMETRY: '1', TMPDIR: `${directory}/tmp` };
    await mkdir(`${directory}/cli-home`, { recursive: true });
    await mkdir(`${directory}/tmp`);
    await mkdir(`${directory}/cli-home/.cache`);
    const cache = resolve(repositoryDirectory, '.convex/backend-binary-cache');
    await mkdirCache(cache, { recursive: true });
    await symlink(cache, `${directory}/cli-home/.cache/convex`, 'dir');
    const { preparationLock } = await import('./preparation-lock');
    const releaseCache = await preparationLock(cache);
    const setupMs = Math.max(250, Math.min(Number(process.env.AUCTION_BACKEND_SETUP_TIMEOUT_MS) || 120000, 300000));
    const controller = new AbortController();
    const expired = new Promise<never>((_, reject) => {
        controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
    });
    const timer = setTimeout(() => controller.abort(new Error(`Isolated Convex setup timed out after ${setupMs} ms`)),
        setupMs);
    const withinSetup = <T>(work: Promise<T>) => Promise.race([work, expired]);
    const cli = resolve(repositoryDirectory, 'node_modules/convex/bin/main.js');
    const preload = resolve(repositoryDirectory, 'scripts/local-cli.mjs');
    let bootstrap: ChildProcess | undefined;
    let child: ChildProcess | undefined;
    let log = '';
    const url = `http://127.0.0.1:${port}`;
    const client = new ConvexHttpClient(url, {
        fetch: (input, init) => fetch(input, { ...init, signal: controller.signal })
    });
    let push: ChildProcess | undefined;
    const close = onceAsync(async () => {
        controller.abort(new Error('Isolated Convex setup stopped'));
        const errors: unknown[] = [];
        const groups = [];
        for (const [role, process_] of [['push', push], ['bootstrap', bootstrap], ['backend', child]] as const) {
            if (!process_) continue;
            try {
                await stopOwnedProcess(process_);
                groups.push({ role, attempted: true, closed: true });
            } catch (error) {
                errors.push(error);
                groups.push({ role, attempted: true, closed: false, error: String(error) });
            }
        }
        let nativePortsClosed = false;
        try {
            await Promise.all([requireClosedPort(port), requireClosedPort(sitePort)]);
            nativePortsClosed = true;
        } catch (error) { errors.push(error); }
        try { await writeFile(`${evidence}/backend-${label}.log`, log); }
        catch (error) { errors.push(error); }
        let directoryRemoved = false;
        if (!errors.length) {
            try { await rm(directory, { recursive: true, force: true }); directoryRemoved = true; }
            catch (error) { errors.push(error); }
        }
        try {
            await appendFile(`${evidence}/local-backends.jsonl`, JSON.stringify({ label, action: 'close',
                pid: child?.pid, port, sitePort, directoryRemoved, nativePortsClosed, groups,
                statePreserved: !directoryRemoved }) + '\n');
        } catch (error) { errors.push(error); }
        if (errors.length) throw new BackendCleanupError(errors, directory);
    });
    try {
        bootstrap = spawnOwnedProcess(process.execPath, ['--import', preload, '-e', '', '--', 'dev',
            '--local-cloud-port', String(port), '--local-site-port', String(sitePort),
            '--local-backend-version', isolatedBackendVersion],
        { cwd: directory, env: environment, detached: true, stdio: ['ignore', 'pipe', 'pipe'] }, 'SIGTERM');
        bootstrap.stdout!.on('data', data => { log += String(data); });
        bootstrap.stderr!.on('data', data => { log += String(data); });
        const prepared = await withinSetup(new Promise((resolve, reject) => {
            bootstrap!.once('error', reject);
            bootstrap!.once('close', resolve);
        }));
        if (prepared !== 0) throw new Error(`Cannot start pinned Convex backend ${isolatedBackendVersion}. `
            + `It must be cached or downloadable. Local preparation exited ${prepared}: ${log}`);
        const state = `${directory}/.convex/local/default`;
        const configuration = JSON.parse(await withinSetup(readFile(`${state}/config.json`, 'utf8')));
        const binary = resolve(cache, 'binaries', isolatedBackendVersion, 'convex-local-backend');
        child = spawnOwnedProcess(binary, ['--port', String(port), '--site-proxy-port', String(sitePort),
            '--instance-name', configuration.deploymentName, '--instance-secret', configuration.instanceSecret,
            '--local-storage', `${state}/convex_local_storage`, `${state}/convex_local_backend.sqlite3`],
        { cwd: directory, env: { PATH: process.env.PATH, NODE_ENV: 'test' }, detached: true,
            stdio: 'ignore' }, 'SIGTERM');
        let startupError: Error | undefined;
        child.once('error', error => { startupError = new Error(`Cannot start the isolated local backend: ${error.message}`); });
        let ready = false;
        let instanceName: string | undefined;
        for (let attempt = 0; attempt < 600; attempt++) {
            if (startupError) throw startupError;
            if (child.exitCode !== null) throw new Error(`Cannot start pinned Convex backend ${isolatedBackendVersion}. `
                + `It must be cached or downloadable. Local Convex exited ${child.exitCode}: ${log}`);
            try {
                const response = await withinSetup(fetch(`${url}/instance_name`, { signal: controller.signal }));
                if (!response.ok) throw new Error('The local backend is not ready');
                instanceName = await withinSetup(response.text());
                ready = true;
                break;
            } catch {
                if (controller.signal.aborted) throw controller.signal.reason;
                await withinSetup(sleep(250));
            }
        }
        if (!ready) throw new Error(`Local Convex did not start: ${log}`);
        if (instanceName !== configuration.deploymentName) throw new Error('Isolated Convex backend identity mismatch');
        push = spawnOwnedProcess(process.execPath, ['--import', preload, cli, 'dev', '--url', url,
            '--admin-key', configuration.adminKey, '--once', '--typecheck', 'disable', '--codegen', 'disable',
            '--tail-logs', 'disable'], { cwd: directory, env: environment, detached: true,
                stdio: ['ignore', 'pipe', 'pipe'] }, 'SIGINT');
        let pushLog = '';
        push.stdout!.on('data', data => { pushLog += String(data); });
        push.stderr!.on('data', data => { pushLog += String(data); });
        const pushed = await withinSetup(new Promise((resolve, reject) => {
            push!.once('error', error => reject(new Error(error.message.replaceAll(configuration.adminKey, '[local key]'))));
            push!.once('close', resolve);
        }));
        log += pushLog.replaceAll(configuration.adminKey, '[local key]');
        if (pushed !== 0) throw new Error(`Isolated Convex function push failed: ${log}`);
        await withinSetup(client.query(makeFunctionReference<'query'>('smoke:ping'), {}));
        const admin = async (name: string, args: Record<string, unknown> = {}) => {
            const argumentFile = `${directory}/args-${crypto.randomUUID()}.json`;
            await writeFile(argumentFile, JSON.stringify(args));
            const worker = spawn(process.execPath, ['--import', preload, cli, 'run', '--url', url,
                '--admin-key', configuration.adminKey, name],
            { cwd: directory, env: { ...environment, AUCTION_ARGS_FILE: argumentFile },
                stdio: ['ignore', 'pipe', 'pipe'] });
            let output = '';
            let error = '';
            worker.stdout.on('data', data => { output += String(data); });
            worker.stderr.on('data', data => { error += String(data); });
            const code = await new Promise(resolve => worker.once('exit', resolve));
            await rm(argumentFile);
            if (code !== 0) {
                const detail = error.replaceAll(configuration.adminKey, '[local key]');
                throw new Error(`Local admin ${name} failed: ${detail}`);
            }
            return output.trim() ? JSON.parse(output) : null;
        };
        const identity = { mode: 'anonymous', version: configuration.backendVersion, url, port, sitePort,
            command: `convex-local-backend ${isolatedBackendVersion} <isolated config>; convex dev --url <local> --once`,
            directory };
        await writeFile(`${evidence}/backend-${label}.json`, JSON.stringify(identity, null, 2));
        await appendFile(`${evidence}/local-backends.jsonl`, JSON.stringify({ label, action: 'ready',
            pid: child.pid, ...identity }) + '\n');
        return { client, admin, close, url, identity };
    } catch (error) {
        try { await close(); }
        catch (cleanupError) {
            const errors = cleanupError instanceof AggregateError ? cleanupError.errors : [cleanupError];
            throw new BackendCleanupError([error, ...errors], directory);
        }
        throw error;
    } finally {
        clearTimeout(timer);
        await releaseCache();
    }
}
