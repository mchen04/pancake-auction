import { canNominate, counts, legalPlacements, maxBid, nextDeadline, placementMax, timeoutNominee } from '../lib/rules';
import type { AuctionState, Entry, Lot, Manager, Player } from '../lib/types';
import type { WireAction } from './validators';
import { randomIndex, RuleError, Store } from './core';

async function event(client: Store, type: string, managerId: number | null, lotId: number | null,
    data: Record<string, unknown>, now: number) {
    await client.ctx.db.insert('events', { live: true, id: client.nextEvent++, type, managerId, lotId,
        data: { ...data, now }, at: now });
}
async function releaseSeat(client: Store, managerId: number, actorId: number | null, now: number) {
    const manager = await client.ctx.db.query('managers').withIndex('id', q => q.eq('id', managerId)).unique();
    if (!manager) throw new RuleError('Manager does not exist');
    await client.ctx.db.patch(manager._id, { tokenHash: null });
    await event(client, 'release', actorId, null, { managerId }, now);
}
function team(s: AuctionState, id: number) {
    return s.roster.filter(e => e.managerId === id);
}
async function resumeRequiredNominations(client: Store, s: AuctionState, lotId: number | null, now: number) {
    for (const manager of s.managers) {
        if (!manager.done || counts(team(s, manager.id)).active === 20) continue;
        manager.done = false;
        s.draft.passedTurns = s.draft.passedTurns.filter(id => id !== manager.id);
        
        await event(client, "done", manager.id, lotId, {
            done: false,
            reason: "active-spot-opened",
            nominationGeneration: s.draft.nominationGeneration
        }, now);
    }
}
function out(s: AuctionState, m: Manager) {
    if (!s.lot) {
        return true;
    }
    const player = s.players.find(p => p.id === s.lot!.playerId)!;
    return s.passes.includes(m.id) || maxBid(m.budget, player, team(s, m.id), s.players) <= s.lot.highBid;
}
async function complete(client: Store, s: AuctionState, reason: string, now: number) {
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
async function turn(client: Store, s: AuctionState, from: number, now: number) {
    await client.ensurePool(s);
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
        client.renewTurn(s);
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
            nominationGeneration: d.nominationGeneration,
            deadline: d.deadline,
            remainingMs: d.remainingMs
        }, now);
        return;
    }
}
async function award(client: Store, s: AuctionState, reason: "deadline" | "all-out" | "force", now: number) {
    if (s.draft.status !== "running" && reason !== "force") return;
    const lot = s.lot;
    if (!lot || lot.status !== "open") {
        return;
    }
    await client.ensurePool(s);
    const m = s.managers.find(m => m.id === lot.highBidderId)!;
    const player = s.players.find(p => p.id === lot.playerId);
    if (!player) throw new RuleError("Player is no longer available", 409);
    const entries = team(s, m.id);
    const placement = legalPlacements(player, entries, s.players).find(p => placementMax(m.budget, entries,
        p) >= lot.highBid);
    if (!placement) {
        throw new Error("Standing bid has no legal placement");
    }
    await client.updateLot(lot.id, { status: "sold" });
    const entry: Entry = {
        playerId: player.id,
        managerId: m.id,
        placement,
        price: lot.highBid,
        lotId: lot.id
    };
    await client.ctx.db.insert("roster", { ...entry, player });
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
async function nominate(client: Store, s: AuctionState, m: Manager, player: Player, amount: number | undefined,
    auto: boolean, now: number) {
    if (amount === undefined) throw new RuleError('Choose an opening bid of at least $1');
    if (!Number.isSafeInteger(amount) || amount < 1 || amount > maxBid(m.budget, player, team(s, m.id), s.players)) {
        throw new RuleError("Opening bid exceeds your legal maximum");
    }
    const r: Lot = { id: client.nextLot++, playerId: player.id, nominatorId: m.id,
        highBidderId: m.id, highBid: amount, status: 'open' };
    await client.ctx.db.insert('lots', { ...r, player });
    const nominationDeadline = s.draft.deadline;
    s.draft.passedTurns = [];
    s.draft.completionReason = null;
    s.lot = r;
    s.passes = [];
    s.draft.phase = "bidding";
    s.draft.lotId = s.lot.id;
    s.draft.deadline = now + s.draft.biddingMs;
    await event(client, "nomination", m.id, s.lot.id, {
        playerId: player.id,
        amount,
        auto,
        nominationDeadline,
        nominationGeneration: s.draft.nominationGeneration,
        deadline: s.draft.deadline,
        max: maxBid(m.budget, player, team(s, m.id), s.players)
    }, now);
    if (s.managers.every(other => other.id === m.id || out(s, other))) {
        await award(client, s, "all-out", now);
    }
}
export async function advance(client: Store, s: AuctionState, now: number) {
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
    await client.ensurePool(s);
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
    const player = timeoutNominee(s, m);
    if (player) {
        await nominate(client, s, m, player, 1, true, now);
    }
    else
        await turn(client, s, d.turnIndex + 1, now);
}

function turnBound(action: WireAction, s: AuctionState) {
    return action.type === 'nominate' || action.type === 'done'
        && s.draft.phase === 'nomination' && s.draft.nominatorId === s.me;
}
export function requireCurrentPage(action: WireAction, s: AuctionState) {
    const missingGeneration = (action.type === 'nominate' || action.type === 'done')
        && turnBound(action, s) && action.nominationGeneration === undefined;
    const missingForceTarget = action.type === 'force'
        && (action.expectedHighBidderId === undefined || action.expectedHighBid === undefined);
    const missingControl = action.type === 'resume' && action.expectedPause === undefined
        || action.type === 'pause' && action.expectedRunning === undefined;
    if (missingGeneration || missingForceTarget || missingControl) {
        throw new RuleError('Refresh the page to continue', 409);
    }
}
export async function act(client: Store, s: AuctionState, now: number, action: Exclude<WireAction, { type: 'mode' }>) {
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
            await client.ensurePool(s);
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
                const j = randomIndex(i + 1);
                [d.order[i], d.order[j]] = [d.order[j], d.order[i]];
            }
            d.status = "running";
            client.renewControl(s);
            d.passedTurns = [];
            d.completionReason = null;
            await event(client, "start", m.id, null, {
                controlGeneration: d.controlGeneration,
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
            const undone = await client.ctx.db.query('lots').withIndex('status', q => q.eq('status', 'sold'))
                .order('desc').first();
            if (!undone) {
                throw new RuleError("There is no sale to undo", 409);
            }
            if (action.lotId !== Number(undone.id)) {
                throw new RuleError("The latest sale has changed. Review it before undoing.", 409);
            }
            if (s.lot) {
                await client.updateLot(s.lot.id, { status: "void" });
            }
            const removed = await client.ctx.db.query('roster')
                .withIndex('lotId', q => q.eq('lotId', undone.id)).unique();
            if (!removed) throw new Error('Sold lot has no roster entry');
            await client.ctx.db.delete(removed._id);
            await client.updateLot(undone.id, { status: 'undone' });
            s.roster = s.roster.filter(entry => entry.lotId !== undone.id);
            const winner = s.managers.find(manager => manager.id === undone.highBidderId)!;
            winner.budget += undone.highBid;
            await resumeRequiredNominations(client, s, undone.id, now);
            s.managers.find(manager => manager.id === undone.nominatorId)!.done = false;
            d.passedTurns = [];
            d.completionReason = null;
            d.status = "paused";
            d.phase = "nomination";
            d.turnIndex = d.order.indexOf(undone.nominatorId);
            d.nominatorId = undone.nominatorId;
            d.lotId = null;
            d.deadline = null;
            d.remainingMs = d.nominationMs;
            client.renewTurn(s);
            client.renewControl(s);
            await event(client, "undo", m.id, undone.id, {
                playerId: undone.playerId,
                winnerId: undone.highBidderId,
                price: undone.highBid,
                placement: removed.placement,
                voidLotId: s.lot?.id ?? null,
                nominatorId: undone.nominatorId,
                nominationGeneration: d.nominationGeneration,
                controlGeneration: d.controlGeneration,
                remainingMs: d.remainingMs
            }, now);
            return;
        }
        if (action.type === "pause") {
            if (d.status !== "running") {
                throw new RuleError("Draft is not running", 409);
            }
            if (action.expectedRunning !== d.controlGeneration) {
                throw new RuleError('The draft has resumed again. Check before pausing.', 409);
            }
            d.remainingMs = Math.max(0, (d.deadline ?? now) - now);
            d.deadline = null;
            d.status = "paused";
            client.renewControl(s);
            client.renewNomination(s);
            await event(client, "pause", m.id, d.lotId, {
                remainingMs: d.remainingMs,
                controlGeneration: d.controlGeneration,
                nominationGeneration: d.nominationGeneration
            }, now);
            return;
        }
        if (action.type === "resume") {
            if (d.status !== "paused") {
                throw new RuleError("Draft is not paused", 409);
            }
            if (action.expectedPause !== d.controlGeneration) {
                throw new RuleError('The draft was paused again. Check before resuming.', 409);
            }
            d.status = "running";
            client.renewControl(s);
            d.deadline = now + (d.remainingMs ?? 0);
            d.remainingMs = null;
            client.renewNomination(s);
            await event(client, "resume", m.id, d.lotId, {
                deadline: d.deadline,
                controlGeneration: d.controlGeneration,
                nominationGeneration: d.nominationGeneration
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
            const stored = await client.ctx.db.query('roster')
                .withIndex('playerId', q => q.eq('playerId', player.id)).unique();
            await client.ctx.db.patch(stored!._id, { placement: action.placement });
            const previous = entry.placement;
            if (previous !== action.placement) {
                d.passedTurns = d.passedTurns.filter(id => id !== m.id);
            }
            entry.placement = action.placement;
            await resumeRequiredNominations(client, s, entry.lotId, now);
            await event(client, "placement", m.id, entry.lotId, {
                playerId: player.id,
                from: previous,
                to: action.placement
            }, now);
            if (d.status === "running") {
                await advance(client, s, now);
            }
            return;
        }
        if (d.status !== "running" && action.type !== "force") {
            throw new RuleError("Draft is paused", 409);
        }
        requireCurrentPage(action, s);
        if ((action.type === 'nominate' || action.type === 'done') && turnBound(action, s)
            && action.nominationGeneration !== d.nominationGeneration) {
            throw new RuleError('That nomination turn has ended', 409);
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
            if (m.done && !d.passedTurns.includes(m.id)) {
                d.passedTurns.push(m.id);
            }
            if (!m.done) {
                d.passedTurns = d.passedTurns.filter(id => id !== m.id);
            }
            await event(client, "done", m.id, d.lotId, {
                done: m.done,
                nominationGeneration: d.nominationGeneration
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
            const player = s.players.find(p => p.id === action.playerId && !s.roster.some(e => e.playerId === p.id));
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
            
            throw new RuleError("Bid arrived after the deadline", 409);
        }
        const lot = s.lot;
        if (action.type === "force") {
            if (action.expectedHighBidderId !== lot.highBidderId || action.expectedHighBid !== lot.highBid) {
                throw new RuleError('The high bid has changed. Review it before forcing a sale.', 409);
            }
            await event(client, "force", m.id, lot.id,
                { highBidderId: lot.highBidderId, highBid: lot.highBid }, now);
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
            await client.ctx.db.insert('passes', { lotId: lot.id, managerId: m.id });
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
            await client.updateLot(lot.id, { highBid: action.amount, highBidderId: m.id });
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

}
