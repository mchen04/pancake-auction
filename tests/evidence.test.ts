import { spawnSync } from 'node:child_process';
import { access, appendFile, cp, mkdir, mkdtemp, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { evidenceDirectory } from '../scripts/evidence';

const root = resolve(process.env.EVIDENCE_DIR || '../evidence', 'evidence-path-regressions');
describe('C14 evidence stays outside the repository', () => {
    it('guards optional and required evidence values through one helper', () => {
        expect(evidenceDirectory(undefined)).toBeUndefined();
        expect(() => evidenceDirectory(undefined, true)).toThrow('Set EVIDENCE_DIR outside');
        for (const path of ['.', './child', resolve('.'), './child/../child']) {
            expect(() => evidenceDirectory(path)).toThrow('EVIDENCE_DIR must be outside');
        }
        expect(evidenceDirectory(root)).toBe(root);
        expect(evidenceDirectory('../app-sibling')).toBe(resolve('../app-sibling'));
    });
    it.each(['.', './child', 'absolute-root', '../source/child', 'external'])(
        'rejects repository equality and descendants: %s', async value => {
            await mkdir(root, { recursive: true });
            const parent = await mkdtemp(`${root}/case-`);
            const cwd = `${parent}/source`;
            await mkdir(cwd);
            const evidence = value === 'absolute-root' ? cwd : value === 'external' ? `${parent}/outside` : value;
            const fetchLog = `${parent}/fetch.jsonl`;
            const result = spawnSync(process.execPath, [
                '--import', resolve('node_modules/tsx/dist/loader.mjs'),
                '--import', resolve('tests/import-fetch.mjs'), resolve('scripts/import.ts')
            ], { cwd, encoding: 'utf8', timeout: 15000, env: {
                ...process.env, EVIDENCE_DIR: evidence, IMPORT_TEST_FETCH_LOG: fetchLog,
                IMPORT_TEST_NOW: String(Date.UTC(2026, 9, 1))
            } });
            const fetches = (await readFile(fetchLog, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean);
            if (value === 'external') {
                expect(result.status).toBe(0);
                expect(fetches).toHaveLength(15);
            } else {
                expect.soft(result.status).toBe(1);
                expect.soft(result.stderr).toContain('EVIDENCE_DIR must be outside the repository');
                expect(fetches).toHaveLength(0);
            }
        }, 20000
    );
});

async function fileCount(directory: string): Promise<number> {
    let count = 0;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.isDirectory()) count += await fileCount(`${directory}/${entry.name}`);
        else if (entry.isFile()) count++;
    }
    return count;
}
async function privateSource(parent: string) {
    const source = `${parent}/source`;
    const files = [
        'package.json', 'scripts/import.ts', 'scripts/evidence.ts', 'scripts/env.ts', 'scripts/admin-client.ts', 'scripts/local-cli.mjs',
        'lib/import-data.ts', 'lib/import-cache.ts', 'lib/rules.ts', 'lib/types.ts',
        'tests/import-fetch.mjs', 'tests/import-fixture.ts', 'tests/fixtures/sleeper.json'
    ];
    for (const file of files) await cp(resolve(file), `${source}/${file}`);
    await symlink(resolve('node_modules'), `${source}/node_modules`, 'dir');
    return source;
}
describe('C14 physical evidence containment', () => {
    it.each(['symlink-root', 'symlink-child', 'symlink-new-child', 'literal-root', 'literal-child',
        'external', 'external-new-child', 'symlink-missing-target', 'external-missing-target'])(
        'actual importer protects the private source through %s', async kind => {
            await mkdir(root, { recursive: true });
            const parent = await mkdtemp(`${root}/physical-`);
            const proof: Record<string, unknown> = { kind };
            try {
                const source = await privateSource(parent);
                await mkdir(`${source}/child`);
                const linkTarget = kind === 'symlink-child' ? `${source}/child`
                    : kind === 'symlink-missing-target' ? `${source}/missing`
                    : kind === 'external-missing-target' ? `${parent}/outside/missing` : source;
                await symlink(linkTarget, `${parent}/alias`, 'dir');
                const targets: Record<string, string> = {
                    'symlink-root': `${parent}/alias`,
                    'symlink-child': `${parent}/alias`,
                    'symlink-new-child': `${parent}/alias/new/deeper`,
                    'literal-root': source,
                    'literal-child': `${source}/child`,
                    external: `${parent}/external`,
                    'external-new-child': `${parent}/outside/new/deeper`,
                    'symlink-missing-target': `${parent}/alias/new`,
                    'external-missing-target': `${parent}/alias/new`
                };
                if (kind === 'external') await mkdir(targets[kind]);
                const before = await fileCount(source);
                const fetchLog = `${parent}/fetch.jsonl`;
                const result = spawnSync(process.execPath, [
                    '--import', `${source}/node_modules/tsx/dist/loader.mjs`,
                    '--import', `${source}/tests/import-fetch.mjs`, `${source}/scripts/import.ts`
                ], { cwd: source, encoding: 'utf8', timeout: 15000, env: {
                    PATH: process.env.PATH, NODE_ENV: 'test',
                    EVIDENCE_DIR: targets[kind], IMPORT_TEST_FETCH_LOG: fetchLog,
                    IMPORT_TEST_NOW: String(Date.UTC(2026, 9, 1))
                } });
                const fetched = (await readFile(fetchLog, 'utf8').catch(() => '')).trim()
                    .split('\n').filter(Boolean).map(line => JSON.parse(line).index);
                const after = await fileCount(source);
                const outputFiles = await fileCount(`${targets[kind]}/import`).catch(() => 0);
                Object.assign(proof, { exitCode: result.status, fetchIndexes: fetched,
                    sourceFilesBefore: before, sourceFilesAfter: after, outputFiles });
                expect.soft(after).toBe(before);
                if (kind.startsWith('external')) {
                    expect(result.status).toBe(0);
                    expect(fetched).toEqual(Array.from({ length: 15 }, (_, index) => index));
                    expect(outputFiles).toBe(16);
                } else {
                    expect.soft(result.status).toBe(1);
                    expect.soft(result.stderr).toContain('EVIDENCE_DIR must be outside the repository');
                    expect.soft(fetched).toEqual([]);
                    expect(outputFiles).toBe(0);
                }
            } finally {
                await rm(parent, { recursive: true, force: true });
                proof.temporaryTreeRemoved = await access(parent).then(() => false, () => true);
                await appendFile(`${root}/physical-cases.jsonl`, JSON.stringify(proof) + '\n');
            }
        }, 20000
    );
    it('canonicalizes a symlinked repository root', async () => {
        await mkdir(root, { recursive: true });
        const parent = await mkdtemp(`${root}/repository-link-`);
        try {
            await mkdir(`${parent}/source`);
            await symlink(`${parent}/source`, `${parent}/repository-alias`, 'dir');
            expect(() => evidenceDirectory(`${parent}/source`, false, `${parent}/repository-alias`))
                .toThrow('EVIDENCE_DIR must be outside');
        } finally {
            await rm(parent, { recursive: true, force: true });
        }
    });
});
