import { describe, expect, it } from "vitest";
import { counts, fantasyPoints, fits, legalPlacements, matching, maxBid,
    taxiEligibility } from "../lib/rules";
import type { Entry, Player } from "../lib/types";
const player: Player = {
    id: "p",
    name: "Test Player",
    position: "PG",
    positions: ["PG"],
    team: null,
    status: null,
    yearsExp: 1,
    injuryStatus: null,
    age: null,
    careerGames: 64,
    careerGamesComplete: true,
    projection: null,
    projectedStats: null,
    adp: null
};
const entry = (i: number, placement: Entry["placement"] = "active"): Entry => ({
    playerId: String(i),
    managerId: 1,
    placement,
    price: 1,
    lotId: i
});
const pool = Array.from({
    length: 25
}, (_, i) => ({
    ...player,
    id: String(i),
    positions: [
        ["PG"],
        ["SG"],
        ["SF"],
        ["PF"],
        ["C"]
    ][i % 5] as Player["positions"]
}));
describe("league rules", () => {
    it("scores the league example as 41, including Sleeper field names", () => expect(fantasyPoints({
        pts: 20,
        reb: 5,
        ast: 5,
        stl: 1,
        blk: 1,
        tpm: 2,
        fgm: 8,
        fga: 16,
        ftm: 2,
        fta: 2,
        to: 2
    })).toBe(41));
    it("applies exact slot rules", () => {
        expect(fits(["G"], "PG")).toBe(false);
        expect(fits(["SG"], "G")).toBe(true);
        expect(fits(["F"], "F")).toBe(true);
        expect(fits(["C"], "F")).toBe(false);
    });
    it("finds a full matching and rejects blocked starters", () => {
        expect(matching(pool.slice(0, 20))).not.toBeNull();
        expect(matching(Array(20).fill(player))).toBeNull();
        expect(matching(pool)).toBeNull();
        expect(matching([])).not.toBeNull();
    });
    it("reassigns flexible players rather than using greedy placement", () => {
        const diverse = Array(13).fill({
            positions: ["C"]
        }).concat([
            {
                positions: ["PG", "SG"]
            },
            {
                positions: ["PG"]
            },
            {
                positions: ["SF"]
            },
            {
                positions: ["PF"]
            }
        ]);
        expect(matching(diverse)).not.toBeNull();
    });
    it("distinguishes rookie, exact games, lower bounds and unknown games", () => {
        expect(taxiEligibility({
            ...player,
            yearsExp: 0,
            careerGames: null,
            careerGamesComplete: false
        })).toBe("eligible");
        expect(taxiEligibility(player)).toBe("eligible");
        expect(taxiEligibility({
            ...player,
            careerGames: 65
        })).toBe("ineligible");
        expect(taxiEligibility({
            ...player,
            careerGamesComplete: false
        })).toBe("unknown");
        expect(taxiEligibility({
            ...player,
            careerGames: 65,
            careerGamesComplete: false
        })).toBe("ineligible");
        expect(taxiEligibility({
            ...player,
            careerGames: null
        })).toBe("unknown");
    });
    it("allows only exactly Out for IR and respects group limits", () => {
        for (const injuryStatus of [
            "Questionable",
            "Doubtful",
            "Day-To-Day",
            "DTD",
            "GTD",
            "IR",
            null
        ])
            expect(legalPlacements({
                ...player,
                injuryStatus
            }, [], pool)).not.toContain("ir");
        expect(legalPlacements({
            ...player,
            injuryStatus: "Out"
        }, [], pool)).toContain("ir");
        expect(legalPlacements(player, [entry(0, "taxi"), entry(1, "taxi"), entry(2, "taxi")],
            pool)).not.toContain("taxi");
    });
    it("reserves active spots, with a different reserve for taxi/IR", () => {
        expect(maxBid(1000, player, [], pool)).toBe(981);
        const full = pool.slice(0, 20).map((_, i) => entry(i));
        expect(counts(full).active).toBe(20);
        expect(maxBid(500, player, full, pool)).toBe(500);
        expect(maxBid(500, {
            ...player,
            careerGames: 100
        }, full, pool)).toBe(0);
        const blocked = Array.from({
            length: 15
        }, (_, i) => entry(i));
        const guards = pool.map(p => ({
            ...p,
            positions: ["PG"] as Player["positions"]
        }));
        expect(maxBid(100, player, blocked, guards)).toBe(95);
    });
});
