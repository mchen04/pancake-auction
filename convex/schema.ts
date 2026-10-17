import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';
import { player, placement, response, queueEntry } from './validators';

export default defineSchema({
    drafts: defineTable({ key: v.string(), value: v.object({ mode: v.optional(v.literal('sealed-v1')), tiePriority: v.optional(v.array(v.number())), status: v.union(v.literal('setup'),
        v.literal('running'), v.literal('paused'),
        v.literal('complete')), nominationGeneration: v.optional(v.string()), turnSequence: v.optional(v.number()),
        controlGeneration: v.optional(v.string()),
        phase: v.union(v.literal('nomination'), v.literal('bidding')),
        order: v.array(v.number()), turnIndex: v.number(), nominatorId: v.union(v.number(), v.null()),
        lotId: v.union(v.number(), v.null()), deadline: v.union(v.number(), v.null()),
        remainingMs: v.union(v.number(), v.null()), nominationMs: v.number(), biddingMs: v.number(),
        extensionMs: v.number(), capMs: v.number(), passedTurns: v.array(v.number()),
        completionReason: v.union(v.string(), v.null()) }), version: v.number(), nextLot: v.number(),
        nextEvent: v.number(), nominationSequence: v.optional(v.number()), turnSequence: v.optional(v.number()),
        controlSequence: v.optional(v.number()) }).index('key', ['key']),
    managers: defineTable({ id: v.number(), name: v.string(), commissioner: v.boolean(), budget: v.number(),
        done: v.boolean(), tokenHash: v.union(v.string(), v.null()), joinedAt: v.optional(v.number()) }).index('id', ['id']).index('tokenHash', ['tokenHash']),
    pools: defineTable({ revision: v.string(), players: v.array(player) }).index('revision', ['revision']),
    imports: defineTable({ revision: v.string(), startedAt: v.number(), finishedAt: v.number(),
        fetchedAt: v.string(), sources: v.array(v.string()), counts: v.any(), coverage: v.any() }),
    lots: defineTable({ id: v.number(), playerId: v.string(), nominatorId: v.number(), highBidderId: v.number(),
        highBid: v.number(), status: v.string(), player, eligibleIds: v.optional(v.array(v.number())),
        respondedIds: v.optional(v.array(v.number())), bids: v.optional(v.array(response)),
        priorityBefore: v.optional(v.array(v.number())), tied: v.optional(v.boolean()) }).index('id', ['id']).index('status', ['status']),
    roster: defineTable({ playerId: v.string(), managerId: v.number(), placement, price: v.number(), player,
        lotId: v.number() }).index('playerId', ['playerId']).index('lotId', ['lotId']),
    responses: defineTable({ lotId: v.number(), managerId: v.number(), amount: v.number(),
        automatic: v.optional(v.string()) }).index('lotId', ['lotId']).index('owner', ['lotId', 'managerId']),
    queues: defineTable({ managerId: v.number(), entries: v.array(queueEntry) }).index('managerId', ['managerId']),
    passes: defineTable({ lotId: v.number(), managerId: v.number() }).index('lotId', ['lotId']),
    events: defineTable({ sealed: v.optional(v.boolean()), id: v.number(), type: v.string(), managerId: v.union(v.number(), v.null()),
        lotId: v.union(v.number(), v.null()), data: v.any(), at: v.number() }).index('id', ['id'])
});
