import { readdir } from "node:fs/promises";
import { Client } from "pg";
import { schemaName } from "../lib/db";
import leagueManagers from "../league/managers.json";
export async function checkLeague() {
    const client = new Client({
        connectionString: process.env.DATABASE_URL
    });
    const failures: string[] = [];
    const report: Record<string, unknown> = {};
    await client.connect();
    try {
        await client.query("BEGIN READ ONLY");
        await client.query(`SET LOCAL search_path TO "${schemaName()}"`);
        const table = await client.query("SELECT to_regclass($1) AS name", [`${schemaName()}.migrations`]);
        if (!table.rows[0].name) {
            failures.push("Migrations are missing");
        }
        else {
            const expected = (await readdir("db/migrations")).filter(file => file.endsWith(".sql")).sort();
            const applied = new Set((await client.query("SELECT file FROM migrations")).rows.map(row => row.file));
            const missing = expected.filter(file => !applied.has(file));
            report.migrations = {
                applied: applied.size,
                missing
            };
            if (missing.length) {
                failures.push("Apply the missing migrations");
            }
            const managers = (await client.query("SELECT name,commissioner FROM managers")).rows;
            report.managers = {
                count: managers.length,
                commissioners: managers.filter(manager => manager.commissioner).length,
                names: managers.map(manager => manager.name)
            };
            if (managers.length !== 10) {
                failures.push("Configure exactly ten real managers");
            }
            if (managers.filter(manager => manager.commissioner).length !== 1) {
                failures.push("Configure exactly one commissioner");
            }
            const expectedNames = leagueManagers.map(manager => manager.name).sort();
            const configuredNames = managers.map(manager => manager.name).sort();
            if (JSON.stringify(configuredNames) !== JSON.stringify(expectedNames)) {
                failures.push("Manager names must match league/managers.json exactly");
            }
            const commissioner = leagueManagers.find(manager => manager.commissioner)!;
            if (managers.filter(manager => manager.commissioner).length !== 1 || !managers.some(manager =>
                manager.name === commissioner.name && manager.commissioner)) {
                failures.push("The configured commissioner must match league/managers.json");
            }
            const imported = (await client.query(`
        SELECT counts,coverage,finished_at FROM import_runs
        WHERE finished_at IS NOT NULL ORDER BY id DESC LIMIT 1
      `)).rows[0];
            const poolCount = Number((await client.query("SELECT count(*) FROM players")).rows[0].count);
            report.import = imported ?? null;
            report.poolCount = poolCount;
            if (!imported || !poolCount || imported.counts.pool !== poolCount) {
                failures.push("A completed player import with matching counts is required");
            }
            const draft = (await client.query("SELECT * FROM draft WHERE id=1")).rows[0];
            report.status = draft?.status;
            report.timingsMs = draft ? [
                draft.nomination_ms,
                draft.bidding_ms,
                draft.extension_ms,
                draft.cap_ms
            ] : [];
            if (draft?.status !== "setup") {
                failures.push("Draft must be in setup");
            }
            if (!draft || draft.nomination_ms !== 10000 || draft.bidding_ms !== 10000
                || draft.extension_ms !== 5000 || draft.cap_ms !== 15000) {
                failures.push("Production timings must be 10/10/5/15 seconds");
            }
            if ((await client.query("SELECT 1 FROM lots LIMIT 1")).rowCount) {
                failures.push("A started draft cannot pass readiness");
            }
        }
        await client.query("COMMIT");
    }
    catch (error) {
        await client.query("ROLLBACK");
        throw error;
    }
    finally {
        await client.end();
    }
    return {
        ready: failures.length === 0,
        ...report,
        failures
    };
}
