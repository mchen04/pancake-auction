import { evidenceDirectory, evidenceFile, makeEvidenceDirectory } from "./evidence";
import { runAdmin } from "./admin-client";
import { readFile } from "node:fs/promises";
import { buildPool, sourceUrls } from "../lib/import-data";
import { readSnapshot, writeSnapshot, type Snapshot } from "../lib/import-cache";
import { safeError } from "./env";
async function main() {
    const apply = process.argv.includes("--apply");
    console.log("Sleeper requests the players endpoint at most once per day. Reuse the evidence snapshot within 24 hours.");
    const startedAt = new Date();
    const evidence = evidenceDirectory(process.env.EVIDENCE_DIR);
    const directory = evidence ? evidenceDirectory(`${evidence}/import`, true)! : null;
    const snapshot = directory ? evidenceFile(`${directory}/sleeper-2026.json`) : null;
    const sources = directory ? sourceUrls.map((_, index) => evidenceFile(`${directory}/source-${index}.json`)) : [];
    if (directory) await makeEvidenceDirectory(directory, { recursive: true });
    const option = process.argv.indexOf('--snapshot');
    const explicit = option >= 0 ? JSON.parse(await readFile(process.argv[option + 1], 'utf8')) as Snapshot : null;
    if (explicit && (!Number.isFinite(Date.parse(explicit.fetchedAt)) || !Array.isArray(explicit.data))) {
        throw new Error('Invalid recorded snapshot');
    }
    const cached = explicit ?? (snapshot ? await readSnapshot(snapshot) : null);
    const raw: unknown[] = cached && Array.isArray(cached.data) ? cached.data : [];
    const fetchedTimes: number[] = [];
    if (!raw.length) {
        for (let i = 0; i < sourceUrls.length; i++) {
            const initial = sources[i] ?? null;
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
    const fetchedAt = cached?.fetchedAt ?? new Date(Math.min(...fetchedTimes)).toISOString();
    await runAdmin('admin:importPlayers', { players: result.players, fetchedAt,
        startedAt: startedAt.getTime(), sources: sourceUrls, counts: result.counts, coverage: result.coverage });
    console.log(`Imported ${result.players.length} players.`);
}
main().catch(error => {
    console.error(safeError(error));
    process.exitCode = 1;
});
