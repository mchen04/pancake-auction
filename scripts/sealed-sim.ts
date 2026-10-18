import assert from 'node:assert/strict';
import { AuctionClient } from '../lib/client';
import { legalMaximum } from '../lib/sealed';
import { localBackend } from './local-backend';
import { recordedPool } from './pool-source';
import { seededFraction } from './strategy';
import { Bot } from './bot';
import { auditSealed } from './sealed-audit';
import { evidenceDirectory, makeEvidenceDirectory, writeEvidenceFile } from './evidence';

function option(name: string, fallback: string) {
    const index = process.argv.indexOf(name);
    return index < 0 ? fallback : process.argv[index + 1];
}
export async function runSealedSim() {
    const runs = Number(option('--runs', '1'));
    const seed = Number(option('--seed', '42'));
    assert(Number.isInteger(runs) && runs > 0 && Number.isFinite(seed));
    const root = `${evidenceDirectory(process.env.EVIDENCE_DIR, true)}/sim-blind`;
    await makeEvidenceDirectory(root, { recursive: true });
    const source = recordedPool();
    for (let run = 1; run <= runs; run++) {
        const runSeed = seed + run - 1;
        const backend = await localBackend(`blind-${runSeed}`, true);
        const clients = Array.from({ length: 10 }, () => new AuctionClient(backend.url));
        const client = clients[0];
        const result: Record<string, unknown> = { mode: 'sealed-v1', seed: runSeed, run, source: source.source };
        const started = Date.now();
        async function expire() {
            const snapshot = await backend.admin('testOnly:deadlineSnapshot');
            assert.equal(typeof snapshot.deadline, 'number');
            await backend.admin('testOnly:simulatedExpiry', { snapshot, now: snapshot.deadline });
        }
        try {
            await backend.admin('admin:managers');
            await backend.admin('admin:importPlayers', { players: source.players, ...source.importMetadata, startedAt: Date.now() });
            const tokens = await Promise.all(clients.map((device, i) => device.claim(i + 1)));
            assert.equal((await client.state()).draft.mode, 'sealed-v1');
            const second = new AuctionClient(backend.url);
            assert.equal(await second.claim(1), tokens[0]);
            await client.act({ type: 'start' }, tokens[0]);
            await expire();
            let state = await client.state();
            assert(state.lot, 'Nomination timeout must open a lot');
            await expire();
            assert((await client.state()).sales.some(lot => lot.status === 'unsold'));
            let turn = 0;
            let reconnected = false;
            let sameSeatResponse = false;
            while ((state = await client.state()).draft.status !== 'complete') {
                assert(turn++ < 800, 'Blind simulation must finish');
                assert(Date.now() - started < 30 * 60 * 1000, 'Blind simulation exceeded thirty minutes');
                if (!state.lot) {
                    const manager = state.managers.find(manager => manager.id === state.draft.nominatorId)!;
                    const candidates = state.players.filter(player => !state.roster.some(row => row.playerId === player.id)
                        && legalMaximum(state, manager, player) >= 1);
                    assert(candidates.length);
                    const player = candidates[Math.floor(seededFraction(runSeed, `nomination:${turn}`) * candidates.length)];
                    if (turn % 17 === 0) await expire();
                    else if (turn % 3 === 1) await clients[manager.id - 1].queue({ type: 'add', playerId: player.id }, tokens[manager.id - 1]);
                    else await clients[manager.id - 1].act({ type: 'nominate', playerId: player.id,
                        nominationGeneration: state.draft.nominationGeneration }, tokens[manager.id - 1]);
                    state = await client.state();
                }
                const lot = state.lot!;
                assert(lot && lot.highBid === 0 && lot.highBidderId === 0);
                const player = state.players.find(player => player.id === lot.playerId)!;
                const eligible = state.managers.filter(manager => !lot.respondedIds?.includes(manager.id));
                const tie = turn === 1 || turn % 7 === 0;
                const timed = turn % 13 === 0;
                const responders = timed && eligible.length > 1 ? eligible.slice(0, -1) : eligible;
                const responses = responders.map(manager => ({ manager,
                    amount: tie ? 1 : Math.min(legalMaximum(state, manager, player),
                        1 + Math.floor(seededFraction(runSeed, `bid:${turn}:${manager.id}`) * 70)) }));
                await Promise.all(responses.map(async ({ manager, amount }) => {
                    const action = { type: 'bid' as const, lotId: lot.id, amount };
                    if (manager.id === 1 && !sameSeatResponse) {
                        const race = await Promise.allSettled([clients[0].act(action, tokens[0]), second.act(action, tokens[0])]);
                        assert.equal(race.filter(result => result.status === 'fulfilled').length, 1);
                        sameSeatResponse = true;
                    } else await clients[manager.id - 1].act(action, tokens[manager.id - 1]);
                }));
                if (timed && (await client.state()).lot?.id === lot.id) await expire();
                assert.notEqual((await client.state()).lot?.id, lot.id);
                if (!reconnected && turn >= 3) {
                    const device = new Bot(1, backend.url);
                    device.token = tokens[0];
                    await device.reconnect();
                    await device.close();
                    reconnected = true;
                }
            }
            assert(reconnected && sameSeatResponse);
            const inspected = await backend.admin('admin:inspect');
            result.audit = auditSealed(state, inspected.events, inspected.lots);
            result.reconnects = 1;
            result.sameSeatDevices = 2;
            result.elapsedMs = Date.now() - started;
            result.exitCode = 0;
            console.log(`PASS Blind draft ${run}: ${state.roster.length} sales; complete; seed ${runSeed}`);
        } catch (error) {
            result.exitCode = 1;
            result.error = String(error);
            throw error;
        } finally {
            try {
                const inspected = await backend.admin('admin:inspect');
                await writeEvidenceFile(`${root}/events-${runSeed}-${run}.json`, JSON.stringify(inspected.events));
                await writeEvidenceFile(`${root}/run-${runSeed}-${run}.json`, JSON.stringify(result, null, 2));
            } finally { await backend.close(); }
        }
    }
}
