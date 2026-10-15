import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { basename } from 'node:path';
import { localBackend, requireClosedPort, sleep } from '../scripts/local-backend';

function listening(port: number): Promise<boolean> {
    return new Promise((resolve, reject) => {
        const socket = createConnection({ host: '127.0.0.1', port });
        socket.once('connect', () => { socket.destroy(); resolve(true); });
        socket.once('error', error => {
            socket.destroy();
            if ('code' in error && error.code === 'ECONNREFUSED') resolve(false);
            else reject(error);
        });
        socket.setTimeout(2000, () => { socket.destroy(); reject(new Error('Listener probe timed out')); });
    });
}
async function delayedShutdownControl() {
    const server = createServer();
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert(address && typeof address !== 'string');
    const port = address.port;
    const before = await listening(port);
    assert.equal(before, true, 'The listener remains open before its delayed shutdown');
    const started = Date.now();
    const stop = setTimeout(() => server.close(), 250);
    try {
        await requireClosedPort(port);
        const elapsedMs = Date.now() - started;
        assert(elapsedMs >= 200, 'Shutdown must await the actual listener instead of the parent exit');
        const after = await listening(port);
        assert.equal(after, false);
        return { before, after, elapsedMs, result: 'passed' };
    } finally {
        clearTimeout(stop);
        if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    }
}
async function main() {
    const waitControl = await delayedShutdownControl();
    const backend = await localBackend('teardown');
    const ports = [backend.identity.port, backend.identity.sitePort];
    const pids = [...new Set(ports.flatMap(port => execFileSync('/usr/sbin/lsof',
        ['-t', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).trim().split('\n').map(Number)))];
    const listeners = pids.map(pid => ({ pid, executable: execFileSync('ps', ['-p', String(pid), '-o', 'comm='],
        { encoding: 'utf8' }).trim() }));
    const owned = listeners.filter(process_ => basename(process_.executable) === 'convex-local-backend'
        && (process_.executable.startsWith(backend.identity.directory + '/')
            || process_.executable.includes('/.convex/backend-binary-cache/')));
    const proof: Record<string, unknown> = { name: 'Native backend shutdown closes both listener ports', waitControl };
    let closed = false;
    try {
        assert.equal(owned.length, listeners.length);
        proof.before = await Promise.all(ports.map(listening));
        assert.deepEqual(proof.before, [true, true], 'Live listeners are the negative control');
        await backend.close();
        closed = true;
        proof.after = await Promise.all(ports.map(listening));
        assert.deepEqual(proof.after, [false, false]);
        proof.result = 'passed';
        console.log(`PASS ${proof.name}`);
    } catch (error) {
        proof.result = 'failed';
        proof.error = error instanceof Error ? error.message : String(error);
        throw error;
    } finally {
        if (!closed) await backend.close();
        for (const process_ of owned) {
            const current = spawnSync('ps', ['-p', String(process_.pid), '-o', 'comm='], { encoding: 'utf8' });
            if (current.status !== 0 || current.stdout.trim() !== process_.executable) continue;
            try { process.kill(process_.pid, 'SIGTERM'); }
            catch (error) { if (!(error instanceof Error) || !('code' in error) || error.code !== 'ESRCH') throw error; }
        }
        for (let attempt = 0; attempt < 100 && (await Promise.all(ports.map(listening))).some(Boolean); attempt++) {
            await sleep(100);
        }
        proof.listenersAfterCleanup = await Promise.all(ports.map(listening));
        await writeFile(`${process.env.EVIDENCE_DIR}/teardown.json`, JSON.stringify(proof, null, 2));
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
