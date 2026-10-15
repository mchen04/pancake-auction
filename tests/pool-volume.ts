import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { ConvexClient } from 'convex/browser';
import { api } from '../convex/_generated/api';
import recorded from './fixtures/sleeper-pool.json';
import type { Player } from '../lib/types';
import { safeError } from '../scripts/env';
import { createIsolated, dropIsolated, seedManagers, seedPlayers, claimSeat, getState, act, currentBackend, sleep } from './support';
async function main() {
    const isolated = await createIsolated('test');
    const poolFrames: { frameBytes: number; resultBytes: number; players: number }[] = [];
    class MeasuredSocket extends WebSocket {
        constructor(url: string | URL, protocols?: string | string[]) {
            super(url, protocols);
            this.addEventListener('message', event => {
                if (typeof event.data !== 'string') return;
                const frame = JSON.parse(event.data) as { type: string; modifications?: {
                    type: string; value?: { revision?: string; players?: unknown[] } }[] };
                if (frame.type !== 'Transition') return;
                for (const update of frame.modifications ?? []) {
                    if (update.type === 'QueryUpdated' && update.value?.revision && update.value.players?.length) {
                        poolFrames.push({ frameBytes: Buffer.byteLength(event.data),
                            resultBytes: Buffer.byteLength(JSON.stringify(update.value)),
                            players: update.value.players.length });
                    }
                }
            });
        }
    }
    const client = new ConvexClient(currentBackend().url, { webSocketConstructor: MeasuredSocket });
    const deliveries: { kind: string; bytes: number; status?: string }[] = [];
    const subscriptions: (() => void)[] = [];
    try {
        await seedManagers();
        await seedPlayers(recorded.players as Player[]);
        const token = await claimSeat(1);
        const initial = await getState(token);
        subscriptions.push(client.onUpdate(api.auction.pool, { revision: initial.poolRevision }, pool => {
            deliveries.push({ kind: 'pool', bytes: Buffer.byteLength(JSON.stringify(pool)) });
        }));
        subscriptions.push(client.onUpdate(api.auction.state, { token }, state => {
            assert.equal(state.players.length, 0);
            deliveries.push({ kind: 'state', bytes: Buffer.byteLength(JSON.stringify(state)), status: state.draft.status });
        }));
        await sleep(100);
        for (let id = 2; id <= 10; id++) await claimSeat(id);
        await sleep(100);
        const setup = deliveries.filter(item => item.kind === 'state' && item.status === 'setup');
        assert(setup.length >= 2);
        assert.equal(deliveries.filter(item => item.kind === 'pool').length, 1);
        assert.equal(poolFrames.length, 1, 'The wire must carry the pool only once');
        await act({ type: 'start' }, token);
        await act({ type: 'pause' }, token);
        await act({ type: 'resume' }, token);
        await sleep(100);
        assert.equal(deliveries.filter(item => item.kind === 'pool').length, 1);
        assert.equal(poolFrames.length, 1, 'Draft changes must not resend the pool on the wire');
        assert(deliveries.some(item => item.kind === 'state' && item.status === 'running'));
        assert(deliveries.filter(item => item.kind === 'state').every(item => item.bytes < 10000));
        const root = process.env.EVIDENCE_DIR!;
        await mkdir(root, { recursive: true });
        await writeFile(`${root}/pool-volume.json`, JSON.stringify({ players: initial.players.length,
            poolDeliveries: deliveries.filter(item => item.kind === 'pool').length,
            poolFrames, deliveries }, null, 2));
        console.log('PASS setup and running subscriptions deliver the pool once across draft changes');
    } finally {
        subscriptions.forEach(stop => stop());
        await client.close();
        await dropIsolated(isolated);
    }
}
main().catch(error => { console.error(safeError(error)); process.exitCode = 1; });
