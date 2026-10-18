import type { AuctionState, Draft, Lot, PrivateState } from '../lib/types';
import { draftDefaults, isAuctionMode } from '../lib/modes';
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import { internal } from './_generated/api';

export class RuleError extends Error {
    constructor(message: string, public status = 422) { super(message); }
}
export const initialDraft = (): Draft => draftDefaults('sealed-v1');
export async function tokenHash(token: string) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
export function randomIndex(limit: number): number {
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
export async function identity(ctx: QueryCtx, token?: string) {
    const seat = token ? /^seat:(\d{1,3})$/.exec(token) : null;
    if (seat) return ctx.db.query('managers').withIndex('id', q => q.eq('id', Number(seat[1]))).unique();
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
    const hash = await tokenHash(token);
    return ctx.db.query('managers').withIndex('tokenHash', q => q.eq('tokenHash', hash)).unique();
}
const joined = (manager: Doc<'managers'>) => manager.tokenHash !== null || manager.joinedAt !== undefined;
export function cleanLot(row: Doc<'lots'>, mode?: Draft['mode']): Lot {
    const revealed = mode === 'live-v1';
    const resolved = ['sold', 'unsold', 'undone'].includes(row.status);
    return { id: row.id, playerId: row.playerId, nominatorId: row.nominatorId,
        highBidderId: (resolved || revealed) ? row.highBidderId : 0, highBid: (resolved || revealed) ? row.highBid : 0,
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
    const sales = includePool ? [] : draft.mode === 'live-v1'
        ? await ctx.db.query('lots').withIndex('status', q => q.eq('status', 'sold')).order('desc').take(30)
        : (await ctx.db.query('lots').withIndex('id').order('desc').take(40))
        .filter(row => ['sold', 'unsold', 'undone'].includes(row.status));
    if (!includePool && draft.mode !== 'live-v1') {
        const latestSale = await ctx.db.query('lots').withIndex('status', q => q.eq('status', 'sold')).order('desc').first();
        if (latestSale && !sales.some(lot => lot.id === latestSale.id)) sales.push(latestSale);
    }
    const recent = includePool || !isAuctionMode(draft.mode) ? []
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
        lot: lot ? cleanLot(lot, draft.mode) : null,
        passes: lot && draft.mode === 'live-v1' ? (await ctx.db.query('passes')
            .withIndex('lotId', q => q.eq('lotId', lot.id)).collect()).map(row => row.managerId) : [],
        sales: sales.map(row => cleanLot(row, draft.mode)),
        recentEvents: recent.filter(e => draft.mode === 'sealed-v1' ? e.sealed : draft.mode === 'live-v1' && e.live).map(e => ({ id: String(e.id), type: e.type, managerId: e.managerId,
            lotId: e.lotId, data: e.data, at: e.at })), serverNow: Date.now() };
}
export async function privateState(ctx: QueryCtx, token: string): Promise<PrivateState | null> {
    const manager = await identity(ctx, token);
    if (!manager) return null;
    const record = await draftRecord(ctx);
    if (record?.value.mode !== 'sealed-v1') return { managerId: manager.id, lotId: record?.value.lotId ?? null, response: null, queue: [] };
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
