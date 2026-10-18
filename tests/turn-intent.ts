import { makeEvidenceDirectory as mkdir, writeEvidenceFile as writeFile } from '../scripts/evidence';
import assert from 'node:assert/strict';

import { api } from '../convex/_generated/api';
import { act, claimSeat, configure, createIsolated, currentClient, dropIsolated, getState,
    seedManagers, seedPlayers } from './support';
import type { AuctionState } from '../lib/types';
import { makeFunctionReference } from 'convex/server';
import type { MutationResult } from '../convex/_generated/api';

type LegacyAction = { type: 'nominate'; playerId: string; amount: number }
    | { type: 'done'; done: boolean }
    | { type: 'force'; lotId: number; expectedHighBid?: number; expectedHighBidderId?: number };
const legacyAction = makeFunctionReference<'mutation', { token: string; action: LegacyAction }, MutationResult>(
    'auction:actOnDraft');

const results: { name: string; result: string; error?: string }[] = [];
async function check(name: string, run: () => Promise<void>) {
    try { await run(); results.push({ name, result: 'passed' }); console.log(`PASS ${name}`); }
    catch (error) { results.push({ name, result: 'failed', error: String(error) }); }
}
async function main() {
    const name = await createIsolated('test');
    try {
        await seedManagers(); await seedPlayers();
        const tokens = await Promise.all(Array.from({ length: 10 }, (_, i) => claimSeat(i + 1)));
        await act({ type: 'mode', mode: 'live-v1' }, tokens[0]);
        await configure({ draft: { nominationMs: 600000, biddingMs: 600000, capMs: 600000 } });
        await act({ type: 'start' }, tokens[0]);
        const first = await getState();
        function later(before: AuctionState, after: AuctionState) {
            const [beforeDraft, beforeSequence] = before.draft.nominationGeneration.split(':');
            const [afterDraft, afterSequence] = after.draft.nominationGeneration.split(':');
            assert.equal(afterDraft, beforeDraft);
            assert(Number(afterSequence) > Number(beforeSequence));
        }
        async function reject(state: AuctionState, generation = state.draft.nominationGeneration) {
            const result = await currentClient().transport.mutation(api.auction.actOnDraft,
                { token: tokens[state.draft.nominatorId! - 1], action: { type: 'nominate',
                    playerId: state.players[100].id, amount: 400, nominationGeneration: generation } });
            assert(!result.ok && result.status === 409);
            assert.equal(result.error, 'That nomination turn has ended');
        }
        await check('C19 pause and resume invalidate the old nomination without losing frozen time', async () => {
            await act({ type: 'pause' }, tokens[0]); const paused = await getState();
            later(first, paused);
            await act({ type: 'resume' }, tokens[0]); const resumed = await getState();
            later(paused, resumed);
            const resume = resumed.recentEvents.find(event => event.type === 'resume')!;
            assert.equal(resumed.draft.deadline! - resume.at, paused.draft.remainingMs);
            await reject(first);
            await reject(resumed, `different-draft:${resumed.draft.nominationGeneration.split(':')[1]}`);
            assert.equal((await getState()).lot, null);
        });
        await check('C19 Undo never restores an earlier nomination generation', async () => {
            const current = await getState();
            await act({ type: 'nominate', playerId: current.players[0].id, amount: 1,
                nominationGeneration: current.draft.nominationGeneration }, tokens[current.draft.nominatorId! - 1]);
            const bidding = await getState();
            await act({ type: 'force', lotId: bidding.lot!.id,
                expectedHighBidderId: bidding.lot!.highBidderId, expectedHighBid: bidding.lot!.highBid }, tokens[0]);
            const next = await getState(); later(current, next);
            await act({ type: 'undo', lotId: bidding.lot!.id }, tokens[0]);
            const undone = await getState(); later(next, undone);
            await act({ type: 'resume' }, tokens[0]); const resumed = await getState(); later(undone, resumed);
            await reject(current);
            assert.equal(resumed.managers.find(m => m.id === current.draft.nominatorId)!.budget, 1000);
        });
        await check('Reopening another manager preserves the current nomination intent', async () => {
            const current = await getState();
            await configure({ roster: current.players.slice(0, 20).map((player, index) => ({ playerId: player.id,
                managerId: 1, placement: 'active', lotId: index + 100, price: 1 })),
                managers: [{ id: 1, done: true }], draft: { status: 'running', phase: 'nomination',
                    nominatorId: 2, turnIndex: 1, lotId: null }, deadlineAfterMs: 600000 });
            const before = await getState();
            await act({ type: 'place', playerId: before.players[0].id, placement: 'taxi' }, tokens[0]);
            const after = await getState();
            assert.equal(after.draft.nominationGeneration, before.draft.nominationGeneration);
            assert.equal(after.draft.deadline, before.draft.deadline);
            assert.equal(after.managers[0].done, false);
            await act({ type: 'nominate', playerId: before.players[100].id, amount: 10,
                nominationGeneration: before.draft.nominationGeneration }, tokens[1]);
            assert.equal((await getState()).lot!.highBid, 10);
        });
        async function preferenceTurn(nominatorId = 2) {
            const state = await getState();
            await configure({ roster: state.players.slice(0, 20).map((player, index) => ({ playerId: player.id,
                managerId: 1, placement: 'active', lotId: index + 100, price: 1 })),
                managers: [{ id: 1, done: false }], draft: { status: 'running', phase: 'nomination',
                    nominatorId, turnIndex: nominatorId - 1, lotId: null, passedTurns: [] },
                deadlineAfterMs: 600000 });
            return getState();
        }
        await check('A non-nominator applies an old-generation Done preference idempotently', async () => {
            const old = await preferenceTurn();
            await configure({ draft: { nominatorId: 3, turnIndex: 2 } });
            const current = await getState(); later(old, current);
            const preference = { type: 'done' as const, done: true,
                nominationGeneration: old.draft.nominationGeneration };
            await act(preference, tokens[0]);
            assert.equal((await getState()).managers[0].done, true);
            await act(preference, tokens[0]);
            assert.equal((await getState()).managers[0].done, true);
            await act({ ...preference, done: false }, tokens[0]);
            assert.equal((await getState()).managers[0].done, false);
        });
        await check('The current nominator rejects an earlier-turn Done true that would change state', async () => {
            const old = await preferenceTurn(1);
            await configure({ draft: { nominatorId: 2, turnIndex: 1 } });
            await configure({ draft: { nominatorId: 1, turnIndex: 0 } });
            const before = await getState(); later(old, before);
            assert.equal(before.managers[0].done, false);
            const result = await currentClient().transport.mutation(api.auction.actOnDraft,
                { token: tokens[0], action: { type: 'done', done: true,
                    nominationGeneration: old.draft.nominationGeneration } });
            assert(!result.ok && result.status === 409);
            assert.equal(result.error, 'That nomination turn has ended');
            assert.equal((await getState()).managers[0].done, false);
            await act({ type: 'done', done: true,
                nominationGeneration: before.draft.nominationGeneration }, tokens[0]);
            const after = await getState();
            assert.equal(after.managers[0].done, true);
            assert.notEqual(after.draft.nominatorId, 1);
        });
        async function missing(action: LegacyAction, token: string) {
            const before = await getState();
            const result = await currentClient().transport.mutation(legacyAction, { token, action });
            assert(!result.ok && result.status === 409);
            assert.equal(result.error, 'Refresh the page to continue');
            const after = await getState();
            assert.deepEqual({ ...after, serverNow: 0 }, { ...before, serverNow: 0 });
        }
        await check('Old tabs missing nomination generation receive a plain error without state changes', async () => {
            const state = await preferenceTurn(2);
            await missing({ type: 'nominate', playerId: state.players[100].id, amount: 400 }, tokens[1]);
            await act({ type: 'nominate', playerId: state.players[100].id, amount: 1,
                nominationGeneration: state.draft.nominationGeneration }, tokens[1]);
            assert.equal((await getState()).lot!.highBid, 1);
        });
        await check('Old tabs missing bound Done generation receive a plain error; unbound preferences work', async () => {
            await preferenceTurn(1);
            await missing({ type: 'done', done: true }, tokens[0]);
            await preferenceTurn(2);
            const result = await currentClient().transport.mutation(legacyAction,
                { token: tokens[0], action: { type: 'done', done: true } });
            assert(result.ok);
            assert.equal((await getState()).managers[0].done, true);
        });
        await check('Old tabs missing either Force expectation receive a plain error without a sale', async () => {
            const state = await preferenceTurn(2);
            await act({ type: 'nominate', playerId: state.players[100].id, amount: 1,
                nominationGeneration: state.draft.nominationGeneration }, tokens[1]);
            const lot = (await getState()).lot!;
            await missing({ type: 'force', lotId: lot.id }, tokens[0]);
            await missing({ type: 'force', lotId: lot.id, expectedHighBid: lot.highBid }, tokens[0]);
            await missing({ type: 'force', lotId: lot.id, expectedHighBidderId: lot.highBidderId }, tokens[0]);
            await act({ type: 'force', lotId: lot.id, expectedHighBid: lot.highBid,
                expectedHighBidderId: lot.highBidderId }, tokens[0]);
            assert.equal((await getState()).lot, null);
        });
        await check('C19 restarting the draft value preserves the stored monotonic sequence', async () => {
            const before = await getState();
            await configure({ roster: [], draft: { status: 'setup', phase: 'nomination', order: [], nominatorId: null,
                lotId: null, nominationGeneration: '', deadline: null } });
            await act({ type: 'start' }, tokens[0]);
            const after = await getState(); later(before, after);
            await reject(before);
        });
    } finally {
        await dropIsolated(name);
        const directory = `${process.env.EVIDENCE_DIR}/turn-intent`;
        await mkdir(directory, { recursive: true });
        await writeFile(`${directory}/results.json`, JSON.stringify(results, null, 2));
    }
    assert(results.every(result => result.result === 'passed'), JSON.stringify(results));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
