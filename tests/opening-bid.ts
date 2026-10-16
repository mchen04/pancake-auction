import { makeEvidenceDirectory as mkdir, writeEvidenceFile as writeFile, bundleEvidence } from '../scripts/evidence';
import { withResources, runBrowser, ownServer, listen } from '../scripts/resources';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { createIsolated, dropIsolated, seedManagers, seedPlayers, claimSeat,
    currentBackend, currentClient, getState, sleep, syntheticPool } from './support';


const execute = promisify(execFile);
const require = createRequire(resolve('package.json'));
const { build }: typeof import('esbuild') = require('esbuild');
const session = `pancake-opening-bid-${crypto.randomUUID()}`;
const results: { name: string; result: string; proof?: unknown; error?: string }[] = [];
async function browser(...args: string[]) {
    return runBrowser(session,args,25000);
}
async function evaluate<T>(expression: string): Promise<T> { return JSON.parse(await browser('eval', expression)); }
async function until(expression: string, timeout = 12000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) { if (await evaluate<boolean>(expression)) return; await sleep(50); }
    throw new Error(`Not ready: ${expression}`);
}
async function check(name: string, run: () => Promise<unknown>) {
    const items = process.argv.find(arg => arg.startsWith('--items='))?.slice(8).split(',');
    if (items && !items.some(item => name.startsWith(item))) return;
    try { const proof = await run(); results.push({ name, result: 'passed', proof }); console.log(`PASS ${name}`); }
    catch (error) {
        results.push({ name, result: 'failed', error: String(error) }); console.log(`FAIL ${name}: ${error}`);
        const observed = await evaluate(`({tab:document.querySelector('.room')?.dataset.tab,
            focused:document.activeElement?.textContent?.slice(0,100),scrollY,
            clicks:window.control?.clicks,buttons:[...document.querySelectorAll('.tabbar button')]
                .map(button=>({text:button.textContent,selected:button.getAttribute('aria-selected'),
                    bounds:button.getBoundingClientRect().toJSON()}))})`).catch(String);
        await writeFile(`${process.env.EVIDENCE_DIR}/opening-bid/failure-${results.length}.json`,
            JSON.stringify({ error:String(error),observed,state:await getState() },null,2));
    }
}
async function main() {
    const evidence = `${process.env.EVIDENCE_DIR}/opening-bid`;
    await mkdir(evidence, { recursive: true });
    await bundleEvidence(build, { entryPoints: ['tests/turn-client-harness.tsx'], outfile: `${evidence}/bundle.js`, bundle: true,
        format: 'iife', platform: 'browser', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } });
    const isolated = await createIsolated('test');
    await seedManagers(); await seedPlayers(syntheticPool());
    assert.equal((await getState()).draft.nominationMs, 10000);
    const commissionerToken = await claimSeat(1);
    const otherToken = await claimSeat(2);
    let token = commissionerToken;
    const tokens = new Map([[1,commissionerToken],[2,otherToken]]);
    for(let id=3;id<=10;id++)tokens.set(id,await claimSeat(id));
    let initial = await getState();
    const skew = 0;
    const css = ':root{--font-display:Arial;--font-body:Arial}' + await readFile('app/globals.css', 'utf8');
    const server = ownServer(createServer(async (request, response) => {
        if (request.url === '/bundle.js') {
            response.setHeader('Content-Type', 'text/javascript');
            response.end(await readFile(`${evidence}/bundle.js`));
        } else if (request.url === '/style.css') {
            response.setHeader('Content-Type', 'text/css'); response.end(css);
        } else {
            response.setHeader('Content-Type', 'text/html; charset=utf-8');
            response.end('<!doctype html><html><head><meta name="viewport" content="width=device-width">'
                + '<link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script>window.initial='
                + JSON.stringify(initial) + ';window.config='
                + JSON.stringify({ token, url: currentBackend().url, skew })
                + '</script><script src="/bundle.js"></script></body></html>');
        }
    }));
    await listen(server, 0, '127.0.0.1');
    const address = server.address();
    assert(address && typeof address !== 'string');
    const open = async (mode = 'components') => {
        await browser('set', 'viewport', '390', '844');
        await browser('open', `http://127.0.0.1:${address.port}/?mode=${mode}`);
        await browser('wait', mode === 'room' ? '.room' : '.commish');
    };
    try {
        await check('C28 event eviction preserves the focused opening and public nomination amount', async () => {
            await currentClient().act({type:'start'},commissionerToken);
            let first=await getState();
            await currentClient().act({type:'nominate',playerId:'test-0',amount:1,
                nominationGeneration:first.draft.nominationGeneration},tokens.get(first.draft.nominatorId!)!);
            first=await getState();
            if(first.lot!.highBidderId!==2)await currentClient().act({type:'bid',lotId:first.lot!.id,amount:2},otherToken);
            first=await getState();
            await currentClient().act({type:'force',lotId:first.lot!.id,
                expectedHighBidderId:first.lot!.highBidderId,expectedHighBid:first.lot!.highBid},commissionerToken);
            let waiting = await getState();
            while (waiting.draft.nominatorId !== 2) {
                const player = waiting.players.find(player => !waiting.roster.some(entry => entry.playerId === player.id))!;
                const nextToken = tokens.get(waiting.draft.nominatorId!)!;
                await currentClient().act({ type:'nominate',playerId:player.id,amount:1,
                    nominationGeneration:waiting.draft.nominationGeneration },nextToken);
                waiting = await getState();
                await currentClient().act({ type:'bid',lotId:waiting.lot!.id,amount:2 },otherToken);
                waiting = await getState();
                await currentClient().act({ type:'force',lotId:waiting.lot!.id,
                    expectedHighBidderId:waiting.lot!.highBidderId,expectedHighBid:waiting.lot!.highBid },commissionerToken);
                waiting = await getState();
            }
            await currentClient().act({type:'pause'},commissionerToken);
            const started=await getState();
            token=tokens.get(started.draft.nominatorId!)!;
            initial=await getState(); await open('room');
            await until(`document.querySelector('input[aria-label="Opening bid"]')!==null`);
            let placement:'active'|'taxi'='active';
            const move=async()=>{placement=placement==='active'?'taxi':'active';
                await currentClient().act({type:'place',playerId:'test-0',placement},otherToken);};
            while((await getState()).recentEvents.findIndex(event=>event.type==='turn')<28)await move();
            await currentClient().act({type:'resume'},commissionerToken);
            await until(`document.querySelector('.headline').classList.contains('running')`);
            const delay = Number(process.env.OPENING_TEST_DELAY_MS ?? 0);
            if (delay) await sleep(delay);
            const interactive = await getState();
            await writeFile(`${evidence}/interactive-turn.json`, JSON.stringify({ draft: interactive.draft,
                serverNow: interactive.serverNow, delay, events: interactive.recentEvents }, null, 2));
            assert.equal(interactive.draft.phase, 'nomination');
            assert.equal(interactive.draft.nominatorId, started.draft.nominatorId);
            const geometry = await evaluate<{ height: number; viewport: number; scroll: number }>(`({
                height:Math.max(document.body.scrollHeight,document.documentElement.scrollHeight),
                viewport:innerHeight,scroll:scrollY})`);
            assert(geometry.height <= geometry.viewport); assert.equal(geometry.scroll, 0);
            await browser('click','.tabbar button:nth-child(4)');
            await until(`document.querySelector('.room').dataset.tab==='results'`);
            const click = await evaluate<{ target: string; x: number; y: number }>(
                `window.control.clicks.filter(event=>event.type==='click').at(-1)`);
            assert.equal(click.target, 'Results'); assert(click.y >= 0 && click.y <= geometry.viewport);
            await writeFile(`${evidence}/tab-click.json`, JSON.stringify({ geometry, click }));
            await browser('fill','input[aria-label="Opening bid"]','25');
            const read=()=>evaluate<{text:string;title:string;tab:string;focused:boolean}>(`({
                text:document.querySelector('input[aria-label="Opening bid"]').value,
                title:document.querySelector('.nominate').title,tab:document.querySelector('.room').dataset.tab,
                focused:document.activeElement===document.querySelector('input[aria-label="Opening bid"]')})`);
            const before=await read(),stateBefore=await getState();
            await writeFile(`${evidence}/boundary-29.json`,JSON.stringify({before,stateBefore},null,2));
            assert.equal(stateBefore.recentEvents.findIndex(event=>event.type==='turn'),29);
            assert.equal(before.text,'25');assert.equal(before.title,'Nominate at $25');
            assert.equal(before.tab,'results');
            const transitions=await evaluate<number>('window.control.transitions');
            await move();
            await until(`window.control.transitions>${transitions}`);
            await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))');
            const after=await read(),stateAfter=await getState();
            assert.equal(stateAfter.recentEvents.findIndex(event=>event.type==='turn'),-1);
            const reconnects=await evaluate<number>('window.control.sockets.length');
            await evaluate('window.control.sockets.at(-1).close();true');
            await until(`window.control.sockets.length>${reconnects}&&window.control.sockets.at(-1).readyState===1`);
            await sleep(300);
            const reconnected=await read();
            assert.equal(stateBefore.draft.nominationGeneration,stateAfter.draft.nominationGeneration);
            await browser('screenshot',`${evidence}/evicted.png`);
            await writeFile(`${evidence}/before-nomination.json`,JSON.stringify({before,after},null,2));
            await evaluate('document.querySelector(".nominate").click();true');
            for(let i=0;i<100;i++){if((await getState()).lot)break;await sleep(50);}
            const final=await getState();
            const proof={before,after,reconnected,turnEventBefore:stateBefore.recentEvents[29].id,
                sameNominationGeneration:stateBefore.draft.nominationGeneration===stateAfter.draft.nominationGeneration,
                actualOpening:final.lot?.highBid,fixture:'Public start, nomination, bid, Force, pause, resume and placements only'};
            await writeFile(`${evidence}/eviction.json`,JSON.stringify(proof,null,2));
            assert.equal(after.text,'25');assert.equal(after.title,'Nominate at $25');assert(after.focused);
            assert.equal(after.tab,'results');assert.equal(reconnected.text,'25');
            assert.equal(reconnected.title,'Nominate at $25');assert.equal(final.lot?.highBid,25);
            return proof;
        });
        await check('C28 a real new turn resets the opening and selected tab together', async () => {
            const original=(await getState()).draft.nominatorId!;
            let state=await getState();
            const generation=state.draft.nominationGeneration;
            for(let turns=0;turns<11;turns++) {
                if(state.lot)await currentClient().act({type:'force',lotId:state.lot.id,
                    expectedHighBidderId:state.lot.highBidderId,expectedHighBid:state.lot.highBid},commissionerToken);
                state=await getState();
                if(state.draft.nominatorId===original)break;
                const player=state.players.find(player=>!state.roster.some(entry=>entry.playerId===player.id))!;
                await currentClient().act({type:'nominate',playerId:player.id,amount:1,
                    nominationGeneration:state.draft.nominationGeneration},tokens.get(state.draft.nominatorId!)!);
                state=await getState();
            }
            assert.equal(state.draft.nominatorId,original);
            assert.notEqual(state.draft.nominationGeneration,generation);
            await until(`document.querySelector('input[aria-label="Opening bid"]')?.value==='1'`);
            const shown=await evaluate<{ amount: string; title: string; tab: string }>(`({amount:document.querySelector('input[aria-label="Opening bid"]').value,
                title:document.querySelector('.nominate').title,tab:document.querySelector('.room').dataset.tab})`);
            assert.equal(shown.title,'Nominate at $1');assert.equal(shown.tab,'players');
            return {generation:state.draft.nominationGeneration,shown};
        });
        await check('Opening edits keep key-by-key text and submit exactly thirty dollars', async () => {
            await browser('fill', 'input[aria-label="Opening bid"]', '25');
            await browser('focus', 'input[aria-label="Opening bid"]');
            await browser('press', 'End');
            await browser('press', 'Backspace');
            await browser('press', 'Backspace');
            await browser('press', '3');
            await browser('press', '0');
            const typed = await evaluate<string>(`document.querySelector('[aria-label="Opening bid"]').value`);
            await evaluate('document.querySelector(".nominate").click();true');
            for (let i = 0; i < 100; i++) { if ((await getState()).lot) break; await sleep(50); }
            const actual = (await getState()).lot?.highBid;
            await writeFile(`${evidence}/key-edit.json`, JSON.stringify({ typed, actual }));
            assert.equal(typed, '30'); assert.equal(actual, 30);
            return { typed, actual };
        });
        await check('Undo restores a new input turn while pause and resume retain the same turn', async () => {
            let state = await getState();
            assert(state.lot);
            await currentClient().act({ type: 'force', lotId: state.lot.id,
                expectedHighBidderId: state.lot.highBidderId, expectedHighBid: state.lot.highBid }, commissionerToken);
            state = await getState();
            await currentClient().act({ type: 'undo', lotId: state.sales[0].id }, commissionerToken);
            await currentClient().act({ type: 'resume' }, commissionerToken);
            await until(`document.querySelector('.headline').classList.contains('running')`);
            await browser('fill', 'input[aria-label="Opening bid"]', '25');
            await browser('click', '.tabbar button:nth-child(4)');
            const before = await getState();
            await currentClient().act({ type: 'pause' }, commissionerToken);
            await until(`document.querySelector('.headline').classList.contains('paused')`);
            await currentClient().act({ type: 'resume' }, commissionerToken);
            await until(`document.querySelector('.headline').classList.contains('running')`);
            const shown = await evaluate<{ amount: string; tab: string }>(`({
                amount:document.querySelector('input[aria-label="Opening bid"]').value,
                tab:document.querySelector('.room').dataset.tab})`);
            await evaluate('document.querySelector(".nominate").click();true');
            for (let i = 0; i < 100; i++) { if ((await getState()).lot) break; await sleep(50); }
            const after = await getState();
            const proof = { before: before.draft, after: after.draft, shown, actual: after.lot?.highBid };
            await writeFile(`${evidence}/pause-turn.json`, JSON.stringify(proof, null, 2));
            await currentClient().act({ type: 'force', lotId: after.lot!.id,
                expectedHighBidderId: after.lot!.highBidderId, expectedHighBid: after.lot!.highBid }, commissionerToken);
            await currentClient().act({ type: 'undo', lotId: after.lot!.id }, commissionerToken);
            const undone = await getState();
            await currentClient().act({ type: 'resume' }, commissionerToken);
            await until(`document.querySelector('input[aria-label="Opening bid"]')?.value==='1'
                &&document.querySelector('.room').dataset.tab==='players'`);
            await until(`document.querySelector('.headline').classList.contains('running')`);
            assert.notEqual(before.draft.nominationGeneration, after.draft.nominationGeneration);
            assert.equal(before.draft.turnSequence, after.draft.turnSequence);
            assert.notEqual(undone.draft.turnSequence, after.draft.turnSequence);
            assert.equal(shown.amount, '25'); assert.equal(shown.tab, 'results'); assert.equal(after.lot?.highBid, 25);
            return proof;
        });
        await check('Opening normalization occurs on blur for empty and over-cap edits', async () => {
            await browser('fill', 'input[aria-label="Opening bid"]', '');
            const empty = await evaluate<string>(`document.querySelector('input[aria-label="Opening bid"]').value`);
            await browser('press', 'Tab');
            const normalized = await evaluate<string>(`document.querySelector('input[aria-label="Opening bid"]').value`);
            await browser('fill', 'input[aria-label="Opening bid"]', '5000');
            const editing = await evaluate<string>(`document.querySelector('input[aria-label="Opening bid"]').value`);
            await browser('press', 'Tab');
            const clamped = await evaluate<{ amount: string; title: string }>(`({
                amount:document.querySelector('input[aria-label="Opening bid"]').value,
                title:document.querySelector('.nominate').title})`);
            await writeFile(`${evidence}/normalize.json`, JSON.stringify({ empty, normalized, editing, clamped }));
            assert.equal(empty, ''); assert.equal(normalized, '1'); assert.equal(editing, '5000');
            assert(Number(clamped.amount) <= 1000); assert.equal(clamped.title, `Nominate at $${clamped.amount}`);
            return { empty, normalized, editing, clamped };
        });
        await check('C28 the displayed opening is the clamped nomination amount', async () => {
            await browser('fill','input[aria-label="Opening bid"]','5000');
            await browser('press', 'Tab');
            const clamped=await evaluate<{amount:string;title:string}>(`({
                amount:document.querySelector('input[aria-label="Opening bid"]').value,
                title:document.querySelector('.nominate').title})`);
            assert(Number(clamped.amount)<=1000);
            assert.equal(clamped.title,`Nominate at $${clamped.amount}`);
            return clamped;
        });
        await check('Direct nomination normalizes focused text before a delayed query transition', async () => {
            await browser('fill', 'input[aria-label="Opening bid"]', '5000');
            const before = await evaluate<{ amount: string; cap: number }>(`({
                amount:document.querySelector('input[aria-label="Opening bid"]').value,
                cap:Number(document.querySelector('.nominate').title.replace(/[^0-9]/g,''))})`);
            await evaluate('window.control.delay=2000;document.querySelector(".nominate").click();true');
            await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))');
            const sending = await evaluate<{ amount: string; busy: boolean }>(`({
                amount:document.querySelector('input[aria-label="Opening bid"]')?.value,
                busy:document.querySelector('.nominate')?.disabled})`);
            const state = await getState();
            const price = state.lot?.highBid ?? state.sales[0]?.highBid;
            await writeFile(`${evidence}/direct-submit.json`, JSON.stringify({ before, sending, price }));
            assert.equal(before.amount, '5000'); assert.equal(sending.amount, String(before.cap));
            assert(sending.busy); assert.equal(price, before.cap);
            await sleep(2200); await evaluate('window.control.delay=0;true');
            return { before, sending, price };
        });
    } finally {
        try {
            await browser('close');
            for (let i = 0; ; i++) {
                if (!(await execute('agent-browser', ['session', 'list'])).stdout.includes(session)) break;
                assert(i < 100); await sleep(50);
            }
        } finally {
            await new Promise<void>(resolve => server.close(() => resolve())); await dropIsolated(isolated);
            await writeFile(`${evidence}/results.json`, JSON.stringify(results, null, 2));
        }
    }
    assert(results.every(result => result.result === 'passed'), 'Every client boundary check must pass');
}
withResources(main).catch(error => { console.error(error); process.exitCode = 1; });
