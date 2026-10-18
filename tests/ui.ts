import { makeEvidenceDirectory as mkdir, writeEvidenceFile as writeFile, bundleEvidence } from '../scripts/evidence';
import { withResources, runBrowser, ownServer, listen } from '../scripts/resources';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

import { roomFixture } from './room-fixture';
import {
    createIsolated, dropIsolated, seedManagers, seedPlayers, claimSeat, configure, currentBackend, getState, act
} from './support';

const require = createRequire(resolve('package.json'));
const { build }: typeof import('esbuild') = require('esbuild');
const results: { name: string; result: string; error?: string }[] = [];
const session = `pancake-review-${randomBytes(6).toString('hex')}`;
async function browser(...args: string[]) {
    return runBrowser(session,args,20000);
}
async function evaluate(expression: string) {
    return JSON.parse(await browser('eval', expression));
}
async function check(name: string, test: () => Promise<void>) {
    try { await test(); results.push({ name, result: 'passed' }); console.log(`PASS ${name}`); }
    catch (error) {
        results.push({ name, result: 'failed', error: error instanceof Error ? error.message : String(error) });
        console.error(`FAIL ${name}`);
    }
}
async function main() {
    const root = process.env.EVIDENCE_DIR;
    if (!root) throw new Error('Set EVIDENCE_DIR');
    const dir = `${root}/ui-regressions`;
    await mkdir(dir, { recursive: true });
    await bundleEvidence(build, { entryPoints: ['tests/ui-harness.tsx'], outfile: `${dir}/bundle.js`, bundle: true,
        platform: 'browser', format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } });
    const isolated = await createIsolated('test');
    await seedManagers(); await act({ type: 'mode', mode: 'live-v1' }, 'seat:1');
    const initial = roomFixture();
    await seedPlayers(initial.players.slice(0, 1));
    const tokens = await Promise.all(initial.managers.map(manager => claimSeat(manager.id)));
    await configure({ draft: { nominationMs: 600000, biddingMs: 600000 } });
    const added = { ...initial.players[1], id: 'review-new', name: 'Review Added Player' };
    const server = ownServer(createServer(async (request, response) => {
        if (request.url?.startsWith('/fixture/')) {
            if (request.url.endsWith('replace')) await seedPlayers([initial.players[0], added]);
            if (request.url.endsWith('live')) {
                await act({ type: 'start' }, tokens[0]);
                const state = await getState();
                await act({ type: 'nominate', playerId: added.id, amount: 1 }, tokens[state.draft.nominatorId! - 1]);
            }
            if (request.url.endsWith('win')) {
                const state = await getState();
                if (state.lot!.highBidderId !== 1) await act({ type: 'bid', lotId: state.lot!.id, amount: 2 }, tokens[0]);
                await act({ type: 'force', lotId: state.lot!.id }, tokens[0]);
            }
            response.end('{}');
        } else if (request.url === '/bundle.js') {
            response.setHeader('Content-Type', 'text/javascript');
            response.end(await readFile(`${dir}/bundle.js`));
        } else response.end('<!doctype html><html><body>'
            + '<div id="root"></div><script>window.roomConfig='
            + JSON.stringify({ url: currentBackend().url, token: tokens[0] })
            + '</script><script src="/bundle.js"></script></body></html>');
    }));
    await listen(server, 0, '127.0.0.1');
    const address = server.address();
    assert(address && typeof address === 'object');
    const base = `http://127.0.0.1:${address.port}`;
    const open = async (mode: string) => { await browser('open', `${base}/?case=${mode}`); };
    const input = () => evaluate('document.querySelector(".custom input")?.value');
    const actions = () => evaluate('window.testActions');
    try {
        await check('B4/C9 direct lot A to B clears custom amount and cannot submit A amount', async () => {
            await open('bid');
            await browser('fill', '[aria-label="Bid amount"]', '900');
            assert.equal(await input(), '900');
            await browser('click', '#lot-b');
            await browser('focus', '[aria-label="Bid amount"]');
            await browser('press', 'Enter');
            const proof = { value: await input(), actions: await actions() };
            await writeFile(`${dir}/direct-lot.json`, JSON.stringify(proof));
            assert.equal(proof.value, '');
            assert.deepEqual(proof.actions, []);
        });
        await check('B4/C9 nomination-gap negative control clears the custom amount', async () => {
            await open('bid');
            await browser('fill', '[aria-label="Bid amount"]', '900');
            await browser('click', '#gap');
            await browser('click', '#lot-b');
            assert.equal(await input(), '');
        });
        await check('B4/C9 unchanged-lot negative control submits the entered amount', async () => {
            await open('bid');
            await browser('fill', '[aria-label="Bid amount"]', '900');
            await browser('press', 'Enter');
            assert.deepEqual(await actions(), [{ type: 'bid', lotId: 101, amount: 900 }]);
        });
        await check('S5/C10 changed Force target disarms through the nomination gap', async () => {
            await open('confirm');
            await browser('click', '.commish button:nth-child(2)');
            await browser('click', '#gap');
            assert.equal(await evaluate('document.querySelector(".commish button:nth-child(2)").disabled'), true);
            await browser('click', '#lot-b');
            await browser('click', '.commish button:nth-child(2)');
            assert.deepEqual(await actions(), []);
        });
        await check('S5/C10 changed Undo target disarms before its first click', async () => {
            await open('confirm');
            await browser('click', '.commish button:first-child');
            await browser('click', '#sale-b');
            await browser('click', '.commish button:first-child');
            assert.deepEqual(await actions(), []);
            await browser('click', '.commish button:first-child');
            assert.deepEqual(await actions(), [{ type: 'undo', lotId: 91 }]);
        });
        await check('S5/C10 unchanged Force target still requires two clicks', async () => {
            const fixture = roomFixture('live-v1');
            const lot = fixture.lot!;
            const name = fixture.managers.find(manager => manager.id === lot.highBidderId)!.name;
            await open('confirm');
            await browser('click', '.commish button:nth-child(2)');
            assert.deepEqual(await actions(), []);
            assert.equal(await evaluate('document.querySelector(".commish button:nth-child(2)").textContent'),
                `Sell to ${name} $${lot.highBid}?`);
            await browser('click', '.commish button:nth-child(2)');
            assert.deepEqual(await actions(), [{ type: 'force', lotId: lot.id,
                expectedHighBidderId: lot.highBidderId, expectedHighBid: lot.highBid }]);
        });
        for (const change of ['amount', 'leader'] as const) {
            await check(`S5/C10 changed Force ${change} requires confirmation of the new target`, async () => {
                const fixture = roomFixture('live-v1');
                const lot = fixture.lot!;
                const amount = lot.highBid + Number(change === 'amount');
                const leader = change === 'leader' ? 3 : lot.highBidderId;
                const name = fixture.managers.find(manager => manager.id === leader)!.name;
                await open('confirm');
                await browser('click', '.commish button:nth-child(2)');
                await browser('click', change === 'amount' ? '#raise-bid' : '#new-leader');
                assert.equal(await evaluate('document.querySelector(".commish button:nth-child(2)").getAttribute("aria-label")'), 'Force end');
                await browser('click', '.commish button:nth-child(2)');
                assert.deepEqual(await actions(), []);
                assert.equal(await evaluate('document.querySelector(".commish button:nth-child(2)").textContent'),
                    `Sell to ${name} $${amount}?`);
                await browser('click', '.commish button:nth-child(2)');
                assert.deepEqual(await actions(), [{ type: 'force', lotId: lot.id,
                    expectedHighBidderId: leader, expectedHighBid: amount }]);
            });
        }
        await check('S5/C10 confirmation timeout negative control disarms after four seconds', async () => {
            await open('confirm');
            await browser('click', '.commish button:nth-child(2)');
            await browser('wait', '4100');
            await browser('click', '.commish button:nth-child(2)');
            assert.deepEqual(await actions(), []);
        });
        await check('B2/C2 setup import refreshes the open Room and a newly won roster player', async () => {
            await open('room');
            await browser('wait', '.room');
            await browser('click', '#replace');
            await browser('wait', '700');
            const poolVisible = await evaluate(
                'document.querySelector(".pool")?.innerText.includes("Review Added Player")'
            );
            assert.equal(poolVisible, true);
            await browser('click', '#live');
            await browser('wait', '700');
            assert.equal(await evaluate('Boolean(document.querySelector(".bid-controls"))'), true);
            await browser('click', '#win');
            await browser('wait', '700');
            const wonVisible = await evaluate(
                'document.querySelector(".roster")?.innerText.includes("Review Added Player")'
            );
            assert.equal(wonVisible, true);
            await writeFile(`${dir}/pool-refresh-requests.json`, JSON.stringify(await evaluate('window.testRequests')));
        });
        await check('C7 ADP sorts ranked players before unranked and shows the provider tooltip', async () => {
            await open('adp');
            await browser('click', '[title="Sleeper dynasty ADP"]');
            const names = await evaluate('Array.from(document.querySelectorAll(".name-button"), el => el.textContent)');
            assert.deepEqual(names, ['ADP 1.3', 'ADP 699', 'ADP 0', 'ADP 999']);
            const unknown = await evaluate(`document.querySelectorAll('[title="Unranked by Sleeper"]').length`);
            assert.equal(unknown, 2);
        });
        await writeFile(`${dir}/snapshot.txt`, await browser('snapshot'));
        await writeFile(`${dir}/errors.log`, await browser('errors'));
    } finally {
        try { await browser('close'); } finally {
            await new Promise<void>(resolve => server.close(() => resolve()));
            await dropIsolated(isolated);
            await writeFile(`${dir}/results.json`, JSON.stringify(results, null, 2));
        }
    }
    assert(results.every(result => result.result === 'passed'), 'Browser regression tests must pass');
}
withResources(main).catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
