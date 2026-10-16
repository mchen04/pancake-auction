import {
    appendEvidenceFile as appendFile, copyEvidence as cp, makeEvidenceDirectory as mkdir,
    makeEvidenceTemporaryDirectory as mkdtemp, writeEvidenceFile as writeFile
} from '../scripts/evidence';
import { spawnSync } from 'node:child_process';
import { access, readFile, readdir, rm, symlink } from 'node:fs/promises';
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
            try {
                const cwd = await privateSource(parent);
                const evidence = value === 'absolute-root' ? cwd : value === 'external' ? `${parent}/outside` : value;
                const fetchLog = `${parent}/fetch.jsonl`;
                const result = spawnSync(process.execPath, [
                    '--import', `${cwd}/node_modules/tsx/dist/loader.mjs`,
                    '--import', `${cwd}/tests/import-fetch.mjs`, `${cwd}/scripts/import.ts`
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
            } finally {
                await rm(parent, { recursive: true, force: true });
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
        'package.json', 'scripts/evidence-cli.mjs', 'scripts/import.ts', 'scripts/evidence.ts',
        'scripts/env.ts', 'scripts/admin-client.ts', 'scripts/local-cli.mjs',
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
            const source = await privateSource(parent);
            await symlink(source, `${parent}/repository-alias`, 'dir');
            const before = await fileCount(source);
            const fetchLog = `${parent}/fetch.jsonl`;
            const result = spawnSync(process.execPath, [
                '--import', `${source}/node_modules/tsx/dist/loader.mjs`,
                '--import', `${source}/tests/import-fetch.mjs`, `${parent}/repository-alias/scripts/import.ts`
            ], { cwd: parent, encoding: 'utf8', timeout: 15000, env: {
                PATH: process.env.PATH, NODE_ENV: 'test', EVIDENCE_DIR: source,
                IMPORT_TEST_FETCH_LOG: fetchLog, IMPORT_TEST_NOW: String(Date.UTC(2026, 9, 1))
            } });
            expect(result.status).toBe(1);
            expect(result.stderr).toContain('EVIDENCE_DIR must be outside');
            expect(await fileCount(source)).toBe(before);
            expect(await readFile(fetchLog, 'utf8').catch(() => '')).toBe('');
        } finally {
            await rm(parent, { recursive: true, force: true });
        }
    });
});

