import { makeEvidenceDirectory as mkdir, writeEvidenceFile as writeFile } from './evidence';
import { evidenceDirectory, repositoryDirectory } from "./evidence";
import { spawn } from "node:child_process";
import { statfs } from 'node:fs/promises';
import { safeError } from "./env";
async function main() {
    const started = Date.now();
    const root = evidenceDirectory(process.env.EVIDENCE_DIR, true)!;
    process.chdir(repositoryDirectory);
    const dir = `${root}/verify-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    await mkdir(dir, {
        recursive: true
    });
    const disk = await statfs(dir);
    const freeBytes = disk.bavail * disk.bsize;
    if (freeBytes < 1024 ** 3) {
        throw new Error(`Local verification needs 1 GiB of free disk; available ${freeBytes} bytes`);
    }
    const commands = [['typecheck'], ['lint'], ['test'], ['test:local'], ['test:db'],
        ['test:volume'], ['build'], ['test:layout'], ['test:ui'], ['test:seats'], ['test:room']];
    const results: {
        command: string;
        exitCode: number;
        path: string;
    }[] = [];
    for (const [index, args] of commands.entries()) {
        console.log(`Running npm run ${args.join(" ")}`);
        let output = "";
        const child = spawn("npm", ["run", ...args], {
            env: {
                ...process.env,
                EVIDENCE_DIR: dir
            },
            stdio: ["ignore", "pipe", "pipe"]
        });
        child.stdout.on("data", d => {
            output += String(d);
            process.stdout.write(d);
        });
        child.stderr.on("data", d => {
            output += String(d);
            process.stderr.write(d);
        });
        const exitCode = await new Promise<number>(resolve => child.on("exit", code => resolve(code ?? 1)));
        const path = `${dir}/${index + 1}-${args[0]}.log`;
        await writeFile(path, output);
        results.push({
            command: `npm run ${args.join(" ")}`,
            exitCode,
            path
        });
        await writeFile(`${dir}/results.json`, JSON.stringify(results, null, 2));
        if (exitCode !== 0) {
            throw new Error(`Verification failed; see ${path}`);
        }
    }
    await writeFile(`${dir}/duration.json`, JSON.stringify({ elapsedMs: Date.now() - started }, null, 2));
    console.log(`All checks passed. Results: ${dir}/results.json`);
}
main().catch(error => {
    console.error(safeError(error));
    process.exitCode = 1;
});
