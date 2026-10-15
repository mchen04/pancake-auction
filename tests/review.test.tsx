import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BlockPanel, PlayerDetails, PoolPanel, RosterPanel, turnsUntil } from '../app/components';
import { canNominate, rankedDynastyAdp } from '../lib/rules';
import { Strategy } from '../scripts/strategy';
import { roomFixture } from './room-fixture';

describe('review component regressions', () => {
    it.each([[0, null], [1.3, 1.3], [699, 699], [999, null], [null, null], [-1, null], [1000, null]])(
        'C7 ranked dynasty ADP %s becomes %s', (raw, expected) => {
            expect(rankedDynastyAdp(raw)).toBe(expected);
        }
    );
    it('B2/C2 missing roster data renders a safe player-id fallback', () => {
        const state = roomFixture();
        state.players = [];
        state.lot = null;
        state.roster = [{ playerId: 'review-new', managerId: 1, placement: 'active', price: 12, lotId: 1 }];
        const props = { state, me: state.managers[0], busy: false, connected: true, send: async () => {} };
        const html = renderToString(createElement(RosterPanel, props));
        expect(html).toContain('review-new');
        expect(html).toContain('$12');
    });
    it('Roster fallback keeps twenty active spots when player metadata is missing', () => {
        const state = roomFixture();
        state.players = [];
        state.lot = null;
        state.roster = [{ playerId: 'review-new', managerId: 1, placement: 'active', price: 12, lotId: 1 }];
        const props = { state, me: state.managers[0], busy: false, connected: true, send: async () => {} };
        const html = renderToString(createElement(RosterPanel, props));
        expect(html.match(/aria-label="Active spot \d+ of 20,/g)).toHaveLength(20);
        expect(html).toContain('Active spot 1 of 20, review-new');
        expect(html).toContain('Active spot 20 of 20, open');
    });
    it('B2/C2 a current lot retains controls when its pool entry is missing', () => {
        const state = roomFixture();
        state.players = [];
        const html = renderToString(createElement(BlockPanel, {
            state, me: state.managers[0], busy: false, connected: true, send: async () => {},
            offset: 0, opening: 1, setOpening: () => {}
        }));
        expect(html).toContain('bid-controls');
        expect(html).toContain('room-0');
    });
    it('B2/C2 known roster player negative control keeps the player name', () => {
        const state = roomFixture();
        state.roster = [{ playerId: state.players[0].id, managerId: 1, placement: 'active', price: 12, lotId: 1 }];
        const html = renderToString(createElement(RosterPanel, {
            state, me: state.managers[0], busy: false, connected: true, send: async () => {}
        }));
        expect(html).toContain(state.players[0].name);
    });
    it('S4/C8 full active and taxi without available Out has no nomination hint', () => {
        const state = roomFixture();
        state.lot = null;
        state.draft.phase = 'nomination';
        state.draft.nominatorId = 1;
        state.draft.turnIndex = 0;
        state.roster = state.players.slice(0, 23).map((player, index) => ({
            playerId: player.id, managerId: 2, placement: index < 20 ? 'active' : 'taxi', price: 1, lotId: index + 1
        }));
        expect(canNominate(state, state.managers[1])).toBe(false);
        expect(turnsUntil(state, state.managers[1])).toBeNull();
        expect(turnsUntil(state, state.managers[2])).toBe(1);
        state.players[23].injuryStatus = 'Out';
        expect(canNominate(state, state.managers[1])).toBe(true);
        expect(turnsUntil(state, state.managers[1])).toBe(1);
        state.managers[1].done = true;
        expect(turnsUntil(state, state.managers[1])).toBeNull();
    });
    it('C7 unranked 999 is hidden in the pool and ignored in valuations', () => {
        const state = roomFixture();
        const player = { ...state.players[0], adp: 999, projection: 60 };
        state.players = [player];
        const html = renderToString(createElement(PoolPanel, {
            state, me: state.managers[0], busy: false, connected: true, send: async () => {}, opening: 1
        }));
        expect(html).not.toContain('999.0');
        expect(html).toContain('Unranked by Sleeper');
        const details = renderToString(createElement(PlayerDetails, { player }));
        expect(details).not.toContain('999.0');
        expect(details).toContain('Unranked by Sleeper');
        const strategy = new Strategy(42, 3, state.players);
        expect(strategy.valuation(state, player)).toBe(strategy.valuation(state, { ...player, adp: null }));
    });
    it('S4/C8 available Out and explicit Done negative controls match the turn hint', () => {
        const state = roomFixture();
        state.lot = null;
        state.draft.phase = 'nomination';
        state.draft.nominatorId = 1;
        state.draft.turnIndex = 0;
        state.roster = state.players.slice(0, 23).map((player, index) => ({
            playerId: player.id, managerId: 2, placement: index < 20 ? 'active' : 'taxi', price: 1, lotId: index + 1
        }));
        state.players[23].injuryStatus = 'Out';
        expect(turnsUntil(state, state.managers[1])).toBe(1);
        state.managers[1].done = true;
        expect(turnsUntil(state, state.managers[1])).toBeNull();
    });
    it.each((['paused', 'running', 'setup', 'complete'] as const)
        .flatMap(status => [false, true].map(done => ({ status, done }))))(
        'C18 nomination preference is correct for $status with Done $done', ({ status, done }) => {
            const state = roomFixture();
            state.draft.status = status;
            state.managers[0].done = done;
            state.managers[0].budget = 980;
            state.roster = state.players.slice(0, 20).map((player, index) => ({
                playerId: player.id, managerId: 1, placement: 'active', price: 1, lotId: index + 1
            }));
            const html = renderToString(createElement(RosterPanel, {
                state, me: state.managers[0], busy: false, connected: true, send: async () => {}
            }));
            const button = html.match(/<button[^>]*>(?:Skip my nominations|Nominate again)<\/button>/)?.[0];
            if (status === 'setup' || status === 'complete') {
                expect(button).toBeUndefined();
                return;
            }
            expect(button).toContain(done ? 'Nominate again' : 'Skip my nominations');
            if (status === 'paused') {
                expect.soft(button).toContain('disabled=""');
                expect.soft(button).toContain('title="Available when the draft resumes"');
                const reasonId = button?.match(/aria-describedby="([^"]+)"/)?.[1];
                expect.soft(reasonId).toBeTruthy();
                expect(html.replace(/<!--.*?-->/g, ''))
                    .toContain(`id="${reasonId}"> Available when the draft resumes.</span>`);
            } else {
                expect(button).not.toContain('disabled');
                expect(button).not.toContain('aria-describedby');
            }
        }
    );

});
