import { evidenceDirectory, makeEvidenceDirectory as mkdir, repositoryDirectory, writeEvidenceFile as writeFile } from './evidence';
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

import { recordedPool } from "./pool-source";
import type { SeedMetadata } from "../tests/support";
import { safeError } from "./env";
import { auditDraft } from "./audit";
import { Bot } from "./bot";
import { Competition } from "./competition";
import { assertFloors, recordSpread } from "./simulation-results";
import {
    createIsolated, dropIsolated, seedManagers, seedPlayers, sleep, configure, inspect, events, getState,
    currentBackend, currentClient
} from "../tests/support";

import { counts, maxBid, taxiEligibility } from "../lib/rules";
import type { AuctionState, Player } from "../lib/types";
function option(name: string, fallback: string) {
    const index = process.argv.indexOf(name);
    return index < 0 ? fallback : process.argv[index + 1];
}
const runs = Number(option("--runs", "1"));
const timing = option("--timing", "fast");
const seed = Number(option("--seed", "42"));
let randomState = seed >>> 0;
function random() {
    randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
    return randomState / 4294967296;
}
async function build(evidence: string) {
    const chunks: string[] = [];
    const child = spawn("npm", ["run", "build"], {
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"]
    });
    child.stdout.on("data", chunk => chunks.push(String(chunk)));
    child.stderr.on("data", chunk => chunks.push(String(chunk)));
    const code = await new Promise(resolve => child.once("exit", resolve));
    await writeFile(`${evidence}/sim/build.log`, chunks.join(""));
    assert.equal(code, 0, "Production build must pass");
}
function reservedEndgamePlayers(players: Player[]) {
    const lowFirst = [...players].sort((a, b) => (a.projection ?? -Infinity) - (b.projection ?? -Infinity));
    const healthyTaxi = lowFirst.filter(p => taxiEligibility(p) === "eligible" && p.injuryStatus !== "Out");
    const rookie = healthyTaxi.find(p => p.yearsExp === 0);
    const lowGames = healthyTaxi.find(p => p.yearsExp !== 0 && p.careerGamesComplete && p.careerGames! < 65);
    const ir = lowFirst.filter(p => p.injuryStatus === "Out" && taxiEligibility(p) !== "eligible").slice(0, 2);
    assert(rookie && lowGames && ir.length === 2, "Imported pool needs rookie, low-GP and Out endgame players");
    return [rookie, lowGames, ...ir];
}
class DraftDriver {
    commissioner: Bot;
    reconnects = 0;
    simultaneousBids = 0;
    snipes = 0;
    competition: Competition | undefined;
    private lastReport = 0;
    private midDone = new Set<string>();
    private midAt = {
        pause: 35 + Math.floor(random() * 10),
        undo: 75 + Math.floor(random() * 10),
        force: 110 + Math.floor(random() * 10),
        reconnect: 135 + Math.floor(random() * 10)
    };
    constructor(public bots: Bot[], public reserved: Player[]) {
        this.commissioner = bots[0];
    }
    bot(id: number) {
        return this.bots[id - 1];
    }
    async state() {
        const failure = this.bots.find(bot => bot.failure)?.failure;
        if (failure) {
            throw failure;
        }
        const state = await this.commissioner.state();
        if (Date.now() - this.lastReport > 30000) {
            console.log(`${state.roster.filter(e => e.placement === "active").length}/200 active drafted`);
            this.lastReport = Date.now();
        }
        return state;
    }
    async undoLatest() {
        for (let attempt = 0; attempt < 5; attempt++) {
            const sale = (await this.state()).sales[0];
            assert(sale, "An undo scenario must have a sale");
            const accepted = await this.commissioner.action({ type: "undo", lotId: sale.id }, true);
            if (accepted) return;
        }
        throw new Error("The latest sale kept changing during the undo scenario");
    }
    available(state: AuctionState, managerId: number) {
        const manager = state.managers.find(m => m.id === managerId)!;
        const entries = state.roster.filter(e => e.managerId === managerId);
        const sold = new Set(state.roster.map(e => e.playerId));
        return state.players.filter(player => !sold.has(player.id) && maxBid(manager.budget, player, entries,
            state.players) >= 1);
    }
    async nominate(player?: Player, amount = 1) {
        let state = await this.state();
        while (state.lot)
            state = await this.finishByPasses(state);
        assert.equal(state.draft.phase, "nomination");
        const id = state.draft.nominatorId!;
        const available = this.available(state, id);
        const chosen = player || available.find(p => !this.reserved.some(reserved => reserved.id === p.id));
        assert(chosen);
        assert(available.some(p => p.id === chosen.id));
        await this.bot(id).action({
            type: "nominate",
            nominationGeneration: state.draft.nominationGeneration,
            playerId: chosen.id,
            amount
        });
        return this.state();
    }
    async finishByPasses(state: AuctionState) {
        if (!state.lot) {
            return this.state();
        }
        const lot = state.lot;
        const player = state.players.find(player => player.id === lot.playerId)!;
        const canRaise = (bot: Bot) => {
            const manager = state.managers.find(manager => manager.id === bot.id)!;
            return maxBid(manager.budget, player, state.roster.filter(e => e.managerId === bot.id),
                state.players) > lot.highBid;
        };
        await Promise.all(this.bots.filter(bot => bot.id !== lot.highBidderId && !state.passes.includes(bot.id)
            && canRaise(bot)).map(bot => bot.action({
            type: "pass",
            lotId: lot.id
        }, true)));
        const next = await this.state();
        assert(!next.lot || next.lot.id !== lot.id);
        return next;
    }
    async waitForSale(lotId: number) {
        let state = await this.state();
        while (state.lot?.id === lotId) {
            await sleep(200);
            state = await this.state();
        }
        return state;
    }
    async capBids(lotId: number) {
        for (let attempt = 0; attempt < 12; attempt++) {
            const state = await this.state();
            const bid = state.recentEvents.find(event => event.type === 'bid' && event.lotId === lotId);
            if (bid && Number(bid.data.deadline) === Number(bid.data.now) + state.draft.capMs
                && Number(bid.data.deadline) < Number(bid.data.beforeDeadline) + state.draft.extensionMs) return;
            assert(state.lot?.id === lotId, 'Cap exercise must retain its open lot');
            await this.bot(attempt % 2 + 1).action({
                type: 'bid', lotId, amount: state.lot.highBid + 1
            });
        }
        throw new Error('Accepted bids must exercise the deadline cap');
    }
    async timerPrelude() {
        await this.commissioner.action({
            type: "start"
        });
        let state = await this.state();
        while (!state.lot) {
            assert.equal(state.draft.status, "running");
            await sleep(200);
            state = await this.state();
        }
        const lotId = state.lot.id;
        const amount = state.lot.highBid + 1;
        this.simultaneousBids += this.bots.length;
        await Promise.all(this.bots.map(bot => bot.action({
            type: "bid",
            lotId,
            amount
        }, true)));
        state = await this.state();
        assert.equal(state.lot!.id, lotId);
        await this.bot(1).action({
            type: "bid",
            lotId,
            amount: state.lot!.highBid + 1
        });
        state = await this.state();
        await this.bot(2).action({
            type: "bid",
            lotId,
            amount: state.lot!.highBid + 1
        });
        await this.capBids(lotId);
        state = await this.state();
        await this.commissioner.action({
            type: "pause",
            expectedRunning: state.draft.controlGeneration
        });
        state = await this.state();
        const remaining = state.draft.remainingMs;
        await sleep(300);
        assert.equal((await this.state()).draft.remainingMs, remaining);
        state = await this.state();
        await this.commissioner.action({
            type: "resume",
            expectedPause: state.draft.controlGeneration
        });
        await this.bot(3 + Math.floor(random() * 8)).reconnect();
        this.reconnects++;
        state = await this.state();
        await sleep(Math.max(0, state.draft.deadline! - state.serverNow - state.draft.biddingMs * 0.2));
        state = await this.state();
        await this.bot(1).action({
            type: "bid",
            lotId,
            amount: state.lot!.highBid + 1
        });
        this.snipes++;
        await this.waitForSale(lotId);
    }
    async commissionerPrelude() {
        let state = await this.state();
        const rookie = this.available(state, state.draft.nominatorId!).find(player => player.yearsExp === 0
            && !this.reserved.some(reserved => reserved.id === player.id));
        assert(rookie);
        state = await this.nominate(rookie);
        const taxiOwner = state.lot!.highBidderId;
        await this.commissioner.action({
            type: "force",
            expectedHighBidderId: state.lot!.highBidderId, expectedHighBid: state.lot!.highBid,
            lotId: state.lot!.id
        });
        await this.bot(taxiOwner).action({
            type: "place",
            playerId: rookie.id,
            placement: "taxi"
        });
        state = await this.state();
        const out = this.available(state, state.draft.nominatorId!).find(player =>
            player.injuryStatus === "Out" && !this.reserved.some(reserved => reserved.id === player.id));
        assert(out);
        state = await this.nominate(out);
        const irLot = state.lot!.id;
        const irOwner = state.lot!.highBidderId;
        await this.finishByPasses(state);
        await this.bot(irOwner).action({
            type: "place",
            playerId: out.id,
            placement: "ir"
        });
        state = await this.nominate();
        assert(state.lot && state.lot.id !== irLot);
        await this.undoLatest();
        await this.undoLatest();
        assert.equal((await this.state()).draft.status, "paused");
        state = await this.state();
        await this.commissioner.action({
            type: "resume",
            expectedPause: state.draft.controlGeneration
        });
    }
    async midDraft(state: AuctionState) {
        const active = state.roster.filter(entry => entry.placement === "active").length;
        if (active >= this.midAt.reconnect && !this.midDone.has("reconnect")) {
            await this.bot(1 + Math.floor(random() * 10)).reconnect();
            this.reconnects++;
            this.midDone.add("reconnect");
        }
        if (active >= this.midAt.pause && !this.midDone.has("pause")) {
            await this.commissioner.action({
                type: "pause",
                expectedRunning: state.draft.controlGeneration
            });
            await sleep(150);
            state = await this.state();
            await this.commissioner.action({
                type: "resume",
                expectedPause: state.draft.controlGeneration
            });
            this.midDone.add("pause");
        }
        if (active >= this.midAt.undo && !this.midDone.has("undo")) {
            await this.undoLatest();
            state = await this.state();
            await this.commissioner.action({
                type: "resume",
                expectedPause: state.draft.controlGeneration
            });
            this.midDone.add("undo");
            return false;
        }
        if (active >= this.midAt.force && !this.midDone.has("force") && state.lot) {
            await this.commissioner.action({
                type: "force",
                expectedHighBidderId: state.lot.highBidderId, expectedHighBid: state.lot.highBid,
                lotId: state.lot.id
            });
            this.midDone.add("force");
            return false;
        }
        return true;
    }
    async fillActive() {
        const initial = await this.state();
        const competition = new Competition(this.bots, seed, initial.players, this.reserved);
        this.competition = competition;
        competition.start();
        const started = Date.now();
        try {
            while (true) {
                const state = await this.state();
                const active = state.roster.filter(entry => entry.placement === "active").length;
                if (active === 200) return;
                assert.equal(state.draft.status, "running");
                assert(Date.now() - started < 30 * 60 * 1000, "Competitive draft must finish within thirty minutes");
                const due = Object.entries(this.midAt).some(([name, threshold]) =>
                    active >= threshold && !this.midDone.has(name) && (name !== "force" || state.lot));
                if (due) {
                    await competition.suspend();
                    await this.midDraft(await this.state());
                    competition.enabled = true;
                }
                await sleep(state.draft.biddingMs < 10000 ? 75 : 200);
            }
        } finally {
            await competition.suspend();
            this.bots.forEach(bot => { bot.onPoll = undefined; });
            this.snipes += competition.snipes;
        }
    }
    async lateAuctions() {
        let state = await this.state();
        assert.equal(state.roster.filter(e => e.placement === "active").length, 200);
        for (const id of [1, 2]) {
            if (state.managers.find(manager => manager.id === id)!.done) {
                await this.bot(id).preference(false);
            }
        }
        for (const player of this.reserved) {
            state = await this.state();
            while (![1, 2].includes(state.draft.nominatorId!)) {
                const id = state.draft.nominatorId!;
                await this.bot(id).preference(true);
                state = await this.state();
            }
            const nominator = state.draft.nominatorId!;
            const rival = nominator === 1 ? 2 : 1;
            state = await this.nominate(player);
            assert(state.lot);
            const lotId = state.lot.id;
            await this.bot(rival).preference(true);
            await this.bot(rival).action({
                type: "bid",
                lotId,
                amount: 2
            });
            await this.bot(rival).preference(false);
            state = await this.state();
            await this.finishByPasses(state);
            state = await this.state();
            const entry = state.roster.find(e => e.lotId === lotId)!;
            assert.equal(entry.managerId, rival);
            assert.equal(entry.placement, player.injuryStatus === "Out" ? "ir" : "taxi");
            assert.equal(counts(state.roster.filter(e => e.managerId === rival)).active, 20);
        }
    }
    async endgame(run: number) {
        if (run % 3 === 1 && timing === "fast") {
            await this.bot(1).preference(true);
            await this.bot(2).preference(true);
        }
        else if (run % 3 === 0) {
            await this.bot(1).preference(true);
        }
        let state = await this.state();
        while (state.draft.status !== "complete") {
            assert(!state.lot, "Endgame must pass turns without new nominations");
            await sleep(200);
            state = await this.state();
        }
    }
}
async function runDraft(run: number, pool: Player[], source: string, evidence: string, importMetadata: SeedMetadata) {
    const started = Date.now();
    const schema = await createIsolated("sim");
    let bots: Bot[] = [];
    const result: Record<string, unknown> = {
        run,
        seed,
        timing,
        source,
        importMetadata,
        leagueConfig: "league/managers.json",
        clients: 10
    };
    try {
        await seedPlayers(pool, importMetadata);
        await seedManagers();
        if (process.argv.includes('--check-import')) {
            result.clients = 0;
            result.seededImport = (await inspect()).imports.at(-1);
            result.check = 'import-only; no draft started';
            result.exitCode = 0;
            return;
        }
        await currentClient().claim(1);
        await currentClient().act({ type: 'mode', mode: 'live-v1' }, 'seat:1');
        if (timing === 'fast') {
            await configure({ draft: { nominationMs: 3000, biddingMs: 3000, extensionMs: 1500, capMs: 4500 } });
        }
        const base = currentBackend().url;
        bots = Array.from({
            length: 10
        }, (_, index) => new Bot(index + 1, base));
        await Promise.all(bots.map(bot => bot.claim()));
        const secondDevice = new Bot(1, base);
        await secondDevice.claim();
        assert.equal(secondDevice.token, bots[0].token);
        await secondDevice.close();
        bots.forEach(bot => bot.startPolling(timing === "fast" ? 150 : 500));
        const driver = new DraftDriver(bots, reservedEndgamePlayers(pool));
        await driver.timerPrelude();
        await driver.commissionerPrelude();
        await driver.fillActive();
        await driver.lateAuctions();
        await driver.endgame(run);
        await Promise.all(bots.map(bot => bot.stopPolling()));
        const audited = await auditDraft({ state: await getState(),
            events: await events(), lots: (await inspect()).lots });
        result.audited = audited;
        assertFloors(audited);
        assert(audited.timers.nominationTimeouts > 0 && audited.timers.extensions > 0,
            "Nomination timeout and accepted extensions must execute");
        assert(audited.timers.caps > 0 && audited.timers.expirySales > 0,
            "A capped bid and a deadline sale must execute");
        assert(audited.taxiIrOnlyManagers.nominations >= 4 && audited.taxiIrOnlyManagers.bids >= 4);
        assert(audited.taxiIrOnlyManagers.taxiSales >= 2 && audited.taxiIrOnlyManagers.irSales >= 2);
        assert(audited.undos >= 2 && audited.forceEnds > 0 && audited.pauses > 0 && audited.giveUps > 0);
        assert(driver.reconnects > 0 && driver.snipes > 0 && driver.simultaneousBids >= 10);
        result.result = {
            ...audited,
            competitiveProfiles: driver.competition!.profiles(),
            competitiveNominations: driver.competition!.nominations,
            competitiveSnipes: driver.competition!.snipes,
            reconnects: driver.reconnects,
            snipes: driver.snipes,
            simultaneousBids: driver.simultaneousBids,
            requests: bots.reduce((sum, bot) => sum + bot.requests, 0),
            abortedTransactionRetries: bots.reduce((sum, bot) => sum + bot.transactionRetries, 0),
            rejectedActionsByReason: Object.fromEntries(bots.flatMap(bot => Object.entries(bot.rejected))
                .reduce((map, [reason, count]) => map.set(reason, (map.get(reason) || 0) + count),
                new Map<string, number>()))
        };
        result.elapsedMs = Date.now() - started;
        result.exitCode = 0;
        console.log(`PASS full draft ${run}: 10 managers, 200 active, ${audited.finalRosterSize} total (${timing})`);
    }
    catch (error) {
        result.error = safeError(error);
        result.stack = error instanceof Error ? error.stack : undefined;
        result.exitCode = 1;
        throw error;
    }
    finally {
        await Promise.all(bots.map(bot => bot.stopPolling()));
        try {
            const logged = await events();
            const players = (await getState()).players;
            await writeFile(`${evidence}/sim/events-${timing}-${seed}-${run}.json`, JSON.stringify(logged));
            await writeFile(`${evidence}/sim/players-${timing}-${seed}-${run}.json`, JSON.stringify(players));
            await writeFile(`${evidence}/sim/run-${timing}-${seed}-${run}.json`, JSON.stringify(result, null, 2));
        } finally {
            await Promise.all(bots.map(bot => bot.close()));
            await dropIsolated(schema);
        }
    }
}
async function parallelRun(run: number, evidence: string) {
    const args = [
        'node_modules/tsx/dist/cli.mjs', 'scripts/sim.ts', '--runs', '1', '--timing', timing,
        '--seed', String(seed + run - 1), '--run-index', String(run), '--skip-build'
    ];
    if (process.argv.includes('--keep-schema')) args.push('--keep-schema');
    const child = spawn(process.execPath, args, {
        env: process.env, stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    child.stdout.on('data', chunk => { output += String(chunk); process.stdout.write(chunk); });
    child.stderr.on('data', chunk => { output += String(chunk); process.stderr.write(chunk); });
    const exitCode = await new Promise<number>(resolve => child.once('exit', code => resolve(code ?? 1)));
    await writeFile(`${evidence}/sim/worker-${timing}-${run}.log`, output);
    assert.equal(exitCode, 0, `Full draft ${run} must pass`);
}
async function main() {
    if (option("--mode", "normal") === "blind") return (await import("./sealed-sim")).runSealedSim();
    assert(["normal", "live"].includes(option("--mode", "normal")));
    assert(Number.isInteger(runs) && runs > 0 && Number.isFinite(seed));
    assert(["fast", "real"].includes(timing));
    assert(!process.argv.includes('--check-import') || runs === 1);
    const evidence = evidenceDirectory(process.env.EVIDENCE_DIR, true)!;
    process.chdir(repositoryDirectory);
    await mkdir(`${evidence}/sim`, {
        recursive: true
    });
    const { players, source, importMetadata } = recordedPool();
    if (!process.argv.includes("--skip-build")) {
        await build(evidence);
    }
    if (runs === 1) {
        const run = Number(option('--run-index', '1'));
        await runDraft(run, players, source, evidence, importMetadata);
        if (!process.argv.includes('--check-import')) {
            await recordSpread([`${evidence}/sim/run-${timing}-${seed}-${run}.json`]);
        }
    } else {
        for (let first = 1; first <= runs; first += 3) {
            const group = Array.from({ length: Math.min(3, runs - first + 1) }, (_, index) => first + index);
            const results = await Promise.allSettled(group.map(run => parallelRun(run, evidence)));
            const failure = results.find(result => result.status === 'rejected');
            if (failure?.status === 'rejected') throw failure.reason;
        }
        const paths = Array.from({ length: runs }, (_, index) =>
            `${evidence}/sim/run-${timing}-${seed + index}-${index + 1}.json`);
        await recordSpread(paths, true);
    }
}
main().catch(error => {
    console.error(safeError(error));
    process.exitCode = 1;
});
