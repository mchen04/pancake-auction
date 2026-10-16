import { makeEvidenceDirectory as mkdir, writeEvidenceFile as writeFile, bundleEvidence } from '../scripts/evidence';
import { withResources, runBrowser, ownServer, listen } from '../scripts/resources';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { createIsolated, dropIsolated, seedManagers, seedPlayers, claimSeat, configure,
    currentBackend, currentClient, getState, sleep } from './support';
import recorded from './fixtures/sleeper-pool.json';
import type { Action, Player } from '../lib/types';
import { api } from '../convex/_generated/api';

const execute = promisify(execFile);
const require = createRequire(resolve('package.json'));
const { build }: typeof import('esbuild') = require('esbuild');
const session = `pancake-turn-client-${crypto.randomUUID()}`;
const results: { name: string; result: string; proof?: unknown; error?: string }[] = [];
async function browser(...args: string[]) {
    return runBrowser(session,args,25000);
}
async function evaluate<T>(expression: string): Promise<T> { return JSON.parse(await browser('eval', expression)); }
async function until(expression: string, timeout = 12000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) { if (await evaluate<boolean>(expression)) return; await sleep(50); }
    throw new Error(`Not ready: ${expression}`);
}
async function check(name: string, run: () => Promise<unknown>) {
    const items = process.argv.find(arg => arg.startsWith('--items='))?.slice(8).split(',');
    if (items && !items.some(item => name.startsWith(item))) return;
    try { const proof = await run(); results.push({ name, result: 'passed', proof }); console.log(`PASS ${name}`); }
    catch (error) {
        results.push({ name, result: 'failed', error: String(error) }); console.log(`FAIL ${name}: ${error}`);
    }
}
async function main() {
    const evidence = `${process.env.EVIDENCE_DIR}/turn-client`;
    await mkdir(evidence, { recursive: true });
    await bundleEvidence(build, { entryPoints: ['tests/turn-client-harness.tsx'], outfile: `${evidence}/bundle.js`, bundle: true,
        format: 'iife', platform: 'browser', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } });
    const isolated = await createIsolated('test');
    await seedManagers(); await seedPlayers(recorded.players as Player[]);
    const token = await claimSeat(1);
    const otherToken = await claimSeat(2);
    let initial = await getState();
    let skew = 0;
    const server = ownServer(createServer(async (request, response) => {
        if (request.url === '/bundle.js') {
            response.setHeader('Content-Type', 'text/javascript');
            response.end(await readFile(`${evidence}/bundle.js`));
        } else {
            response.setHeader('Content-Type', 'text/html; charset=utf-8');
            response.end('<!doctype html><html><body><div id="root"></div><script>window.initial='
                + JSON.stringify(initial) + ';window.config='
                + JSON.stringify({ token, url: currentBackend().url, skew })
                + '</script><script src="/bundle.js"></script></body></html>');
        }
    }));
    await listen(server, 0, '127.0.0.1');
    const address = server.address();
    assert(address && typeof address !== 'string');
    const open = async (mode = 'components') => {
        await browser('open', `http://127.0.0.1:${address.port}/?mode=${mode}`);
        await browser('wait', mode === 'room' ? '.room' : '.commish');
    };
    const forceButton = '.commish button:nth-child(2)';
    const captureForce = async () => {
        initial = await getState(); await open();
        await browser('click', forceButton); await browser('click', forceButton);
        return (await evaluate<Action[]>('window.actions'))[0];
    };
    async function lot(id: number) {
        await configure({ lot: { id, playerId: recorded.players[0].id, nominatorId: 2,
            highBidderId: 2, highBid: 10, status: 'open' }, draft: { status: 'running', phase: 'bidding',
            lotId: id, nominatorId: 2, order: [1,2,3,4,5,6,7,8,9,10], turnIndex: 1 }, deadlineAfterMs: 60000 });
    }
    try {
        await lot(201);
        initial = await getState();
        await check('C22 same-lot winner and price change disarms Force', async () => {
            await open(); await browser('click', forceButton);
            const armed = await evaluate<string>(`document.querySelector('${forceButton}').textContent`);
            await evaluate(`window.replace({lot:{...window.initial.lot,highBidderId:3,highBid:20}});true`);
            await browser('click', forceButton);
            const actions = await evaluate<Action[]>('window.actions');
            await writeFile(`${evidence}/force-target.json`, JSON.stringify({ armed, actions }));
            assert.deepEqual(actions, []);
            return { armed, actions };
        });
        await check('C22 same-lot price change alone disarms Force', async () => {
            await open(); await browser('click', forceButton);
            await evaluate('window.replace({lot:{...window.initial.lot,highBid:11}});true');
            await browser('click', forceButton);
            assert.deepEqual(await evaluate('window.actions'), []);
        });
        await check('C22 changing lot identity still disarms Force', async () => {
            await open(); await browser('click', forceButton);
            await evaluate('window.replace({lot:{...window.initial.lot,id:202}});true');
            await browser('click', forceButton);
            assert.deepEqual(await evaluate('window.actions'), []);
        });
        await check('C22 a bid after target capture rejects Force atomically', async () => {
            const action = await captureForce();
            await currentClient().act({ type: 'bid', lotId: 201, amount: 20 }, token);
            const result = await currentClient().transport.mutation(api.auction.actOnDraft, { token, action });
            const state = await getState();
            await writeFile(`${evidence}/force-race.json`, JSON.stringify({ action, result, lot: state.lot }));
            assert(!result.ok && result.status === 409);
            assert.equal(state.lot?.highBid, 20); assert.equal(state.lot.highBidderId, 1);
            const priceTarget = await captureForce();
            await currentClient().act({ type: 'bid', lotId: 201, amount: 21 }, token);
            const priceResult = await currentClient().transport.mutation(api.auction.actOnDraft,
                { token, action: priceTarget });
            const priceState = await getState();
            assert(!priceResult.ok && priceResult.status === 409);
            assert.equal(priceState.lot?.highBid, 21); assert.equal(priceState.lot.highBidderId, 1);
            return { action, result, lot: state.lot, priceTarget, priceResult, priceLot: priceState.lot };
        });
        await lot(203);
        await check('C22 matching target sells while paused and authority remains enforced', async () => {
            const action = await captureForce();
            const denied = await currentClient().transport.mutation(api.auction.actOnDraft,
                { token: otherToken, action });
            assert(!denied.ok && denied.status === 403);
            await currentClient().act({ type: 'pause' }, token);
            await currentClient().act(action, token);
            const state = await getState();
            assert(state.roster.some(entry => entry.lotId === 203 && entry.price === 10));
            assert.equal(state.draft.status, 'paused');
            return { denied, sold: state.roster.find(entry => entry.lotId === 203) };
        });
        await check('C21 unsorted real pool preview matches the real scheduler timeout', async () => {
            await configure({ roster: [], draft: { status: 'running', phase: 'nomination',
                lotId: null, nominatorId: 1, turnIndex: 0 }, deadlineAfterMs: 3000 });
            initial = await getState(); await open();
            const hint = await evaluate<string>('document.querySelector(".nomination p").textContent');
            await sleep(3500);
            const state = await getState();
            const actual = state.lot!.player!.name;
            await writeFile(`${evidence}/timeout-preview.json`, JSON.stringify({ hint, actual }));
            assert(hint.includes(actual), `${hint} must name ${actual}`);
            return { hint, actual };
        });
        await lot(205);
        async function clockSample() {
            const state = await getState();
            return evaluate<{ shown: string; actual: number; error: number }>(`(() => {
                const shown = document.querySelector('.bid-controls .digits').textContent;
                const actual = (${state.draft.deadline} - window.control.nativeNow()) / 1000;
                return {shown,actual,error:Math.abs(Number(shown)-actual)};
            })()`);
        }
        await check('C20 fresh clock control stays within 0.3 seconds', async () => {
            await configure({ deadlineAfterMs: 9000 }); await open('room'); await sleep(250);
            const sample = await clockSample();
            assert.match(sample.shown, /^\d+\.\d$/); assert(sample.error <= 0.3);
            return sample;
        });
        await check('C20 delayed ordered transitions cannot resample the clock from a bid promise', async () => {
            await configure({ deadlineAfterMs: 12000 }); await open('room'); await sleep(250);
            await evaluate('window.control.delay=6000;true');
            await browser('click', '.bid-controls .bid-buttons button:first-child');
            await until('window.control.events.some(e=>e.type==="received"&&e.path==="auction:actOnDraft")');
            await evaluate('window.dispatchEvent(new Event("focus"));true');
            await until('window.control.events.some(e=>e.type==="transitions-released")');
            await sleep(1300);
            const sample = await clockSample();
            const events = await evaluate<{ type: string; at: number }[]>('window.control.events');
            await writeFile(`${evidence}/clock-transition.json`, JSON.stringify({ sample, events, tolerance: 0.3 }));
            assert.match(sample.shown, /^\d+\.\d$/);
            assert(sample.error <= 0.3, `Delayed transition clock error ${sample.error} exceeds 0.3 seconds`);
            const received = events.find(e => e.type === 'received' && 'path' in e && e.path === 'auction:actOnDraft')!;
            const released = events.find(e => e.type === 'transitions-released')!;
            assert(released.at - received.at >= 5900);
            assert(events.some(e => e.type === 'http-clock' && e.at > received.at && e.at < released.at),
                'A real HTTP clock sample completes without the held WebSocket transition');
            return { sample, events, tolerance: 0.3 };
        });
        await check('C20 local clock skew control stays within 0.3 seconds', async () => {
            skew = 120000;
            await configure({ deadlineAfterMs: 9000 }); await open('room'); await sleep(350);
            const sample = await clockSample();
            assert.match(sample.shown, /^\d+\.\d$/); assert(sample.error <= 0.3);
            skew = 0;
            return sample;
        });
        assert.equal(await browser('errors'), '');
    } finally {
        try {
            await browser('close');
            for (let i = 0; ; i++) {
                if (!(await execute('agent-browser', ['session', 'list'])).stdout.includes(session)) break;
                assert(i < 100); await sleep(50);
            }
        } finally {
            await new Promise<void>(resolve => server.close(() => resolve())); await dropIsolated(isolated);
            await writeFile(`${evidence}/results.json`, JSON.stringify(results, null, 2));
        }
    }
    assert(results.every(result => result.result === 'passed'), 'Every client boundary check must pass');
}
withResources(main).catch(error => { console.error(error); process.exitCode = 1; });
