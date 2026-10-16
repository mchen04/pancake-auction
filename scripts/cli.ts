import { spawn } from 'node:child_process';
import { runAdmin } from './admin-client';
import { checkLeague } from './readiness';
import { safeError } from './env';
import { evidenceDirectory, repositoryDirectory } from './evidence';
async function main() {
    evidenceDirectory(process.env.EVIDENCE_DIR);
    const [command, ...args] = process.argv.slice(2);
    if (command === 'managers') console.log(JSON.stringify(await runAdmin('admin:managers')));
    else if (command === 'release') {
        const index = args.indexOf('--name');
        if (index < 0 || !args[index + 1]) throw new Error('Provide --name');
        console.log(JSON.stringify(await runAdmin('admin:release', { name: args[index + 1] })));
    } else if (command === 'check') {
        const result = await checkLeague();
        console.log(JSON.stringify(result, null, 2));
        if (!result.ready) process.exitCode = 1;
    } else if (command === 'dev' || command === 'start') {
        const child = spawn(process.execPath, [`${repositoryDirectory}/node_modules/next/dist/bin/next`, command, ...args],
            { cwd: repositoryDirectory, stdio: 'inherit', env: process.env });
        process.once('SIGTERM', () => child.kill('SIGTERM'));
        process.once('SIGINT', () => child.kill('SIGINT'));
        process.exitCode = await new Promise<number>(resolve => child.once('exit', code => resolve(code ?? 1)));
    } else throw new Error('Unknown command');
}
main().catch(error => { console.error(safeError(error)); process.exitCode = 1; });
