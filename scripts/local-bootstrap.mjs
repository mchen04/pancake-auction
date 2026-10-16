import { constants } from 'node:fs';
import { access, chmod, copyFile, lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { repositoryDirectory, makeEvidenceDirectory, makeEvidenceTemporaryDirectory,
    writeEvidenceFile } from './evidence.ts';

const execute = promisify(execFile);
export async function preparePinnedDeployment(version) {
    if (!/^[a-zA-Z0-9._-]+$/.test(version)) throw new Error('Invalid pinned backend version');
    const project = process.cwd();
    const localRuntime = project === repositoryDirectory;
    const state = resolve(project, '.convex/local/default');
    const configuration = `${state}/config.json`;
    if (await access(configuration).then(() => true, () => false)) return;
    const cache = resolve(process.env.AUCTION_CLI_HOME, '.cache/convex/binaries', version);
    const binary = `${cache}/convex-local-backend`;
    if (!await access(binary, constants.X_OK).then(() => true, () => false)) {
        const platforms = { darwin: 'apple-darwin', linux: 'unknown-linux-gnu' };
        const arches = { arm64: 'aarch64', x64: 'x86_64' };
        const target = `${arches[process.arch]}-${platforms[process.platform]}`;
        const createTemporary = localRuntime ? mkdtemp : makeEvidenceTemporaryDirectory;
        const temporary = await createTemporary(`${process.env.AUCTION_CLI_HOME}/download-`);
        try {
            if (!platforms[process.platform] || !arches[process.arch]) throw new Error('Unsupported local platform');
            const archive = `convex-local-backend-${target}.zip`;
            const response = await fetch(`https://github.com/get-convex/convex-backend/releases/download/${version}/${archive}`,
                { signal: AbortSignal.timeout(30000) });
            if (!response.ok) throw new Error(`Binary download returned ${response.status}`);
            const writeArchive = localRuntime ? writeFile : writeEvidenceFile;
            await writeArchive(`${temporary}/backend.zip`, new Uint8Array(await response.arrayBuffer()));
            await execute('/usr/bin/unzip', ['-q', `${temporary}/backend.zip`, 'convex-local-backend', '-d', temporary]);
            await mkdir(cache, { recursive: true });
            await copyFile(`${temporary}/convex-local-backend`, binary, constants.COPYFILE_EXCL);
            await chmod(binary, 0o700);
        } catch {
            throw new Error(`Pinned Convex backend ${version} is not cached and cannot be downloaded.`);
        } finally { await rm(temporary, { recursive: true, force: true }); }
    }
    if (!(await lstat(binary)).isFile()) throw new Error('Pinned backend cache must contain a regular binary');
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
