import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
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
