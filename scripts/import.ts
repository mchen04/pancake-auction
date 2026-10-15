import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { begin, closeDatabase } from "../lib/db";
import { buildPool, sourceUrls } from "../lib/import-data";
import { readSnapshot, writeSnapshot, type Snapshot } from "../lib/import-cache";
import { loadEnvironment, safeError } from "./env";
async function main() {
    loadEnvironment();
    const apply = process.argv.includes("--apply");
    console.log("Sleeper requests the players endpoint at most once per day. Reuse the evidence snapshot within 24 hours.");
    const startedAt = new Date();
    const evidence = process.env.EVIDENCE_DIR;
    if (evidence && resolve(evidence).startsWith(resolve(".") + "/")) {
        throw new Error("EVIDENCE_DIR must be outside the repository");
    }
    const snapshot = evidence ? `${evidence}/import/sleeper-2026.json` : null;
    if (evidence) await mkdir(`${evidence}/import`, { recursive: true });
    const cached = snapshot ? await readSnapshot(snapshot) : null;
    const raw: unknown[] = cached && Array.isArray(cached.data) ? cached.data : [];
    const fetchedTimes: number[] = [];
    if (!raw.length) {
        for (let i = 0; i < sourceUrls.length; i++) {
            const initial = evidence ? `${evidence}/import/source-${i}.json` : null;
            let source: Snapshot | null = initial ? await readSnapshot(initial) : null;
            if (!source) {
                const response = await fetch(sourceUrls[i], {
                    headers: {
                        "User-Agent": "PancakeAuction/1.0 (one-time NBA dynasty auction import)"
                    },
                    signal: AbortSignal.timeout(30000)
                });
                if (!response.ok) {
                    throw new Error(`Sleeper HTTP ${response.status} at source ${i + 1}`);
                }
                source = { fetchedAt: new Date().toISOString(), data: await response.json() };
                if (initial) await writeSnapshot(initial, source);
                await new Promise(resolve => setTimeout(resolve, 150));
            }
            fetchedTimes.push(Date.parse(source.fetchedAt));
            raw.push(source.data);
        }
    }
    else
        console.log("Using recorded Sleeper snapshot; no network calls.");
    const result = buildPool(raw);
    console.log(JSON.stringify({
        mode: apply ? "apply" : "dry-run",
        sources: sourceUrls,
        counts: result.counts,
        coverage: result.coverage
    }, null, 2));
    if (snapshot && !cached) {
        await writeSnapshot(snapshot, { fetchedAt: new Date(Math.min(...fetchedTimes)).toISOString(), data: raw });
    }
    if (!apply) {
        console.log("Dry run: no database writes.");
        return;
    }
    const client = await begin();
    try {
        await client.query("SELECT id FROM draft WHERE id=1 FOR UPDATE");
        if ((await client.query("SELECT status FROM draft")).rows[0].status !== "setup" || (await client.query(
            "SELECT 1 FROM lots LIMIT 1")).rowCount) {
            throw new Error("Import is forbidden once the draft starts; there is no override");
        }
        const ids = result.players.map(p => p.id);
        await client.query("DELETE FROM players WHERE NOT (id = ANY($1::text[]))", [ids]);
        await client.query(`
    INSERT INTO players(id,data) SELECT item->>'id',item FROM jsonb_array_elements($1::jsonb)
    item ON CONFLICT(id) DO UPDATE SET data=EXCLUDED.data
`, [JSON.stringify(result.players)]);
        await client.query("INSERT INTO import_runs(started_at,sources,counts,coverage) VALUES($1,$2,$3,$4)", [
            startedAt,
            JSON.stringify(sourceUrls),
            result.counts,
            result.coverage
        ]);
        await client.query("COMMIT");
        console.log(`Imported ${ids.length} players.`);
    }
    catch (error) {
        await client.query("ROLLBACK");
        throw error;
    }
    finally {
        client.release();
    }
}
main().catch(error => {
    console.error(safeError(error));
    process.exitCode = 1;
}).finally(closeDatabase);
