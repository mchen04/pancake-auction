import assert from "node:assert/strict";
import type { AuctionState, Entry, Lot, Placement, Player } from "../lib/types";
export type LoggedEvent = {
    id: string;
    type: string;
    manager_id: number | null;
    lot_id: number | null;
    data: Record<string, unknown>;
    created_at: Date;
};
type ReplayLot = {
    id: number;
    playerId: string;
    high: number;
    bidder: number;
    nominator: number;
    passes: Set<number>;
};
type Timing = {
    nominationMs: number;
    biddingMs: number;
    extensionMs: number;
    capMs: number;
};
export class Replay {
    roster: Entry[] = [];
    budgets = new Map<number, number>();
    done = new Set<number>();
    passedTurns = new Set<number>();
    order: number[] = [];
    cursor = 0;
    nominator: number | null = null;
    deadline: number | null = null;
    remaining: number | null = null;
    paused = false;
    complete = false;
    lot: ReplayLot | null = null;
    forced: number | null = null;
    sold: {
        lotId: number;
        nominator: number;
    }[] = [];
    timing: Timing = {
        nominationMs: 10000,
        biddingMs: 10000,
        extensionMs: 5000,
        capMs: 15000
    };
    coverage: Record<string, number> = {};
    timers = {
        nominationTimeouts: 0,
        extensions: 0,
        caps: 0,
        expirySales: 0,
        passedTurns: 0
    };
    late = {
        nominations: 0,
        bids: 0,
        taxiSales: 0,
        irSales: 0
    };
    implicitGiveUps = 0;
    acceptedBids = 0;
    maxBidHits = 0;
    bidParticipation = new Map<number, { acceptedBids: number; lots: Set<number> }>();
    lookup: Map<string, Player>;
    slotTypes = [
        "PG",
        "SG",
        "SF",
        "PF",
        "C",
        "G",
        "F",
        "U",
        "U",
        "U",
        ...Array<string>(10).fill("U")
    ];
    constructor(public players: Player[], public managerIds: number[]) {
        this.lookup = new Map(players.map(player => [player.id, player]));
        managerIds.forEach(id => this.budgets.set(id, 1000));
    }
    team(id: number) {
        return this.roster.filter(entry => entry.managerId === id);
    }
    count(entries: Entry[], placement: Placement) {
        return entries.filter(e => e.placement === placement).length;
    }
    player(id: string) {
        const player = this.lookup.get(id);
        assert(player, `Missing replay player ${id}`);
        return player;
    }
    fits(player: Player, slot: string) {
        return slot === "U" || player.positions.some(position => position === slot || slot === "G" && ["PG",
            "SG", "G"].includes(position) || slot === "F" && ["SF", "PF", "F"].includes(position));
    }
    feasible(entries: Entry[], extra?: Player) {
        const players = entries.filter(e => e.placement === "active").map(e => this.player(e.playerId));
        if (extra) {
            players.push(extra);
        }
        if (players.length > 20) {
            return false;
        }
        const options = players.map(player => this.slotTypes.flatMap((slot, index) => this.fits(player,
            slot) ? [index] : []));
        const order = players.map((_, index) => index).sort((a, b) => options[a].length - options[b].length);
        const taken = Array<number>(20).fill(-1);
        function put(index: number, seen: Set<number>): boolean {
            for (const slot of options[index]) {
                if (seen.has(slot)) {
                    continue;
                }
                seen.add(slot);
                if (taken[slot] === -1 || put(taken[slot], seen)) {
                    taken[slot] = index;
                    return true;
                }
            }
            return false;
        }
        return order.every(index => put(index, new Set()));
    }
    taxi(player: Player) {
        return player.yearsExp === 0 || player.careerGamesComplete && player.careerGames !== null
            && player.careerGames < 65;
    }
    placements(id: number, player: Player, entries = this.team(id)) {
        const result: Placement[] = [];
        if (this.count(entries, "active") < 20 && this.feasible(entries, player)) {
            result.push("active");
        }
        if (this.count(entries, "taxi") < 3 && this.taxi(player)) {
            result.push("taxi");
        }
        if (this.count(entries, "ir") < 2 && player.injuryStatus === "Out") {
            result.push("ir");
        }
        return result;
    }
    placementMax(id: number, entries: Entry[], placement: Placement) {
        return this.budgets.get(id)! - (20 - this.count(entries, "active") - (placement === "active" ? 1 : 0));
    }
    maximum(id: number, player: Player, entries = this.team(id)) {
        return Math.max(0, ...this.placements(id, player, entries).map(place => this.placementMax(id, entries, place)));
    }
    available() {
        const sold = new Set(this.roster.map(entry => entry.playerId));
        return this.players.filter(player => !sold.has(player.id));
    }
    canNominate(id: number) {
        return !this.done.has(id) && this.available().some(player => this.maximum(id, player) >= 1);
    }
    requireLot(event: LoggedEvent) {
        assert(this.lot && event.lot_id === this.lot.id, `Wrong lot at event ${event.id}`);
        return this.lot;
    }
    private nominationGeneration = '';
    private nominationSequence = -1;
    apply(event: LoggedEvent) {
        const data = event.data;
        const now = Number(data.now);
        const id = event.manager_id!;
        this.coverage[event.type] = (this.coverage[event.type] || 0) + 1;
        assert(Number.isFinite(now));
        assert(event.created_at.getTime() + 1 >= now, `Event ${event.id} precedes the decision clock`);
        if (typeof data.nominationGeneration === 'string') {
            const [draftId, sequence] = data.nominationGeneration.split(':');
            assert(draftId && Number.isSafeInteger(Number(sequence)));
            if (this.nominationGeneration) {
                assert.equal(draftId, this.nominationGeneration.split(':')[0]);
                assert(Number(sequence) >= this.nominationSequence, 'Nomination generation cannot roll back');
                if (event.type === 'nomination') assert.equal(data.nominationGeneration, this.nominationGeneration);
                if (event.type === 'turn') assert(Number(sequence) > this.nominationSequence);
            }
            this.nominationGeneration = data.nominationGeneration;
            this.nominationSequence = Number(sequence);
        }
        switch (event.type) {
            case "start":
                this.order = data.order as number[];
                assert.deepEqual([...this.order].sort((a, b) => a - b), this.managerIds);
                this.timing = data.timing as Timing;
                break;
            case "turn": {
                const next = Array.from({
                    length: 10
                }, (_, i) => (this.cursor + i) % 10).find(index => this.canNominate(this.order[index]));
                assert.equal(data.index, next, `Incorrect rotation at event ${event.id}`);
                this.cursor = Number(data.index);
                this.nominator = this.order[this.cursor];
                assert.equal(data.nominatorId, this.nominator);
                this.deadline = data.deadline === null ? null : Number(data.deadline);
                this.remaining = data.remainingMs === null ? null : Number(data.remainingMs);
                if (!this.paused) {
                    assert.equal(this.deadline, now + this.timing.nominationMs);
                }
                break;
            }
            case "nomination": {
                assert(!this.paused && !this.lot);
                assert.equal(id, this.nominator);
                const player = this.player(String(data.playerId));
                assert(this.available().some(p => p.id === player.id));
                const amount = Number(data.amount);
                assert(Number.isInteger(amount) && amount >= 1 && amount <= this.maximum(id, player));
                assert.equal(data.nominationDeadline, this.deadline);
                if (data.auto) {
                    this.timers.nominationTimeouts++;
                    assert(now >= this.deadline!);
                    const top = this.available().filter(player => this.maximum(id, player) >= 1).sort((a, b) =>
                        (b.projection ?? -Infinity) - (a.projection ?? -Infinity) || a.id.localeCompare(b.id))[0];
                    assert.equal(player.id, top.id);
                    assert.equal(amount, 1);
                }
                else
                    assert(now < this.deadline!);
                if (this.count(this.team(id), "active") === 20) {
                    this.late.nominations++;
                }
                this.passedTurns.clear();
                this.deadline = Number(data.deadline);
                assert.equal(this.deadline, now + this.timing.biddingMs);
                this.lot = {
                    id: event.lot_id!,
                    playerId: player.id,
                    high: amount,
                    bidder: id,
                    nominator: id,
                    passes: new Set()
                };
                break;
            }
            case "bid": {
                const lot = this.requireLot(event);
                assert(!this.paused && now < this.deadline! && !lot.passes.has(id));
                const amount = Number(data.amount);
                assert(Number.isInteger(amount) && amount > lot.high);
                const maximum = this.maximum(id, this.player(lot.playerId));
                assert(amount <= maximum, `Bid ${event.id} exceeds independently recomputed maximum ${maximum}`);
                this.acceptedBids++;
                if (amount === maximum) this.maxBidHits++;
                const participation = this.bidParticipation.get(id) ?? { acceptedBids: 0, lots: new Set<number>() };
                participation.acceptedBids++;
                participation.lots.add(lot.id);
                this.bidParticipation.set(id, participation);
                assert.equal(data.beforeDeadline, this.deadline);
                const extended = this.deadline! + this.timing.extensionMs;
                const cap = now + this.timing.capMs;
                assert.equal(data.deadline, Math.min(extended, cap));
                if (Number(data.deadline) > this.deadline!) {
                    this.timers.extensions++;
                }
                if (data.deadline === cap && cap < extended) {
                    this.timers.caps++;
                }
                if (this.count(this.team(id), "active") === 20) {
                    this.late.bids++;
                }
                this.deadline = Number(data.deadline);
                lot.high = amount;
                lot.bidder = id;
                break;
            }
            case "pass": {
                const lot = this.requireLot(event);
                assert(!this.paused && id !== lot.bidder && !lot.passes.has(id));
                lot.passes.add(id);
                break;
            }
            case "force":
                this.forced = this.requireLot(event).id;
                break;
            case "sale": {
                assert(!this.paused || data.reason === "force");
                const lot = this.requireLot(event);
                const player = this.player(lot.playerId);
                assert.equal(id, lot.bidder);
                assert.equal(data.price, lot.high);
                assert.equal(data.playerId, player.id);
                const implicit = this.managerIds.filter(other => other !== id && !lot.passes.has(other)
                    && this.maximum(other, player) <= lot.high);
                assert.deepEqual(data.implicitOut, implicit);
                this.implicitGiveUps += implicit.length;
                if (data.reason === "deadline") {
                    assert(now >= this.deadline!);
                    this.timers.expirySales++;
                }
                else if (data.reason === "force") {
                    assert.equal(this.forced, lot.id);
                }
                else {
                    assert.equal(data.reason, "all-out");
                    assert(this.managerIds.every(other => other === id || lot.passes.has(other)
                        || implicit.includes(other)));
                }
                const entries = this.team(id);
                const allowed = this.placements(id, player).filter(place => this.placementMax(id, entries,
                    place) >= lot.high);
                assert.equal(data.placement, allowed[0]);
                if (this.count(entries, "active") === 20) {
                    if (data.placement === "taxi") {
                        this.late.taxiSales++;
                    }
                    if (data.placement === "ir") {
                        this.late.irSales++;
                    }
                }
                this.roster.push({
                    playerId: player.id,
                    managerId: id,
                    placement: data.placement as Placement,
                    price: lot.high,
                    lotId: lot.id
                });
                this.budgets.set(id, this.budgets.get(id)! - lot.high);
                this.sold.push({
                    lotId: lot.id,
                    nominator: lot.nominator
                });
                this.cursor = (this.order.indexOf(lot.nominator) + 1) % 10;
                this.lot = null;
                this.forced = null;
                break;
            }
            case "placement": {
                const entry = this.roster.find(e => e.playerId === data.playerId && e.managerId === id);
                assert(entry);
                assert.equal(data.from, entry.placement);
                const rest = this.team(id).filter(e => e !== entry);
                assert(this.placements(id, this.player(entry.playerId), rest).includes(data.to as Placement));
                if (entry.placement !== data.to) this.passedTurns.delete(id);
                entry.placement = data.to as Placement;
                assert(this.budgets.get(id)! >= 20 - this.count(this.team(id), "active"));
                if (this.lot?.bidder === id) {
                    assert(this.maximum(id, this.player(this.lot.playerId)) >= this.lot.high);
                }
                break;
            }
            case "pause":
                assert(!this.paused);
                assert.equal(data.remainingMs, Math.max(0, this.deadline! - now));
                this.remaining = Number(data.remainingMs);
                this.deadline = null;
                this.paused = true;
                break;
            case "resume":
                assert(this.paused);
                assert.equal(data.deadline, now + this.remaining!);
                this.deadline = Number(data.deadline);
                this.remaining = null;
                this.paused = false;
                break;
            case "undo": {
                const last = this.sold.pop();
                assert(last && last.lotId === event.lot_id);
                const index = this.roster.findIndex(e => e.lotId === last.lotId);
                assert(index >= 0);
                const [entry] = this.roster.splice(index, 1);
                assert.equal(data.placement, entry.placement);
                assert.equal(data.price, entry.price);
                this.budgets.set(entry.managerId, this.budgets.get(entry.managerId)! + entry.price);
                assert.equal(data.voidLotId, this.lot?.id ?? null);
                this.lot = null;
                this.nominator = last.nominator;
                this.done.delete(this.nominator);
                this.passedTurns.clear();
                this.cursor = this.order.indexOf(this.nominator);
                this.paused = true;
                this.complete = false;
                this.deadline = null;
                this.remaining = this.timing.nominationMs;
                break;
            }
            case "done":
                if (data.done) assert.equal(this.count(this.team(id), "active"), 20);
                if (data.done) {
                    this.done.add(id);
                    this.passedTurns.add(id);
                }
                else {
                    this.done.delete(id);
                    this.passedTurns.delete(id);
                }
                if (!this.lot && id === this.nominator && data.done) {
                    this.cursor = (this.order.indexOf(id) + 1) % 10;
                }
                break;
            case "nomination-pass":
                assert.equal(id, this.nominator);
                assert.equal(this.count(this.team(id), "active"), 20);
                assert(now >= this.deadline! && !this.done.has(id));
                this.passedTurns.add(id);
                this.timers.passedTurns++;
                this.cursor = (this.order.indexOf(id) + 1) % 10;
                break;
            case "complete": {
                const eligible = this.managerIds.filter(manager => this.canNominate(manager));
                if (data.reason === "no-eligible-managers") {
                    assert.equal(eligible.length, 0);
                }
                else {
                    assert.equal(data.reason, "full-cycle-passed");
                    assert(eligible.length && eligible.every(manager => this.passedTurns.has(manager)));
                }
                assert.deepEqual(data.passedTurns, [...this.passedTurns]);
                this.complete = true;
                this.lot = null;
                break;
            }
        }
        for (const manager of this.done) {
            assert.equal(this.count(this.team(manager), "active"), 20,
                `Done manager ${manager} has an open active spot at event ${event.id}`);
        }
        if (this.complete) {
            assert(!this.managerIds.some(manager => this.count(this.team(manager), "active") < 20
                && this.available().some(player => this.maximum(manager, player) >= 1)),
            `Draft completes with a legal required nomination at event ${event.id}`);
        }
    }
}
export async function auditDraft(snapshot: { state: AuctionState; events: LoggedEvent[]; lots: Lot[] },
    requireFull = true) {
    const players = snapshot.state.players;
    const managers = snapshot.state.managers;
    const replay = new Replay(players, managers.map(manager => manager.id));
    const events = snapshot.events;
    events.forEach(event => replay.apply(event));
    assert(replay.complete && !replay.lot, "Draft must complete");
    const actual = snapshot.state.roster;
    const byPlayer = (a: Entry, b: Entry) => a.playerId.localeCompare(b.playerId);
    assert.deepEqual([...actual].sort(byPlayer), [...replay.roster].sort(byPlayer));
    const teams = managers.map(manager => {
        const entries = replay.team(manager.id);
        const active = replay.count(entries, "active");
        const taxi = replay.count(entries, "taxi");
        const ir = replay.count(entries, "ir");
        assert.equal(manager.budget, replay.budgets.get(manager.id));
        assert.equal(manager.budget, 1000 - entries.reduce((sum, entry) => sum + entry.price, 0));
        assert.equal(manager.done, replay.done.has(manager.id));
        assert(active <= 20 && taxi <= 3 && ir <= 2 && replay.feasible(entries));
        assert(entries.filter(e => e.placement === "taxi").every(e => replay.taxi(replay.player(e.playerId))));
        assert(entries.filter(e => e.placement === "ir").every(e => replay.player(e.playerId).injuryStatus === "Out"));
        if (requireFull) {
            assert.equal(active, 20, `Manager ${manager.id} must draft twenty active players`);
        }
        return {
            managerId: manager.id,
            budget: manager.budget,
            active,
            taxi,
            ir
        };
    });
    assert.equal(new Set(replay.roster.map(entry => entry.playerId)).size, replay.roster.length);
    const lots = snapshot.lots.reduce<Record<string, number>>((totals, lot) => {
        totals[lot.status] = (totals[lot.status] || 0) + 1;
        return totals;
    }, {});
    assert.equal(lots.sold, replay.roster.length);
    return {
        players: players.length,
        lots,
        sales: replay.coverage.sale || 0,
        finalRosterSize: replay.roster.length,
        activeSize: teams.reduce((sum, team) => sum + team.active, 0),
        teams,
        events: events.length,
        coverage: replay.coverage,
        timers: replay.timers,
        timingMs: replay.timing,
        taxiIrOnlyManagers: replay.late,
        giveUps: replay.coverage.pass || 0,
        implicitGiveUps: replay.implicitGiveUps,
        undos: replay.coverage.undo || 0,
        forceEnds: replay.coverage.force || 0,
        pauses: replay.coverage.pause || 0,
        acceptedBids: replay.acceptedBids,
        maxBidHits: replay.maxBidHits,
        bidParticipation: managers.map(manager => ({
            managerId: manager.id,
            acceptedBids: replay.bidParticipation.get(manager.id)?.acceptedBids ?? 0,
            lotsBidOn: replay.bidParticipation.get(manager.id)?.lots.size ?? 0
        })),
        averageUnspentBudget: teams.reduce((sum, team) => sum + team.budget, 0) / teams.length,
        invariants: {
            uniqueLiveSales: true,
            budgetReplay: true,
            bidReserveAtEveryBid: true,
            deadlineArithmetic: true,
            noEarlyAward: true,
            matchingAndCapacities: true,
            taxiAndIrEligibility: true,
            placementReplay: true,
            nominationRotationAndSkips: true,
            completionCycle: true,
            undoRefundAndTurn: true,
            pauseExactRemaining: true,
            forceEndHighBid: true,
            databaseMatchesReplay: true,
            fullActiveRosters: requireFull,
            noBidExceededIndependentMax: true,
            doneRequiresFullActiveAtEveryEvent: true,
            noPrematureRequiredCompletion: true
        }
    };
}
