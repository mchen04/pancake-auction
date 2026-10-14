import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadEnvironment, safeError } from "./env";
async function main() {
    loadEnvironment();
    const root = process.env.EVIDENCE_DIR;
    if (!root || resolve(root).startsWith(resolve(".") + "/")) {
        throw new Error("Set EVIDENCE_DIR outside the repository");
    }
    const dir = `${root}/verify-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    await mkdir(dir, {
        recursive: true
    });
    const commands = [
        ["typecheck"],
        ["lint"],
        ["test"],
        ["test:db"],
        ["build"],
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
    console.log(`All checks passed. Results: ${dir}/results.json`);
}
main().catch(error => {
    console.error(safeError(error));
    process.exitCode = 1;
});
