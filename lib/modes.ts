import type { AuctionMode, Draft } from './types';
import { DAY } from './sealed';

export function isAuctionMode(mode: unknown): mode is AuctionMode {
    return mode === 'sealed-v1' || mode === 'live-v1';
}
export function timingDefaults(mode: AuctionMode) {
    return mode === 'live-v1'
        ? { nominationMs: 10000, biddingMs: 10000, extensionMs: 5000, capMs: 15000 }
        : { nominationMs: DAY, biddingMs: DAY, extensionMs: 0, capMs: DAY };
}
export function draftDefaults(mode: AuctionMode): Draft {
    return { mode, ...(mode === 'sealed-v1' ? { tiePriority: [] } : {}), status: 'setup',
        nominationGeneration: '', turnSequence: 0, phase: 'nomination', order: [], turnIndex: 0,
        nominatorId: null, lotId: null, deadline: null, remainingMs: null, ...timingDefaults(mode),
        passedTurns: [], completionReason: null };
}
export function hasDefaultTiming(draft: Draft | undefined) {
    return draft && isAuctionMode(draft.mode) && Object.entries(timingDefaults(draft.mode))
        .every(([key, value]) => draft[key as keyof Draft] === value);
}
export function eventMarker(mode: Draft['mode']) {
    return mode === 'live-v1' ? { live: true } : mode === 'sealed-v1' ? { sealed: true } : {};
}
