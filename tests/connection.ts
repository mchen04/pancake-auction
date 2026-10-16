import { makeEvidenceDirectory as mkdir, writeEvidenceFile as writeFile, bundleEvidence } from '../scripts/evidence';
import { withResources, runBrowser, ownServer, listen } from '../scripts/resources';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import recorded from './fixtures/sleeper-pool.json';
import type { Player } from '../lib/types';
import { createIsolated, dropIsolated, seedManagers, seedPlayers, claimSeat, configure,
    currentBackend, getState, act, sleep } from './support';

const require = createRequire(resolve('package.json'));
const { build }: typeof import('esbuild') = require('esbuild');
const session = `pancake-connection-${crypto.randomUUID()}`;
const results: { name: string; result: string; error?: string }[] = [];
async function browser(...args: string[]) {
    return runBrowser(session,args,20000);
}
async function evaluate(expression: string) { return JSON.parse(await browser('eval', expression)); }
async function until(expression: string) {
    for (let attempt = 0; attempt < 100; attempt++) {
        if (await evaluate(expression)) return;
        await sleep(50);
    }
    throw new Error(`Browser condition did not become true: ${expression}`);
}
async function check(name: string, test: () => Promise<void>) {
    try { await test(); results.push({ name, result: 'passed' }); console.log(`PASS ${name}`); }
    catch (error) {
        results.push({ name, result: 'failed', error: error instanceof Error ? error.message : String(error) });
        console.log(`FAIL ${name}`);
    }
}
async function main() {
    const dir = `${process.env.EVIDENCE_DIR}/connection`;
    await mkdir(dir, { recursive: true });
    await bundleEvidence(build, { entryPoints: ['tests/connection-harness.tsx'], outfile: `${dir}/bundle.js`, bundle: true,
        platform: 'browser', format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } });
    const isolated = await createIsolated('test');
    await seedManagers();
    await seedPlayers(recorded.players.slice(0, 30) as Player[]);
    const token = await claimSeat(1);
    const server = ownServer(createServer(async (request, response) => {
        if (request.url === '/bundle.js') {
            response.setHeader('Content-Type', 'text/javascript');
            response.end(await readFile(`${dir}/bundle.js`));
        } else response.end('<!doctype html><html><body><div id="root"></div><script>window.roomConfig='
            + JSON.stringify({ url: currentBackend().url, token })
            + '</script><script src="/bundle.js"></script></body></html>');
    }));
    await listen(server, 0, '127.0.0.1');
    const address = server.address();
    assert(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    const open = async (mode: string) => { await browser('open', `${base}/?case=${mode}`); };
    try {
        await check('Cold load shows opening until its first connection', async () => {
            await open('cold');
            assert.equal(await evaluate('document.querySelector(".gate p")?.textContent'), 'Opening the draft room…');
            await until('window.transport.ready && window.transport.poolHeld');
            assert.equal(await evaluate('document.querySelector(".gate p")?.textContent'), 'Opening the draft room…');
        });
        await check('Previously connected loading client shows retrying after a drop', async () => {
            await open('cold');
            await until('window.transport.ready && window.transport.poolHeld');
            await browser('eval', 'window.transport.blocked = true; window.transport.sockets.at(-1).close(); true');
            await until('document.querySelector(".gate p")?.textContent.includes("Can’t reach")');
        });
        await check('Never-connected timeout eventually shows retrying', async () => {
            await open('unavailable');
            await sleep(10500);
            assert.equal(await evaluate('document.querySelector(".gate p")?.textContent'),
                'Can’t reach the draft room. Retrying…');
        });
        await check('Setup re-import keeps search, position filter and selected tab while the pool loads', async () => {
            await open('healthy');
            await browser('wait', '.room');
            await browser('fill', '[aria-label="Search players or team"]', 'keep this search');
            await browser('select', '[aria-label="Filter players by position"]', 'PG');
            await browser('click', '[role="tab"]:nth-child(2)');
            await browser('eval', 'window.transport.holdPools = true; true');
            await seedPlayers(recorded.players.slice(0, 31) as Player[]);
            await until('window.transport.poolHeld');
            const during = await evaluate(`({room: Boolean(document.querySelector('.room')),
                search: document.querySelector('input[type=search]')?.value,
                position: document.querySelector('[aria-label="Filter players by position"]')?.value,
                tab: document.querySelector('.room')?.dataset.tab})`);
            assert.deepEqual(during, { room: true, search: 'keep this search', position: 'PG', tab: 'teams' });
            await browser('eval', 'window.transport.holdPools = false; true');
            await until('!window.transport.poolHeld');
            assert.equal(await evaluate('document.querySelector("input[type=search]")?.value'), 'keep this search');
        });
        await configure({ draft: { status: 'running', phase: 'nomination', order: [1,2,3,4,5,6,7,8,9,10],
            nominatorId: 1, nominationMs: 600000 }, deadlineAfterMs: 600000 });
        await check('Pool loading preserves the typed opening bid and same-turn controls', async () => {
            await open('healthy');
            await browser('wait', '[aria-label="Opening bid"]');
            await browser('fill', '[aria-label="Opening bid"]', '23');
            await browser('eval', 'window.transport.holdPools = true; true');
            await currentBackend().admin('testOnly:refreshPoolRevision');
            await until('window.transport.poolHeld');
            assert.equal(await evaluate(`document.querySelector('[aria-label="Opening bid"]')?.value ?? null`), '23');
            await browser('eval', 'window.transport.holdPools = false; true');
            await until('!window.transport.poolHeld');
            assert.equal(await evaluate(`document.querySelector('[aria-label="Opening bid"]')?.value ?? null`), '23');
        });
        const state = await getState();
        await act({ type: 'nominate', playerId: state.players[0].id, amount: 1 }, token);
        const clockSample = async (selector = '.room .shot-clock .digits') => {
            const sample = await evaluate(`(() => {
                const displayed = document.querySelector(${JSON.stringify(selector)})?.textContent;
                const remaining = (${(await getState()).draft.deadline} - Date.now()) / 1000;
                return { displayed, remaining, errorSeconds: Math.abs(Number(displayed) - remaining) };
            })()`);
            assert(Number.isFinite(sample.errorSeconds), 'The real countdown must exist');
            assert(sample.remaining > 0 && sample.remaining < 10, 'The deadline must test sub-second rendering');
            return sample;
        };
        await check('Fresh clock negative control matches the real remaining time', async () => {
            await configure({ deadlineAfterMs: 9000 });
            await open('healthy');
            await browser('wait', '.bid-controls');
            const sample = await clockSample();
            assert.match(sample.displayed, /^\d+\.\d$/);
            assert(sample.errorSeconds <= 0.3);
        });
        await check('Stale cached query time cannot change the countdown on mount or reconnect', async () => {
            await configure({ deadlineAfterMs: 9000 });
            await open('stale');
            await browser('wait', '.bid-controls');
            await sleep(700);
            const mounted = await clockSample();
            assert.match(mounted.displayed, /^\d+\.\d$/);
            assert(mounted.errorSeconds <= 0.3, 'Mount must synchronize within 0.3 seconds');
            const calls = await evaluate('window.transport.syncCalls');
            assert(calls >= 1);
            const before = await getState();
            await browser('eval', 'window.transport.sockets.at(-1).close(); true');
            await until(`window.transport.syncCalls > ${calls}`);
            await sleep(500);
            const after = await getState();
            assert.equal(after.recentEvents[0].id, before.recentEvents[0].id, 'Reconnect makes no draft write');
            const samples = [];
            for (let index = 0; index < 3; index++) {
                const sample = await clockSample();
                assert.match(sample.displayed, /^\d+\.\d$/);
                assert(sample.errorSeconds <= 0.3, 'Reconnect must synchronize within 0.3 seconds');
                samples.push(sample);
                await sleep(120);
            }
            const cachedOffsetControl = await clockSample('.legacy-clock .digits');
            assert(cachedOffsetControl.errorSeconds > 59, 'The cached-offset control must fail the same tolerance');
            await writeFile(`${dir}/clock.json`, JSON.stringify({ staleQueryTime: await evaluate(
                'window.transport.cachedTimes.at(-1)'), syncCalls: await evaluate('window.transport.syncCalls'),
                toleranceSeconds: 0.3, mounted, reconnected: samples, cachedOffsetControl,
                noDraftWrites: true }, null, 2));
        });
        const otherToken = await claimSeat(2);
        await act({ type: 'bid', lotId: (await getState()).lot!.id, amount: 2 }, otherToken);
        await configure({ deadlineAfterMs: 120000 });
        await check('Ordinary same-lot updates preserve the custom bid (negative control)', async () => {
            await open('healthy');
            await browser('wait', '.bid-controls');
            await browser('fill', '[aria-label="Bid amount"]', '31');
            await claimSeat(3);
            assert.equal(await evaluate(`document.querySelector('[aria-label="Bid amount"]')?.value ?? null`), '31');
        });
        await check('Same-lot pool loading preserves the custom bid', async () => {
            await open('healthy');
            await browser('wait', '.bid-controls');
            await browser('fill', '[aria-label="Bid amount"]', '31');
            await browser('eval', 'window.transport.holdPools = true; true');
            await currentBackend().admin('testOnly:refreshPoolRevision');
            await until('window.transport.poolHeld');
            assert.equal(await evaluate(`document.querySelector('[aria-label="Bid amount"]')?.value ?? null`), '31');
            await browser('eval', 'window.transport.holdPools = false; true');
            await until('!window.transport.poolHeld');
            assert.equal(await evaluate(`document.querySelector('[aria-label="Bid amount"]')?.value ?? null`), '31');
        });
    } finally {
        try { await browser('close'); } finally {
            await new Promise<void>(resolve => server.close(() => resolve()));
            await dropIsolated(isolated);
            await writeFile(`${dir}/results.json`, JSON.stringify(results, null, 2));
        }
    }
    assert(results.every(result => result.result === 'passed'), 'Connection regressions must pass');
}
withResources(main).catch(error => { console.error(error); process.exitCode = 1; });
