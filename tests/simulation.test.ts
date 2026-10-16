import { describe, expect, it, vi } from 'vitest';
import { ConvexHttpClient } from 'convex/browser';
import { Bot } from '../scripts/bot';
import { Replay } from '../scripts/audit';
import { assertFloors, assertSeedVariation, draftFingerprint } from '../scripts/simulation-results';
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
            status: 'running', nominationGeneration: 'fixture:1', phase: 'nomination', order: [], turnIndex: 0, nominatorId: 1, lotId: null,
            deadline: 11000, remainingMs: null, nominationMs: 10000, biddingMs: 10000, extensionMs: 5000,
            capMs: 15000, passedTurns: [], completionReason: null
        }
    };
}

describe('competitive simulation', () => {
    const sales = [
        { type: 'sale', data: { playerId: 'test-0', managerId: 1, price: 10 } },
        { type: 'sale', data: { playerId: 'test-1', managerId: 2, price: 20 } }
    ];
    it('accepts equal expiry counts with distinct sales and varied bid counts', () => {
        const values = [
            { seed: 1042, bids: 900, expirySales: 57, draftFingerprint: draftFingerprint(sales) },
            { seed: 1043, bids: 910, expirySales: 57, draftFingerprint: draftFingerprint([...sales].reverse()) },
            { seed: 1044, bids: 920, expirySales: 57, draftFingerprint: draftFingerprint([
                sales[0], { ...sales[1], data: { ...sales[1].data, price: 21 } }
            ]) }
        ];
        expect(() => assertSeedVariation(values)).not.toThrow();
    });
    it('rejects identical sale fingerprints despite varied bid counts', () => {
        const fingerprint = draftFingerprint(sales);
        expect(() => assertSeedVariation([
            { seed: 1042, bids: 900, draftFingerprint: fingerprint },
            { seed: 1043, bids: 910, draftFingerprint: fingerprint }
        ])).toThrow('Different seeds must produce distinct sale sequences');
    });
    it('retains distinct-seed and accepted-bid variance controls', () => {
        const values = [
            { seed: 1042, bids: 900, draftFingerprint: draftFingerprint(sales) },
            { seed: 1043, bids: 910, draftFingerprint: draftFingerprint([...sales].reverse()) }
        ];
        expect(() => assertSeedVariation(values.map(value => ({ ...value, seed: 1042 }))))
            .toThrow('Spread requires distinct seeds');
        expect(() => assertSeedVariation(values.map(value => ({ ...value, bids: 900 }))))
            .toThrow('Accepted bid counts must vary across seeds');
    });
    it('fingerprints sales without timestamps, lot ids or unrelated events', () => {
        const logged = sales.map((sale, index) => ({ ...sale, lot_id: index + 1,
            data: { ...sale.data, now: index + 1000, deadline: index + 2000 } }));
        expect(draftFingerprint([...logged, { type: 'pass', data: { managerId: 3 } }]))
            .toBe(draftFingerprint(sales));
    });
    it.each([
        ['player', [{ ...sales[0], data: { ...sales[0].data, playerId: 'test-2' } }, sales[1]]],
        ['winner', [{ ...sales[0], data: { ...sales[0].data, managerId: 3 } }, sales[1]]],
        ['price', [{ ...sales[0], data: { ...sales[0].data, price: 11 } }, sales[1]]],
        ['order', [...sales].reverse()]
    ])('changes the fingerprint when the sale %s changes', (_name, changed) => {
        expect(draftFingerprint(changed)).not.toBe(draftFingerprint(sales));
    });
    it('rejects absent or malformed sales rather than hashing an empty draft', () => {
        expect(() => draftFingerprint([{ type: 'bid', data: { amount: 10 } }]))
            .toThrow('Draft fingerprint requires sales');
        expect(() => draftFingerprint([{ type: 'sale', data: { playerId: 'test-0', price: 10 } }]))
            .toThrow('Draft fingerprint requires a player, winner and price for every sale');
    });
    it('counts stale control races as rejections and keeps missing bindings fatal', async () => {
        const bot = new Bot(1, 'http://127.0.0.1:9999');
        const mutation = vi.spyOn(ConvexHttpClient.prototype, 'mutation');
        const snapshot = vi.spyOn(bot, 'state').mockResolvedValue(state());
        const action = { type: 'pause', expectedRunning: 'observed:1' } as const;
        try {
            for (const error of [
                'Draft is not running', 'Draft is not paused',
                'The draft has resumed again. Check before pausing.',
                'The draft was paused again. Check before resuming.'
            ]) {
                mutation.mockResolvedValueOnce({ ok: false, error, status: 409 });
                expect(await bot.action(action, true)).toBe(false);
                expect(bot.rejected[`409: ${error}`]).toBe(1);
            }
            mutation.mockResolvedValueOnce({ ok: false, error: 'Refresh the page to continue', status: 409 });
            await expect(bot.action(action, true)).rejects.toThrow('Refresh the page to continue');
        } finally {
            mutation.mockRestore();
            snapshot.mockRestore();
        }
    });
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
