import { describe, expect, it } from 'vitest';
import { canNominate, timeoutNominee } from '../lib/rules';
import type { Player } from '../lib/types';
import { roomFixture } from './room-fixture';
import recorded from './fixtures/sleeper-pool.json';

describe('C21 deterministic timeout nominee', () => {
    it('chooses the highest real projection from the unsorted import', () => {
        const state = roomFixture();
        state.players = recorded.players as Player[];
        expect(state.players[0].name).toBe('Jimmy Butler');
        expect(timeoutNominee(state, state.managers[0])?.name).toBe('Nikola Jokić');
    });
    it('breaks projection ties by player id without mutating stored order', () => {
        const state = roomFixture();
        const [a, b] = [...recorded.players as Player[]].slice(0, 2).sort((x, y) => x.id.localeCompare(y.id));
        state.players = [{ ...b, projection: 40 }, { ...a, projection: 40 }];
        expect(timeoutNominee(state, state.managers[0])?.id).toBe(a.id);
        expect(state.players[0].id).toBe(b.id);
    });
    it('sorts null projections last and breaks all-null ties by id', () => {
        const state = roomFixture();
        const [a, b] = state.players;
        state.players = [{ ...a, projection: null }, { ...b, projection: -1 }];
        expect(timeoutNominee(state, state.managers[0])?.id).toBe(b.id);
        state.players = [{ ...b, projection: null }, { ...a, projection: null }];
        expect(timeoutNominee(state, state.managers[0])?.id).toBe(a.id);
    });
    it('excludes sold players and bids that cannot cover the active reserve', () => {
        const state = roomFixture();
        state.roster = [{ playerId: state.players[0].id, managerId: 2, placement: 'active', price: 1, lotId: 1 }];
        expect(timeoutNominee(state, state.managers[0])?.id).toBe(state.players[1].id);
        state.managers[0].budget = 19;
        expect(timeoutNominee(state, state.managers[0])).toBeUndefined();
        state.managers[0].budget = 20;
        expect(timeoutNominee(state, state.managers[0])?.id).toBe(state.players[1].id);
    });
    it('excludes positional infeasibility even when the budget covers a high projection', () => {
        const state = roomFixture();
        const guards = state.players.filter(player => player.position === 'PG');
        state.roster = Array.from({ length: 15 }, (_, index) => ({ playerId: `guard-${index}`,
            managerId: 1, placement: 'active', price: 1, lotId: index + 1 }));
        state.players = [...state.roster.map((entry, index) => ({ ...guards[index % guards.length], id: entry.playerId })),
            { ...state.players[0], id: 'new-guard', projection: 999 },
            { ...state.players[1], id: 'new-wing', positions: ['SF'], projection: 1 }];
        expect(timeoutNominee(state, state.managers[0])?.id).toBe('new-wing');
    });
    it('passes reserve-only timeouts while legal optional nominations remain available', () => {
        const state = roomFixture();
        state.roster = state.players.slice(0, 20).map((player, index) => ({ playerId: player.id,
            managerId: 1, placement: 'active', price: 1, lotId: index + 1 }));
        expect(canNominate(state, state.managers[0])).toBe(true);
        expect(timeoutNominee(state, state.managers[0])).toBeUndefined();
        state.managers[0].done = true;
        expect(timeoutNominee(state, state.managers[0])).toBeUndefined();
    });
});
