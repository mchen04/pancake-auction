import { describe, expect, it } from 'vitest';
import { Replay } from '../scripts/audit';
import { assertFloors } from '../scripts/simulation-results';
import { Strategy } from '../scripts/strategy';
import { syntheticPool } from './support';
import type { AuctionState } from '../lib/types';
import managers from '../league/managers.json';

function state(): AuctionState {
    return {
        poolRevision: "fixture",
        players: syntheticPool(), roster: [], passes: [], sales: [], recentEvents: [], serverNow: 1000, me: 1,
        managers: managers.map((manager, index) => ({
            id: index + 1, ...manager,
            budget: 1000, claimed: true, done: false
        })),
        lot: null,
        draft: {
            status: 'running', phase: 'nomination', order: [], turnIndex: 0, nominatorId: 1, lotId: null,
            deadline: 11000, remainingMs: null, nominationMs: 10000, biddingMs: 10000, extensionMs: 5000,
            capMs: 15000, passedTurns: [], completionReason: null
        }
    };
}

describe('competitive simulation', () => {
    it('draws stable valuations that change across managers and seeds', () => {
        const room = state();
        const player = { ...room.players[0], projection: 30, adp: 80 };
        const strategy = new Strategy(42, 3, room.players);
        const value = strategy.valuation(room, player);
        expect(strategy.valuation(room, player)).toBe(value);
        expect(new Strategy(43, 3, room.players).valuation(room, player)).not.toBe(value);
        expect(new Strategy(42, 4, room.players).valuation(room, player)).not.toBe(value);
        expect(strategy.valuation(room, { ...player, projection: 60 })).toBeGreaterThan(value);
        expect(strategy.valuation(room, { ...player, adp: 1 })).toBeGreaterThan(value);
    });
    it('values vacant starter positions and refuses an impossible active placement', () => {
        const room = state();
        room.roster = room.players.filter(player => player.positions.includes('PG')).slice(0, 15)
            .map((player, index) => ({
                playerId: player.id, managerId: 3, placement: 'active', price: 1, lotId: index + 1
            }));
        const strategy = new Strategy(42, 3, room.players);
        const guard = room.players[100];
        const center = room.players[104];
        expect(strategy.need(center, room.roster)).toBeGreaterThan(strategy.need(guard, room.roster));
        expect(strategy.valuation(room, guard)).toBe(0);
        expect(strategy.valuation(room, center)).toBeGreaterThan(0);
    });
    it('fails each required floor instead of accepting a thin full draft', () => {
        const valid = {
            acceptedBids: 450, maxBidHits: 6, averageUnspentBudget: 60, activeSize: 200,
            timers: { expirySales: 30, nominationTimeouts: 3 }
        };
        expect(() => assertFloors(valid)).not.toThrow();
        for (const changed of [
            { acceptedBids: 399 }, { maxBidHits: 4 }, { averageUnspentBudget: 150 }, { activeSize: 199 },
            { timers: { expirySales: 24, nominationTimeouts: 3 } },
            { timers: { expirySales: 30, nominationTimeouts: 2 } }
        ]) expect(() => assertFloors({ ...valid, ...changed })).toThrow();
    });
    it('independently rejects a bid one dollar above the legal maximum', () => {
        const room = state();
        const replay = new Replay(room.players, room.managers.map(manager => manager.id));
        replay.deadline = 11000;
        replay.lot = {
            id: 1, playerId: room.players[0].id, high: 1, bidder: 1, nominator: 1, passes: new Set()
        };
        const event = {
            id: '1', type: 'bid', manager_id: 3, lot_id: 1, created_at: new Date(1000),
            data: { now: 1000, amount: 982, beforeDeadline: 11000, deadline: 16000 }
        };
        expect(() => replay.apply(event)).toThrow(/independently recomputed maximum 981/);
        replay.apply({ ...event, data: { ...event.data, amount: 981 } });
        expect(replay.acceptedBids).toBe(1);
        expect(replay.maxBidHits).toBe(1);
    });
    it('C12/C15 replay rejects Done with an open active spot after every event', () => {
        const room = state();
        const replay = new Replay(room.players, [1]);
        replay.roster = room.players.slice(0, 20).map((player, index) => ({
            playerId: player.id, managerId: 1, placement: 'active', price: 1, lotId: index + 1
        }));
        replay.done.add(1);
        expect(() => replay.apply({
            id: '1', type: 'placement', manager_id: 1, lot_id: 1, created_at: new Date(1000),
            data: { now: 1000, playerId: room.players[0].id, from: 'active', to: 'taxi' }
        })).toThrow(/Done manager 1 has an open active spot/);
    });
    it('C12/C15 replay rejects completion with a legal required nomination', () => {
        const room = state();
        const replay = new Replay(room.players, [1]);
        replay.roster = room.players.slice(0, 19).map((player, index) => ({
            playerId: player.id, managerId: 1, placement: 'active', price: 1, lotId: index + 1
        }));
        replay.passedTurns.add(1);
        expect(() => replay.apply({
            id: '1', type: 'complete', manager_id: null, lot_id: null, created_at: new Date(1000),
            data: { now: 1000, reason: 'full-cycle-passed', passedTurns: [1] }
        })).toThrow(/Draft completes with a legal required nomination/);
    });

});
