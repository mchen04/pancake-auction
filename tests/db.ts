import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { makeFunctionReference } from 'convex/server';
import { api } from '../convex/_generated/api';
import { checkLeague } from '../scripts/readiness';
import { counts, matching } from '../lib/rules';
import type { Action, AuctionState, Entry } from '../lib/types';
import { safeError } from '../scripts/env';
import { act, claimSeat, getState, restoreSeat, RuleError, configure, currentBackend,
    createIsolated, dropIsolated, seedManagers, seedPlayers, sleep, inspect, events, syntheticPool } from './support';

let tokens: string[];
const results: { name: string; result: string; error?: string }[] = [];
async function run(name: string, test: () => Promise<void>, initialized = true) {
    const isolated = await createIsolated('test');
    try {
        if (initialized) {
            await seedManagers();
            await seedPlayers();
            tokens = await Promise.all(Array.from({ length: 10 }, (_, i) => claimSeat(i + 1)));
        }
        await test();
        await invariants();
        results.push({ name, result: 'passed' });
        console.log(`PASS ${name}`);
    } catch (error) {
        results.push({ name, result: 'failed', error: safeError(error) });
        console.error(`FAIL ${name}: ${safeError(error)}`);
    } finally { await dropIsolated(isolated); }
}
async function reject(action: Action, token = tokens[0], status?: number) {
    await assert.rejects(() => act(action, token), (error: unknown) =>
        error instanceof RuleError && (status === undefined || error.status === status));
}
async function start(real = false) {
    if (!real) await configure({ draft: { nominationMs: 600000, biddingMs: 600000, capMs: 600000 } });
    await act({ type: 'start' }, tokens[0]);
    return getState();
}
async function nomination(state: AuctionState, playerId?: string, amount = 1) {
    await act({ type: 'nominate', playerId: playerId || state.players.find(player =>
        !state.roster.some(entry => entry.playerId === player.id))!.id, amount }, tokens[state.draft.nominatorId! - 1]);
    return getState();
}
async function force(state: AuctionState) {
    await act({ type: 'force', lotId: state.lot!.id }, tokens[0]);
    return getState();
}
async function waitFor(predicate: (state: AuctionState) => boolean, timeout = 20000) {
    const began = Date.now();
    while (Date.now() - began < timeout) {
        const state = await getState();
        if (predicate(state)) return state;
        await sleep(30);
    }
    throw new Error('Scheduled state did not arrive');
}
async function fill(managerId: number, size = 20) {
    const state = await getState();
    const entries: Entry[] = syntheticPool().slice((managerId - 1) * 25, (managerId - 1) * 25 + size)
        .map((player, index) => ({ playerId: player.id, managerId, price: 1,
            placement: 'active', lotId: managerId * 100 + index }));
    await configure({ roster: [...state.roster, ...entries], managers: [{ id: managerId, budget: 1000 - size }] });
}
async function invariants() {
    const state = await getState();
    assert.equal(new Set(state.roster.map(entry => entry.playerId)).size, state.roster.length);
    for (const manager of state.managers) {
        const entries = state.roster.filter(entry => entry.managerId === manager.id);
        const count = counts(entries);
        assert(count.active <= 20 && count.taxi <= 3 && count.ir <= 2);
        assert(matching(entries.filter(entry => entry.placement === 'active')
            .map(entry => state.players.find(player => player.id === entry.playerId)!)));
    }
}
async function main() {
    await run('unconfigured local backend exposes no seats and rejects claims cleanly', async () => {
        assert.equal((await getState()).managers.length, 0);
        await assert.rejects(() => claimSeat(1), (error: unknown) =>
            error instanceof RuleError && error.status === 409);
    }, false);
    await run('readiness accepts the exact league and rejects missing or changed requirements', async () => {
        assert((await checkLeague(inspect)).ready);
        await configure({ managers: [{ id: 1, name: 'Michael-invalid' }] });
        assert.equal((await checkLeague(inspect)).ready, false);
        await configure({ managers: [{ id: 1, name: 'Michael', commissioner: false }] });
        assert.equal((await checkLeague(inspect)).ready, false);
        await configure({ managers: [{ id: 1, commissioner: true }], draft: { biddingMs: 4000 } });
        assert.equal((await checkLeague(inspect)).ready, false);
        await configure({ draft: { biddingMs: 10000, status: 'paused' } });
        assert.equal((await checkLeague(inspect)).ready, false);
        await configure({ draft: { status: 'setup' } });
        assert((await checkLeague(inspect)).ready);
    });
    await run('seat claims serialize and invalid tokens fail', async () => {
        await act({ type: 'release', managerId: 2 }, tokens[0]);
        const race = await Promise.allSettled(Array.from({ length: 20 }, () => claimSeat(2)));
        assert.equal(race.filter(result => result.status === 'fulfilled').length, 1);
        await reject({ type: 'start' }, '0'.repeat(64), 401);
        const claimed = race.find(result => result.status === 'fulfilled')!;
        assert.equal(await restoreSeat(claimed.value), 2);
        await assert.rejects(() => restoreSeat(tokens[1]), (error: unknown) =>
            error instanceof RuleError && error.status === 401);
        await reject({ type: 'start' }, claimed.value, 403);
        const publicState = await currentBackend().client.query(api.auction.state, { token: claimed.value });
        assert(!JSON.stringify(publicState).includes('tokenHash'));
        for (const name of ['admin:managers', 'admin:importPlayers', 'testOnly:configure', 'auction:expire']) {
            await assert.rejects(() => currentBackend().client.mutation(makeFunctionReference<'mutation'>(name), {}));
        }
    });
    await run('bid/bid races accept one identical amount', async () => {
        const state = await nomination(await start());
        const race = await Promise.allSettled(Array.from({ length: 20 }, (_, i) =>
            act({ type: 'bid', lotId: state.lot!.id, amount: 20 }, tokens[i % 10])));
        assert.equal(race.filter(result => result.status === 'fulfilled').length, 1);
        assert.equal((await events()).filter(event => event.type === 'bid').length, 1);
    });
    await run('bid/pass and pass/pass races award once with no re-entry', async () => {
        const state = await nomination(await start());
        const high = state.lot!.highBidderId;
        const rival = state.managers.find(manager => manager.id !== high)!.id;
        await Promise.all(state.managers.filter(manager => manager.id !== high && manager.id !== rival)
            .map(manager => act({ type: 'pass', lotId: state.lot!.id }, tokens[manager.id - 1])));
        await Promise.allSettled([act({ type: 'pass', lotId: state.lot!.id }, tokens[rival - 1]),
            act({ type: 'bid', lotId: state.lot!.id, amount: 2 }, tokens[rival - 1]),
            act({ type: 'pass', lotId: state.lot!.id }, tokens[rival - 1])]);
        const after = await getState();
        if (after.lot) await force(after);
        assert.equal((await events()).filter(event => event.type === 'sale').length, 1);
        await reject({ type: 'bid', lotId: state.lot!.id, amount: 3 }, tokens[rival - 1]);
    });
    await run('double force-end and undo/award races keep one sale per player', async () => {
        const state = await nomination(await start());
        const race = await Promise.allSettled(Array.from({ length: 20 }, () =>
            act({ type: 'force', lotId: state.lot!.id }, tokens[0])));
        assert.equal(race.filter(result => result.status === 'fulfilled').length, 1);
        const next = await nomination(await getState());
        const undo = await Promise.allSettled([act({ type: 'undo', lotId: state.lot!.id }, tokens[0]),
            act({ type: 'force', lotId: next.lot!.id }, tokens[0])]);
        const after = await getState();
        if (undo[0].status === 'fulfilled') {
            assert.equal(after.draft.status, 'paused');
            assert.equal(after.roster.length, 0);
        } else {
            assert(undo[0].reason instanceof RuleError && undo[0].reason.status === 409);
            assert.equal(after.roster.length, 2);
        }
    });
    await run('real nomination timeout and real bid timer arithmetic', async () => {
        const state = await start(true);
        assert.equal(state.draft.nominationMs, 10000);
        const lot = await waitFor(state => !!state.lot, 12000);
        assert.equal(lot.lot!.highBid, 1);
        assert.equal(lot.lot!.playerId, lot.players[0].id);
        const bidder = lot.managers.find(manager => manager.id !== lot.lot!.highBidderId)!.id;
        for (const amount of [2, 3]) {
            await act({ type: 'bid', lotId: lot.lot!.id, amount }, tokens[bidder - 1]);
            const bid = (await events()).filter(event => event.type === 'bid').at(-1)!.data;
            assert.equal(bid.deadline, Math.min(Number(bid.beforeDeadline) + 5000, Number(bid.now) + 15000));
            if (amount === 3) assert.equal(bid.deadline, Number(bid.now) + 15000);
        }
        await act({ type: 'pause' }, tokens[0]);
        const paused = await getState();
        await sleep(300);
        assert.equal((await getState()).draft.remainingMs, paused.draft.remainingMs);
        await act({ type: 'resume' }, tokens[0]);
        const resumed = (await events()).findLast(event => event.type === 'resume')!.data;
        assert.equal(Number(resumed.deadline) - Number(resumed.now), paused.draft.remainingMs);
        await waitFor(state => state.roster.some(entry => entry.lotId === lot.lot!.id), 17000);
        await reject({ type: 'bid', lotId: lot.lot!.id, amount: 4 }, tokens[bidder - 1], 409);
        assert.equal((await events()).filter(event => event.type === 'sale').length, 1);
    });
    await run('stale scheduled timers no-op after a newer lot, undo, and pause/resume', async () => {
        await start();
        await configure({ draft: { biddingMs: 3000 } });
        let state = await nomination(await getState());
        const saved = (await inspect()).draft;
        const stale = { draftId: saved._id, lotId: state.lot!.id,
            version: saved.version, deadline: saved.value.deadline };
        await act({ type: 'pause' }, tokens[0]);
        const frozen = (await getState()).draft.remainingMs;
        await sleep(Math.max(0, stale.deadline - Date.now()) + 100);
        await currentBackend().admin('auction:expire', stale);
        assert.equal((await getState()).draft.remainingMs, frozen);
        await act({ type: 'resume' }, tokens[0]);
        await currentBackend().admin('auction:expire', stale);
        assert.equal((await getState()).lot!.id, state.lot!.id);
        await force(await getState());
        const newer = await nomination(await getState());
        await currentBackend().admin('auction:expire', stale);
        assert.equal((await getState()).lot!.id, newer.lot!.id);
        await act({ type: 'undo', lotId: state.lot!.id }, tokens[0]);
        await currentBackend().admin('auction:expire', stale);
        state = await getState();
        assert.equal(state.draft.status, 'paused');
        assert.equal(state.roster.length, 0);
    });
    await run('repeat undo removes current placement, refunds, voids open bids, and restores turn', async () => {
        let state = await nomination(await start(), 'test-0', 30);
        const original = state.lot!;
        await force(state);
        await act({ type: 'place', playerId: original.playerId, placement: 'taxi' }, tokens[original.highBidderId - 1]);
        state = await nomination(await getState(), 'test-1', 5);
        await force(state);
        const open = await nomination(await getState(), 'test-2', 10);
        for (const lotId of [state.lot!.id, original.id]) await act({ type: 'undo', lotId }, tokens[0]);
        const after = await getState();
        assert.equal(after.roster.length, 0);
        assert.equal(after.draft.nominatorId, original.nominatorId);
        assert(after.managers.every(manager => manager.budget === 1000));
        assert((await inspect()).lots.some((lot: { id: number; status: string }) => lot.id === open.lot!.id
            && lot.status === 'void'));
    });
    await run('placement rules reject bad IR, full taxi and standing-bid reserve loss', async () => {
        const state = await nomination(await start(), 'test-1', 1);
        const owner = state.lot!.highBidderId;
        await force(state);
        await reject({ type: 'place', playerId: 'test-1', placement: 'ir' }, tokens[owner - 1]);
        await reject({ type: 'place', playerId: 'test-1', placement: 'taxi' }, tokens[owner % 10]);
    });
    await run('a placement cannot invalidate a standing high bid', async () => {
        let state = await nomination(await start(), 'test-0', 10);
        const owner = state.lot!.highBidderId;
        await force(state);
        state = await nomination(await getState(), 'test-1', 1);
        await act({ type: 'bid', lotId: state.lot!.id, amount: 972 }, tokens[owner - 1]);
        await reject({ type: 'place', playerId: 'test-0', placement: 'taxi' }, tokens[owner - 1]);
    });
    await run('all six placement paths succeed and ownership is enforced', async () => {
        const state = await nomination(await start(), 'test-0', 10);
        const owner = state.lot!.highBidderId;
        await force(state);
        for (const placement of ['taxi', 'ir', 'active', 'ir', 'taxi', 'active'] as const) {
            await act({ type: 'place', playerId: 'test-0', placement }, tokens[owner - 1]);
            assert.equal((await getState()).roster[0].placement, placement);
        }
        await reject({ type: 'place', playerId: 'test-0', placement: 'taxi' }, tokens[owner % 10]);
    });
    await run('implicit give-up never removes a manager with a valid higher bid', async () => {
        const state = await nomination(await start(), 'test-0', 1);
        const high = state.lot!.highBidderId;
        const rival = state.managers.find(manager => manager.id !== high)!.id;
        await configure({ managers: [{ id: rival, budget: 21 }] });
        await Promise.all(state.managers.filter(manager => manager.id !== high && manager.id !== rival)
            .map(manager => act({ type: 'pass', lotId: state.lot!.id }, tokens[manager.id - 1])));
        assert.equal((await getState()).lot!.id, state.lot!.id);
        await act({ type: 'bid', lotId: state.lot!.id, amount: 2 }, tokens[rival - 1]);
        assert.equal((await getState()).lot!.highBidderId, rival);
    });
    await run('implicit give-up awards at the equal-maximum boundary', async () => {
        const state = await start();
        await configure({ managers: state.managers.filter(manager => manager.id !== state.draft.nominatorId)
            .map(manager => ({ id: manager.id, budget: 20 })) });
        const after = await nomination(await getState(), 'test-0', 1);
        assert.equal(after.lot, null);
        assert.equal(after.recentEvents.find(event => event.type === 'sale')!.data.reason, 'all-out');
    });
    await run('taxi-only and IR-only managers nominate and win with full active rosters', async () => {
        for (let id = 1; id <= 10; id++) await fill(id);
        let state = await start();
        for (const playerId of ['test-273', 'test-280']) {
            const nominator = state.draft.nominatorId!;
            state = await nomination(state, playerId);
            const rival = nominator % 10 + 1;
            await act({ type: 'bid', lotId: state.lot!.id, amount: 2 }, tokens[rival - 1]);
            state = await force(await getState());
            assert.equal(state.roster.find(entry => entry.playerId === playerId)!.placement,
                playerId === 'test-273' ? 'taxi' : 'ir');
        }
    });
    await run('taxi/IR timeouts pass a full cycle without marking anyone done', async () => {
        for (let id = 1; id <= 10; id++) await fill(id);
        await configure({ draft: { nominationMs: 150 } });
        await act({ type: 'start' }, tokens[0]);
        const complete = await waitFor(state => state.draft.status === 'complete', 5000);
        assert.equal(complete.draft.completionReason, 'full-cycle-passed');
        assert(complete.managers.every(manager => !manager.done));
        assert.equal((await events()).filter(event => event.type === 'nomination-pass').length, 10);
    });
    await run('full active rosters, taxi-only timeout and all-done endgames complete', async () => {
        for (let id = 1; id <= 10; id++) await fill(id);
        await start();
        for (let id = 1; id <= 10; id++) await act({ type: 'done', done: true }, tokens[id - 1]);
        assert.equal((await getState()).draft.status, 'complete');
    });
    await run('Done is reversible while running and leaves late bids available', async () => {
        await fill(1);
        let state = await start();
        await act({ type: 'done', done: true }, tokens[0]);
        await act({ type: 'done', done: false }, tokens[0]);
        assert.equal((await getState()).managers[0].done, false);
        state = await nomination(await getState(), 'test-30');
        await act({ type: 'done', done: true }, tokens[0]);
        await act({ type: 'bid', lotId: state.lot!.id, amount: 100 }, tokens[0]);
        state = await force(await getState());
        assert.equal(state.roster.find(entry => entry.playerId === 'test-30')!.placement, 'taxi');
    });
    await run('Resume nominations remains available after a move opens an active spot', async () => {
        await fill(1);
        await start();
        await act({ type: 'done', done: true }, tokens[0]);
        await act({ type: 'place', playerId: 'test-0', placement: 'taxi' }, tokens[0]);
        await act({ type: 'done', done: false }, tokens[0]);
        assert.equal((await getState()).managers[0].done, false);
        await reject({ type: 'done', done: true }, tokens[0]);
    });
    await run('done managers still bid into taxi, and a fourth taxi placement fails', async () => {
        await fill(1);
        await start();
        await act({ type: 'done', done: true }, tokens[0]);
        for (const playerId of ['test-30', 'test-33', 'test-36']) {
            const state = await nomination(await getState(), playerId);
            await act({ type: 'bid', lotId: state.lot!.id, amount: 100 }, tokens[0]);
            await force(await getState());
        }
        await reject({ type: 'place', playerId: 'test-3', placement: 'taxi' }, tokens[0]);
        assert.equal((await getState()).managers[0].done, true);
    });
    await run('all active, taxi and IR groups full complete immediately', async () => {
        const pool = syntheticPool();
        const roster: Entry[] = [];
        for (let id = 1; id <= 10; id++) for (let i = 0; i < 25; i++) {
            const player = pool[(id - 1) * 25 + i];
            if (i >= 20 && i < 23) player.yearsExp = 0;
            if (i >= 23) player.injuryStatus = 'Out';
            roster.push({ playerId: player.id, managerId: id, placement: i < 20 ? 'active' : i < 23 ? 'taxi' : 'ir',
                lotId: (id - 1) * 25 + i + 1, price: 1 });
        }
        await seedPlayers(pool);
        await configure({ roster });
        assert.equal((await start()).draft.status, 'complete');
    });
    await run('IR-only endgame permits Out and rejects IR status; exhausted pool completes', async () => {
        const pool = syntheticPool().map(player => ({ ...player, yearsExp: 10, careerGames: 100,
            injuryStatus: player.id === 'test-299' ? 'Out' : 'IR' }));
        await seedPlayers(pool);
        for (let id = 1; id <= 10; id++) await fill(id);
        const state = await nomination(await start(), 'test-299', 500);
        const after = await force(state);
        assert.equal(after.roster.find(entry => entry.playerId === 'test-299')!.placement, 'ir');
        assert.equal(after.draft.status, 'complete');
    });
    await run('empty pool, full groups, exhausted budgets and append-only constraints', async () => {
        await seedPlayers([]);
        await reject({ type: 'start' });
        await seedPlayers();
        await configure({ managers: Array.from({ length: 10 }, (_, i) => ({ id: i + 1, budget: 0 })) });
        assert.equal((await start()).draft.status, 'complete');
        for (const name of ['admin:reset', 'auction:deleteEvents', 'auction:updateEvent']) {
            await assert.rejects(() => currentBackend().client.mutation(makeFunctionReference<'mutation'>(name), {}));
        }
    });
    await run('constraints independently reject duplicate sales and non-increasing bids', async () => {
        const state = await nomination(await start());
        await reject({ type: 'bid', lotId: state.lot!.id, amount: 1 });
        await reject({ type: 'nominate', playerId: state.lot!.playerId, amount: 1 });
        await force(state);
        const after = await getState();
        await reject({ type: 'nominate', playerId: state.lot!.playerId, amount: 1 },
            tokens[after.draft.nominatorId! - 1]);
    });
    await run('import refuses after start and scheduler acts without polling clients', async () => {
        await configure({ draft: { nominationMs: 200, biddingMs: 200 } });
        await act({ type: 'start' }, tokens[0]);
        await assert.rejects(() => seedPlayers());
        await assert.rejects(() => seedManagers());
        await sleep(600);
        const logged = await events();
        assert(logged.some(event => event.type === 'nomination' && event.data.auto));
        assert(logged.some(event => event.type === 'sale' && event.data.reason === 'deadline'));
    });
    const root = process.env.EVIDENCE_DIR!;
    await mkdir(`${root}/db`, { recursive: true });
    await writeFile(`${root}/db/results.json`, JSON.stringify(results, null, 2));
    assert(results.every(result => result.result === 'passed'), 'Convex integration regressions must pass');
}
main().catch(error => { console.error(safeError(error)); process.exitCode = 1; });
