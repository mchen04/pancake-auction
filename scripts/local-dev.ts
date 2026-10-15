import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
async function main() {
    const directory = resolve('.convex/cli-home');
    await mkdir(directory, { recursive: true });
    const selection = resolve('.convex/local-only.env');
    await writeFile(selection, '');
    const child = spawn(process.execPath, ['--import', resolve('scripts/local-cli.mjs'),
        resolve('node_modules/convex/bin/main.js'), 'dev', '--env-file', selection,
        '--typecheck', 'disable', '--codegen', 'disable'],
    { env: { PATH: process.env.PATH, NODE_ENV: 'development', AUCTION_CLI_HOME: directory,
        CONVEX_AGENT_MODE: 'anonymous', CONVEX_DISABLE_TELEMETRY: '1' }, stdio: 'inherit' });
    process.once('SIGTERM', () => child.kill('SIGTERM'));
    process.once('SIGINT', () => child.kill('SIGINT'));
    process.exitCode = await new Promise<number>(resolve => child.once('exit', code => resolve(code ?? 1)));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
