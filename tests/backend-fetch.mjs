import dns from 'node:dns';
import { isIP } from 'node:net';
import { syncBuiltinESMExports } from 'node:module';
import { appendEvidenceFile, evidenceDirectory } from '../scripts/evidence.ts';
import { lstat, unlink, symlink } from 'node:fs/promises';
import { resolve } from 'node:path';

if (process.env.AUCTION_EMPTY_CACHE) {
    const parent = evidenceDirectory(resolve(process.env.AUCTION_CLI_HOME, '.cache'), true);
    const path = `${parent}/convex`;
    const target = evidenceDirectory(process.env.AUCTION_EMPTY_CACHE, true);
    if (!(await lstat(path)).isSymbolicLink()) throw new Error('Expected an owned cache link');
    await unlink(path);
    await symlink(target, path, 'dir');
}
const lookup = dns.lookup;
dns.lookup = function(hostname, options, callback) {
    if (hostname === 'localhost' || isIP(hostname)) return lookup(hostname, options, callback);
    const done = typeof options === 'function' ? options : callback;
    void appendEvidenceFile(process.env.AUCTION_NETWORK_LOG, JSON.stringify({ hostname,
        kind: 'dns', blocked: true }) + '\n')
        .then(() => done(Object.assign(new Error('Test DNS: host unreachable'), { code: 'ENOTFOUND' })));
};
syncBuiltinESMExports();

const fetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.hostname === 'version.convex.dev') {
        await appendEvidenceFile(process.env.AUCTION_NETWORK_LOG, JSON.stringify({ hostname: url.hostname,
            path: url.pathname, kind: url.pathname === '/v1/local_backend_version' ? 'backend-version' : 'metadata' }) + '\n');
    }
    return fetch(input, init);
};
