import assert from 'node:assert/strict';
import { ConvexClient } from 'convex/browser';
import { api } from '../convex/_generated/api';
import { AuctionClient } from '../lib/client';
import { counts, legalPlacements, timeoutNominee } from '../lib/rules';
import { DAY, legalMaximum } from '../lib/sealed';
import type { AuctionState, Entry } from '../lib/types';
import { localBackend, sleep } from '../scripts/local-backend';
import { withResources, ownClient } from '../scripts/resources';
import { makeEvidenceDirectory, writeEvidenceFile } from '../scripts/evidence';
import { recordedPool } from '../scripts/pool-source';
import { checkLeague } from '../scripts/readiness';

async function main() {
    const root = `${process.env.EVIDENCE_DIR}/sealed-db`;
    await makeEvidenceDirectory(root, { recursive: true });
    const backend = await localBackend('sealed-db', true);
    const client = new AuctionClient(backend.url);
    const clients = Array.from({ length: 10 }, () => new AuctionClient(backend.url));
    const results: { name: string; result: string; error?: string }[] = [];
    const evidence: Record<string, unknown> = { backend: backend.identity };
    const source = recordedPool();
    let tokens: string[] = [];
    const state = () => client.state();
    const config = (args: Record<string, unknown>) => backend.admin('testOnly:configure', args);
    const snapshot = () => backend.admin('testOnly:deadlineSnapshot');
    async function reset() { await backend.admin('testOnly:reset'); }
    async function start() { await client.act({ type: 'start' }, tokens[0]); }
    async function nominate(playerId?: string, amount?: number) {
        const s = await state();
        const player = playerId ? s.players.find(p => p.id === playerId)! : timeoutNominee(s, s.managers.find(m => m.id === s.draft.nominatorId))!;
        await client.act({ type: 'nominate', playerId: player.id, nominationGeneration: s.draft.nominationGeneration,
            ...(amount === undefined ? {} : { amount }) }, tokens[s.draft.nominatorId! - 1]);
        return (await state()).lot!;
    }
    async function finish(amounts: Record<number, number> = {}) {
        const s = await state();
        assert(s.lot);
        const lotId = s.lot.id;
        await Promise.all(s.managers.filter(m => !s.lot!.respondedIds?.includes(m.id)).map(m => {
            const amount = amounts[m.id] ?? 0;
            return clients[m.id - 1].act(amount > 0 ? { type: 'bid', lotId, amount } : { type: 'pass', lotId }, tokens[m.id - 1]);
        }));
        return (await state()).sales.find(lot => lot.id === lotId)!;
    }
    async function check(name: string, run: () => Promise<void>) {
        try { await run(); results.push({ name, result: 'passed' }); console.log(`PASS ${name}`); }
        catch (error) { results.push({ name, result: 'failed', error: String(error) }); throw error; }
        finally { await writeEvidenceFile(`${root}/results.json`, JSON.stringify(results, null, 2)); }
    }
    const deny = (operation: Promise<unknown>, pattern: RegExp) => assert.rejects(operation, pattern);
    try {
        await backend.admin('admin:managers');
        await backend.admin('admin:importPlayers', { players: source.players, ...source.importMetadata, startedAt: Date.now() });
        tokens = await Promise.all(clients.map((client, index) => client.claim(index + 1)));
        await check('Ten seats, imported provenance, $1000 and 24h readiness; claims and commissioner restrictions', async () => {
            const s = await state();
            assert.equal(s.managers.length, 10);
            assert(s.managers.every(m => m.budget === 1000));
            assert.equal(s.draft.biddingMs, DAY);
            assert.equal(s.draft.nominationMs, DAY);
            const inspected = await backend.admin('admin:inspect');
            assert.equal(inspected.imports[0].fetchedAt, source.importMetadata.fetchedAt);
            assert.deepEqual(inspected.imports[0].sources, source.importMetadata.sources);
            assert((await checkLeague(() => backend.admin('admin:inspect'))).ready);
            await deny(client.claim(1), /claimed/);
            await deny(client.act({ type: 'start' }, tokens[1]), /Commissioner/);
            await deny(client.act({ type: 'start' }, 'invalid'), /seat/i);
            assert.equal(await client.restore(tokens[2]), 3);
            await start();
            assert.deepEqual((await state()).draft.tiePriority, [...(await state()).draft.order].reverse());
            await deny(client.act({ type: 'pause' }, tokens[1]), /Commissioner/);
            await deny(client.act({ type: 'release', managerId: 3 }, tokens[1]), /Commissioner/);
            await deny(client.act({ type: 'undo', lotId: 1 }, tokens[1]), /Commissioner/);
            await deny(client.act({ type: 'resume' }, tokens[1]), /Commissioner/);
            await deny(backend.admin('admin:importPlayers', { players: source.players, ...source.importMetadata, startedAt: Date.now() }), /forbidden/);
        });
        await check('Public HTTP and subscription secrecy; owner-only responses; immutable responses; first-price tie and concurrent resolution', async () => {
            const s = await state();
            const [first, second] = s.draft.tiePriority!;
            const lot = await nominate();
            const queuePlayer = s.players.find(p => p.id !== lot.playerId)!;
            await client.queue({ type: 'add', playerId: queuePlayer.id, amount: 719 }, tokens[first - 1]);
            await client.act({ type: 'bid', lotId: lot.id, amount: 733 }, tokens[first - 1]);
            await deny(client.act({ type: 'bid', lotId: lot.id, amount: 734 }, tokens[first - 1]), /final/);
            await deny(client.act({ type: 'pass', lotId: lot.id }, tokens[first - 1]), /final/);
            await deny(client.act({ type: 'bid', lotId: lot.id, amount: 982 }, tokens[second - 1]), /maximum/);
            for (const amount of [0, -1, 1.5]) await deny(client.act({ type: 'bid', lotId: lot.id, amount }, tokens[second - 1]), /positive whole/);
            for (const token of [undefined, ...tokens]) {
                const publicState = await client.transport.query(api.auction.state, token ? { token } : {});
                assert.equal(publicState.lot?.highBid, 0);
                assert.equal(publicState.lot?.highBidderId, 0);
                assert.equal(publicState.lot?.bids, undefined);
                assert.equal(publicState.players.length, 0);
                assert(!JSON.stringify(publicState).includes('"amount"'));
                assert(!('queue' in publicState));
            }
            for (let id = 1; id <= 10; id++) {
                const own = await client.privateSeat(tokens[id - 1]);
                assert.equal(own?.managerId, id);
                assert.equal(own?.response?.amount ?? null, id === first ? 733 : null);
                assert.equal(own?.queue.length, id === first ? 1 : 0);
            }
            assert.equal(await client.privateSeat('invalid'), null);
            const publicPool = await client.transport.query(api.auction.pool, { revision: s.poolRevision });
            assert(!JSON.stringify(publicPool).includes('"amount"'));
            assert.equal(publicPool.players.length, source.players.length);
            assert.equal(await client.transport.query(api.auction.result, { lotId: lot.id }), null);
            const wire = ownClient(new ConvexClient(backend.url));
            const publicUpdates: AuctionState[] = [];
            const stop = wire.onUpdate(api.auction.state, {}, update => { publicUpdates.push(update); });
            try {
                await sleep(150);
                await client.act({ type: 'bid', lotId: lot.id, amount: 733 }, tokens[second - 1]);
                await sleep(150);
                assert(publicUpdates.length >= 2);
                assert(publicUpdates.every(update => !JSON.stringify(update).includes('"amount"')));
                evidence.sealedPublicSnapshot = publicUpdates.at(-1);
                const result = await finish();
                assert.equal(result.highBidderId, first);
                assert.equal(result.highBid, 733);
                assert.equal(result.bids?.length, 10);
                const after = await state();
                assert.equal(after.managers[first - 1].budget, 267);
                assert.deepEqual(after.draft.tiePriority, [...s.draft.tiePriority!.filter(id => id !== first), first]);
                assert.equal(after.roster.filter(entry => entry.lotId === lot.id).length, 1);
                const audit = await backend.admin('admin:inspect');
                assert.equal(audit.events.filter((e: { type: string; lotId: number }) => e.type === 'resolution' && e.lotId === lot.id).length, 1);
                await sleep(150);
                assert(publicUpdates.some(update => update.sales.some(sale => sale.bids?.some(bid => bid.amount === 733))));
                assert.deepEqual((await client.transport.query(api.auction.result, { lotId: lot.id }))?.bids, result.bids);
                evidence.revealedLot = result;
                const own = await client.privateSeat(tokens[first - 1]);
                await client.queue({ type: 'remove', id: own!.queue[0].id }, tokens[first - 1]);
            } finally { stop(); await wire.close(); }
        });
        await check('Successive ties rotate; non-tie wins retain priority; all-pass returns player without budget change', async () => {
            const original = (await state()).draft.tiePriority!;
            const a = original.at(-1)!;
            const b = original[0];
            await nominate();
            const secondTie = await finish({ [a]: 31, [b]: 31 });
            assert.equal(secondTie.highBidderId, b);
            const before = await state();
            await nominate();
            await finish({ [a]: 11 });
            assert.deepEqual((await state()).draft.tiePriority, before.draft.tiePriority);
            const beforePass = await state();
            const lot = await nominate();
            const unsold = await finish();
            assert.equal(unsold.status, 'unsold');
            const after = await state();
            assert(!after.roster.some(e => e.playerId === lot.playerId));
            assert(after.players.some(p => p.id === lot.playerId));
            assert.deepEqual(after.managers.map(m => m.budget), beforePass.managers.map(m => m.budget));
            assert.deepEqual(after.draft.tiePriority, beforePass.draft.tiePriority);
            assert.notEqual(after.draft.nominatorId, lot.nominatorId);
            evidence.secondTie = secondTie;
        });
        await check('Queue add, edit, reorder, remove; private consumption with and without amount; queues never bid on other nominations', async () => {
            await reset();
            const players = source.players.slice(0, 4);
            await client.queue({ type: 'add', playerId: players[0].id, amount: 41 }, tokens[0]);
            await client.queue({ type: 'add', playerId: players[1].id }, tokens[0]);
            await client.queue({ type: 'add', playerId: players[2].id, amount: 19 }, tokens[0]);
            let own = (await client.privateSeat(tokens[0]))!;
            await client.queue({ type: 'edit', id: own.queue[2].id, amount: 23 }, tokens[0]);
            await client.queue({ type: 'remove', id: own.queue[2].id }, tokens[0]);
            await client.queue({ type: 'reorder', ids: [own.queue[1].id, own.queue[0].id] }, tokens[0]);
            await deny(client.queue({ type: 'reorder', ids: [own.queue[0].id, own.queue[0].id] }, tokens[0]), /Queue changed/);
            await deny(client.queue({ type: 'remove', id: own.queue[0].id }, tokens[1]), /no longer exists/);
            await start();
            let s = await state();
            while (s.draft.nominatorId !== 1) {
                await nominate(players[3].id);
                assert.equal((await client.privateSeat(tokens[0]))?.response, null);
                await finish({ [s.draft.nominatorId!]: 1 });
                s = await state();
                if (s.draft.nominatorId !== 1) players[3] = timeoutNominee(s, s.managers.find(m => m.id === s.draft.nominatorId))!;
            }
            assert.equal(s.lot?.playerId, players[1].id);
            assert.equal((await client.privateSeat(tokens[0]))?.response, null);
            await finish({ 1: 2 });
            s = await state();
            while (s.draft.nominatorId !== 1) { await nominate(); await finish({ [s.draft.nominatorId!]: 1 }); s = await state(); }
            assert.equal(s.lot?.playerId, players[0].id);
            own = (await client.privateSeat(tokens[0]))!;
            assert.equal(own.response?.amount, 41);
            assert.equal(own.queue.length, 0);
            await finish();
        });
        await check('Queue validation at enqueue and execution; stale, over-budget, and no-placement entries stay with reasons', async () => {
            await reset();
            const [p, q, r] = source.players;
            for (const amount of [0, -1, 1.2, 982]) await deny(client.queue({ type: 'add', playerId: p.id, amount }, tokens[0]), /positive whole|maximum/);
            await client.queue({ type: 'add', playerId: p.id, amount: 900 }, tokens[0]);
            await client.queue({ type: 'add', playerId: q.id, amount: 20 }, tokens[0]);
            await client.queue({ type: 'add', playerId: r.id }, tokens[0]);
            await config({ managers: [{ id: 1, budget: 30 }], roster: [{ playerId: q.id, managerId: 2, placement: 'active', price: 1, lotId: 80 }] });
            await config({ draft: { status: 'paused', phase: 'nomination', order: [1,2,3,4,5,6,7,8,9,10], tiePriority: [10,9,8,7,6,5,4,3,2,1], nominatorId: 1, turnIndex: 0, remainingMs: DAY, deadline: null } });
            await client.act({ type: 'resume' }, tokens[0]);
            assert.equal((await state()).lot?.playerId, r.id);
            const own = (await client.privateSeat(tokens[0]))!;
            assert.equal(own.response, null);
            assert.equal(own.queue[0].amount, 900);
            assert.match(own.queue[0].reason!, /maximum/);
            assert.match(own.queue[1].reason!, /unavailable/);
            await deny(client.queue({ type: 'add', playerId: q.id }, tokens[1]), /unavailable/);
            await reset();
            const veterans = source.players.filter(p => p.yearsExp !== 0 && (p.careerGames ?? 0) >= 65 && p.injuryStatus !== 'Out');
            const target = veterans[0];
            await client.queue({ type: 'add', playerId: target.id }, tokens[0]);
            const roster: Entry[] = source.players.filter(p => p.id !== target.id).filter(p => legalPlacements(p, [], source.players).includes('active')).slice(0, 20)
                .map((p, i) => ({ playerId: p.id, managerId: 1, placement: 'active', price: 1, lotId: i + 1 }));
            await config({ roster, draft: { status: 'paused', phase: 'nomination', order: [1,2,3,4,5,6,7,8,9,10],
                tiePriority: [10,9,8,7,6,5,4,3,2,1], nominatorId: 1, turnIndex: 0, remainingMs: DAY, deadline: null } });
            await client.act({ type: 'resume' }, tokens[0]);
            const skipped = (await client.privateSeat(tokens[0]))!.queue[0];
            assert.match(skipped.reason!, /placement/);
            await deny(client.queue({ type: 'edit', id: skipped.id, amount: 1 }, tokens[0]), /placement/);
            await deny(client.queue({ type: 'add', playerId: veterans.find(p => !roster.some(e => e.playerId === p.id) && p.id !== target.id)!.id }, tokens[0]), /placement/);
            evidence.skippedQueues = own.queue;
        });
        await check('24h defaults under simulated time; exact boundary; stale draft, lot, version and deadline jobs no-op', async () => {
            await reset(); await start();
            const before = await state();
            const job = await snapshot();
            assert.equal(job.deadline - before.recentEvents.find(e => e.type === 'turn')!.at, DAY);
            for (const stale of [{ ...job, version: job.version - 1 }, { ...job, lotId: 999 }, { ...job, deadline: job.deadline - 1 }]) {
                await backend.admin('testOnly:simulatedExpiry', { snapshot: stale, now: job.deadline });
                assert.equal((await state()).lot, null);
            }
            await backend.admin('testOnly:simulatedExpiry', { snapshot: job, now: job.deadline - 1 });
            assert.equal((await state()).lot, null);
            const expected = timeoutNominee(before, before.managers.find(m => m.id === before.draft.nominatorId))!;
            await backend.admin('testOnly:simulatedExpiry', { snapshot: job, now: job.deadline });
            const nominated = await state();
            assert.equal(nominated.lot?.playerId, expected.id);
            assert.equal(nominated.lot?.respondedIds?.length, 0);
            assert.equal(nominated.draft.deadline, job.deadline + DAY);
            const bidJob = await snapshot();
            await backend.admin('testOnly:simulatedExpiry', { snapshot: job, now: bidJob.deadline });
            assert.equal((await state()).lot?.id, nominated.lot?.id);
            await backend.admin('testOnly:simulatedExpiry', { snapshot: bidJob, now: bidJob.deadline });
            assert.equal((await state()).sales[0].status, 'unsold');
            assert((await state()).sales[0].bids?.every(bid => bid.amount === 0 && bid.automatic === 'deadline'));
            await reset(); await start();
            const newId = (await snapshot()).draftId;
            await backend.admin('testOnly:simulatedExpiry', { snapshot: bidJob, now: bidJob.deadline });
            assert.equal((await snapshot()).draftId, newId);
            assert.equal((await state()).lot, null);
            evidence.autoNomination = { id: expected.id, name: expected.name, projection: expected.projection,
                fetchedAt: source.importMetadata.fetchedAt, sources: source.importMetadata.sources, bidAttached: false };
        });
        await check('Real scheduler fires nomination and bid deadlines; pause freezes remainder; stale jobs cannot resolve twice', async () => {
            await reset(); await start();
            await config({ deadlineAfterMs: 1500 });
            const old = await snapshot();
            await client.act({ type: 'pause' }, tokens[0]);
            const paused = await state();
            assert(paused.draft.remainingMs! > 0 && paused.draft.remainingMs! <= 1500);
            await sleep(1700);
            assert.equal((await state()).lot, null);
            assert.equal((await state()).draft.remainingMs, paused.draft.remainingMs);
            await client.act({ type: 'resume' }, tokens[0]);
            const resumed = await state();
            assert.equal(resumed.draft.deadline! - resumed.recentEvents.find(e => e.type === 'resume')!.at, paused.draft.remainingMs);
            await backend.admin('auction:expire', old);
            for (let i = 0; i < 60 && !(await state()).lot; i++) await sleep(100);
            const nominated = await state();
            assert(nominated.lot, 'The real nomination scheduler must fire');
            assert.equal(nominated.lot.respondedIds?.length, 0);
            await client.act({ type: 'bid', lotId: nominated.lot.id, amount: 17 }, tokens[0]);
            await client.act({ type: 'pause' }, tokens[0]);
            const bidRemainder = (await state()).draft.remainingMs;
            await sleep(100);
            assert.equal((await state()).draft.remainingMs, bidRemainder);
            await client.act({ type: 'resume' }, tokens[0]);
            const bidResumed = await state();
            assert.equal(bidResumed.draft.deadline! - bidResumed.recentEvents.find(e => e.type === 'resume')!.at, bidRemainder);
            await config({ deadlineAfterMs: 400 });
            const bidJob = await snapshot();
            for (let i = 0; i < 60 && !(await state()).sales.length; i++) await sleep(100);
            const after = await state();
            assert.equal(after.sales[0]?.highBid, 17);
            assert.equal(after.sales[0]?.bids?.filter(bid => bid.automatic === 'deadline').length, 9);
            await backend.admin('auction:expire', bidJob);
            assert.equal((await state()).roster.length, 1);
            evidence.scheduler = { nominationFired: true, bidDeadlineFired: true, remainingMs: paused.draft.remainingMs };
        });
        await check('Eligibility auto-pass; placement cannot invalidate a sealed response; Done mechanics and undo preserve roster and priority', async () => {
            await reset(); await start();
            const ineligible = (await state()).draft.nominatorId === 10 ? 9 : 10;
            await config({ managers: [{ id: ineligible, budget: 19 }] });
            const lot = await nominate();
            assert.equal((await client.privateSeat(tokens[ineligible - 1]))?.response?.automatic, 'ineligible');
            await deny(client.act({ type: 'pass', lotId: lot.id }, tokens[ineligible - 1]), /final/);
            await deny(client.act({ type: 'done', done: true, nominationGeneration: (await state()).draft.nominationGeneration }, tokens[1]), /taxi or IR/);
            const before = await state();
            const [a,b] = before.draft.tiePriority!.filter(id => id !== ineligible);
            const sale = await finish({ [a]: 8, [b]: 8 });
            assert.equal(sale.highBidderId, a);
            await nominate(undefined, 1);
            await client.act({ type: 'undo', lotId: sale.id }, tokens[0]);
            const undone = await state();
            assert.equal(undone.draft.status, 'paused');
            assert.equal(undone.lot, null);
            assert.equal(undone.roster.length, 0);
            assert.equal(undone.managers[a - 1].budget, 1000);
            assert.deepEqual(undone.draft.tiePriority, before.draft.tiePriority);
            await deny(client.act({ type: 'resume', expectedPause: 'stale' }, tokens[0]), /changed/);
            await client.act({ type: 'resume' }, tokens[0]);
            await reset(); await start();
            const rookie = source.players.find(p => p.yearsExp === 0)!;
            await nominate(rookie.id);
            await finish({ 1: 1 });
            await nominate();
            await config({ managers: [{ id: 1, budget: 100 }] });
            const current = await state();
            await client.act({ type: 'bid', lotId: current.lot!.id, amount: 82 }, tokens[0]);
            await deny(client.act({ type: 'place', playerId: rookie.id, placement: 'taxi' }, tokens[0]), /invalidate/);
        });
        await check('Legacy document shapes validate; in-progress legacy auction never advances; setup migration never starts draft', async () => {
            await reset();
            await backend.admin('testOnly:legacy', { running: true });
            const before = await backend.admin('admin:inspect');
            await deny(client.act({ type: 'pass', lotId: 1 }, tokens[1]), /Legacy/);
            await deny(client.act({ type: 'pause' }, tokens[0]), /Legacy/);
            const job = await snapshot();
            await backend.admin('auction:expire', job);
            assert.deepEqual((await backend.admin('admin:inspect')).draft.value, before.draft.value);
            assert.equal((await state()).lot?.highBid, 0);
            assert.equal((await state()).recentEvents.length, 0);
            await reset();
            await backend.admin('testOnly:legacy', { running: false });
            await backend.admin('admin:managers');
            const migrated = await state();
            assert.equal(migrated.draft.mode, 'sealed-v1');
            assert.equal(migrated.draft.status, 'setup');
            assert.equal(migrated.draft.nominationMs, DAY);
            assert.equal(migrated.roster.length, 0);
            await config({ draft: { status: 'complete', completionReason: 'full-cycle-unsold', passedTurns: [1,2,3,4,5,6,7,8,9,10] } });
            const earlierCompletion = await state();
            assert.equal(earlierCompletion.draft.status, 'complete');
            assert.equal(earlierCompletion.draft.completionReason, 'full-cycle-unsold');
            assert.equal(earlierCompletion.draft.passedTurns.length, 10);
        });
        await check('Three all-pass rotations stay running through manual responses, 24h deadlines and queues, then a sale succeeds', async () => {
            await reset(); await start();
            const initial = await state();
            const order = initial.draft.order;
            const priority = initial.draft.tiePriority;
            const player = timeoutNominee(initial, initial.managers.find(m => m.id === order[0]))!;
            const rotations = [];
            for (let rotation = 0; rotation < 3; rotation++) {
                if (rotation === 2) {
                    await config({ draft: { passedTurns: order } });
                    for (const managerId of [...order.slice(1), order[0]])
                        await client.queue({ type: 'add', playerId: player.id }, tokens[managerId - 1]);
                }
                const lots = [];
                for (let turn = 0; turn < order.length; turn++) {
                    const before = await state();
                    assert.equal(before.draft.nominatorId, order[turn]);
                    if (rotation === 0) await nominate(player.id);
                    if (rotation === 1) {
                        const job = await snapshot();
                        await backend.admin('testOnly:simulatedExpiry', { snapshot: job, now: job.deadline });
                    }
                    const nominated = await state();
                    const lot = nominated.lot!;
                    assert(lot);
                    assert.equal(lot.playerId, player.id);
                    assert.equal(lot.nominatorId, order[turn]);
                    assert.deepEqual(lot.respondedIds, []);
                    assert.equal((await client.privateSeat(tokens[order[turn] - 1]))?.response, null);
                    if (rotation === 1) {
                        assert.equal(nominated.draft.deadline, before.draft.deadline! + DAY);
                        const job = await snapshot();
                        await backend.admin('testOnly:simulatedExpiry', { snapshot: job, now: job.deadline - 1 });
                        assert.equal((await state()).lot?.id, lot.id);
                        await backend.admin('testOnly:simulatedExpiry', { snapshot: job, now: job.deadline });
                    } else await finish();
                    const after = await state();
                    assert.equal(after.draft.status, 'running', `Rotation ${rotation + 1}, turn ${turn + 1} must not complete`);
                    assert.equal(after.draft.completionReason, null);
                    assert.equal(after.draft.nominatorId, order[(turn + 1) % order.length]);
                    assert.deepEqual(after.draft.tiePriority, priority);
                    assert.equal(after.roster.length, 0);
                    assert(after.players.some(p => p.id === player.id));
                    assert(after.managers.every(m => m.budget === 1000));
                    assert(!after.recentEvents.some(event => event.type === 'complete'));
                    const unsold = after.sales.find(result => result.id === lot.id)!;
                    assert.equal(unsold.status, 'unsold');
                    assert.equal(unsold.bids?.length, 10);
                    assert(unsold.bids?.every(bid => bid.amount === 0));
                    if (rotation === 2 && turn < 9) {
                        assert.equal(after.lot?.id, lot.id + 1);
                        assert.deepEqual(after.lot?.respondedIds, []);
                    } else {
                        assert.equal(after.lot, null);
                        assert.equal(after.draft.phase, 'nomination');
                    }
                    const turnEvent = after.recentEvents.find(event => event.type === 'turn')!;
                    if (after.lot === null) assert.equal(after.draft.deadline, turnEvent.at + DAY);
                    lots.push({ lotId: lot.id, nominatorId: lot.nominatorId, nextNominatorId: after.draft.nominatorId });
                }
                const audit = await backend.admin('admin:inspect');
                assert.equal(audit.lots.length, (rotation + 1) * 10);
                assert(!audit.events.some((event: { type: string }) => event.type === 'complete'));
                rotations.push({ source: ['manual', 'simulated-24h', 'queue'][rotation], lots });
            }
            assert.deepEqual((await state()).draft.passedTurns, order);
            await nominate(player.id);
            const sale = await finish({ [order[0]]: 23 });
            assert.equal(sale.highBidderId, order[0]);
            assert.equal(sale.highBid, 23);
            const after = await state();
            assert.equal(after.draft.status, 'running');
            assert.equal(after.roster.length, 1);
            assert.equal(after.managers.find(m => m.id === order[0])?.budget, 977);
            assert.deepEqual(after.draft.tiePriority, priority);
            evidence.unsoldRotations = { rotations, laterSale: sale.id, status: after.draft.status, priority };
        });
        await check('Blank queued lots wait for the sole eligible manager; real deadlines advance without unsold recursion', async () => {
            await reset();
            await config({ managers: Array.from({ length: 9 }, (_, index) => ({ id: index + 2, budget: 19 })) });
            const players = source.players.slice(0, 4);
            for (const [index, player] of players.entries())
                await client.queue({ type: 'add', playerId: player.id, ...(index === 2 ? { amount: 1 } : {}) }, tokens[0]);
            await start();
            let s = await state();
            const priority = s.draft.tiePriority;
            assert.equal(s.lot?.playerId, players[0].id);
            assert.deepEqual(s.lot?.eligibleIds, [1]);
            assert.equal(s.lot?.respondedIds?.length, 9);
            assert.equal((await client.privateSeat(tokens[0]))?.response, null);
            await client.act({ type: 'pass', lotId: s.lot!.id }, tokens[0]);
            s = await state();
            assert.equal(s.draft.status, 'running');
            assert.equal(s.sales.length, 1);
            assert.equal(s.sales[0].status, 'unsold');
            assert.equal(s.lot?.playerId, players[1].id);
            assert.equal(s.lot?.respondedIds?.length, 9);
            assert.equal((await client.privateSeat(tokens[0]))?.response, null);
            const auditAfterPass = await backend.admin('admin:inspect');
            assert.equal(auditAfterPass.lots.length, 2);
            assert.equal(auditAfterPass.events.filter((event: { type: string }) => event.type === 'resolution').length, 1);
            assert.equal(auditAfterPass.events.filter((event: { type: string }) => event.type === 'turn').length, 2);
            await config({ deadlineAfterMs: 500 });
            for (let i = 0; i < 60 && (await state()).lot?.playerId !== players[3].id; i++) await sleep(100);
            s = await state();
            assert.equal(s.draft.status, 'running');
            assert.equal(s.lot?.playerId, players[3].id);
            assert.equal(s.lot?.respondedIds?.length, 9);
            assert.equal((await client.privateSeat(tokens[0]))?.response, null);
            assert.equal((await client.privateSeat(tokens[0]))?.queue.length, 0);
            assert.equal(s.roster.length, 1);
            assert.equal(s.roster[0].playerId, players[2].id);
            assert.equal(s.roster[0].price, 1);
            assert.deepEqual(s.draft.tiePriority, priority);
            const auditAfterDeadline = await backend.admin('admin:inspect');
            assert.deepEqual(auditAfterDeadline.lots.sort((a: { id: number }, b: { id: number }) => a.id - b.id)
                .map((lot: { status: string }) => lot.status), ['unsold', 'unsold', 'sold', 'open']);
            assert.equal(auditAfterDeadline.events.filter((event: { type: string }) => event.type === 'turn').length, 4);
            await client.act({ type: 'pass', lotId: s.lot!.id }, tokens[0]);
            s = await state();
            assert.equal(s.lot, null);
            assert.equal(s.draft.status, 'running');
            const turnEvent = s.recentEvents.find(event => event.type === 'turn')!;
            assert.equal(s.draft.deadline, turnEvent.at + DAY);
            const expected = timeoutNominee(s, s.managers[0])!;
            await config({ deadlineAfterMs: 500 });
            for (let i = 0; i < 60 && !(await state()).lot; i++) await sleep(100);
            s = await state();
            assert.equal(s.lot?.playerId, expected.id);
            assert.equal(s.lot?.respondedIds?.length, 9);
            assert.equal((await client.privateSeat(tokens[0]))?.response, null);
            assert.equal(s.draft.status, 'running');
            assert.equal(s.draft.completionReason, null);
            assert(!s.recentEvents.some(event => event.type === 'complete'));
            evidence.queueContinuation = { afterPass: auditAfterPass.lots.length, afterDeadline: auditAfterDeadline.lots.length,
                bidDeadlineFired: true, nominationDeadlineFired: true, finalLot: s.lot!.id, waitingManager: 1 };
        });
        await check('Complete ten-manager draft fills 200 active slots through the public API, then Done ends nominations', async () => {
            await reset(); await start();
            let won = 0;
            while (won < 200) {
                const s = await state();
                assert.equal(s.draft.status, 'running');
                const winner = s.managers.find(m => counts(s.roster.filter(e => e.managerId === m.id)).active < 20)!;
                const nominator = s.managers.find(m => m.id === s.draft.nominatorId)!;
                const player = [...s.players].sort((a,b) => (b.projection ?? -Infinity) - (a.projection ?? -Infinity))
                    .find(p => !s.roster.some(e => e.playerId === p.id) && legalMaximum(s, nominator, p) > 0
                        && legalPlacements(p, s.roster.filter(e => e.managerId === winner.id), s.players).includes('active'));
                assert(player, 'A legal active player remains');
                await nominate(player.id);
                const sale = await finish({ [winner.id]: 1 });
                assert.equal(sale.highBidderId, winner.id);
                won++;
                if (won % 25 === 0) console.log(`Public draft: ${won} active sales`);
            }
            let s = await state();
            for (const manager of s.managers) {
                assert.equal(counts(s.roster.filter(e => e.managerId === manager.id)).active, 20);
                assert.equal(manager.budget, 980);
                const current = await state();
                await client.act({ type: 'done', done: true, nominationGeneration: current.draft.nominationGeneration }, tokens[manager.id - 1]);
            }
            s = await state();
            assert.equal(s.draft.status, 'complete');
            assert.equal(s.draft.completionReason, 'no-eligible-managers');
            const audit = await backend.admin('admin:inspect');
            assert.equal(audit.lots.length, 200);
            assert.equal(audit.events.filter((e: { type: string }) => e.type === 'resolution').length, 200);
            evidence.fullDraft = { sales: won, active: s.roster.length, managers: s.managers, completionReason: s.draft.completionReason };
        });
        await check('Release revokes old tokens without revealing or resetting private queue and response', async () => {
            await reset(); await start();
            await nominate();
            await client.act({ type: 'bid', lotId: (await state()).lot!.id, amount: 29 }, tokens[1]);
            await client.act({ type: 'release', managerId: 2 }, tokens[0]);
            assert.equal(await client.privateSeat(tokens[1]), null);
            await deny(client.restore(tokens[1]), /valid/);
            await deny(client.act({ type: 'pass', lotId: (await state()).lot!.id }, tokens[1]), /seat/i);
            const replacement = await client.claim(2);
            assert.equal((await client.privateSeat(replacement))?.response?.amount, 29);
            await deny(client.act({ type: 'pass', lotId: (await state()).lot!.id }, replacement), /final/);
        });
    } finally {
        await writeEvidenceFile(`${root}/evidence.json`, JSON.stringify(evidence, null, 2));
        await backend.close();
    }
}
withResources(main).catch(error => { console.error(error); process.exitCode = 1; });
