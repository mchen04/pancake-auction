import { describe, expect, it } from 'vitest';
import { auditSealed } from '../scripts/sealed-audit';
import type { Lot } from '../lib/types';
import { roomFixture } from './room-fixture';

function completed() {
    const state = roomFixture();
    state.players = state.players.slice(0, 2);
    state.managers = state.managers.slice(0, 2).map(manager => ({ ...manager, budget: manager.id === 1 ? 998 : 999, done: false }));
    state.draft = { ...state.draft, status: 'complete', completionReason: 'no-eligible-managers', tiePriority: [1, 2], lotId: null };
    state.lot = null;
    state.roster = [
        { managerId: 2, playerId: state.players[0].id, placement: 'active', price: 1, lotId: 2 },
        { managerId: 1, playerId: state.players[1].id, placement: 'active', price: 2, lotId: 3 }
    ];
    const bids = [
        [{ managerId: 1, amount: 0, automatic: 'deadline' }, { managerId: 2, amount: 0, automatic: 'deadline' }],
        [{ managerId: 1, amount: 1 }, { managerId: 2, amount: 1 }],
        [{ managerId: 1, amount: 2 }, { managerId: 2, amount: 0 }]
    ];
    const lots: Lot[] = bids.map((responses, index) => ({ id: index + 1, playerId: state.players[index === 2 ? 1 : 0].id,
        nominatorId: 1, highBid: index, highBidderId: index === 0 ? 0 : index === 1 ? 2 : 1,
        status: index === 0 ? 'unsold' : 'sold', bids: responses, priorityBefore: index === 2 ? [1, 2] : [2, 1] }));
    const events: Parameters<typeof auditSealed>[1] = [{ id: 1, type: 'start', managerId: 1, lotId: null,
        data: { order: [1, 2], tiePriority: [2, 1] } }];
    for (const [index, lot] of lots.entries()) {
        events.push({ id: events.length + 1, type: 'nomination', managerId: 1, lotId: lot.id,
            data: { playerId: lot.playerId, source: index === 0 ? 'timeout' : index === 1 ? 'queue' : 'manual' } });
        events.push({ id: events.length + 1, type: 'resolution', managerId: lot.highBidderId || null, lotId: lot.id,
            data: { bids: lot.bids, price: lot.highBid, tied: index === 1, priority: index === 0 ? [2, 1] : [1, 2],
                reason: index === 0 ? 'deadline' : 'responses' } });
    }
    events.push({ id: events.length + 1, type: 'complete', managerId: null, lotId: null, data: { reason: 'no-eligible-managers' } });
    return { state, events, lots };
}

describe('Blind simulation replay', () => {
    it('audits ties, all-pass, timeout, queue and completion from independent roster arithmetic', () => {
        const { state, events, lots } = completed();
        expect(auditSealed(state, events, lots)).toMatchObject({ ties: 1, unsold: 1, nominationTimeouts: 1,
            bidTimeouts: 1, queues: 1, sales: 2, completionReason: 'no-eligible-managers', finalRosterSize: 2 });
    });
    it.each(['winner', 'price', 'priority', 'budget', 'reserve', 'duplicate', 'completion', 'coverage'])(
        'rejects corrupt %s evidence', defect => {
            const { state, events, lots } = completed();
            if (defect === 'winner') events[4].managerId = 1;
            if (defect === 'price') events[4].data.price = 2;
            if (defect === 'priority') events[4].data.priority = [2, 1];
            if (defect === 'budget') state.managers[0].budget++;
            if (defect === 'reserve') lots[1].bids![0].amount = 982;
            if (defect === 'duplicate') events.splice(5, 0, { ...events[3] }, { ...events[4] });
            if (defect === 'completion') state.players.push({ ...state.players[0], id: 'still-available' });
            if (defect === 'coverage') events[3].data.source = 'manual';
            expect(() => auditSealed(state, events, lots)).toThrow();
        });
});
