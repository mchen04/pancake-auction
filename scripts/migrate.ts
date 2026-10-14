import { readFile, readdir } from "node:fs/promises";
import { Client } from "pg";
import { schemaName } from "../lib/db";
export async function migrate() {
    const client = new Client({
        connectionString: process.env.DATABASE_URL
    });
    await client.connect();
    try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`pancake-migrate-${schemaName()}`]);
        await client.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName()}"`);
        await client.query(`SET LOCAL search_path TO "${schemaName()}"`);
        await client.query(`
    CREATE TABLE IF NOT EXISTS migrations (file text PRIMARY KEY, applied_at timestamptz NOT
    NULL DEFAULT clock_timestamp())
`);
        const applied = new Set((await client.query("SELECT file FROM migrations")).rows.map(r => r.file));
        for (const file of (await readdir("db/migrations")).filter(f => f.endsWith(".sql")).sort()) {
            if (applied.has(file)) {
                continue;
            }
            await client.query(await readFile(`db/migrations/${file}`, "utf8"));
            await client.query("INSERT INTO migrations(file) VALUES($1)", [file]);
            console.log(`Applied ${file}`);
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
}
