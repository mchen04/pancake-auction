import { mkdir as mkdirCache } from 'node:fs/promises';
import {
    appendEvidenceFile as appendFile, copyEvidence as cp, makeEvidenceDirectory as mkdir,
    makeEvidenceTemporaryDirectory as mkdtemp, writeEvidenceFile as writeFile
} from './evidence';
import { ownCleanup, onceAsync, ownServer, listen } from './resources';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFile, rm, symlink } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { resolve } from 'node:path';
import { ConvexHttpClient } from 'convex/browser';
import { makeFunctionReference } from 'convex/server';
import { evidenceDirectory, repositoryDirectory } from './evidence';
import { isolatedBackendVersion } from './local-version';

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
        await rm(directory, { recursive: true, force: true });
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
    const cli = resolve(repositoryDirectory, 'node_modules/convex/bin/main.js');
    const preload = resolve(repositoryDirectory, 'scripts/local-cli.mjs');
    const bootstrap = spawn(process.execPath, ['--import', preload, '-e', '', '--', 'dev',
        '--local-cloud-port', String(port), '--local-site-port', String(sitePort),
        '--local-backend-version', isolatedBackendVersion],
    { cwd: directory, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
    let child: ChildProcess | undefined;
    let log = '';
    bootstrap.stdout.on('data', data => { log += String(data); });
    bootstrap.stderr.on('data', data => { log += String(data); });
    const url = `http://127.0.0.1:${port}`;
    const client = new ConvexHttpClient(url);
    let push: ChildProcess | undefined;
    const close = onceAsync(async () => {
        if (push?.pid) await stopProcess(push, 'SIGINT');
        if (bootstrap.pid) await stopProcess(bootstrap, 'SIGTERM');
        if (child?.pid) {
            const native = child;
            const force = setTimeout(() => {
                if (native.exitCode === null && native.signalCode === null) native.kill('SIGKILL');
            }, 2000);
            try { await stopProcess(native, 'SIGTERM'); }
            finally { clearTimeout(force); }
        }
        let nativePortsClosed = false;
        try {
            await Promise.all([requireClosedPort(port), requireClosedPort(sitePort)]);
            nativePortsClosed = true;
            await writeFile(`${evidence}/backend-${label}.log`, log);
        } finally {
            await rm(directory, { recursive: true, force: true });
            await appendFile(`${evidence}/local-backends.jsonl`, JSON.stringify({ label, action: 'close',
                pid: child?.pid, port, sitePort, directoryRemoved: true, nativePortsClosed }) + '\n');
        }
    });
    try {
        const prepared = await new Promise((resolve, reject) => {
            bootstrap.once('error', reject);
            bootstrap.once('close', resolve);
        });
        if (prepared !== 0) throw new Error(`Cannot start pinned Convex backend ${isolatedBackendVersion}. `
            + `It must be cached or downloadable. Local preparation exited ${prepared}: ${log}`);
        const state = `${directory}/.convex/local/default`;
        const configuration = JSON.parse(await readFile(`${state}/config.json`, 'utf8'));
        const binary = resolve(cache, 'binaries', isolatedBackendVersion, 'convex-local-backend');
        child = spawn(binary, ['--port', String(port), '--site-proxy-port', String(sitePort),
            '--instance-name', configuration.deploymentName, '--instance-secret', configuration.instanceSecret,
            '--local-storage', `${state}/convex_local_storage`, `${state}/convex_local_backend.sqlite3`],
        { cwd: directory, env: { PATH: process.env.PATH, NODE_ENV: 'test' }, stdio: 'ignore' });
        let startupError: Error | undefined;
        child.once('error', error => { startupError = new Error(`Cannot start the isolated local backend: ${error.message}`); });
        let ready = false;
        let instanceName: string | undefined;
        for (let attempt = 0; attempt < 600; attempt++) {
            if (startupError) throw startupError;
            if (child.exitCode !== null) throw new Error(`Cannot start pinned Convex backend ${isolatedBackendVersion}. `
                + `It must be cached or downloadable. Local Convex exited ${child.exitCode}: ${log}`);
            try {
                const response = await fetch(`${url}/instance_name`);
                if (!response.ok) throw new Error('The local backend is not ready');
                instanceName = await response.text();
                ready = true;
                break;
            } catch { await sleep(250); }
        }
        if (!ready) throw new Error(`Local Convex did not start: ${log}`);
        if (instanceName !== configuration.deploymentName) throw new Error('Isolated Convex backend identity mismatch');
        push = spawn(process.execPath, ['--import', preload, cli, 'dev', '--url', url,
            '--admin-key', configuration.adminKey, '--once', '--typecheck', 'disable', '--codegen', 'disable',
            '--tail-logs', 'disable'], { cwd: directory, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
        let pushLog = '';
        push.stdout!.on('data', data => { pushLog += String(data); });
        push.stderr!.on('data', data => { pushLog += String(data); });
        const pushed = await new Promise((resolve, reject) => {
            push!.once('error', error => reject(new Error(error.message.replaceAll(configuration.adminKey, '[local key]'))));
            push!.once('close', resolve);
        });
        log += pushLog.replaceAll(configuration.adminKey, '[local key]');
        if (pushed !== 0) throw new Error(`Isolated Convex function push failed: ${log}`);
        await client.query(makeFunctionReference<'query'>('smoke:ping'), {});
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
        await close();
        throw error;
    } finally {
        await releaseCache();
    }
}
