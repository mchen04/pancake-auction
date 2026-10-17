import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sourceVersion } from '../lib/app-version';
import { nextAttempt, parseAttempt, parseVersion, updateWindowMs } from '../lib/update';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function tree(files: Record<string, string>) {
    const root = mkdtempSync(join(tmpdir(), 'pancake-version-'));
    roots.push(root);
    for (const [path, body] of Object.entries(files)) {
        mkdirSync(join(root, path, '..'), { recursive: true });
        writeFileSync(join(root, path), body);
    }
    return root;
}

describe('app updates', () => {
    it('versions the same source identically and any shipped change differently', () => {
        const files = { 'app/page.tsx': 'a', 'lib/rules.ts': 'b', 'public/icon.svg': 'c', 'package-lock.json': '{}' };
        const first = sourceVersion(tree(files));
        expect(first).toMatch(/^[0-9a-f]{12}$/);
        expect(sourceVersion(tree(files))).toBe(first);
        expect(sourceVersion(tree({ ...files, 'app/page.tsx': 'a2' }))).not.toBe(first);
        expect(sourceVersion(tree({ ...files, 'public/new.png': 'd' }))).not.toBe(first);
        expect(sourceVersion(tree({ ...files, 'tests/only.ts': 'not shipped' }))).toBe(first);
    });
    it('accepts only a plain version string from the server', () => {
        expect(parseVersion({ version: 'a1b2c3d4e5f6' })).toBe('a1b2c3d4e5f6');
        for (const body of [null, 'a1b2', {}, { version: 7 }, { version: '' }, { version: '<script>' }, { version: 'x'.repeat(65) }])
            expect(parseVersion(body)).toBeNull();
    });
    it('reloads at most twice toward one version per window, then holds', () => {
        const now = 1_000_000;
        const first = nextAttempt('b', null, now);
        expect(first).toEqual({ version: 'b', at: now, count: 1 });
        const second = nextAttempt('b', first, now + 5000);
        expect(second).toEqual({ version: 'b', at: now, count: 2 });
        expect(nextAttempt('b', second, now + 6000)).toBeNull();
        expect(nextAttempt('c', second, now + 6000)).toEqual({ version: 'c', at: now + 6000, count: 1 });
        expect(nextAttempt('b', second, now + updateWindowMs)).toEqual({ version: 'b', at: now + updateWindowMs, count: 1 });
    });
    it('ignores a damaged reload record', () => {
        for (const raw of [null, '', '{', '[]', '{"version":"b"}', '{"version":"b","at":"x","count":1}']) expect(parseAttempt(raw)).toBeNull();
        expect(parseAttempt('{"version":"b","at":5,"count":1}')).toEqual({ version: 'b', at: 5, count: 1 });
    });
});
