import { makeEvidenceDirectory as mkdir, writeEvidenceFile as writeFile } from '../scripts/evidence';
import assert from 'node:assert/strict';

import { act, claimSeat, getState, RuleError } from './support';
import { counts } from '../lib/rules';
import { safeError } from '../scripts/env';
import { createIsolated, dropIsolated, seedManagers, seedPlayers, sleep, configure } from './support';
import type { AuctionState } from '../lib/types';

const results: { name: string; result: string; error?: string }[] = [];
const root = process.env.EVIDENCE_DIR;
let tokens: string[];

async function scenario(name: string, test: () => Promise<void>) {
    const schema = await createIsolated('test');
    try {
        await seedManagers();
        await seedPlayers();
        tokens = await Promise.all(Array.from({ length: 10 }, (_, i) => claimSeat(i + 1)));
        await act({ type: 'mode', mode: 'live-v1' }, tokens[0]);
        await configure({ draft: { nominationMs: 600000, biddingMs: 600000 } });
        await test();
        results.push({ name, result: 'passed' });
        console.log(`PASS ${name}`);
    } catch (error) {
        results.push({ name, result: 'failed', error: safeError(error) });
        console.error(`FAIL ${name}: ${safeError(error)}`);
    } finally {
        await dropIsolated(schema);
    }
}

