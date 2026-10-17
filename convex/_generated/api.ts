import { makeFunctionReference } from 'convex/server';
import type { Action, AuctionState, Player, Lot, PrivateState, QueueAction } from '../../lib/types';
import type { Id } from './dataModel';
export type MutationResult<T = null> = { ok: true; value: T; serverNow: number }
    | { ok: false; error: string; status: number; serverNow: number };
export const api = { auction: {
    privateSeat: makeFunctionReference<'query', { token: string }, PrivateState | null>('auction:privateSeat'),
    editQueue: makeFunctionReference<'mutation', { token: string; action: QueueAction }, MutationResult>('auction:editQueue'),
    state: makeFunctionReference<'query', { token?: string }, AuctionState>('auction:state'),
    result: makeFunctionReference<'query', { lotId: number }, Lot | null>('auction:result'),
    pool: makeFunctionReference<'query', { revision: string }, { revision: string; players: Player[] }>('auction:pool'),
    claimSeat: makeFunctionReference<'mutation', { managerId: number }, MutationResult<string>>('auction:claimSeat'),
    restoreSeat: makeFunctionReference<'mutation', { token: string }, MutationResult<number>>('auction:restoreSeat'),
    actOnDraft: makeFunctionReference<'mutation', { token: string; action: Action }, MutationResult>('auction:actOnDraft')
} };
export const internal = { auction: {
    expire: makeFunctionReference<'mutation', { draftId: Id<'drafts'>; lotId: number | null;
        version: number; deadline: number }, null>('auction:expire')
} };
