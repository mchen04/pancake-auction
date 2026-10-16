import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { evidenceDirectory, makeEvidenceDirectory, writeEvidenceFile, repositoryDirectory } from './evidence';

export async function runAdmin(name: string, args: Record<string, unknown> = {}) {
    const directory = resolve(repositoryDirectory, process.env.CONVEX_LOCAL_DIR || '.convex/local/default');
    const configuration = JSON.parse(await readFile(`${directory}/config.json`, 'utf8'));
    const url = `http://127.0.0.1:${configuration.ports.cloud}`;
    evidenceDirectory(process.env.EVIDENCE_DIR);
    const configurationPath = relative(repositoryDirectory, directory);
    const inProject = configurationPath === '.convex' || configurationPath.startsWith('.convex/');
    const privateDirectory = inProject ? `${directory}/cli` : evidenceDirectory(`${directory}/cli`, true)!;
    await (inProject ? mkdir : makeEvidenceDirectory)(privateDirectory, { recursive: true });
    const path = `${privateDirectory}/args-${crypto.randomUUID()}.json`;
    await (inProject ? writeFile : writeEvidenceFile)(path, JSON.stringify(args));
    try {
        const child = spawn(process.execPath, ['--import', resolve(repositoryDirectory, 'scripts/local-cli.mjs'),
            resolve(repositoryDirectory, 'node_modules/convex/bin/main.js'), 'run', '--url', url, '--admin-key', configuration.adminKey, name],
        { env: { PATH: process.env.PATH, NODE_ENV: 'test', AUCTION_CLI_HOME: privateDirectory,
            AUCTION_ARGS_FILE: path, CONVEX_AGENT_MODE: 'anonymous', CONVEX_DISABLE_TELEMETRY: '1' },
            stdio: ['ignore', 'pipe', 'pipe'] });
        let output = '';
        let error = '';
        child.stdout.on('data', data => { output += String(data); });
        child.stderr.on('data', data => { error += String(data); });
        const code = await new Promise(resolve => child.once('exit', resolve));
        if (code !== 0) throw new Error(error.replaceAll(configuration.adminKey, '[local key]'));
        return output.trim() ? JSON.parse(output) : null;
    } finally {
        await rm(path, { force: true });
    }
}
