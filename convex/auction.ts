import { v } from 'convex/values';
import { internalMutation, mutation, query } from './_generated/server';
import { act, advance, claim, draftRecord, load, restore, Store } from './engine';
import { action } from './validators';

export const syncTime = mutation({ args: {}, handler: () => ({ serverNow: Date.now() }) });
export const state = query({ args: { token: v.optional(v.string()) },
    handler: (ctx, args) => load(ctx, args.token, false) });
export const pool = query({ args: { revision: v.string() }, handler: async ctx => {
    const current = await ctx.db.query('pools').unique();
    return { revision: current?.revision ?? '0', players: current?.players ?? [] };
} });
export const claimSeat = mutation({ args: { managerId: v.number() },
    handler: (ctx, args) => claim(ctx, args.managerId) });
export const restoreSeat = mutation({ args: { token: v.string() },
    handler: (ctx, args) => restore(ctx, args.token) });
export const actOnDraft = mutation({ args: { token: v.string(), action },
    handler: (ctx, args) => act(ctx, args.action, args.token) });
export const expire = internalMutation({ args: { draftId: v.id('drafts'), lotId: v.union(v.number(), v.null()),
    version: v.number(), deadline: v.number() }, handler: async (ctx, args): Promise<void> => {
    const record = await draftRecord(ctx);
    if (!record || record._id !== args.draftId || record.version !== args.version
        || record.value.status !== 'running' || record.value.lotId !== args.lotId
        || record.value.deadline !== args.deadline || Date.now() < args.deadline) return;
    const store = new Store(ctx, record);
    const state = await load(ctx, undefined, true, false);
    await advance(store, state, Date.now());
    await store.save(state);
} });
