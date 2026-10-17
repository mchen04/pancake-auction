import { describe, expect, it } from 'vitest';
import { amountError, automaticResponses, DAY, legalMaximum, reorderQueue, resolveSealed, selectQueue } from '../lib/sealed';
import { canNominate, timeoutNominee } from '../lib/rules';
import { initialDraft } from '../convex/engine';
import { roomFixture } from './room-fixture';
import type { QueueEntry } from '../lib/types';

const bid = (managerId: number, amount: number) => ({ managerId, amount });
describe('sealed engine', () => {
    it('charges the highest bidder their own price and leaves priority alone for a single winner', () => {
        expect(resolveSealed([3, 2, 1], [bid(1, 97), bid(2, 40), bid(3, 0)]))
            .toEqual({ winnerId: 1, price: 97, tied: false, priority: [3, 2, 1] });
    });
    it('rotates only the winner of successive positive ties', () => {
        const first = resolveSealed([3, 2, 1], [bid(1, 30), bid(2, 30), bid(3, 0)]);
        expect(first).toEqual({ winnerId: 2, price: 30, tied: true, priority: [3, 1, 2] });
        const second = resolveSealed(first.priority, [bid(1, 30), bid(2, 30), bid(3, 0)]);
        expect(second.winnerId).toBe(1);
        expect(second.priority).toEqual([3, 2, 1]);
        expect(resolveSealed(second.priority, [bid(1, 0), bid(2, 30), bid(3, 30)]).winnerId).toBe(3);
    });
    it('leaves all-pass players unsold without rotating zero-dollar ties', () => {
        expect(resolveSealed([2, 1], [bid(1, 0), bid(2, 0)]))
            .toEqual({ winnerId: null, price: 0, tied: false, priority: [2, 1] });
    });
    it('keeps a legal nominator waiting despite legacy passed turns and automatic passes', () => {
        const state = roomFixture();
        state.lot = null;
        state.draft.passedTurns = state.managers.map(manager => manager.id);
        for (const manager of state.managers.slice(1)) manager.budget = 19;
        const nominator = state.managers[0];
        expect(canNominate(state, nominator)).toBe(true);
        const player = timeoutNominee(state, nominator)!;
        const queue = selectQueue(state, nominator, [{ id: 'blank', playerId: player.id }]);
        expect(queue.chosen).toEqual({ id: 'blank', playerId: player.id });
        const responses = automaticResponses(state, player);
        expect(responses).toHaveLength(9);
        expect(responses.some(response => response.managerId === nominator.id)).toBe(false);
    });
    it('automatically passes managers with no legal dollar while Done still permits bids', () => {
        const state = roomFixture();
        state.managers[0].budget = 19;
        state.managers[1].done = true;
        expect(automaticResponses(state, state.players[0])).toEqual([{ managerId: 1, amount: 0, automatic: 'ineligible' }]);
        state.roster = state.players.slice(0, 20).map((p, index) => ({ playerId: p.id, managerId: 3,
            lotId: index, placement: 'active', price: 1 }));
        expect(automaticResponses(state, state.players[0]).map(b => b.managerId)).toContain(3);
    });
    it('rejects zero, fractional, unsafe and over-reserve amounts; permits omission and exact maximum', () => {
        const state = roomFixture();
        const maximum = legalMaximum(state, state.managers[0], state.players[0]);
        expect(maximum).toBe(981);
        for (const amount of [0, -1, 1.5, NaN, Infinity, 982, Number.MAX_SAFE_INTEGER + 1]) expect(amountError(amount, maximum)).toBeTruthy();
        expect(amountError(undefined, maximum)).toBeUndefined();
        expect(amountError(981, maximum)).toBeUndefined();
        expect(amountError(undefined, 0)).toBeTruthy();
    });
    it('consumes the first legal queue entry with its exact amount; keeps skip reasons', () => {
        const state = roomFixture();
        state.lot = null;
        state.roster = [{ playerId: state.players[0].id, managerId: 2, lotId: 1, placement: 'active', price: 1 }];
        const entries: QueueEntry[] = [
            { id: 'sold', playerId: state.players[0].id },
            { id: 'gone', playerId: 'missing' },
            { id: 'high', playerId: state.players[1].id, amount: 982 },
            { id: 'valid', playerId: state.players[2].id, amount: 37 },
            { id: 'blank', playerId: state.players[3].id }
        ];
        const result = selectQueue(state, state.managers[0], entries);
        expect(result.chosen).toEqual(entries[3]);
        expect(result.remaining.map(e => e.id)).toEqual(['sold', 'gone', 'high', 'blank']);
        expect(result.remaining.slice(0, 3).every(e => e.reason)).toBe(true);
        expect(result.remaining[2].amount).toBe(982);
        expect(entries[0].reason).toBeUndefined();
        const reordered = reorderQueue(entries, ['blank', 'valid', 'high', 'gone', 'sold']);
        expect(selectQueue(state, state.managers[0], reordered).chosen).toEqual(entries[4]);
        expect(() => reorderQueue(entries, ['blank', 'blank'])).toThrow();
        expect(() => reorderQueue(entries, ['blank', 'valid', 'high', 'gone', 'missing'])).toThrow();
    });
    it('skips queues with no roster placement and nominates the highest legal projection without a bid', () => {
        const state = roomFixture();
        state.lot = null;
        state.roster = state.players.slice(0, 20).map((p, index) => ({ playerId: p.id, managerId: 1,
            lotId: index, placement: 'active', price: 1 }));
        state.players.push({ ...state.players[0], id: 'veteran', projection: 999 });
        const result = selectQueue(state, state.managers[0], [{ id: 'bad', playerId: 'veteran' }]);
        expect(result.chosen).toBeUndefined();
        expect(result.remaining[0].reason).toContain('placement');
        expect(timeoutNominee(state, state.managers[0])?.id).toBe(state.players[20].id);
        const draft = initialDraft();
        expect(draft.nominationMs).toBe(DAY);
        expect(draft.biddingMs).toBe(DAY);
    });
});
