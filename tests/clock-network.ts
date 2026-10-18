import { act } from './support';
import { makeEvidenceDirectory as mkdir, writeEvidenceFile as writeFile, bundleEvidence } from '../scripts/evidence';
import { withResources, runBrowser, ownServer, listen } from '../scripts/resources';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { connect, createServer as createTcpServer, type Socket } from 'node:net';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import recorded from './fixtures/sleeper-pool.json';
import type { Player } from '../lib/types';
import { createIsolated, dropIsolated, seedManagers, seedPlayers, claimSeat, configure,
    currentBackend, getState, sleep } from './support';
import { requireClosedPort } from '../scripts/local-backend';

const require = createRequire(resolve('package.json'));
const { build }: typeof import('esbuild') = require('esbuild');
const session = `pancake-clock-network-${crypto.randomUUID()}`;
const results: { name: string; result: string; proof?: unknown; error?: string }[] = [];
async function browser(...args: string[]) {
    return runBrowser(session,args,20000);
}
async function evaluate<T>(expression: string): Promise<T> { return JSON.parse(await browser('eval', expression)); }
async function check(name: string, run: () => Promise<unknown>) {
    try { const proof = await run(); results.push({ name, result: 'passed', proof }); console.log(`PASS ${name}`); }
    catch (error) { results.push({ name, result: 'failed', error: String(error) }); console.log(`FAIL ${name}: ${error}`); }
}
async function main() {
    const evidence = `${process.env.EVIDENCE_DIR}/clock-network`;
    await mkdir(evidence, { recursive: true });
    await bundleEvidence(build, { entryPoints: ['tests/clock-network-harness.tsx'], outfile: `${evidence}/bundle.js`, bundle: true,
        format: 'iife', platform: 'browser', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } });
    const isolated = await createIsolated('test');
    let token = '';
    let skew = 0;
    let disableTimeout = false;
    let blocked = false;
    const sockets = new Set<Socket>();
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const traffic: { method: string; at: number }[] = [];
    const proxy = ownServer(createTcpServer(downstream => {
        const upstream = connect(Number(new URL(currentBackend().url).port), '127.0.0.1');
        for (const socket of [upstream, downstream]) {
            sockets.add(socket);
            socket.on('error', () => { upstream.destroy(); downstream.destroy(); });
            socket.on('close', () => { sockets.delete(socket); });
        }
        downstream.on('end', () => upstream.end());
        upstream.on('end', () => downstream.end());
        function forward(data: Buffer, target: Socket) {
            if (blocked) return;
            const timer = setTimeout(() => {
                timers.delete(timer);
                if (!target.destroyed) target.write(data);
            }, 200);
            timers.add(timer);
        }
        downstream.on('data', data => {
            const method = /^(OPTIONS|POST) /u.exec(data.toString())?.[1];
            if (method) traffic.push({ method, at: Date.now() });
            forward(data, upstream);
        });
        upstream.on('data', data => forward(data, downstream));
    }));
    await listen(proxy, 0, '127.0.0.1');
    const proxyAddress = proxy.address();
    assert(proxyAddress && typeof proxyAddress !== 'string');
    const server = ownServer(createServer(async (request, response) => {
        if (request.url === '/bundle.js') {
            response.setHeader('Content-Type', 'text/javascript');
            response.end(await readFile(`${evidence}/bundle.js`));
        } else response.end('<!doctype html><html><body><div id="root"></div><script>window.config='
            + JSON.stringify({ url: currentBackend().url, token, skew, disableTimeout,
                proxyUrl: `http://127.0.0.1:${proxyAddress.port}` })
            + '</script><script src="/bundle.js"></script></body></html>');
    }));
    await listen(server, 0, '127.0.0.1');
    const address = server.address();
    assert(address && typeof address !== 'string');
    const frontendPort = address.port;
    async function open(deviceSkew: number, legacySafari = false) {
        skew = deviceSkew;
        disableTimeout = legacySafari;
        await configure({ deadlineAfterMs: 9000 });
        await browser('open', `http://127.0.0.1:${frontendPort}/`);
        await browser('wait', '.room');
    }
    async function sample() {
        const state = await getState();
        return evaluate<{ shown: string; actual: number; error: number; status: string;
            responses: number; offsets: number[] }>(`(() => {
            const shown = document.querySelector('.shot-clock .digits').textContent;
            const actual = (${state.draft.deadline} - window.clockNetwork.nativeNow()) / 1000;
            return {shown,actual,error:Math.abs(Number(shown)-actual),
                status:document.querySelector('.room').dataset.clockStatus,
                responses:window.clockNetwork.responses,offsets:window.clockNetwork.offsets};
        })()`);
    }
    try {
        await seedManagers(); await act({ type: 'mode', mode: 'live-v1' }, 'seat:1'); await seedPlayers(recorded.players as Player[]); token = await claimSeat(1);
        await configure({ draft: { status: 'running', phase: 'nomination',
            order: [1,2,3,4,5,6,7,8,9,10], nominatorId: 1, turnIndex: 0 } });
        await check('Clock accepts provisional samples with 400 ms network RTT and real CORS preflight', async () => {
            await open(0); await sleep(2000);
            const proof = await sample();
            assert(proof.error <= 0.35, JSON.stringify(proof));
            assert.equal(proof.status, 'provisional', 'A zero-skew clock must actually accept a sample');
            assert(proof.responses >= 2, 'The warm-up and a later real sample must finish');
            assert(traffic.some(entry => entry.method === 'OPTIONS'), 'The real browser must preflight the POST');
            return { ...proof, toleranceSeconds: 0.35, networkDelayPerDirectionMs: 200, traffic: [...traffic] };
        });
        await check('Clock corrects a skewed device over 400 ms RTT', async () => {
            await open(120000); await sleep(2000);
            const proof = await sample();
            assert(proof.error <= 0.35, JSON.stringify(proof));
            assert.equal(proof.status, 'provisional');
            assert(proof.offsets.some(offset => Math.abs(offset + 120000) < 350));
            return { ...proof, toleranceSeconds: 0.35, deviceSkewMs: 120000 };
        });
        await check('Clock works without AbortSignal.timeout', async () => {
            await open(120000, true); await sleep(2000);
            const proof = await sample();
            assert(proof.error <= 0.35, JSON.stringify(proof));
            assert.equal(proof.status, 'provisional');
            return proof;
        });
        await check('Clock failures stay visible and recover through bounded backoff', async () => {
            blocked = true;
            await open(120000); await sleep(8000);
            const message = await evaluate<string>('document.querySelector(".clock-status")?.textContent');
            assert.equal(message, 'Clock not synced. Retrying…');
            blocked = false;
            for (let attempt = 0; attempt < 80; attempt++) {
                const status = await evaluate<string>('document.querySelector(".room").dataset.clockStatus');
                if (status === 'provisional') break;
                await sleep(200);
            }
            await configure({ deadlineAfterMs: 9000 }); await sleep(200);
            const proof = await sample();
            assert.equal(proof.status, 'provisional'); assert(proof.error <= 0.35, JSON.stringify(proof));
            return { message, ...proof, toleranceSeconds: 0.35 };
        });
        assert.equal(await browser('errors'), '');
    } finally {
        try { await browser('close'); } finally {
            for (const timer of timers) clearTimeout(timer);
            for (const socket of sockets) socket.destroy();
            await Promise.all([new Promise<void>(resolve => proxy.close(() => resolve())),
                new Promise<void>(resolve => server.close(() => resolve()))]);
            await Promise.all([requireClosedPort(proxyAddress.port), requireClosedPort(address.port)]);
            await dropIsolated(isolated);
            await writeFile(`${evidence}/results.json`, JSON.stringify(results, null, 2));
            await writeFile(`${evidence}/cleanup.json`, JSON.stringify({ browserClosed: true,
                proxyPort: proxyAddress.port, frontendPort: address.port, listenersClosed: true }));
        }
    }
    assert(results.every(result => result.result === 'passed'), 'Network clock regressions must pass');
}
withResources(main).catch(error => { console.error(error); process.exitCode = 1; });
