import { writeEvidenceFile as writeFile, bundleEvidence } from '../scripts/evidence';
import { withResources, runBrowser, ownServer, listen } from '../scripts/resources';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer as httpServer } from 'node:http';
import { createServer, connect, type Socket } from 'node:net';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { AuctionClient } from '../lib/client';
import { api } from '../convex/_generated/api';
import { localBackend, sleep, freePort, requireClosedPort } from '../scripts/local-backend';
import recorded from './fixtures/sleeper-pool.json';
import type { Action, AuctionState } from '../lib/types';
import type { MutationResult } from '../convex/_generated/api';
interface Wire {
  nominations: { requestId: number; action: { playerId: string; amount: number } }[];
  responses: { result: MutationResult }[];
  closes: { code: number; at: number }[];
}
function nomination(s: AuctionState, playerId: string, amount: number): Action {
  const generation = (s.draft as unknown as { nominationGeneration?: string }).nominationGeneration;
  return { type: 'nominate', playerId, amount, ...(generation ? { nominationGeneration: generation } : {}) } as Action;
}
async function force(http: AuctionClient, s: AuctionState, token: string) {
  const lot = s.lot!;
  const bound = 'nominationGeneration' in s.draft
    ? { expectedHighBidderId: lot.highBidderId, expectedHighBid: lot.highBid } : {};
  await http.act({ type: 'force', lotId: lot.id, ...bound } as Action, token);
}
const run = promisify(execFile);
const require = createRequire(resolve('package.json'));
const { build }: typeof import('esbuild') = require('esbuild');
const session = `pancake-nomination-replay-${crypto.randomUUID()}`;
const evidence = process.env.EVIDENCE_DIR!;
const proof: Record<string, unknown> = {
  source: process.env.SOURCE_HASH,
  transport: 'Native browser WebSocket through a TCP proxy drops uplink; SDK reconnects and resends',
  credentialSource: 'Generated anonymous local Convex admin key and seat tokens only; never logged',
  fixtureWrites: false
};
async function browser(...args: string[]) {
    return runBrowser(session,args,25000);
}
async function evaluate<T>(expression: string): Promise<T> { return JSON.parse(await browser('eval', expression)); }
async function until(expression: string, timeout = 18000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await evaluate(expression)) return; await sleep(100); }
  throw new Error(`Condition timeout: ${expression}`);
}
async function main() {
  await bundleEvidence(build, { entryPoints: ['tests/nomination-replay-harness.tsx'], outfile: `${evidence}/bundle.js`,
    bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' } });
  const backend = await localBackend('pancake-nomination-replay', false);
  proof.backend = backend.identity;
  const http = new AuctionClient(backend.url);
  const proxyPort = await freePort();
  proof.proxyPort = proxyPort;
  let blackhole = false;
  let droppedBytes = 0;
  const sockets = new Set<Socket>();
  const proxy = ownServer(createServer(downstream => {
    const upstream = connect(backend.identity.port, '127.0.0.1');
    sockets.add(downstream); sockets.add(upstream);
    downstream.on('data', data => { if (blackhole) droppedBytes += data.length; else upstream.write(data); });
    upstream.on('data', data => downstream.write(data));
    downstream.on('error', () => upstream.destroy());
    upstream.on('error', () => downstream.destroy());
    downstream.on('close', () => { sockets.delete(downstream); upstream.destroy(); });
    upstream.on('close', () => { sockets.delete(upstream); downstream.destroy(); });
  }));
  await listen(proxy, proxyPort, '127.0.0.1');
  let token = '';
  const page = ownServer(httpServer(async (request, response) => {
    if (request.url === '/bundle.js') {
      response.setHeader('Content-Type', 'text/javascript');
      response.end(await readFile(`${evidence}/bundle.js`));
    } else if (request.url === '/style.css') {
      response.setHeader('Content-Type', 'text/css');
      response.end(await readFile('app/globals.css'));
    } else {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end('<!doctype html><html><head><link rel="stylesheet" href="/style.css"></head>'
        + '<body><div id="root"></div><script>window.roomConfig='
        + JSON.stringify({ url: `http://127.0.0.1:${proxyPort}`, token })
        + '</script><script src="/bundle.js"></script></body></html>');
    }
  }));
  let pagePort: number | undefined;
  try {
    await run('agent-browser', ['session', 'list']);
    await backend.admin('admin:managers');
    await backend.admin('admin:importPlayers', { ...recorded, startedAt: Date.now(),
      sources: ['stored-public-fixture'] });
    const tokens = [];
    for (let id = 1; id <= 10; id++) tokens.push(await http.claim(id));
    await http.act({ type: 'start' }, tokens[0]);
    let state = await http.state();
    const originalManager = state.draft.nominatorId!;
    const originalDeadline = state.draft.deadline!;
    const originalTurnEvent = state.recentEvents.find(e => e.type === 'turn')?.id;
    token = tokens[originalManager - 1];
    proof.original = { manager: originalManager, deadline: originalDeadline, turnEvent: originalTurnEvent,
      generation: state.draft.nominationGeneration, timing: { nominationMs: state.draft.nominationMs,
        biddingMs: state.draft.biddingMs, extensionMs: state.draft.extensionMs, capMs: state.draft.capMs } };
    await listen(page, 0, '127.0.0.1');
    pagePort = (page.address() as import('node:net').AddressInfo).port;
    proof.frontendPort = pagePort;
    await browser('open', `http://127.0.0.1:${pagePort}`);
    await browser('wait', '[aria-label="Opening bid"]');
    const chosen = [...state.players].sort((a, b) => (b.projection ?? -Infinity) - (a.projection ?? -Infinity))[50];
    await browser('fill', '[aria-label="Search players or team"]', chosen.name);
    await browser('fill', '[aria-label="Opening bid"]', '400');
    await browser('press', '[aria-label="Opening bid"]', 'Tab');
    const before = await browser('snapshot', '-i');
    await writeFile(`${evidence}/before.txt`, before);
    assert(Date.now() < originalDeadline - 300, 'Browser must click within original legal nomination window');
    blackhole = true;
    await browser('click', '.nominate');
    await until('window.wire.nominations.length === 1');
    const initialWire = await evaluate<Wire>('window.wire');
    assert.equal(initialWire.nominations[0].action.playerId, chosen.id);
    assert.equal(initialWire.nominations[0].action.amount, 400);
    proof.initialWire = initialWire;
    state = await http.state();
    assert.equal(state.lot, null, 'Dropped nomination must never reach original turn');
    while (Date.now() <= originalDeadline + 200) await sleep(100);
    state = await http.state();
    while (!state.lot) { await sleep(100); state = await http.state(); }
    assert.notEqual(state.lot.playerId, chosen.id);
    assert(droppedBytes > 0, 'The TCP proxy must drop the original nomination frame');
    proof.autoLot = { lot: state.lot, phase: state.draft.phase };
    const oldLotId = state.lot.id;
    await force(http, state, tokens[0]);
    state = await http.state();
    assert.notEqual(state.draft.nominatorId, originalManager);
    const wrongTurn = await http.transport.mutation(api.auction.actOnDraft,
      { token, action: nomination(state, chosen.id, 400) });
    assert(!wrongTurn.ok && wrongTurn.status === 409);
    proof.wrongTurn = wrongTurn;
    const cycle = [];
    while (state.draft.nominatorId !== originalManager) {
      const player = state.players.find(p => p.id !== chosen.id && !state.roster.some(e => e.playerId === p.id))!;
      const nominator = state.draft.nominatorId!;
      await http.act(nomination(state, player.id, 1), tokens[nominator - 1]);
      state = await http.state();
      cycle.push({ nominator, lotId: state.lot!.id, playerId: player.id });
      await force(http, state, tokens[0]);
      state = await http.state();
    }
    proof.cycle = cycle;
    const budgetBeforeReplay = state.managers.find(m => m.id === originalManager)!.budget;
    proof.later = { manager: state.draft.nominatorId, deadline: state.draft.deadline,
      turnEvent: state.recentEvents.find(e => e.type === 'turn')?.id, roster: state.roster.length,
      generation: state.draft.nominationGeneration, budget: budgetBeforeReplay };
    assert.equal(cycle.length, 9);
    assert.notEqual(state.recentEvents.find(e => e.type === 'turn')?.id, originalTurnEvent);
    blackhole = false;
    for (const socket of sockets) socket.destroy();
    await until('window.wire.responses.length > 0', 8000);
    const wire = await evaluate<Wire>('window.wire');
    proof.wire = wire;
    assert(wire.nominations.length >= 2, 'SDK must resend queued nomination after native reconnect');
    assert.equal(new Set(wire.nominations.map(n => n.requestId)).size, 1);
    const response = wire.responses[0].result;
    state = await http.state();
    proof.replay = { response, lot: state.lot,
      budgetAfter: state.managers.find(m => m.id === originalManager)!.budget };
    assert(!response.ok && response.status === 409, 'A later-turn native replay must be a rule rejection');
    assert.equal(response.error, 'That nomination turn has ended');
    await until('document.querySelector(".toast")?.textContent.includes("That nomination turn has ended")');
    proof.rejectionText = await browser('eval', 'document.querySelector(".toast").textContent');
    await until('document.querySelector(".nominate")?.disabled === false');
    assert.equal(state.lot, null);
    assert.equal(state.managers.find(m => m.id === originalManager)!.budget, budgetBeforeReplay);
    const staleBid = await http.transport.mutation(api.auction.actOnDraft, { token: tokens[originalManager % 10],
      action: { type: 'bid', lotId: oldLotId, amount: 401 } });
    assert(!staleBid.ok && staleBid.status === 409);
    proof.staleBid = staleBid;
    await browser('fill', '[aria-label="Opening bid"]', '1');
    await browser('click', '.nominate');
    await until('window.wire.responses.some(response => response.result.ok)');
    state = await http.state();
    assert.equal(state.lot!.playerId, chosen.id);
    assert.equal(state.lot!.highBid, 1);
    proof.currentTurnControl = state.lot;
    await force(http, state, tokens[0]);
    state = await http.state();
    assert.equal(state.managers.find(m => m.id === originalManager)!.budget, budgetBeforeReplay - 1);
    proof.finalSnapshot = await browser('snapshot', '-i');
    proof.browserErrors = await browser('errors');
    assert.equal(proof.browserErrors, '');
    proof.droppedBytes = droppedBytes;
    proof.result = 'passed';
    console.log('PASS Original nomination frame does not reach server, original timer nominates another player for $1');
    console.log('PASS Nine real public nomination/sale pairs return to the original manager');
    console.log('PASS C19 native browser replay rejects a later nomination turn without spending its budget');
    console.log('PASS C19 current-turn nomination succeeds; wrong manager and stale lot controls reject');
  } catch (error) { proof.result = 'failed'; proof.error = String(error); throw error; }
  finally {
    try {
      try { await browser('close'); }
      finally {
        for (const socket of sockets) socket.destroy();
        await Promise.all([
          new Promise<void>(resolve => proxy.close(() => resolve())),
          new Promise<void>(resolve => page.close(() => resolve())), backend.close()
        ]);
      }
      for (let attempt = 0; ; attempt++) {
        const sessions = (await run('agent-browser', ['session', 'list'])).stdout;
        if (!sessions.includes(session)) break;
        assert(attempt < 100, 'Own browser session must close');
        await sleep(50);
      }
      proof.browserClosed = true;

      await requireClosedPort(proxyPort);
      if (pagePort) await requireClosedPort(pagePort);
      proof.allListenersClosed = true;
    } finally { await writeFile(`${evidence}/proof.json`, JSON.stringify(proof, null, 2)); }
  }
}
withResources(main).catch(error => { console.error(error); process.exitCode = 1; });
