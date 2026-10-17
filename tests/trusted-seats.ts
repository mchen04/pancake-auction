// Trusted-league seat selection in real browsers: any manager can be opened from any number of devices without a key,
// an old saved device token still opens its seat, switching works, and sealed responses stay private and final.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { webkit, type Browser, type Page } from 'playwright-core';
import { AuctionClient } from '../lib/client';
import { recordedPool } from '../scripts/pool-source';
import { freePort, localBackend, sleep } from '../scripts/local-backend';
import { withResources, ownProcess, ownCleanup } from '../scripts/resources';
import { makeEvidenceDirectory, writeEvidenceFile } from '../scripts/evidence';

const iPhone = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' };
const desktop = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 };

async function main() {
    const root = `${process.env.EVIDENCE_DIR}/trusted-seats`;
    await makeEvidenceDirectory(root, { recursive: true });
    const backend = await localBackend('trusted-seats', true);
    const client = new AuctionClient(backend.url);
    const source = recordedPool();
    const results: { name: string; result: string; error?: string }[] = [];
    async function check(name: string, run: () => Promise<void>) {
        try { await run(); results.push({ name, result: 'passed' }); console.log(`PASS Playwright WebKit (not Safari): ${name}`); }
        catch (error) { results.push({ name, result: 'failed', error: String(error) }); throw error; }
        finally { await writeEvidenceFile(`${root}/results.json`, JSON.stringify(results, null, 2)); }
    }
    await backend.admin('admin:managers');
    await backend.admin('admin:importPlayers', { players: source.players, ...source.importMetadata, startedAt: Date.now() });
    const legacyToken: string = await backend.admin('testOnly:legacyToken', { managerId: 2 });

    const port = await freePort();
    let serverLog = '';
    const server = ownProcess(spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-H', '127.0.0.1', '-p', String(port)], {
        env: { PATH: process.env.PATH, NODE_ENV: 'production', NODE_OPTIONS: '--max-old-space-size=1024', CONVEX_URL: backend.url,
            NEXT_TELEMETRY_DISABLED: '1', ...(process.env.NEXT_DIST_DIR ? { NEXT_DIST_DIR: process.env.NEXT_DIST_DIR } : {}) },
        stdio: ['ignore', 'pipe', 'pipe'] }));
    server.stdout!.on('data', data => { serverLog += String(data); });
    server.stderr!.on('data', data => { serverLog += String(data); });
    const base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 120; i++) {
        if (server.exitCode !== null) throw new Error(`Local Next server exited ${server.exitCode}: ${serverLog}`);
        try { if ((await fetch(base)).ok) break; } catch {}
        await sleep(250);
    }
    const cache = `${homedir()}/Library/Caches/ms-playwright`;
    const versions = (await readdir(cache)).filter(name => name.startsWith('webkit-'))
        .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
    assert(versions.length, 'A cached WebKit build is required');
    const browser: Browser = await webkit.launch({ executablePath: `${cache}/${versions[0]}/pw_run.sh`, headless: true });
    ownCleanup(() => browser.close());
    const errors: string[] = [];
    async function device(options: typeof iPhone | typeof desktop, saved?: string) {
        const context = await browser.newContext(options);
        if (saved) await context.addInitScript(value => { if (!sessionStorage.getItem('seeded')) {
            localStorage.setItem('pancake-seat', value); sessionStorage.setItem('seeded', '1'); } }, saved);
        const page = await context.newPage();
        page.on('pageerror', error => errors.push(String(error)));
        await page.goto(base);
        return page;
    }
    const seat = (page: Page) => page.evaluate(() => localStorage.getItem('pancake-seat'));
    const me = (page: Page) => page.locator('.me-box .me').textContent().then(text => text?.trim());
    async function pick(page: Page, name: string) {
        await page.locator('.seat-grid button', { hasText: name }).click();
        await page.waitForSelector('.room');
        assert.equal(await me(page), name);
    }
    const shot = (page: Page, name: string) => page.screenshot({ path: `${root}/${name}.png` }).then(() => undefined);

    const phone = await device(iPhone);
    const laptop = await device(desktop);
    await check('Every name is selectable without a key; the picker explains the trusted, passwordless model', async () => {
        await phone.waitForSelector('.seat-grid button');
        const buttons = phone.locator('.seat-grid button');
        assert.equal(await buttons.count(), 10);
        for (let i = 0; i < 10; i++) assert(await buttons.nth(i).isEnabled());
        const note = await phone.locator('.gate p').textContent();
        assert(note?.includes('no password') && note.includes('any phone or computer'), note ?? '');
        assert(!(await phone.content()).includes('Taken'));
        await shot(phone, 'picker-390x844');
    });
    await check('The commissioner opens on two devices at once; each remembers only the nonsecret seat', async () => {
        await pick(phone, 'Michael');
        await laptop.waitForSelector('.seat-grid button');
        await pick(laptop, 'Michael');
        for (const page of [phone, laptop]) {
            assert.equal(await seat(page), 'seat:1');
            assert(await page.locator('button', { hasText: 'Start draft' }).isVisible());
        }
        await shot(laptop, 'commissioner-two-devices-1440x900');
    });
    const oldDevice = await device(iPhone, legacyToken);
    await check('A token saved by the earlier exclusive-claim build still opens its seat and is converted', async () => {
        await oldDevice.waitForSelector('.room');
        assert.equal(await me(oldDevice), 'Matthew');
        assert.equal(await seat(oldDevice), 'seat:2');
    });
    await check('Switching manager returns to the picker and opens another seat', async () => {
        await laptop.locator('button.me-box').click();
        await laptop.waitForSelector('.seat-grid button');
        assert.equal(await seat(laptop), null);
        await pick(laptop, 'Justin');
        assert.equal(await seat(laptop), 'seat:3');
        assert(!(await laptop.locator('button', { hasText: 'Start draft' }).count()), 'Justin is not the commissioner');
    });
    const secondPhone = await device(iPhone);
    await check('Two devices on Matthew share one sealed response; it is final and invisible to other seats', async () => {
        await pick(secondPhone, 'Matthew');
        await phone.locator('button', { hasText: 'Start draft' }).click();
        await phone.waitForSelector('.deadline');
        const started = await client.state();
        if (!started.lot) {
            const nominator = started.draft.nominatorId!;
            const player = started.players.find(p => !started.roster.some(entry => entry.playerId === p.id))!;
            await client.act({ type: 'nominate', playerId: player.id, nominationGeneration: started.draft.nominationGeneration }, `seat:${nominator}`);
        }
        for (const page of [oldDevice, secondPhone]) await page.waitForFunction(() =>
            (document.querySelector('[aria-label="Sealed bid amount"]') as HTMLInputElement | null)?.disabled === false);
        await oldDevice.fill('[aria-label="Sealed bid amount"]', '41');
        await oldDevice.locator('.sealed-form .primary').click();
        for (const page of [oldDevice, secondPhone]) {
            await page.waitForSelector('.own-response');
            assert((await page.locator('.own-response').textContent())?.includes('$41'));
            assert(!(await page.locator('[aria-label="Sealed bid amount"]').count()), 'No second response form on any device');
        }
        await shot(secondPhone, 'same-seat-second-device-390x844');
        await secondPhone.reload();
        await secondPhone.waitForSelector('.own-response');
        assert((await secondPhone.locator('.own-response').textContent())?.includes('$41'), 'Reconnect keeps the seat and response');
        const lot = (await client.state()).lot!;
        await assert.rejects(client.act({ type: 'bid', lotId: lot.id, amount: 60 }, 'seat:2'), /final/);
        await assert.rejects(client.act({ type: 'pass', lotId: lot.id }, legacyToken), /final/);
        await laptop.waitForSelector('.sealed-form');
        assert(!(await laptop.locator('.own-response').count()));
        assert(!(await laptop.evaluate(() => document.body.innerText.includes('$41'))), 'Justin must not see Matthew\'s amount');
        for (const token of [undefined, 'seat:3', 'seat:2']) {
            const view = await client.state(token);
            assert.equal(view.lot!.highBid, 0); assert.equal(view.lot!.bids, undefined);
            assert(!JSON.stringify(view).includes('"amount":41'), 'Public state must not carry hidden amounts');
        }
        assert.equal((await client.privateSeat('seat:3'))?.response, null);
        await shot(laptop, 'other-seat-1440x900');
    });
    await check('No page errors in any browser context', async () => { assert.deepEqual(errors, []); });
}
withResources(main).catch(error => { console.error(error); process.exitCode = 1; });
