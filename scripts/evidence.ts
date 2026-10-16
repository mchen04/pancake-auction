import { constants, type MakeDirectoryOptions, type WriteFileOptions, type TimeLike } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readFile, readdir, readlink, rm, symlink } from 'node:fs/promises';
import type { BuildOptions, build as esbuild } from 'esbuild';
import { lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repositoryDirectory = realpathSync(fileURLToPath(new URL('..', import.meta.url)));

function physicalPath(value: string): string {
    let ancestor = resolve(value);
    const missing: string[] = [];
    while (true) {
        try {
            return resolve(realpathSync(ancestor), ...missing.reverse());
        } catch (error) {
            if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
            const parent = dirname(ancestor);
            if (lstatSync(ancestor, { throwIfNoEntry: false })?.isSymbolicLink()) {
                return resolve(physicalPath(resolve(parent, readlinkSync(ancestor))), ...missing.reverse());
            }
            if (parent === ancestor) throw error;
            missing.push(basename(ancestor));
            ancestor = parent;
        }
    }
}
export function evidenceDirectory(value: string | undefined, required = false) {
    if (!value) {
        if (required) throw new Error('Set EVIDENCE_DIR outside the repository');
        return undefined;
    }
    const target = physicalPath(value);
    const path = relative(repositoryDirectory, target);
    if (!path || !isAbsolute(path) && path !== '..' && !path.startsWith('../')) {
        throw new Error('EVIDENCE_DIR must be outside the repository');
    }
    return target;
}

export function evidenceFile(value: string) {
    const target = evidenceDirectory(value, true)!;
    if (lstatSync(value, { throwIfNoEntry: false })?.isSymbolicLink()) {
        throw new Error('Evidence output must not be a symbolic link');
    }
    return target;
}

export async function makeEvidenceDirectory(value: string, options?: MakeDirectoryOptions) {
    const target = evidenceDirectory(value, true)!;
    const result = await mkdir(target, options);
    evidenceDirectory(target, true);
    return result;
}
export async function makeEvidenceTemporaryDirectory(prefix: string) {
    const target = evidenceDirectory(prefix, true)!;
    const directory = await mkdtemp(target);
    return evidenceDirectory(directory, true)!;
}
export async function openEvidenceOutput(value: string, append = false, mode: number | string = 0o600) {
    const target = evidenceFile(value);
    const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | (append ? constants.O_APPEND : 0);
    const handle = await open(target, flags, mode);
    try {
        evidenceFile(target);
        const [actual, expected] = await Promise.all([handle.stat(), lstat(target)]);
        if (actual.dev !== expected.dev || actual.ino !== expected.ino) throw new Error('Evidence target changed');
        if (!append) await handle.truncate(0);
        return handle;
    } catch (error) { await handle.close(); throw error; }
}
async function writeChecked(value: string, data: EvidenceData, options: WriteFileOptions | undefined, append: boolean) {
    const mode = typeof options === 'object' && options !== null ? options.mode : undefined;
    const handle = await openEvidenceOutput(value, append, mode);
    try { await handle.writeFile(data, options); }
    finally { await handle.close(); }
}
type EvidenceData = Parameters<Awaited<ReturnType<typeof open>>['writeFile']>[0];
export async function writeEvidenceFile(value: string, data: EvidenceData, options?: WriteFileOptions) {
    await writeChecked(value, data, options, false);
}
export async function appendEvidenceFile(value: string, data: EvidenceData, options?: WriteFileOptions) {
    await writeChecked(value, data, options, true);
}
export async function copyEvidence(source: string, destination: string, options?: { recursive?: boolean }) {
    const stat = await lstat(source);
    if (stat.isDirectory()) {
        if (!options?.recursive) throw new Error('Recursive evidence copy requires recursive: true');
        const target = evidenceDirectory(destination, true)!;
        await makeEvidenceDirectory(target, { recursive: true });
        for (const name of await readdir(source)) await copyEvidence(`${source}/${name}`, `${target}/${name}`, options);
    } else {
        const target = evidenceFile(destination);
        await makeEvidenceDirectory(dirname(target), { recursive: true });
        if (stat.isSymbolicLink()) await symlink(await readlink(source), target);
        else await writeEvidenceFile(target, await readFile(source), { mode: stat.mode });
    }
}
export async function bundleEvidence(build: typeof esbuild, options: BuildOptions) {
    if (!options.outfile) throw new Error('Set an evidence bundle output file');
    const outfile = evidenceFile(options.outfile);
    const result = await build({ ...options, outfile, write: false });
    for (const output of result.outputFiles ?? []) await writeEvidenceFile(output.path, output.contents);
    return result;
}
export async function captureEvidence<T>(value: string, produce: (temporary: string) => Promise<T>) {
    const target = evidenceFile(value);
    const directory = await makeEvidenceTemporaryDirectory(`${dirname(target)}/capture-`);
    try {
        const temporary = `${directory}/${basename(target)}`;
        const result = await produce(temporary);
        await writeEvidenceFile(target, await readFile(temporary));
        return result;
    } finally { await rm(directory, { recursive: true, force: true }); }
}

export async function setEvidenceTimes(value: string, atime: TimeLike, mtime: TimeLike) {
    const target = evidenceFile(value);
    const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        evidenceFile(target);
        const [actual, expected] = await Promise.all([handle.stat(), lstat(target)]);
        if (actual.dev !== expected.dev || actual.ino !== expected.ino) throw new Error('Evidence target changed');
        await handle.utimes(atime, mtime);
    } finally { await handle.close(); }
}
