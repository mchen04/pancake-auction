import { ConvexHttpClient } from 'convex/browser';
import { api, type MutationResult } from '../convex/_generated/api';
import type { Action, AuctionState, Player } from './types';

export class RuleError extends Error {
    constructor(message: string, public status = 422) { super(message); }
}
export function unwrap<T>(result: MutationResult<T>): T {
    if (!result.ok) throw new RuleError(result.error, result.status);
    return result.value;
}
export class AuctionClient {
    readonly transport: ConvexHttpClient;
    private pool: { revision: string; players: Player[] } | undefined;
    constructor(public url: string) { this.transport = new ConvexHttpClient(url); }
    async state(token?: string): Promise<AuctionState> {
        const state = await this.transport.query(api.auction.state, token ? { token } : {});
        if (this.pool?.revision !== state.poolRevision) {
            this.pool = await this.transport.query(api.auction.pool, { revision: state.poolRevision });
        }
        return { ...state, players: this.pool.players };
    }
    async claim(managerId: number) {
        return unwrap(await this.transport.mutation(api.auction.claimSeat, { managerId }));
    }
    async restore(token: string) {
        return unwrap(await this.transport.mutation(api.auction.restoreSeat, { token }));
    }
    async act(action: Action, token = '') {
        return unwrap(await this.transport.mutation(api.auction.actOnDraft, { token, action }));
    }
}
