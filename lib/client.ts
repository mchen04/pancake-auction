import { ConvexHttpClient } from 'convex/browser';
import { api, type MutationResult } from '../convex/_generated/api';
import type { Action, AuctionState, Player, QueueAction } from './types';
import { retryAbortedMutation } from './mutation-retry';

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
    constructor(public url: string, fetch_?: typeof fetch) {
        this.transport = new ConvexHttpClient(url, { fetch: fetch_ });
    }
    async state(token?: string): Promise<AuctionState> {
        const state = await this.transport.query(api.auction.state, token ? { token } : {});
        if (this.pool?.revision !== state.poolRevision) {
            this.pool = await this.transport.query(api.auction.pool, { revision: state.poolRevision });
        }
        return { ...state, players: this.pool.players };
    }
    async privateSeat(token: string) { return this.transport.query(api.auction.privateSeat, { token }); }
    async queue(action: QueueAction, token: string) {
        return unwrap(await this.transport.mutation(api.auction.editQueue, { token, action }));
    }
    async claim(managerId: number) {
        return unwrap(await retryAbortedMutation(() =>
            this.transport.mutation(api.auction.claimSeat, { managerId }, { skipQueue: true })));
    }
    async restore(token: string) {
        return unwrap(await retryAbortedMutation(() =>
            this.transport.mutation(api.auction.restoreSeat, { token }, { skipQueue: true })));
    }
    async act(action: Action, token = '') {
        if (action.type === 'pause' && action.expectedRunning === undefined) {
            action = { ...action, expectedRunning: (await this.state(token)).draft.controlGeneration };
        } else if (action.type === 'resume' && action.expectedPause === undefined) {
            action = { ...action, expectedPause: (await this.state(token)).draft.controlGeneration };
        }
        const intent = action;
        return unwrap(await retryAbortedMutation(() =>
            this.transport.mutation(api.auction.actOnDraft, { token, action: intent }, { skipQueue: true })));
    }
}
