import { makeEvidenceDirectory as mkdir, writeEvidenceFile as writeFile, bundleEvidence } from '../scripts/evidence';
import { withResources, runBrowser, ownServer, listen } from '../scripts/resources';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { connect, createServer as createTcpServer, type Socket } from 'node:net';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import recorded from './fixtures/sleeper-pool.json';
import type { Player } from '../lib/types';
import { createIsolated, dropIsolated, seedManagers, seedPlayers, claimSeat, configure,
    currentBackend, getState, sleep } from './support';
import { requireClosedPort } from '../scripts/local-backend';

const require = createRequire(resolve('package.json'));
const { build }: typeof import('esbuild') = require('esbuild');
const session = `pancake-clock-jump-${crypto.randomUUID()}`;
const results: { name: string; result: string; proof?: unknown; error?: string }[] = [];
async function browser(...args: string[]) {
    return runBrowser(session,args,20000);
}
async function evaluate<T>(expression: string): Promise<T> { return JSON.parse(await browser('eval', expression)); }
async function check(name: string, run: () => Promise<unknown>) {
    const items = process.argv.find(arg => arg.startsWith('--items='))?.slice(8).split(',');
    if (items && !items.some(item => name.startsWith(item))) return;
    try { const proof = await run(); results.push({ name, result: 'passed', proof }); console.log(`PASS ${name}`); }
    catch (error) { results.push({ name, result: 'failed', error: String(error) }); console.log(`FAIL ${name}: ${error}`); }
}
async function main() {
    const evidence = `${process.env.EVIDENCE_DIR}/clock-jump`;
    await mkdir(evidence, { recursive: true });
    await bundleEvidence(build, { entryPoints: ['tests/clock-network-harness.tsx'], outfile: `${evidence}/bundle.js`, bundle: true,
        format: 'iife', platform: 'browser', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } });
    const isolated = await createIsolated('test');
    let token = '';
    let skew = 0;
    let disableTimeout = false;
    let delayMs = 200;
    let blocked = false;
    const sockets = new Set<Socket>();
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const traffic: { method: string; at: number }[] = [];
    const proxy = ownServer(createTcpServer(downstream => {
        const upstream = connect(Number(new URL(currentBackend().url).port), '127.0.0.1');
        for (const socket of [upstream, downstream]) {
            sockets.add(socket);
            socket.on('error', () => { upstream.destroy(); downstream.destroy(); });
            socket.on('close', () => { sockets.delete(socket); });
        }
        downstream.on('end', () => upstream.end());
        upstream.on('end', () => downstream.end());
        function forward(data: Buffer, target: Socket) {
            if (blocked) return;
            const timer = setTimeout(() => {
                timers.delete(timer);
                if (!target.destroyed) target.write(data);
            }, delayMs);
            timers.add(timer);
        }
        downstream.on('data', data => {
            const method = /^(OPTIONS|POST) /u.exec(data.toString())?.[1];
            if (method) traffic.push({ method, at: Date.now() });
            forward(data, upstream);
        });
        upstream.on('data', data => forward(data, downstream));
    }));
    await listen(proxy, 0, '127.0.0.1');
    const proxyAddress = proxy.address();
    assert(proxyAddress && typeof proxyAddress !== 'string');
    const server = ownServer(createServer(async (request, response) => {
        if (request.url === '/bundle.js') {
            response.setHeader('Content-Type', 'text/javascript');
            response.end(await readFile(`${evidence}/bundle.js`));
        } else response.end('<!doctype html><html><body><div id="root"></div><script>window.config='
            + JSON.stringify({ url: currentBackend().url, token, skew, disableTimeout,
                proxyUrl: `http://127.0.0.1:${proxyAddress.port}` })
            + '</script><script src="/bundle.js"></script></body></html>');
    }));
    await listen(server, 0, '127.0.0.1');
    const address = server.address();
    assert(address && typeof address !== 'string');
    const frontendPort = address.port;
    async function open(deviceSkew: number, legacySafari = false) {
        delayMs = 200; blocked = false;
        skew = deviceSkew;
        disableTimeout = legacySafari;
        await configure({ deadlineAfterMs: 9000 });
        await browser('open', `http://127.0.0.1:${frontendPort}/`);
        await browser('wait', '.room');
    }
    async function ticks(duration = 1200) {
        const state = await getState();
        return evaluate<{ ticks: { shown: number; actual: number; error: number }[];
            responsesBefore: number; responsesAfter: number }>(`new Promise(resolve=>{
            const values=[],node=document.querySelector('.shot-clock .digits');
            const responsesBefore=window.clockNetwork.responses;
            const sample=()=>{const shown=Number(node.textContent);
                const actual=Math.max(0,(${state.draft.deadline}-window.clockNetwork.nativeNow())/1000);
                values.push({shown,actual,error:Math.abs(shown-actual)});};
            const observer=new MutationObserver(sample);observer.observe(node,{childList:true,subtree:true,characterData:true});
            setTimeout(sample,150);
            setTimeout(()=>{observer.disconnect();resolve({ticks:values,responsesBefore,
                responsesAfter:window.clockNetwork.responses});},${duration});
        })`);
    }
    function accurate(proof: Awaited<ReturnType<typeof ticks>>) {
        assert(proof.ticks.length >= 5, 'Observe every rendered countdown tick');
        for (const tick of proof.ticks) assert(tick.error <= 0.3, JSON.stringify(proof));
    }
    async function synchronized() {
        for (let attempt=0;attempt<100;attempt++) {
            if (await evaluate<boolean>(`['synced','provisional'].includes(document.querySelector('.room')
                ?.dataset.clockStatus)&&window.clockNetwork.responses>=3`)) return;
            await sleep(50);
        }
        throw new Error('The real HTTP samples must synchronize the room');
    }
    try {
        await seedManagers(); await seedPlayers(recorded.players as Player[]); token = await claimSeat(1);
        await configure({ draft: { status: 'running', phase: 'nomination',
            order: [1,2,3,4,5,6,7,8,9,10], nominatorId: 1, turnIndex: 0 } });
        await check('C24 stable and reversed wall clocks stay within 0.3 seconds on every tick', async () => {
            await open(0); await synchronized();
            const stable = await ticks(); accurate(stable);
            await evaluate('window.config.skew=0');
            const reversal = await ticks(); accurate(reversal);
            return { stable, reversal, toleranceSeconds:0.3 };
        });
        for (const jump of [-30000]) {
            await check(`C24 ${jump>0?'forward':'backward'} 30-second jump needs no new sample`, async () => {
                await open(0); await synchronized();
                const before = await ticks(700); accurate(before);
                blocked = true;
                await evaluate(`window.config.skew=${jump}`);
                const jumped = await ticks();
                blocked = false; delayMs = 0;
                await evaluate('window.config.skew=0;window.dispatchEvent(new Event("focus"));true');
                await synchronized();
                const reversed = await ticks(700);
                await writeFile(`${evidence}/jump-${jump}.json`, JSON.stringify({ before,jumped,reversed },null,2));
                accurate(jumped); accurate(reversed);
                assert.equal(jumped.responsesBefore,jumped.responsesAfter);
                assert.equal(before.responsesAfter,jumped.responsesAfter,'No resample hides a backward clock jump');
                await browser('screenshot',`${evidence}/jump-${jump}.png`);
                return { before,jumped,reversed,toleranceSeconds:0.3 };
            });
        }
        await check('C27 forward wall jumps hide uncertain digits until a fresh sample arrives', async () => {
            await open(0); await synchronized(); blocked = true;
            await evaluate('window.config.skew=30000;true');
            await sleep(1100);
            const uncertain = await evaluate<{ shown: string; status: string; message: string | null }>(`({shown:document.querySelector('.shot-clock .digits').textContent,
                status:document.querySelector('.room').dataset.clockStatus,
                message:document.querySelector('.clock-status')?.textContent??null})`);
            await writeFile(`${evidence}/forward-uncertain.json`, JSON.stringify(uncertain));
            assert.equal(uncertain.shown, '--');
            assert.equal(uncertain.status, 'retrying');
            assert.equal(uncertain.message, 'Clock not synced. Retrying…');
            blocked = false; delayMs = 0;
            await synchronized();
            const recovered = await ticks(600); accurate(recovered);
            blocked = true;
            await evaluate('window.config.skew=0;true');
            const reversed = await ticks(600); accurate(reversed);
            return { uncertain, recovered, reversed, policy: 'A forward wall jump can also be sleep; wait for HTTP time' };
        });
        await check('C27 clock HTTP failure without suspension keeps accurate confident digits', async () => {
            await open(0); await synchronized(); blocked = true;
            await evaluate("window.dispatchEvent(new Event('focus'));true");
            const proof = await ticks(900); accurate(proof);
            assert.equal(await evaluate("document.querySelector('.clock-status')?.textContent??null"), null);
            return proof;
        });
        await check('C27 failed wake hides uncertain digits with a live socket, then recovers', async () => {
            await open(0); await synchronized(); blocked = true;
            const responses = await evaluate<number>('window.clockNetwork.responses');
            await evaluate('window.clockNetwork.freeze();true');
            await sleep(1600);
            await evaluate("window.clockNetwork.wake();document.dispatchEvent(new Event('visibilitychange'));true");
            const wake = await evaluate<number>('window.clockNetwork.nativeNow()');
            const deadline = (await getState()).draft.deadline!;
            const readings = await evaluate<{ elapsed: number; shown: string; message: string | null;
                status: string; connected: boolean; actual: number; error: number | null }[]>(`new Promise(resolve=>{
                const rows=[];
                const record=()=>{
                    const shown=document.querySelector('.shot-clock .digits').textContent;
                    const actual=Math.max(0,(${deadline}-window.clockNetwork.nativeNow())/1000);
                    rows.push({elapsed:window.clockNetwork.nativeNow()-${wake},shown,actual,
                    error:shown==='--'?null:Math.abs(Number(shown)-actual),
                    status:document.querySelector('.room').dataset.clockStatus,
                    message:document.querySelector('.clock-status')?.textContent??null,
                    connected:!document.body.textContent.includes('Reconnecting…')});};
                record();const timer=setInterval(record,25);
                setTimeout(()=>{clearInterval(timer);record();resolve(rows)},4100);
            })`);
            const requests=await evaluate<number[]>('window.clockNetwork.requests');
            await writeFile(`${evidence}/wake-failure.json`, JSON.stringify({ responses, wake, deadline, readings, requests }, null, 2));
            await browser('screenshot', `${evidence}/wake-failure.png`);
            assert(readings.some(row => row.shown === '--' && row.elapsed <= 1100));
            assert(readings.filter(row => row.elapsed >= 1100).every(row => row.shown === '--'
                && row.message === 'Clock not synced. Retrying…' && row.status === 'retrying'));
            assert(readings.every(row => row.connected));
            const retries=requests.filter(at=>at>=wake-1600);
            assert(retries.length>=2,'An HTTP timeout must not defer recovery for fifteen seconds');
            assert(retries.slice(1).every((at,index)=>at-retries[index]<=4600));
            assert.equal(await evaluate('window.clockNetwork.responses'), responses);
            await configure({ deadlineAfterMs: 9000 });
            const recoveryStart = Date.now();
            blocked = false; delayMs = 0;
            await synchronized();
            const recoveryMs = Date.now() - recoveryStart;
            assert(recoveryMs <= 5000);
            const recovered = await ticks(600); accurate(recovered);
            return { responses, readings, requests, recovered, recoveryMs,
                simulation: 'Browser performance.now pauses 1600ms; HTTP times out; native WebSocket stays live' };
        });
        await check('C27 heartbeat alone detects suspended monotonic time', async () => {
            await open(0); await synchronized(); blocked = true;
            await evaluate('window.clockNetwork.freeze();true');
            await sleep(1600);
            await evaluate('window.clockNetwork.wake();true');
            await sleep(1100);
            const observed=await evaluate<{shown:string;status:string;connected:boolean}>(`({
                shown:document.querySelector('.shot-clock .digits').textContent,
                status:document.querySelector('.room').dataset.clockStatus,
                connected:!document.body.textContent.includes('Reconnecting…')})`);
            await writeFile(`${evidence}/heartbeat-wake.json`,JSON.stringify(observed));
            assert.equal(observed.shown,'--');assert.equal(observed.status,'retrying');assert(observed.connected);
            return observed;
        });
        await check('Disconnected sleep marks the clock uncertain before reconnect and a valid sample', async () => {
            await open(0); await synchronized(); blocked = true;
            await evaluate('window.clockNetwork.disconnect();true');
            for (let i = 0; i < 100; i++) {
                if (await evaluate<boolean>(`document.body.textContent.includes('Reconnecting…')`)) break;
                await sleep(25);
            }
            assert(await evaluate<boolean>(`document.body.textContent.includes('Reconnecting…')`));
            await evaluate('window.clockNetwork.freeze();true'); await sleep(1800);
            await evaluate('window.clockNetwork.wake();true'); await sleep(1100);
            const observed = await evaluate<{ shown: string; message: string; disconnected: boolean }>(`({
                shown:document.querySelector('.shot-clock .digits').textContent,
                message:document.querySelector('.clock-status')?.textContent??'',
                disconnected:document.body.textContent.includes('Reconnecting…')})`);
            await writeFile(`${evidence}/disconnected-sleep.json`, JSON.stringify(observed));
            assert.equal(observed.shown, '--'); assert(observed.disconnected);
            assert.equal(observed.message, 'Clock not synced. Retrying…');
            blocked = false; delayMs = 0;
            await configure({ deadlineAfterMs: 9000 });
            await evaluate('window.clockNetwork.reconnect();true');
            await synchronized(); const recovered = await ticks(600); accurate(recovered);
            return { observed, recovered };
        });
        await check('Backward wall correction cannot mask a later five-second sleep', async () => {
            await open(0); await synchronized(); blocked = true;
            await evaluate('window.config.skew=-30000;true');
            const backward = await ticks(1100); accurate(backward);
            await evaluate('window.clockNetwork.freeze();true'); await sleep(5000);
            await evaluate('window.clockNetwork.wake();true'); await sleep(1100);
            const observed = await evaluate<{ shown: string; message: string }>(`({
                shown:document.querySelector('.shot-clock .digits').textContent,
                message:document.querySelector('.clock-status')?.textContent??''})`);
            await writeFile(`${evidence}/backward-sleep.json`, JSON.stringify({ backward, observed }));
            assert.equal(observed.shown, '--'); assert.equal(observed.message, 'Clock not synced. Retrying…');
            blocked = false; delayMs = 0;
            await configure({ deadlineAfterMs: 9000 }); await synchronized();
            const recovered = await ticks(500); accurate(recovered);
            return { backward, observed, recovered };
        });
        await check('Lifecycle returns keep the countdown visible and cannot starve fresh samples', async () => {
            await open(0); await synchronized();
            delayMs = 100;
            const state = await getState();
            const proof = await evaluate<{
                ticks: { shown: string; status: string; syncing: boolean; error: number }[];
                acceptedBefore: number; acceptedDuring: number; acceptedAfter: number;
                events: Record<string, number>;
            }>(`new Promise(resolve => {
                const ticks=[],events={},acceptedBefore=window.clockNetwork.accepted.length;
                let visibility='visible',index=0;
                Object.defineProperty(document,'visibilityState',{configurable:true,get:()=>visibility});
                const record=()=>{
                    const shown=document.querySelector('.shot-clock .digits').textContent;
                    const actual=Math.max(0,(${state.draft.deadline}-window.clockNetwork.nativeNow())/1000);
                    ticks.push({shown,status:document.querySelector('.room').dataset.clockStatus,
                        syncing:document.body.textContent.includes('Syncing clock'),
                        error:Math.abs(Number(shown)-actual)});
                };
                const fire=(target,name)=>{events[name]=(events[name]??0)+1;target.dispatchEvent(new Event(name));};
                const returns=[()=>fire(window,'focus'),()=>{fire(window,'blur');fire(window,'focus');},
                    ()=>{visibility='hidden';fire(document,'visibilitychange');visibility='visible';
                        fire(document,'visibilitychange');},()=>fire(window,'pageshow'),()=>fire(document,'resume')];
                const observer=new MutationObserver(record);
                observer.observe(document.querySelector('.room'),{subtree:true,childList:true,characterData:true});
                const polling=setInterval(record,25);
                const storm=setInterval(()=>returns[index++%returns.length](),50);
                returns[0]();
                setTimeout(()=>{
                    clearInterval(storm);
                    const acceptedDuring=window.clockNetwork.accepted.length;
                    setTimeout(()=>{clearInterval(polling);observer.disconnect();record();
                        delete document.visibilityState;
                        resolve({ticks,events,acceptedBefore,acceptedDuring,
                            acceptedAfter:window.clockNetwork.accepted.length});},350);
                },1500);
            })`);
            await writeFile(`${evidence}/lifecycle.json`, JSON.stringify(proof, null, 2));
            await browser('screenshot', `${evidence}/lifecycle.png`);
            assert(proof.ticks.length >= 50);
            assert(proof.ticks.every(tick => tick.shown !== '--'), 'Tab returns must keep the accepted anchor visible');
            assert(proof.ticks.every(tick => !tick.syncing), 'Tab returns must not flash the syncing header');
            assert(proof.ticks.every(tick => tick.error <= 0.3), JSON.stringify(proof));
            assert(proof.acceptedDuring > proof.acceptedBefore, 'A fresh sample must land during repeated events');
            assert(['focus','blur','visibilitychange','pageshow','resume'].every(name => proof.events[name] >= 3));
            return proof;
        });
        await check('C24 a lower-RTT ordinary sample replaces the accepted anchor', async () => {
            await open(0); await synchronized();
            const before = await evaluate<number>('window.clockNetwork.accepted.length');
            delayMs=0;
            await evaluate("window.dispatchEvent(new Event('focus'));true");
            for(let i=0;i<100;i++) {
                if(await evaluate<boolean>(`window.clockNetwork.accepted.length>${before}`))break;
                await sleep(50);
            }
            assert(await evaluate<boolean>(`window.clockNetwork.accepted.length>${before}`));
            const proof=await ticks(); accurate(proof);
            return {proof,accepted:await evaluate('window.clockNetwork.accepted')};
        });
        await check('C24 visibility wake refreshes a monotonic clock paused during sleep', async () => {
            await open(0); await synchronized(); delayMs=0;
            const count=await evaluate<number>('window.clockNetwork.accepted.length');
            await evaluate('window.clockNetwork.freeze();true'); await sleep(1200);
            await evaluate("window.clockNetwork.wake();document.dispatchEvent(new Event('visibilitychange'));true");
            for(let i=0;i<100;i++) {
                if(await evaluate<boolean>(`window.clockNetwork.accepted.length>${count}
                    &&['synced','provisional'].includes(document.querySelector('.room').dataset.clockStatus)`))break;
                await sleep(50);
            }
            assert(await evaluate<boolean>(`window.clockNetwork.accepted.length>${count}`));
            const proof=await ticks(); accurate(proof);
            return {proof,accepted:await evaluate('window.clockNetwork.accepted')};
        });
        assert.equal(await browser('errors'), '');
    } finally {
        try { await browser('close'); } finally {
            for (const timer of timers) clearTimeout(timer);
            for (const socket of sockets) socket.destroy();
            await Promise.all([new Promise<void>(resolve => proxy.close(() => resolve())),
                new Promise<void>(resolve => server.close(() => resolve()))]);
            await Promise.all([requireClosedPort(proxyAddress.port), requireClosedPort(address.port)]);
            await dropIsolated(isolated);
            await writeFile(`${evidence}/results.json`, JSON.stringify(results, null, 2));
            await writeFile(`${evidence}/cleanup.json`, JSON.stringify({ browserClosed: true,
                proxyPort: proxyAddress.port, frontendPort: address.port, listenersClosed: true }));
        }
    }
    assert(results.every(result => result.result === 'passed'), 'Network clock regressions must pass');
}
withResources(main).catch(error => { console.error(error); process.exitCode = 1; });
