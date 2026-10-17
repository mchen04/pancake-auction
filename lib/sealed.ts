import { maxBid } from './rules';
import type { AuctionState, Manager, Player, QueueEntry, SealedResponse } from './types';

export const DAY = 24 * 60 * 60 * 1000;
export function legalMaximum(state: AuctionState, manager: Manager, player: Player) {
    return maxBid(manager.budget, player, state.roster.filter(entry => entry.managerId === manager.id), state.players);
}
export function amountError(amount: number | undefined, maximum: number): string | undefined {
    if (maximum < 1) return 'No affordable legal placement';
    if (amount === undefined) return;
    if (!Number.isSafeInteger(amount) || amount < 1) return 'Use a positive whole-dollar amount';
    if (amount > maximum) return `Amount exceeds your legal maximum of $${maximum}`;
}
export function queueReason(state: AuctionState, manager: Manager, entry: QueueEntry) {
    const player = state.players.find(player => player.id === entry.playerId);
    if (!player || state.roster.some(row => row.playerId === entry.playerId)
        || state.lot?.playerId === entry.playerId) return 'Player is unavailable';
    return amountError(entry.amount, legalMaximum(state, manager, player));
}
export function selectQueue(state: AuctionState, manager: Manager, entries: QueueEntry[]) {
    const queue = entries.map(entry => ({ ...entry }));
    let chosen: QueueEntry | undefined;
    for (const entry of queue) {
        const reason = queueReason(state, manager, entry);
        if (reason) entry.reason = reason;
        else {
            delete entry.reason;
            chosen = entry;
            break;
        }
    }
    return { chosen, remaining: queue.filter(entry => entry.id !== chosen?.id) };
}
export function reorderQueue(entries: QueueEntry[], ids: string[]) {
    if (ids.length !== entries.length || new Set(ids).size !== ids.length
        || ids.some(id => !entries.some(entry => entry.id === id))) throw new Error('Queue changed. Refresh and reorder.');
    return ids.map(id => entries.find(entry => entry.id === id)!);
}
export function resolveSealed(priority: number[], responses: SealedResponse[]) {
    const price = Math.max(0, ...responses.map(response => response.amount));
    const tiedIds = responses.filter(response => response.amount === price && price > 0).map(response => response.managerId);
    const winnerId = priority.find(id => tiedIds.includes(id)) ?? null;
    if (price > 0 && winnerId === null) throw new Error('Bidder is missing from tie priority');
    const tied = tiedIds.length > 1;
    return { winnerId, price, tied, priority: tied
        ? [...priority.filter(id => id !== winnerId), winnerId!] : [...priority] };
}
export function automaticResponses(state: AuctionState, player: Player): SealedResponse[] {
    return state.managers.filter(manager => legalMaximum(state, manager, player) < 1)
        .map(manager => ({ managerId: manager.id, amount: 0, automatic: 'ineligible' }));
}
