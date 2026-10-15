import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { ConvexReactClient } from 'convex/react';
import { makeFunctionReference } from 'convex/server';
import { api, type MutationResult } from '../convex/_generated/api';
import { AuctionClient } from '../lib/client';
import type { Player } from '../lib/types';
import recorded from './fixtures/sleeper-pool.json';
import { localBackend, sleep } from '../scripts/local-backend';

const execute = promisify(execFile);
const require = createRequire(resolve('package.json'));
const { build }: typeof import('esbuild') = require('esbuild');
const session = `pancake-websocket-${crypto.randomUUID()}`;
const interfere = makeFunctionReference<'mutation'>('testOnly:interfereDraft');
async function browser(...args: string[]) {
    return (await execute('agent-browser', ['--session', session, ...args], { timeout: 25000 })).stdout.trim();
}
async function evaluate(expression: string) { return JSON.parse(await browser('eval', expression)); }
async function until(expression: string, timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    do {
        if (await evaluate(expression)) return;
        await sleep(100);
    } while (Date.now() < deadline);
    throw new Error(`Browser condition did not become true: ${expression}`);
}
async function bounded<T>(operation: Promise<T>, label: string) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([operation, new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`${label} did not finish within 25 seconds`)), 25000);
        })]);
    } finally { clearTimeout(timer); }
}
function requireRuleResult(result: MutationResult) {
    assert(result.ok || result.status === 409 || result.status === 422, 'Only auction rule rejections are allowed');
}
async function main() {
    const directory = `${process.env.EVIDENCE_DIR}/websocket`;
    await mkdir(directory, { recursive: true });
    await build({ entryPoints: ['tests/websocket-harness.tsx'], outfile: `${directory}/bundle.js`, bundle: true,
        platform: 'browser', format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } });
    const backend = await localBackend('websocket-retry', true);
    const http = new AuctionClient(backend.url);
    const disconnects: string[] = [];
    const bidders = Array.from({ length: 8 }, () => new ConvexReactClient(backend.url,
        { logger: false, unsavedChangesWarning: false, onServerDisconnectError: message => disconnects.push(message) }));
    const writers = Array.from({ length: 4 }, () => new ConvexReactClient(backend.url,
        { logger: false, unsavedChangesWarning: false }));
    const proof: Record<string, unknown> = { backend: backend.identity, browserTransport: 'native WebSocket',
        httpTransport: 'ConvexHttpClient', adapterUsed: false };
    let stopContention: (() => Promise<void>) | undefined;
    let base = '';
    let token = '';
    const server = createServer(async (request, response) => {
        if (request.url === '/bundle.js') {
            response.setHeader('Content-Type', 'text/javascript');
            response.end(await readFile(`${directory}/bundle.js`));
        } else if (request.url === '/style.css') {
            response.setHeader('Content-Type', 'text/css');
            response.end(await readFile('app/globals.css'));
        } else response.end('<!doctype html><html><head><link rel="stylesheet" href="/style.css"></head>'
            + '<body><div id="root"></div><script>window.roomConfig='
            + JSON.stringify({ url: backend.url, token }) + '</script><script src="/bundle.js"></script></body></html>');
    });
    async function churn() {
        let active = true;
        let commits = 0;
        const safety = setTimeout(() => { active = false; }, 20000);
        const work = Promise.allSettled(writers.map(async writer => {
            while (active) { await writer.mutation(interfere, {}); commits++; }
        }));
        stopContention = async () => {
            active = false;
            clearTimeout(safety);
            const settled = await work;
            assert(settled.every(result => result.status === 'fulfilled'), 'Contention writers must finish cleanly');
            return;
        };
        await sleep(300);
        return { stop: stopContention, count: () => commits };
    }
    async function uiBid(amount: number) {
        await browser('fill', '[aria-label="Bid amount"]', String(amount));
        await browser('click', '.custom button');
    }
    async function idle() {
        await until(`Boolean([...document.querySelectorAll('.commish button')]
            .find(button => button.textContent === 'Pause' && !button.disabled))`);
        assert.equal(await evaluate('document.querySelector(".toast")?.textContent ?? ""'), '',
            'A successful native bid must not show an error toast');
    }
    try {
        await execute('agent-browser', ['session', 'list']);
        await backend.admin('admin:managers');
        await backend.admin('admin:importPlayers', { ...recorded, players: recorded.players as Player[],
            startedAt: Date.now(), sources: ['recorded-public-Sleeper-pool'] });
        const tokens = await Promise.all(Array.from({ length: 10 }, (_, index) => http.claim(index + 1)));
        token = tokens[0];
        await http.act({ type: 'start' }, token);
        await backend.admin('testOnly:configure', { draft: { biddingMs: 300000, capMs: 300000 },
            deadlineAfterMs: 300000 });
        let state = await http.state();
        await http.act({ type: 'nominate', playerId: state.players[0].id, amount: 1,
            nominationGeneration: state.draft.nominationGeneration }, tokens[state.draft.nominatorId! - 1]);
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const address = server.address();
        assert(address && typeof address !== 'string');
        base = `http://127.0.0.1:${address.port}`;
        proof.frontendPort = address.port;
        await browser('open', base);
        await browser('wait', '.bid-controls');
        await Promise.all([...bidders, ...writers].map(client => client.mutation(api.auction.syncTime, {})));
        if (state.draft.nominatorId === 1) {
            await http.act({ type: 'bid', lotId: (await http.state()).lot!.id, amount: 2 }, tokens[1]);
        }
        await uiBid(10);
        await idle();
        proof.healthyControl = await evaluate('window.transport');
        assert.equal((await http.state()).lot!.highBid, 10);
        assert.equal((proof.healthyControl as { closes: unknown[] }).closes.length, 0);
        console.log('PASS Healthy browser bid finishes once without a reconnect');
        await http.act({ type: 'bid', lotId: (await http.state()).lot!.id, amount: 11 }, tokens[1]);
        await until('document.querySelector(".custom input")?.disabled === false');
        await browser('eval', 'window.transport.busyStates = []; window.transport.feedback = []; true');
        state = await http.state();
        const lotId = state.lot!.id;
        const contention = await churn();
        const attempts = bidders.map((client, index) => ({ managerId: index + 3, amount: 42,
            result: client.mutation(api.auction.actOnDraft,
                { token: tokens[index + 2], action: { type: 'bid', lotId, amount: 42 } }) }));
        const outcomes = Promise.allSettled(attempts.map(async attempt => ({ managerId: attempt.managerId,
            amount: attempt.amount, result: await attempt.result })));
        await uiBid(60);
        await until('window.transport.closes.some(close => close.code === 1013 '
            + '&& close.reason.includes("OptimisticConcurrencyControlFailure"))');
        const pending = await evaluate('window.transport.bids.filter(bid => bid.amount === 60)');
        assert(pending.length >= 1);
        await contention.stop();
        const results = (await bounded(outcomes, 'Concurrent Node WebSocket bids')).map(result => {
            if (result.status === 'rejected') throw result.reason;
            return result.value;
        });
        for (const attempt of results) requireRuleResult(attempt.result);
        await idle();
        const wire = await evaluate('window.transport');
        assert(wire.busyStates.includes(true) && wire.busyStates.at(-1) === false,
            'The real page must enter and leave its busy state');
        assert(wire.feedback.length > 0, 'The existing sending or reconnecting feedback must appear');
        const browserErrors = await browser('errors');
        assert.equal(browserErrors, '', 'A native reconnect must not crash the page');
        const sends = wire.bids.filter((bid: { amount: number }) => bid.amount === 60);
        assert(sends.length >= 2, 'The SDK must resend the in-flight native bid after the 1013 close');
        assert.equal(new Set(sends.map((bid: { requestId: number }) => bid.requestId)).size, 1,
            'A resend must retain its request id');
        const response = wire.responses.find((result: { requestId: number }) => result.requestId === sends[0].requestId);
        assert(response?.ok, 'The replayed browser bid must win against lower concurrent bids');
        const inspected = await backend.admin('admin:inspect');
        const bidEvents = inspected.events.filter((event: { type: string; lotId: number }) =>
            event.type === 'bid' && event.lotId === lotId);
        assert.equal(bidEvents.filter((event: { managerId: number; data: { amount: number } }) =>
            event.managerId === 1 && event.data.amount === 10).length, 1, 'The healthy control also applies once');
        assert(results.filter(attempt => !attempt.result.ok).length >= 7,
            'Simultaneous equal bids must retain their rule-rejection control');
        for (const attempt of [...results, { managerId: 1, amount: 60, result: response }]) {
            const count = bidEvents.filter((event: { managerId: number; data: { amount: number } }) =>
                event.managerId === attempt.managerId && event.data.amount === attempt.amount).length;
            assert.equal(count, attempt.result.ok ? 1 : 0, 'Each intended bid commits once or has a rule rejection');
        }
        assert.equal((await http.state()).roster.length, 0, 'No sale occurs during the long test clock');
        proof.nativeWebSocket = { attempts: results.map(attempt => ({ ...attempt, result: attempt.result.ok
            ? { ok: true } : attempt.result })), browser: { response, sends, closes: wire.closes },
            busyCleared: true, busyStates: wire.busyStates, feedback: wire.feedback, browserErrors,
            noRawError: true, exactlyOnce: true, writerCommits: contention.count(), disconnects,
            bidEvents: bidEvents.map((event: { id: number; managerId: number; data: { amount: number } }) =>
                ({ id: event.id, managerId: event.managerId, amount: event.data.amount })) };
        console.log('PASS Native draft contention resends intended bids and clears browser busy state without double apply');
        const httpContention = await churn();
        let requests = 0;
        let aborts = 0;
        const countedFetch: typeof fetch = async (input, init) => {
            requests++;
            const response = await fetch(input, init);
            if (!response.ok) {
                const error = await response.clone().json();
                if (error.code === 'OptimisticConcurrencyControlFailure') {
                    aborts++;
                    await httpContention.stop();
                }
            }
            return response;
        };
        await bounded(new AuctionClient(backend.url, countedFetch)
            .act({ type: 'bid', lotId, amount: 100 }, tokens[1]), 'HTTP bid retry');
        await httpContention.stop();
        assert.equal(aborts, 1, 'The real HTTP path must expose an aborted transaction');
        assert.equal(requests, 2, 'The HTTP helper retries only the aborted attempt');
        const afterHttp = await backend.admin('admin:inspect');
        const httpBids = afterHttp.events.filter((event: { type: string; managerId: number; data: { amount: number } }) =>
            event.type === 'bid' && event.managerId === 2 && event.data.amount === 100);
        assert.equal(httpBids.length, 1);
        proof.httpRetry = { requests, aborts, committedBids: httpBids.length,
            eventId: httpBids[0].id, writerCommits: httpContention.count() };
        console.log('PASS Real HTTP bid conflict retries and commits once');
        const disconnectsBeforeRejection = disconnects.length;
        const rejected = await bidders[0].mutation(api.auction.actOnDraft,
            { token: tokens[2], action: { type: 'bid', lotId: lotId + 1, amount: 90 } });
        assert(!rejected.ok && rejected.status === 409);
        assert.equal(disconnects.length, disconnectsBeforeRejection, 'A rule rejection does not reconnect');
        proof.ruleRejection = { status: rejected.status, error: rejected.error };
        console.log('PASS Native stale-lot rejection stays a rule error');
        proof.result = 'passed';
    } catch (error) {
        proof.result = 'failed';
        proof.error = error instanceof Error ? error.message : String(error);
        throw error;
    } finally {
        try {
            try {
                try { await stopContention?.(); }
                finally { await browser('close'); }
                const deadline = Date.now() + 5000;
                while (true) {
                    const sessions = (await execute('agent-browser', ['session', 'list'])).stdout;
                    if (!sessions.includes(session)) break;
                    assert(Date.now() < deadline, 'The test browser must close');
                    await sleep(50);
                }
                proof.browserClosed = true;
            } finally {
                const closed = await Promise.allSettled([
                    ...[...bidders, ...writers].map(client => client.close()),
                    new Promise<void>(resolve => server.close(() => resolve()))
                        .then(() => { proof.frontendClosed = true; }),
                    backend.close()
                ]);
                for (const result of closed) if (result.status === 'rejected') throw result.reason;
            }
        } catch (error) {
            proof.result = 'failed';
            proof.cleanupError = error instanceof Error ? error.message : String(error);
            throw error;
        } finally {
            await writeFile(`${process.env.EVIDENCE_DIR}/websocket-retry.json`, JSON.stringify(proof, null, 2));
        }
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
