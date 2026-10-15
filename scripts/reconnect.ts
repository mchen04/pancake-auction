import { AuctionClient } from '../lib/client';
async function main() {
    const parts: Buffer[] = [];
    for await (const part of process.stdin) parts.push(Buffer.from(part));
    const data = JSON.parse(Buffer.concat(parts).toString());
    const client = new AuctionClient(data.base);
    await client.restore(data.token);
    console.log(JSON.stringify({ me: (await client.state(data.token)).me }));
}
main().catch(() => { process.exitCode = 1; });
