import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage } from 'node:http';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { act, claimSeat, getState, RuleError } from '../lib/engine';
import { counts } from '../lib/rules';
import type { Action } from '../lib/types';
import { loadEnvironment, safeError } from '../scripts/env';
import { createIsolated, dropIsolated, seedManagers, seedPlayers, sleep, sql } from './support';

const execute = promisify(execFile);
const require = createRequire(resolve('package.json'));
const { build }: typeof import('esbuild') = require('esbuild');
const session = `pancake-preference-${randomBytes(6).toString('hex')}`;
const results: { name: string; result: string; error?: string; proof?: unknown }[] = [];
async function browser(...args: string[]) {
    return (await execute('agent-browser', ['--session', session, ...args], { timeout: 20000 })).stdout.trim();
}
async function evaluate(expression: string) {
    return JSON.parse(await browser('eval', expression));
}
async function check(name: string, test: () => Promise<unknown>) {
    try {
        results.push({ name, result: 'passed', proof: await test() });
        console.log(`PASS ${name}`);
    } catch (error) {
        results.push({ name, result: 'failed', error: safeError(error) });
        console.error(`FAIL ${name}: ${safeError(error)}`);
    }
}
async function rosterReady() {
    await seedManagers();
    await seedPlayers();
    const tokens = await Promise.all(Array.from({ length: 10 }, (_, index) => claimSeat(index + 1)));
    await sql('UPDATE draft SET nomination_ms=600000,bidding_ms=600000,cap_ms=600000');
    await act({ type: 'start' }, tokens[0]);
    for (let index = 0; index < 20; index++) {
        let state = await getState();
        await act({ type: 'nominate', playerId: `test-${index}`, amount: 1 },
            tokens[state.draft.nominatorId! - 1]);
        state = await getState();
        if (state.lot!.highBidderId !== 1) await act({ type: 'bid', lotId: state.lot!.id, amount: 2 }, tokens[0]);
        await act({ type: 'force', lotId: state.lot!.id }, tokens[0]);
    }
    const state = await getState(tokens[0]);
    assert.equal(counts(state.roster.filter(entry => entry.managerId === 1)).active, 20);
    return tokens[0];
}
async function actionBody(request: IncomingMessage) {
    const parts: Buffer[] = [];
    for await (const part of request) parts.push(Buffer.from(part));
    return JSON.parse(Buffer.concat(parts).toString()) as Action;
}
async function settled(done: boolean, paused: boolean) {
    const label = done ? 'Nominate again' : 'Skip my nominations';
    for (let attempt = 0; attempt < 50; attempt++) {
        const ready = await evaluate(`(() => {
            const button=document.querySelector('.skip-note button');
            const control=document.querySelector('.commish button:last-child');
            return button?.textContent.trim()===${JSON.stringify(label)} && control?.disabled===false
                && Boolean(document.querySelector('.headline.paused'))===${paused};
        })()`);
        if (ready) return;
        await sleep(100);
    }
    throw new Error('The nomination preference did not render the engine state');
}
async function preference(done: boolean, paused: boolean) {
    await settled(done, paused);
    return evaluate(`(() => {const button=document.querySelector('.skip-note button');
        const id=button.getAttribute('aria-describedby');return {text:button.textContent.trim(),
        disabled:button.disabled,title:button.title,
        description:id?document.getElementById(id)?.textContent.trim():null};
    })()`);
}
async function clickPreference(done: boolean) {
    await settled(done, false);
    await browser('scrollintoview', '.skip-note button');
    const label = done ? 'Nominate again' : 'Skip my nominations';
    await browser('find', 'role', 'button', 'click', '--name', label, '--exact');
    await settled(!done, false);
}
async function main() {
    loadEnvironment();
    const root = process.env.EVIDENCE_DIR;
    assert(root);
    const dir = `${root}/preference`;
    await mkdir(dir, { recursive: true });
    const schema = await createIsolated('test');
    const actions: Action[] = [];
    let closedBrowser = false;
    try {
        const token = await rosterReady();
        await build({ entryPoints: ['tests/preference-harness.tsx'], outfile: `${dir}/bundle.js`, bundle: true,
            platform: 'browser', format: 'iife', jsx: 'automatic',
            define: { 'process.env.NODE_ENV': '"production"' } });
        const server = createServer(async (request, response) => {
            const path = new URL(request.url!, 'http://localhost').pathname;
            try {
                if (path === '/api/state') {
                    response.setHeader('Content-Type', 'application/json');
                    response.end(JSON.stringify(await getState(token)));
                } else if (path === '/api/action') {
                    const action = await actionBody(request);
                    actions.push(action);
                    await act(action, token);
                    response.setHeader('Content-Type', 'application/json');
                    response.end(JSON.stringify({ ok: true }));
                } else if (path === '/bundle.js') {
                    response.setHeader('Content-Type', 'text/javascript');
                    response.end(await readFile(`${dir}/bundle.js`));
                } else if (path === '/style.css') {
                    response.setHeader('Content-Type', 'text/css; charset=utf-8');
                    response.end(await readFile('app/globals.css'));
                } else response.end('<!doctype html><html><head><meta charset="utf-8">'
                    + '<link rel="stylesheet" href="/style.css"></head><body><div id="root"></div>'
                    + '<script src="/bundle.js"></script></body></html>');
            } catch (error) {
                response.statusCode = error instanceof RuleError ? error.status : 500;
                response.setHeader('Content-Type', 'application/json');
                response.end(JSON.stringify({ error: safeError(error) }));
            }
        });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const address = server.address();
        assert(address && typeof address === 'object');
        const base = `http://127.0.0.1:${address.port}`;
        try {
            await browser('open', base);
            await browser('set', 'viewport', '1440', '900');
            await browser('wait', '.room');
            for (const done of [false, true]) {
                await check(`C18 running Done ${done} enables the preference and updates the real engine`, async () => {
                    const proof = await preference(done, false);
                    assert.equal(proof.disabled, false);
                    await clickPreference(done);
                    const after = await getState(token);
                    assert.equal(after.managers[0].done, !done);
                    return { ...proof, doneAfterAction: after.managers[0].done };
                });
            }
            for (const done of [false, true]) {
                if (done) await clickPreference(false);
                await browser('find', 'role', 'button', 'click', '--name', 'Pause', '--exact');
                await check(`C18 paused Done ${done} disables the preference with an accessible reason`, async () => {
                    const proof = await preference(done, true);
                    await browser('scrollintoview', '.skip-note button');
                    await writeFile(`${dir}/paused-${done}.txt`, await browser('snapshot'));
                    await browser('screenshot', `${dir}/paused-${done}.png`);
                    assert.equal(proof.disabled, true);
                    assert.equal(proof.title, 'Available when the draft resumes');
                    assert.equal(proof.description, 'Available when the draft resumes.');
                    return proof;
                });
                const negativeName = `C18 paused Done ${done} server negative control returns 409 without changing Done`;
                await check(negativeName, async () => {
                    const before = await getState(token);
                    const denied = await fetch(`${base}/api/action`, { method: 'POST',
                        body: JSON.stringify({ type: 'done', done: !done }) });
                    assert.equal(denied.status, 409);
                    assert.deepEqual(await denied.json(), { error: 'Draft is paused' });
                    const after = await getState(token);
                    assert.equal(after.managers[0].done, done);
                    assert.equal(after.draft.remainingMs, before.draft.remainingMs);
                    return { status: denied.status, done: after.managers[0].done,
                        remainingMsBefore: before.draft.remainingMs, remainingMsAfter: after.draft.remainingMs };
                });
                await browser('find', 'role', 'button', 'click', '--name', 'Resume', '--exact');
                await settled(done, false);
            }
            await clickPreference(true);
            assert.equal((await getState(token)).managers[0].done, false);
            assert.equal(await evaluate('Boolean(document.querySelector(".toast"))'), false);
            const errors = await browser('errors');
            await writeFile(`${dir}/errors.log`, errors);
            assert.equal(errors, '');
        } finally {
            try { await browser('close'); closedBrowser = true; } finally {
                await new Promise<void>(resolve => server.close(() => resolve()));
            }
        }
    } finally {
        if (!closedBrowser) await browser('close').catch(() => {});
        await dropIsolated(schema);
        await writeFile(`${dir}/results.json`, JSON.stringify(results, null, 2));
        await writeFile(`${dir}/actions.json`, JSON.stringify(actions, null, 2));
    }
    assert(results.every(result => result.result === 'passed'), 'Nomination preference regressions must pass');
}
main().catch(error => { console.error(safeError(error)); process.exitCode = 1; });