async function start() {
    await act({ type: 'start' }, tokens[0]);
    return getState();
}
async function nominate(playerId: string) {
    const state = await getState();
    await act({ type: 'nominate', playerId, amount: 1 }, tokens[state.draft.nominatorId! - 1]);
    return getState();
}
async function force(state: AuctionState) {
    if (state.lot) await act({ type: 'force', lotId: state.lot.id }, tokens[0]);
}
async function fullDraft() {
    await start();
    for (let sale = 0; sale < 200; sale++) {
        const state = await getState();
        const id = state.draft.nominatorId!;
        const active = counts(state.roster.filter(entry => entry.managerId === id)).active;
        const position = (['PG', 'SG', 'SF', 'PF', 'C'] as const)[active % 5];
        const player = state.players.find(player => player.positions.includes(position)
            && !state.roster.some(entry => entry.playerId === player.id))!;
        await force(await nominate(player.id));
    }
    const state = await getState();
    assert.equal(state.roster.filter(entry => entry.placement === 'active').length, 200);
    return state;
}
async function stalePass(control: boolean) {
    let state = await fullDraft();
    const victim = state.draft.nominatorId!;
    const rookie = state.roster.find(entry => entry.managerId === victim
        && state.players.find(player => player.id === entry.playerId)!.yearsExp === 0)!;
    await configure({ draft: { nominationMs: 1000 }, deadlineAfterMs: 1000 });
    await sleep(1100);
    state = await getState();
    assert(state.draft.passedTurns.includes(victim));
    await act({ type: 'place', playerId: rookie.playerId, placement: 'taxi' }, tokens[victim - 1]);
    if (control) await act({ type: 'done', done: false }, tokens[victim - 1]);
    state = await getState();
    for (let turn = 0; turn < 12 && state.draft.status === 'running'
        && state.draft.nominatorId !== victim; turn++) {
        await sleep(1100);
        state = await getState();
    }
    assert.equal(counts(state.roster.filter(entry => entry.managerId === victim)).active, 19);
    assert.equal(state.managers.find(manager => manager.id === victim)!.done, false);
    assert.equal(state.draft.status, 'running');
    assert.equal(state.draft.nominatorId, victim);
    assert(!state.draft.passedTurns.includes(victim));
}
async function pausedLot() {
    await start();
    for (let i = 0; i < 20; i++) {
        let state = await nominate(`test-${i}`);
        if (state.lot!.highBidderId !== 2) {
            await act({ type: 'bid', lotId: state.lot!.id, amount: 2 }, tokens[1]);
        }
        state = await getState();
        await force(state);
        if (i === 0) await act({ type: 'place', playerId: 'test-0', placement: 'taxi' }, tokens[1]);
    }
    let state = await nominate('test-28');
    if (state.lot!.highBidderId === 2) {
        await act({ type: 'bid', lotId: state.lot!.id, amount: 2 }, tokens[0]);
    }
    state = await getState();
    const lot = state.lot!;
    for (const manager of state.managers) {
        if (![lot.highBidderId, 2].includes(manager.id)) {
            await act({ type: 'pass', lotId: lot.id }, tokens[manager.id - 1]);
        }
    }
    await act({ type: 'pause' }, tokens[0]);
    return getState();
}
async function pausedMove() {
    const before = await pausedLot();
    await assert.rejects(() => act({ type: 'pass', lotId: before.lot!.id }, tokens[1]), /paused/);
    await act({ type: 'place', playerId: 'test-0', placement: 'taxi' }, tokens[1]);
    assert.equal((await getState()).lot!.id, before.lot!.id);
    await act({ type: 'place', playerId: 'test-0', placement: 'active' }, tokens[1]);
    const after = await getState();
    assert.equal(after.draft.status, 'paused');
    assert.equal(after.draft.phase, 'bidding');
    assert.equal(after.lot?.id, before.lot!.id);
    assert.equal(after.draft.remainingMs, before.draft.remainingMs);
    assert(!after.roster.some(entry => entry.playerId === 'test-28'));
    await act({ type: 'resume' }, tokens[0]);
    const resumed = await getState();
    assert(resumed.roster.some(entry => entry.playerId === 'test-28'));
    assert.equal(resumed.recentEvents.find(event => event.type === 'sale')!.data.reason, 'all-out');
}
async function sales() {
    await start();
    const a = await nominate('test-0');
    await force(a);
    const b = await nominate('test-1');
    await force(b);
    return { a: a.lot!.id, b: b.lot!.id };
}
async function main() {
    if (!root) throw new Error('Set EVIDENCE_DIR');
    await mkdir(`${root}/review-db`, { recursive: true });
    await scenario('B1/C1 stale timeout is cleared when Active moves to Taxi', () => stalePass(false));
    await scenario('B1/C1 done:false negative control restores the nomination', () => stalePass(true));
    await scenario('B1/C1 no-op placement preserves a valid timeout pass', async () => {
        let state = await fullDraft();
        const victim = state.draft.nominatorId!;
        const entry = state.roster.find(entry => entry.managerId === victim)!;
        await configure({ draft: { nominationMs: 1000 }, deadlineAfterMs: 1000 });
        await sleep(1100);
        state = await getState();
        assert(state.draft.passedTurns.includes(victim));
        await act({ type: 'place', playerId: entry.playerId, placement: 'active' }, tokens[victim - 1]);
        state = await getState();
        assert(state.draft.passedTurns.includes(victim));
        for (let turn = 0; turn < 12 && state.draft.status === 'running'; turn++) {
            await sleep(1100);
            state = await getState();
        }
        assert.equal(state.draft.status, 'complete');
        assert.equal(state.draft.completionReason, 'full-cycle-passed');
    });
    await scenario('B5/C11 paused placement freezes sale; resume awards all-out', pausedMove);
    await scenario('B5/C11 explicit commissioner force remains legal while paused', async () => {
        const before = await pausedLot();
        await act({ type: 'force', lotId: before.lot!.id }, tokens[0]);
        const state = await getState();
        assert.equal(state.draft.status, 'paused');
        assert.equal(state.recentEvents.find(event => event.type === 'sale')!.data.reason, 'force');
    });
    await scenario('S5/C10 stale expected sale cannot undo a newer sale', async () => {
        const { a, b } = await sales();
        await assert.rejects(() => act({ type: 'undo', lotId: a }, tokens[0]),
            (error: unknown) => error instanceof RuleError && error.status === 409);
        const state = await getState();
        assert(state.roster.some(entry => entry.lotId === b));
        assert.equal(state.draft.status, 'running');
    });
    await scenario('S5/C10 matching expected sale still refunds and pauses', async () => {
        const { b } = await sales();
        await act({ type: 'undo', lotId: b }, tokens[0]);
        const state = await getState();
        assert.equal(state.draft.status, 'paused');
        assert(!state.roster.some(entry => entry.lotId === b));
    });
    await scenario('B4/C9 server stale-lot 409 negative control', async () => {
        await start();
        const a = await nominate('test-0');
        await force(a);
        const b = await nominate('test-1');
        await assert.rejects(() => act({ type: 'bid', lotId: a.lot!.id, amount: 900 }, tokens[0]),
            (error: unknown) => error instanceof RuleError && error.status === 409);
        assert.equal((await getState()).lot!.id, b.lot!.id);
        assert.equal((await getState()).lot!.highBid, 1);
    });
    await writeFile(`${root}/review-db/results.json`, JSON.stringify(results, null, 2));
    assert(results.every(result => result.result === 'passed'), 'Review database regressions must pass');
}
main().catch(error => { console.error(safeError(error)); process.exitCode = 1; });
