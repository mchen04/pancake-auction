import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { webkit } from 'playwright-core';
import { AuctionClient } from '../lib/client';
import { counts } from '../lib/rules';
import { DAY } from '../lib/sealed';
import { recordedPool } from '../scripts/pool-source';
import { freePort, localBackend, sleep, stopProcess } from '../scripts/local-backend';
import { withResources, ownProcess, ownCleanup, runBrowser } from '../scripts/resources';
import { makeEvidenceDirectory, writeEvidenceFile } from '../scripts/evidence';

interface Driver {
    open(url: string): Promise<unknown>;
    click(selector: string): Promise<unknown>;
    fill(selector: string, text: string): Promise<unknown>;
    evaluate<T = unknown>(expression: string): Promise<T>;
    screenshot(path: string): Promise<unknown>;
    resize(width: number, height: number): Promise<unknown>;
    close(): Promise<unknown>;
    standalone?(): Promise<unknown>;
    form?(kind: 'phone' | 'desktop'): Promise<unknown>;
}
const execute = promisify(execFile);
const mode = process.env.AUCTION_BROWSER ?? 'chromium';
const label = mode === 'safari' ? 'Desktop Safari' : mode === 'webkit' ? 'Playwright WebKit (not Safari)' : 'Chromium';
const commands: { command: string; result?: unknown }[] = [];
async function driver(): Promise<Driver> {
    if (mode === 'safari') {
        const port = await freePort();
        const process_ = ownProcess(spawn('/usr/bin/safaridriver', ['--port', String(port)], { stdio: 'ignore' }));
        commands.push({ command: `/usr/bin/safaridriver --port ${port}` });
        const base = `http://127.0.0.1:${port}`;
        for (let i = 0; i < 60; i++) {
            try { if ((await fetch(`${base}/status`)).ok) break; } catch {}
            await sleep(100);
        }
        async function request(method: string, path: string, body?: unknown) {
            const response = await fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json' },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
            const result = await response.json();
            if (!response.ok || result.value?.error) throw new Error(`Safari ${method} ${path.replace(/session\/[^/]+/, 'session/<owned>')}: ${JSON.stringify(result.value)}`);
            return result.value;
        }
        commands.push({ command: 'POST /session {"capabilities":{"alwaysMatch":{"browserName":"safari"}}}' });
        const session = await request('POST', '/session', { capabilities: { alwaysMatch: { browserName: 'safari' } } });
        const prefix = `/session/${session.sessionId}`;
        let closed = false;
        const close = async () => {
            if (closed) return;
            closed = true;
            try { await request('DELETE', prefix); } finally { await stopProcess(process_); }
        };
        ownCleanup(close);
        async function element(selector: string) {
            const result = await request('POST', `${prefix}/element`, { using: 'css selector', value: selector });
            return result['element-6066-11e4-a52e-4f735466cecf'];
        }
        const evaluate = async <T>(expression: string): Promise<T> => request('POST', `${prefix}/execute/sync`,
            { script: `return (${expression})`, args: [] });
        return {
            open: url => request('POST', `${prefix}/url`, { url }),
            click: async selector => {
                const id = await element(selector);
                await request('POST', `${prefix}/element/${id}/click`, {});
            },
            fill: async (selector, text) => {
                const id = await element(selector);
                await request('POST', `${prefix}/element/${id}/clear`, {});
                if (text) await request('POST', `${prefix}/element/${id}/value`, { text });
            },
            evaluate,
            screenshot: async path => writeEvidenceFile(path, Buffer.from(await request('GET', `${prefix}/screenshot`), 'base64')),
            resize: (width, height) => request('POST', `${prefix}/window/rect`, { width, height }),
            close,
            standalone: async () => {
                const current = await request('GET', `${prefix}/window`);
                const attempt: Record<string, unknown> = { command: 'POST /session/<owned>/window/new {"type":"standalone"}' };
                try {
                    const result = await request('POST', `${prefix}/window/new`, { type: 'standalone' });
                    attempt.result = result;
                    if (result.handle && result.handle !== current) {
                        await request('POST', `${prefix}/window`, { handle: result.handle });
                        attempt.actualStandalone = await evaluate("matchMedia('(display-mode: standalone)').matches || navigator.standalone === true");
                        await request('DELETE', `${prefix}/window`);
                        await request('POST', `${prefix}/window`, { handle: current });
                    }
                } catch (error) { attempt.error = String(error); }
                attempt.reason = 'WebDriver exposes browser windows, not Safari Add to Dock. No user Safari window or system UI was touched.';
                commands.push({ command: String(attempt.command), result: attempt });
                return attempt;
            }
        };
    }
    if (mode === 'webkit') {
        const cache = `${homedir()}/Library/Caches/ms-playwright`;
        const versions = (await readdir(cache)).filter(name => name.startsWith('webkit-')).sort((a,b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
        assert(versions.length, 'A cached WebKit build is required');
        const executablePath = `${cache}/${versions[0]}/pw_run.sh`;
        const browser = await webkit.launch({ executablePath, headless: true });
        ownCleanup(() => browser.close());
        const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
            deviceScaleFactor: 2, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' });
        let page = await context.newPage();
        commands.push({ command: `Playwright WebKit executable ${executablePath}; viewport 390x844; mobile=true; touch=true` });
        const forms = { phone: page } as Record<'phone' | 'desktop', typeof page>;
        return {
            open: url => page.goto(url), click: selector => page.locator(selector).click(),
            fill: (selector, text) => page.locator(selector).fill(text), evaluate: expression => page.evaluate(expression),
            screenshot: async path => writeEvidenceFile(path, await page.screenshot()),
            resize: (width,height) => page.setViewportSize({ width, height }), close: () => browser.close(),
            form: async kind => {
                if (!forms[kind]) {
                    const seat = await page.evaluate(() => localStorage.getItem('pancake-seat'));
                    const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
                    await desktop.addInitScript(token => { if (token) localStorage.setItem('pancake-seat', token); }, seat);
                    forms[kind] = await desktop.newPage();
                    await forms[kind].goto(page.url());
                    commands.push({ command: 'Playwright WebKit desktop context; mobile=false; touch=false; same isolated seat' });
                }
                page = forms[kind];
            }
        };
    }
    const session = `sealed-${crypto.randomUUID()}`;
    await execute('agent-browser', ['session', 'list']);
    const command = async (...args: string[]) => runBrowser(session, args, 30000);
    commands.push({ command: 'agent-browser --session <owned> open <isolated-local-app>' });
    return {
        open: async url => { await command('open', url); await command('snapshot', '-i'); },
        click: async selector => {
            commands.push({ command: `scrollintoview ${selector}` });
            await command('scrollintoview', selector);
            return command('click', selector);
        }, fill: (selector, text) => command('fill', selector, text),
        evaluate: async expression => JSON.parse(await command('eval', expression)),
        screenshot: path => command('screenshot', path), resize: (width,height) => command('set', 'viewport', String(width), String(height)),
        close: async () => {
            await command('close');
            for (let i = 0; i < 50; i++) {
                if (!(await execute('agent-browser', ['session', 'list'])).stdout.includes(session)) return;
                await sleep(100);
            }
            throw new Error('Owned Chromium session did not close');
        }
    };
}
async function main() {
    const root = `${process.env.EVIDENCE_DIR}/${mode}`;
    await makeEvidenceDirectory(root, { recursive: true });
    const backend = await localBackend(`browser-${mode}`, true);
    const client = new AuctionClient(backend.url);
    const source = recordedPool();
    const results: { name: string; result: string; error?: string }[] = [];
    const evidence: Record<string, unknown> = { browser: label, backend: backend.identity };
    let browser: Driver | undefined;
    let server: ReturnType<typeof spawn> | undefined;
    let serverLog = '';
    const tokens: string[] = [];
    async function check(name: string, run: () => Promise<void>) {
        try { await run(); results.push({ name, result: 'passed' }); console.log(`PASS ${label}: ${name}`); }
        catch (error) { results.push({ name, result: 'failed', error: String(error) }); throw error; }
        finally { await writeEvidenceFile(`${root}/results.json`, JSON.stringify(results, null, 2)); }
    }
    async function until(expression: string) {
        const end = Date.now() + 30000;
        while (Date.now() < end) {
            if (await browser!.evaluate(expression)) return;
            await sleep(100);
        }
        throw new Error(`UI did not reach: ${expression}`);
    }
    async function screenshot(name: string) { await browser!.screenshot(`${root}/${name}.png`); }
    async function tab(name: string) {
        const key = ({ Players: 'players', Queue: 'queue', Teams: 'teams', 'My roster': 'roster', Results: 'results' } as Record<string, string>)[name];
        if (await browser!.evaluate(`document.querySelector(".tabbar .tab-${key}").getClientRects().length > 0`))
            await browser!.click(`.tabbar .tab-${key}`);
    }
    async function turnForMichael() {
        const s = await client.state();
        await backend.admin('testOnly:configure', { draft: { status: 'running', phase: 'nomination', nominatorId: 1,
            lotId: null, order: [1,2,3,4,5,6,7,8,9,10], turnIndex: 0,
            tiePriority: s.draft.tiePriority, turnSequence: (s.draft.turnSequence ?? 0) + 1 }, deadlineAfterMs: DAY });
        await until('document.querySelector(".nomination h2")?.textContent === "Your nomination"');
        await tab('Players');
    }
    async function finish() {
        const s = await client.state();
        assert(s.lot);
        await Promise.all(s.managers.filter(m => !s.lot!.respondedIds?.includes(m.id))
            .map(m => client.act({ type: 'pass', lotId: s.lot!.id }, tokens[m.id - 1])));
        await until('!document.querySelector(".bid-controls")');
    }
    const findName = (id: string) => source.players.find(player => player.id === id)!.name;
    async function search(name: string) {
        await browser!.fill('[aria-label="Search players or team"]', name);
        await until(`document.querySelectorAll('.pool-row').length === 1 && document.querySelector('.name-button')?.textContent === ${JSON.stringify(name)}`);
    }
    try {
        await backend.admin('admin:managers');
        await backend.admin('admin:importPlayers', { players: source.players, ...source.importMetadata, startedAt: Date.now() });
        const port = await freePort();
        const development = process.env.AUCTION_NEXT_DEV === '1';
        server = ownProcess(spawn(process.execPath, ['node_modules/next/dist/bin/next', development ? 'dev' : 'start',
            ...(development ? ['--webpack'] : []), '-H', '127.0.0.1', '-p', String(port)], {
            env: { PATH: process.env.PATH, NODE_ENV: development ? 'development' : 'production',
                NODE_OPTIONS: '--max-old-space-size=1024', CONVEX_URL: backend.url,
                NEXT_TELEMETRY_DISABLED: '1', ...(process.env.NEXT_DIST_DIR ? { NEXT_DIST_DIR: process.env.NEXT_DIST_DIR } : {}) },
            stdio: ['ignore', 'pipe', 'pipe'] }));
        server.stdout!.on('data', data => { serverLog += String(data); });
        server.stderr!.on('data', data => { serverLog += String(data); });
        const base = `http://127.0.0.1:${port}`;
        evidence.frontend = base;
        commands.push({ command: `CONVEX_URL=<isolated-local> next ${development ? 'dev --webpack' : 'start'} -H 127.0.0.1 -p ${port}` });
        for (let i = 0; i < 120; i++) {
            if (server.exitCode !== null) throw new Error(`Local Next server exited ${server.exitCode}: ${serverLog}`);
            try { if ((await fetch(base)).ok) break; } catch {}
            await sleep(250);
        }
        const raw = await driver();
        browser = { ...raw,
            open: url => { commands.push({ command: `open ${url}` }); return raw.open(url); },
            click: selector => { commands.push({ command: `click ${selector}` }); return raw.click(selector); },
            fill: (selector, text) => { commands.push({ command: `fill ${selector} ${JSON.stringify(text)}` }); return raw.fill(selector, text); },
            screenshot: path => { commands.push({ command: `screenshot ${path}` }); return raw.screenshot(path); },
            resize: (width, height) => { commands.push({ command: `resize ${width} ${height}` }); return raw.resize(width, height); }
        };
        await browser.open(base);
        if (mode !== 'webkit') await browser.resize(1440, 1000);
        await check('Claim seat; reconnect restores identity; start uses all ten managers', async () => {
            await until('document.querySelectorAll(".seat-grid button").length === 10');
            await browser!.click('.seat-grid button:first-child');
            await until('document.querySelector(".me")?.textContent === "Michael"');
            tokens[0] = await browser!.evaluate<string>('localStorage.getItem("pancake-seat")');
            for (let id = 2; id <= 10; id++) tokens[id - 1] = await client.claim(id);
            await browser!.open(base);
            await until('document.querySelector(".me")?.textContent === "Michael"');
            await browser!.click('.nomination .primary');
            await until('!document.querySelector(".nomination .primary")');
            assert.equal((await client.state()).draft.order.length, 10);
            assert.equal(await browser!.evaluate('document.body.innerText.includes("Force end")'), false);
        });
        const ranked = [...source.players].sort((a,b) => (b.projection ?? -Infinity) - (a.projection ?? -Infinity));
        await check('Nominate with a sealed amount; own response visible; commissioner cannot see another bid', async () => {
            await turnForMichael();
            await browser!.fill('[aria-label="Optional nomination bid"]', '51');
            await search(ranked[0].name);
            await browser!.click('.nominate');
            await until('document.querySelector(".own-response")?.textContent.includes("$51")');
            const s = await client.state();
            assert.equal((await client.privateSeat(tokens[0]))?.response?.amount, 51);
            await client.act({ type: 'bid', lotId: s.lot!.id, amount: 67 }, tokens[1]);
            await until('document.querySelector(".response-count")?.textContent.startsWith("2 of 10")');
            assert.equal(await browser!.evaluate('document.body.innerText.includes("$67")'), false);
            assert.equal(await browser!.evaluate('Boolean(document.querySelector(".high-bid")?.textContent.includes("leads"))'), false);
            await screenshot('sealed-own-response');
            await finish();
            await tab('Results');
            await until('document.querySelector(".revealed-lot summary")?.textContent.includes("$67")');
            await browser!.click('.revealed-lot summary');
            assert(await browser!.evaluate('document.querySelector(".revealed-lot")?.innerText.includes("$51")'));
            await screenshot('revealed-bids');
            await tab('Teams');
            assert(await browser!.evaluate('document.querySelector(".priority")?.innerText.includes("highest first")'));
            await screenshot('tie-priority');
        });
        await check('Nominate without amount; enter and submit a final bid; same-lot updates preserve typed amount', async () => {
            await turnForMichael();
            await browser!.fill('[aria-label="Optional nomination bid"]', '');
            await search(ranked[1].name);
            await browser!.click('.nominate');
            await until('document.querySelector(".sealed-form input")?.disabled === false');
            assert.equal((await client.privateSeat(tokens[0]))?.response, null);
            await browser!.fill('[aria-label="Sealed bid amount"]', '43');
            const s = await client.state();
            await client.act({ type: 'pass', lotId: s.lot!.id }, tokens[1]);
            await until('document.querySelector(".response-count")?.textContent.startsWith("1 of 10")');
            assert.equal(await browser!.evaluate('document.querySelector(".sealed-form input").value'), '43');
            await browser!.click('.sealed-form .primary');
            await until('document.querySelector(".own-response")?.textContent.includes("$43")');
            assert.equal(await browser!.evaluate('Boolean(document.querySelector(".sealed-form"))'), false);
            await screenshot('final-bid');
        });
        await check('Private queue add, amount edit, reorder and remove use real controls', async () => {
            await tab('Players');
            for (let index = 2; index <= 3; index++) {
                await search(ranked[index].name);
                await browser!.click('.name-button');
                await until('Boolean(document.querySelector(".queue-add"))');
                if (index === 2) await browser!.fill('.queue-add input', '29');
                await browser!.click('.queue-add button');
                await until(`document.querySelector('.queue h2')?.textContent.includes('· ${index - 1}')`);
            }
            await search(ranked[4].name);
            await browser!.click('.pool-row .queue-quick');
            await until(`document.querySelector('.queue h2')?.textContent.includes('· 3')`);
            assert.equal(await browser!.evaluate('document.querySelector(".pool-row .queue-quick")?.textContent'), 'Queued');
            assert.equal((await client.privateSeat(tokens[0]))!.queue[2].amount, undefined);
            await tab('Queue');
            await browser!.click('.queue-row:nth-child(3) .queue-actions button:last-child');
            await until('document.querySelectorAll(".queue-row").length === 2');
            await browser!.click('.queue-row:nth-child(2) .queue-actions button:first-child');
            await until(`document.querySelector('.queue-row')?.dataset.player === ${JSON.stringify(ranked[3].id)}`);
            await browser!.fill('.queue-row:first-child input', '31');
            await browser!.click('.queue-row:first-child form button');
            await sleep(250);
            assert.equal((await client.privateSeat(tokens[0]))!.queue[0].amount, 31);
            await browser!.click('.queue-row:nth-child(2) .queue-actions button:last-child');
            await until('document.querySelectorAll(".queue-row").length === 1');
            const other = await client.privateSeat(tokens[1]);
            assert.equal(other?.queue.length, 0);
            await screenshot('private-queue');
            await browser!.click('.queue-row .queue-actions button:last-child');
            await until('document.querySelectorAll(".queue-row").length === 0');
            await finish();
        });
        await check('Explicit Pass is final and own response stays private until reveal', async () => {
            await turnForMichael();
            await browser!.fill('[aria-label="Optional nomination bid"]', '');
            await search(ranked[4].name);
            await browser!.click('.nominate');
            await until('document.querySelector(".sealed-form button[type=button]")?.disabled === false');
            await browser!.click('.sealed-form button[type=button]');
            await until('document.querySelector(".own-response")?.textContent.includes("Pass ($0)")');
            assert.equal((await client.privateSeat(tokens[0]))?.response?.amount, 0);
            assert.equal((await client.privateSeat(tokens[1]))?.response, null);
            await screenshot('final-pass');
            await finish();
            assert.equal((await client.state()).sales[0].status, 'unsold');
        });
        await check('Roster slots, player details, safe-area layout, manifest and Apple web-app metadata', async () => {
            await tab('My roster');
            assert.equal(await browser!.evaluate('document.querySelectorAll(".roster .roster-row").length'), 25);
            const state = await client.state();
            assert.equal(counts(state.roster.filter(e => e.managerId === 1)).active, 1);
            const size = await browser!.evaluate<{ width: number; height: number; scroll: number }>('({width:innerWidth,height:innerHeight,scroll:document.documentElement.scrollWidth})');
            assert(size.scroll <= size.width + 1, 'The page must not overflow horizontally');
            evidence.viewport = size;
            if (mode === 'webkit') { assert.equal(size.width, 390); assert.equal(size.height, 844); }
            const manifest = await (await fetch(`${base}/manifest.webmanifest`)).json();
            assert.equal(manifest.display, 'standalone');
            assert.equal(manifest.icons.length, 2);
            for (const icon of manifest.icons) assert((await fetch(`${base}${icon.src}`)).ok);
            assert.equal(await browser!.evaluate('document.querySelector("meta[name=apple-mobile-web-app-capable]")?.content'), 'yes');
            await screenshot('roster-layout');
            evidence.manifest = manifest;
        });
        await check('One page at phone, landscape, short and desktop sizes keeps identity, deadline, response state and actions reachable', async () => {
            const longest = [...source.players].sort((a, b) => b.name.length - a.name.length)[0];
            for (const player of [ranked[30], longest]) await client.queue({ type: 'add', playerId: player.id }, tokens[0]);
            const sizes: ['phone' | 'desktop', number, number][] = [['phone', 390, 844], ['phone', 375, 667], ['phone', 360, 640],
                ['phone', 320, 568], ['phone', 390, 500], ['phone', 844, 390], ['desktop', 1440, 900], ['desktop', 1280, 720],
                ['desktop', 1220, 760], ['desktop', 1024, 700], ['desktop', 900, 600]];
            const common = ['.wordmark', '.me', '.me-budget', '.commish button:last-child', '.deadline'];
            const states: { name: string; ready: string; required: string[]; setup: () => Promise<void> }[] = [
                { name: 'bidding', ready: 'document.querySelector(".sealed-form input")?.disabled === false',
                    required: ['.response-count', '[aria-label="Sealed bid amount"]', '.sealed-form .primary', '.sealed-form .pass'],
                    setup: async () => {
                        const s = await client.state();
                        await backend.admin('testOnly:configure', { draft: { status: 'running', phase: 'nomination', nominatorId: 2,
                            lotId: null, order: [1,2,3,4,5,6,7,8,9,10], turnIndex: 1, tiePriority: s.draft.tiePriority,
                            turnSequence: (s.draft.turnSequence ?? 0) + 1 }, deadlineAfterMs: DAY });
                        const t = await client.state();
                        await client.act({ type: 'nominate', playerId: ranked[5].id, nominationGeneration: t.draft.nominationGeneration }, tokens[1]);
                        const lot = (await client.state()).lot!;
                        await client.act({ type: 'bid', lotId: lot.id, amount: 9 }, tokens[2]);
                    } },
                { name: 'responded', ready: 'Boolean(document.querySelector(".own-response"))',
                    required: ['.response-count', '.own-response'],
                    setup: async () => { await client.act({ type: 'bid', lotId: (await client.state()).lot!.id, amount: 12 }, tokens[0]); } },
                { name: 'nominating', ready: 'Boolean(document.querySelector("[aria-label=\\"Optional nomination bid\\"]"))',
                    required: ['[aria-label="Optional nomination bid"]', '.pool-row .nominate'],
                    setup: async () => { await finish(); await turnForMichael(); } }
            ];
            const geometry = (required: string[]) => `(() => {
                const vw = innerWidth, vh = innerHeight, de = document.documentElement;
                const visible = e => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
                const reach = e => { const r = e.getBoundingClientRect();
                    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + Math.min(r.height / 2, 10));
                    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
                        inView: r.width > 0 && r.height > 0 && r.x >= -1 && r.y >= -1 && r.right <= vw + 1 && r.bottom <= vh + 1,
                        hit: !!hit && (e === hit || e.contains(hit) || hit.contains(e)) }; };
                const required = ${JSON.stringify(required)}.map(selector => { const e = document.querySelector(selector);
                    return e && visible(e) ? { selector, ...reach(e) } : { selector, missing: true }; });
                const targets = [...document.querySelectorAll('.room button:not(.name-button), .room input, .room select, .room summary, .pool-row')]
                    .filter(visible).map(e => ({ text: (e.getAttribute('aria-label') || e.textContent).trim().slice(0, 40),
                        h: Math.round(e.getBoundingClientRect().height) })).filter(t => t.h > 0);
                const panel = [...document.querySelectorAll('.pool, .queue, .teams, .roster, .results')].filter(visible)
                    .map(e => ({ panel: e.className.replace('panel ', ''), height: Math.round(e.getBoundingClientRect().height),
                        scroll: e.querySelector('.scroll') ? Math.round(e.querySelector('.scroll').clientHeight) : null }));
                return { viewport: [vw, vh], document: [de.scrollWidth, de.scrollHeight], body: [document.body.scrollWidth, document.body.scrollHeight],
                    bodyOverflow: getComputedStyle(document.body).overflow, tab: document.querySelector('.room').dataset.tab,
                    tabsShown: getComputedStyle(document.querySelector('.tabbar')).display !== 'none', required, targets, panel };
            })()`;
            const proofs: unknown[] = [];
            function assertOnePage(proof: { viewport: number[]; document: number[]; body: number[]; bodyOverflow: string;
                required: { selector: string; missing?: boolean; inView?: boolean; hit?: boolean }[];
                panel: { panel: string; scroll: number | null }[]; targets: { text: string; h: number }[] }, label: string, touch: boolean) {
                const [width, height] = proof.viewport;
                assert(proof.document[0] <= width && proof.document[1] <= height && proof.body[0] <= width && proof.body[1] <= height,
                    `${label}: page overflows ${proof.document} in ${proof.viewport}`);
                assert.equal(proof.bodyOverflow, 'hidden', `${label}: body must not scroll`);
                for (const item of proof.required) assert(!item.missing && item.inView && item.hit, `${label}: ${item.selector} not reachable ${JSON.stringify(item)}`);
                for (const panel of proof.panel) assert(panel.scroll === null || panel.scroll >= 56, `${label}: ${panel.panel} scroll area ${panel.scroll}px`);
                if (touch) for (const target of proof.targets) assert(target.h >= 44, `${label}: touch target ${target.text} is ${target.h}px`);
            }
            for (const state of states) {
                await state.setup();
                for (const [form, width, height] of sizes) {
                    if (browser!.form) await browser!.form(form);
                    await browser!.resize(width, height);
                    await until(state.ready);
                    await sleep(150);
                    const label = `${state.name} ${width}x${height}`;
                    const touch = form === 'phone' || width < 1220;
                    const proof = await browser!.evaluate<Parameters<typeof assertOnePage>[0] & { tabsShown: boolean }>(geometry([...common, ...state.required]));
                    proofs.push({ state: state.name, form, size: [width, height], ...proof });
                    await screenshot(`onepage-${state.name}-${width}x${height}`);
                    assertOnePage(proof, label, touch);
                    if (proof.tabsShown && state.name === 'bidding') {
                        for (const name of ['Queue', 'Teams', 'My roster', 'Results', 'Players']) {
                            await tab(name);
                            await sleep(100);
                            const tabProof = await browser!.evaluate<Parameters<typeof assertOnePage>[0]>(geometry([...common, ...state.required]));
                            proofs.push({ state: state.name, form, size: [width, height], tab: name, ...tabProof });
                            if (name !== 'Players') await screenshot(`onepage-${state.name}-${width}x${height}-${name.replace(' ', '-').toLowerCase()}`);
                            assertOnePage(tabProof, `${label} ${name}`, touch);
                        }
                    }
                    if (form === 'phone' && height > width && state.name !== 'responded') {
                        const input = state.name === 'bidding' ? '[aria-label="Sealed bid amount"]' : '[aria-label="Optional nomination bid"]';
                        const keyboard = await browser!.evaluate<{ bottom: number; limit: number; focused: boolean }>(`(() => {
                            const e = document.querySelector('${input.replace(/"/g, '\\"')}'); e.focus();
                            return { bottom: Math.round(e.getBoundingClientRect().bottom), limit: Math.round(innerHeight * 0.58),
                                focused: document.activeElement === e }; })()`);
                        proofs.push({ state: state.name, size: [width, height], keyboardEstimate: '42% of viewport height', ...keyboard });
                        assert(keyboard.focused && keyboard.bottom <= keyboard.limit,
                            `${label}: focused amount field ends at ${keyboard.bottom}px, under an on-screen keyboard estimate (limit ${keyboard.limit}px)`);
                        await browser!.evaluate('(document.activeElement.blur(), true)');
                    }
                }
                if (browser!.form) await browser!.form('phone');
            }
            evidence.onePage = proofs;
            await writeEvidenceFile(`${root}/one-page.json`, JSON.stringify(proofs, null, 2));
        });
        await check('Long queue: API readback matches the UI; deep reorder, amount edit and remove work; an add on your own turn nominates the first entry', async () => {
            if (browser!.form) await browser!.form('phone');
            await browser!.resize(mode === 'webkit' ? 390 : 1440, mode === 'webkit' ? 844 : 1000);
            const s = await client.state();
            await backend.admin('testOnly:configure', { draft: { status: 'running', phase: 'nomination', nominatorId: 3,
                lotId: null, order: [1,2,3,4,5,6,7,8,9,10], turnIndex: 2, tiePriority: s.draft.tiePriority,
                turnSequence: (s.draft.turnSequence ?? 0) + 1 }, deadlineAfterMs: DAY });
            // Off Michael's turn, so clearing the queue cannot nominate from it.
            for (const entry of (await client.privateSeat(tokens[0]))!.queue) await client.queue({ type: 'remove', id: entry.id }, tokens[0]);
            const sold = new Set((await client.state()).roster.map(entry => entry.playerId));
            const free = ranked.filter(player => !sold.has(player.id)).slice(40, 52);
            for (const [index, player] of free.slice(0, 11).entries())
                await client.queue({ type: 'add', playerId: player.id, ...(index % 3 === 0 ? { amount: 5 + index } : {}) }, tokens[0]);
            await tab('Players');
            await search(free[11].name);
            await browser!.click('.pool-row .queue-quick');
            await until(`document.querySelector('.queue h2')?.textContent === 'My queue · 12'`);
            const readback = async () => (await client.privateSeat(tokens[0]))!.queue;
            assert.deepEqual((await readback()).map(entry => entry.playerId), free.map(player => player.id));
            if (await browser!.evaluate('document.querySelector(".tabbar .tab-queue").getClientRects().length > 0'))
                assert.equal(await browser!.evaluate('document.querySelector(".tabbar .tab-queue .badge")?.textContent'), '12');
            await tab('Queue');
            await until('document.querySelectorAll(".queue-row").length === 12');
            await browser!.click('.queue-row:nth-child(12) .queue-actions button:first-child');
            await until(`document.querySelector('.queue-row:nth-child(11)')?.dataset.player === ${JSON.stringify(free[11].id)}`);
            assert.deepEqual((await readback()).slice(10).map(entry => entry.playerId), [free[11].id, free[10].id]);
            await browser!.fill('.queue-row:nth-child(10) input', '27');
            await browser!.click('.queue-row:nth-child(10) form button');
            await until(`document.querySelector('.queue-row:nth-child(10) input')?.value === '27'`);
            await sleep(250);
            assert.equal((await readback())[9].amount, 27);
            await browser!.click('.queue-row:nth-child(12) .queue-actions button:last-child');
            await until('document.querySelectorAll(".queue-row").length === 11');
            assert.equal((await readback()).length, 11);
            assert(!(await readback()).some(entry => entry.playerId === free[10].id));
            await screenshot('long-queue');
            await turnForMichael();
            const before = await readback();
            const extra = ranked.filter(player => !sold.has(player.id) && !free.includes(player))[60];
            await search(extra.name);
            await browser!.click('.name-button');
            await until('Boolean(document.querySelector(".queue-add button"))');
            assert.equal(before.length, 11);
            await browser!.click('.queue-add button');
            // The count stays 11 (one added, one nominated), so wait for the nominated lot itself.
            await until(`document.querySelector('.lot-heading h2')?.textContent === ${JSON.stringify(findName(before[0].playerId))}`);
            assert.equal(await browser!.evaluate(`document.querySelector('.queue h2')?.textContent`), 'My queue · 11');
            const after = await client.state();
            assert.equal(after.lot?.nominatorId, 1);
            assert.equal(after.lot?.playerId, before[0].playerId);
            assert.deepEqual((await readback()).map(entry => entry.playerId), [...before.slice(1), { playerId: extra.id }].map(entry => entry.playerId));
            assert.equal((await client.privateSeat(tokens[0]))?.response?.amount, before[0].amount);
            evidence.ownTurnQueueAdd = { queuedBefore: before.length, added: extra.id, nominated: before[0].playerId,
                attachedAmount: before[0].amount ?? null, queuedAfter: (await readback()).length, lotNominator: after.lot?.nominatorId };
            await screenshot('own-turn-queue-add');
            await finish();
        });
        if (mode === 'safari') await check('Actual standalone route attempted; separate emulated standalone presentation in real Safari', async () => {
            evidence.actualStandaloneAttempt = await browser!.standalone!();
            await browser!.resize(500, 900);
            await browser!.evaluate('document.documentElement.classList.add("emulated-standalone")');
            evidence.standaloneLabel = 'emulated standalone';
            for (const name of ['Players','Teams','My roster','Results']) {
                await tab(name);
                const geometry = await browser!.evaluate<{ width: number; scrollWidth: number; height: number; panelHeight: number }>(`(() => {
                    const panel = [...document.querySelectorAll('.panel')].find(p => p.classList.contains(${JSON.stringify(name === 'Players' ? 'pool' : name === 'Teams' ? 'teams' : name === 'My roster' ? 'roster' : 'results')}));
                    return {width:innerWidth,scrollWidth:document.documentElement.scrollWidth,height:innerHeight,panelHeight:panel.getBoundingClientRect().height};
                })()`);
                assert(geometry.scrollWidth <= geometry.width + 1);
                assert(geometry.panelHeight >= 100, 'Standalone panels retain usable scroll space');
            }
            await screenshot('emulated-standalone');
        });
    } catch (error) {
        evidence.error = String(error);
        if (browser) {
            try { await screenshot('failure'); evidence.failedText = await browser.evaluate('document.body.innerText'); } catch {}
        }
        throw error;
    } finally {
        try { await browser?.close(); } finally {
            if (server) await stopProcess(server);
            await backend.close();
            await writeEvidenceFile(`${root}/server.log`, serverLog);
            await writeEvidenceFile(`${root}/commands.json`, JSON.stringify(commands, null, 2));
            await writeEvidenceFile(`${root}/evidence.json`, JSON.stringify(evidence, null, 2));
        }
    }
}
withResources(main).catch(error => { console.error(error); process.exitCode = 1; });
