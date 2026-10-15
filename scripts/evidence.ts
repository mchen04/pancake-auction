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
