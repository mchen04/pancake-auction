import { v } from 'convex/values';
import { internalMutation } from '../convex/_generated/server';
import { draftRecord, load, Store } from '../convex/engine';
import type { Draft, Entry } from '../lib/types';

export const queryFailure = internalMutation({ args: { enabled: v.boolean() }, handler: async (ctx, args) => {
    const rows = await ctx.db.query('drafts').withIndex('key', q => q.eq('key', 'auction')).collect();
    if (args.enabled) {
        const row = rows[0];
        await ctx.db.insert('drafts', { key: row.key, value: row.value, version: row.version,
            nextLot: row.nextLot, nextEvent: row.nextEvent });
    } else {
        for (const row of rows.slice(1)) await ctx.db.delete(row._id);
    }
} });

export const refreshPoolRevision = internalMutation({ args: {}, handler: async ctx => {
    const pool = await ctx.db.query('pools').unique();
    const imported = await ctx.db.query('imports').order('desc').first();
    if (!pool || !imported) throw new Error('Import the fixture first');
    const revision = crypto.randomUUID();
    await ctx.db.patch(pool._id, { revision });
    await ctx.db.patch(imported._id, { revision });
} });

export const configure = internalMutation({ args: { draft: v.optional(v.any()), managers: v.optional(v.any()),
    roster: v.optional(v.any()), lot: v.optional(v.any()), deadlineAfterMs: v.optional(v.number()) },
handler: async (ctx, args) => {
    const record = await draftRecord(ctx);
    if (!record) throw new Error('Initialize the test league first');
    const state = await load(ctx);
    if (args.draft) Object.assign(state.draft, args.draft as Partial<Draft>);
    if (args.deadlineAfterMs !== undefined) state.draft.deadline = Date.now() + args.deadlineAfterMs;
    for (const change of args.managers ?? []) {
        const manager = state.managers.find(manager => manager.id === change.id);
        if (!manager) throw new Error('Unknown fixture manager');
        Object.assign(manager, change);
        const row = await ctx.db.query('managers').withIndex('id', q => q.eq('id', manager.id)).unique();
        await ctx.db.patch(row!._id, change);
    }
    if (args.roster) {
        for (const row of await ctx.db.query('roster').collect()) await ctx.db.delete(row._id);
        for (const row of await ctx.db.query('lots').collect()) await ctx.db.delete(row._id);
        for (const entry of args.roster as Entry[]) {
            const player = state.players.find(player => player.id === entry.playerId);
            if (!player) throw new Error('Unknown fixture player');
            await ctx.db.insert('roster', { ...entry, player });
            await ctx.db.insert('lots', { id: entry.lotId, playerId: entry.playerId,
                nominatorId: entry.managerId, highBidderId: entry.managerId, highBid: entry.price,
                status: 'sold', player });
        }
    }
    if (args.lot) {
        const before = await ctx.db.query('lots').withIndex('id', q => q.eq('id', args.lot.id)).unique();
        const row = { ...args.lot, player: state.players.find(player => player.id === args.lot.playerId) };
        if (before) await ctx.db.replace(before._id, row);
        else await ctx.db.insert('lots', row);
    }
    const store = new Store(ctx, record);
    if (args.roster) store.nextLot = Math.max(0, ...args.roster.map((entry: Entry) => entry.lotId)) + 1;
    await store.save(state);
} });
