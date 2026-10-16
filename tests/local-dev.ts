import { mkdir as mkdirCache } from 'node:fs/promises';
import {
    copyEvidence as cp, makeEvidenceDirectory as mkdir, makeEvidenceTemporaryDirectory as mkdtemp,
    writeEvidenceFile as writeFile
} from '../scripts/evidence';
import { withResources, ownProcess, ownCleanup, stopOwnedProcess } from '../scripts/resources';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { rm, stat, symlink, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ConvexHttpClient } from 'convex/browser';
import { makeFunctionReference } from 'convex/server';
import { api } from '../convex/_generated/api';
import { isolatedBackendVersion } from '../scripts/local-version';
import { runAdmin } from '../scripts/admin-client';
import { evidenceDirectory } from '../scripts/evidence';
import { freePort, requireClosedPort, sleep } from '../scripts/local-backend';

async function main() {
    const root = evidenceDirectory(process.env.EVIDENCE_DIR, true)!;
    await mkdir(root, { recursive: true });
    const directory = await mkdtemp(`${root}/local-workflow-`);
    ownCleanup(async () => { await rm(directory, { recursive: true, force: true }); });
    const port = await freePort();
    const sitePort = await freePort();
    assert(![3210, 3211, 3100, 3220, 3221, 3917].includes(port));
    assert(![3210, 3211, 3100, 3220, 3221, 3917].includes(sitePort));
    const client = new ConvexHttpClient(`http://127.0.0.1:${port}`);
    const ping = makeFunctionReference<'query'>('smoke:ping');
    const proof: Record<string, unknown> = { name: 'Documented local command serves and preserves data after restart',
        port, sitePort, result: 'failed' };
    let child: ChildProcess | undefined;
    let frontend: ChildProcess | undefined;
    let log = '';
    let frontendLog = '';
    const stop = async () => {
        if (child) await stopOwnedProcess(child);
        await Promise.all([requireClosedPort(port), requireClosedPort(sitePort)]);
    };
    const start = async () => {
        child = ownProcess(spawn('npm', ['run', 'backend:local'], { cwd: directory, detached: true,
            env: { PATH: process.env.PATH, NODE_ENV: 'test', CONVEX_LOCAL_CLOUD_PORT: String(port),
                CONVEX_LOCAL_SITE_PORT: String(sitePort), CONVEX_LOCAL_BACKEND_VERSION: isolatedBackendVersion },
            stdio: ['ignore', 'pipe', 'pipe'] }), 'SIGTERM', true);
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
        for (const name of ['app', 'convex', 'lib', 'scripts', 'league']) {
            await cp(resolve(name), `${directory}/${name}`, { recursive: true });
        }
        for (const name of ['next.config.ts', 'tsconfig.json', 'next-env.d.ts']) {
            await cp(name, `${directory}/${name}`);
        }
        await cp('package.json', `${directory}/package.json`);
        await symlink(resolve('node_modules'), `${directory}/node_modules`, 'dir');
        const cache = resolve('.convex/backend-binary-cache');
        await mkdirCache(cache, { recursive: true });
        await mkdir(`${directory}/.convex/cli-home/.cache`, { recursive: true });
        await symlink(cache, `${directory}/.convex/cli-home/.cache/convex`, 'dir');
        await start();
        assert.equal((await client.query(api.auction.state, {})).managers.length, 0);
        proof.freshDataControl = true;
        assert((await stat(`${directory}/.env.local`)).size > 0);
        const frontendPort = await freePort();
        proof.frontendPort = frontendPort;
        frontend = ownProcess(spawn('npm', ['run', 'dev', '--', '--webpack', '--port', String(frontendPort)],
            { cwd: directory, detached: true, env: { PATH: process.env.PATH, NODE_ENV: 'development' },
                stdio: ['ignore', 'pipe', 'pipe'] }), 'SIGTERM', true);
        frontend.stdout!.on('data', data => { frontendLog += String(data); });
        frontend.stderr!.on('data', data => { frontendLog += String(data); });
        let frontendLoadedUrl = false;
        for (let attempt = 0; attempt < 120; attempt++) {
            if (frontend.exitCode !== null) throw new Error('The documented Next command exited');
            try {
                const response = await fetch(`http://127.0.0.1:${frontendPort}`);
                frontendLoadedUrl = response.ok && (await response.text()).includes(`http://127.0.0.1:${port}`);
            } catch {}
            if (frontendLoadedUrl) break;
            await sleep(250);
        }
        assert(frontendLoadedUrl, 'Next must load the generated frontend URL without an injected URL');
        const configuration = JSON.parse(await readFile(`${directory}/.convex/local/default/config.json`, 'utf8'));
        assert.equal(configuration.backendVersion, isolatedBackendVersion);
        proof.backendVersion = configuration.backendVersion;
        proof.frontendUrlWritten = true;
        proof.nextLoadedGeneratedUrl = true;
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
        if (frontend) {
            await stopOwnedProcess(frontend);
            await requireClosedPort(proof.frontendPort as number);
        }
        await stop();
        proof.nativePortsClosed = true;
        await rm(directory, { recursive: true, force: true });
        proof.directoryRemoved = true;
        await writeFile(`${root}/local-workflow.log`, log);
        await writeFile(`${root}/local-frontend.log`, frontendLog);
        await writeFile(`${root}/local-workflow.json`, JSON.stringify(proof, null, 2));
    }
}
withResources(main).catch(error => { console.error(error); process.exitCode = 1; });
