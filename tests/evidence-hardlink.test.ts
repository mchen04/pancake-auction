import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, cp, link, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { appendEvidenceFile, makeEvidenceDirectory, makeEvidenceTemporaryDirectory } from '../scripts/evidence';

const root = resolve(process.env.EVIDENCE_DIR || '../evidence', 'hardlink-regressions');
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
async function sourceAt(parent: string, importer = false) {
    const source = `${parent}/source`;
    const files = ['package.json', 'scripts/evidence.ts', 'scripts/evidence-cli.mjs', 'lib/import-cache.ts'];
    if (importer) files.push('scripts/import.ts', 'scripts/env.ts', 'scripts/admin-client.ts', 'scripts/local-cli.mjs',
        'lib/import-data.ts', 'lib/rules.ts', 'lib/types.ts', 'tests/import-fetch.mjs',
        'tests/import-fixture.ts', 'tests/fixtures/sleeper.json');
    for (const file of files) {
        const target = `${source}/${file}`;
        await mkdir(target.slice(0, target.lastIndexOf('/')), { recursive: true });
        await cp(resolve(file), target);
    }
    await symlink(resolve('node_modules'), `${source}/node_modules`, 'dir');
    return source;
}
async function eachCase(kind: string, work: (parent: string, source: string, proof: Record<string, unknown>) => Promise<void>,
    importer = false) {
    await makeEvidenceDirectory(root, { recursive: true });
    const parent = await makeEvidenceTemporaryDirectory(`${root}/case-`);
    const proof: Record<string, unknown> = { kind };
    try { await work(parent, await sourceAt(parent, importer), proof); }
    finally {
        await rm(parent, { recursive: true, force: true });
        proof.removed = !await access(parent).then(() => true, () => false);
        await appendEvidenceFile(`${root}/cases.jsonl`, JSON.stringify(proof) + '\n');
    }
}
const modes = ['write', 'descriptor', 'copy', 'snapshot', 'capture', 'record', 'append-record', 'command', 'append', 'time'] as const;
describe('C33 evidence writes do not mutate linked source inodes', () => {
    for (const mode of modes) for (const kind of ['hardlink', 'symlink', 'external']) {
        it(`${mode} ${kind} preserves source and removes temporary files`, async () => {
            await eachCase(`${mode}-${kind}`, async (parent, source, proof) => {
                const outside = `${parent}/outside`;
                await mkdir(outside);
                const marker = `${source}/marker.json`, target = `${outside}/output.json`;
                const original = '{"preserved":true}';
                await writeFile(marker, original);
                if (kind === 'hardlink') await link(marker, target);
                else if (kind === 'symlink') await symlink(marker, target);
                else await writeFile(target, 'old');
                const before = await stat(marker);
                const calls: Record<string, string> = {
                    write: "await io.writeEvidenceFile(target,'new')",
                    descriptor: "const h=await io.openEvidenceOutput(target);try{await h.writeFile('new')}finally{await h.close()}",
                    copy: "await io.copyEvidence(input,target)",
                    snapshot: "const cache=await import(source+'/lib/import-cache.ts');await cache.writeSnapshot(target,{fetchedAt:'2026-10-14T21:21:00.000Z',data:'new'})",
                    capture: "await io.captureEvidence(target,temporary=>fs.writeFile(temporary,'new'))",
                    append: "await io.appendEvidenceFile(target,'new')",
                    time: "await io.setEvidenceTimes(target,1,1)"
                };
                await writeFile(`${outside}/input`, 'new');
                const js = "import * as fs from 'node:fs/promises';import{pathToFileURL}from'node:url';"
                    + `const source=${JSON.stringify(source)},target=${JSON.stringify(target)},input=${JSON.stringify(`${outside}/input`)};`
                    + "const io=await import(pathToFileURL(source+'/scripts/evidence.ts'));" + calls[mode];
                const args = mode === 'record' || mode === 'append-record'
                    ? [`${source}/scripts/evidence-cli.mjs`, outside, mode === 'record' ? '--record' : '--append',
                        'output.json', 'value=new']
                    : mode === 'command' ? [`${source}/scripts/evidence-cli.mjs`, outside, '--capture', 'output.json',
                        process.execPath, '-e', "console.log('new')"]
                    : ['--import', `${source}/node_modules/tsx/dist/loader.mjs`, '--input-type=module', '-e', js];
                const result = spawnSync(process.execPath, args, { cwd: source, encoding: 'utf8', timeout: 10000,
                    env: { PATH: process.env.PATH, NODE_ENV: 'test' } });
                const after = await stat(marker), output = await readFile(target, 'utf8');
                const unchanged = hash(await readFile(marker, 'utf8')) === hash(original);
                const temporary = (await readdir(outside)).filter(name => name.startsWith('.evidence-') || name.startsWith('capture-'));
                Object.assign(proof, { exit: result.status, stderr: result.stderr, unchanged, output,
                    sourceBefore: hash(original), sourceAfter: hash(await readFile(marker, 'utf8')),
                    sourceMtimeBefore: before.mtimeMs, sourceMtimeAfter: after.mtimeMs, temporary });
                expect.soft(unchanged).toBe(true);
                expect.soft(after.mtimeMs).toBe(before.mtimeMs);
                const reject = kind === 'symlink' || kind === 'hardlink' && ['append', 'append-record', 'time'].includes(mode);
                expect.soft(result.status).toBe(reject ? 1 : 0);
                if (!reject) {
                    if (mode === 'time') {
                        expect(output).toBe('old');
                        expect((await stat(target)).mtimeMs).toBe(1000);
                    } else if (mode === 'append') expect(output).toBe('oldnew');
                    else if (mode === 'record') expect(output).toBe('value=new\n');
                    else if (mode === 'append-record') expect(output).toBe('oldvalue=new\n');
                    else if (mode === 'command') expect(output).toBe('new\n');
                    else if (mode === 'snapshot') expect(JSON.parse(output).data).toBe('new');
                    else expect(output).toBe('new');
                }
                if (kind === 'hardlink' && !reject) expect((await stat(target)).ino).not.toBe(after.ino);
                expect(temporary).toEqual([]);
            });
        }, 15000);
    }
    it.each(['write-failure', 'producer-failure', 'rename-failure'])(
        'failed atomic output cleans its temporary files: %s', async kind => {
            await eachCase(kind, async (parent, source, proof) => {
                const outside = `${parent}/outside`;
                await mkdir(outside);
                const target = `${outside}/target`;
                if (kind === 'rename-failure') await mkdir(target);
                else await writeFile(target, 'preserved');
                const expression = kind === 'write-failure' ? 'await io.writeEvidenceFile(target,undefined)'
                    : kind === 'producer-failure' ? "await io.captureEvidence(target,async temporary=>{await fs.writeFile(temporary,'partial');throw Error('producer failed')})"
                    : "await io.writeEvidenceFile(target,'new')";
                const script = "import * as fs from 'node:fs/promises';"
                    + `const io=await import(${JSON.stringify(`${source}/scripts/evidence.ts`)});`
                    + `const target=${JSON.stringify(target)};` + expression;
                const run = spawnSync(process.execPath, ['--import', `${source}/node_modules/tsx/dist/loader.mjs`,
                    '--input-type=module', '-e', script], { encoding: 'utf8', timeout: 10000 });
                const contents = await readdir(outside);
                Object.assign(proof, { exit: run.status, contents });
                expect(run.status).toBe(1);
                expect(contents).toEqual(['target']);
                if (kind !== 'rename-failure') expect(await readFile(target, 'utf8')).toBe('preserved');
            });
        }, 15000
    );
    it.each(['snapshot', 'source-cache', 'external'])('actual fixture importer preserves linked source: %s', async kind => {
        await eachCase(`import-${kind}`, async (parent, source, proof) => {
            const outside = `${parent}/outside`;
            await mkdir(`${outside}/import`, { recursive: true });
            const marker = `${source}/marker.json`, original = '{"source":true}';
            await writeFile(marker, original);
            const name = kind === 'source-cache' ? 'source-14.json' : 'sleeper-2026.json';
            if (kind !== 'external') await link(marker, `${outside}/import/${name}`);
            const fetchLog = `${parent}/fetch.jsonl`;
            const run = spawnSync(process.execPath, ['--import', `${source}/node_modules/tsx/dist/loader.mjs`,
                '--import', `${source}/tests/import-fetch.mjs`, `${source}/scripts/import.ts`], {
                cwd: parent, encoding: 'utf8', timeout: 15000, env: { PATH: process.env.PATH, NODE_ENV: 'test',
                    EVIDENCE_DIR: outside, IMPORT_TEST_FETCH_LOG: fetchLog,
                    IMPORT_TEST_NOW: String(Date.UTC(2026, 9, 1)) }
            });
            const fetched = (await readFile(fetchLog, 'utf8')).trim().split('\n').filter(Boolean).length;
            const outputs = await readdir(`${outside}/import`);
            Object.assign(proof, { exit: run.status, fetched, outputs, sourceBefore: hash(original),
                sourceAfter: hash(await readFile(marker, 'utf8')), stderr: run.stderr });
            expect(run.status).toBe(0);
            expect(await readFile(marker, 'utf8')).toBe(original);
            expect(fetched).toBe(15);
            expect(outputs).toHaveLength(16);
            expect(outputs.filter(name => name.startsWith('.evidence-'))).toEqual([]);
        }, true);
    }, 20000);
});
