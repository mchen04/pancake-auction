import { describe, expect, it } from "vitest";
import raw from "./fixtures/sleeper.json";
import { buildPool } from "../lib/import-data";
import { taxiEligibility } from "../lib/rules";
const fixture = () => structuredClone(raw) as unknown[];
describe("recorded Sleeper import", () => {
    it("keeps source projections, lower bounds and rookies", () => {
        const result = buildPool(fixture(), 1);
        const veteran = result.players.find(p => p.id === "1000")!;
        expect(veteran.careerGamesComplete).toBe(false);
        expect(veteran.careerGames).toBeGreaterThan(65);
        expect(veteran.projection).not.toBeNull();
        expect(veteran.injuryStatus).toBe("Out");
        expect(result.players.some(p => p.yearsExp === 0)).toBe(true);
    });
    it("never zero fills an absent projection", () => {
        const f = fixture();
        f[1] = (f[1] as {
            player_id: string;
        }[]).filter(r => r.player_id !== "1000");
        expect(buildPool(f, 1).players.find(p => p.id === "1000")!.projection).toBeNull();
    });
    it("counts null and missing gp as zero, preserves unknown lower bounds", () => {
        const f = fixture();
        for (const season of f.slice(2))
            (season as Record<string, unknown>)["1000"] = {
                gp: null
            };
        const p = buildPool(f, 1).players.find(p => p.id === "1000")!;
        expect(p.careerGames).toBe(0);
        expect(taxiEligibility(p)).toBe("unknown");
    });
    it("rejects unexpected shapes and small responses before writing", () => {
        expect(() => buildPool(fixture())).toThrow("small");
        const f = fixture();
        f[2] = [];
        expect(() => buildPool(f, 1)).toThrow("shape");
        const g = fixture();
        (g[2] as Record<string, unknown>)["1000"] = {
            gp: -1
        };
        expect(() => buildPool(g, 1)).toThrow("games");
    });
});
it("does not invent known games for a non-rookie absent from all seasons", () => {
    const f = fixture();
    (f[0] as Record<string, Record<string, unknown>>)["1000"].years_exp = 1;
    for (const season of f.slice(2))
        delete (season as Record<string, unknown>)["1000"];
    const keep = Object.keys(f[0] as object).find(id => id !== "1000")!;
    for (const season of f.slice(2))
        (season as Record<string, unknown>)[keep] = {
            gp: 0
        };
    const player = buildPool(f, 1).players.find(p => p.id === "1000")!;
    expect(player.careerGames).toBeNull();
    expect(taxiEligibility(player)).toBe("unknown");
});
it("uses stored age first, then computes age from birth_date without inventing missing ages", async () => {
    const { importedAge } = await import("../lib/import-data");
    const day = new Date("2026-10-14T00:00:00Z");
    expect(importedAge(30, "2000-10-14", day)).toBe(30);
    expect(importedAge(null, "2000-10-15", day)).toBe(25);
    expect(importedAge(undefined, "2000-10-14", day)).toBe(26);
    expect(importedAge(null, null, day)).toBeNull();
    expect(() => importedAge(null, "2000-02-30", day)).toThrow("birth_date");
});
