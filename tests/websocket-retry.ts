import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { BaseConvexClient, ConvexHttpClient } from 'convex/browser';
import { ConvexReactClient } from 'convex/react';
import { makeFunctionReference } from 'convex/server';
import type { Value } from 'convex/values';
import { api } from '../convex/_generated/api';
import { retryAbortedMutation } from '../lib/mutation-retry';
import { localBackend } from '../scripts/local-backend';

class HttpMutationResults extends BaseConvexClient {
    private http: ConvexHttpClient;
    constructor(url: string) {
        super(url, () => {}, { logger: false, unsavedChangesWarning: false });
        this.http = new ConvexHttpClient(url);
    }
    async mutationInternal(name: string, args: Record<string, Value>) {
        try {
            const value = await this.http.mutation(makeFunctionReference<'mutation'>(name), args, { skipQueue: true });
            return { success: true as const, value, logLines: [] };
        } catch (error) {
            if (!(error instanceof Error)) throw error;
            return { success: false as const, errorMessage: error.message, logLines: [] };
        }
    }
}

async function main() {
    const backend = await localBackend('websocket-retry', true);
    let stopContention = () => {};
    const disconnects: string[] = [];
    const native = new ConvexReactClient(backend.url, { logger: false, unsavedChangesWarning: false,
        onServerDisconnectError: message => { disconnects.push(message); stopContention(); } });
    const options = { baseClient: new HttpMutationResults(backend.url), logger: false as const };
    const wrapped = new ConvexReactClient(backend.url, options);
    const contenders = Array.from({ length: 8 }, () =>
        new ConvexReactClient(backend.url, { logger: false, unsavedChangesWarning: false }));
    const proof: Record<string, unknown> = { client: 'ConvexReactClient', backendRetries: 'default' };
    const contend = makeFunctionReference<'mutation', { reads: number }, number>('testOnly:contend');
    const interfere = makeFunctionReference<'mutation'>('testOnly:interfere');
    async function trial(client: ConvexReactClient) {
        const before = (await native.query(api.auction.state, {})).managers[0].budget;
        let churning = true;
        stopContention = () => { churning = false; };
        const stop = setTimeout(stopContention, 20000);
        let writerCommits = 0;
        const writers = contenders.map(async contender => {
            while (churning) { await contender.mutation(interfere, {}); writerCommits++; }
        });
        const finished = Promise.allSettled(writers);
        let calls = 0;
        let retries = 0;
        const errors: string[] = [];
        const started = Date.now();
        try {
            const result = await retryAbortedMutation(async () => {
                calls++;
                if (calls > 1) await finished;
                try { return await client.mutation(contend, { reads: 4000 }); }
                catch (error) {
                    if (error instanceof Error) errors.push(error.message);
                    throw error;
                }
            }, () => { retries++; stopContention(); });
            await finished;
            const after = (await native.query(api.auction.state, {})).managers[0].budget;
            assert.equal(after - before, writerCommits + 1, 'The victim must commit exactly once');
            return { result, calls, retries, errors, writerCommits, budgetChange: after - before,
                elapsedMs: Date.now() - started };
        } finally {
            stopContention();
            clearTimeout(stop);
            const settled = await finished;
            assert(settled.every(result => result.status === 'fulfilled'), 'Contention writers must finish cleanly');
        }
    }
    try {
        await backend.admin('admin:managers');
        await Promise.all(contenders.map(contender => contender.mutation(api.auction.syncTime, {})));
        const nativeResult = await trial(native);
        proof.nativeWebSocket = { ...nativeResult, disconnects };
        assert(disconnects.some(message =>
            message === 'WebSocket closed with code 1013: OptimisticConcurrencyControlFailure'));
        assert.equal(nativeResult.calls, 1, 'The SDK replays the native WebSocket request itself');
        assert.equal(typeof nativeResult.result, 'number');
        console.log('PASS Real native WebSocket conflict reconnects and replays the write');
        const wrappedResult = await trial(wrapped);
        proof.wrappedError = { ...wrappedResult,
            adapter: 'Unmodified native HTTP abort result through BaseConvexClient.mutation error wrapping' };
        assert(wrappedResult.retries > 0, 'A real backend abort must trigger the browser-wrapper retry path');
        assert.equal(wrappedResult.calls, 2, 'The aborted write retries once after contention stops');
        assert(wrappedResult.errors.every(message => message.startsWith('[CONVEX M(testOnly:contend)] ')
            && message.endsWith('\n  Called by client')));
        console.log('PASS Real backend abort through the browser error wrapper retries and commits');
        const identity = await native.mutation(api.auction.claimSeat, { managerId: 1 });
        assert(identity.ok);
        let rejectionCalls = 0;
        let rejectionRetries = 0;
        const rejected = await retryAbortedMutation(() => {
            rejectionCalls++;
            return native.mutation(api.auction.actOnDraft,
                { token: identity.value, action: { type: 'bid', lotId: 999, amount: 2 } });
        }, () => { rejectionRetries++; });
        assert.equal(rejected.ok, false);
        assert(!rejected.ok && rejected.status === 409);
        assert.equal(rejectionCalls, 1);
        assert.equal(rejectionRetries, 0);
        proof.ruleRejection = { calls: rejectionCalls, retries: rejectionRetries, status: rejected.status,
            error: rejected.error };
        proof.result = 'passed';
        console.log('PASS Rule rejection does not retry through the real WebSocket client');
    } catch (error) {
        proof.result = 'failed';
        proof.error = error instanceof Error ? error.message : String(error);
        throw error;
    } finally {
        await Promise.all([native, wrapped, ...contenders].map(client => client.close()));
        await backend.close();
        await writeFile(`${process.env.EVIDENCE_DIR}/websocket-retry.json`, JSON.stringify(proof, null, 2));
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
