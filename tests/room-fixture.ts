import managers from '../league/managers.json';
import type { AuctionState, Player, Position } from '../lib/types';

export function roomFixture(): AuctionState {
    const positions: Position[] = ['PG', 'SG', 'SF', 'PF', 'C'];
    const players: Player[] = Array.from({ length: 30 }, (_, index) => ({
        id: `room-${index}`, name: `Test Player ${index}`, positions: [positions[index % 5]],
        position: positions[index % 5], team: 'TEST', status: 'ACT', yearsExp: index >= 20 ? 0 : 5,
        injuryStatus: null, age: 25, careerGames: index >= 20 ? 0 : 400, careerGamesComplete: true,
        projection: 30 - index, projectedStats: null, adp: index + 1
    }));
    return {
        poolRevision: '1', players, roster: [], passes: [], sales: [], recentEvents: [], me: 1,
        serverNow: Date.now(),
        managers: managers.map((manager, index) => ({
            ...manager, id: index + 1, budget: 1000, done: false, claimed: true
        })),
        lot: { id: 101, playerId: players[0].id, nominatorId: 2, highBidderId: 2, highBid: 1, status: 'open' },
        draft: {
            status: 'running', nominationGeneration: 'fixture:1', phase: 'bidding', order: managers.map((_, index) => index + 1), turnIndex: 1,
            nominatorId: 2, lotId: 101, deadline: Date.now() + 600000, remainingMs: null,
            nominationMs: 10000, biddingMs: 10000, extensionMs: 5000, capMs: 15000,
            passedTurns: [], completionReason: null
        }
    };
}
