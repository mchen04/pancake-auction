import os from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';

if (!process.env.AUCTION_CLI_HOME) throw new Error('A private CLI directory is required');
const directory = resolve(process.env.AUCTION_CLI_HOME);
os.homedir = () => directory;
syncBuiltinESMExports();
if (process.env.AUCTION_ARGS_FILE) process.argv.push(readFileSync(process.env.AUCTION_ARGS_FILE, 'utf8'));

const versionOption = process.argv.indexOf('--local-backend-version');
if (process.argv.includes('dev') && versionOption >= 0) {
    const { preparePinnedDeployment } = await import('./local-bootstrap.mjs');
    await preparePinnedDeployment(process.argv[versionOption + 1]);
}
