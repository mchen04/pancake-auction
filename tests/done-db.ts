import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { act, claimSeat, getState } from '../lib/engine';
import { canNominate, counts, legalPlacements, maxBid, taxiEligibility } from '../lib/rules';
import type { AuctionState, Placement } from '../lib/types';
import { Replay } from '../scripts/audit';
import { loadEnvironment, safeError } from '../scripts/env';
import { createIsolated, dropIsolated, seedManagers, seedPlayers, sql } from './support';

const results: { name: string; result: string; error?: string }[] = [];
let tokens: string[];
async function scenario(name: string, test: () => Promise<void>) {
    const schema = await createIsolated('test');
    try {
        await seedManagers();
        await seedPlayers();
        tokens = await Promise.all(Array.from({ length: 10 }, (_, i) => claimSeat(i + 1)));
        await sql('UPDATE draft SET nomination_ms=600000,bidding_ms=600000,cap_ms=600000');
        await test();
        await checkReplay();
        results.push({ name, result: 'passed' });
        console.log(`PASS ${name}`);
    } catch (error) {
        results.push({ name, result: 'failed', error: safeError(error) });
        console.error(`FAIL ${name}: ${safeError(error)}`);
    } finally {
        await dropIsolated(schema);
    }
}
async function checkReplay() {
    const state = await getState();
    const replay = new Replay(state.players, state.managers.map(manager => manager.id));
    for (const event of (await sql('SELECT * FROM events ORDER BY id')).rows) replay.apply(event);
    for (const manager of state.managers) {
        assert.equal(replay.done.has(manager.id), manager.done);
        assert.equal(replay.budgets.get(manager.id), manager.budget);
        assert.deepEqual(replay.team(manager.id), state.roster.filter(entry => entry.managerId === manager.id));
    }
    assert.deepEqual([...replay.passedTurns], state.draft.passedTurns);
    assert.equal(replay.complete, state.draft.status === 'complete');
}
async function sell(state: AuctionState, playerId: string, winner: number) {
    await act({ type: 'nominate', playerId, amount: 1 }, tokens[state.draft.nominatorId! - 1]);
    let next = await getState();
    if (next.lot!.highBidderId !== winner) {
        await act({ type: 'bid', lotId: next.lot!.id, amount: 2 }, tokens[winner - 1]);
    }
    next = await getState();
    await act({ type: 'force', lotId: next.lot!.id }, tokens[0]);
    return next.lot!;
}
async function fullDraft() {
    await act({ type: 'start' }, tokens[0]);
    let last;
    for (let sale = 0; sale < 200; sale++) {
        const state = await getState();
        const incomplete = state.managers.filter(manager => counts(team(state, manager.id)).active < 20);
        let winner = sale < 198 ? sale % 10 + 1 : incomplete[0].id;
        if (sale === 198) {
            const next = state.draft.order[(state.draft.turnIndex + 1) % 10];
            winner = incomplete.find(manager => manager.id === next)?.id ?? incomplete[0].id;
        }
        const entries = team(state, winner);
        const position = (['PG', 'SG', 'SF', 'PF', 'C'] as const)[counts(entries).active % 5];
        const nominator = state.managers.find(manager => manager.id === state.draft.nominatorId)!;
        const player = state.players.find(player => player.positions.includes(position)
            && !state.roster.some(entry => entry.playerId === player.id)
            && maxBid(nominator.budget, player, team(state, nominator.id), state.players) >= 1
            && legalPlacements(player, entries, state.players).includes('active'));
        assert(player);
        last = await sell(state, player.id, winner);
    }
    const state = await getState();
    assert.equal(state.roster.filter(entry => entry.placement === 'active').length, 200);
    assert(last && last.highBidderId !== last.nominatorId);
    return { state, last };
}
function team(state: AuctionState, id: number) {
    return state.roster.filter(entry => entry.managerId === id);
}
async function othersDone(victim: number) {
    const state = await getState();
    for (const manager of state.managers.filter(manager => manager.id !== victim)) {
        await act({ type: 'done', done: true }, tokens[manager.id - 1]);
    }
    return getState();
}
async function expectResumed(victim: number) {
    const state = await othersDone(victim);
    assert.equal(state.draft.status, 'running');
    assert.equal(counts(team(state, victim)).active, 19);
    assert.equal(state.managers.find(manager => manager.id === victim)!.done, false);
    assert(canNominate(state, state.managers.find(manager => manager.id === victim)));
    assert.equal(state.draft.nominatorId, victim);
}
async function automaticEvent(victim: number) {
    const events = (await sql("SELECT * FROM events WHERE type='done' AND manager_id=$1", [victim])).rows;
    assert(events.some(event => event.data.done === false && event.data.reason === 'active-spot-opened'));
}
async function move(control: 'no-move' | 'explicit-resume' | 'automatic', placement: Placement = 'taxi') {
    const { state } = await fullDraft();
    const entry = state.roster.find(entry => entry.managerId !== state.draft.nominatorId
        && (placement === 'taxi' ? taxiEligibility(state.players.find(player => player.id === entry.playerId)!)
            === 'eligible' : state.players.find(player => player.id === entry.playerId)!.injuryStatus === 'Out'))!;
    assert(entry);
    const victim = entry.managerId;
    await act({ type: 'done', done: true }, tokens[victim - 1]);
    if (control === 'no-move') {
        const completed = await othersDone(victim);
        assert.equal(completed.draft.status, 'complete');
        assert.equal(counts(team(completed, victim)).active, 20);
        assert.equal(completed.managers.find(manager => manager.id === victim)!.done, true);
        return;
    }
    await act({ type: 'place', playerId: entry.playerId, placement }, tokens[victim - 1]);
    if (control === 'explicit-resume') await act({ type: 'done', done: false }, tokens[victim - 1]);
    await expectResumed(victim);
    if (control === 'automatic') await automaticEvent(victim);
}
async function undo(control: 'explicit-resume' | 'automatic' | 'taxi' | 'ir') {
    const { state, last } = await fullDraft();
    let sale = last;
    if (control === 'taxi' || control === 'ir') {
        const winner = state.managers.find(manager => manager.id !== state.draft.nominatorId)!;
        const player = state.players.find(player => !state.roster.some(entry => entry.playerId === player.id)
            && legalPlacements(player, team(state, winner.id), state.players).includes(control));
        assert(player);
        sale = await sell(state, player.id, winner.id);
        if (control === 'ir') {
            await act({ type: 'place', playerId: player.id, placement: 'ir' }, tokens[winner.id - 1]);
        }
    }
    const victim = sale.highBidderId;
    assert.notEqual(victim, sale.nominatorId);
    await act({ type: 'done', done: true }, tokens[victim - 1]);
    await act({ type: 'done', done: true }, tokens[sale.nominatorId - 1]);
    await act({ type: 'undo', lotId: sale.id }, tokens[0]);
    const paused = await getState();
    assert.equal(paused.draft.status, 'paused');
    assert.equal(paused.managers.find(manager => manager.id === sale.nominatorId)!.done, false);
    if (control === 'taxi' || control === 'ir') {
        assert.equal(counts(team(paused, victim)).active, 20);
        assert.equal(paused.managers.find(manager => manager.id === victim)!.done, true);
        return;
    }
    if (control === 'automatic') {
        assert.equal(paused.managers.find(manager => manager.id === victim)!.done, false);
        await automaticEvent(victim);
    }
    await act({ type: 'resume' }, tokens[0]);
    if (control === 'explicit-resume') await act({ type: 'done', done: false }, tokens[victim - 1]);
    await expectResumed(victim);
}
async function main() {
    loadEnvironment();
    const root = process.env.EVIDENCE_DIR;
    assert(root);
    await mkdir(`${root}/done-db`, { recursive: true });
    await scenario('C12 no-move control completes at twenty active with Done retained', () => move('no-move'));
    await scenario('C12 explicit-resume control restores the active nomination', () => move('explicit-resume'));
    await scenario('C12 Active to Taxi automatically clears Done before completion', () => move('automatic'));
    await scenario('C12 Active to IR automatically clears Done before completion', () => move('automatic', 'ir'));
    await scenario('C12 optional Taxi and IR moves leave full-active manager Done', async () => {
        const { state } = await fullDraft();
        const winner = state.managers.find(manager => manager.id !== state.draft.nominatorId)!;
        const player = state.players.find(player => !state.roster.some(entry => entry.playerId === player.id)
            && taxiEligibility(player) === 'eligible' && player.injuryStatus === 'Out');
        assert(player);
        await sell(state, player.id, winner.id);
        await act({ type: 'done', done: true }, tokens[winner.id - 1]);
        for (const placement of ['ir', 'taxi'] as const) {
            await act({ type: 'place', playerId: player.id, placement }, tokens[winner.id - 1]);
            const moved = await getState();
            assert.equal(counts(team(moved, winner.id)).active, 20);
            assert.equal(moved.managers.find(manager => manager.id === winner.id)!.done, true);
        }
    });
    await scenario('C15 explicit-resume control restores distinct winner after Undo', () => undo('explicit-resume'));
    await scenario('C15 Undo automatically resumes distinct Done winner with nineteen active', () => undo('automatic'));
    await scenario('C15 Undo Taxi control leaves full-active winner Done', () => undo('taxi'));
    await scenario('C15 Undo IR control leaves full-active winner Done', () => undo('ir'));
    await writeFile(`${root}/done-db/results.json`, JSON.stringify(results, null, 2));
    assert(results.every(result => result.result === 'passed'), 'Done database regressions must pass');
}
main().catch(error => { console.error(safeError(error)); process.exitCode = 1; });
