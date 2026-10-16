import { readFile, writeFile } from "node:fs/promises";
async function main() {
    const path = "next-env.d.ts";
    const data = await readFile(path, "utf8");
    await writeFile(path, data.split("\n").filter(line => !line.startsWith("// NOTE:") && !line.startsWith(
        "// see https://nextjs.org/")).join("\n"));
}
main().catch(() => {
    process.exitCode = 1;
});
