import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { ConvexHttpClient } from 'convex/browser';
import { api } from '../convex/_generated/api';
import { unwrap, RuleError } from '../lib/client';
import type { Action, AuctionState, Player } from '../lib/types';
import { retryAbortedMutation } from '../lib/mutation-retry';
const raceReasons = new Set([
    'Draft is paused', 'Draft is not in progress', 'It is not your nomination turn',
    'Player is no longer available', 'This lot has ended. Refresh and try the current lot.',
    'Bid arrived after the deadline', 'The high bidder cannot give up', 'You already gave up on this player',
    'The latest sale has changed. Review it before undoing.', 'That nomination turn has ended',
    'The high bid has changed. Review it before forcing a sale.'
]);
export class Bot {
    token = '';
    requests = 0;
    transactionRetries = 0;
    rejected: Record<string, number> = {};
    latest: AuctionState | null = null;
    private client: ConvexHttpClient;
    private players: Player[] = [];
    private timer: ReturnType<typeof setInterval> | undefined;
    private polling: Promise<void> | null = null;
    private serverSample: number | null = null;
    private offset = 0;
    failure: Error | null = null;
    onPoll: ((state: AuctionState) => Promise<void>) | undefined;
    constructor(public id: number, private base: string) { this.client = new ConvexHttpClient(base); }
    async claim() {
        this.token = unwrap(await retryAbortedMutation(() =>
            this.client.mutation(api.auction.claimSeat, { managerId: this.id }), () => this.transactionRetries++));
        await this.state();
    }
    async state(): Promise<AuctionState> {
        this.requests++;
        const state = await this.client.query(api.auction.state, { token: this.token });
        assert.equal(state.me, this.id);
        if (state.serverNow !== this.serverSample) {
            this.serverSample = state.serverNow;
            this.offset = state.serverNow - Date.now();
        }
        if (state.poolRevision !== this.latest?.poolRevision) {
            const pool = await this.client.query(api.auction.pool, { revision: state.poolRevision });
            this.players = pool.players;
        }
        this.latest = { ...state, players: this.players, serverNow: Date.now() + this.offset };
        return this.latest;
    }
    async action(action: Action, expectedRejection = false) {
        this.requests++;
        const result = await retryAbortedMutation(() =>
            this.client.mutation(api.auction.actOnDraft, { token: this.token, action }), () => this.transactionRetries++);
        if (!result.ok) {
            const reason = result.error.replace(/\$\d+/g, '$N');
            const key = `${result.status}: ${reason}`;
            this.rejected[key] = (this.rejected[key] || 0) + 1;
            const race = raceReasons.has(result.error) || /^Bid must be a whole dollar above/.test(result.error);
            if (!expectedRejection || ![409, 422].includes(result.status) || !race) {
                throw new RuleError(`Unexpected Convex rejection ${result.status}: ${result.error}`, result.status);
            }
            await this.state();
            return false;
        }
        await this.state();
        return true;
    }
    async preference(done: boolean) {
        const state = await this.state();
        return this.action({ type: 'done', done, nominationGeneration: state.draft.nominationGeneration });
    }
    startPolling(intervalMs = 500) {
        this.timer = setInterval(() => {
            if (this.polling) return;
            this.polling = this.state().then(async state => { await this.onPoll?.(state); })
                .catch(error => { this.failure = error; }).finally(() => { this.polling = null; });
        }, intervalMs);
    }
    async waitForPoll() { await this.polling; }
    async stopPolling() { clearInterval(this.timer); await this.polling; }
    async close() { await this.stopPolling(); }
    async reconnect() {
        const child = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'scripts/reconnect.ts'],
            { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH, NODE_ENV: 'test' } });
        let output = '';
        child.stdout.on('data', chunk => { output += String(chunk); });
        child.stdin.end(JSON.stringify({ base: this.base, token: this.token, managerId: this.id }));
        const code = await new Promise(resolve => child.once('exit', resolve));
        assert.equal(code, 0);
        assert.equal(JSON.parse(output).me, this.id);
        this.client = new ConvexHttpClient(this.base);
        await this.state();
    }
}
