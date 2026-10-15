import { spawnSync } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, utimes } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(process.env.EVIDENCE_DIR || '../evidence', 'import-regressions');
const hour = 3600000;
const epoch = Date.UTC(2026, 9, 1);
async function directory(label: string) {
    await mkdir(root, { recursive: true });
    return mkdtemp(`${root}/${label}-`);
}
async function invoke(evidence: string, hours = 0) {
    const fetchLog = `${evidence}-fetch.jsonl`;
    const before = await readFile(fetchLog, 'utf8').catch(() => '');
    const result = spawnSync(process.execPath, [
        '--import', 'tsx', '--import', resolve('tests/import-fetch.mjs'), 'scripts/import.ts'
    ], {
        encoding: 'utf8', env: {
            ...process.env, EVIDENCE_DIR: evidence, IMPORT_TEST_NOW: String(epoch + hours * hour),
            IMPORT_TEST_FETCH_LOG: fetchLog
        }, timeout: 30000
    });
    const after = await readFile(fetchLog, 'utf8').catch(() => '');
    const fetches = after.slice(before.length).trim().split('\n').filter(Boolean).length;
    const snapshotPath = `${evidence}/import/sleeper-2026.json`;
    const snapshot = JSON.parse(await readFile(snapshotPath, 'utf8').catch(() => '{}'));
    await appendFile(`${root}/calls.jsonl`, JSON.stringify({ evidence, hours, exitCode: result.status, fetches,
        fetchedAt: snapshot.fetchedAt ?? null,
        mtimeMs: await stat(snapshotPath).then(file => file.mtimeMs).catch(() => null)
    }) + '\n');
    return { exitCode: result.status, fetches, stderr: result.stderr };
}

describe('recorded import CLI cache', () => {
    it.each(['fresh-root', 'existing-root', 'existing-import'])(
        'S2/C4 first import works with %s and never uses the network', async kind => {
            const parent = await directory(kind);
            const path = `${parent}/evidence`;
            if (kind !== 'fresh-root') await mkdir(path);
            if (kind === 'existing-import') await mkdir(`${path}/import`);
            const result = await invoke(path);
            expect(result).toEqual({ exitCode: 0, fetches: 15, stderr: '' });
        }, 10000
    );
    it('S3/C6 23-hour reuse does not slide past the original 24-hour fetch time', async () => {
        const path = await directory('repeated');
        await mkdir(`${path}/import`);
        expect((await invoke(path)).fetches).toBe(15);
        const original = await stat(`${path}/import/sleeper-2026.json`);
        expect((await invoke(path, 23)).fetches).toBe(0);
        expect.soft((await stat(`${path}/import/sleeper-2026.json`)).mtimeMs).toBe(original.mtimeMs);
        expect((await invoke(path, 46)).fetches).toBe(15);
        expect((await invoke(path, 69)).fetches).toBe(0);
        expect((await invoke(path, 92)).fetches).toBe(15);
    }, 30000);
    it('S3/C6 untouched 24-hour snapshot negative control fetches again', async () => {
        const path = await directory('untouched');
        await mkdir(`${path}/import`);
        expect((await invoke(path)).fetches).toBe(15);
        expect((await invoke(path, 24)).fetches).toBe(15);
    }, 15000);
    it('S3/C6 source-cache reuse keeps its original age even with a recent mtime', async () => {
        const path = await directory('source-cache');
        await mkdir(`${path}/import`);
        expect((await invoke(path)).fetches).toBe(15);
        await rm(`${path}/import/sleeper-2026.json`);
        expect((await invoke(path, 23)).fetches).toBe(0);
        await rm(`${path}/import/sleeper-2026.json`);
        for (let i = 0; i < 15; i++) {
            await utimes(`${path}/import/source-${i}.json`, epoch / 1000 + 24 * 3600, epoch / 1000 + 24 * 3600);
        }
        expect((await invoke(path, 24)).fetches).toBe(15);
    }, 20000);
});
