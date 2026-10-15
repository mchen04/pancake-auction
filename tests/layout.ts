import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { resolve, basename } from 'node:path';
import { promisify } from 'node:util';
import { closeDatabase } from '../lib/db';
import { matching } from '../lib/rules';
import type { Player } from '../lib/types';
import { loadEnvironment, safeError } from '../scripts/env';
import { roomFixture } from './room-fixture';
import { sql } from './support';

const execute = promisify(execFile);
const require = createRequire(resolve('package.json'));
const { build }: typeof import('esbuild') = require('esbuild');
const session = `pancake-layout-${randomBytes(6).toString('hex')}`;
const results: { name: string; result: string; error?: string; measurements?: unknown }[] = [];
async function browser(...args: string[]) {
    return (await execute('agent-browser', ['--session', session, ...args], { timeout: 20000 })).stdout.trim();
}
async function evaluate(expression: string) {
    return JSON.parse(await browser('eval', expression));
}
async function check(name: string, test: () => Promise<unknown>) {
    try {
        const measurements = await test();
        results.push({ name, result: 'passed', measurements });
        console.log(`PASS ${name}`);
    } catch (error) {
        results.push({ name, result: 'failed', error: safeError(error) });
        console.error(`FAIL ${name}: ${safeError(error)}`);
    }
}
async function fixture() {
    const players: Player[] = (await sql('SELECT data FROM auction.players ORDER BY id')).rows.map(row => row.data);
    const target = players.find(player => player.name === 'Giannis Antetokounmpo');
    assert(target && target.projectedStats && Object.keys(target.projectedStats).length >= 11);
    const owned: Player[] = [];
    for (let index = 0; index < 19; index++) {
        const position = (['PG', 'SG', 'SF', 'PF', 'C'] as const)[index % 5];
        const player = players.find(player => player.id !== target.id && !owned.includes(player)
            && player.positions.includes(position));
        assert(player);
        owned.push(player);
    }
    assert(matching(owned));
    const state = roomFixture();
    state.players = players;
    state.roster = owned.map((player, index) => ({
        playerId: player.id, managerId: 1, placement: 'active', lotId: index + 1, price: 35
    }));
    state.managers[0].budget = 335;
    state.sales = state.roster.map(entry => ({
        id: entry.lotId, playerId: entry.playerId, nominatorId: 2, highBidderId: 1,
        highBid: entry.price, status: 'sold'
    })).reverse();
    state.lot = { ...state.lot!, playerId: target.id, player: target };
    return state;
}
const geometry = `(() => {
    const rect = e => {const r=e.getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,
        width:r.width,height:r.height};};
    const visible = e => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden';
    const controls = [...document.querySelectorAll('button,input,.result-row b')].filter(visible).flatMap(e => {
        const r=rect(e);if(!r.width||!r.height)return [];
        const panel=e.closest('.panel,.topbar,.tabbar');if(!panel)return [];
        const p=rect(panel);const scroll=e.closest('.scroll,.block-information');const s=scroll?rect(scroll):p;
        if(r.bottom<=s.y||r.y>=s.bottom||r.bottom<=0||r.y>=innerHeight)return [];
        return [{text:e.getAttribute('aria-label')||e.textContent,rect:r,panel:p,scroll:!!scroll}];
    });
    const tab=document.querySelector('.room').dataset.tab;
    const panel=document.querySelector('.'+({players:'pool',teams:'teams',roster:'roster',results:'results'}[tab]));
    return {viewport:[innerWidth,innerHeight],document:[document.documentElement.scrollWidth,
        document.documentElement.scrollHeight],bodyWidth:document.body.scrollWidth,
        roomWidth:document.querySelector('.room').scrollWidth,controls,tab,
        tabHeight:panel.querySelector('.scroll').clientHeight,
        bidControls:[...document.querySelectorAll('.bid-buttons button,.bid-buttons input,.bid-footer>button')]
            .map(e=>({text:e.textContent||e.getAttribute('aria-label'),rect:rect(e),disabled:e.disabled,
                hit:e.contains(document.elementFromPoint((rect(e).x+rect(e).right)/2,(rect(e).y+rect(e).bottom)/2))})),
        block:rect(document.querySelector('.block')),font:getComputedStyle(document.body).fontFamily};
})()`;
function assertFrame(proof: Awaited<ReturnType<typeof evaluate>>) {
    const [width, height] = proof.viewport;
    assert(proof.document[0] <= width && proof.document[1] <= height
        && proof.bodyWidth <= width && proof.roomWidth <= width, 'Document overflow');
    for (const control of proof.controls) {
        const { rect: r, panel: p } = control;
        assert(r.x >= -1 && r.right <= width + 1, `Clipped control: ${control.text}`);
        assert(r.x >= p.x - 1 && r.right <= p.right + 1, `Outside panel: ${control.text}`);
        if (!control.scroll) {
            assert(r.y >= p.y - 1 && r.bottom <= p.bottom + 1 && r.bottom <= height + 1,
                `Vertically clipped control: ${control.text}`);
        }
    }
}
function assertBids(proof: Awaited<ReturnType<typeof evaluate>>) {
    assert.equal(proof.bidControls.length, 5);
    for (const { rect: r, text, hit } of proof.bidControls) {
        assert(hit && r.height >= 28 && r.y >= proof.block.y && r.bottom <= proof.block.bottom + 1
            && r.bottom <= proof.viewport[1], `Bid control hidden: ${text}`);
    }
    assert(proof.bidControls.filter((control: { disabled: boolean }) => !control.disabled).length >= 4);
}
async function main() {
    loadEnvironment();
    const root = process.env.EVIDENCE_DIR;
    assert(root);
    const dir = `${root}/layout`;
    await mkdir(dir, { recursive: true });
    const state = await fixture();
    await closeDatabase();
    await writeFile(`${dir}/fixture.json`, JSON.stringify(state));
    await build({ entryPoints: ['tests/layout-harness.tsx'], outfile: `${dir}/bundle.js`, bundle: true,
        platform: 'browser', format: 'esm', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } });
    const files = await readdir('.next/static/chunks');
    const styles = await Promise.all(files.filter(file => file.endsWith('.css'))
        .map(file => readFile(`.next/static/chunks/${file}`, 'utf8')));
    const fonts = styles.join('').match(/@font-face\{[^}]+\}/g)?.join('') ?? '';
    assert(fonts.includes('IBM Plex Sans') && fonts.includes('Barlow Condensed'));
    const css = fonts + ':root{--font-body:"IBM Plex Sans";--font-display:"Barlow Condensed"}'
        + await readFile('app/globals.css', 'utf8');
    const server = createServer(async (request, response) => {
        const path = new URL(request.url!, 'http://localhost').pathname;
        if (path === '/style.css') {
            response.setHeader('Content-Type', 'text/css');
            response.end(css);
        } else if (path.endsWith('.woff2')) {
            response.setHeader('Content-Type', 'font/woff2');
            response.end(await readFile(`.next/static/media/${basename(path)}`));
        } else if (path === '/bundle.js' || path === '/fixture.json') {
            response.setHeader('Content-Type', path.endsWith('.js') ? 'text/javascript' : 'application/json');
            if (path === '/fixture.json' && request.url?.includes('player=short')) {
                const player = state.players.find(player => player.name === 'Jayson Tatum');
                assert(player);
                response.end(JSON.stringify({ ...state, lot: { ...state.lot, playerId: player.id, player } }));
            } else response.end(await readFile(`${dir}${path}`));
        } else response.end('<!doctype html><html><head><meta name="viewport" content="width=device-width">'
            + '<meta charset="utf-8"><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div>'
            + '<script type="module" src="/bundle.js"></script></body></html>');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert(address && typeof address === 'object');
    try {
        await browser('open', `http://127.0.0.1:${address.port}`);
        await browser('wait', '.room');
        await browser('eval', 'document.fonts.ready.then(()=>true)');
        await writeFile(`${dir}/snapshot.txt`, await browser('snapshot'));
        for (const [width, height] of [[1180,768],[1181,768],[1200,768],[1219,768],[1220,768],
            [1280,720],[1440,900],[1024,768],[390,844]]) {
            await check(`C16 viewport ${width}x${height} keeps controls and sale prices inside panels`, async () => {
                await browser('set', 'viewport', String(width), String(height));
                const proofs = [];
                for (const tab of width < 1220 ? ['Players', 'My roster', 'Results'] : ['Players']) {
                    if (width < 1220) await browser('find', 'role', 'tab', 'click', '--name', tab, '--exact');
                    const proof = await evaluate(geometry);
                    proofs.push(proof);
                    await writeFile(`${dir}/width-${width}-${tab}.json`, JSON.stringify(proof, null, 2));
                    assertFrame(proof);
                    if (tab === 'Results' || width >= 1220) {
                        assert(proof.controls.some((control: { text: string }) => control.text === '$35'));
                    }
                }
                if ([1181, 1280, 1440].includes(width)) {
                    await browser('screenshot', `${dir}/desktop-${width}.png`);
                }
                return proofs;
            });
        }
        for (const height of [667, 844]) {
            await browser('set', 'viewport', '390', String(height));
            for (const expanded of [false, true]) {
                await browser('open', `http://127.0.0.1:${address.port}`);
                await browser('wait', '.room');
                if (expanded) await browser('find', 'role', 'button', 'click', '--name', 'Details', '--exact');
                for (const tab of ['Players', 'Teams', 'My roster', 'Results']) {
                    await check(`C17 ${height} ${tab} details ${expanded ? 'expanded' : 'collapsed'}`, async () => {
                        await browser('find', 'role', 'tab', 'click', '--name', tab, '--exact');
                        const proof = await evaluate(geometry);
                        const path = `${dir}/phone-${height}-${tab}-${expanded}.json`;
                        await writeFile(path, JSON.stringify(proof, null, 2));
                        assertFrame(proof);
                        assert(proof.tabHeight >= 100, `Selected tab scroll height ${proof.tabHeight} below 100px`);
                        assertBids(proof);
                        if (expanded) {
                            const scroll = await evaluate('Boolean(document.querySelector(".block-information"))');
                            const selector = scroll ? '.block-information' : '.block';
                            await browser('scroll', 'down', '1000', '--selector', selector);
                            const detail = await evaluate(`(() => {
                                const box=document.querySelector('.block-information')||document.querySelector('.block');
                                const last=document.querySelector('.block .details').lastElementChild;
                                return {bottom:last.getBoundingClientRect().bottom,top:last.getBoundingClientRect().top,
                                    box:box?.getBoundingClientRect().toJSON(),scrollTop:box?.scrollTop};})()`);
                            const reachable = detail.box && detail.bottom <= detail.box.bottom + 1
                                && detail.top >= detail.box.top - 1;
                            assert(reachable, 'Last detail row is unreachable');
                            assertBids(await evaluate(geometry));
                            await browser('focus', '[aria-label="Bid amount"]');
                            await browser('fill', '[aria-label="Bid amount"]', '50');
                            assertBids(await evaluate(geometry));
                            return { ...proof, detail };
                        }
                        return proof;
                    });
                }
                await browser('screenshot', `${dir}/phone-${height}-${expanded}.png`);
            }
        }
        await check('C17 Hide details keyboard recovery restores My roster', async () => {
            const scroll = await evaluate('Boolean(document.querySelector(".block-information"))');
            await browser('scroll', 'up', '1000', '--selector', scroll ? '.block-information' : '.block');
            await browser('focus', '.lot-heading button');
            await browser('press', 'Enter');
            await browser('find', 'role', 'tab', 'click', '--name', 'My roster', '--exact');
            const proof = await evaluate(geometry);
            assert(proof.tabHeight > 0);
            assert.equal(await evaluate('Boolean(document.querySelector(".block .details"))'), false);
            assertBids(proof);
            return proof;
        });
        await check('C17 shorter real-player control keeps My roster usable with details open', async () => {
            await browser('open', `http://127.0.0.1:${address.port}/?player=short`);
            await browser('wait', '.room');
            await browser('find', 'role', 'button', 'click', '--name', 'Details', '--exact');
            await browser('find', 'role', 'tab', 'click', '--name', 'My roster', '--exact');
            const proof = await evaluate(geometry);
            assert(proof.tabHeight > 0);
            assertBids(proof);
            return proof;
        });
        await writeFile(`${dir}/errors.log`, await browser('errors'));
        assert.equal((await browser('errors')).trim(), '');
    } finally {
        try { await browser('close'); } finally {
            await new Promise<void>(resolve => server.close(() => resolve()));
            await writeFile(`${dir}/results.json`, JSON.stringify(results, null, 2));
        }
    }
    assert(results.every(result => result.result === 'passed'), 'Layout regressions must pass');
}
main().catch(error => { console.error(safeError(error)); process.exitCode = 1; }).finally(closeDatabase);
