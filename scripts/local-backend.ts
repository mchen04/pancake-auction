import { spawn, type ChildProcess } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { ConvexHttpClient } from 'convex/browser';
import { makeFunctionReference } from 'convex/server';
import { evidenceDirectory } from './evidence';

export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
export async function freePort(): Promise<number> {
    const server = createServer();
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No local port');
    await new Promise<void>(resolve => server.close(() => resolve()));
    return address.port;
}
export async function stopProcess(child: ChildProcess) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const stopped = new Promise<void>(resolve => child.once('exit', () => resolve()));
    child.kill('SIGTERM');
    await stopped;
}
export async function localBackend(label: string) {
    const evidence = evidenceDirectory(process.env.EVIDENCE_DIR, true)!;
    await mkdir(evidence, { recursive: true });
    const directory = await mkdtemp(`${evidence}/backend-${label}-`);
    const port = await freePort();
    const sitePort = await freePort();
    for (const name of ['convex', 'lib', 'league']) await cp(resolve(name), `${directory}/${name}`, { recursive: true });
    await cp('package.json', `${directory}/package.json`);
    await symlink(resolve('node_modules'), `${directory}/node_modules`, 'dir');
    await writeFile(`${directory}/convex.json`, JSON.stringify({ functions: 'convex/' }));
    const environment: NodeJS.ProcessEnv = { PATH: process.env.PATH, NODE_ENV: 'test', CONVEX_AGENT_MODE: 'anonymous',
        AUCTION_CLI_HOME: `${directory}/cli-home`, CONVEX_DISABLE_TELEMETRY: '1' };
    await mkdir(`${directory}/cli-home`, { recursive: true });
    const cli = resolve('node_modules/convex/bin/main.js');
    const preload = resolve('scripts/local-cli.mjs');
    const child = spawn(process.execPath, ['--import', preload, cli, 'dev', '--typecheck', 'disable',
        '--codegen', 'disable', '--local-cloud-port', String(port), '--local-site-port', String(sitePort),
        '--tail-logs', 'disable'], { cwd: directory, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    child.stdout.on('data', data => { log += String(data); });
    child.stderr.on('data', data => { log += String(data); });
    const url = `http://127.0.0.1:${port}`;
    const client = new ConvexHttpClient(url);
    const close = async () => {
        await stopProcess(child);
        await writeFile(`${evidence}/backend-${label}.log`, log);
        await rm(directory, { recursive: true, force: true });
    };
    try {
        let ready = false;
        for (let attempt = 0; attempt < 600; attempt++) {
            if (child.exitCode !== null) throw new Error(`Local Convex exited ${child.exitCode}: ${log}`);
            try {
                await client.query(makeFunctionReference<'query'>('smoke:ping'), {});
                ready = true;
                break;
            } catch { await sleep(250); }
        }
        if (!ready) throw new Error(`Local Convex did not start: ${log}`);
        const configuration = JSON.parse(await readFile(`${directory}/.convex/local/default/config.json`, 'utf8'));
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
            if (code !== 0) throw new Error(`Local admin ${name} failed: ${error.replaceAll(configuration.adminKey, '[local key]')}`);
            return output.trim() ? JSON.parse(output) : null;
        };
        const identity = { mode: 'anonymous', version: configuration.backendVersion, url, port, sitePort,
            command: 'convex dev --typecheck disable --codegen disable', directory };
        await writeFile(`${evidence}/backend-${label}.json`, JSON.stringify(identity, null, 2));
        return { client, admin, close, url, identity };
    } catch (error) {
        await close();
        throw error;
    }
}
