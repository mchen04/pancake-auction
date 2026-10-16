import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';

const execute = promisify(execFile);
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
type Owner = { host: string; pid: number; processStart?: string; startedAt?: number; token?: string };
type Options = { waitMs?: number; graceMs?: number; pollMs?: number };
async function snapshot(path: string) {
    const stat = await lstat(path).catch(error => {
        if (error.code !== 'ENOENT') throw error;
        return null;
    });
    if (!stat) return null;
    const text = await readFile(`${path}/owner.json`, 'utf8').catch(error => {
        if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
        return '';
    });
    let owner: Owner | null = null;
    try {
        const value = JSON.parse(text);
        if (typeof value.host === 'string' && Number.isInteger(value.pid) && value.pid > 0) owner = value;
    } catch {}
    const identity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}:${text}`;
    return { identity, stamp: `${identity}:${stat.mtimeMs}:${stat.ctimeMs}`, owner };
}
async function gone(owner: Owner) {
    if (owner.host !== hostname()) return false;
    try { process.kill(owner.pid, 0); }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
    const current = await execute('ps', ['-p', String(owner.pid), '-o', 'lstart=']).catch(() => null);
    return Boolean(owner.processStart) && current !== null && current.stdout.trim() !== owner.processStart;
}
function retirementMutex(path: string) {
    let database: DatabaseSync | undefined;
    try {
        database = new DatabaseSync(path);
        database.exec('BEGIN EXCLUSIVE');
    } catch (error) {
        database?.close();
        if (error && typeof error === 'object' && 'errcode' in error && [5, 6].includes(Number(error.errcode))) return;
        throw error;
    }
    return () => {
        try { database.exec('ROLLBACK'); }
        finally { database.close(); }
    };
}
async function sweepPreparation(cache: string) {
    for (const name of await readdir(cache)) {
        if (!['prepare.lock.candidate-', 'prepare.lock.retired-'].some(prefix => name.startsWith(prefix))) continue;
        const path = `${cache}/${name}`;
        const stat = await lstat(path).catch(() => null);
        if (!stat?.isDirectory() || Date.now() - stat.mtimeMs < 24 * 60 * 60 * 1000) continue;
        const previous = await snapshot(path);
        if (!previous || previous.owner && !await gone(previous.owner)) continue;
        if ((await snapshot(path))?.stamp === previous.stamp) await rm(path, { recursive: true, force: true });
    }
}
export async function preparationLock(cache: string, options: Options = {}) {
    const path = `${cache}/prepare.lock`;
    const owner: Owner = { host: hostname(), pid: process.pid, startedAt: Date.now(), token: randomUUID(),
        processStart: (await execute('ps', ['-p', String(process.pid), '-o', 'lstart='])).stdout.trim() };
    const candidate = `${path}.candidate-${owner.token}`;
    const deadline = performance.now() + (options.waitMs ?? 60000);
    const graceMs = options.graceMs ?? 1000;
    let observed: { stamp: string; since: number } | undefined;
    await mkdir(candidate);
    try {
        await writeFile(`${candidate}/owner.json`, JSON.stringify(owner), { flag: 'wx' });
        for (;;) {
            const previous = await snapshot(path);
            if (performance.now() >= deadline) {
                throw new Error(`Local Convex binary preparation is still owned: ${JSON.stringify(previous?.owner)}`);
            }
            if (!previous) {
                let acquired = false;
                try { await rename(candidate, path); acquired = true; }
                catch (error) {
                    if (!['EEXIST', 'ENOTEMPTY', 'ENOENT'].includes((error as NodeJS.ErrnoException).code!)) throw error;
                }
                if (acquired) {
                    const release = async () => {
                        if ((await snapshot(path))?.owner?.token === owner.token) {
                            await rm(path, { recursive: true, force: true });
                        }
                    };
                    try { await sweepPreparation(cache); }
                    catch (error) { await release(); throw error; }
                    return release;
                }
            } else {
                if (observed?.stamp !== previous.stamp) observed = { stamp: previous.stamp, since: performance.now() };
                const abandoned = previous.owner ? await gone(previous.owner)
                    : performance.now() - observed.since >= graceMs;
                if (abandoned) {
                    const retired = `${path}.retired-${createHash('sha256').update(previous.identity).digest('hex')}`;
                    const unlock = retirementMutex(`${cache}/retirement.sqlite`);
                    if (unlock) {
                        let moved = false;
                        try {
                            if ((await snapshot(path))?.stamp === previous.stamp) {
                                await writeFile(`${path}/.retirement`, '', { flag: 'wx' }).catch(error => {
                                    if (error.code !== 'EEXIST') throw error;
                                });
                                if ((await snapshot(path))?.identity === previous.identity) {
                                    await rename(path, retired);
                                    moved = true;
                                }
                            }
                        } catch (error) {
                            if (!['ENOENT', 'EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code!)) throw error;
                        } finally {
                            try { if (moved) await rm(retired, { recursive: true, force: true }); }
                            finally { unlock(); }
                        }
                    }
                }
            }
            await pause(Math.min(options.pollMs ?? 100, Math.max(0, deadline - performance.now())));
        }
    } finally { await rm(candidate, { recursive: true, force: true }); }
}
