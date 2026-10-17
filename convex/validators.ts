import { v } from 'convex/values';
export const placement = v.union(v.literal('active'), v.literal('taxi'), v.literal('ir'));
export const action = v.union(
    v.object({ type: v.literal('start') }),
    v.object({ type: v.literal('pause'), expectedRunning: v.optional(v.string()) }),
    v.object({ type: v.literal('resume'), expectedPause: v.optional(v.string()) }),
    v.object({ type: v.literal('undo'), lotId: v.number() }),
    v.object({ type: v.literal('done'), done: v.boolean(), nominationGeneration: v.optional(v.string()) }),
    v.object({ type: v.literal('nominate'), playerId: v.string(), amount: v.optional(v.number()),
        nominationGeneration: v.optional(v.string()) }),
    v.object({ type: v.literal('bid'), lotId: v.number(), amount: v.number() }),
    v.object({ type: v.literal('pass'), lotId: v.number() }),
    v.object({ type: v.literal('place'), playerId: v.string(), placement }),
    v.object({ type: v.literal('release'), managerId: v.number() })
);
export const player = v.object({ id: v.string(), name: v.string(), position: v.string(),
    positions: v.array(v.union(v.literal('PG'), v.literal('SG'), v.literal('SF'), v.literal('PF'),
        v.literal('C'), v.literal('G'), v.literal('F'))),
    team: v.union(v.string(), v.null()), status: v.union(v.string(), v.null()),
    yearsExp: v.union(v.number(), v.null()), injuryStatus: v.union(v.string(), v.null()),
    age: v.union(v.number(), v.null()), careerGames: v.union(v.number(), v.null()), careerGamesComplete: v.boolean(),
    projection: v.union(v.number(), v.null()), projectedStats: v.union(v.record(v.string(), v.number()), v.null()),
    adp: v.union(v.number(), v.null()) });

export const response = v.object({ managerId: v.number(), amount: v.number(), automatic: v.optional(v.string()) });
export const queueEntry = v.object({ id: v.string(), playerId: v.string(), amount: v.optional(v.number()),
    reason: v.optional(v.string()) });
export const queueAction = v.union(
    v.object({ type: v.literal('add'), playerId: v.string(), amount: v.optional(v.number()) }),
    v.object({ type: v.literal('remove'), id: v.string() }),
    v.object({ type: v.literal('edit'), id: v.string(), amount: v.optional(v.number()) }),
    v.object({ type: v.literal('reorder'), ids: v.array(v.string()) })
);
