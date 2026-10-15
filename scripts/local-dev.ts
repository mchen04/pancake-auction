import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { requireClosedPort } from './local-backend';
import { localPorts } from './local-ports';
async function main() {
    const ports = localPorts(process.env);
    const directory = resolve('.convex/cli-home');
    await mkdir(directory, { recursive: true });
    const temporary = resolve('.convex/tmp');
    await mkdir(temporary, { recursive: true });
    const child = spawn(process.execPath, ['--import', resolve('scripts/local-cli.mjs'),
        resolve('node_modules/convex/bin/main.js'), 'dev', '--local-cloud-port', String(ports.cloud),
        '--local-site-port', String(ports.site), '--typecheck', 'disable', '--codegen', 'disable'],
    { env: { PATH: process.env.PATH, NODE_ENV: 'development', AUCTION_CLI_HOME: directory,
        CONVEX_AGENT_MODE: 'anonymous', CONVEX_DISABLE_TELEMETRY: '1', TMPDIR: temporary }, stdio: 'inherit' });
    process.once('SIGTERM', () => child.kill('SIGINT'));
    process.once('SIGINT', () => child.kill('SIGINT'));
    process.exitCode = await new Promise<number>(resolve => child.once('exit', (code, signal) =>
        resolve(code ?? (signal === 'SIGINT' ? 0 : 1))));
    await Promise.all([requireClosedPort(ports.cloud), requireClosedPort(ports.site)]);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
