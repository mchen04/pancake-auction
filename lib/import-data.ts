import { fantasyPoints } from "./rules";
import type { Player, Position } from "./types";
export const sourceUrls = [
    "https://api.sleeper.app/v1/players/nba",
    "https://api.sleeper.app/projections/nba/2026?season_type=regular",
    ...Array.from({
        length: 13
    }, (_, i) => `https://api.sleeper.app/v1/stats/nba/regular/${2013 + i}`)
];
function object(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("Unexpected Sleeper object shape");
    }
    return value as Record<string, unknown>;
}
function nullableNumber(value: unknown): number | null {
    if (value === null || value === undefined) {
        return null;
    }
    if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error("Unexpected Sleeper numeric field");
    }
    return value;
}
function nullableText(value: unknown): string | null {
    if (value === null || value === undefined) {
        return null;
    }
    if (typeof value !== "string") {
        throw new Error("Unexpected Sleeper text field");
    }
    return value;
}
export function importedAge(age: unknown, birthDate: unknown, asOf: Date): number | null {
    const supplied = nullableNumber(age);
    if (supplied !== null) {
        if (!Number.isInteger(supplied) || supplied < 0 || supplied > 100) {
            throw new Error("Invalid player age");
        }
        return supplied;
    }
    const date = nullableText(birthDate);
    if (!date) {
        return null;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        throw new Error("Invalid birth_date");
    }
    const birth = new Date(`${date}T00:00:00Z`);
    if (!Number.isFinite(birth.getTime()) || birth.toISOString().slice(0, 10) !== date) {
        throw new Error("Invalid birth_date");
    }
    let years = asOf.getUTCFullYear() - birth.getUTCFullYear();
    const beforeBirthday = asOf.getUTCMonth() < birth.getUTCMonth() || asOf.getUTCMonth() === birth.getUTCMonth(
        ) && asOf.getUTCDate() < birth.getUTCDate();
    if (beforeBirthday) {
        years--;
    }
    if (years < 0 || years > 100) {
        throw new Error("Invalid birth_date age");
    }
    return years;
}
export function buildPool(raw: unknown[], minimum = 200, asOf = new Date()) {
    if (raw.length !== 15) {
        throw new Error("Expected players, projections, and thirteen seasons");
    }
    const people = object(raw[0]);
    if (Object.keys(people).length < minimum) {
        throw new Error("Suspiciously small players response");
    }
    if (!Array.isArray(raw[1]) || raw[1].length < minimum) {
        throw new Error("Unexpected or small projections response");
    }
    const projections = new Map<string, {
        stats: Record<string, number> | null;
        adp: number | null;
    }>();
    for (const value of raw[1]) {
        const r = object(value);
        if (typeof r.player_id !== "string" || typeof r.company !== "string") {
            throw new Error("Unexpected projection record");
        }
        if (r.company.toLowerCase() !== "rotowire") {
            continue;
        }
        const stats = object(r.stats);
        const numeric: Record<string, number> = {};
        for (const [key, val] of Object.entries(stats)) {
            const n = nullableNumber(val);
            if (n !== null) {
                numeric[key] = n;
            }
        }
        projections.set(r.player_id, {
            stats: numeric.pts === undefined ? null : numeric,
            adp: nullableNumber(stats.adp_dynasty)
        });
    }
    const seasons = raw.slice(2).map(value => {
        const season = object(value);
        if (Object.keys(season).length < minimum) {
            throw new Error("Suspiciously small season response");
        }
        for (const value of Object.values(season)) {
            const stats = object(value);
            const gp = nullableNumber(stats.gp);
            if (gp !== null && (!Number.isInteger(gp) || gp < 0)) {
                throw new Error("Unexpected season games");
            }
        }
        return season;
    });
    const players: Player[] = [];
    for (const [id, value] of Object.entries(people)) {
        const r = object(value);
        if (r.player_id !== undefined && r.player_id !== id) {
            throw new Error("Mismatched player id");
        }
        if (r.fantasy_positions !== null && r.fantasy_positions !== undefined && (!Array.isArray(
            r.fantasy_positions) || r.fantasy_positions.some(p => typeof p !== "string"))) {
            throw new Error("Unexpected positions");
        }
        const positions = (Array.isArray(r.fantasy_positions) ? r.fantasy_positions : []).filter(p => [
            "PG",
            "SG",
            "SF",
            "PF",
            "C"
        ].includes(p)) as Position[];
        if (!positions.length) {
            continue;
        }
        const name = nullableText(r.full_name) || [nullableText(r.first_name), nullableText(r.last_name)]
            .filter(Boolean).join(" ");
        if (!name.trim()) {
            throw new Error("Player has no name");
        }
        if (typeof r.active !== "boolean") {
            throw new Error("Unexpected active flag");
        }
        const projection = projections.get(id);
        const team = nullableText(r.team);
        if (!r.active || (!team && !projection?.stats && projection?.adp == null)) {
            continue;
        }
        const yearsExp = nullableNumber(r.years_exp);
        if (yearsExp !== null && (!Number.isInteger(yearsExp) || yearsExp < 0)) {
            throw new Error("Invalid years_exp");
        }
        const present = seasons.some(season => id in season);
        const games = seasons.reduce((sum, season) => sum + (id in season ? nullableNumber(object(
            season[id]).gp) ?? 0 : 0), 0);
        const complete = yearsExp !== null && 2026 - yearsExp >= 2013;
        players.push({
            id,
            name,
            positions,
            position: nullableText(r.position) || positions.join("/"),
            team,
            status: nullableText(r.status),
            yearsExp,
            injuryStatus: nullableText(r.injury_status),
            age: importedAge(r.age, r.birth_date, asOf),
            careerGames: present ? games : yearsExp === 0 ? 0 : null,
            careerGamesComplete: complete,
            projectedStats: projection?.stats ?? null,
            projection: projection?.stats ? fantasyPoints(projection.stats) : null,
            adp: projection?.adp ?? null
        });
    }
    if (players.length < minimum) {
        throw new Error("Suspiciously small eligible pool");
    }
    const count = (predicate: (p: Player) => boolean) => players.filter(predicate).length;
    return {
        players,
        counts: {
            sourcePlayers: Object.keys(people).length,
            pool: players.length,
            byStatus: Object.fromEntries([...new Set(players.map(p => p.status || "unknown"))].map(status =>
                [status, count(p => (p.status || "unknown") === status)]))
        },
        coverage: {
            projected: count(p => p.projection !== null),
            noProjection: count(p => p.projection === null),
            dynastyAdp: count(p => p.adp !== null),
            careerComplete: count(p => p.careerGamesComplete),
            careerPartialOrUnknown: count(p => !p.careerGamesComplete),
            out: count(p => p.injuryStatus === "Out"),
            notes: [
                "2013\u20132025 regular seasons only; earlier totals are lower bounds.",
                "Non-rookies with incomplete totals below 65 are ineligible (unknown).",
                "Injury status IR, DTD, GTD, Questionable and Doubtful do not qualify for IR.",
                "Rotowire 2026 projections are per game; missing stat lines remain null."
            ]
        }
    };
}
