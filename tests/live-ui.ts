import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { AuctionClient } from '../lib/client';
import { api } from '../convex/_generated/api';
import { recordedPool } from '../scripts/pool-source';
import { freePort, localBackend, sleep, stopProcess } from '../scripts/local-backend';
import { withResources, ownProcess } from '../scripts/resources';
import { makeEvidenceDirectory, writeEvidenceFile } from '../scripts/evidence';
import { driver, mode, label, commands, watchClockRequests, type Driver } from './browser-driver';
import { sizes, geometry, assertOnePage } from './browser-layout';

async function main() {
    const root = `${process.env.EVIDENCE_DIR}/live-${mode}`;
    await makeEvidenceDirectory(root, { recursive: true });
    const backend = await localBackend(`live-browser-${mode}`, true);
    const client = new AuctionClient(backend.url);
    const device = new AuctionClient(backend.url);
    const source = recordedPool();
    const ranked = [...source.players].sort((a, b) => (b.projection ?? -Infinity) - (a.projection ?? -Infinity));
    const results: { name: string; result: string; error?: string }[] = [];
    let browser: Driver | undefined;
    let server: ReturnType<typeof spawn> | undefined;
    let serverLog = '';
    let base = '';
    const tokens = Array.from({ length: 10 }, (_, i) => `seat:${i + 1}`);
    async function until(expression: string) {
        for (let i = 0; i < 150; i++) {
            if (await browser!.evaluate(expression)) return;
            await sleep(100);
        }
        throw new Error(`UI did not reach: ${expression}`);
    }
    async function check(name: string, run: () => Promise<void>) {
        try { await run(); results.push({ name, result: 'passed' }); console.log(`PASS ${label}: ${name}`); }
        catch (error) { results.push({ name, result: 'failed', error: String(error) }); throw error; }
        finally { await writeEvidenceFile(`${root}/results.json`, JSON.stringify(results, null, 2)); }
    }
    async function tab(name: string) {
        const selector = `.tab-${name}`;
        if (await browser!.evaluate(`Boolean(document.querySelector('${selector}')?.getClientRects().length)`)) {
            await browser!.click(selector);
            await until(`document.querySelector('${selector}')?.getAttribute('aria-selected') === 'true'`);
        }
    }
    async function roomReady() {
        const state = await client.state();
        const lot = state.lot;
        const expected = lot
            ? `document.querySelector('.lot-heading h2')?.textContent === ${JSON.stringify(state.players.find(player => player.id === lot.playerId)!.name)}
                && document.querySelector('.high-bid strong')?.textContent === ${JSON.stringify(`$${lot.highBid}`)}
                && document.querySelector('.high-bid span')?.textContent === ${JSON.stringify(lot.highBidderId === 1
                    ? 'You lead' : `${state.managers.find(manager => manager.id === lot.highBidderId)!.name} leads`)}
                && document.querySelector('.custom input')?.disabled === false`
            : `document.querySelector('.nomination h2')?.textContent === 'Your nomination'
                && Boolean(document.querySelector('[aria-label="Opening bid"]')) && !document.querySelector('.bid-controls')`;
        await until(`document.querySelector('.room')?.dataset.mode === 'live-v1'
            && document.querySelector('.me')?.textContent === 'Michael' && Boolean(document.querySelector('.tab-players'))
            && ['synced', 'provisional'].includes(document.querySelector('.room')?.dataset.clockStatus)
            && (${expected})`);
    }
    async function turn(managerId: number) {
        const state = await client.state();
        assert.equal(state.lot, null);
        await backend.admin('testOnly:configure', { draft: { status: 'running', phase: 'nomination', nominatorId: managerId,
            lotId: null, order: [1,2,3,4,5,6,7,8,9,10], turnIndex: managerId - 1,
            turnSequence: (state.draft.turnSequence ?? 0) + 1, nominationMs: 600000, biddingMs: 600000, capMs: 600000 }, deadlineAfterMs: 600000 });
    }
    async function force() {
        await browser!.click('[aria-label="Force end"]');
        const armed = await browser!.evaluate<string>('document.querySelector(".commish").innerText');
        assert(armed.includes('Sell to'));
        await browser!.click('.commish .armed');
        await until('!document.querySelector(".bid-controls")');
    }
    async function lead() {
        await turn(2);
        const s = await client.state();
        const player = ranked.find(player => !s.roster.some(entry => entry.playerId === player.id))!;
        await device.act({ type: 'nominate', playerId: player.id, amount: 12,
            nominationGeneration: s.draft.nominationGeneration }, tokens[1]);
        await until('document.querySelector(".high-bid")?.textContent.includes("$12")');
    }
    try {
        await backend.admin('admin:managers');
        await backend.admin('admin:importPlayers', { players: source.players, ...source.importMetadata, startedAt: Date.now() });
        const port = await freePort();
        const development = process.env.AUCTION_NEXT_DEV === '1';
        server = ownProcess(spawn(process.execPath, ['node_modules/next/dist/bin/next', development ? 'dev' : 'start',
            ...(development ? ['--webpack'] : []), '-H', '127.0.0.1', '-p', String(port)], {
            env: { PATH: process.env.PATH, NODE_ENV: development ? 'development' : 'production', NODE_OPTIONS: '--max-old-space-size=1024',
                CONVEX_URL: backend.url, NEXT_TELEMETRY_DISABLED: '1', ...(process.env.NEXT_DIST_DIR ? { NEXT_DIST_DIR: process.env.NEXT_DIST_DIR } : {}) },
            stdio: ['ignore', 'pipe', 'pipe'] }));
        server.stdout!.on('data', data => { serverLog += String(data); });
        server.stderr!.on('data', data => { serverLog += String(data); });
        base = `http://127.0.0.1:${port}`;
        for (let i = 0; i < 120; i++) {
            if (server.exitCode !== null) throw new Error(serverLog);
            try { if ((await fetch(base)).ok) break; } catch {}
            await sleep(250);
        }
        browser = await driver();
        await browser.open(base);
        await browser.resize(390, 844);
        await check('Commissioner selects Normal and starts; another seat sees the choice', async () => {
            await until('document.querySelectorAll(".seat-grid button").length === 10');
            await browser!.click('.seat-grid button:first-child');
            await until('Boolean(document.querySelector(".mode-selector"))');
            assert.equal((await client.state()).draft.mode, 'sealed-v1');
            await browser!.click('.mode-selector button:first-child');
            await until('document.querySelector(".mode-selector button:first-child")?.getAttribute("aria-pressed") === "true"');
            assert.equal((await client.state()).draft.mode, 'live-v1');
            assert.equal(await device.claim(1), 'seat:1');
            await browser!.click('.me-box');
            await until('Boolean(document.querySelector(".seat-grid"))');
            await browser!.click('.seat-grid button:nth-child(2)');
            await until('document.querySelector(".nomination")?.textContent.includes("Normal · live ascending bids")');
            assert.equal(await browser!.evaluate('Boolean(document.querySelector(".mode-selector"))'), false);
            await browser!.click('.me-box');
            await until('Boolean(document.querySelector(".seat-grid"))');
            await browser!.click('.seat-grid button:first-child');
            await until('Boolean(document.querySelector(".mode-selector"))');
            await backend.admin('testOnly:configure', { draft: { nominationMs: 600000, biddingMs: 600000, capMs: 600000 } });
            await browser!.click('.nomination .primary');
            await until('!document.querySelector(".mode-selector")');
            assert.equal((await client.state()).draft.status, 'running');
            assert.equal(await browser!.evaluate('Boolean(document.querySelector(".tab-queue, .queue, .queue-add"))'), false);
            await until('["synced", "provisional"].includes(document.querySelector(".room").dataset.clockStatus)');
            await watchClockRequests(browser!);
            await until('window.auctionClockRequests > 0');
        });
        await check('Opening stepper, custom opening, nomination, another device and Give up', async () => {
            await turn(1);
            await until('Boolean(document.querySelector("[aria-label=\\"Opening bid\\"]"))');
            await browser!.click('[aria-label="Raise opening bid"]');
            assert.equal(await browser!.evaluate('document.querySelector("[aria-label=\\"Opening bid\\"]").value'), '2');
            await browser!.click('[aria-label="Lower opening bid"]');
            await browser!.fill('[aria-label="Opening bid"]', '3');
            assert(await browser!.evaluate('Boolean(document.querySelector(".opening [data-unsaved]"))'));
            await browser!.fill('[aria-label="Search players or team"]', ranked[0].name);
            await until('document.querySelectorAll(".pool-row").length === 1');
            await browser!.click('.nominate');
            await until('document.querySelector(".pinned-lead")?.textContent.includes("You lead")');
            let s = await client.state();
            assert.equal(s.lot!.highBid, 3);
            assert.equal(s.lot!.highBidderId, 1);
            await device.act({ type: 'bid', lotId: s.lot!.id, amount: 5 }, tokens[1]);
            await until('document.querySelector(".high-bid")?.textContent.includes("$5")');
            await browser!.click('.bid-buttons > button:first-child');
            await until('document.querySelector(".high-bid")?.textContent.includes("$6")');
            s = await client.state();
            await device.act({ type: 'bid', lotId: s.lot!.id, amount: 7 }, tokens[2]);
            await until('document.querySelector(".custom input")?.disabled === false');
            await browser!.fill('[aria-label="Bid amount"]', '17');
            assert(await browser!.evaluate('Boolean(document.querySelector(".custom [data-unsaved]"))'));
            await device.act({ type: 'bid', lotId: s.lot!.id, amount: 8 }, tokens[1]);
            await until('document.querySelector(".high-bid")?.textContent.includes("$8")');
            assert.equal(await browser!.evaluate('document.querySelector(".custom input").value'), '17');
            await browser!.click('.custom button');
            await until('document.querySelector(".high-bid")?.textContent.includes("$17")');
            await device.act({ type: 'bid', lotId: s.lot!.id, amount: 18 }, tokens[1]);
            await until('document.querySelector(".bid-footer button")?.disabled === false');
            await browser!.click('.bid-footer > button');
            await until('document.querySelector(".bid-footer button")?.textContent.trim() === "Gave up"');
            assert((await client.state()).passes.includes(1));
            assert.equal(await browser!.evaluate('document.querySelector(".custom input").disabled'), true);
            await force();
            assert.equal((await client.state()).sales[0].highBid, 18);
        });
        await check('Shot clock drains, turns urgent, freezes on pause, resumes and restores the seat after refresh', async () => {
            await lead();
            await backend.admin('testOnly:configure', { deadlineAfterMs: 9000 });
            await until('/^\\d+\\.\\d$/.test(document.querySelector(".pinned-lead .digits")?.textContent ?? "")');
            const shown = Number(await browser!.evaluate('document.querySelector(".pinned-lead .digits").textContent'));
            await sleep(350);
            assert(Number(await browser!.evaluate('document.querySelector(".pinned-lead .digits").textContent')) < shown);
            assert(await browser!.evaluate('parseFloat(document.querySelector(".pinned-lead .drain").style.width) > 0'));
            await backend.admin('testOnly:configure', { deadlineAfterMs: 3500 });
            await until('Boolean(document.querySelector(".pinned-lead .urgent"))');
            await browser!.click('.commish button:last-child');
            await until('document.querySelector(".commish button:last-child")?.textContent.trim() === "Resume"');
            const paused = await client.state();
            const digits = await browser!.evaluate('document.querySelector(".pinned-lead .digits").textContent');
            await sleep(250);
            assert.equal(await browser!.evaluate('document.querySelector(".pinned-lead .digits").textContent'), digits);
            await backend.admin('testOnly:configure', { draft: { remainingMs: 600000 } });
            await browser!.open(base);
            await until('document.querySelector(".me")?.textContent === "Michael"');
            assert.equal(await browser!.evaluate('localStorage.getItem("pancake-seat")'), 'seat:1');
            assert.equal((await client.state()).lot!.id, paused.lot!.id);
            await browser!.click('.commish button:last-child');
            await until('document.querySelector(".commish button:last-child")?.textContent.trim() === "Pause"');
            await backend.admin('testOnly:configure', { deadlineAfterMs: 600000 });
            await client.act({ type: 'pause' }, tokens[0]);
            await until('document.querySelector(".commish button:last-child")?.textContent.trim() === "Resume"');
            await force();
            assert.equal((await client.state()).draft.status, 'paused');
            await browser!.click('.commish button:last-child');
            await until('document.querySelector(".commish button:last-child")?.textContent.trim() === "Pause"');
        });
        await check('Both Normal states fit the full size matrix and the standalone safe areas', async () => {
            const proofs: unknown[] = [];
            for (const phase of ['bidding', 'nomination'] as const) {
                if (phase === 'bidding') await lead();
                else { await force(); await turn(1); }
                for (const [form, width, height] of sizes) {
                    await browser!.form?.(form);
                    await browser!.resize(width, height);
                    await roomReady();
                    await tab('players');
                    await browser!.fill('[aria-label="Search players or team"]', '');
                    await until('document.querySelectorAll(".pool-row").length > 20');
                    const required = ['.me', '.me-budget', '.commish button:last-child',
                        phase === 'bidding' && width <= 860 ? '.pinned-lead .shot-clock' : '.block-top > .shot-clock',
                        ...(phase === 'bidding' ? ['.bid-buttons > button:first-child', '.custom input', '.custom button', '.bid-footer > button',
                            width <= 860 ? '.pinned-lead' : '.high-bid'] : ['[aria-label="Opening bid"]', '.pool-row .nominate'])];
                    for (const name of ['players', 'teams', 'roster', 'results']) {
                        await tab(name);
                        await sleep(150);
                        const proof = await browser!.evaluate<Parameters<typeof assertOnePage>[0] & { tabsShown: boolean;
                            thumb: { tabbar: { top: number; bottom: number }; block: { top: number; bottom: number };
                                panel: { top: number; bottom: number }; controls: { top: number; text: string }[] } }>(geometry(
                            phase === 'nomination' && name !== 'players' ? required.filter(item => item !== '.pool-row .nominate') : required));
                        const description = `${phase} ${name} ${width}x${height}`;
                        assertOnePage(proof, description, width < 1220);
                        if (proof.tabsShown) assert(proof.thumb.tabbar.bottom >= height - 12);
                        if (width <= 860 && height > width) {
                            assert(proof.thumb.panel.bottom <= proof.thumb.block.top + 1);
                            assert(proof.thumb.block.bottom <= proof.thumb.tabbar.top + 1);
                            for (const control of proof.thumb.controls) assert(control.top >= height / 2, `${description}: ${control.text} is beyond thumb reach`);
                        }
                        proofs.push({ phase, tab: name, size: [width, height], ...proof });
                        if (phase === 'bidding' && name === 'players' && (width === 375 || width === 1440))
                            await browser!.screenshot(`${root}/mid-draft-${width}x${height}.png`);
                    }
                }
                await browser!.form?.('phone');
                await roomReady();
            }
            await lead();
            await browser!.resize(390, 844);
            await roomReady();
            await browser!.evaluate(`(() => { document.documentElement.classList.add('emulated-standalone');
                const style = document.createElement('style'); style.id = 'standalone-insets';
                style.textContent = ':root{--safe-top:47px;--safe-bottom:34px}'; document.head.append(style); return true; })()`);
            for (const name of ['players', 'teams', 'roster', 'results']) {
                await tab(name);
                await sleep(150);
                const proof = await browser!.evaluate<Parameters<typeof assertOnePage>[0]>(geometry(
                    ['.me', '.me-budget', '.pinned-lead', '.pinned-lead .shot-clock', '.custom input', '.custom button', '.bid-footer > button']));
                assertOnePage(proof, `standalone ${name}`, true);
                const safe = await browser!.evaluate<{ me: number; tabs: number; bottom: number; scroll: number }>(`(() => {
                    const r = e => e.getBoundingClientRect();
                    const panel = [...document.querySelectorAll('.pool, .teams, .roster, .results')].find(e => e.getClientRects().length);
                    return { me: r(document.querySelector('.me-box')).top, tabs: r(document.querySelector('.tabbar button')).bottom,
                        bottom: r(document.querySelector('.tabbar')).bottom, scroll: panel.querySelector('.scroll').clientHeight }; })()`);
                assert(safe.me >= 47 && safe.tabs <= 810 && safe.bottom >= 843 && safe.scroll >= 100);
                proofs.push({ standalone: name, ...proof, safe });
                await browser!.screenshot(`${root}/standalone-390x844-${name}.png`);
            }
            await writeEvidenceFile(`${root}/one-page.json`, JSON.stringify(proofs, null, 2));
        });
        assert.equal((await client.transport.query(api.auction.privateSeat, { token: tokens[0] }))?.queue.length, 0);
    } catch (error) {
        if (browser) {
            await browser.screenshot(`${root}/failure.png`).catch(() => {});
            await writeEvidenceFile(`${root}/failure.txt`, String(await browser.evaluate('document.body.innerText').catch(() => error)));
        }
        throw error;
    } finally {
        try { await browser?.close(); } finally {
            if (server) await stopProcess(server);
            await backend.close();
            await writeEvidenceFile(`${root}/server.log`, serverLog);
            await writeEvidenceFile(`${root}/commands.json`, JSON.stringify(commands, null, 2));
        }
    }
}
withResources(main).catch(error => { console.error(error); process.exitCode = 1; });
