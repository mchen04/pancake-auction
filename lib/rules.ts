import type { AuctionState, Entry, Manager, Placement, Player, Position } from "./types";
export function rankedDynastyAdp(value: number | null): number | null {
    return value !== null && value > 0 && value < 999 ? value : null;
}
export function canNominate(state: AuctionState, manager: Manager | undefined): boolean {
    if (!manager || manager.done) return false;
    const sold = new Set(state.roster.map(entry => entry.playerId));
    const entries = state.roster.filter(entry => entry.managerId === manager.id);
    return state.players.some(player => !sold.has(player.id)
        && maxBid(manager.budget, player, entries, state.players) >= 1);
}
export function timeoutNominee(state: AuctionState, manager: Manager | undefined): Player | undefined {
    if (!manager || manager.done) return undefined;
    const entries = state.roster.filter(entry => entry.managerId === manager.id);
    if (state.draft.mode === 'live-v1' && counts(entries).active >= 20) return undefined;
    const sold = new Set(state.roster.map(entry => entry.playerId));
    return state.players.filter(player => !sold.has(player.id)).sort((a, b) =>
        (b.projection ?? -Infinity) - (a.projection ?? -Infinity) || a.id.localeCompare(b.id))
        .find(player => maxBid(manager.budget, player, entries, state.players) >= 1);
}
export const slots = [
    "PG",
    "SG",
    "SF",
    "PF",
    "C",
    "G",
    "F",
    "UTIL",
    "UTIL",
    "UTIL",
    ...Array<string>(10).fill("BENCH")
];
export function fits(positions: Position[], slot: string): boolean {
    if (slot === "UTIL" || slot === "BENCH") return true;
    return positions.some(position => {
        if (position === slot) return true;
        if (slot === "G") return ["PG", "SG", "G"].includes(position);
        if (slot === "F") return ["SF", "PF", "F"].includes(position);
        return false;
    });
}
export function matching(players: Pick<Player, "positions">[]): number[] | null {
    if (players.length > slots.length) {
        return null;
    }
    const occupants = Array<number>(slots.length).fill(-1);
    function assign(player: number, visited: Set<number>): boolean {
        for (let slot = 0; slot < slots.length; slot++) {
            if (visited.has(slot) || !fits(players[player].positions, slots[slot])) {
                continue;
            }
            visited.add(slot);
            if (occupants[slot] < 0 || assign(occupants[slot], visited)) {
                occupants[slot] = player;
                return true;
            }
        }
        return false;
    }
    for (let i = 0; i < players.length; i++)
        if (!assign(i, new Set())) {
            return null;
        }
    return occupants;
}
export function taxiEligibility(player: Player): "eligible" | "ineligible" | "unknown" {
    if (player.yearsExp === 0) {
        return "eligible";
    }
    if (player.careerGames !== null && player.careerGames >= 65) {
        return "ineligible";
    }
    if (player.careerGamesComplete && player.careerGames !== null) {
        return "eligible";
    }
    return "unknown";
}
export function counts(entries: Entry[]) {
    return {
        active: entries.filter(e => e.placement === "active").length,
        taxi: entries.filter(e => e.placement === "taxi").length,
        ir: entries.filter(e => e.placement === "ir").length
    };
}
export function legalPlacements(player: Player, entries: Entry[], players: Player[]): Placement[] {
    const count = counts(entries);
    const result: Placement[] = [];
    if (count.active < 20) {
        const active = entries.filter(e => e.placement === "active").map(e => players.find(p => p.id === e.playerId));
        if (active.every(p => p !== undefined) && matching([...active as Player[], player])) {
            result.push("active");
        }
    }
    if (count.taxi < 3 && taxiEligibility(player) === "eligible") {
        result.push("taxi");
    }
    if (count.ir < 2 && player.injuryStatus === "Out") {
        result.push("ir");
    }
    return result;
}
export function placementMax(budget: number, entries: Entry[], placement: Placement): number {
    return budget - (20 - counts(entries).active - (placement === "active" ? 1 : 0));
}
export function maxBid(budget: number, player: Player, entries: Entry[], players: Player[]): number {
    return Math.max(0, ...legalPlacements(player, entries, players).map(p => placementMax(budget, entries, p)));
}
export function fantasyPoints(stats: Record<string, number>): number {
    const weights: Record<string, number> = {
        pts: 1,
        reb: 1,
        ast: 2,
        stl: 4,
        blk: 4,
        tpm: 1,
        fgm: 2,
        fga: -1,
        ftm: 1,
        fta: -1,
        to: -2
    };
    return Object.entries(weights).reduce((sum, [key, weight]) => {
        const alias = key === "tpm" ? stats.fg3m : key === "to" ? stats.tov : undefined;
        return sum + (stats[key] ?? alias ?? 0) * weight;
    }, 0);
}

export function nextDeadline(deadline: number, now: number, extensionMs: number, capMs: number): number {
    return Math.min(deadline + extensionMs, now + capMs);
}
