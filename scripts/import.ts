import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { begin, closeDatabase } from "../lib/db";
import { buildPool, sourceUrls } from "../lib/import-data";
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
    let raw: unknown[] = [];
    if (snapshot) {
        try {
            if (Date.now() - (await stat(snapshot)).mtimeMs < 86400000) {
                raw = JSON.parse(await readFile(snapshot, "utf8"));
            }
        }
        catch {
        }
    }
    if (!raw.length) {
        for (let i = 0; i < sourceUrls.length; i++) {
            let data: unknown;
            const initial = evidence ? `${evidence}/import/source-${i}.json` : null;
            if (initial) {
                try {
                    if (Date.now() - (await stat(initial)).mtimeMs < 86400000) {
                        data = JSON.parse(await readFile(initial, "utf8"));
                    }
                }
                catch {
                }
            }
            if (!data) {
                const response = await fetch(sourceUrls[i], {
                    headers: {
                        "User-Agent": "PancakeAuction/1.0 (one-time NBA dynasty auction import)"
                    },
                    signal: AbortSignal.timeout(30000)
                });
                if (!response.ok) {
                    throw new Error(`Sleeper HTTP ${response.status} at source ${i + 1}`);
                }
                data = await response.json();
                await new Promise(resolve => setTimeout(resolve, 150));
            }
            if (initial) {
                await writeFile(initial, JSON.stringify(data));
            }
            raw.push(data);
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
    if (snapshot) {
        await mkdir(`${evidence}/import`, {
            recursive: true
        });
        await writeFile(snapshot, JSON.stringify(raw));
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
