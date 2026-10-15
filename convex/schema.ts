import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';
import { player, placement } from './validators';

export default defineSchema({
    drafts: defineTable({ key: v.string(), value: v.object({ status: v.union(v.literal('setup'), v.literal('running'), v.literal('paused'),
        v.literal('complete')), phase: v.union(v.literal('nomination'), v.literal('bidding')),
        order: v.array(v.number()), turnIndex: v.number(), nominatorId: v.union(v.number(), v.null()),
        lotId: v.union(v.number(), v.null()), deadline: v.union(v.number(), v.null()),
        remainingMs: v.union(v.number(), v.null()), nominationMs: v.number(), biddingMs: v.number(),
        extensionMs: v.number(), capMs: v.number(), passedTurns: v.array(v.number()),
        completionReason: v.union(v.string(), v.null()) }), version: v.number(), nextLot: v.number(),
        nextEvent: v.number() }).index('key', ['key']),
    managers: defineTable({ id: v.number(), name: v.string(), commissioner: v.boolean(), budget: v.number(),
        done: v.boolean(), tokenHash: v.union(v.string(), v.null()) }).index('id', ['id']),
    pools: defineTable({ revision: v.string(), players: v.array(player) }).index('revision', ['revision']),
    imports: defineTable({ revision: v.string(), startedAt: v.number(), finishedAt: v.number(),
        fetchedAt: v.string(), sources: v.array(v.string()), counts: v.any(), coverage: v.any() }),
    lots: defineTable({ id: v.number(), playerId: v.string(), nominatorId: v.number(), highBidderId: v.number(),
        highBid: v.number(), status: v.string(), player }).index('id', ['id']).index('status', ['status']),
    roster: defineTable({ playerId: v.string(), managerId: v.number(), placement, price: v.number(), player,
        lotId: v.number() }).index('playerId', ['playerId']).index('lotId', ['lotId']),
    passes: defineTable({ lotId: v.number(), managerId: v.number() }).index('lotId', ['lotId']),
    events: defineTable({ id: v.number(), type: v.string(), managerId: v.union(v.number(), v.null()),
        lotId: v.union(v.number(), v.null()), data: v.any(), at: v.number() }).index('id', ['id'])
});
