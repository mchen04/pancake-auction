import { constants } from 'node:fs';
import { access, chmod, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { repositoryDirectory, makeEvidenceDirectory, writeEvidenceFile } from './evidence.ts';

const execute = promisify(execFile);
async function generatesKey(binary) {
    const result = await execute(binary, ['keygen', 'admin-key', '--instance-name', 'anonymous-validation',
        '--instance-secret', '0'.repeat(64)], { timeout: 5000 });
    return Boolean(result.stdout.trim());
}
async function validBinary(binary) {
    try {
        const stat = await lstat(binary);
        if (!stat.isFile() || stat.size < 1024) return false;
        await access(binary, constants.X_OK);
        return await generatesKey(binary);
    } catch { return false; }
}
async function removeAbandonedDownloads(cache) {
    for (const name of await readdir(cache)) {
        if (!name.startsWith('download-')) continue;
        const path = `${cache}/${name}`;
        const stat = await lstat(path);
        if (!stat.isDirectory()) continue;
        const owner = await readFile(`${path}/owner.json`, 'utf8').then(JSON.parse).catch(() => null);
        let abandoned = !owner && Date.now() - stat.mtimeMs >= 24 * 60 * 60 * 1000;
        if (owner?.host === hostname() && Number.isInteger(owner.pid) && owner.pid > 0) {
            try {
                process.kill(owner.pid, 0);
                const current = await execute('ps', ['-p', String(owner.pid), '-o', 'lstart=']).catch(() => null);
                abandoned = Boolean(owner.processStart && current && current.stdout.trim() !== owner.processStart);
            } catch (error) { abandoned = error.code === 'ESRCH'; }
        }
        if (abandoned) await rm(path, { recursive: true, force: true });
    }
}
export async function preparePinnedDeployment(version) {
    if (!/^[a-zA-Z0-9._-]+$/.test(version)) throw new Error('Invalid pinned backend version');
    const project = process.cwd();
    const localRuntime = project === repositoryDirectory;
    const state = resolve(project, '.convex/local/default');
    const configuration = `${state}/config.json`;
    const cache = resolve(process.env.AUCTION_CLI_HOME, '.cache/convex/binaries', version);
    const binary = `${cache}/convex-local-backend`;
    await mkdir(cache, { recursive: true });
    await removeAbandonedDownloads(cache);
    if (!await validBinary(binary)) {
        await rm(binary, { force: true });
        const platforms = { darwin: 'apple-darwin', linux: 'unknown-linux-gnu' };
        const arches = { arm64: 'aarch64', x64: 'x86_64' };
        const target = `${arches[process.arch]}-${platforms[process.platform]}`;
        const temporary = await mkdtemp(`${cache}/download-`);
        try {
            await writeFile(`${temporary}/owner.json`, JSON.stringify({ host: hostname(), pid: process.pid,
                processStart: (await execute('ps', ['-p', String(process.pid), '-o', 'lstart='])).stdout.trim() }),
            { flag: 'wx' });
            if (!platforms[process.platform] || !arches[process.arch]) throw new Error('Unsupported local platform');
            const archive = `convex-local-backend-${target}.zip`;
            const response = await fetch(`https://github.com/get-convex/convex-backend/releases/download/${version}/${archive}`,
                { signal: AbortSignal.timeout(30000) });
            if (!response.ok) throw new Error(`Binary download returned ${response.status}`);
            await writeFile(`${temporary}/backend.zip`, new Uint8Array(await response.arrayBuffer()));
            await execute('/usr/bin/unzip', ['-q', `${temporary}/backend.zip`, 'convex-local-backend', '-d', temporary]);
            const extracted = `${temporary}/convex-local-backend`;
            await chmod(extracted, 0o700);
            if (!await validBinary(extracted)) throw new Error('Downloaded backend failed validation');
            await rename(extracted, binary);
        } catch {
            throw new Error(`Pinned Convex backend ${version} is not cached and cannot be downloaded.`);
        } finally { await rm(temporary, { recursive: true, force: true }); }
    }
    if (await access(configuration).then(() => true, () => false)) return;
    const deploymentName = `anonymous-${randomUUID().replaceAll('-', '')}`;
    const instanceSecret = randomBytes(32).toString('hex');
    let adminKey;
    try {
        const result = await execute(binary, ['keygen', 'admin-key', '--instance-name', deploymentName,
            '--instance-secret', instanceSecret]);
        adminKey = result.stdout.trim();
        if (!adminKey) throw new Error('Empty generated key');
    } catch { throw new Error(`Pinned Convex backend ${version} cannot generate local credentials.`); }
    const port = name => Number(process.argv[process.argv.indexOf(name) + 1]);
    const value = { deploymentName, backendVersion: version, instanceSecret, adminKey,
        ports: { cloud: port('--local-cloud-port'), site: port('--local-site-port') } };
    if (localRuntime) {
        await mkdir(state, { recursive: true });
        await writeFile(configuration, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
    } else {
        await makeEvidenceDirectory(state, { recursive: true });
        await writeEvidenceFile(configuration, JSON.stringify(value));
    }
}
