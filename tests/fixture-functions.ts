import { expireDraft } from '../convex/auction';
import { v } from 'convex/values';
import { internalMutation, internalQuery } from '../convex/_generated/server';
import { draftRecord, initialDraft, load, Store } from '../convex/engine';
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
        for (const row of await ctx.db.query('responses').collect()) await ctx.db.delete(row._id);
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
    if (args.draft) store.renewNomination(state);
    if (args.roster) store.nextLot = Math.max(0, ...args.roster.map((entry: Entry) => entry.lotId)) + 1;
    await store.save(state);
} });

export const reset = internalMutation({ args: {}, handler: async ctx => {
    for (const table of ['drafts', 'lots', 'roster', 'responses', 'queues', 'passes', 'events'] as const)
        for (const row of await ctx.db.query(table).collect()) await ctx.db.delete(row._id);
    for (const manager of await ctx.db.query('managers').collect())
        await ctx.db.patch(manager._id, { budget: 1000, done: false });
    await ctx.db.insert('drafts', { key: 'auction', value: initialDraft(), version: 0, nextLot: 1, nextEvent: 1 });
} });
export const deadlineSnapshot = internalQuery({ args: {}, handler: async ctx => {
    const record = (await draftRecord(ctx))!;
    return { draftId: record._id, lotId: record.value.lotId, version: record.version, deadline: record.value.deadline };
} });
export const simulatedExpiry = internalMutation({ args: { snapshot: v.object({ draftId: v.id('drafts'),
    lotId: v.union(v.number(), v.null()), version: v.number(), deadline: v.number() }), now: v.number() },
handler: async (ctx, args) => {
    await expireDraft(ctx, args.snapshot, args.now);
} });
export const scheduledDeadlines = internalQuery({ args: {}, handler: async ctx => {
    return (await ctx.db.system.query('_scheduled_functions').collect())
        .filter(job => job.state.kind === 'pending')
        .map(job => ({ name: job.name, args: job.args, scheduledTime: job.scheduledTime }));
} });
export const legacy = internalMutation({ args: {
    status: v.union(v.literal('setup'), v.literal('running'), v.literal('paused'), v.literal('complete')),
    data: v.optional(v.union(v.literal('lot'), v.literal('roster'))), unclaimed: v.optional(v.boolean())
}, handler: async (ctx, args) => {
    const record = (await draftRecord(ctx))!;
    const value: Draft = { status: 'setup', nominationGeneration: '', turnSequence: 0,
        phase: 'nomination', order: [], turnIndex: 0, nominatorId: null, lotId: null, deadline: null,
        remainingMs: null, nominationMs: 10000, biddingMs: 10000, extensionMs: 5000, capMs: 15000,
        passedTurns: [], completionReason: null };
    const player = (await ctx.db.query('pools').unique())!.players[0];
    if (args.unclaimed) for (const manager of await ctx.db.query('managers').collect())
        await ctx.db.patch(manager._id, { tokenHash: null });
    if (args.status !== 'setup') {
        value.status = args.status;
        value.order = [1,2,3,4,5,6,7,8,9,10];
        value.nominatorId = 1;
        value.phase = 'bidding';
        value.lotId = 1;
        value.deadline = Date.now() - 1;
        if (args.status === 'paused') value.remainingMs = 5000;
    }
    if (args.status !== 'setup' || args.data === 'lot') {
        await ctx.db.insert('lots', { id: 1, playerId: player.id, nominatorId: 1,
            highBidderId: 1, highBid: 73, status: args.status === 'complete' ? 'sold' : 'open', player });
    }
    if (args.data === 'roster') await ctx.db.insert('roster', {
        playerId: player.id, managerId: 1, placement: 'active', price: 73, lotId: 1, player
    });
    if (args.status !== 'setup') {
        await ctx.db.insert('passes', { lotId: 1, managerId: 2 });
        await ctx.db.insert('events', { id: 1, type: 'bid', managerId: 1, lotId: 1, data: { amount: 73 }, at: Date.now() });
    }
    await ctx.db.replace(record._id, { key: 'auction', value, version: 0, nextLot: 1, nextEvent: 1 });
} });
