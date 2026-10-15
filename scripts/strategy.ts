import { createHash } from 'node:crypto';
import { counts, fits, legalPlacements, matching, maxBid, slots } from '../lib/rules';
import type { AuctionState, Entry, Player } from '../lib/types';

export function seededFraction(seed: number, key: string) {
    const bytes = createHash('sha256').update(`${seed}:${key}`).digest();
    return bytes.readUInt32LE(0) / 4294967296;
}

export class Strategy {
    readonly bias: number;
    readonly patience: number;
    readonly holdBudget: number;
    private lookup: Map<string, Player>;
    constructor(readonly seed: number, readonly managerId: number, readonly players: Player[]) {
        this.bias = 0.85 + this.draw('bias') * 0.3;
        this.patience = 0.25 + this.draw('patience') * 0.45;
        this.holdBudget = managerId <= 2 ? 18 + Math.floor(this.draw('hold') * 12) : 0;
        this.lookup = new Map(players.map(player => [player.id, player]));
    }
    draw(key: string) {
        return seededFraction(this.seed, `${this.managerId}:${key}`);
    }
    need(player: Player, entries: Entry[]) {
        const active = entries.filter(entry => entry.placement === 'active');
        const assigned = matching(active.map(entry => this.lookup.get(entry.playerId)!));
        if (!assigned) return 0;
        const vacancies = slots.slice(0, 10).filter((slot, index) => assigned[index] < 0 && fits(player.positions, slot));
        const crowd = active.filter(entry => this.lookup.get(entry.playerId)!.positions.some(position =>
            player.positions.includes(position))).length;
        return 1 + vacancies.length * 0.08 - Math.min(0.2, crowd * 0.025);
    }
    valuation(state: AuctionState, player: Player) {
        const manager = state.managers.find(manager => manager.id === this.managerId)!;
        const entries = state.roster.filter(entry => entry.managerId === this.managerId);
        if (!legalPlacements(player, entries, state.players).includes('active')) return 0;
        const openings = 20 - counts(entries).active;
        const maximum = maxBid(manager.budget, player, entries, state.players);
        const spendable = Math.max(0, maximum - this.holdBudget);
        const projection = player.projection === null ? 2 : Math.max(0, player.projection);
        const adpValue = player.adp !== null && player.adp > 0 ? 95 / Math.pow(player.adp + 8, 0.55) : 0;
        const base = (projection * 1.7 + adpValue + 3) * this.bias;
        const noise = 0.72 + this.draw(`player:${player.id}`) * 0.65;
        const paced = (manager.budget - this.holdBudget) / openings;
        const closing = openings <= 5 ? spendable * (1 + this.draw(`close:${player.id}`) * 0.25) : 0;
        const value = Math.max(base * noise * this.need(player, entries), paced * 0.85, closing);
        return Math.max(1, Math.min(spendable || 1, Math.round(value)));
    }
    bidAmount(high: number, value: number, maximum: number, lotId: number) {
        if (value >= maximum && this.draw(`max:${lotId}:${high}`) < 0.24) return maximum;
        const increments = [5, 7, 10, 15, 20, 25];
        const roll = this.draw(`increment:${lotId}:${high}`);
        const index = Math.floor(Math.max(0, roll - 0.05) / 0.95 * increments.length);
        const increment = roll < 0.05 ? 1 : increments[index];
        return Math.min(value, maximum, high + increment);
    }
    opening(value: number, maximum: number, key: string) {
        const fraction = this.draw(`opening:${key}`) * 0.2;
        return Math.max(1, Math.min(maximum, Math.floor(value * fraction)));
    }
}
