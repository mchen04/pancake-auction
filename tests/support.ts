import { mkdir, appendFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { begin, closeDatabase, schemaName } from "../lib/db";
import { migrate } from "../scripts/migrate";
import type { Player } from "../lib/types";
import leagueManagers from "../league/managers.json";
export function syntheticPool(): Player[] {
    return Array.from({
        length: 300
    }, (_, i) => ({
        id: `test-${i}`,
        name: `Test Player ${i + 1}`,
        position: [
            "PG",
            "SG",
            "SF",
            "PF",
            "C"
        ][i % 5],
        positions: [
            ["PG"],
            ["SG"],
            ["SF"],
            ["PF"],
            ["C"]
        ][i % 5] as Player["positions"],
        team: null,
        status: "ACT",
        yearsExp: i % 3 === 0 ? 0 : 1,
        injuryStatus: i % 5 === 0 ? "Out" : null,
        age: 22,
        careerGames: i % 3 === 0 ? 0 : i % 7 === 0 ? 100 : 40,
        careerGamesComplete: true,
        projection: 300 - i,
        projectedStats: null,
        adp: null
    }));
}
export async function createIsolated(prefix: "test" | "sim") {
    process.env.DB_SCHEMA = `${prefix}_${randomBytes(8).toString("hex")}`;
    if (process.env.EVIDENCE_DIR) {
        await mkdir(process.env.EVIDENCE_DIR, {
            recursive: true
        });
        await appendFile(`${process.env.EVIDENCE_DIR}/schemas.jsonl`, JSON.stringify({
            schema: schemaName(),
            action: "create",
            at: new Date().toISOString()
        }) + "\n");
    }
    await migrate();
    return schemaName();
}
export async function dropIsolated(name: string) {
    await closeDatabase();
    if (!/^(test|sim)_[a-z0-9_]+$/.test(name)) {
        throw new Error("Refusing to drop a non-test schema");
    }
    const client = new Client({
        connectionString: process.env.DATABASE_URL
    });
    await client.connect();
    try {
        await client.query(`DROP SCHEMA IF EXISTS "${name}" CASCADE`);
        if (process.env.EVIDENCE_DIR) {
            await appendFile(`${process.env.EVIDENCE_DIR}/schemas.jsonl`, JSON.stringify({
                schema: name,
                action: "drop",
                at: new Date().toISOString()
            }) + "\n");
        }
    }
    finally {
        await client.end();
    }
}
export async function sql(text: string, values: unknown[] = []) {
    const client = await begin();
    try {
        const result = await client.query(text, values);
        await client.query("COMMIT");
        return result;
    }
    catch (error) {
        await client.query("ROLLBACK");
        throw error;
    }
    finally {
        client.release();
    }
}
export async function seedManagers() {
    if (!/^(test|sim)_/.test(schemaName())) {
        throw new Error("Test setup requires an isolated schema");
    }
    await sql(`
    INSERT INTO managers(name,commissioner)
    SELECT item->>'name',(item->>'commissioner')::boolean
    FROM jsonb_array_elements($1::jsonb) WITH ORDINALITY AS entries(item,sequence)
    ORDER BY sequence
  `, [JSON.stringify(leagueManagers)]);
}
export async function seedPlayers(players = syntheticPool()) {
    await sql(`
    INSERT INTO players(id,data) SELECT item->>'id',item FROM jsonb_array_elements($1::jsonb)
    item ON CONFLICT(id) DO UPDATE SET data=EXCLUDED.data
`, [JSON.stringify(players)]);
}
export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
