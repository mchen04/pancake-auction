import { counts, legalPlacements, maxBid } from '../lib/rules';
import type { AuctionState, Player } from '../lib/types';
import { Bot } from './bot';
import { seededFraction, Strategy } from './strategy';

type TurnPlan = { timeout: boolean; player: Player | null; amount: number; attempted: boolean };

export class Competition {
    enabled = false;
    snipes = 0;
    nominations = 0;
    private strategies: Map<number, Strategy>;
    private turns = new Map<string, TurnPlan>();
    private nextBid = new Map<number, number>();
    private sniped = new Set<string>();
    private reserved: Set<string>;
    constructor(readonly bots: Bot[], readonly seed: number, players: Player[], reserved: Player[]) {
        this.strategies = new Map(bots.map(bot => [bot.id, new Strategy(seed, bot.id, players)]));
        this.reserved = new Set(reserved.map(player => player.id));
    }
    async suspend() {
        this.enabled = false;
        await Promise.all(this.bots.map(bot => bot.waitForPoll()));
    }
    start() {
        this.bots.forEach(bot => { bot.onPoll = state => this.step(bot, state); });
        this.enabled = true;
    }
    profiles() {
        return [...this.strategies.values()].map(strategy => ({
            managerId: strategy.managerId, bias: strategy.bias, patience: strategy.patience,
            holdBudget: strategy.holdBudget
        }));
    }
    clockLot(lotId: number) {
        const rate = 0.27 + seededFraction(this.seed, 'clock-rate') * 0.06;
        return seededFraction(this.seed, `clock:${lotId}`) < rate;
    }
    planTurn(bot: Bot, state: AuctionState, strategy: Strategy) {
        const key = `${bot.id}:${state.draft.deadline}`;
        const cached = this.turns.get(key);
        if (cached) return cached;
        const entries = state.roster.filter(entry => entry.managerId === bot.id);
        const manager = state.managers.find(manager => manager.id === bot.id)!;
        const sold = new Set(state.roster.map(entry => entry.playerId));
        const candidates = state.players.filter(player => !sold.has(player.id) && !this.reserved.has(player.id)
            && legalPlacements(player, entries, state.players).includes('active'));
        const scored = candidates.map(player => ({ player, value: strategy.valuation(state, player) }))
            .sort((a, b) => b.value - a.value || a.player.id.localeCompare(b.player.id));
        const turnNumber = this.turns.size;
        const choice = Math.floor(strategy.draw(`nominee:${turnNumber}`) * Math.min(scored.length, 8));
        const selected = scored[choice];
        const timeout = seededFraction(this.seed, `timeout:${turnNumber}`) < 0.07;
        const maximum = selected ? maxBid(manager.budget, selected.player, entries, state.players) : 0;
        const plan = {
            timeout, player: selected?.player ?? null, attempted: false,
            amount: selected ? strategy.opening(selected.value, maximum, String(turnNumber)) : 1
        };
        this.turns.set(key, plan);
        return plan;
    }
    async nominate(bot: Bot, state: AuctionState, strategy: Strategy) {
        if (state.draft.nominatorId !== bot.id) return;
        const entries = state.roster.filter(entry => entry.managerId === bot.id);
        if (counts(entries).active === 20) return;
        const plan = this.planTurn(bot, state, strategy);
        if (plan.timeout || plan.attempted || !plan.player) return;
        plan.attempted = true;
        if (await bot.action({ type: 'nominate', playerId: plan.player.id, amount: plan.amount }, true)) {
            this.nominations++;
        }
    }
    async step(bot: Bot, state: AuctionState) {
        if (!this.enabled || state.draft.status !== 'running') return;
        const strategy = this.strategies.get(bot.id)!;
        if (!state.lot) return this.nominate(bot, state, strategy);
        const lot = state.lot;
        if (lot.highBidderId === bot.id || state.passes.includes(bot.id)) return;
        const player = state.players.find(player => player.id === lot.playerId)!;
        const manager = state.managers.find(manager => manager.id === bot.id)!;
        const entries = state.roster.filter(entry => entry.managerId === bot.id);
        const maximum = maxBid(manager.budget, player, entries, state.players);
        if (maximum <= lot.highBid) return;
        const value = Math.min(maximum, strategy.valuation(state, player));
        const clock = this.clockLot(lot.id);
        if (value <= lot.highBid) {
            if (!clock) await bot.action({ type: 'pass', lotId: lot.id }, true);
            return;
        }
        const scale = state.draft.biddingMs / 10000;
        const sniperKey = `${bot.id}:${lot.id}`;
        const sniper = clock && strategy.draw(`sniper:${lot.id}`) < 0.12;
        if (sniper) {
            if (this.sniped.has(sniperKey)) return;
            const window = (1000 + strategy.draw(`window:${lot.id}`) * 2000) * scale;
            if (state.draft.deadline! - state.serverNow > window) return;
        }
        if (state.serverNow < (this.nextBid.get(bot.id) ?? 0)) return;
        this.nextBid.set(bot.id, state.serverNow + strategy.patience * 1000 * scale);
        const amount = strategy.bidAmount(lot.highBid, value, maximum, lot.id);
        if (amount <= lot.highBid) return;
        const accepted = await bot.action({ type: 'bid', lotId: lot.id, amount }, true);
        if (sniper && accepted) {
            this.sniped.add(sniperKey);
            this.snipes++;
        }
    }
}
