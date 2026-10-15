import { evidenceDirectory } from "./evidence";
import { spawn } from "node:child_process";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { loadEnvironment, safeError } from "./env";
import { recordSpread } from "./simulation-results";
async function main() {
    const started = Date.now();
    loadEnvironment();
    const root = evidenceDirectory(process.env.EVIDENCE_DIR, true)!;
    const dir = `${root}/verify-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    await mkdir(dir, {
        recursive: true
    });
    const commands = [
        ["typecheck"],
        ["lint"],
        ["test"],
        ["test:db"],
        ["test:ui"],
        ["test:volume"],
        ["build"],
        ["test:layout"],
        ["test:room"],
        [
            "sim",
            "--",
            "--runs",
            "3",
            "--timing",
            "fast",
            "--seed",
            "1042",
            "--skip-build"
        ],
        [
            "sim",
            "--",
            "--runs",
            "1",
            "--timing",
            "real",
            "--seed",
            "2042",
            "--skip-build"
        ]
    ];
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
    const summaries = (await readdir(`${dir}/sim`)).filter(file => /^run-.*\.json$/.test(file));
    const spread = await recordSpread(summaries.map(file => `${dir}/sim/${file}`), true);
    await writeFile(`${dir}/seed-spread.json`, JSON.stringify(spread, null, 2));
    await writeFile(`${dir}/duration.json`, JSON.stringify({ elapsedMs: Date.now() - started }, null, 2));
    console.log(`All checks passed. Results: ${dir}/results.json`);
}
main().catch(error => {
    console.error(safeError(error));
    process.exitCode = 1;
});
