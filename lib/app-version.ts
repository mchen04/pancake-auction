import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Everything that shapes the shipped app. The same source always yields the same version.
export const versionedPaths = ['app', 'lib', 'public', 'convex/_generated', 'next.config.ts', 'package-lock.json'];

export function sourceVersion(root: string, paths = versionedPaths) {
    const hash = createHash('sha256');
    const add = (path: string) => {
        const full = join(root, path);
        if (statSync(full).isDirectory()) for (const name of readdirSync(full).sort()) add(join(path, name));
        else hash.update(`${path}\0`).update(readFileSync(full));
    };
    for (const path of paths) if (existsSync(join(root, path))) add(path);
    return hash.digest('hex').slice(0, 12);
}
