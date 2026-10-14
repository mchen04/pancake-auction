import { Pool, type PoolClient } from "pg";
export function schemaName(): string {
    const name = process.env.DB_SCHEMA || "auction";
    if (!/^[a-z][a-z0-9_]{0,62}$/.test(name)) {
        throw new Error("Invalid DB_SCHEMA");
    }
    return name;
}
let pool: Pool | undefined;
let direct = false;
export function selectDirectDatabase() {
    direct = true;
}
export function database(): Pool {
    if (!pool) {
        const connectionString = direct ? process.env.DATABASE_URL : process.env.DATABASE_URL_POOLED;
        if (!connectionString) {
            throw new Error("DATABASE_URL_POOLED is required");
        }
        pool = new Pool({
            connectionString,
            max: 12,
            connectionTimeoutMillis: 15000,
            idleTimeoutMillis: 10000
        });
    }
    return pool;
}
export async function closeDatabase() {
    await pool?.end();
    pool = undefined;
}
export async function begin(): Promise<PoolClient> {
    const client = await database().connect();
    try {
        await client.query(`BEGIN; SET LOCAL search_path TO "${schemaName()}"`);
        return client;
    }
    catch (error) {
        client.release();
        throw error;
    }
}
export async function dbNow(client: PoolClient): Promise<number> {
    const result = await client.query("SELECT extract(epoch FROM clock_timestamp()) * 1000 AS now");
    return Math.floor(Number(result.rows[0].now));
}
