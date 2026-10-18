import { sizes, geometry, assertOnePage } from './browser-layout';
import { driver, mode, label, commands, watchClockRequests, type Driver } from './browser-driver';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { AuctionClient } from '../lib/client';
import { counts } from '../lib/rules';
import { DAY } from '../lib/sealed';
import { recordedPool } from '../scripts/pool-source';
import { freePort, localBackend, sleep, stopProcess } from '../scripts/local-backend';
import { withResources, ownProcess } from '../scripts/resources';
import { makeEvidenceDirectory, writeEvidenceFile } from '../scripts/evidence';

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
        await backend.admin('testOnly:legacy', { status: 'setup', unclaimed: true });
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
        await check('Legacy setup: claim commissioner, restore seat, wait to queue, then Start converts the room', async () => {
            await until('document.querySelectorAll(".seat-grid button").length === 10');
            await browser!.click('.seat-grid button:first-child');
            await until('Boolean(document.querySelector(".me")) || document.body.innerText.includes("Legacy draft is read-only")');
            await screenshot('legacy-setup');
            assert.equal(await browser!.evaluate('document.body.innerText.includes("Legacy draft is read-only")'), false);
            await until('document.querySelector(".me")?.textContent === "Michael"');
            assert.equal(await browser!.evaluate('document.querySelector(".nomination h2")?.textContent'), '1 of 10 managers joined');
            assert.equal(await browser!.evaluate('document.querySelector(".nomination .primary")?.textContent'), 'Start draft');
            assert.equal(await browser!.evaluate('document.querySelector(".pool-row .queue-quick")?.disabled'), true);
            await browser!.click('.pool .table-head + .pool-row .name-button');
            await until('Boolean(document.querySelector(".queue-add button"))');
            assert.equal(await browser!.evaluate('document.querySelector(".queue-add button")?.disabled'), true);
            assert.match(await browser!.evaluate<string>('document.querySelector(".queue-add").textContent'), /Available when the commissioner starts/);
            await browser!.click('.pool .table-head + .pool-row .name-button');
            await tab('Queue');
            assert.match(await browser!.evaluate<string>('document.querySelector(".queue").textContent'), /Available when the commissioner starts/);
            await tab('Players');
            tokens[0] = await browser!.evaluate<string>('localStorage.getItem("pancake-seat")');
            for (let id = 2; id <= 10; id++) tokens[id - 1] = await client.claim(id);
            await browser!.open(base);
            await until('document.querySelector(".me")?.textContent === "Michael"');
            await browser!.click('.nomination .primary');
            await until('!document.querySelector(".nomination .primary")');
            const started = (await client.state()).draft;
            assert.equal(started.mode, 'sealed-v1');
            assert.equal(started.status, 'running');
            assert.equal(started.order.length, 10);
            assert.deepEqual(started.tiePriority, [...started.order].reverse());
            await screenshot('legacy-started');
            assert.equal(await browser!.evaluate('document.body.innerText.includes("Force end")'), false);
        });
        const ranked = [...source.players].sort((a,b) => (b.projection ?? -Infinity) - (a.projection ?? -Infinity));
        await check('Blind wake events send no clock-sync requests', async () => {
            await watchClockRequests(browser!);
            await sleep(500);
            assert.equal(await browser!.evaluate('window.auctionClockRequests'), 0);
            assert.equal(await browser!.evaluate('Boolean(document.querySelector(".shot-clock, .clock-status"))'), false);
        });
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
            // Earlier checks leave a one-player search; measure the full pool so the player table shows realistic rows.
            await tab('Players');
            await browser!.evaluate(`(() => { const input = document.querySelector('[aria-label="Search players or team"]');
                Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '');
                return input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
            await until('document.querySelectorAll(".pool-row").length > 20');
            // Phones drop the wordmark so the top bar stays one row (the installed app already carries the name).
            const common = (width: number) => [...(width > 860 ? ['.wordmark'] : []), '.me', '.me-budget', '.commish button:last-child', '.deadline'];
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
            const proofs: unknown[] = [];
            type Box = { top: number; bottom: number; left: number; right: number };
            // Touch layouts keep the tabs on the bottom edge; phones in portrait stack panel, decision card, then tabs,
            // with the amount field and its buttons on one row in the lower half where thumbs reach. When the
            // keyboard opens, iOS lifts that whole row with the focused field.
            function assertThumb(proof: { viewport: number[]; thumb: { tabbar: Box; block: Box; panel: Box | null;
                controls: (Box & { text: string })[] } }, label: string, portrait: boolean) {
                const [, height] = proof.viewport;
                const { tabbar, block, panel, controls } = proof.thumb;
                assert(tabbar.bottom >= height - 12, `${label}: tabs end at ${tabbar.bottom}px, not at the bottom of ${height}px`);
                if (!portrait) return;
                assert(block.bottom <= tabbar.top + 1 && (!panel || panel.bottom <= block.top + 1),
                    `${label}: expected panel, card, tabs from top to bottom ${JSON.stringify(proof.thumb)}`);
                for (const control of controls) assert(control.top >= height / 2, `${label}: ${control.text} at ${control.top}px is out of thumb reach`);
                const rows = new Set(controls.filter(control => control.text !== 'Optional nomination bid').map(control => control.top));
                assert(rows.size <= 1, `${label}: bid field and its buttons are split across rows ${JSON.stringify(controls)}`);
            }
            const tables = new Set<string>();
            function assertTable(table: { head: { gap: number; labels: string[] }; posGap: number | null; rows: number; rowGap: number;
                crowded: unknown[]; overflowX: number } | null, label: string, size: string) {
                if (!table) return;
                assert(table.posGap === null || table.posGap >= 6, `${label}: header labels touch the first player row (${table.posGap}px)`);
                for (const stat of ['Pos', 'Age', 'GP', 'Proj', 'ADP']) assert(table.head.labels.some(text => text.startsWith(stat)),
                    `${label}: player table hides ${stat} (${table.head.labels})`);
                assert(table.rows >= 1, `${label}: no player row fully on screen`);
                assert(table.head.gap >= 8 && table.rowGap >= 8, `${label}: player columns crowd: header ${table.head.gap}px, rows ${table.rowGap}px ${JSON.stringify(table.crowded)}`);
                assert(table.overflowX <= 1, `${label}: player table overflows its panel by ${table.overflowX}px`);
                if (table.rows >= 2) tables.add(size);
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
                    const proof = await browser!.evaluate<Parameters<typeof assertOnePage>[0] & Parameters<typeof assertThumb>[0] & { tabsShown: boolean; table: Parameters<typeof assertTable>[0] }>(geometry([...common(width), ...state.required]));
                    proofs.push({ state: state.name, form, size: [width, height], ...proof });
                    await screenshot(`onepage-${state.name}-${width}x${height}`);
                    assertOnePage(proof, label, touch);
                    assertTable(proof.table, label, `${width}x${height}`);
                    if (proof.tabsShown && state.name === 'bidding') {
                        for (const name of ['Queue', 'Teams', 'My roster', 'Results', 'Players']) {
                            await tab(name);
                            await sleep(100);
                            const tabProof = await browser!.evaluate<Parameters<typeof assertOnePage>[0] & Parameters<typeof assertThumb>[0] & { table: Parameters<typeof assertTable>[0] }>(geometry([...common(width), ...state.required]));
                            proofs.push({ state: state.name, form, size: [width, height], tab: name, ...tabProof });
                            if (name !== 'Players') await screenshot(`onepage-${state.name}-${width}x${height}-${name.replace(' ', '-').toLowerCase()}`);
                            assertOnePage(tabProof, `${label} ${name}`, touch);
                            assertTable(tabProof.table, `${label} ${name}`, `${width}x${height}`);
                            assertThumb(tabProof, `${label} ${name}`, form === 'phone' && height > width);
                        }
                    }
                    if (proof.tabsShown) assertThumb(proof, label, form === 'phone' && height > width);
                }
                if (browser!.form) await browser!.form('phone');
            }
            for (const size of ['390x844', '375x667', '1440x900', '1280x720', '1024x700'])
                assert(tables.has(size), `Player columns were not measured over two or more rows at ${size}`);
            evidence.onePage = proofs;
            await writeEvidenceFile(`${root}/one-page.json`, JSON.stringify(proofs, null, 2));
        });
        await check('Emulated iPhone standalone 390x844: safe areas, panels between top bar and bottom card, tabs above the home indicator', async () => {
            if (browser!.form) await browser!.form('phone');
            await browser!.resize(390, 844);
            const s = await client.state();
            await backend.admin('testOnly:configure', { draft: { status: 'running', phase: 'nomination', nominatorId: 2,
                lotId: null, order: [1,2,3,4,5,6,7,8,9,10], turnIndex: 1, tiePriority: s.draft.tiePriority,
                turnSequence: (s.draft.turnSequence ?? 0) + 1 }, deadlineAfterMs: DAY });
            const t = await client.state();
            await client.act({ type: 'nominate', playerId: ranked[8].id, nominationGeneration: t.draft.nominationGeneration }, tokens[1]);
            await client.act({ type: 'bid', lotId: (await client.state()).lot!.id, amount: 14 }, tokens[3]);
            await until('document.querySelector(".sealed-form input")?.disabled === false');
            // iPhone portrait insets (status bar 47px, home indicator 34px) applied through the app's own safe-area variables.
            await browser!.evaluate(`(() => { const style = document.createElement('style'); style.id = 'standalone-insets';
                style.textContent = ':root{--safe-top:47px;--safe-bottom:34px}'; document.head.append(style); return true; })()`);
            await tab('Players');
            await browser!.evaluate('([...document.querySelectorAll(".pool-row.expanded .name-button")].forEach(button => button.click()), true)');
            const frames: unknown[] = [];
            for (const name of ['Players', 'Queue', 'Teams', 'My roster', 'Results']) {
                await tab(name);
                await sleep(150);
                const frame = await browser!.evaluate<{ viewport: number[]; document: number[]; me: number; tabs: number; tabbar: number;
                    card: number[]; panel: number[]; scroll: number }>(`(() => {
                    const r = e => e.getBoundingClientRect(), panel = [...document.querySelectorAll('.pool, .queue, .teams, .roster, .results')]
                        .find(e => e.getClientRects().length);
                    return { viewport: [innerWidth, innerHeight], document: [document.documentElement.scrollWidth, document.documentElement.scrollHeight],
                        me: Math.round(r(document.querySelector('.me-box')).top), tabs: Math.round(Math.max(...[...document.querySelectorAll('.tabbar button')].map(e => r(e).bottom))),
                        tabbar: Math.round(r(document.querySelector('.tabbar')).bottom), card: [Math.round(r(document.querySelector('.block')).top), Math.round(r(document.querySelector('.block')).bottom)],
                        panel: [Math.round(r(panel).top), Math.round(r(panel).bottom)], scroll: Math.round(panel.querySelector('.scroll').clientHeight) }; })()`);
                frames.push({ tab: name, ...frame });
                await screenshot(`standalone-390x844-${name.replace(' ', '-').toLowerCase()}`);
                assert(frame.document[0] <= 390 && frame.document[1] <= 844, `${name}: page overflows ${frame.document}`);
                assert(frame.me >= 47, `${name}: identity under the status bar (${frame.me}px)`);
                assert(frame.tabs <= 844 - 34 && frame.tabbar >= 843, `${name}: tabs ${frame.tabs}px / bar ${frame.tabbar}px vs home indicator`);
                assert(frame.panel[1] <= frame.card[0] && frame.card[1] <= frame.tabs - 40, `${name}: order ${JSON.stringify(frame)}`);
                assert(frame.scroll >= 100, `${name}: panel scroll area ${frame.scroll}px`);
            }
            evidence.standalone = { insets: { top: 47, bottom: 34 }, frames };
            await browser!.evaluate('(document.getElementById("standalone-insets").remove(), true)');
            await finish();
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
        await check('Legacy setup with auction data shows the Start error; legacy running stays read-only', async () => {
            await backend.admin('testOnly:reset');
            await backend.admin('testOnly:legacy', { status: 'setup', data: 'lot' });
            await until('document.querySelector(".nomination .primary")?.textContent === "Start draft"');
            const before = (await backend.admin('admin:inspect')).draft.value;
            await browser!.click('.nomination .primary');
            await until('document.querySelector(".toast")?.textContent.includes("Existing lots require commissioner migration")');
            assert.deepEqual((await backend.admin('admin:inspect')).draft.value, before);
            await screenshot('legacy-start-refused');
            await backend.admin('testOnly:reset');
            await backend.admin('testOnly:legacy', { status: 'running' });
            await until('document.body.innerText.includes("Legacy draft is read-only")');
            assert.equal(await browser!.evaluate('Boolean(document.querySelector(".nomination .primary"))'), false);
            await screenshot('legacy-running-read-only');
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
