import { isAuctionMode } from '../lib/modes';
import { v } from 'convex/values';
import { internalMutation, mutation, query } from './_generated/server';
import { act, advance, claim, draftRecord, load, restore, Store, privateState, changeQueue, cleanLot } from './engine';
import type { MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { action, queueAction } from './validators';

export const syncTime = mutation({ args: {}, handler: () => ({ serverNow: Date.now() }) });
export const privateSeat = query({ args: { token: v.string() }, handler: (ctx, args) => privateState(ctx, args.token) });
export const editQueue = mutation({ args: { token: v.string(), action: queueAction },
    handler: (ctx, args) => changeQueue(ctx, args.token, args.action) });
export const state = query({ args: { token: v.optional(v.string()) },
    handler: (ctx, args) => load(ctx, args.token, false) });
export const pool = query({ args: { revision: v.string() }, handler: async ctx => {
    const current = await ctx.db.query('pools').unique();
    return { revision: current?.revision ?? '0', players: current?.players ?? [] };
} });
export const result = query({ args: { lotId: v.number() }, handler: async (ctx, args) => {
    const lot = await ctx.db.query('lots').withIndex('id', q => q.eq('id', args.lotId)).unique();
    return lot && ['sold', 'unsold', 'undone'].includes(lot.status) ? cleanLot(lot) : null;
} });
export const claimSeat = mutation({ args: { managerId: v.number() },
    handler: (ctx, args) => claim(ctx, args.managerId) });
export const restoreSeat = mutation({ args: { token: v.string() },
    handler: (ctx, args) => restore(ctx, args.token) });
export const actOnDraft = mutation({ args: { token: v.string(), action },
    handler: (ctx, args) => act(ctx, args.action, args.token) });
export async function expireDraft(ctx: MutationCtx, args: {
    draftId: Id<'drafts'>; lotId: number | null; version: number; deadline: number
}, now: number) {
    const record = await draftRecord(ctx);
    if (!record || record._id !== args.draftId || record.version !== args.version
        || !isAuctionMode(record.value.mode) || record.value.status !== 'running' || record.value.lotId !== args.lotId
        || record.value.deadline !== args.deadline || now < args.deadline) return;
    const store = new Store(ctx, record);
    const state = await load(ctx, undefined, true, false);
    await advance(store, state, now);
    await store.save(state);
}
export const expire = internalMutation({ args: { draftId: v.id('drafts'), lotId: v.union(v.number(), v.null()),
    version: v.number(), deadline: v.number() }, handler: async (ctx, args): Promise<void> => {
    await expireDraft(ctx, args, Date.now());
} });
