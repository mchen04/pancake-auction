export type Position = "PG" | "SG" | "SF" | "PF" | "C" | "G" | "F";
export type Placement = "active" | "taxi" | "ir";
export interface Player {
    id: string;
    name: string;
    position: string;
    positions: Position[];
    team: string | null;
    status: string | null;
    yearsExp: number | null;
    injuryStatus: string | null;
    age: number | null;
    careerGames: number | null;
    careerGamesComplete: boolean;
    projection: number | null;
    projectedStats: Record<string, number> | null;
    adp: number | null;
}
export interface Entry {
    playerId: string;
    managerId: number;
    placement: Placement;
    price: number;
    lotId: number;
}
export interface Manager {
    id: number;
    name: string;
    commissioner: boolean;
    budget: number;
    done: boolean;
    claimed: boolean;
}
export interface Draft {
    status: "setup" | "running" | "paused" | "complete";
    nominationGeneration: string;
    turnSequence?: number;
    controlGeneration?: string;
    phase: "nomination" | "bidding";
    order: number[];
    turnIndex: number;
    nominatorId: number | null;
    lotId: number | null;
    deadline: number | null;
    remainingMs: number | null;
    nominationMs: number;
    biddingMs: number;
    extensionMs: number;
    capMs: number;
    passedTurns: number[];
    completionReason: string | null;
}
export interface Lot {
    id: number;
    playerId: string;
    nominatorId: number;
    highBidderId: number;
    highBid: number;
    status: string;
    player?: Player;
}
export interface RecentEvent {
    id: string;
    type: string;
    managerId: number | null;
    lotId: number | null;
    data: Record<string, unknown>;
    at: number;
}
export interface AuctionState {
    poolRevision: string;
    draft: Draft;
    managers: Manager[];
    players: Player[];
    roster: Entry[];
    lot: Lot | null;
    passes: number[];
    sales: Lot[];
    recentEvents: RecentEvent[];
    serverNow: number;
    me: number | null;
}
export type Action = {
    type: "start";
} | {
    type: "pause";
    expectedRunning?: string;
} | {
    type: "resume";
    expectedPause?: string;
} | {
    type: "undo";
    lotId: number;
} | {
    type: "done";
    done: boolean;
    nominationGeneration: string;
} | {
    type: "nominate";
    nominationGeneration: string;
    playerId: string;
    amount: number;
} | {
    type: "bid";
    lotId: number;
    amount: number;
} | {
    type: "pass";
    lotId: number;
} | {
    type: "force";
    lotId: number;
    expectedHighBidderId: number;
    expectedHighBid: number;
} | {
    type: "place";
    playerId: string;
    placement: Placement;
} | {
    type: "release";
    managerId: number;
};
