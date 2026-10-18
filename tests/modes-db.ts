import assert from 'node:assert/strict';
import { AuctionClient, RuleError } from '../lib/client';
import { draftDefaults, timingDefaults } from '../lib/modes';
import type { AuctionMode } from '../lib/types';
import { api } from '../convex/_generated/api';
import { checkLeague } from '../scripts/readiness';
import { localBackend } from '../scripts/local-backend';
import { withResources } from '../scripts/resources';
import { makeEvidenceDirectory, writeEvidenceFile } from '../scripts/evidence';
import { recordedPool } from '../scripts/pool-source';

async function main() {
    const root = `${process.env.EVIDENCE_DIR}/modes-db`;
    await makeEvidenceDirectory(root, { recursive: true });
    const backend = await localBackend('modes-db', true);
    const client = new AuctionClient(backend.url);
    const source = recordedPool();
    const results: { name: string; result: string; error?: string }[] = [];
    const deny = (operation: Promise<unknown>, status: number) => assert.rejects(operation,
        error => error instanceof RuleError && error.status === status);
    async function check(name: string, run: () => Promise<void>) {
        try { await run(); results.push({ name, result: 'passed' }); }
        catch (error) { results.push({ name, result: 'failed', error: String(error) }); throw error; }
        finally { await writeEvidenceFile(`${root}/results.json`, JSON.stringify(results, null, 2)); }
    }
    async function reset(mode?: AuctionMode) {
        await backend.admin('testOnly:reset');
        if (mode) await client.act({ type: 'mode', mode }, 'seat:1');
    }
    try {
        await backend.admin('admin:managers');
        await backend.admin('admin:importPlayers', { players: source.players, ...source.importMetadata, startedAt: Date.now() });
        const devices = [client, new AuctionClient(backend.url)];
        assert.deepEqual(await Promise.all(devices.map(device => device.claim(1))), ['seat:1', 'seat:1']);
        await check('A failed legacy Start leaves its mode and events untouched', async () => {
            await reset();
            await backend.admin('testOnly:legacy', { status: 'setup' });
            await backend.admin('admin:importPlayers', { players: [], ...source.importMetadata, startedAt: Date.now() });
            const before = await backend.admin('admin:inspect');
            await deny(client.act({ type: 'start' }, 'seat:1'), 422);
            assert.deepEqual(await backend.admin('admin:inspect'), before);
            await backend.admin('admin:importPlayers', { players: source.players, ...source.importMetadata, startedAt: Date.now() });
        });
        for (const mode of ['live-v1', 'sealed-v1'] as const) {
            await check(`${mode}: commissioner only, idempotence, defaults, managers preserves selection, readiness`, async () => {
                await reset();
                await deny(client.act({ type: 'mode', mode }, 'seat:2'), 403);
                await deny(client.act({ type: 'mode', mode }, 'invalid'), 401);
                await client.act({ type: 'mode', mode }, 'seat:1');
                const before = await backend.admin('admin:inspect');
                for (const [key, value] of Object.entries(timingDefaults(mode))) assert.equal(before.draft.value[key], value);
                if (mode === 'live-v1') assert.equal(before.draft.value.tiePriority, undefined);
                await devices[1].act({ type: 'mode', mode }, 'seat:1');
                assert.deepEqual((await backend.admin('admin:inspect')).draft, before.draft);
                assert.deepEqual((await backend.admin('admin:inspect')).events, before.events);
                await backend.admin('admin:managers');
                assert.equal((await client.state()).draft.mode, mode);
                assert((await checkLeague(() => backend.admin('admin:inspect'))).ready);
                for (const field of ['nominationMs', 'biddingMs', 'extensionMs', 'capMs'] as const) {
                    await backend.admin('testOnly:configure', { draft: { [field]: timingDefaults(mode)[field] + 1 } });
                    assert(!(await checkLeague(() => backend.admin('admin:inspect'))).ready);
                    await backend.admin('testOnly:configure', { draft: { [field]: timingDefaults(mode)[field] } });
                }
                await client.act({ type: 'start' }, 'seat:1');
                assert.equal((await client.state()).draft.mode, mode);
                for (const status of ['running', 'paused', 'complete'] as const) {
                    await backend.admin('testOnly:configure', { draft: { status } });
                    for (const selected of ['sealed-v1', 'live-v1'] as const)
                        await deny(client.act({ type: 'mode', mode: selected }, 'seat:1'), 409);
                }
            });
            await check(`${mode}: untouched legacy converts; existing auction data cannot convert`, async () => {
                await reset();
                await backend.admin('testOnly:legacy', { status: 'setup' });
                await client.act({ type: 'mode', mode }, 'seat:1');
                const state = await client.state();
                assert.equal(state.draft.mode, mode);
                assert.equal(state.draft.status, 'setup');
                assert(state.draft.controlGeneration!.endsWith(':1'));
                assert.equal(state.recentEvents[0].type, 'mode');
                for (const data of ['lot', 'roster']) {
                    await reset();
                    await backend.admin('testOnly:legacy', { status: 'setup', data });
                    const before = await backend.admin('admin:inspect');
                    await deny(client.act({ type: 'mode', mode }, 'seat:1'), 409);
                    assert.deepEqual(await backend.admin('admin:inspect'), before);
                }
                for (const status of ['running', 'paused', 'complete']) {
                    await reset();
                    await backend.admin('testOnly:legacy', { status });
                    const before = await backend.admin('admin:inspect');
                    await deny(client.act({ type: 'mode', mode }, 'seat:1'), 409);
                    assert.deepEqual(await backend.admin('admin:inspect'), before);
                    assert.equal((await client.state()).recentEvents.length, 0);
                }
            });
        }
        await check('Only the current mode marks public events; same-mode selection cannot bypass data checks', async () => {
            await reset('live-v1');
            await client.act({ type: 'mode', mode: 'sealed-v1' }, 'seat:1');
            assert((await client.state()).recentEvents.every(event => event.type !== 'mode' || event.data.mode === 'sealed-v1'));
            await client.act({ type: 'mode', mode: 'live-v1' }, 'seat:1');
            assert((await client.state()).recentEvents.every(event => event.type !== 'mode' || event.data.mode === 'live-v1'));
            await backend.admin('testOnly:legacy', { status: 'setup', data: 'lot' });
            await backend.admin('testOnly:configure', { draft: draftDefaults('live-v1') });
            await deny(client.act({ type: 'mode', mode: 'live-v1' }, 'seat:1'), 409);
        });
        await check('Stored mode rejects foreign actions and foreign bid intent', async () => {
            for (const mode of ['live-v1', 'sealed-v1'] as const) {
                await reset(mode);
                await backend.admin('testOnly:configure', { draft: { nominationMs: 600000, biddingMs: 600000, capMs: 600000 } });
                await client.act({ type: 'start' }, 'seat:1');
                const state = await client.state();
                const token = `seat:${state.draft.nominatorId}`;
                const nomination = { type: 'nominate' as const, playerId: source.players[0].id,
                    nominationGeneration: state.draft.nominationGeneration };
                if (mode === 'live-v1') {
                    await deny(client.act(nomination, token), 422);
                    await deny(client.queue({ type: 'add', playerId: source.players[0].id }, token), 409);
                    assert.deepEqual((await client.privateSeat(token))?.queue, []);
                } else await deny(client.act({ type: 'force', lotId: 1 }, 'seat:1'), 409);
                await client.act({ ...nomination, ...(mode === 'live-v1' ? { amount: 1 } : {}) }, token);
                const lot = (await client.state()).lot!;
                const foreign = mode === 'live-v1' ? 'sealed-v1' : 'live-v1';
                for (const type of ['bid', 'pass'] as const)
                    await deny(client.act(type === 'bid' ? { type, mode: foreign, lotId: lot.id, amount: 2 }
                        : { type, mode: foreign, lotId: lot.id }, 'seat:2'), 409);
                const publicState = await client.transport.query(api.auction.state, {});
                assert.equal(publicState.lot!.highBid, mode === 'live-v1' ? 1 : 0);
            }
        });
        await check('A rejected late Normal bid persists the sale and exactly one new deadline', async () => {
            await reset('live-v1');
            await backend.admin('testOnly:configure', { draft: { nominationMs: 600000, biddingMs: 600000 } });
            await client.act({ type: 'start' }, 'seat:1');
            const s = await client.state();
            await client.act({ type: 'nominate', playerId: source.players[0].id, amount: 1,
                nominationGeneration: s.draft.nominationGeneration }, `seat:${s.draft.nominatorId}`);
            const lot = (await client.state()).lot!;
            const result = await backend.admin('testOnly:expiredAction', { token: 'seat:2', action: { type: 'bid', lotId: lot.id, amount: 2 } });
            assert(!result.ok && result.status === 409);
            const after = await client.state();
            assert.equal(after.roster.filter(entry => entry.lotId === lot.id).length, 1);
            assert.equal(after.lot, null);
            assert.equal(after.recentEvents.filter(event => event.type === 'sale').length, 1);
            const before = await backend.admin('testOnly:deadlineSnapshot');
            const jobs = await backend.admin('testOnly:scheduledDeadlines');
            await client.claim(2);
            assert.deepEqual(await backend.admin('testOnly:deadlineSnapshot'), before);
            assert.deepEqual(await backend.admin('testOnly:scheduledDeadlines'), jobs);
        });
    } finally { await backend.close(); }
}
withResources(main).catch(error => { console.error(error); process.exitCode = 1; });
