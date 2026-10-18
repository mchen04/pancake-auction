import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BlockPanel, CommissionerBar, PoolPanel, TeamsPanel } from '../app/components';
import { cleanLot, initialDraft } from '../convex/core';
import type { Doc } from '../convex/_generated/dataModel';
import { draftDefaults, eventMarker, hasDefaultTiming, isAuctionMode } from '../lib/modes';
import { nextDeadline, timeoutNominee } from '../lib/rules';
import { DAY } from '../lib/sealed';
import { roomFixture } from './room-fixture';

describe('auction modes', () => {
    it('preserves Blind defaults and defines the historical Normal timing', () => {
        expect(initialDraft()).toEqual(draftDefaults('sealed-v1'));
        expect(initialDraft()).toMatchObject({ nominationMs: DAY, biddingMs: DAY, extensionMs: 0, capMs: DAY, tiePriority: [] });
        expect(draftDefaults('live-v1')).toMatchObject({ nominationMs: 10000, biddingMs: 10000, extensionMs: 5000, capMs: 15000 });
        expect(draftDefaults('live-v1')).not.toHaveProperty('tiePriority');
        for (const mode of ['live-v1', 'sealed-v1'] as const) {
            const draft = draftDefaults(mode);
            expect(isAuctionMode(mode)).toBe(true);
            expect(hasDefaultTiming(draft)).toBe(true);
            for (const field of ['nominationMs', 'biddingMs', 'extensionMs', 'capMs'] as const)
                expect(hasDefaultTiming({ ...draft, [field]: draft[field] + 1 })).toBe(false);
        }
        expect(isAuctionMode(undefined)).toBe(false);
        expect(hasDefaultTiming({ ...initialDraft(), mode: undefined })).toBe(false);
        expect(eventMarker(undefined)).toEqual({});
        expect(eventMarker('live-v1')).toEqual({ live: true });
        expect(eventMarker('sealed-v1')).toEqual({ sealed: true });
    });
    it('extends the old deadline by five seconds and caps at fifteen from now', () => {
        expect(nextDeadline(10000, 9000, 5000, 15000)).toBe(15000);
        expect(nextDeadline(24000, 10000, 5000, 15000)).toBe(25000);
        expect(nextDeadline(10000, 0, 5000, 15000)).toBe(15000);
    });
    it('reveals an open live bid only under Normal rules', () => {
        const row = { ...roomFixture().lot!, highBid: 73, highBidderId: 2, status: 'open',
            bids: [{ managerId: 2, amount: 73 }] } as Doc<'lots'>;
        for (const mode of [undefined, 'sealed-v1'] as const) {
            expect(cleanLot(row, mode)).toMatchObject({ highBid: 0, highBidderId: 0 });
            expect(cleanLot(row, mode)).not.toHaveProperty('bids');
        }
        expect(cleanLot(row, 'live-v1')).toMatchObject({ highBid: 73, highBidderId: 2 });
        expect(cleanLot({ ...row, status: 'sold' }, 'sealed-v1')).toMatchObject({ highBid: 73, bids: row.bids });
    });
    it.each(['live-v1', 'sealed-v1'] as const)('renders the chosen %s controls and hides the other mode', mode => {
        const state = roomFixture();
        state.draft.mode = mode;
        state.lot!.highBid = 27;
        state.lot!.highBidderId = 2;
        const props = { state, me: state.managers[0], busy: false, connected: true, send: async () => {},
            opening: mode === 'live-v1' ? 1 : undefined, setOpening: () => {} };
        const block = renderToString(createElement(BlockPanel, props));
        const teams = renderToString(createElement(TeamsPanel, props));
        const pool = renderToString(createElement(PoolPanel, props));
        const bar = renderToString(createElement(CommissionerBar, props));
        if (mode === 'live-v1') {
            expect(block).toContain('Give up');
            expect(block).toContain('shot-clock');
            expect(block).toContain('$27');
            expect(block).not.toContain('Sealed bid amount');
            expect(teams).toContain('Leads $27');
            expect(teams).not.toContain('Tie priority');
            expect(pool).not.toContain('Queue');
            expect(bar).toContain('Force end');
        } else {
            expect(block).toContain('Sealed bid amount');
            expect(block).not.toContain('shot-clock');
            expect(block).not.toContain('Give up');
            expect(teams).toContain('Tie priority');
            expect(pool).toContain('Queue');
            expect(bar).not.toContain('Force end');
        }
        state.lot = null;
        state.draft.phase = 'nomination';
        state.draft.nominatorId = 1;
        const nomination = renderToString(createElement(BlockPanel, props));
        expect(nomination).toContain(mode === 'live-v1' ? 'Opening bid' : 'Optional nomination bid');
        expect(nomination).not.toContain('Auction mode');
        state.draft.status = 'setup';
        const setup = renderToString(createElement(BlockPanel, props));
        expect(setup).toContain('Auction mode');
        expect(setup).toContain('Normal');
        expect(setup).toContain('Blind');
        expect(setup.indexOf('Auction mode')).toBeLessThan(setup.indexOf('Start draft'));
        expect(renderToString(createElement(BlockPanel, { ...props, me: state.managers[1] }))).not.toContain('aria-pressed');
    });
    it('Normal reserve-only timeout passes; Blind still nominates a legal reserve player', () => {
        const state = roomFixture();
        state.roster = state.players.slice(0, 20).map((player, index) => ({
            playerId: player.id, managerId: 1, placement: 'active', lotId: index + 1, price: 1
        }));
        state.players[20].yearsExp = 0;
        state.draft.mode = 'live-v1';
        expect(timeoutNominee(state, state.managers[0])).toBeUndefined();
        state.draft.mode = 'sealed-v1';
        expect(timeoutNominee(state, state.managers[0])).toBeDefined();
    });
});
