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
    }
}
async function main() {
    const evidence = `${process.env.EVIDENCE_DIR}/opening-bid`;
    await mkdir(evidence, { recursive: true });
    await bundleEvidence(build, { entryPoints: ['tests/turn-client-harness.tsx'], outfile: `${evidence}/bundle.js`, bundle: true,
        format: 'iife', platform: 'browser', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } });
    const isolated = await createIsolated('test');
    await seedManagers(); await seedPlayers(syntheticPool());
    const commissionerToken = await claimSeat(1);
    const otherToken = await claimSeat(2);
    let token = commissionerToken;
    const tokens = new Map([[1,commissionerToken],[2,otherToken]]);
    for(let id=3;id<=10;id++)tokens.set(id,await claimSeat(id));
    let initial = await getState();
    const skew = 0;
    const server = ownServer(createServer(async (request, response) => {
        if (request.url === '/bundle.js') {
            response.setHeader('Content-Type', 'text/javascript');
            response.end(await readFile(`${evidence}/bundle.js`));
        } else {
            response.setHeader('Content-Type', 'text/html; charset=utf-8');
            response.end('<!doctype html><html><body><div id="root"></div><script>window.initial='
                + JSON.stringify(initial) + ';window.config='
                + JSON.stringify({ token, url: currentBackend().url, skew })
                + '</script><script src="/bundle.js"></script></body></html>');
        }
    }));
    await listen(server, 0, '127.0.0.1');
    const address = server.address();
    assert(address && typeof address !== 'string');
    const open = async (mode = 'components') => {
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
            await browser('click','.tabbar button:nth-child(4)');
            await until(`document.querySelector('.room').dataset.tab==='results'`);
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
        await check('C28 the displayed opening is the clamped nomination amount', async () => {
            await browser('fill','input[aria-label="Opening bid"]','5000');
            const clamped=await evaluate<{amount:string;title:string}>(`({
                amount:document.querySelector('input[aria-label="Opening bid"]').value,
                title:document.querySelector('.nominate').title})`);
            assert(Number(clamped.amount)<=1000);
            assert.equal(clamped.title,`Nominate at $${clamped.amount}`);
            return clamped;
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
