import { createHash, randomBytes, randomInt } from "node:crypto";
import type { PoolClient } from "pg";
import { begin, dbNow, schemaName } from "./db";
import { counts, legalPlacements, maxBid, nextDeadline, placementMax } from "./rules";
import type { Action, AuctionState, Draft, Entry, Lot, Manager, Player } from "./types";
export class RuleError extends Error {
    constructor(message: string, public status = 422) {
        super(message);
    }
}
export function tokenHash(token: string) {
    return createHash("sha256").update(token).digest("hex");
}
const lotFrom = (r: Record<string, unknown>): Lot => ({
    id: Number(r.id),
    playerId: String(r.player_id),
    nominatorId: Number(r.nominator_id),
    highBidderId: Number(r.high_bidder_id),
    highBid: Number(r.high_bid),
    status: String(r.status)
});
const playerCache = new Map<string, Player[]>();
async function load(client: PoolClient, token?: string): Promise<AuctionState> {
    const cached = playerCache.get(schemaName());
    const all = (await client.query(`SELECT
    (SELECT row_to_json(d) FROM draft d WHERE id=1) AS draft,
    COALESCE((SELECT json_agg(m ORDER BY id) FROM
      (SELECT id,name,commissioner,budget,done,token_hash IS NOT NULL AS claimed,token_hash FROM managers) m),
      '[]') AS managers,
    CASE WHEN ${cached ? "(SELECT status FROM draft WHERE id=1) <> 'setup'" : "false"}
      THEN NULL ELSE COALESCE((SELECT json_agg(data ORDER BY
      (data->>'projection')::double precision DESC NULLS LAST,id) FROM players),'[]') END AS players,
    COALESCE((SELECT json_agg(r ORDER BY lot_id) FROM roster r),'[]') AS roster,
    (SELECT row_to_json(l) FROM lots l WHERE id=(SELECT lot_id FROM draft WHERE id=1)) AS lot,
    COALESCE((SELECT json_agg(manager_id) FROM passes
      WHERE lot_id=(SELECT lot_id FROM draft WHERE id=1)),'[]') AS passes,
    COALESCE((SELECT json_agg(l ORDER BY id DESC) FROM
      (SELECT * FROM lots WHERE status='sold' ORDER BY id DESC LIMIT 30) l),'[]') AS sales,
    COALESCE((SELECT json_agg(e ORDER BY id DESC) FROM
      (SELECT * FROM events ORDER BY id DESC LIMIT 30) e),'[]') AS events,
    extract(epoch FROM clock_timestamp()) * 1000 AS now`)).rows[0];
    const r = all.draft;
    const draft: Draft = {
        status: r.status,
        phase: r.phase,
        order: r.nomination_order,
        turnIndex: r.turn_index,
        nominatorId: r.nominator_id,
        lotId: r.lot_id,
        deadline: r.deadline ? new Date(r.deadline).getTime() : null,
        remainingMs: r.remaining_ms,
        nominationMs: r.nomination_ms,
        biddingMs: r.bidding_ms,
        extensionMs: r.extension_ms,
        capMs: r.cap_ms,
        passedTurns: r.passed_turns,
        completionReason: r.completion_reason
    };
    const hash = token && /^[a-f0-9]{64}$/.test(token) ? tokenHash(token) : null;
    const me = hash ? all.managers.find((m: {
        token_hash: string;
    }) => m.token_hash === hash)?.id ?? null : null;
    const managers: Manager[] = all.managers.map((m: Manager & {
        token_hash?: string;
    }) => {
        delete m.token_hash;
        return m;
    });
    const players: Player[] = all.players ?? cached;
    if (all.players) {
        playerCache.set(schemaName(), players);
    }
    const roster: Entry[] = all.roster.map((r: Record<string, unknown>) => ({
        playerId: String(r.player_id),
        managerId: Number(r.manager_id),
        placement: r.placement as Entry["placement"],
        price: Number(r.price),
        lotId: Number(r.lot_id)
    }));
    const lot = all.lot ? lotFrom(all.lot) : null;
    const passes: number[] = all.passes;
    const sales: Lot[] = all.sales.map(lotFrom);
    const recentEvents = all.events.map((e: Record<string, unknown>) => ({
        id: String(e.id),
        type: String(e.type),
        managerId: e.manager_id as number | null,
        lotId: e.lot_id as number | null,
        data: e.data as Record<string, unknown>,
        at: new Date(String(e.created_at)).getTime()
    }));
    return {
        draft,
        managers,
        players,
        roster,
        lot,
        passes,
        sales,
        recentEvents,
        serverNow: Number(all.now),
        me
    };
}
async function save(client: PoolClient, d: Draft) {
    await client.query(`
    UPDATE draft SET
    status=$1,phase=$2,nomination_order=$3,turn_index=$4,nominator_id=$5,lot_id=$6,
    deadline=$7,remaining_ms=$8,passed_turns=$9,completion_reason=$10
    WHERE id=1
`, [
        d.status,
        d.phase,
        d.order,
        d.turnIndex,
        d.nominatorId,
        d.lotId,
        d.deadline === null ? null : new Date(d.deadline),
        d.remainingMs,
        d.passedTurns,
        d.completionReason
    ]);
}
async function event(client: PoolClient, type: string, managerId: number | null, lotId: number | null,
    data: Record<string, unknown>, now: number) {
    await client.query("INSERT INTO events(type,manager_id,lot_id,data) VALUES($1,$2,$3,$4)", [
        type,
        managerId,
        lotId,
        {
            ...data,
            now
        }
    ]);
}
function team(s: AuctionState, id: number) {
    return s.roster.filter(e => e.managerId === id);
}
function available(s: AuctionState) {
    const sold = new Set(s.roster.map(e => e.playerId));
    return s.players.filter(p => !sold.has(p.id));
}
function canNominate(s: AuctionState, m: Manager) {
    return !m.done && available(s).some(p => maxBid(m.budget, p, team(s, m.id), s.players) >= 1);
}
function out(s: AuctionState, m: Manager) {
    if (!s.lot) {
        return true;
    }
    const player = s.players.find(p => p.id === s.lot!.playerId)!;
    return s.passes.includes(m.id) || maxBid(m.budget, player, team(s, m.id), s.players) <= s.lot.highBid;
}
async function complete(client: PoolClient, s: AuctionState, reason: string, now: number) {
    const d = s.draft;
    d.status = "complete";
    d.nominatorId = null;
    d.deadline = null;
    d.remainingMs = null;
    d.completionReason = reason;
    await event(client, "complete", null, null, {
        reason,
        passedTurns: d.passedTurns
    }, now);
}
async function turn(client: PoolClient, s: AuctionState, from: number, now: number) {
    const d = s.draft;
    d.lotId = null;
    d.phase = "nomination";
    s.lot = null;
    s.passes = [];
    const eligible = s.managers.filter(m => canNominate(s, m));
    if (!eligible.length) {
        return complete(client, s, "no-eligible-managers", now);
    }
    if (eligible.every(m => d.passedTurns.includes(m.id))) {
        return complete(client, s, "full-cycle-passed", now);
    }
    for (let offset = 0; offset < d.order.length; offset++) {
        const index = (from + offset) % d.order.length;
        const m = eligible.find(m => m.id === d.order[index]);
        if (!m) {
            continue;
        }
        d.turnIndex = index;
        d.nominatorId = m.id;
        if (d.status === "paused") {
            d.deadline = null;
            d.remainingMs = d.nominationMs;
        }
        else {
            d.deadline = now + d.nominationMs;
            d.remainingMs = null;
        }
        await event(client, "turn", null, null, {
            index,
            nominatorId: m.id,
            deadline: d.deadline,
            remainingMs: d.remainingMs
        }, now);
        return;
    }
}
async function award(client: PoolClient, s: AuctionState, reason: "deadline" | "all-out" | "force", now: number) {
    const lot = s.lot;
    if (!lot || lot.status !== "open") {
        return;
    }
    const m = s.managers.find(m => m.id === lot.highBidderId)!;
    const player = s.players.find(p => p.id === lot.playerId)!;
    const entries = team(s, m.id);
    const placement = legalPlacements(player, entries, s.players).find(p => placementMax(m.budget, entries,
        p) >= lot.highBid);
    if (!placement) {
        throw new Error("Standing bid has no legal placement");
    }
    await client.query("UPDATE lots SET status='sold',sold_at=clock_timestamp() WHERE id=$1 AND status='open'",
        [lot.id]);
    await client.query("INSERT INTO roster(player_id,manager_id,placement,price,lot_id) VALUES($1,$2,$3,$4,$5)", [
        player.id,
        m.id,
        placement,
        lot.highBid,
        lot.id
    ]);
    await client.query("UPDATE managers SET budget=budget-$1 WHERE id=$2", [lot.highBid, m.id]);
    const entry: Entry = {
        playerId: player.id,
        managerId: m.id,
        placement,
        price: lot.highBid,
        lotId: lot.id
    };
    await event(client, "sale", m.id, lot.id, {
        ...entry,
        reason,
        deadline: s.draft.deadline,
        passed: s.passes,
        implicitOut: s.managers.filter(other => other.id !== m.id && !s.passes.includes(other.id) && maxBid(
            other.budget, player, team(s, other.id), s.players) <= lot.highBid).map(other => other.id)
    }, now);
    m.budget -= lot.highBid;
    s.roster.push(entry);
    lot.status = "sold";
    await turn(client, s, s.draft.turnIndex + 1, now);
}
async function nominate(client: PoolClient, s: AuctionState, m: Manager, player: Player, amount: number,
    auto: boolean, now: number) {
    if (!Number.isSafeInteger(amount) || amount < 1 || amount > maxBid(m.budget, player, team(s, m.id), s.players)) {
        throw new RuleError("Opening bid exceeds your legal maximum");
    }
    const r = (await client.query(`
    INSERT INTO lots(player_id,nominator_id,high_bidder_id,high_bid,status)
    VALUES($1,$2,$2,$3,'open') RETURNING *
`, [player.id, m.id, amount])).rows[0];
    const nominationDeadline = s.draft.deadline;
    s.draft.passedTurns = [];
    s.draft.completionReason = null;
    s.lot = lotFrom(r);
    s.passes = [];
    s.draft.phase = "bidding";
    s.draft.lotId = s.lot.id;
    s.draft.deadline = now + s.draft.biddingMs;
    await client.query("INSERT INTO bids(lot_id,manager_id,amount) VALUES($1,$2,$3)", [s.lot.id, m.id, amount]);
    await event(client, "nomination", m.id, s.lot.id, {
        playerId: player.id,
        amount,
        auto,
        nominationDeadline,
        deadline: s.draft.deadline,
        max: maxBid(m.budget, player, team(s, m.id), s.players)
    }, now);
    if (s.managers.every(other => other.id === m.id || out(s, other))) {
        await award(client, s, "all-out", now);
    }
}
async function advance(client: PoolClient, s: AuctionState, now: number) {
    const d = s.draft;
    if (d.status !== "running") {
        return;
    }
    if (d.phase === "bidding") {
        if (d.deadline !== null && now >= d.deadline) {
            await award(client, s, "deadline", now);
        }
        else if (s.lot && s.managers.every(m => m.id === s.lot!.highBidderId || out(s, m))) {
            await award(client, s, "all-out", now);
        }
        return;
    }
    const m = s.managers.find(m => m.id === d.nominatorId);
    if (!m || !canNominate(s, m)) {
        await turn(client, s, d.turnIndex + 1, now);
        return;
    }
    if (d.deadline === null || now < d.deadline) {
        return;
    }
    if (counts(team(s, m.id)).active === 20) {
        if (!d.passedTurns.includes(m.id)) {
            d.passedTurns.push(m.id);
        }
        await event(client, "nomination-pass", m.id, null, {
            reason: "timeout",
            deadline: d.deadline
        }, now);
        await turn(client, s, d.turnIndex + 1, now);
        return;
    }
    const player = available(s).find(p => maxBid(m.budget, p, team(s, m.id), s.players) >= 1);
    if (player) {
        await nominate(client, s, m, player, 1, true, now);
    }
    else
        await turn(client, s, d.turnIndex + 1, now);
}
export async function transact<T>(run: (client: PoolClient, state: AuctionState, now: number) => Promise<T>,
    token?: string): Promise<T> {
    const client = await begin();
    let state: AuctionState | undefined;
    let original = "";
    try {
        await client.query("SELECT id FROM draft WHERE id=1 FOR UPDATE");
        state = await load(client, token);
        original = JSON.stringify(state.draft);
        const now = await dbNow(client);
        state.serverNow = now;
        await advance(client, state, now);
        const result = await run(client, state, now);
        if (original !== JSON.stringify(state.draft)) {
            await save(client, state.draft);
        }
        await client.query("COMMIT");
        return result;
    }
    catch (error) {
        if (error instanceof RuleError) {
            if (state && original !== JSON.stringify(state.draft)) {
                await save(client, state.draft);
            }
            await client.query("COMMIT");
        }
        else
            await client.query("ROLLBACK");
        throw error;
    }
    finally {
        client.release();
    }
}
export async function getState(token?: string) {
    const client = await begin();
    let state: AuctionState;
    try {
        state = await load(client, token);
        await client.query("COMMIT");
    }
    catch (error) {
        await client.query("ROLLBACK");
        throw error;
    }
    finally {
        client.release();
    }
    if (state.draft.status !== "running" || state.draft.deadline === null || state.serverNow < state.draft.deadline) {
        return state;
    }
    return transact(async (client, s) => {
        s.serverNow = await dbNow(client);
        return s;
    }, token);
}
export async function claimSeat(managerId: number) {
    return transact(async (client, s, now) => {
        const m = s.managers.find(m => m.id === managerId);
        if (!m) {
            throw new RuleError("Choose a configured manager");
        }
        if (m.claimed) {
            throw new RuleError("This seat is claimed. Ask the commissioner to release it.", 409);
        }
        const token = randomBytes(32).toString("hex");
        await client.query("UPDATE managers SET token_hash=$1,claimed_at=clock_timestamp() WHERE id=$2",
            [tokenHash(token), managerId]);
        await event(client, "claim", managerId, null, {}, now);
        return token;
    });
}
export async function restoreSeat(token: string) {
    return transact(async (client, s, now) => {
        if (!s.me) {
            throw new RuleError("Seat token is no longer valid", 401);
        }
        await event(client, "restore", s.me, null, {
            activeDrafted: s.roster.filter(entry => entry.placement === "active").length
        }, now);
        return s.me;
    }, token);
}
export async function releaseSeat(client: PoolClient, managerId: number, actorId: number | null, now: number) {
    const result = await client.query(
        "UPDATE managers SET token_hash=NULL,claimed_at=NULL WHERE id=$1 RETURNING id", [managerId]);
    if (!result.rowCount) {
        throw new RuleError("Manager does not exist");
    }
    await event(client, "release", actorId, null, {
        managerId
    }, now);
}
export async function act(action: Action, token?: string) {
    return transact(async (client, s, now) => {
        const m = s.managers.find(m => m.id === s.me);
        if (!m) {
            throw new RuleError("Claim your seat first", 401);
        }
        const d = s.draft;
        if ([
            "start",
            "pause",
            "resume",
            "undo",
            "force",
            "release"
        ].includes(action.type) && !m.commissioner) {
            throw new RuleError("Commissioner only", 403);
        }
        if (action.type === "release") {
            await releaseSeat(client, action.managerId, m.id, now);
            return;
        }
        if (action.type === "start") {
            if (d.status !== "setup") {
                throw new RuleError("Draft has already started", 409);
            }
            if (s.managers.length !== 10 || s.managers.filter(m => m.commissioner).length !== 1) {
                throw new RuleError("Configure ten managers and one commissioner");
            }
            if (!s.players.length) {
                throw new RuleError("Import players before starting");
            }
            d.order = s.managers.map(m => m.id);
            for (let i = d.order.length - 1; i > 0; i--) {
                const j = randomInt(i + 1);
                [d.order[i], d.order[j]] = [d.order[j], d.order[i]];
            }
            d.status = "running";
            d.passedTurns = [];
            d.completionReason = null;
            await event(client, "start", m.id, null, {
                order: d.order,
                timing: {
                    nominationMs: d.nominationMs,
                    biddingMs: d.biddingMs,
                    extensionMs: d.extensionMs,
                    capMs: d.capMs
                }
            }, now);
            await turn(client, s, 0, now);
            return;
        }
        if (action.type === "undo") {
            const sale = (await client.query(
                "SELECT * FROM lots WHERE status='sold' ORDER BY id DESC LIMIT 1")).rows[0];
            if (!sale) {
                throw new RuleError("There is no sale to undo", 409);
            }
            const undone = lotFrom(sale);
            if (s.lot) {
                await client.query("UPDATE lots SET status='void' WHERE id=$1", [s.lot.id]);
            }
            const removed = (await client.query("DELETE FROM roster WHERE lot_id=$1 RETURNING *", [undone.id])).rows[0];
            await client.query("UPDATE lots SET status='undone' WHERE id=$1", [undone.id]);
            await client.query("UPDATE managers SET budget=budget+$1 WHERE id=$2", [undone.highBid,
                undone.highBidderId]);
            await client.query("UPDATE managers SET done=false WHERE id=$1", [undone.nominatorId]);
            d.passedTurns = [];
            d.completionReason = null;
            d.status = "paused";
            d.phase = "nomination";
            d.turnIndex = d.order.indexOf(undone.nominatorId);
            d.nominatorId = undone.nominatorId;
            d.lotId = null;
            d.deadline = null;
            d.remainingMs = d.nominationMs;
            await event(client, "undo", m.id, undone.id, {
                playerId: undone.playerId,
                winnerId: undone.highBidderId,
                price: undone.highBid,
                placement: removed.placement,
                voidLotId: s.lot?.id ?? null,
                nominatorId: undone.nominatorId,
                remainingMs: d.remainingMs
            }, now);
            return;
        }
        if (action.type === "pause") {
            if (d.status !== "running") {
                throw new RuleError("Draft is not running", 409);
            }
            d.remainingMs = Math.max(0, (d.deadline ?? now) - now);
            d.deadline = null;
            d.status = "paused";
            await event(client, "pause", m.id, d.lotId, {
                remainingMs: d.remainingMs
            }, now);
            return;
        }
        if (action.type === "resume") {
            if (d.status !== "paused") {
                throw new RuleError("Draft is not paused", 409);
            }
            d.status = "running";
            d.deadline = now + (d.remainingMs ?? 0);
            d.remainingMs = null;
            await event(client, "resume", m.id, d.lotId, {
                deadline: d.deadline
            }, now);
            await advance(client, s, now);
            return;
        }
        if (d.status === "complete" || d.status === "setup") {
            throw new RuleError("Draft is not in progress", 409);
        }
        if (action.type === "place") {
            if (!["active", "taxi", "ir"].includes(action.placement)) {
                throw new RuleError("Invalid placement");
            }
            const entry = s.roster.find(e => e.playerId === action.playerId && e.managerId === m.id);
            if (!entry) {
                throw new RuleError("You can only move your own players");
            }
            const player = s.players.find(p => p.id === entry.playerId)!;
            const rest = team(s, m.id).filter(e => e !== entry);
            if (!legalPlacements(player, rest, s.players).includes(action.placement)) {
                throw new RuleError("Player cannot use that placement");
            }
            const changed = [...rest, {
                    ...entry,
                    placement: action.placement
                }];
            if (m.budget < 20 - counts(changed).active) {
                throw new RuleError("Keep $1 for each open active spot");
            }
            if (s.lot?.highBidderId === m.id) {
                const standingPlayer = s.players.find(p => p.id === s.lot!.playerId)!;
                if (maxBid(m.budget, standingPlayer, changed, s.players) < s.lot.highBid) {
                    throw new RuleError("This move would invalidate your standing bid");
                }
            }
            await client.query("UPDATE roster SET placement=$1 WHERE player_id=$2", [action.placement, player.id]);
            await event(client, "placement", m.id, entry.lotId, {
                playerId: player.id,
                from: entry.placement,
                to: action.placement
            }, now);
            entry.placement = action.placement;
            if (s.lot && s.managers.every(other => other.id === s.lot!.highBidderId || out(s, other))) {
                await award(client, s, "all-out", now);
            }
            else if (d.status === "running") {
                await advance(client, s, now);
            }
            return;
        }
        if (d.status !== "running" && action.type !== "force") {
            throw new RuleError("Draft is paused", 409);
        }
        if (action.type === "done") {
            const c = counts(team(s, m.id));
            if (action.done && (c.active !== 20 || c.taxi === 3 && c.ir === 2)) {
                throw new RuleError("Done is available when only taxi or IR openings remain");
            }
            if (typeof action.done !== "boolean") {
                throw new RuleError("Choose whether to stop nominations");
            }
            m.done = action.done;
            await client.query("UPDATE managers SET done=$1 WHERE id=$2", [m.done, m.id]);
            if (m.done && !d.passedTurns.includes(m.id)) {
                d.passedTurns.push(m.id);
            }
            if (!m.done) {
                d.passedTurns = d.passedTurns.filter(id => id !== m.id);
            }
            await event(client, "done", m.id, d.lotId, {
                done: m.done
            }, now);
            if (d.phase === "nomination") {
                if (d.nominatorId === m.id && m.done) {
                    await turn(client, s, d.turnIndex + 1, now);
                }
                else if (s.managers.filter(other => canNominate(s, other)).every(other =>
                    d.passedTurns.includes(other.id))) {
                    await turn(client, s, d.turnIndex, now);
                }
            }
            return;
        }
        if (action.type === "nominate") {
            if (d.phase !== "nomination" || d.nominatorId !== m.id) {
                throw new RuleError("It is not your nomination turn", 409);
            }
            const player = available(s).find(p => p.id === action.playerId);
            if (!player) {
                throw new RuleError("Player is no longer available", 409);
            }
            await nominate(client, s, m, player, action.amount, false, now);
            return;
        }
        if (!s.lot || !("lotId" in action) || action.lotId !== s.lot.id || d.phase !== "bidding") {
            throw new RuleError("This lot has ended. Refresh and try the current lot.", 409);
        }
        if (d.status === "running" && d.deadline !== null && now >= d.deadline) {
            await award(client, s, "deadline", now);
            await save(client, d);
            throw new RuleError("Bid arrived after the deadline", 409);
        }
        const lot = s.lot;
        if (action.type === "force") {
            await event(client, "force", m.id, lot.id, {}, now);
            await award(client, s, "force", now);
            return;
        }
        if (action.type === "pass") {
            if (m.id === lot.highBidderId) {
                throw new RuleError("The high bidder cannot give up");
            }
            if (s.passes.includes(m.id)) {
                throw new RuleError("You already gave up on this player", 409);
            }
            await client.query("INSERT INTO passes(lot_id,manager_id) VALUES($1,$2)", [lot.id, m.id]);
            s.passes.push(m.id);
            await event(client, "pass", m.id, lot.id, {}, now);
        }
        else if (action.type === "bid") {
            if (s.passes.includes(m.id)) {
                throw new RuleError("You gave up on this player");
            }
            const player = s.players.find(p => p.id === lot.playerId)!;
            const maximum = maxBid(m.budget, player, team(s, m.id), s.players);
            if (!Number.isSafeInteger(action.amount) || action.amount <= lot.highBid || action.amount > maximum) {
                throw new RuleError(`Bid must be a whole dollar above $${lot.highBid}, up to $${maximum}`);
            }
            const before = d.deadline!;
            d.deadline = nextDeadline(before, now, d.extensionMs, d.capMs);
            await client.query("INSERT INTO bids(lot_id,manager_id,amount) VALUES($1,$2,$3)", [lot.id, m.id,
                action.amount]);
            await client.query("UPDATE lots SET high_bid=$1,high_bidder_id=$2 WHERE id=$3", [action.amount,
                m.id, lot.id]);
            lot.highBid = action.amount;
            lot.highBidderId = m.id;
            await event(client, "bid", m.id, lot.id, {
                amount: action.amount,
                beforeDeadline: before,
                deadline: d.deadline,
                max: maximum
            }, now);
        }
        if (s.managers.every(other => other.id === lot.highBidderId || out(s, other))) {
            await award(client, s, "all-out", now);
        }
    }, token);
}
