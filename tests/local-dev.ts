import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ConvexHttpClient } from 'convex/browser';
import { makeFunctionReference } from 'convex/server';
import { api } from '../convex/_generated/api';
import { runAdmin } from '../scripts/admin-client';
import { evidenceDirectory } from '../scripts/evidence';
import { freePort, requireClosedPort, sleep } from '../scripts/local-backend';

async function main() {
    const root = evidenceDirectory(process.env.EVIDENCE_DIR, true)!;
    await mkdir(root, { recursive: true });
    const directory = await mkdtemp(`${root}/local-workflow-`);
    const port = await freePort();
    const sitePort = await freePort();
    assert(![3210, 3211, 3100, 3220, 3221, 3917].includes(port));
    assert(![3210, 3211, 3100, 3220, 3221, 3917].includes(sitePort));
    const client = new ConvexHttpClient(`http://127.0.0.1:${port}`);
    const ping = makeFunctionReference<'query'>('smoke:ping');
    const proof: Record<string, unknown> = { name: 'Documented local command serves and preserves data after restart',
        port, sitePort, result: 'failed' };
    let child: ChildProcess | undefined;
    let log = '';
    const stop = async () => {
        if (child && child.exitCode === null && child.signalCode === null) {
            const exited = new Promise(resolve => child!.once('exit', resolve));
            process.kill(-child.pid!, 'SIGINT');
            await exited;
        }
        await Promise.all([requireClosedPort(port), requireClosedPort(sitePort)]);
    };
    const start = async () => {
        child = spawn('npm', ['run', 'backend:local'], { cwd: directory, detached: true,
            env: { PATH: process.env.PATH, NODE_ENV: 'test', CONVEX_LOCAL_CLOUD_PORT: String(port),
                CONVEX_LOCAL_SITE_PORT: String(sitePort) }, stdio: ['ignore', 'pipe', 'pipe'] });
        child.stdout!.on('data', data => { log += String(data); });
        child.stderr!.on('data', data => { log += String(data); });
        for (let attempt = 0; attempt < 600; attempt++) {
            if (child.exitCode !== null) throw new Error(`Documented command exited ${child.exitCode}: ${log}`);
            try { await client.query(ping, {}); return; } catch { await sleep(250); }
        }
        throw new Error('Documented local command did not serve');
    };
    const previousDirectory = process.env.CONVEX_LOCAL_DIR;
    try {
        for (const name of ['convex', 'lib', 'scripts', 'league']) {
            await cp(resolve(name), `${directory}/${name}`, { recursive: true });
        }
        await cp('package.json', `${directory}/package.json`);
        await symlink(resolve('node_modules'), `${directory}/node_modules`, 'dir');
        const cache = resolve('.convex/backend-binary-cache');
        await mkdir(cache, { recursive: true });
        await mkdir(`${directory}/.convex/cli-home/.cache`, { recursive: true });
        await symlink(cache, `${directory}/.convex/cli-home/.cache/convex`, 'dir');
        await start();
        assert.equal((await client.query(api.auction.state, {})).managers.length, 0);
        proof.freshDataControl = true;
        const frontend = await readFile(`${directory}/.env.local`, 'utf8');
        assert(frontend.includes(`NEXT_PUBLIC_CONVEX_URL=http://127.0.0.1:${port}`));
        proof.frontendUrlWritten = true;
        process.env.CONVEX_LOCAL_DIR = `${directory}/.convex/local/default`;
        await runAdmin('admin:managers');
        const claimed = await client.mutation(api.auction.claimSeat, { managerId: 1 });
        assert(claimed.ok);
        await stop();
        await assert.rejects(client.query(ping, {}));
        proof.stoppedConnectionControl = true;
        await start();
        const restored = await client.query(api.auction.state, { token: claimed.value });
        assert.equal(restored.managers.length, 10);
        assert.equal(restored.me, 1);
        assert.equal(restored.managers[0].name, 'Michael');
        proof.restartPreservesDataAndIdentity = true;
        proof.result = 'passed';
        console.log(`PASS ${proof.name}`);
    } catch (error) {
        proof.error = error instanceof Error ? error.message : String(error);
        throw error;
    } finally {
        if (previousDirectory === undefined) delete process.env.CONVEX_LOCAL_DIR;
        else process.env.CONVEX_LOCAL_DIR = previousDirectory;
        await stop();
        proof.nativePortsClosed = true;
        await rm(directory, { recursive: true, force: true });
        proof.directoryRemoved = true;
        await writeFile(`${root}/local-workflow.log`, log);
        await writeFile(`${root}/local-workflow.json`, JSON.stringify(proof, null, 2));
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