describe('C23 source boundary ignores the caller working directory', () => {
    it.each(['source-cwd', 'sibling-cwd', 'external-from-sibling'])(
        'actual absolute importer invocation: %s', async kind => {
            await mkdir(root, { recursive: true });
            const parent = await mkdtemp(`${root}/cwd-`);
            const proof: Record<string, unknown> = { kind };
            try {
                const source = await privateSource(parent);
                const sibling = `${parent}/sibling`;
                await mkdir(sibling);
                const cwd = kind === 'source-cwd' ? source : sibling;
                const target = kind === 'external-from-sibling' ? `${parent}/external/new` : `${source}/evidence`;
                const before = await fileCount(source);
                const fetchLog = `${parent}/fetch.jsonl`;
                const result = spawnSync(process.execPath, [
                    '--import', `${source}/node_modules/tsx/dist/loader.mjs`,
                    '--import', `${source}/tests/import-fetch.mjs`, `${source}/scripts/import.ts`
                ], { cwd, encoding: 'utf8', timeout: 15000, env: {
                    PATH: process.env.PATH, NODE_ENV: 'test', EVIDENCE_DIR: target,
                    IMPORT_TEST_FETCH_LOG: fetchLog, IMPORT_TEST_NOW: String(Date.UTC(2026, 9, 1))
                } });
                const fetched = (await readFile(fetchLog, 'utf8').catch(() => '')).trim()
                    .split('\n').filter(Boolean).map(line => JSON.parse(line).index);
                const after = await fileCount(source);
                const outputFiles = await fileCount(`${target}/import`).catch(() => 0);
                Object.assign(proof, { cwd, target, exitCode: result.status, fetchIndexes: fetched,
                    sourceFilesBefore: before, sourceFilesAfter: after, outputFiles });
                expect.soft(after).toBe(before);
                if (kind === 'external-from-sibling') {
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
                await appendFile(`${root}/cwd-cases.jsonl`, JSON.stringify(proof) + '\n');
            }
        }, 20000
    );
});

describe('C25 actual importer checks every output target', () => {
    it.each(['direct-root','child-link','final-snapshot-link','final-cache-link','external','sibling-child-link'])(
        'rejects source writes through %s', async kind => {
            await mkdir(root, { recursive: true });
            const parent = await mkdtemp(`${root}/write-target-`);
            const proof: Record<string, unknown> = { kind };
            try {
                const source = await privateSource(parent);
                const outside = `${parent}/outside`;
                const cache = `${source}/existing-cache`;
                const marker = `${source}/existing.json`;
                await mkdir(cache);
                await mkdir(`${outside}/import`, { recursive: true });
                const original = '{"untouched":true}\n';
                await writeFile(marker, original);
                if (kind === 'child-link' || kind === 'sibling-child-link') {
                    await rm(`${outside}/import`, { recursive: true });
                    await symlink(cache, `${outside}/import`, 'dir');
                }
                if (kind.startsWith('final-')) {
                    const name = kind === 'final-cache-link' ? 'source-14.json' : 'sleeper-2026.json';
                    await symlink(marker, `${outside}/import/${name}`, 'file');
                }
                const fetchLog = `${parent}/fetch.jsonl`;
                const before = await fileCount(source);
                const { createHash } = await import('node:crypto');
                const hash = (value: string) => createHash('sha256').update(value).digest('hex');
                const result = spawnSync(process.execPath, [
                    '--import', `${source}/node_modules/tsx/dist/loader.mjs`,
                    '--import', `${source}/tests/import-fetch.mjs`, `${source}/scripts/import.ts`
                ], { cwd: kind === 'sibling-child-link' ? parent : source, encoding: 'utf8', timeout: 15000,
                    env: { PATH: process.env.PATH, NODE_ENV: 'test', EVIDENCE_DIR: kind === 'direct-root' ? source : outside,
                        IMPORT_TEST_FETCH_LOG: fetchLog, IMPORT_TEST_NOW: String(Date.UTC(2026, 9, 1)) } });
                const fetched = (await readFile(fetchLog, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean);
                const after = await fileCount(source);
                const current = await readFile(marker, 'utf8');
                Object.assign(proof, { exitCode: result.status, fetched: fetched.length,
                    sourceFilesBefore: before, sourceFilesAfter: after, markerBefore: hash(original),
                    markerAfter: hash(current), stdout: result.stdout, stderr: result.stderr });
                expect.soft(after).toBe(before);
                expect.soft(hash(current)).toBe(hash(original));
                if (kind === 'external') {
                    expect(result.status).toBe(0);
                    expect(fetched).toHaveLength(15);
                    expect(await fileCount(`${outside}/import`)).toBe(16);
                } else {
                    expect.soft(result.status).toBe(1);
                    expect.soft(result.stderr).toMatch(/outside the repository|symbolic link/i);
                    expect(fetched).toHaveLength(0);
                }
            } finally {
                await rm(parent, { recursive: true, force: true });
                proof.temporaryTreeRemoved = await access(parent).then(() => false, () => true);
                await appendFile(`${root}/write-target-cases.jsonl`, JSON.stringify(proof) + '\n');
            }
        }, 20000
    );
});

describe('C25 command logs use the shared output guard', () => {
    it.each(['child-link','file-link','external'])('actual capture command: %s', async kind => {
        await mkdir(root,{recursive:true});
        const parent=await mkdtemp(`${root}/command-`);
        const proof: Record<string,unknown>={kind};
        try {
            const source=await privateSource(parent), outside=`${parent}/outside`;
            await mkdir(outside);
            const marker=`${source}/protected.json`, original='{"preserved":true}';
            await writeFile(marker,original);
            if(kind==='child-link')await symlink(source,`${outside}/child`,'dir');
            if(kind==='file-link')await symlink(marker,`${outside}/capture.log`,'file');
            const output=kind==='child-link'?'child/capture.log':'capture.log';
            const executed=`${parent}/executed`;
            const script=`require('node:fs').writeFileSync(${JSON.stringify(executed)},'ran');console.log('recorded')`;
            const before=await fileCount(source);
            const run=spawnSync(process.execPath,[`${source}/scripts/evidence-cli.mjs`,outside,'--capture',output,
                process.execPath,'-e',script],{cwd:parent,encoding:'utf8',timeout:10000,env:{PATH:process.env.PATH,NODE_ENV:'test'}});
            const after=await fileCount(source);
            Object.assign(proof,{exitCode:run.status,sourceFilesBefore:before,sourceFilesAfter:after,
                markerUnchanged:await readFile(marker,'utf8')===original,
                executed:await access(executed).then(()=>true,()=>false),stderr:run.stderr});
            expect(after).toBe(before);
            expect(proof.markerUnchanged).toBe(true);
            if(kind==='external') {
                expect(run.status).toBe(0);
                expect(proof.executed).toBe(true);
                expect(await readFile(`${outside}/capture.log`,'utf8')).toBe('recorded\n');
            } else {
                expect(run.status).toBe(1);
                expect(proof.executed).toBe(false);
                expect(run.stderr).toMatch(/outside the repository|symbolic link/i);
            }
        } finally {
            await rm(parent,{recursive:true,force:true});
            await appendFile(`${root}/cli-write-cases.jsonl`,JSON.stringify(proof)+'\n');
        }
    },15000);
});
