import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { act, claimSeat, getState, RuleError, restoreSeat } from "../lib/engine";
import { checkLeague } from "../scripts/readiness";
import { counts, matching, taxiEligibility } from "../lib/rules";
import { loadEnvironment, safeError } from "../scripts/env";
import { createIsolated, dropIsolated, seedManagers, seedPlayers, sleep, sql, syntheticPool } from "./support";
import leagueManagers from "../league/managers.json";
import type { Action, AuctionState } from "../lib/types";
let tokens: string[] = [];
const evidence: {
    name: string;
    elapsedMs: number;
    result: string;
}[] = [];
async function reset() {
    await sql("TRUNCATE managers RESTART IDENTITY CASCADE");
    await sql(`
    UPDATE draft SET
    status='setup',phase='nomination',nomination_order='{}',turn_index=0,nominator_id=NULL,lot_id=NULL,
    deadline=NULL,remaining_ms=NULL,passed_turns='{}',completion_reason=NULL,
    nomination_ms=10000,bidding_ms=10000,extension_ms=5000,cap_ms=15000
`);
    await sql("DELETE FROM players");
    await seedPlayers();
    await seedManagers();
    tokens = await Promise.all(Array.from({
        length: 10
    }, (_, i) => claimSeat(i + 1)));
}
async function run(name: string, fn: () => Promise<void>) {
    const start = Date.now();
    await reset();
    await fn();
    evidence.push({
        name,
        elapsedMs: Date.now() - start,
        result: "passed"
    });
    console.log(`PASS ${name}`);
}
async function start(real = false) {
    if (!real) {
        await sql("UPDATE draft SET nomination_ms=60000,bidding_ms=60000");
    }
    await act({
        type: "start"
    }, tokens[0]);
    return getState();
}
async function nomination(s: AuctionState, playerId?: string, amount = 1) {
    await act({
        type: "nominate",
        playerId: playerId || s.players.find(p => !s.roster.some(e => e.playerId === p.id))!.id,
        amount
    }, tokens[s.draft.nominatorId! - 1]);
    return getState();
}
async function force(s: AuctionState) {
    await act({
        type: "force",
        lotId: s.lot!.id
    }, tokens[0]);
    return getState();
}
async function reject(action: Action, token: string, status?: number) {
    await assert.rejects(() => act(action, token), (error: unknown) => error instanceof RuleError && (
        status === undefined || error.status === status));
}
async function invariants() {
    const s = await getState();
    for (const m of s.managers)
        assert.equal(m.budget, 1000 - s.roster.filter(e => e.managerId === m.id).reduce((sum, e) => sum + e.price, 0));
    for (const manager of s.managers) {
        const entries = s.roster.filter(entry => entry.managerId === manager.id);
        const c = counts(entries);
        assert(c.active <= 20 && c.taxi <= 3 && c.ir <= 2);
        const player = (id: string) => s.players.find(player => player.id === id)!;
        assert(matching(entries.filter(e => e.placement === "active").map(e => player(e.playerId))));
        assert(entries.filter(e => e.placement === "taxi").every(e => taxiEligibility(player(
            e.playerId)) === "eligible"));
        assert(entries.filter(e => e.placement === "ir").every(e => player(e.playerId).injuryStatus === "Out"));
    }
    assert.equal(new Set(s.roster.map(e => e.playerId)).size, s.roster.length);
    assert.equal(Number((await sql("SELECT count(*) FROM lots WHERE status='open'")).rows[0].count), s.lot ? 1 : 0);
}
async function fill(managerId: number, size = 20) {
    const pool = syntheticPool();
    const ids = pool.slice((managerId - 1) * 25, (managerId - 1) * 25 + size).map(p => p.id);
    await sql(`
    WITH added AS (INSERT INTO lots(player_id,nominator_id,high_bidder_id,high_bid,status)
    SELECT unnest($1::text[]),$2,$2,1,'sold' RETURNING id,player_id) INSERT INTO
    roster(player_id,manager_id,placement,price,lot_id) SELECT player_id,$2,'active',1,id FROM
    added
`, [ids, managerId]);
    await sql("UPDATE managers SET budget=1000-$1 WHERE id=$2", [size, managerId]);
}
async function main() {
    loadEnvironment();
    const schema = await createIsolated("test");
    try {
        await run("readiness accepts the exact league and rejects missing or changed requirements", async () => {
            await sql(`
                INSERT INTO import_runs(started_at,sources,counts,coverage)
                VALUES(clock_timestamp(),'["recorded test fixture"]','{"pool":300}','{"syntheticPlayers":true}')
            `);
            assert.equal((await checkLeague()).ready, true);
            await sql("UPDATE managers SET name=name || '-invalid' WHERE id=1");
            assert.equal((await checkLeague()).ready, false);
            const commissionerName = leagueManagers.find(manager => manager.commissioner)!.name;
            await sql("UPDATE managers SET name=$1 WHERE id=1", [commissionerName]);
            await sql("UPDATE managers SET commissioner=false WHERE id=1");
            assert.equal((await checkLeague()).ready, false);
            await sql("UPDATE managers SET commissioner=true WHERE id=1");
            await sql("UPDATE draft SET bidding_ms=4000");
            assert.equal((await checkLeague()).ready, false);
            await sql("UPDATE draft SET bidding_ms=10000,status='paused'");
            assert.equal((await checkLeague()).ready, false);
            await sql("UPDATE draft SET status='setup'");
            await sql("DELETE FROM migrations WHERE file='003_nomination_cycles.sql'");
            assert.equal((await checkLeague()).ready, false);
            await sql("INSERT INTO migrations(file) VALUES('003_nomination_cycles.sql')");
            assert.equal((await checkLeague()).ready, true);
        });
        await run("seat claims serialize and invalid tokens fail", async () => {
            await sql("UPDATE managers SET token_hash=NULL WHERE id=1");
            const results = await Promise.allSettled(Array.from({
                length: 20
            }, () => claimSeat(1)));
            assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
            await reject({
                type: "start"
            }, "0".repeat(64), 401);
            const token = (results.find(r => r.status === "fulfilled") as PromiseFulfilledResult<string>).value;
            assert.equal(await restoreSeat(token), 1);
            await act({
                type: "release",
                managerId: 2
            }, token);
            await assert.rejects(() => restoreSeat(tokens[1]), (e: unknown) => e instanceof RuleError
                && e.status === 401);
        });
        await run("bid/bid races accept one identical amount", async () => {
            const s = await nomination(await start());
            const results = await Promise.allSettled(Array.from({
                length: 20
            }, (_, i) => act({
                type: "bid",
                lotId: s.lot!.id,
                amount: 20
            }, tokens[i % 10])));
            assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
            assert.equal((await sql("SELECT amount FROM bids WHERE lot_id=$1 ORDER BY amount",
                [s.lot!.id])).rows.length, 2);
            await invariants();
        });
        await run("bid/pass and pass/pass races award once with no re-entry", async () => {
            const s = await nomination(await start());
            const high = s.lot!.highBidderId;
            const rival = s.managers.find(m => m.id !== high)!.id;
            await Promise.all(s.managers.filter(m => m.id !== high && m.id !== rival).map(m => act({
                type: "pass",
                lotId: s.lot!.id
            }, tokens[m.id - 1])));
            await Promise.allSettled([act({
                    type: "pass",
                    lotId: s.lot!.id
                }, tokens[rival - 1]), act({
                    type: "bid",
                    lotId: s.lot!.id,
                    amount: 2
                }, tokens[rival - 1]), act({
                    type: "pass",
                    lotId: s.lot!.id
                }, tokens[rival - 1])]);
            const after = await getState();
            if (after.lot) {
                await force(after);
            }
            assert.equal((await sql("SELECT * FROM events WHERE type='sale'")).rowCount, 1);
            await invariants();
            await reject({
                type: "bid",
                lotId: s.lot!.id,
                amount: 3
            }, tokens[rival - 1]);
        });
        await run("double force-end and undo/award races keep one sale per player", async () => {
            const s = await nomination(await start());
            await Promise.allSettled(Array.from({
                length: 20
            }, () => act({
                type: "force",
                lotId: s.lot!.id
            }, tokens[0])));
            assert.equal((await sql("SELECT * FROM events WHERE type='sale'")).rowCount, 1);
            const next = await nomination(await getState());
            await Promise.allSettled([act({
                    type: "undo"
                }, tokens[0]), act({
                    type: "force",
                    lotId: next.lot!.id
                }, tokens[0])]);
            await invariants();
            const after = await getState();
            assert.equal(after.draft.status, "paused");
        });
        await run("real nomination timeout and real bid timer arithmetic", async () => {
            const s = await start(true);
            assert(s.draft.deadline! - s.serverNow <= 10000 && s.draft.deadline! - s.serverNow > 9000);
            await sleep(Math.max(0, s.draft.deadline! - Date.now()) + 50);
            const lot = await getState();
            assert(lot.lot);
            assert.equal(lot.lot.highBid, 1);
            assert.equal(lot.lot.playerId, lot.players[0].id);
            const firstDeadline = lot.draft.deadline!;
            const bidder = lot.managers.find(m => m.id !== lot.lot!.highBidderId)!;
            await act({
                type: "bid",
                lotId: lot.lot.id,
                amount: 2
            }, tokens[bidder.id - 1]);
            const event = (await sql("SELECT data FROM events WHERE type='bid' ORDER BY id DESC LIMIT 1")).rows[0].data;
            assert.equal(event.deadline, Math.min(event.beforeDeadline + 5000, event.now + 15000));
            assert.equal(event.beforeDeadline, firstDeadline);
            await act({
                type: "bid",
                lotId: lot.lot.id,
                amount: 3
            }, tokens[bidder.id - 1]);
            const cap = (await sql("SELECT data FROM events WHERE type='bid' ORDER BY id DESC LIMIT 1")).rows[0].data;
            assert.equal(cap.deadline, cap.now + 15000);
            await sleep(300);
            await act({
                type: "pause"
            }, tokens[0]);
            const paused = await getState();
            assert.equal(paused.draft.deadline, null);
            await sleep(600);
            assert.equal((await getState()).draft.remainingMs, paused.draft.remainingMs);
            await act({
                type: "resume"
            }, tokens[0]);
            const resumed = (await sql(
                "SELECT data FROM events WHERE type='resume' ORDER BY id DESC LIMIT 1")).rows[0].data;
            assert.equal(resumed.deadline - resumed.now, paused.draft.remainingMs);
            await sleep(Math.max(0, resumed.deadline - Date.now()) + 50);
            const attempts = await Promise.allSettled([act({
                    type: "bid",
                    lotId: lot.lot.id,
                    amount: 4
                }, tokens[bidder.id - 1]), getState(), getState()]);
            assert.equal(attempts[0].status, "rejected");
            assert.equal((await sql("SELECT * FROM events WHERE type='sale'")).rowCount, 1);
            assert.equal((await getState()).roster[0].price, 3);
        });
        await run("repeat undo removes current placement, refunds, voids open bids, and restores turn", async () => {
            let s = await nomination(await start(), "test-0", 30);
            const original = s.lot!;
            s = await force(s);
            await act({
                type: "place",
                playerId: original.playerId,
                placement: "taxi"
            }, tokens[original.highBidderId - 1]);
            s = await nomination(s, "test-1", 5);
            s = await force(s);
            const open = await nomination(s, "test-2", 10);
            await act({
                type: "undo"
            }, tokens[0]);
            let after = await getState();
            assert.equal(after.draft.status, "paused");
            assert.equal(after.roster.length, 1);
            assert.equal((await sql("SELECT status FROM lots WHERE id=$1", [open.lot!.id])).rows[0].status, "void");
            await act({
                type: "undo"
            }, tokens[0]);
            after = await getState();
            assert.equal(after.roster.length, 0);
            assert.equal(after.draft.nominatorId, original.nominatorId);
            assert.equal(after.managers.find(m => m.id === original.highBidderId)!.budget, 1000);
            await invariants();
        });
        await run("placement rules reject bad IR, full taxi and standing-bid reserve loss", async () => {
            const before = await start();
            const id = before.draft.nominatorId!;
            await nomination(before, "test-0", 981);
            await reject({
                type: "place",
                playerId: "test-0",
                placement: "taxi"
            }, tokens[id - 1]);
            await reject({
                type: "place",
                playerId: "test-0",
                placement: "ir"
            }, tokens[id - 1]);
            const next = await nomination(await getState(), "test-1", 1);
            const bidder = next.lot!.highBidderId;
            await force(next);
            await reject({
                type: "place",
                playerId: "test-1",
                placement: "ir"
            }, tokens[bidder - 1]);
            await reject({
                type: "place",
                playerId: "test-1",
                placement: "taxi"
            }, tokens[id === bidder ? (id % 10) : id - 1]);
            await invariants();
        });
        await run("a placement cannot invalidate a standing high bid", async () => {
            let s = await nomination(await start(), "test-0", 10);
            const owner = s.lot!.highBidderId;
            await force(s);
            s = await nomination(await getState(), "test-1", 1);
            await act({
                type: "bid",
                lotId: s.lot!.id,
                amount: 972
            }, tokens[owner - 1]);
            await reject({
                type: "place",
                playerId: "test-0",
                placement: "taxi"
            }, tokens[owner - 1]);
            assert.equal((await getState()).roster[0].placement, "active");
        });
        await run("full active rosters, taxi-only timeout and all-done endgames complete", async () => {
            for (let i = 1; i <= 10; i++)
                await fill(i);
            let s = await start();
            assert.equal(s.draft.status, "running");
            const nom = s.draft.nominatorId!;
            await sql("UPDATE draft SET deadline=clock_timestamp()-interval '1 millisecond'");
            s = await getState();
            assert.equal(s.managers.find(m => m.id === nom)!.done, false);
            assert(s.draft.passedTurns.includes(nom));
            await Promise.all(s.managers.filter(m => m.id !== nom).map(m => act({
                type: "done",
                done: true
            }, tokens[m.id - 1])));
            s = await getState();
            assert.equal(s.draft.status, "complete");
            await invariants();
        });
        await run("taxi/IR timeouts pass a full cycle without marking anyone done", async () => {
            for (let id = 1; id <= 10; id++)
                await fill(id);
            let s = await start();
            for (let index = 0; index < 10; index++) {
                assert.equal(s.draft.status, "running");
                const managerId = s.draft.nominatorId!;
                await sql("UPDATE draft SET deadline=clock_timestamp()-interval '1 millisecond'");
                s = await getState();
                assert.equal(s.managers.find(m => m.id === managerId)!.done, false);
                assert(s.draft.passedTurns.includes(managerId));
            }
            assert.equal(s.draft.status, "complete");
            assert.equal(s.draft.completionReason, "full-cycle-passed");
            assert.equal((await sql("SELECT count(*) FROM events WHERE type='nomination-pass'")).rows[0].count, "10");
        });
        await run("Done is reversible while running and leaves late bids available", async () => {
            await fill(1);
            let s = await start();
            await act({
                type: "done",
                done: true
            }, tokens[0]);
            assert.equal((await getState()).managers[0].done, true);
            await act({
                type: "done",
                done: false
            }, tokens[0]);
            s = await getState();
            assert.equal(s.managers[0].done, false);
            assert(!s.draft.passedTurns.includes(1));
            s = await nomination(s, "test-30", 1);
            await act({
                type: "done",
                done: true
            }, tokens[0]);
            await act({
                type: "bid",
                lotId: s.lot!.id,
                amount: 100
            }, tokens[0]);
            s = await force(await getState());
            assert.equal(s.roster.find(e => e.playerId === "test-30")!.placement, "taxi");
            assert.equal(s.managers[0].done, true);
        });
        await run("Resume nominations remains available after a move opens an active spot", async () => {
            await fill(1);
            await start();
            await act({ type: "done", done: true }, tokens[0]);
            await act({ type: "place", playerId: "test-0", placement: "taxi" }, tokens[0]);
            assert.equal(counts((await getState()).roster.filter(entry => entry.managerId === 1)).active, 19);
            await act({ type: "done", done: false }, tokens[0]);
            assert.equal((await getState()).managers[0].done, false);
            await reject({ type: "done", done: true }, tokens[0]);
        });
        await run("all six placement paths succeed and ownership is enforced", async () => {
            let s = await nomination(await start(), "test-0", 10);
            const owner = s.lot!.highBidderId;
            s = await force(s);
            for (const placement of [
                "taxi",
                "ir",
                "active",
                "ir",
                "taxi",
                "active"
            ] as const) {
                await act({
                    type: "place",
                    playerId: "test-0",
                    placement
                }, tokens[owner - 1]);
                assert.equal((await getState()).roster[0].placement, placement);
            }
            await reject({
                type: "place",
                playerId: "test-0",
                placement: "taxi"
            }, tokens[owner % 10]);
            await invariants();
        });
        await run("implicit give-up never removes a manager with a valid higher bid", async () => {
            const s = await nomination(await start(), "test-0", 1);
            const high = s.lot!.highBidderId;
            const rival = s.managers.find(m => m.id !== high)!.id;
            await sql("UPDATE managers SET budget=21 WHERE id=$1", [rival]);
            await Promise.all(s.managers.filter(m => m.id !== high && m.id !== rival).map(m => act({
                type: "pass",
                lotId: s.lot!.id
            }, tokens[m.id - 1])));
            assert.equal((await getState()).lot!.id, s.lot!.id);
            assert.equal((await sql("SELECT count(*) FROM events WHERE type='sale'")).rows[0].count, "0");
            await act({
                type: "bid",
                lotId: s.lot!.id,
                amount: 2
            }, tokens[rival - 1]);
            assert.equal((await getState()).lot!.highBidderId, rival);
            await sql("UPDATE managers SET budget=19 WHERE id=$1", [high]);
            await getState();
            await sql("UPDATE draft SET deadline=clock_timestamp()-interval '1 millisecond'");
            assert.equal((await getState()).roster[0].price, 2);
        });
        await run("implicit give-up awards at the equal-maximum boundary", async () => {
            const initial = await start();
            const nominator = initial.draft.nominatorId!;
            await sql("UPDATE managers SET budget=20 WHERE id<>$1", [nominator]);
            const s = await nomination(await getState(), "test-0", 1);
            assert.equal(s.lot, null);
            const sale = (await sql("SELECT data FROM events WHERE type='sale'")).rows[0].data;
            assert.equal(sale.reason, "all-out");
            assert.equal(sale.implicitOut.length, 9);
        });
        await run("taxi-only and IR-only managers nominate and win with full active rosters", async () => {
            for (let id = 1; id <= 10; id++)
                await fill(id);
            let s = await start();
            for (const group of ["taxi", "ir"] as const) {
                const nominator = s.draft.nominatorId!;
                const used = new Set(s.roster.map(e => e.playerId));
                const player = s.players.find(p => !used.has(p.id) && (group === "taxi" ? p.yearsExp === 0
                    && p.injuryStatus !== "Out" : p.injuryStatus === "Out" && p.careerGames! >= 65));
                assert(player, `Fixture needs an available ${group} player`);
                const playerId = player.id;
                s = await nomination(await getState(), playerId, 1);
                const bidder = s.managers.find(m => m.id !== nominator)!.id;
                await act({
                    type: "bid",
                    lotId: s.lot!.id,
                    amount: 2
                }, tokens[bidder - 1]);
                s = await force(await getState());
                assert.equal(s.roster.find(e => e.playerId === playerId)!.placement, group);
            }
            await invariants();
        });
        await run("done managers still bid into taxi, and a fourth taxi placement fails", async () => {
            await fill(1);
            let s = await start();
            await act({
                type: "done",
                done: true
            }, tokens[0]);
            s = await getState();
            for (const playerId of ["test-30", "test-33", "test-36"]) {
                s = await nomination(s, playerId, 1);
                await act({
                    type: "bid",
                    lotId: s.lot!.id,
                    amount: 100
                }, tokens[0]);
                s = await force(await getState());
                assert.equal(s.roster.find(e => e.playerId === playerId)!.placement, "taxi");
            }
            await reject({
                type: "place",
                playerId: "test-3",
                placement: "taxi"
            }, tokens[0]);
            assert.equal(s.managers.find(m => m.id === 1)!.done, true);
            await invariants();
        });
        await run("all active, taxi and IR groups full complete immediately", async () => {
            for (let id = 1; id <= 10; id++) {
                await fill(id);
                const extra = Array.from({
                    length: 5
                }, (_, i) => `test-${(id - 1) * 25 + 20 + i}`);
                await sql("UPDATE players SET data=jsonb_set(data,'{yearsExp}','0') WHERE id=ANY($1)",
                    [extra.slice(0, 3)]);
                await sql("UPDATE players SET data=jsonb_set(data,'{injuryStatus}','\"Out\"') WHERE id=ANY($1)",
                    [extra.slice(3)]);
                await sql(`
          WITH added AS (
            INSERT INTO lots(player_id,nominator_id,high_bidder_id,high_bid,status)
            SELECT unnest($1::text[]),$2,$2,1,'sold' RETURNING id,player_id
          )
          INSERT INTO roster(player_id,manager_id,placement,price,lot_id)
          SELECT player_id,$2,CASE WHEN player_id=ANY($3::text[]) THEN 'taxi' ELSE 'ir' END,1,id FROM added
        `, [extra, id, extra.slice(0, 3)]);
                await sql("UPDATE managers SET budget=975 WHERE id=$1", [id]);
            }
            const s = await start();
            assert.equal(s.draft.status, "complete");
            assert.equal(s.draft.completionReason, "no-eligible-managers");
            assert.equal(s.roster.length, 250);
            await invariants();
        });
        await run("IR-only endgame permits Out and rejects IR status; exhausted pool completes", async () => {
            for (let i = 1; i <= 10; i++)
                await fill(i);
            await sql(`
    UPDATE players SET
    data=jsonb_set(jsonb_set(jsonb_set(data,'{careerGames}','100'),'{yearsExp}','10'),'{injuryStatus}','"IR"')
    WHERE id NOT IN (SELECT player_id FROM roster)
`);
            let s = await start();
            assert.equal(s.draft.status, "complete");
            await sql("UPDATE draft SET status='setup'");
            await sql("UPDATE players SET data=jsonb_set(data,'{injuryStatus}','\"Out\"') WHERE id='test-299'");
            s = await start();
            assert.equal(s.draft.status, "running");
            s = await nomination(s, "test-299", 500);
            await force(s);
            s = await getState();
            assert.equal(s.roster.find(e => e.playerId === "test-299")!.placement, "ir");
            assert.equal(s.draft.status, "complete");
        });
        await run("empty pool, full groups, exhausted budgets and append-only constraints", async () => {
            await sql("DELETE FROM players");
            await reject({
                type: "start"
            }, tokens[0]);
            await seedPlayers();
            for (let i = 1; i <= 10; i++)
                await fill(i);
            await sql("UPDATE managers SET budget=0");
            assert.equal((await start()).draft.status, "complete");
            await assert.rejects(() => sql("UPDATE events SET type='changed'"));
            await assert.rejects(() => sql("DELETE FROM events"));
        });
        await run("constraints independently reject duplicate sales and non-increasing bids", async () => {
            const s = await nomination(await start());
            await assert.rejects(() => sql("INSERT INTO bids(lot_id,manager_id,amount) VALUES($1,1,1)", [s.lot!.id]));
            await assert.rejects(() => sql(`
    INSERT INTO lots(player_id,nominator_id,high_bidder_id,high_bid,status)
    VALUES($1,1,1,1,'open')
`, [s.lot!.playerId]));
            await force(s);
            await assert.rejects(() => sql(`
    INSERT INTO lots(player_id,nominator_id,high_bidder_id,high_bid,status)
    VALUES($1,1,1,1,'sold')
`, [s.lot!.playerId]));
        });
    }
    finally {
        const dir = process.env.EVIDENCE_DIR;
        if (dir) {
            await mkdir(`${dir}/db`, {
                recursive: true
            });
            await writeFile(`${dir}/db/results.json`, JSON.stringify(evidence, null, 2));
        }
        if (!process.argv.includes("--keep-schema")) {
            await dropIsolated(schema);
        }
    }
}
main().catch(error => {
    console.error(safeError(error));
    process.exitCode = 1;
});
