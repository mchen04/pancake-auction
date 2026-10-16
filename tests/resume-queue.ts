import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { makeEvidenceDirectory, writeEvidenceFile, bundleEvidence } from '../scripts/evidence';
import { withResources, runBrowser, ownServer, listen } from '../scripts/resources';
import { localBackend, sleep } from '../scripts/local-backend';
import { AuctionClient } from '../lib/client';
import { syntheticPool } from './support';
import { api } from '../convex/_generated/api';

const root = `${process.env.EVIDENCE_DIR}/resume-queue`;
const session = `pancake-pause-${crypto.randomUUID()}`;
const results: Record<string, unknown>[] = [];
const browser = (...args: string[]) => runBrowser(session, args, 20000);
const evaluate = async (value: string) => JSON.parse(await browser('eval', value));
async function until(check: () => Promise<boolean>) {
    const deadline = performance.now() + 18000;
    while (!await check()) { assert(performance.now() < deadline, 'Browser condition timed out'); await sleep(80); }
}
async function main() {
    await makeEvidenceDirectory(root, { recursive: true });
    const require = createRequire(resolve('package.json'));
    const { build }: typeof import('esbuild') = require('esbuild');
    await bundleEvidence(build, { entryPoints: ['tests/resume-queue-harness.tsx'], outfile: `${root}/bundle.js`,
        bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic',
        define: { 'process.env.NODE_ENV': '"production"' } });
    const backend = await localBackend('pause-queue', true);
    const http = new AuctionClient(backend.url);
    await backend.admin('admin:managers');
    await backend.admin('admin:importPlayers', { players: syntheticPool(), fetchedAt: new Date().toISOString(),
        startedAt: Date.now(), sources: ['isolated-test-fixture'], counts: { pool: 300 }, coverage: {} });
    const token = await http.claim(1);
    await http.act({ type: 'start' }, token); await http.act({ type: 'pause' }, token);
    const server = ownServer(createServer(async (request, response) => {
        if (request.url === '/bundle.js') {
            response.setHeader('Content-Type', 'text/javascript'); response.end(await readFile(`${root}/bundle.js`));
        } else if (request.url === '/style.css') {
            response.setHeader('Content-Type', 'text/css'); response.end(await readFile('app/globals.css'));
        } else {
            response.setHeader('Content-Type', 'text/html');
            response.end('<html><head><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div>'
                + '<script>window.roomConfig=' + JSON.stringify({ url: backend.url, token })
                + '</script><script src="/bundle.js"></script></body></html>');
        }
    }));
    await listen(server);
    const address = server.address(); assert(address && typeof address !== 'string');
    const button = '.commish > button.secondary';
    await browser('open', `http://127.0.0.1:${address.port}`);
    await until(() => evaluate(`document.querySelector('${button}')?.textContent==='Resume'`));
    async function check(name: string, run: (proof: Record<string, unknown>) => Promise<void>) {
        const proof: Record<string, unknown> = {};
        try { await run(proof); results.push({ name, result: 'passed', proof }); console.log(`PASS ${name}`); }
        catch (error) {
            results.push({ name, result: 'failed', error: String(error), proof });
            console.log(`FAIL ${name}: ${error}`); process.exitCode = 1;
        }
        await writeEvidenceFile(`${root}/results.json`, JSON.stringify(results, null, 2));
    }
    const disconnect = async () => {
        await evaluate('(()=>{transport.blocked=true;for(const s of transport.sockets)s.close();return true})()');
        await until(() => evaluate('document.querySelector(".offline")?.textContent.includes("Reconnecting")'));
    };
    const reconnect = async () => {
        await evaluate('(()=>{transport.blocked=false;for(const s of transport.sockets)s.close();return true})()');
        await until(() => evaluate('!document.querySelector(".offline:not(.clock-status)")'));
    };
    await check('queued native Resume after another Resume reports not paused', async proof => {
        const observed = await http.state();
        await until(() => evaluate('pauseControl.state?.draft.controlGeneration==='
            + JSON.stringify(observed.draft.controlGeneration)));
        await disconnect();
        await evaluate('pauseControl.queue("resume");true');
        await http.act({ type: 'resume' }, token);
        const before = await http.state();
        await reconnect(); await until(() => evaluate('queuedResult!==null'));
        proof.result = await evaluate('queuedResult');
        const after = await http.state();
        proof.before = before.draft; proof.after = after.draft;
        assert.deepEqual(after.draft, before.draft);
        assert.deepEqual(after.managers, before.managers);
        assert.deepEqual(after.roster, before.roster);
        assert.equal((proof.result as { status: number }).status, 409);
        assert.equal((proof.result as { error: string }).error, 'Draft is not paused');
    });
    if ((await http.state()).draft.status === 'running') await http.act({ type: 'pause' }, token);
    await check('C44 queued native Resume rejects a newer pause', async proof => {
        await disconnect();
        proof.offline = await evaluate(`(()=>{const b=document.querySelector('${button}');return {
            disabled:b.disabled,title:b.title,reason:b.getAttribute('aria-describedby')}})()`);
        await evaluate('pauseControl.queue("resume");true');
        await http.act({ type: 'resume' }, token); await http.act({ type: 'pause' }, token);
        const newer = await http.state();
        await reconnect(); await until(() => evaluate('queuedResult!==null'));
        proof.result = await evaluate('queuedResult');
        const after = await http.state();
        proof.status = after.draft.status; proof.remainingMs = after.draft.remainingMs;
        assert.equal(after.draft.status, 'paused'); assert.equal(after.draft.remainingMs, newer.draft.remainingMs);
        assert.deepEqual(proof.result, { ok: false, error: 'The draft was paused again. Check before resuming.',
            status: 409, serverNow: (proof.result as { serverNow: number }).serverNow });
        assert((proof.offline as { disabled: boolean }).disabled);
        assert.equal((proof.offline as { title: string }).title, 'Reconnecting…');
    });
    if ((await http.state()).draft.status === 'running') await http.act({ type: 'pause' }, token);
    await check('C44 reconnect without a queued action preserves the new pause', async proof => {
        await disconnect(); await http.act({ type: 'resume' }, token); await http.act({ type: 'pause' }, token);
        const frozen = (await http.state()).draft.remainingMs;
        await reconnect(); const after = await http.state();
        proof.status = after.draft.status; assert.equal(after.draft.status, 'paused');
        assert.equal(after.draft.remainingMs, frozen);
    });
    await check('C44 current online Resume shows busy and preserves the turn', async proof => {
        const before = await http.state();
        await evaluate('transport.holdActions=true;true'); await browser('click', button);
        await until(() => evaluate(`document.querySelector('${button}')?.getAttribute('aria-busy')==='true'`));
        proof.busy = true;
        await evaluate('(()=>{transport.holdActions=false;for(const send of transport.held.splice(0))send();return true})()');
        await until(async () => (await http.state()).draft.status === 'running');
        const after = await http.state(); proof.status = after.draft.status;
        assert.equal(after.draft.turnSequence, before.draft.turnSequence);
    });
    await evaluate('(()=>{transport.holdActions=false;for(const send of transport.held.splice(0))send();return true})()');
    await check('queued native Pause after another Pause reports not running', async proof => {
        const observed = await http.state();
        await until(() => evaluate('pauseControl.state?.draft.controlGeneration==='
            + JSON.stringify(observed.draft.controlGeneration)));
        await disconnect();
        await evaluate('pauseControl.queue("pause");true');
        await http.act({ type: 'pause' }, token);
        const before = await http.state();
        await reconnect(); await until(() => evaluate('queuedResult!==null'));
        proof.result = await evaluate('queuedResult');
        const after = await http.state();
        proof.before = before.draft; proof.after = after.draft;
        assert.deepEqual(after.draft, before.draft);
        assert.deepEqual(after.managers, before.managers);
        assert.deepEqual(after.roster, before.roster);
        assert.equal((proof.result as { status: number }).status, 409);
        assert.equal((proof.result as { error: string }).error, 'Draft is not running');
    });
    if ((await http.state()).draft.status === 'paused') await http.act({ type: 'resume' }, token);
    await check('C44 queued native Pause cannot stop a newer running interval', async proof => {
        await disconnect();
        proof.disabled = await evaluate(`document.querySelector('${button}').disabled`);
        await evaluate('pauseControl.queue("pause");true');
        await http.act({ type: 'pause' }, token); await http.act({ type: 'resume' }, token);
        await http.act({ type: 'pause' }, token); await http.act({ type: 'resume' }, token);
        await reconnect(); await until(() => evaluate('queuedResult!==null'));
        proof.result = await evaluate('queuedResult'); proof.status = (await http.state()).draft.status;
        assert.equal(proof.status, 'running');
        assert.equal((proof.result as { error: string }).error, 'The draft has resumed again. Check before pausing.');
        assert.equal(proof.disabled, true);
    });
    await check('C44 missing fields reject old tabs and Undo creates a fresh pause identity', async proof => {
        const missingPause = await backend.client.mutation(api.auction.actOnDraft, { token, action: { type: 'pause' } });
        assert(!missingPause.ok); assert.equal(missingPause.error, 'Refresh the page to continue');
        let state = await http.state();
        if (!state.lot) {
            const nominator = state.draft.nominatorId!;
            const seat = nominator === 1 ? token : await http.claim(nominator);
            await http.act({ type: 'nominate', playerId: state.players.find(player =>
                !state.roster.some(entry => entry.playerId === player.id))!.id, amount: 1,
            nominationGeneration: state.draft.nominationGeneration }, seat);
            state = await http.state();
        }
        const lot = state.lot!;
        await http.act({ type: 'force', lotId: lot.id, expectedHighBid: lot.highBid,
            expectedHighBidderId: lot.highBidderId }, token);
        await http.act({ type: 'pause' }, token);
        const before = await http.state();
        await http.act({ type: 'undo', lotId: lot.id }, token);
        const after = await http.state();
        proof.freshIdentity = after.draft.controlGeneration !== before.draft.controlGeneration;
        assert.equal(proof.freshIdentity, true);
        await assert.rejects(http.act({ type: 'resume', expectedPause: before.draft.controlGeneration }, token),
            /The draft was paused again/);
        const missingResume = await backend.client.mutation(api.auction.actOnDraft, { token, action: { type: 'resume' } });
        assert(!missingResume.ok); assert.equal(missingResume.error, 'Refresh the page to continue');
        assert.equal((await http.state()).draft.status, 'paused');
        proof.missingPause = missingPause.error; proof.missingResume = missingResume.error;
    });
    await browser('screenshot', `${root}/controls.png`);
}
withResources(main).catch(error => { console.error(error); process.exitCode = 1; });
