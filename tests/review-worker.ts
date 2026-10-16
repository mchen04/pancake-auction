import { AuctionClient } from '../lib/client';
async function main() {
    const parts: Buffer[] = [];
    for await (const part of process.stdin) parts.push(Buffer.from(part));
    const request = JSON.parse(Buffer.concat(parts).toString());
    const client = new AuctionClient(request.url);
    if (request.mode === 'start') await client.act({ type: 'start' }, request.token);
    const state = await client.state();
    console.log(JSON.stringify({ phase: state.draft.phase, playerId: state.lot?.playerId }));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
