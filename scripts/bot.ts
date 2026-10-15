import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { Action, AuctionState, Player } from "../lib/types";
const raceReasons = new Set([
    'Draft is paused', 'Draft is not in progress', 'It is not your nomination turn',
    'Player is no longer available', 'This lot has ended. Refresh and try the current lot.',
    'Bid arrived after the deadline', 'The high bidder cannot give up', 'You already gave up on this player'
]);
export class Bot {
    cookie = "";
    token = "";
    requests = 0;
    rejected: Record<string, number> = {};
    latest: AuctionState | null = null;
    private players: Player[] = [];
    private timer: ReturnType<typeof setInterval> | undefined;
    private polling: Promise<void> | null = null;
    failure: Error | null = null;
    onPoll: ((state: AuctionState) => Promise<void>) | undefined;
    constructor(public id: number, private base: string) {
    }
    async call(path: string, body?: unknown, expectedRejection = false) {
        this.requests++;
        const response = await fetch(`${this.base}/api/${path}`, {
            method: body ? "POST" : "GET",
            headers: {
                "Content-Type": "application/json",
                Cookie: this.cookie,
                Origin: this.base
            },
            body: body ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(60000)
        });
        const result = await response.json();
        if (!response.ok) {
            const reason = String(result.error).replace(/\$\d+/g, "$N");
            this.rejected[`${response.status}: ${reason}`] = (this.rejected[`${response.status}: ${reason}`] || 0) + 1;
            const race = raceReasons.has(String(result.error)) || /^Bid must be a whole dollar above/.test(result.error);
            if (!expectedRejection || ![409, 422].includes(response.status) || !race) {
                throw new Error(`Unexpected HTTP ${response.status}: ${result.error}`);
            }
            return null;
        }
        if (path === "claim") {
            this.token = result.token;
            this.cookie = response.headers.get("set-cookie")!.split(";")[0];
        }
        return result;
    }
    async claim() {
        assert(await this.call("claim", {
            managerId: this.id
        }));
        await this.state();
    }
    async state(): Promise<AuctionState> {
        const omitPool = this.players.length && this.latest?.draft.status !== "setup";
        const state: AuctionState = await this.call(omitPool ? "state?players=0" : "state");
        assert(state);
        assert.equal(state.me, this.id);
        if (omitPool) {
            state.players = this.players;
        }
        else
            this.players = state.players;
        this.latest = state;
        return state;
    }
    async action(action: Action, expectedRejection = false) {
        const result = await this.call("action", action, expectedRejection);
        await this.state();
        return result !== null;
    }
    startPolling(intervalMs = 500) {
        this.timer = setInterval(() => {
            if (this.polling) {
                return;
            }
            this.polling = this.state().then(async state => {
                await this.onPoll?.(state);
            }).catch(error => {
                this.failure = error;
            }).finally(() => {
                this.polling = null;
            });
        }, intervalMs);
    }
    async waitForPoll() {
        await this.polling;
    }
    async stopPolling() {
        clearInterval(this.timer);
        await this.polling;
    }
    async reconnect() {
        const child = spawn(process.execPath, ["node_modules/tsx/dist/cli.mjs", "scripts/reconnect.ts"], {
            stdio: ["pipe", "pipe", "pipe"],
            env: process.env
        });
        let output = "";
        child.stdout.on("data", chunk => {
            output += String(chunk);
        });
        child.stdin.end(JSON.stringify({
            base: this.base,
            token: this.token,
            managerId: this.id
        }));
        const code = await new Promise(resolve => child.once("exit", resolve));
        assert.equal(code, 0);
        const result = JSON.parse(output);
        assert.equal(result.me, this.id);
        this.cookie = result.cookie;
        await this.state();
    }
}
