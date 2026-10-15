import { isAbsolute, relative, resolve } from 'node:path';

export function evidenceDirectory(value: string | undefined, required = false, repository = process.cwd()) {
    if (!value) {
        if (required) throw new Error('Set EVIDENCE_DIR outside the repository');
        return undefined;
    }
    const target = resolve(value);
    const path = relative(resolve(repository), target);
    if (!path || !isAbsolute(path) && path !== '..' && !path.startsWith('../')) {
        throw new Error('EVIDENCE_DIR must be outside the repository');
    }
    return target;
}
