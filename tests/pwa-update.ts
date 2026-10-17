// Installed-app updates across two real production builds. An iPhone-standalone WebKit client opens build A
// through a local "alias" proxy; the proxy is then swapped to build B (like a production deployment). The open
// client must load B on its next focus with exactly one reload, keep its seat, never reload while an amount is
// being typed, ride out an unreachable version check, and stop after two reloads if the server keeps
// announcing a version it never serves.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { createServer, request as forward } from 'node:http';
import { homedir } from 'node:os';
import { webkit, type Page } from 'playwright-core';
import { AuctionClient } from '../lib/client';
import { DAY } from '../lib/sealed';
import { recordedPool } from '../scripts/pool-source';
import { freePort, localBackend, sleep } from '../scripts/local-backend';
import { withResources, ownProcess, ownCleanup, ownServer, listen } from '../scripts/resources';
import { makeEvidenceDirectory, writeEvidenceFile } from '../scripts/evidence';

const iPhone = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' };
// Build output directories already listed in tsconfig.json, so the builds do not add include entries.
const builds = { a: '.next/verified', b: '.next/verification' } as const;
type Build = keyof typeof builds;

async function main() {
    const root = `${process.env.EVIDENCE_DIR}/pwa-update`;
    await makeEvidenceDirectory(root, { recursive: true });
    const results: { name: string; result: string; error?: string }[] = [];
    const evidence: Record<string, unknown> = { browser: 'Playwright WebKit (not Safari), iPhone standalone emulation' };
    async function check(name: string, run: () => Promise<void>) {
        try { await run(); results.push({ name, result: 'passed' }); console.log(`PASS Playwright WebKit (not Safari): ${name}`); }
        catch (error) { results.push({ name, result: 'failed', error: String(error) }); throw error; }
        finally { await writeEvidenceFile(`${root}/results.json`, JSON.stringify(results, null, 2)); }
    }
    // `next build` points next-env.d.ts at its output directory; put the tracked files back afterwards.
    const tracked = await Promise.all(['next-env.d.ts', 'tsconfig.json'].map(async path => ({ path, body: await readFile(path, 'utf8') })));
    ownCleanup(async () => { for (const { path, body } of tracked) await writeFile(path, body); });

    const run = randomBytes(3).toString('hex');
    const versions: Record<Build, string> = { a: `test-a-${run}`, b: `test-b-${run}` };
    for (const build of ['a', 'b'] as Build[]) {
        const started = Date.now();
        let log = '';
        const child = ownProcess(spawn(process.execPath, ['node_modules/next/dist/bin/next', 'build'], {
            env: { PATH: process.env.PATH, NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1', NEXT_DIST_DIR: builds[build],
                PANCAKE_APP_VERSION: versions[build] }, stdio: ['ignore', 'pipe', 'pipe'] }));
        child.stdout!.on('data', data => { log += String(data); });
        child.stderr!.on('data', data => { log += String(data); });
        const code = await new Promise<number | null>(resolve => child.on('exit', resolve));
        await writeEvidenceFile(`${root}/build-${build}.log`, log);
        assert.equal(code, 0, `next build ${build} failed: ${log.slice(-2000)}`);
        evidence[`build-${build}`] = { version: versions[build], distDir: builds[build], ms: Date.now() - started };
    }
    const chunks = Object.fromEntries(await Promise.all((['a', 'b'] as Build[])
        .map(async build => [build, new Set(await readdir(`${builds[build]}/static/chunks`))]))) as Record<Build, Set<string>>;

    evidence.chunksOnlyInA = [...chunks.a].filter(file => !chunks.b.has(file));
    evidence.chunksOnlyInB = [...chunks.b].filter(file => !chunks.a.has(file));
    const backend = await localBackend('pwa-update', true);
    const client = new AuctionClient(backend.url);
    const source = recordedPool();
    await backend.admin('admin:managers');
    await backend.admin('admin:importPlayers', { players: source.players, ...source.importMetadata, startedAt: Date.now() });
    const commissioner = await client.claim(1);
    await client.act({ type: 'start' }, commissioner);

    const ports = {} as Record<Build, number>;
    const logs: Record<Build, string> = { a: '', b: '' };
    for (const build of ['a', 'b'] as Build[]) {
        ports[build] = await freePort();
        const server = ownProcess(spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-H', '127.0.0.1', '-p', String(ports[build])], {
            env: { PATH: process.env.PATH, NODE_ENV: 'production', NODE_OPTIONS: '--max-old-space-size=1024', CONVEX_URL: backend.url,
                NEXT_TELEMETRY_DISABLED: '1', NEXT_DIST_DIR: builds[build], PANCAKE_APP_VERSION: versions[build] },
            stdio: ['ignore', 'pipe', 'pipe'] }));
        server.stdout!.on('data', data => { logs[build] += String(data); });
        server.stderr!.on('data', data => { logs[build] += String(data); });
        ownCleanup(() => writeEvidenceFile(`${root}/server-${build}.log`, logs[build]));
        for (let i = 0; i < 120; i++) {
            if (server.exitCode !== null) throw new Error(`next start ${build} exited: ${logs[build]}`);
            try { if ((await fetch(`http://127.0.0.1:${ports[build]}/version.json`)).ok) break; } catch {}
            await sleep(250);
        }
    }

    // The "production alias": one origin whose target moves from A to B, as a deployment does.
    let target: Build = 'a';
    let versionMode: 'normal' | 'error' | 'drop' | 'phantom' = 'normal';
    const requests: { at: number; path: string; target: Build; status: number }[] = [];
    const proxy = ownServer(createServer((req, res) => {
        const path = req.url ?? '/';
        const record = (status: number) => requests.push({ at: Date.now(), path, target, status });
        if (path.startsWith('/version.json') && versionMode !== 'normal') {
            if (versionMode === 'drop') { record(0); req.socket.destroy(); return; }
            if (versionMode === 'error') { record(503); res.writeHead(503).end('deploying'); return; }
            record(200);
            res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify({ version: `test-phantom-${run}` }));
            return;
        }
        const upstream = forward({ host: '127.0.0.1', port: ports[target], path, method: req.method,
            headers: { ...req.headers, host: `127.0.0.1:${ports[target]}` } }, response => {
            record(response.statusCode ?? 0);
            res.writeHead(response.statusCode ?? 502, response.headers);
            response.pipe(res);
        });
        upstream.on('error', () => { record(502); res.writeHead(502).end(); });
        req.pipe(upstream);
    }));
    await listen(proxy, 0, '127.0.0.1');
    const address = proxy.address();
    assert(address && typeof address === 'object');
    const origin = `http://127.0.0.1:${address.port}`;
    evidence.origin = origin;
    evidence.servers = ports;

    const cache = `${homedir()}/Library/Caches/ms-playwright`;
    const webkitBuild = (await readdir(cache)).filter(name => name.startsWith('webkit-')).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))[0];
    assert(webkitBuild, 'A cached WebKit build is required');
    const browser = await webkit.launch({ executablePath: `${cache}/${webkitBuild}/pw_run.sh`, headless: true });
    ownCleanup(() => browser.close());
    const context = await browser.newContext(iPhone);
    await context.addInitScript(() => Object.defineProperty(navigator, 'standalone', { value: true }));
    const page = await context.newPage();
    const errors: string[] = [];
    const loads: { at: number }[] = [];
    page.on('pageerror', error => errors.push(String(error)));
    page.on('load', () => { loads.push({ at: Date.now() }); });

    async function until(expression: string, timeout = 30000, on: Page = page) {
        const end = Date.now() + timeout;
        while (Date.now() < end) {
            try { if (await on.evaluate(expression)) return; } catch {}
            await sleep(100);
        }
        throw new Error(`Did not reach: ${expression}`);
    }
    // The app is shown again: the handler, the network check and any reload are all real.
    async function refocus() {
        await sleep(3200);
        await page.evaluate(() => { window.dispatchEvent(new Event('focus')); });
    }
    async function loaded(on: Page = page) {
        return on.evaluate(() => ({
            version: document.documentElement.dataset.version ?? null,
            update: document.documentElement.dataset.update ?? null,
            seat: localStorage.getItem('pancake-seat'),
            me: document.querySelector('.me')?.textContent ?? null,
            scripts: [...document.querySelectorAll('script[src]')].map(script => new URL((script as HTMLScriptElement).src).pathname)
                .filter(path => path.startsWith('/_next/static/chunks/')).map(path => path.slice('/_next/static/chunks/'.length)),
            attempt: sessionStorage.getItem('pancake-update')
        }));
    }
    const frames: unknown[] = [];
    try {
        await check('Standalone client opens build A and keeps its seat choice', async () => {
            await page.goto(origin);
            await until('document.querySelectorAll(".seat-grid button").length === 10');
            await page.locator('.seat-grid button').first().click();
            await until('document.querySelector(".me")?.textContent === "Michael"');
            await until('document.documentElement.dataset.update === "current"');
            const state = await loaded();
            frames.push({ step: 'A', ...state });
            assert.equal(state.version, versions.a);
            assert(state.scripts.length > 0 && state.scripts.every(file => chunks.a.has(file)), 'Build A must serve its own chunks');
            assert(state.scripts.some(file => !chunks.b.has(file)), 'Builds A and B must ship different chunks');
            assert.equal(state.seat, 'seat:1');
            await refocus();
            await sleep(1500);
            assert.equal(loads.length, 1, 'No reload while the live build matches');
            await page.screenshot({ path: `${root}/1-build-a.png` });
        });
        await check('B deployed but the version check fails or the phone is offline: build A keeps running, no reload', async () => {
            target = 'b';
            for (const mode of ['error', 'drop'] as const) {
                versionMode = mode;
                await refocus();
                await until('document.documentElement.dataset.update === "unreachable"');
                await page.evaluate(() => { document.documentElement.dataset.update = 'probe'; });
            }
            // Offline on top of a failing check, so coming back online cannot race the next step.
            await page.evaluate(() => { document.documentElement.dataset.update = 'probe'; });
            await context.setOffline(true);
            await refocus();
            await until('document.documentElement.dataset.update === "unreachable"');
            await context.setOffline(false);
            await sleep(1000);
            const state = await loaded();
            frames.push({ step: 'unreachable', ...state });
            assert.equal(loads.length, 1);
            assert.equal(state.version, versions.a);
            assert.equal(state.me, 'Michael');
        });
        await check('A typed nomination amount defers the update; finishing the edit loads build B with one reload', async () => {
            await backend.admin('testOnly:configure', { draft: { status: 'running', phase: 'nomination', nominatorId: 1, lotId: null,
                order: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], turnIndex: 0, turnSequence: 50 }, deadlineAfterMs: DAY });
            await until('Boolean(document.querySelector("[aria-label=\\"Optional nomination bid\\"]"))');
            await page.locator('[aria-label="Optional nomination bid"]').fill('7');
            await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
            await page.evaluate(() => { document.documentElement.dataset.update = 'probe'; });
            versionMode = 'normal';
            await refocus();
            await until('document.documentElement.dataset.update === "deferred"');
            await sleep(1500);
            assert.equal(loads.length, 1, 'Must not reload over a typed amount');
            assert.equal(await page.locator('[aria-label="Optional nomination bid"]').inputValue(), '7');
            await page.screenshot({ path: `${root}/2-deferred-on-a.png` });
            await page.locator('[aria-label="Optional nomination bid"]').fill('');
            await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
            await until(`document.documentElement.dataset.version === ${JSON.stringify(versions.b)} && document.querySelector(".me")?.textContent === "Michael"`);
            await until('document.documentElement.dataset.update === "current"');
            const state = await loaded();
            frames.push({ step: 'B', ...state });
            assert.equal(loads.length, 2, 'Exactly one reload');
            assert(state.scripts.every(file => chunks.b.has(file)), 'Every chunk comes from build B');
            assert(state.scripts.some(file => !chunks.a.has(file)), 'Build B chunks replaced build A chunks');
            assert.equal(state.seat, 'seat:1', 'Seat preference survives the update');
            assert.equal(JSON.parse(state.attempt!).count, 1);
            await refocus();
            await sleep(2000);
            assert.equal(loads.length, 2, 'No further reloads once B is running');
            await page.screenshot({ path: `${root}/3-build-b.png` });
        });
        await check('A version the server never serves causes at most two reloads, then the app holds', async () => {
            versionMode = 'phantom';
            await refocus();
            await until('document.documentElement.dataset.update === "held"', 30000);
            await sleep(4000);
            await refocus();
            await sleep(2000);
            const state = await loaded();
            frames.push({ step: 'phantom', ...state });
            assert.equal(loads.length, 4, `Expected exactly two guarded reloads, saw ${loads.length - 2}`);
            assert.equal(state.update, 'held');
            assert.equal(state.version, versions.b);
            assert.equal(state.me, 'Michael');
            versionMode = 'normal';
        });
        await check('Opening the app fresh after the deployment loads build B directly', async () => {
            const fresh = await context.newPage();
            await fresh.goto(origin);
            await until('document.querySelector(".me")?.textContent === "Michael"', 30000, fresh);
            await until('document.documentElement.dataset.update === "current"', 30000, fresh);
            const state = await loaded(fresh);
            frames.push({ step: 'cold-open', ...state });
            assert.equal(state.version, versions.b);
            assert(state.scripts.every(file => chunks.b.has(file)));
            await fresh.close();
        });
        assert.deepEqual(errors, [], 'No page errors');
    } finally {
        evidence.loads = loads;
        evidence.frames = frames;
        evidence.errors = errors;
        evidence.requests = requests.filter(entry => !entry.path.startsWith('/_next/static/media'));
        await writeEvidenceFile(`${root}/evidence.json`, JSON.stringify(evidence, null, 2));
    }
}
withResources(main).catch(error => { console.error(error); process.exitCode = 1; });
