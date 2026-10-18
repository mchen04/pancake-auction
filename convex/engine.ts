import type { AuctionState, QueueAction } from '../lib/types';
import { draftDefaults, eventMarker, isAuctionMode } from '../lib/modes';
import type { MutationCtx } from './_generated/server';
import type { WireAction } from './validators';
import { draftRecord, identity, load, RuleError, seatReference, Store } from './core';
import * as live from './liveEngine';
import * as sealed from './sealedEngine';
export { cleanLot, draftRecord, initialDraft, load, privateState, RuleError, seatReference, Store, tokenHash } from './core';

export async function advance(store: Store, s: AuctionState, now: number) {
    if (s.draft.mode === 'live-v1') await live.advance(store, s, now);
    if (s.draft.mode === 'sealed-v1') await sealed.advance(store, s, now);
}
export async function transaction<T>(ctx: MutationCtx, token: string | undefined,
    run: (store: Store, state: AuctionState, now: number) => Promise<T>, validate?: (state: AuctionState) => void) {
    const record = await draftRecord(ctx);
    if (!record) return { ok: false as const, error: 'League managers are not configured', status: 409, serverNow: Date.now() };
    const store = new Store(ctx, record);
    const state = await load(ctx, token, true, false);
    const now = Date.now();
    let validated = false;
    try {
        validate?.(state);
        validated = true;
        await advance(store, state, now);
        const value = await run(store, state, now);
        await store.save(state);
        return { ok: true as const, value: value ?? null, serverNow: now };
    } catch (error) {
        if (!(error instanceof RuleError)) throw error;
        if (validated && isAuctionMode(state.draft.mode)) await store.save(state);
        return { ok: false as const, error: error.message, status: error.status, serverNow: now };
    }
}
function requireManager(s: AuctionState) {
    const manager = s.managers.find(m => m.id === s.me);
    if (!manager) throw new RuleError('Choose your seat first', 401);
    return manager;
}
function requireMode(s: AuctionState) {
    if (!isAuctionMode(s.draft.mode)) throw new RuleError('Legacy draft is read-only. Commissioner must arrange migration.', 409);
}
export async function changeQueue(ctx: MutationCtx, token: string, action: QueueAction) {
    return transaction(ctx, token, (store, s, now) => sealed.changeQueue(store, s, now, action), s => {
        requireManager(s);
        requireMode(s);
        if (s.draft.mode !== 'sealed-v1') throw new RuleError('Queues are only available in Blind mode', 409);
    });
}
export async function act(ctx: MutationCtx, action: WireAction, token: string) {
    return transaction(ctx, token, async (store, s, now) => {
        if (action.type === 'mode' || action.type === 'start') {
            if (s.draft.status !== 'setup') throw new RuleError('Draft has already started', 409);
            if (s.roster.length || await ctx.db.query('lots').first())
                throw new RuleError('Existing lots require commissioner migration', 409);
            if (action.type === 'mode') {
                if (s.draft.mode === action.mode) return;
                s.draft = draftDefaults(action.mode);
                store.renewControl(s);
                await ctx.db.insert('events', { ...eventMarker(action.mode), id: store.nextEvent++, type: 'mode',
                    managerId: s.me, lotId: null, data: { mode: action.mode, now }, at: now });
                return;
            }
        }
        if (s.draft.mode === 'live-v1') return live.act(store, s, now, action);
        if (action.type === 'force') throw new RuleError('Force end is only available in Normal mode', 409);
        return sealed.act(store, s, now, action);
    }, s => {
        const manager = requireManager(s);
        if ((action.type === 'bid' || action.type === 'pass' || action.type === 'nominate')
            && action.mode !== undefined && action.mode !== s.draft.mode)
            throw new RuleError('Auction mode changed. Refresh the page.', 409);
        if (['mode', 'start', 'pause', 'resume', 'undo', 'force', 'release'].includes(action.type) && !manager.commissioner)
            throw new RuleError('Commissioner only', 403);
        if (action.type !== 'release' && !(['start', 'mode'].includes(action.type) && s.draft.status === 'setup')) requireMode(s);
        if (['start', 'mode'].includes(action.type) && !isAuctionMode(s.draft.mode) && (s.roster.length || s.lot))
            throw new RuleError('Legacy draft contains auction data. Commissioner must arrange migration.', 409);
        if (s.draft.mode === 'live-v1') live.requireCurrentPage(action, s);
        if (s.draft.mode === 'sealed-v1' && action.type === 'force')
            throw new RuleError('Force end is only available in Normal mode', 409);
    });
}
export async function claim(ctx: MutationCtx, managerId: number) {
    return transaction(ctx, undefined, async (store, s, now) => {
        const manager = s.managers.find(m => m.id === managerId);
        if (!manager) throw new RuleError('Choose a configured manager');
        // Selecting is never exclusive. The first selection only marks the manager as joined.
        if (!manager.claimed) {
            const row = await ctx.db.query('managers').withIndex('id', q => q.eq('id', managerId)).unique();
            await ctx.db.patch(row!._id, { joinedAt: now });
            await ctx.db.insert('events', { ...eventMarker(s.draft.mode), id: store.nextEvent++, type: 'claim',
                managerId, lotId: null, data: { now }, at: now });
        }
        return seatReference(managerId);
    });
}
export async function restore(ctx: MutationCtx, token: string) {
    const manager = await identity(ctx, token);
    return manager ? { ok: true as const, value: manager.id, serverNow: Date.now() }
        : { ok: false as const, error: 'Seat token is no longer valid', status: 401, serverNow: Date.now() };
}
