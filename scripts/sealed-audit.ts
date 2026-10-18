import assert from 'node:assert/strict';
import { Replay } from './audit';
import type { AuctionState, Lot, SealedResponse } from '../lib/types';

type Event = { id: number; type: string; managerId: number | null; lotId: number | null; data: Record<string, unknown> };
export function auditSealed(state: AuctionState, events: Event[], lots: Lot[]) {
    const replay = new Replay(state.players, state.managers.map(manager => manager.id));
    let priority: number[] = [];
    let pending: { id: number; playerId: string } | null = null;
    const resolved = new Set<number>();
    const coverage = { ties: 0, unsold: 0, nominationTimeouts: 0, bidTimeouts: 0, queues: 0, sales: 0 };
    for (const event of events) {
        if (event.type === 'start') {
            priority = [...event.data.tiePriority as number[]];
            assert.deepEqual(priority, [...event.data.order as number[]].reverse());
        }
        if (event.type === 'nomination') {
            assert.equal(pending, null);
            const playerId = String(event.data.playerId);
            assert(replay.available().some(player => player.id === playerId));
            assert(replay.maximum(event.managerId!, replay.player(playerId)) >= 1);
            pending = { id: event.lotId!, playerId };
            if (event.data.source === 'timeout') coverage.nominationTimeouts++;
            if (event.data.source === 'queue') coverage.queues++;
        }
        if (event.type === 'resolution') {
            assert(pending && pending.id === event.lotId);
            assert(!resolved.has(pending.id));
            resolved.add(pending.id);
            const lot = lots.find(lot => lot.id === pending!.id)!;
            assert(lot);
            assert.deepEqual(lot.priorityBefore, priority);
            const bids = event.data.bids as SealedResponse[];
            assert.equal(bids.length, state.managers.length);
            assert.deepEqual(bids.map(bid => bid.managerId).sort((a, b) => a - b), replay.managerIds);
            assert.deepEqual(lot.bids, bids);
            const player = replay.player(pending.playerId);
            for (const bid of bids) {
                assert(Number.isSafeInteger(bid.amount) && bid.amount >= 0);
                assert(bid.amount <= replay.maximum(bid.managerId, player));
                if (bid.automatic) assert.equal(bid.amount, 0);
                if (bid.automatic === 'ineligible') assert.equal(replay.maximum(bid.managerId, player), 0);
            }
            const price = Math.max(...bids.map(bid => bid.amount));
            const tied = bids.filter(bid => bid.amount === price && price > 0).map(bid => bid.managerId);
            const winner = priority.find(id => tied.includes(id)) ?? null;
            assert.equal(event.managerId, winner);
            assert.equal(event.data.price, price);
            assert.equal(event.data.tied, tied.length > 1);
            assert.equal(lot.highBid, price);
            assert.equal(lot.highBidderId, winner ?? 0);
            assert.equal(lot.status, winner === null ? 'unsold' : 'sold');
            if (event.data.reason === 'deadline') coverage.bidTimeouts++;
            if (winner !== null) {
                const placement = replay.placements(winner, player)
                    .find(place => replay.placementMax(winner, replay.team(winner), place) >= price);
                assert(placement);
                replay.roster.push({ playerId: player.id, managerId: winner, lotId: lot.id, price, placement });
                replay.budgets.set(winner, replay.budgets.get(winner)! - price);
                coverage.sales++;
            } else coverage.unsold++;
            if (tied.length > 1) {
                priority = [...priority.filter(id => id !== winner), winner!];
                coverage.ties++;
            }
            assert.deepEqual(event.data.priority, priority);
            pending = null;
        }
        if (event.type === 'complete') {
            assert.equal(event.data.reason, 'no-eligible-managers');
            assert(replay.managerIds.every(id => !replay.canNominate(id)));
        }
        for (const id of replay.managerIds) {
            const team = replay.team(id);
            assert(replay.count(team, 'active') <= 20 && replay.count(team, 'taxi') <= 3 && replay.count(team, 'ir') <= 2);
            assert(replay.feasible(team));
            assert(replay.budgets.get(id)! >= 20 - replay.count(team, 'active'));
        }
        assert.equal(new Set(replay.roster.map(entry => entry.playerId)).size, replay.roster.length);
    }
    assert.equal(state.draft.status, 'complete');
    assert.equal(state.draft.completionReason, 'no-eligible-managers');
    assert.equal(pending, null);
    assert(events.some(event => event.type === 'complete'));
    assert.deepEqual(state.draft.tiePriority, priority);
    assert.deepEqual([...state.roster].sort((a, b) => a.lotId - b.lotId), replay.roster);
    for (const manager of state.managers) assert.equal(manager.budget, replay.budgets.get(manager.id));
    assert(Object.values(coverage).every(count => count > 0), 'Every Blind scenario must execute');
    return { ...coverage, completionReason: state.draft.completionReason, finalRosterSize: state.roster.length,
        teams: state.managers.map(manager => ({ id: manager.id, budget: manager.budget, roster: replay.team(manager.id).length })) };
}
