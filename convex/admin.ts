import { v } from 'convex/values';
import { internalMutation, internalQuery } from './_generated/server';
import { draftRecord, initialDraft } from './engine';
import { leagueManagers } from '../lib/league';
import { player } from './validators';

export const managers = internalMutation({ args: {}, handler: async ctx => {
    const draft = await draftRecord(ctx);
    if (draft && draft.value.status !== 'setup' || await ctx.db.query('lots').first() || await ctx.db.query('roster').first()) {
        throw new Error('Manager setup is forbidden once the draft starts');
    }
    if (!draft) await ctx.db.insert('drafts', { key: 'auction', value: initialDraft(), version: 0,
        nextLot: 1, nextEvent: 1 });
    if (draft && draft.value.mode !== 'sealed-v1') await ctx.db.patch(draft._id, { value: initialDraft() });
    const existing = await ctx.db.query('managers').collect();
    for (const [index, manager] of leagueManagers.entries()) {
        const row = existing.find(row => row.id === index + 1);
        if (row && (row.name !== manager.name || row.commissioner !== manager.commissioner)) {
            throw new Error('Existing manager identities differ from league configuration');
        }
        if (!row) await ctx.db.insert('managers', { ...manager, id: index + 1, budget: 1000,
            done: false, tokenHash: null });
    }
    return { managers: 10, commissioner: 'Michael' };
} });
export const importPlayers = internalMutation({ args: { players: v.array(player), fetchedAt: v.string(),
    startedAt: v.number(), sources: v.array(v.string()), counts: v.any(), coverage: v.any() },
handler: async (ctx, args) => {
    const draft = await draftRecord(ctx);
    if (draft && draft.value.status !== 'setup' || await ctx.db.query('lots').first() || await ctx.db.query('roster').first()) {
        throw new Error('Import is forbidden once the draft starts; there is no override');
    }
    if (!Number.isFinite(Date.parse(args.fetchedAt)) || new Set(args.players.map(p => p.id)).size !== args.players.length) {
        throw new Error('Invalid import metadata or duplicate player ids');
    }
    const revision = crypto.randomUUID();
    const previous = await ctx.db.query('pools').unique();
    if (previous) await ctx.db.replace(previous._id, { revision, players: args.players });
    else await ctx.db.insert('pools', { revision, players: args.players });
    await ctx.db.insert('imports', { revision, startedAt: args.startedAt, finishedAt: Date.now(),
        fetchedAt: args.fetchedAt, sources: args.sources, counts: args.counts, coverage: args.coverage });
    return { revision, players: args.players.length };
} });
export const release = internalMutation({ args: { name: v.string() }, handler: async (ctx, args) => {
    const manager = (await ctx.db.query('managers').collect()).find(manager => manager.name === args.name);
    if (!manager) throw new Error('Manager does not exist');
    await ctx.db.patch(manager._id, { tokenHash: null });
    const draft = await draftRecord(ctx);
    if (draft) {
        await ctx.db.insert('events', { id: draft.nextEvent, type: 'release', managerId: null, lotId: null,
            data: { managerId: manager.id, now: Date.now() }, at: Date.now() });
        await ctx.db.patch(draft._id, { nextEvent: draft.nextEvent + 1 });
    }
    return { released: manager.name };
} });
export const inspect = internalQuery({ args: {}, handler: async ctx => ({
    draft: await draftRecord(ctx), managers: (await ctx.db.query('managers').collect()).map(manager => ({
        id: manager.id, name: manager.name, commissioner: manager.commissioner, budget: manager.budget,
        done: manager.done, claimed: manager.tokenHash !== null })),
    roster: await ctx.db.query('roster').collect(), lots: await ctx.db.query('lots').collect(),
    events: await ctx.db.query('events').withIndex('id').collect(), imports: await ctx.db.query('imports').collect(),
    pool: await ctx.db.query('pools').unique().then(pool => pool
        ? { revision: pool.revision, count: pool.players.length } : null)
}) });
