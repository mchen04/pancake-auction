import { canNominate, counts, legalPlacements, maxBid, placementMax, timeoutNominee } from '../lib/rules';
import { amountError, automaticResponses, DAY, legalMaximum, queueReason, reorderQueue, resolveSealed, selectQueue } from '../lib/sealed';
import type { AuctionState, Draft, Entry, Lot, Manager, Player, PrivateState, QueueAction, SealedResponse } from '../lib/types';
import type { Infer } from 'convex/values';
import { action as actionValidator } from './validators';
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import { internal } from './_generated/api';

type WireAction = Infer<typeof actionValidator>;
export class RuleError extends Error {
    constructor(message: string, public status = 422) { super(message); }
}
export const initialDraft = (): Draft => ({ mode: 'sealed-v1', tiePriority: [], status: 'setup',
    nominationGeneration: '', turnSequence: 0, phase: 'nomination', order: [], turnIndex: 0,
    nominatorId: null, lotId: null, deadline: null, remainingMs: null, nominationMs: DAY, biddingMs: DAY,
    extensionMs: 0, capMs: DAY, passedTurns: [], completionReason: null });
export async function tokenHash(token: string) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
function randomIndex(limit: number): number {
    const ceiling = Math.floor(4294967296 / limit) * limit;
    let value: number;
    do { value = crypto.getRandomValues(new Uint32Array(1))[0]; } while (value >= ceiling);
    return value % limit;
}
export async function draftRecord(ctx: QueryCtx) {
    return ctx.db.query('drafts').withIndex('key', q => q.eq('key', 'auction')).unique();
}
// Trusted league: anyone may select any manager, from any number of devices. A seat reference is the nonsecret
// `seat:<managerId>`. A 64-hex device token from the earlier exclusive-claim model still resolves to its seat.
export const seatReference = (managerId: number) => `seat:${managerId}`;
async function identity(ctx: QueryCtx, token?: string) {
    const seat = token ? /^seat:(\d{1,3})$/.exec(token) : null;
    if (seat) return ctx.db.query('managers').withIndex('id', q => q.eq('id', Number(seat[1]))).unique();
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
    const hash = await tokenHash(token);
    return ctx.db.query('managers').withIndex('tokenHash', q => q.eq('tokenHash', hash)).unique();
}
const joined = (manager: Doc<'managers'>) => manager.tokenHash !== null || manager.joinedAt !== undefined;
export function cleanLot(row: Doc<'lots'>): Lot {
    const resolved = ['sold', 'unsold', 'undone'].includes(row.status);
    return { id: row.id, playerId: row.playerId, nominatorId: row.nominatorId,
        highBidderId: resolved ? row.highBidderId : 0, highBid: resolved ? row.highBid : 0,
        status: row.status, player: row.player, eligibleIds: row.eligibleIds ?? [],
        respondedIds: row.respondedIds ?? [], ...(resolved ? { bids: row.bids, tied: row.tied } : {}) };
}
export async function load(ctx: QueryCtx, token?: string, includePool = true, fullPool = true): Promise<AuctionState> {
    const record = await draftRecord(ctx);
    const managers = await ctx.db.query('managers').withIndex('id').collect();
    const me = await identity(ctx, token);
    const draft: Draft = record ? { ...record.value,
        controlGeneration: `${record._id}:${record.controlSequence ?? 0}`,
        turnSequence: record.turnSequence ?? record.value.turnSequence ?? 0,
        nominationGeneration: record.value.nominationGeneration ?? `${record._id}:0` } : initialDraft();
    const latest = await ctx.db.query('imports').order('desc').first();
    const pool = includePool && fullPool ? await ctx.db.query('pools').unique() : null;
    const lot = draft.lotId === null ? null : await ctx.db.query('lots')
        .withIndex('id', q => q.eq('id', draft.lotId!)).unique();
    const sales = includePool ? [] : (await ctx.db.query('lots').withIndex('id').order('desc').take(40))
        .filter(row => ['sold', 'unsold', 'undone'].includes(row.status));
    if (!includePool) {
        const latestSale = await ctx.db.query('lots').withIndex('status', q => q.eq('status', 'sold')).order('desc').first();
        if (latestSale && !sales.some(lot => lot.id === latestSale.id)) sales.push(latestSale);
    }
    const recent = includePool || draft.mode !== 'sealed-v1' ? []
        : await ctx.db.query('events').withIndex('id').order('desc').take(30);
    const roster = await ctx.db.query('roster').collect();
    const neededPlayers = new Map(roster.map(entry => [entry.playerId, entry.player]));
    if (lot) neededPlayers.set(lot.playerId, lot.player);
    return { poolRevision: latest?.revision ?? '0', draft,
        managers: managers.map(m => ({ id: m.id, name: m.name, commissioner: m.commissioner,
            budget: m.budget, done: m.done, claimed: joined(m) })), me: me?.id ?? null,
        players: pool?.players ?? (includePool ? [...neededPlayers.values()] : []),
        roster: roster.map(r => ({ playerId: r.playerId, managerId: r.managerId,
            placement: r.placement, price: r.price, lotId: r.lotId })),
        lot: lot ? cleanLot(lot) : null, passes: [], sales: sales.map(cleanLot),
        recentEvents: recent.filter(e => e.sealed).map(e => ({ id: String(e.id), type: e.type, managerId: e.managerId,
            lotId: e.lotId, data: e.data, at: e.at })), serverNow: Date.now() };
}
export async function privateState(ctx: QueryCtx, token: string): Promise<PrivateState | null> {
    const manager = await identity(ctx, token);
    if (!manager) return null;
    const record = await draftRecord(ctx);
    const lotId = record?.value.lotId ?? null;
    const row = lotId === null ? null : await ctx.db.query('responses').withIndex('owner', q =>
        q.eq('lotId', lotId).eq('managerId', manager.id)).unique();
    const queue = await ctx.db.query('queues').withIndex('managerId', q => q.eq('managerId', manager.id)).unique();
    return { managerId: manager.id, lotId, response: row ? { managerId: row.managerId,
        amount: row.amount, ...(row.automatic ? { automatic: row.automatic } : {}) } : null,
    queue: queue?.entries ?? [] };
}
export class Store {
    resolvedLots = 0;
    nextLot: number;
    nextEvent: number;
    nominationSequence: number;
    turnSequence: number;
    controlSequence: number;
    constructor(public ctx: MutationCtx, public record: Doc<'drafts'>) {
        this.nextLot = record.nextLot;
        this.nextEvent = record.nextEvent;
        this.nominationSequence = record.nominationSequence ?? 0;
        this.turnSequence = record.turnSequence ?? record.value.turnSequence ?? 0;
        this.controlSequence = record.controlSequence ?? 0;
    }
    renewControl(s: AuctionState) { s.draft.controlGeneration = `${this.record._id}:${++this.controlSequence}`; }
    renewNomination(s: AuctionState) { s.draft.nominationGeneration = `${this.record._id}:${++this.nominationSequence}`; }
    renewTurn(s: AuctionState) { s.draft.turnSequence = ++this.turnSequence; this.renewNomination(s); }
    async ensurePool(s: AuctionState) { s.players = (await this.ctx.db.query('pools').unique())?.players ?? []; }
    async updateLot(id: number, changes: Partial<Lot>) {
        const stored = await this.ctx.db.query('lots').withIndex('id', q => q.eq('id', id)).unique();
        if (!stored) throw new Error('Missing lot');
        await this.ctx.db.patch(stored._id, changes);
    }
    async save(s: AuctionState) {
        const stored = await this.ctx.db.query('managers').collect();
        for (const manager of s.managers) {
            const before = stored.find(m => m.id === manager.id)!;
            if (before.budget !== manager.budget || before.done !== manager.done) {
                await this.ctx.db.patch(before._id, { budget: manager.budget, done: manager.done });
            }
        }
        if (this.nextEvent === this.record.nextEvent && this.nextLot === this.record.nextLot
            && JSON.stringify(s.draft) === JSON.stringify(this.record.value)) return;
        const before = this.record.value;
        const changedDeadline = before.status !== s.draft.status || before.deadline !== s.draft.deadline
            || before.lotId !== s.draft.lotId || before.nominationGeneration !== s.draft.nominationGeneration;
        const version = this.record.version + Number(changedDeadline);
        await this.ctx.db.patch(this.record._id, { value: s.draft, version,
            nextLot: this.nextLot, nextEvent: this.nextEvent, nominationSequence: this.nominationSequence,
            turnSequence: this.turnSequence, controlSequence: this.controlSequence });
        if (changedDeadline && s.draft.status === 'running' && s.draft.deadline !== null) {
            await this.ctx.scheduler.runAt(s.draft.deadline, internal.auction.expire,
                { draftId: this.record._id, lotId: s.draft.lotId, version, deadline: s.draft.deadline });
        }
    }
}
async function event(store: Store, type: string, managerId: number | null, lotId: number | null,
    data: Record<string, unknown>, now: number) {
    await store.ctx.db.insert('events', { sealed: true, id: store.nextEvent++, type, managerId, lotId, data, at: now });
}
function team(s: AuctionState, id: number) { return s.roster.filter(e => e.managerId === id); }
async function resumeRequiredNominations(store: Store, s: AuctionState, now: number) {
    for (const manager of s.managers) {
        if (!manager.done || counts(team(s, manager.id)).active === 20) continue;
        manager.done = false;
        await event(store, 'done', manager.id, null, { done: false, reason: 'active-spot-opened' }, now);
    }
}
async function complete(store: Store, s: AuctionState, reason: string, now: number) {
    Object.assign(s.draft, { status: 'complete', nominatorId: null, deadline: null,
        remainingMs: null, completionReason: reason });
    await event(store, 'complete', null, null, { reason }, now);
}
async function executeQueue(store: Store, s: AuctionState, manager: Manager, now: number) {
    if (s.draft.status !== 'running' || s.draft.phase !== 'nomination' || s.draft.nominatorId !== manager.id) return;
    const queue = await store.ctx.db.query('queues').withIndex('managerId', q => q.eq('managerId', manager.id)).unique();
    if (!queue) return;
    const { chosen, remaining } = selectQueue(s, manager, queue.entries);
    await store.ctx.db.patch(queue._id, { entries: remaining });
    if (chosen) await nominate(store, s, manager, s.players.find(player => player.id === chosen.playerId)!, chosen.amount, 'queue', now);
}
async function turn(store: Store, s: AuctionState, from: number, now: number) {
    await store.ensurePool(s);
    const d = s.draft;
    d.lotId = null;
    d.phase = 'nomination';
    s.lot = null;
    const eligible = s.managers.filter(m => canNominate(s, m));
    if (!eligible.length) return complete(store, s, 'no-eligible-managers', now);
    for (let offset = 0; offset < d.order.length; offset++) {
        const index = (from + offset) % d.order.length;
        const manager = eligible.find(m => m.id === d.order[index]);
        if (!manager) continue;
        d.turnIndex = index;
        d.nominatorId = manager.id;
        store.renewTurn(s);
        d.deadline = d.status === 'paused' ? null : now + d.nominationMs;
        d.remainingMs = d.status === 'paused' ? d.nominationMs : null;
        await event(store, 'turn', manager.id, null, { deadline: d.deadline }, now);
        await executeQueue(store, s, manager, now);
        return;
    }
}
async function responses(store: Store, lotId: number): Promise<SealedResponse[]> {
    return (await store.ctx.db.query('responses').withIndex('lotId', q => q.eq('lotId', lotId)).collect())
        .map(row => ({ managerId: row.managerId, amount: row.amount,
            ...(row.automatic ? { automatic: row.automatic } : {}) }));
}
async function respond(store: Store, s: AuctionState, response: SealedResponse) {
    const lot = s.lot!;
    await store.ctx.db.insert('responses', { lotId: lot.id, ...response });
    lot.respondedIds = [...(lot.respondedIds ?? []), response.managerId];
    await store.updateLot(lot.id, { respondedIds: lot.respondedIds });
}
async function resolveLot(store: Store, s: AuctionState, reason: 'deadline' | 'all-responded', now: number) {
    const lot = s.lot;
    if (s.draft.status !== 'running' || !lot || lot.status !== 'open') return;
    if (++store.resolvedLots > s.managers.length * 25 + 1) throw new Error('Automatic resolution limit exceeded');
    const bids = await responses(store, lot.id);
    for (const manager of s.managers) {
        if (!bids.some(bid => bid.managerId === manager.id)) bids.push({ managerId: manager.id, amount: 0, automatic: 'deadline' });
    }
    bids.sort((a, b) => a.managerId - b.managerId);
    const priorityBefore = [...s.draft.tiePriority!];
    const result = resolveSealed(priorityBefore, bids);
    if (result.winnerId !== null) {
        await store.ensurePool(s);
        const manager = s.managers.find(m => m.id === result.winnerId)!;
        const player = s.players.find(p => p.id === lot.playerId)!;
        const entries = team(s, manager.id);
        const placement = legalPlacements(player, entries, s.players)
            .find(p => placementMax(manager.budget, entries, p) >= result.price);
        if (!placement) throw new Error('Sealed response has no legal placement');
        const entry: Entry = { playerId: player.id, managerId: manager.id, placement, price: result.price, lotId: lot.id };
        await store.ctx.db.insert('roster', { ...entry, player });
        manager.budget -= result.price;
        s.roster.push(entry);
    }
    s.draft.tiePriority = result.priority;
    const status = result.winnerId === null ? 'unsold' : 'sold';
    await store.updateLot(lot.id, { status, highBid: result.price, highBidderId: result.winnerId ?? 0,
        bids, priorityBefore, tied: result.tied });
    lot.status = status;
    await event(store, 'resolution', result.winnerId, lot.id, { playerId: lot.playerId, price: result.price,
        bids, tied: result.tied, priority: result.priority, reason, status }, now);
    await turn(store, s, s.draft.turnIndex + 1, now);
}
async function nominate(store: Store, s: AuctionState, manager: Manager, player: Player,
    amount: number | undefined, source: 'manual' | 'queue' | 'timeout', now: number) {
    const error = amountError(amount, legalMaximum(s, manager, player));
    if (error) throw new RuleError(error);
    const automatic = automaticResponses(s, player);
    const lot: Lot = { id: store.nextLot++, playerId: player.id, nominatorId: manager.id,
        highBidderId: 0, highBid: 0, status: 'open', eligibleIds: s.managers
            .filter(m => !automatic.some(response => response.managerId === m.id)).map(m => m.id), respondedIds: [] };
    await store.ctx.db.insert('lots', { ...lot, player });
    s.lot = lot;
    Object.assign(s.draft, { phase: 'bidding', lotId: lot.id, deadline: now + s.draft.biddingMs, remainingMs: null });
    for (const response of automatic) await respond(store, s, response);
    if (amount !== undefined) await respond(store, s, { managerId: manager.id, amount });
    await event(store, 'nomination', manager.id, lot.id, { playerId: player.id, source, deadline: s.draft.deadline }, now);
    if (amount !== undefined && lot.respondedIds!.length === s.managers.length) await resolveLot(store, s, 'all-responded', now);
}
export async function advance(store: Store, s: AuctionState, now: number) {
    const d = s.draft;
    if (d.status !== 'running' || d.mode !== 'sealed-v1') return;
    if (d.phase === 'bidding') {
        if (d.deadline !== null && now >= d.deadline) await resolveLot(store, s, 'deadline', now);
        else if (s.lot?.respondedIds?.length === s.managers.length) await resolveLot(store, s, 'all-responded', now);
        return;
    }
    await store.ensurePool(s);
    const manager = s.managers.find(m => m.id === d.nominatorId);
    if (!manager || !canNominate(s, manager)) return turn(store, s, d.turnIndex + 1, now);
    if (d.deadline === null || now < d.deadline) return;
    const player = timeoutNominee(s, manager);
    if (player) await nominate(store, s, manager, player, undefined, 'timeout', now);
    else await turn(store, s, d.turnIndex + 1, now);
}
export async function transaction<T>(ctx: MutationCtx, token: string | undefined,
    run: (store: Store, state: AuctionState, now: number) => Promise<T>, validate?: (state: AuctionState) => void) {
    const record = await draftRecord(ctx);
    if (!record) return { ok: false as const, error: 'League managers are not configured', status: 409, serverNow: Date.now() };
    const store = new Store(ctx, record);
    const state = await load(ctx, token, true, false);
    const now = Date.now();
    let validated = false;
    try {
        validate?.(state);
        validated = true;
        await advance(store, state, now);
        const value = await run(store, state, now);
        await store.save(state);
        return { ok: true as const, value: value ?? null, serverNow: now };
    } catch (error) {
        if (!(error instanceof RuleError)) throw error;
        if (validated && state.draft.mode === 'sealed-v1') await store.save(state);
        return { ok: false as const, error: error.message, status: error.status, serverNow: now };
    }
}
function requireSealed(s: AuctionState) {
    if (s.draft.mode !== 'sealed-v1') throw new RuleError('Legacy draft is read-only. Commissioner must arrange migration.', 409);
}
function requireManager(s: AuctionState) {
    const manager = s.managers.find(m => m.id === s.me);
    if (!manager) throw new RuleError('Choose your seat first', 401);
    return manager;
}
export async function changeQueue(ctx: MutationCtx, token: string, action: QueueAction) {
    return transaction(ctx, token, async (store, s, now) => {
        const manager = requireManager(s);
        if (s.draft.status === 'complete') throw new RuleError('Draft is complete', 409);
        await store.ensurePool(s);
        const row = await ctx.db.query('queues').withIndex('managerId', q => q.eq('managerId', manager.id)).unique();
        let entries = row?.entries ?? [];
        if (action.type === 'add') {
            if (entries.length >= 100) throw new RuleError('Queue is limited to 100 players');
            if (entries.some(entry => entry.playerId === action.playerId)) throw new RuleError('Player is already queued');
            const entry = { id: crypto.randomUUID(), playerId: action.playerId,
                ...(action.amount !== undefined ? { amount: action.amount } : {}) };
            const error = queueReason(s, manager, entry);
            if (error) throw new RuleError(error);
            entries = [...entries, entry];
        } else if (action.type === 'reorder') {
            try { entries = reorderQueue(entries, action.ids); }
            catch { throw new RuleError('Queue changed. Refresh and reorder.', 409); }
        } else {
            const entry = entries.find(entry => entry.id === action.id);
            if (!entry) throw new RuleError('Queue entry no longer exists', 409);
            if (action.type === 'remove') entries = entries.filter(entry => entry.id !== action.id);
            else {
                const changed = { id: entry.id, playerId: entry.playerId,
                    ...(action.amount !== undefined ? { amount: action.amount } : {}) };
                const error = queueReason(s, manager, changed);
                if (error) throw new RuleError(error);
                entries = entries.map(entry => entry.id === action.id ? changed : entry);
            }
        }
        if (row) await ctx.db.patch(row._id, { entries });
        else await ctx.db.insert('queues', { managerId: manager.id, entries });
        await executeQueue(store, s, manager, now);
    }, s => { requireManager(s); requireSealed(s); });
}
export async function act(ctx: MutationCtx, action: WireAction, token: string) {
    return transaction(ctx, token, async (store, s, now) => {
        const m = requireManager(s);
        const d = s.draft;
        if (action.type === 'release') {
            const row = await ctx.db.query('managers').withIndex('id', q => q.eq('id', action.managerId)).unique();
            if (!row) throw new RuleError('Manager does not exist');
            await ctx.db.patch(row._id, { tokenHash: null });
            await event(store, 'release', m.id, null, { managerId: row.id }, now);
            return;
        }
        if (action.type === 'start') {
            if (d.status !== 'setup') throw new RuleError('Draft has already started', 409);
            await store.ensurePool(s);
            if (s.managers.length !== 10 || s.managers.filter(m => m.commissioner).length !== 1)
                throw new RuleError('Configure ten managers and one commissioner');
            if (!s.players.length) throw new RuleError('Import players before starting');
            if (s.roster.length || await ctx.db.query('lots').first()) throw new RuleError('Existing lots require commissioner migration', 409);
            if (d.mode !== 'sealed-v1') Object.assign(d, initialDraft());
            d.order = s.managers.map(m => m.id);
            for (let i = d.order.length - 1; i > 0; i--) {
                const j = randomIndex(i + 1);
                [d.order[i], d.order[j]] = [d.order[j], d.order[i]];
            }
            d.tiePriority = [...d.order].reverse();
            d.status = 'running';
            store.renewControl(s);
            await event(store, 'start', m.id, null, { order: d.order, tiePriority: d.tiePriority }, now);
            return turn(store, s, 0, now);
        }
        if (action.type === 'undo') {
            const sale = await ctx.db.query('lots').withIndex('status', q => q.eq('status', 'sold')).order('desc').first();
            if (!sale || sale.id !== action.lotId) throw new RuleError('The latest sale has changed. Review it before undoing.', 409);
            if (!sale.priorityBefore) throw new RuleError('Legacy sale cannot be undone by sealed rules', 409);
            if (s.lot) await store.updateLot(s.lot.id, { status: 'void' });
            const removed = await ctx.db.query('roster').withIndex('lotId', q => q.eq('lotId', sale.id)).unique();
            if (!removed) throw new Error('Sold lot has no roster entry');
            await ctx.db.delete(removed._id);
            await store.updateLot(sale.id, { status: 'undone' });
            s.roster = s.roster.filter(entry => entry.lotId !== sale.id);
            s.managers.find(manager => manager.id === sale.highBidderId)!.budget += sale.highBid;
            s.managers.find(manager => manager.id === sale.nominatorId)!.done = false;
            await resumeRequiredNominations(store, s, now);
            Object.assign(d, { tiePriority: sale.priorityBefore, completionReason: null,
                status: 'paused', phase: 'nomination', turnIndex: d.order.indexOf(sale.nominatorId),
                nominatorId: sale.nominatorId, lotId: null, deadline: null, remainingMs: d.nominationMs });
            s.lot = null;
            store.renewTurn(s);
            store.renewControl(s);
            await event(store, 'undo', m.id, sale.id, { playerId: sale.playerId, price: sale.highBid }, now);
            return;
        }
        if (action.type === 'pause') {
            if (d.status !== 'running' || action.expectedRunning !== d.controlGeneration)
                throw new RuleError('Draft changed. Review before pausing.', 409);
            d.remainingMs = Math.max(0, (d.deadline ?? now) - now);
            d.deadline = null;
            d.status = 'paused';
            store.renewControl(s);
            store.renewNomination(s);
            await event(store, 'pause', m.id, d.lotId, { remainingMs: d.remainingMs }, now);
            return;
        }
        if (action.type === 'resume') {
            if (d.status !== 'paused' || action.expectedPause !== d.controlGeneration)
                throw new RuleError('Draft changed. Review before resuming.', 409);
            d.status = 'running';
            d.deadline = now + (d.remainingMs ?? 0);
            d.remainingMs = null;
            store.renewControl(s);
            store.renewNomination(s);
            await event(store, 'resume', m.id, d.lotId, { deadline: d.deadline }, now);
            await advance(store, s, now);
            if (d.phase === 'nomination') {
                await store.ensurePool(s);
                const manager = s.managers.find(m => m.id === d.nominatorId);
                if (manager) await executeQueue(store, s, manager, now);
            }
            return;
        }
        if (d.status === 'complete' || d.status === 'setup') throw new RuleError('Draft is not in progress', 409);
        if (action.type === 'place') {
            const entry = s.roster.find(e => e.playerId === action.playerId && e.managerId === m.id);
            if (!entry) throw new RuleError('You can only move your own players');
            const player = s.players.find(p => p.id === entry.playerId)!;
            const rest = team(s, m.id).filter(e => e !== entry);
            if (!legalPlacements(player, rest, s.players).includes(action.placement)) throw new RuleError('Player cannot use that placement');
            const changed = [...rest, { ...entry, placement: action.placement }];
            if (m.budget < 20 - counts(changed).active) throw new RuleError('Keep $1 for each open active spot');
            if (s.lot) {
                const own = await ctx.db.query('responses').withIndex('owner', q => q.eq('lotId', s.lot!.id).eq('managerId', m.id)).unique();
                const lotPlayer = s.players.find(p => p.id === s.lot!.playerId)!;
                const maximum = maxBid(m.budget, lotPlayer, changed, s.players);
                if (own && own.amount > maximum) throw new RuleError('This move would invalidate your sealed response');
                if (!own && maximum < 1) await respond(store, s, { managerId: m.id, amount: 0, automatic: 'ineligible' });
            }
            const stored = await ctx.db.query('roster').withIndex('playerId', q => q.eq('playerId', player.id)).unique();
            await ctx.db.patch(stored!._id, { placement: action.placement });
            entry.placement = action.placement;
            await resumeRequiredNominations(store, s, now);
            await event(store, 'placement', m.id, entry.lotId, { playerId: player.id, to: action.placement }, now);
            if (s.lot?.respondedIds?.length === s.managers.length) await resolveLot(store, s, 'all-responded', now);
            else await advance(store, s, now);
            return;
        }
        if (d.status !== 'running') throw new RuleError('Draft is paused', 409);
        if ((action.type === 'nominate' || action.type === 'done' && d.phase === 'nomination' && d.nominatorId === m.id)
            && action.nominationGeneration !== d.nominationGeneration) throw new RuleError('That nomination turn has ended', 409);
        if (action.type === 'done') {
            const c = counts(team(s, m.id));
            if (action.done && (c.active !== 20 || c.taxi === 3 && c.ir === 2))
                throw new RuleError('Done is available when only taxi or IR openings remain');
            m.done = action.done;
            await event(store, 'done', m.id, d.lotId, { done: m.done }, now);
            if (d.phase === 'nomination') await advance(store, s, now);
            return;
        }
        if (action.type === 'nominate') {
            if (d.phase !== 'nomination' || d.nominatorId !== m.id) throw new RuleError('It is not your nomination turn', 409);
            await store.ensurePool(s);
            const player = s.players.find(p => p.id === action.playerId && !s.roster.some(e => e.playerId === p.id));
            if (!player) throw new RuleError('Player is no longer available', 409);
            return nominate(store, s, m, player, action.amount, 'manual', now);
        }
        if (!s.lot || action.lotId !== s.lot.id || d.phase !== 'bidding') throw new RuleError('This lot has ended', 409);
        const lot = s.lot;
        if (lot.respondedIds?.includes(m.id)) throw new RuleError('Your response is final. You already responded.', 409);
        const player = s.players.find(p => p.id === lot.playerId)!;
        const maximum = legalMaximum(s, m, player);
        const amount = action.type === 'pass' ? 0 : action.amount;
        if (action.type === 'bid') {
            const error = amountError(amount, maximum);
            if (error) throw new RuleError(error);
        }
        await respond(store, s, { managerId: m.id, amount });
        if (lot.respondedIds!.length === s.managers.length) await resolveLot(store, s, 'all-responded', now);
    }, s => {
        const manager = requireManager(s);
        if (['start', 'pause', 'resume', 'undo', 'release'].includes(action.type) && !manager.commissioner)
            throw new RuleError('Commissioner only', 403);
        if (action.type !== 'release' && !(action.type === 'start' && s.draft.status === 'setup')) requireSealed(s);
        if (action.type === 'start' && s.draft.mode !== 'sealed-v1' && (s.roster.length || s.lot))
            throw new RuleError('Legacy draft contains auction data. Commissioner must arrange migration.', 409);
    });
}
export async function claim(ctx: MutationCtx, managerId: number) {
    return transaction(ctx, undefined, async (store, s, now) => {
        const manager = s.managers.find(m => m.id === managerId);
        if (!manager) throw new RuleError('Choose a configured manager');
        // Selecting is never exclusive. The first selection only marks the manager as joined.
        if (!manager.claimed) {
            const row = await ctx.db.query('managers').withIndex('id', q => q.eq('id', managerId)).unique();
            await ctx.db.patch(row!._id, { joinedAt: now });
            await event(store, 'claim', managerId, null, {}, now);
        }
        return seatReference(managerId);
    });
}
export async function restore(ctx: MutationCtx, token: string) {
    const manager = await identity(ctx, token);
    return manager ? { ok: true as const, value: manager.id, serverNow: Date.now() }
        : { ok: false as const, error: 'Seat token is no longer valid', status: 401, serverNow: Date.now() };
}
