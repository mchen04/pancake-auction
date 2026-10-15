import assert from 'node:assert/strict';
import { execFile, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { buildPool } from '../lib/import-data';
import { safeError } from '../scripts/env';
import { importFixture } from './import-fixture';
import { createIsolated, dropIsolated, seedManagers, seedPlayers, sleep, configure, currentBackend, getState } from './support';

const execute = promisify(execFile);
const session = `pancake-import-${randomBytes(6).toString('hex')}`;
async function browser(...args: string[]) {
    return (await execute('agent-browser', ['--session', session, ...args], { timeout: 20000 })).stdout.trim();
}
async function visible(selector: string, text: string) {
    const query = `document.querySelector(${JSON.stringify(selector)})`;
    const expression = `Boolean(${query}?.innerText.includes(${JSON.stringify(text)}))`;
    for (let attempt = 0; attempt < 30; attempt++) {
        if (JSON.parse(await browser('eval', expression)) === true) return true;
        await sleep(100);
    }
    return false;
}
async function freePort() {
    const listener = createServer();
    await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
    const address = listener.address();
    assert(address && typeof address === 'object');
    await new Promise<void>(resolve => listener.close(() => resolve()));
    return address.port;
}
async function stop(server: ChildProcess) {
    if (server.exitCode !== null || server.signalCode !== null) return;
    const exit = new Promise(resolve => server.once('exit', resolve));
    server.kill('SIGTERM');
    await exit;
}
async function main() {
    const root = process.env.EVIDENCE_DIR;
    if (!root) throw new Error('Set EVIDENCE_DIR');
    await mkdir(root, { recursive: true });
    const dir = await mkdtemp(`${root}/room-import-`);
    await mkdir(`${dir}/import`);
    const schema = await createIsolated('test');
    let server: ChildProcess | undefined;
    let serverLog = '';
    let queryFault = false;
    const receipt: Record<string, unknown> = {};
    try {
        const raw = importFixture();
        await seedManagers();
        await seedPlayers(buildPool(raw).players);
        await configure({ draft: { nominationMs: 600000, biddingMs: 600000 } });
        const port = await freePort();
        server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-p', String(port)], {
            env: { ...process.env, CONVEX_URL: currentBackend().url }, stdio: ['ignore', 'pipe', 'pipe']
        });
        server.stdout!.on('data', data => { serverLog += String(data); });
        server.stderr!.on('data', data => { serverLog += String(data); });
        const base = `http://127.0.0.1:${port}`;
        let ready = false;
        for (let attempt = 0; attempt < 50; attempt++) {
            if (server.exitCode !== null) break;
            try { ready = (await fetch(base)).ok; } catch {}
            if (ready) break;
            await sleep(200);
        }
        assert(ready, 'The production room must start');
        await browser('open', base);
        await browser('find', 'role', 'button', 'click', '--name', 'Michael');
        await browser('wait', '.room');
        assert.equal(await visible('.me', 'Michael'), true);
        const playerId = 'review-added';
        const name = 'Review Added Player';
        raw[0][playerId] = { ...raw[0]['1000'], player_id: playerId, full_name: name };
        raw[1].push({ player_id: playerId, stats: { pts: 1000, adp_dynasty: 1.3 }, company: 'rotowire' });
        const fixture = `${dir}/fixture.json`;
        await writeFile(fixture, JSON.stringify(raw));
        const imported = spawnSync(process.execPath, [
            '--import', 'tsx', '--import', resolve('tests/import-fetch.mjs'), 'scripts/import.ts', '--apply'
        ], {
            encoding: 'utf8', env: { ...process.env, EVIDENCE_DIR: dir, IMPORT_TEST_FIXTURE: fixture,
                CONVEX_LOCAL_DIR: `${currentBackend().identity.directory}/.convex/local/default` }, timeout: 30000
        });
        await writeFile(`${dir}/import.log`, safeError(new Error(imported.stdout + imported.stderr)));
        assert.equal(imported.status, 0);
        receipt.poolRefreshedWithoutReload = await visible('.pool', name);
        await browser('find', 'role', 'button', 'click', '--name', 'Start draft', '--exact');
        let state = await getState();
        for (let attempt = 0; attempt < 30 && state.draft.status === 'setup'; attempt++) {
            await sleep(100);
            state = await getState();
        }
        assert.equal(state.draft.status, 'running');
        await configure({ deadlineAfterMs: 10 });
        for (let attempt = 0; attempt < 50; attempt++) {
            state = await getState();
            if (state.lot) break;
            await sleep(50);
        }
        assert.equal(state.lot?.playerId, playerId);
        receipt.livePlayerVisible = await visible('.block', name);
        const controls = await browser('eval', 'Boolean(document.querySelector(".bid-controls"))');
        receipt.bidControlsVisible = JSON.parse(controls);
        await writeFile(`${dir}/before-reload.txt`, await browser('snapshot'));
        receipt.reloadedBeforeSale = !receipt.bidControlsVisible;
        if (!receipt.bidControlsVisible) {
            await browser('reload');
            await browser('wait', '.room');
            assert.equal(await visible('.block', name), true);
        }
        if (state.lot!.highBidderId !== 1) await browser('click', '.bid-buttons > button:first-child');
        assert.equal(await visible('.high-bid', 'You lead'), true);
        await browser('find', 'role', 'button', 'click', '--name', 'Force end', '--exact');
        await browser('click', '.commish .armed');
        receipt.winningRosterVisible = await visible('.roster', name);
        state = await getState();
        assert(state.roster.some(entry => entry.playerId === playerId && entry.managerId === 1));
        receipt.browserErrors = await browser('errors');
        await writeFile(`${dir}/after-sale.txt`, await browser('snapshot'));
        await browser('reload');
        await browser('wait', '.room');
        receipt.reloadControl = await visible('.roster', name);
        receipt.identitySurvivesReload = await visible('.me', 'Michael');
        assert.equal(receipt.poolRefreshedWithoutReload, true);
        assert.equal(receipt.reloadedBeforeSale, false);
        assert.equal(receipt.livePlayerVisible, true);
        assert.equal(receipt.bidControlsVisible, true);
        assert.equal(receipt.reloadControl, true);
        assert.equal(receipt.identitySurvivesReload, true);
        assert.equal(receipt.winningRosterVisible, true);
        assert.equal(receipt.browserErrors, '');
        console.log('PASS B2/C2 production room follows a real setup import, auction, win and reload');
        receipt.healthyQueryControl = await visible('.room', 'Michael');
        assert.equal(receipt.healthyQueryControl, true);
        await browser('eval', 'window.retryWithoutReload = true; true');
        await currentBackend().admin('testOnly:queryFailure', { enabled: true });
        queryFault = true;
        receipt.forcedQueryBoundaryVisible = await visible('[role="alert"]', 'Could not load the draft room.');
        assert.equal(receipt.forcedQueryBoundaryVisible, true);
        await currentBackend().admin('testOnly:queryFailure', { enabled: false });
        queryFault = false;
        await browser('find', 'role', 'button', 'click', '--name', 'Retry', '--exact');
        await browser('wait', '.room');
        receipt.retryRecovered = await visible('.room', 'Michael');
        receipt.retryWithoutReload = JSON.parse(await browser('eval', 'window.retryWithoutReload === true'));
        assert.equal(receipt.retryRecovered, true);
        assert.equal(receipt.retryWithoutReload, true);
        console.log('PASS query-error boundary catches a real backend failure and Retry recovers without reload');
    } finally {
        if (queryFault) await currentBackend().admin('testOnly:queryFailure', { enabled: false });
        try { await browser('close'); } finally {
            if (server) await stop(server);
            await dropIsolated(schema);
            await writeFile(`${dir}/server.log`, safeError(new Error(serverLog)));
            await writeFile(`${dir}/result.json`, JSON.stringify(receipt, null, 2));
        }
    }
}
main().catch(error => { console.error(safeError(error)); process.exitCode = 1; });
