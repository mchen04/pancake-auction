import { makeEvidenceDirectory as mkdir, writeEvidenceFile as writeFile, bundleEvidence } from '../scripts/evidence';
import { withResources, runBrowser, ownServer, listen } from '../scripts/resources';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, resolve } from 'node:path';
import { promisify } from 'node:util';
import { matching, slots, taxiEligibility } from '../lib/rules';
import type { AuctionState, Entry, Player } from '../lib/types';
import { requireClosedPort } from '../scripts/local-backend';
import { act, claimSeat, configure, createIsolated, currentBackend, dropIsolated, getState,
    seedManagers, seedPlayers, sleep } from './support';
import recorded from './fixtures/sleeper-pool.json';

const execute = promisify(execFile);
const require = createRequire(resolve('package.json'));
const { build }: typeof import('esbuild') = require('esbuild');
const session = `pancake-roster-slots-${crypto.randomUUID()}`;
const players = recorded.players as Player[];
const target = players.find(player => player.name === 'Giannis Antetokounmpo')!;
const freshPlayer = players.find(player => player.injuryStatus === 'Out' && taxiEligibility(player) === 'eligible')!;
const mover = players.find(player => player.id !== freshPlayer.id && player.injuryStatus === 'Out'
    && taxiEligibility(player) === 'eligible')!;
const capacities = { Starters: 10, Bench: 10, Taxi: 3, IR: 2 };
const results: { name: string; result: string; proof?: unknown; error?: string }[] = [];
async function browser(...args: string[]) {
    return runBrowser(session,args,20000);
}
async function evaluate<T>(expression: string): Promise<T> { return JSON.parse(await browser('eval', expression)); }
async function until(expression: string) {
    for (let attempt = 0; attempt < 60; attempt++) {
        if (await evaluate<boolean>(expression)) return;
        await sleep(50);
    }
    throw new Error(`Browser condition failed: ${expression}`);
}
async function check(name: string, run: () => Promise<unknown>) {
    const only = process.argv.find(arg => arg.startsWith('--only='))?.slice(7);
    if (only && !name.includes(only)) return;
    try { const proof = await run(); results.push({ name, result: 'passed', proof }); console.log(`PASS ${name}`); }
    catch (error) { results.push({ name, result: 'failed', error: String(error) }); console.log(`FAIL ${name}: ${error}`); }
}
function roster(mode: 'empty' | 'partial' | 'full') {
    if (mode === 'empty') return [];
    const used = new Set([target.id, freshPlayer.id, mover.id]);
    const entries: Entry[] = [];
    function add(player: Player, managerId: number, placement: Entry['placement']) {
        used.add(player.id);
        entries.push({ playerId: player.id, managerId, placement, lotId: entries.length + 1, price: 1 });
    }
    function pick(predicate: (player: Player) => boolean) {
        const player = players.find(player => !used.has(player.id) && predicate(player));
        assert(player); return player;
    }
    for (const managerId of [1, 2]) {
        const active = mode === 'full' ? 20 : 12;
        if (managerId === 1) add(mover, managerId, 'active');
        for (let index = managerId === 1 ? 1 : 0; index < active; index++) {
            const position = (['PG', 'SG', 'SF', 'PF', 'C'] as const)[index % 5];
            add(pick(player => player.positions.includes(position)), managerId, 'active');
        }
        assert(matching(entries.filter(entry => entry.managerId === managerId).map(entry =>
            players.find(player => player.id === entry.playerId)!)));
        for (let index = 0; index < (mode === 'full' ? 3 : 1); index++) {
            add(pick(player => taxiEligibility(player) === 'eligible'), managerId, 'taxi');
        }
        for (let index = 0; index < (mode === 'full' ? 2 : 1); index++) {
            add(pick(player => player.injuryStatus === 'Out'), managerId, 'ir');
        }
    }
    return entries;
}
async function seed(mode: 'empty' | 'partial' | 'full') {
    const entries = roster(mode);
    const id = entries.length + 1;
    await configure({ roster: entries, managers: [1,2].map(managerId => ({ id: managerId, done: false,
        budget: 1000 - entries.filter(entry => entry.managerId === managerId).length })),
        lot: { id, playerId: target.id, nominatorId: 3, highBidderId: 3, highBid: 10, status: 'open' },
        draft: { status: 'paused', phase: 'bidding', order: [1,2,3,4,5,6,7,8,9,10], nominatorId: 3,
            turnIndex: 2, lotId: id, deadline: null, remainingMs: 10000, passedTurns: [] } });
    return getState();
}
function expected(state: AuctionState, managerId: number) {
    const entries = state.roster.filter(entry => entry.managerId === managerId);
    const active = entries.filter(entry => entry.placement === 'active');
    const assignment = matching(active.map(entry => players.find(player => player.id === entry.playerId)!));
    assert(assignment);
    return {
        Starters: assignment.slice(0,10).map(index => active[index]?.playerId ?? null),
        Bench: [...assignment.slice(10).filter(index => index >= 0).map(index => active[index].playerId),
            ...Array(10).fill(null)].slice(0,10),
        Taxi: [...entries.filter(entry => entry.placement === 'taxi').map(entry => entry.playerId),
            null, null, null].slice(0,3),
        IR: [...entries.filter(entry => entry.placement === 'ir').map(entry => entry.playerId), null, null].slice(0,2)
    };
}
const measure = (selector: string) => `(() => {
    const panel=document.querySelector(${JSON.stringify(selector)});
    if(!panel)return {missing:true};
    const scroll=panel.closest('.panel').querySelector('.scroll');
    const visible=el=>{const r=el.getBoundingClientRect();const s=scroll.getBoundingClientRect();
        return r.height>0&&r.top>=s.top-1&&r.bottom<=s.bottom+1&&r.left>=-1&&r.right<=innerWidth+1;};
    const groups={};
    for(const heading of panel.querySelectorAll('h3')) {
        const name=heading.firstChild.textContent.trim();const rows=[];
        for(let row=heading.nextElementSibling;row&&row.tagName!=='H3';row=row.nextElementSibling) {
            if(!row.classList.contains('roster-row'))continue;
            const r=row.getBoundingClientRect();const s=scroll.getBoundingClientRect();
            scroll.scrollTop+=r.top-s.top-(scroll.clientHeight-r.height)/2;
            rows.push({label:row.getAttribute('aria-label'),role:row.getAttribute('role'),
                open:row.classList.contains('open'),name:row.querySelector('strong')?.textContent,
                code:row.querySelector('.slot')?.textContent,reachable:visible(row),
                interactive:!!row.querySelector('button,a,input,select,textarea,[tabindex]'),
                tabIndex:row.tabIndex,cursor:getComputedStyle(row).cursor,rect:row.getBoundingClientRect().toJSON()});
        }
        groups[name]=rows;
    }
    return {groups,document:[document.documentElement.scrollWidth,document.documentElement.scrollHeight],
        viewport:[innerWidth,innerHeight],scrollY,scrollX,panelHeight:scroll.clientHeight,
        scrollHeight:scroll.scrollHeight,overflowY:getComputedStyle(scroll).overflowY,
        placementButtons:panel.querySelectorAll('.placement button').length};
})()`;
type Row = { label: string; role: string; open: boolean; name?: string; code: string;
    reachable: boolean; interactive: boolean; tabIndex: number; cursor: string };
type Measurements = { groups: Record<string, Row[]>; document: number[]; viewport: number[];
    scrollX: number; scrollY: number; panelHeight: number; scrollHeight: number; overflowY: string; placementButtons: number };
function frame(proof: Measurements) {
    assert(proof.document[0] <= proof.viewport[0] && proof.document[1] <= proof.viewport[1], 'Document overflow');
    assert.equal(proof.scrollX, 0); assert.equal(proof.scrollY, 0);
    assert(proof.panelHeight >= 100, 'The selected panel must keep usable scroll space');
    if (proof.scrollHeight > proof.panelHeight + 1) {
        assert(['auto','scroll'].includes(proof.overflowY), 'The panel must permit user scrolling');
    }
}
function assertSlots(proof: Measurements, state: AuctionState, managerId: number, readOnly: boolean) {
    const assigned = expected(state, managerId);
    frame(proof);
    for (const [group, capacity] of Object.entries(capacities)) {
        assert.equal((proof.groups[group] ?? []).length, capacity, `${group} must render ${capacity} individual slots`);
    }
    for (const [group, capacity] of Object.entries(capacities)) {
        const rows = proof.groups[group];
        const ids = assigned[group as keyof typeof assigned];
        assert.equal(rows.filter(row => row.open).length, ids.filter(id => id === null).length);
        rows.forEach((row, index) => {
            const name = players.find(player => player.id === ids[index])?.name;
            assert.equal(row.name, name);
            assert.equal(row.role, 'group');
            const position = group === 'Starters' ? slots[index] : group;
            assert.equal(row.label, `${position} spot ${index + 1} of ${capacity}, ${name ?? 'open'}`);
            assert.equal(row.code, group === 'Starters' ? slots[index] : { Bench: 'BN', Taxi: 'TX', IR: 'IR' }[group]);
            assert(row.reachable, `${row.label} must be reachable by panel scrolling`);
            if (row.open) {
                assert(!row.interactive); assert.equal(row.tabIndex, -1); assert.notEqual(row.cursor, 'pointer');
            }
        });
    }
    if (readOnly) assert.equal(proof.placementButtons, 0);
}
async function main() {
    const evidence = `${process.env.EVIDENCE_DIR}/roster-slots`;
    await mkdir(evidence, { recursive: true });
    const isolated = await createIsolated('test');
    await seedManagers(); await seedPlayers(players);
    const tokens = await Promise.all(Array.from({ length: 10 }, (_, index) => claimSeat(index + 1)));
    const token = tokens[0];
    let memberToken = tokens[1];
    let viewerToken = token;
    await bundleEvidence(build, { entryPoints: ['tests/layout-harness.tsx'], outfile: `${evidence}/bundle.js`, bundle: true,
        platform: 'browser', format: 'esm', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } });
    let fontCss = '';
    try {
        const files = await readdir('.next/static/chunks');
        const styles = await Promise.all(files.filter(file => file.endsWith('.css'))
            .map(file => readFile(`.next/static/chunks/${file}`, 'utf8')));
        fontCss = styles.join('').match(/@font-face\{[^}]+\}/g)?.join('') ?? '';
    } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
    const css = fontCss + ':root{--font-body:"IBM Plex Sans",Arial;--font-display:"Barlow Condensed",Arial}'
        + await readFile('app/globals.css', 'utf8');
    const server = ownServer(createServer(async (request, response) => {
        const path = new URL(request.url!, 'http://localhost').pathname;
        if (path === '/client-config.json') {
            response.setHeader('Content-Type', 'application/json');
            response.end(JSON.stringify({ url: currentBackend().url, token: viewerToken }));
        } else if (path === '/style.css') { response.setHeader('Content-Type', 'text/css'); response.end(css); }
        else if (path.endsWith('.woff2')) {
            response.setHeader('Content-Type', 'font/woff2');
            response.end(await readFile(`.next/static/media/${basename(path)}`));
        } else if (path === '/bundle.js') {
            response.setHeader('Content-Type', 'text/javascript'); response.end(await readFile(`${evidence}/bundle.js`));
        } else response.end('<!doctype html><html><head><meta name="viewport" content="width=device-width">'
            + '<meta charset="utf-8"><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div>'
            + '<script type="module" src="/bundle.js"></script></body></html>');
    }));
    await listen(server, 0, '127.0.0.1');
    const address = server.address(); assert(address && typeof address !== 'string');
    const port = address.port;
    async function open() {
        await browser('open', `http://127.0.0.1:${port}`); await browser('wait', '.room');
        await evaluate('document.fonts.ready.then(()=>true)');
    }
    async function tab(name: string) {
        if (await evaluate<number>('innerWidth') < 1220) {
            await browser('find', 'role', 'tab', 'click', '--name', name, '--exact');
        }
    }
    async function inspectTeam(id: number, key = 'Enter') {
        const selector = `.team-name button[aria-controls="team-roster-${id}"]`;
        assert(await evaluate<boolean>(`!!document.querySelector(${JSON.stringify(selector)})`),
            'Every team name must be a real inspection button');
        await browser('focus', selector); await browser('press', key);
    }
    async function teamGeometry(id: number) {
        return evaluate<{
            expanded: boolean; cueVisible: boolean; cueAngle: number; background: string;
            columns: number[][]; header: number[][];
        }>(`(() => {
            const button=document.querySelector('[aria-controls="team-roster-${id}"]');
            const row=button.closest('.team-row'),cell=button.closest('.team-name');
            const scroll=row.closest('.scroll'),r=row.getBoundingClientRect(),s=scroll.getBoundingClientRect();
            scroll.scrollTop+=r.top-s.top-(scroll.clientHeight-r.height)/2;
            const cue=button.querySelector('.team-inspect-cue');
            const c=cue?.getBoundingClientRect(),b=button.getBoundingClientRect(),v=scroll.getBoundingClientRect();
            const style=cue&&getComputedStyle(cue),matrix=new DOMMatrix(style?.transform??'none');
            const columns=element=>[...element.children].map(child=>{
                const box=child.getBoundingClientRect();return [box.left,box.right];});
            return {expanded:button.getAttribute('aria-expanded')==='true',
                cueVisible:!!c&&c.width>0&&c.height>0&&style.visibility==='visible'&&Number(style.opacity)>0
                    &&c.left>=b.left&&c.right<=b.right&&c.top>=v.top&&c.bottom<=v.bottom
                    &&c.left>=0&&c.right<=innerWidth,
                cueAngle:Math.round(Math.atan2(matrix.b,matrix.a)*180/Math.PI),
                background:getComputedStyle(row).backgroundColor,columns:columns(row),
                header:columns(document.querySelector('.teams .table-head'))};
        })()`);
    }
    function aligned(proof: Awaited<ReturnType<typeof teamGeometry>>) {
        assert.equal(proof.columns.length, proof.header.length);
        proof.columns.forEach((column, index) => column.forEach((edge, side) => {
            assert(Math.abs(edge - proof.header[index][side]) < 1, 'Team columns must align with their headers');
        }));
    }
    async function teamNames() {
        return evaluate<{
            names: { name: string; clientWidth: number; scrollWidth: number; gap: number;
                cueVisible: boolean; buttonFits: boolean; aligned: boolean;
                lines: { text: string; fits: boolean; width: number; scrollWidth: number }[] }[];
            columns: { text: string; fits: boolean; excluded: string | null }[];
            admin: boolean; turn: boolean; gutter: number; document: number[]; viewport: number[];
            scrollWidth: number; clientWidth: number; tracks: string;
        }>(`(() => {
            const scroll=document.querySelector('.teams .scroll');
            const header=document.querySelector('.teams .table-head');
            const excluded=(child,index)=>{
                const style=getComputedStyle(child),r=child.getBoundingClientRect();
                if(index===6&&child.parentElement.classList.contains('with-turn')
                    &&(style.display==='none'||style.visibility==='hidden'&&r.width===0))return 'inline-turn-column';
                if(child.matches('.team-release,.team-release-heading')&&style.display==='none')
                    return 'collapsed-seat-control';
                if(child.matches('.team-release')&&style.gridColumnEnd==='-1')return 'expanded-seat-control';
                return null;
            };
            const columns=[header,...document.querySelectorAll('.team-row')].flatMap(row=>
                [...row.children].slice(1).map((child,index)=>({text:child.textContent,
                    fits:child.scrollWidth<=child.clientWidth,excluded:excluded(child,index+1)})));
            const names=[...document.querySelectorAll('.team-row')].map(row=>{
                const cellElement=row.querySelector('.team-name');
                const button=cellElement.querySelector('.team-inspect')??cellElement.querySelector('b');
                const r=row.getBoundingClientRect(),s=scroll.getBoundingClientRect();
                scroll.scrollTop+=r.top-s.top-(scroll.clientHeight-r.height)/2;
                const name=button.querySelector('.team-inspect-name')??button;
                const cue=button.querySelector('.team-inspect-cue');
                const n=name.getBoundingClientRect(),c=cue?.getBoundingClientRect(),b=button.getBoundingClientRect();
                const cell=cellElement.getBoundingClientRect(),v=scroll.getBoundingClientRect();
                const lines=[...cellElement.querySelectorAll('.status,.turn-inline')]
                    .filter(line=>getComputedStyle(line).display!=='none').map(line=>{
                        const l=line.getBoundingClientRect();return {text:line.textContent,width:line.clientWidth,
                            scrollWidth:line.scrollWidth,fits:line.scrollWidth<=line.clientWidth
                                &&l.left>=cell.left&&l.right<=cell.right+0.1&&l.bottom<=cell.bottom+0.1};});
                return {name:name.textContent,clientWidth:name.clientWidth,scrollWidth:name.scrollWidth,
                    gap:c?c.left-n.right:null,cueVisible:!!c&&c.width>0&&c.height>0&&c.top>=v.top&&c.bottom<=v.bottom
                        &&c.left>=b.left&&c.right<=b.right,
                    buttonFits:b.left>=cell.left&&b.right<=cell.right,lines,
                    aligned:[...row.children].every((child,index)=>{
                        if(excluded(child,index))return true;
                        const a=child.getBoundingClientRect(),h=header.children[index].getBoundingClientRect();
                        return Math.abs(a.left-h.left)<1&&Math.abs(a.right-h.right)<1;})};
            });
            return {names,columns,admin:header.classList.contains('with-admin'),turn:header.classList.contains('with-turn'),
                gutter:scroll.offsetWidth-scroll.clientWidth,scrollWidth:scroll.scrollWidth,clientWidth:scroll.clientWidth,
                tracks:getComputedStyle(header).gridTemplateColumns,
                document:[document.documentElement.scrollWidth,document.documentElement.scrollHeight],
                viewport:[innerWidth,innerHeight]};
        })()`);
    }
    async function panelWidths(width: number, label: string) {
        const layouts: { expanded: boolean; tab: string; panels: {
            name: string; scrollWidth: number; clientWidth: number; height: number; overflowX: string }[] }[] = [];
        for (const expanded of [false, true]) {
            if (width <= 860) await tab('Teams');
            if (expanded) await inspectTeam(2);
            const tabs = width >= 1220 ? ['All']
                : width <= 860 ? ['Teams','Players','My roster','Results'] : ['Players','My roster','Results'];
            for (const selected of tabs) {
                if (selected !== 'All') await tab(selected);
                const panels = await evaluate<(typeof layouts)[number]['panels']>(`(() => {
                    const visible=element=>element.getBoundingClientRect().width>0;
                    return [...document.querySelectorAll('.panel .scroll,.team-roster')]
                        .filter(visible).map(element=>({name:element.classList.contains('team-roster')
                            ?'inspected roster':element.closest('.panel').getAttribute('aria-label'),
                            scrollWidth:element.scrollWidth,clientWidth:element.clientWidth,
                            height:element.getBoundingClientRect().height,overflowX:getComputedStyle(element).overflowX}));
                })()`);
                layouts.push({ expanded, tab: selected, panels });
                if ((selected === 'Teams' || selected === 'All') && (width <= 390 || width === 1440)) {
                    await browser('scroll', 'up', '2000', '--selector', '.teams .scroll');
                    await browser('screenshot', `${evidence}/${label}-${expanded ? 'expanded' : 'collapsed'}-panels.png`);
                }
            }
        }
        if (width <= 860) await tab('Teams');
        await inspectTeam(2);
        return layouts;
    }
    function assertPanelWidths(layouts: Awaited<ReturnType<typeof panelWidths>>) {
        for (const expanded of [false, true]) {
            const panels = layouts.filter(layout => layout.expanded === expanded).flatMap(layout => layout.panels);
            assert.deepEqual([...new Set(panels.map(panel => panel.name))].sort(),
                ['Players','Teams','My roster','Results', ...(expanded ? ['inspected roster'] : [])].sort());
            for (const panel of panels) {
                assert(panel.clientWidth > 0, `${panel.name} must be visible for its width check`);
                assert(panel.scrollWidth <= panel.clientWidth,
                    `${panel.name} must not scroll horizontally: ${panel.scrollWidth} > ${panel.clientWidth}`);
            }
        }
    }
    try {
        const nameViewports = [[1180,768],[1181,768],[1200,768],[1219,768],[1220,768],
            [1280,720],[1440,900],[1024,768],[390,844],[390,667],[360,640],[360,667],[375,667]];
        for (const [width, height] of nameViewports) {
            for (const commissioner of [true, false]) {
                for (const status of ['paused','running','setup'] as const) {
                    const live = status !== 'setup';
                    const role = commissioner ? 'commissioner' : 'member', phase = status === 'paused' ? 'live' : status;
                    const label = `${width}x${height}-${role}-${phase}${width < 390 ? '-narrow' : ''}`;
                    await check(`${label} team names stay complete beside their cues`, async () => {
                        viewerToken = commissioner ? token : memberToken;
                        const state = await seed('partial');
                        if (!live) await configure({ draft: { status: 'setup', phase: 'nomination',
                            lotId: null, nominatorId: null, deadline: null, remainingMs: null } });
                        else if (status === 'running') await configure({ draft: { status, deadline: null } });
                        await browser('set', 'viewport', String(width), String(height)); await open();
                        if (width <= 860) await tab('Teams');
                        const normal = await teamNames();
                        await evaluate(`(() => {
                            const style=document.createElement('style');
                            style.textContent='.teams .scroll{scrollbar-width:auto;scrollbar-gutter:stable}'
                                +'.teams .scroll::-webkit-scrollbar{width:15px}';
                            document.head.append(style);return true;})()`);
                        const reserved = await teamNames();
                        let nomination: Awaited<ReturnType<typeof teamNames>> | null = null;
                        if (live) {
                            await configure({ draft: { phase: 'nomination', lotId: null,
                                nominatorId: 5, turnIndex: 4, deadline: null } });
                            await until(`document.querySelector('[aria-controls="team-roster-5"]')
                                .closest('.team-row').textContent.includes('Nominating')`);
                            nomination = await teamNames();
                        }
                        const panels = await panelWidths(width, label);
                        const proof = { normal, reserved, nomination, panels };
                        await writeFile(`${evidence}/${label}-team-names.json`, JSON.stringify(proof,null,2));
                        await browser('scroll', 'up', '2000', '--selector', '.teams .scroll');
                        await browser('screenshot', `${evidence}/${label}-team-names.png`);
                        assert(reserved.gutter >= 15, 'The scrollbar control must reserve real browser space');
                        assertPanelWidths(panels);
                        for (const layout of [normal, reserved, ...(nomination ? [nomination] : [])]) {
                            assert.equal(layout.admin, commissioner && status !== 'running');
                            assert.equal(layout.turn, live);
                            assert(layout.scrollWidth <= layout.clientWidth,
                                `Teams must not scroll horizontally: ${layout.scrollWidth} > ${layout.clientWidth}`);
                            assert.deepEqual(layout.names.map(row => row.name), state.managers.map(row => row.name));
                            assert(layout.document[0] <= width && layout.document[1] <= height);
                            for (const name of layout.names) {
                                assert(name.scrollWidth <= name.clientWidth, `${name.name} must not truncate`);
                                assert(name.gap >= 0 && name.gap <= 5, `${name.name}'s cue must stay beside its name`);
                                assert(name.cueVisible && name.buttonFits && name.aligned);
                                for (const line of name.lines) assert(line.fits, `${name.name}: ${line.text} must fit`);
                            }
                            for (const column of layout.columns) {
                                if (!column.excluded) assert(column.fits, `Data column must fit: ${column.text}`);
                            }
                            const hiddenTurns = layout.columns.filter(column =>
                                column.excluded === 'inline-turn-column');
                            assert.equal(hiddenTurns.length,
                                live && commissioner && status !== 'running' && width <= 860 ? 11 : 0);
                        }
                        return proof;
                    });
                }
            }
        }
        viewerToken = token;
        await check('360x640 narrow nomination and Done lines remain readable', async () => {
            await seed('full'); await configure({ managers: [{ id: 1, done: true },{ id: 2, done: true }],
                draft: { status: 'paused', phase: 'nomination', lotId: null, nominatorId: 5, turnIndex: 4 } });
            await browser('set', 'viewport', '360', '640'); await open(); await tab('Teams');
            const proof = await teamNames();
            await writeFile(`${evidence}/360x640-nomination-status.json`, JSON.stringify(proof,null,2));
            await browser('scroll', 'up', '2000', '--selector', '.teams .scroll');
            await browser('screenshot', `${evidence}/360x640-nomination-status.png`);
            await evaluate(`(() => {
                const row=document.querySelectorAll('.team-row')[4],scroll=row.closest('.scroll');
                const r=row.getBoundingClientRect(),s=scroll.getBoundingClientRect();
                scroll.scrollTop+=r.top-s.top-(scroll.clientHeight-r.height)/2;return true;})()`);
            await browser('screenshot', `${evidence}/360x640-nominator.png`);
            const nominator = proof.names.find(manager => manager.name === 'Kyle')!;
            assert(nominator.lines.some(line => line.text.trim() === 'Nominating'));
            assert(nominator.lines.every(line => line.fits), 'Kyle: Nominating must fit');
            for (const manager of proof.names) {
                for (const line of manager.lines) assert(line.fits, `${manager.name}: ${line.text} must fit`);
            }
            return proof;
        });
        for (const [width, height] of [[360,640],[375,667]]) {
            for (const status of ['paused','setup'] as const) {
                await check(`${width}x${height} narrow ${status} Release stays reachable with keyboard confirmation`,
                    async () => {
                        viewerToken = token; await seed('partial');
                        if (status === 'setup') await configure({ draft: { status, lotId: null, nominatorId: null } });
                        await browser('set', 'viewport', String(width), String(height)); await open(); await tab('Teams');
                        const selector = '.team-row:has([aria-controls="team-roster-2"]) .release';
                        assert(await evaluate(`!document.querySelector(${JSON.stringify(selector)}).getClientRects().length`));
                        await inspectTeam(2); await browser('press', 'Tab');
                        await until(`document.activeElement===document.querySelector(${JSON.stringify(selector)})`);
                        assertSlots(await evaluate<Measurements>(measure('#team-roster-2')), await getState(), 2, true);
                        const proof = await teamNames();
                        assert(proof.names.every(manager => manager.aligned));
                        assert(await evaluate(`(() => {
                            const button=document.querySelector(${JSON.stringify(selector)});
                            const scroll=button.closest('.scroll'),r=button.getBoundingClientRect();
                            const s=scroll.getBoundingClientRect();
                            scroll.scrollTop+=r.top-s.top-(scroll.clientHeight-r.height)/2;
                            const b=button.getBoundingClientRect();
                            return b.left>=s.left&&b.right<=s.right&&b.top>=s.top&&b.bottom<=s.bottom
                                &&button.contains(document.elementFromPoint((b.left+b.right)/2,(b.top+b.bottom)/2));
                        })()`));
                        await browser('focus', selector); await browser('press', 'Enter');
                        assert.equal((await getState()).managers[1].claimed, true);
                        assert(await evaluate(`document.querySelector(${JSON.stringify(selector)})
                            .textContent.includes('Release Matthew?')`));
                        await browser('screenshot', `${evidence}/${width}x${height}-${status}-release-confirm.png`);
                        await browser('press', 'Enter');
                        await until(`!document.querySelector(${JSON.stringify(selector)})`);
                        assert.equal((await getState()).managers[1].claimed, false);
                        memberToken = await claimSeat(2);
                        return proof;
                    });
            }
        }
        for (const [width, height] of [[1440,900],[390,844]]) {
            await check(`${width}x${height} team disclosure is visible without hover and follows inspection`, async () => {
                await browser('set', 'viewport', String(width), String(height));
                const state = await seed('partial'); await open(); await tab('Teams');
                await browser('mouse', 'move', '0', '0');
                const closed = [];
                for (const manager of state.managers) {
                    const proof = await teamGeometry(manager.id); closed.push({ manager: manager.name, ...proof });
                    assert(proof.cueVisible, `${manager.name} must have a visible disclosure cue without hover`);
                    assert.equal(proof.expanded, false); assert.equal(proof.cueAngle, 0); aligned(proof);
                }
                await browser('scroll', 'up', '2000', '--selector', '.teams .scroll');
                await browser('screenshot', `${evidence}/${width}x${height}-disclosure-closed.png`);
                await inspectTeam(2);
                const opened = await teamGeometry(2);
                assert(opened.cueVisible); assert(opened.expanded); assert.equal(opened.cueAngle, 90);
                assert.notEqual(opened.background, closed[1].background); aligned(opened);
                await browser('screenshot', `${evidence}/${width}x${height}-disclosure-open.png`);
                await inspectTeam(2);
                const restored = await teamGeometry(2);
                assert(restored.cueVisible); assert(!restored.expanded); assert.equal(restored.cueAngle, 0);
                assert.equal(restored.background, closed[1].background); aligned(restored);
                return { closed, opened, restored };
            });
            await check(`${width}x${height} team disclosure keyboard focus stays inside its clipping area`, async () => {
                await browser('set', 'viewport', String(width), String(height));
                await seed('partial'); await open(); await tab('Teams'); await teamGeometry(2);
                const selector = '[aria-controls="team-roster-2"]';
                await browser('focus', selector); await browser('press', 'Tab'); await browser('press', 'Shift+Tab');
                const proof = await evaluate<{
                    focused: boolean; visible: boolean; outlineWidth: number; outlineStyle: string;
                    outlineOffset: number; ring: number[]; clips: number[][];
                }>(`(() => {
                    const button=document.querySelector(${JSON.stringify(selector)}),style=getComputedStyle(button);
                    const r=button.getBoundingClientRect();
                    const width=parseFloat(style.outlineWidth),offset=parseFloat(style.outlineOffset);
                    const extent=width+offset,ring=[r.left-extent,r.top-extent,r.right+extent,r.bottom+extent];
                    const box=element=>{const b=element.getBoundingClientRect();return [b.left,b.top,b.right,b.bottom];};
                    const clips=[box(button.closest('.team-name')),box(button.closest('.scroll')),
                        [0,0,innerWidth,innerHeight]];
                    return {focused:document.activeElement===button&&button.matches(':focus-visible'),
                        visible:ring[2]>ring[0]&&ring[3]>ring[1],outlineWidth:width,outlineOffset:offset,
                        outlineStyle:style.outlineStyle,ring,clips};
                })()`);
                await browser('screenshot', `${evidence}/${width}x${height}-disclosure-focus.png`);
                await writeFile(`${evidence}/${width}x${height}-disclosure-focus.json`, JSON.stringify(proof,null,2));
                assert(proof.focused); assert(proof.visible); assert(proof.outlineWidth >= 2);
                assert.equal(proof.outlineStyle, 'solid');
                for (const clip of proof.clips) {
                    assert(proof.ring[0] >= clip[0] && proof.ring[1] >= clip[1]
                        && proof.ring[2] <= clip[2] && proof.ring[3] <= clip[3],
                    'The entire focus outline must fit inside the cell, scroll container and viewport');
                }
                return proof;
            });
        }
        for (const [width, height] of [[1440,900],[390,844],[390,667]]) {
            await browser('set', 'viewport', String(width), String(height));
            for (const mode of ['empty','partial','full'] as const) {
                const state = await seed(mode); await open();
                const label = `${width}x${height}-${mode}`;
                await check(`${label} My roster shows every occupied and open slot`, async () => {
                    await tab('My roster');
                    const proof = await evaluate<Measurements>(measure('.roster'));
                    await writeFile(`${evidence}/${label}-mine.json`, JSON.stringify(proof, null, 2));
                    await browser('scroll', 'up', '2000', '--selector', '.roster .scroll');
                    await browser('screenshot', `${evidence}/${label}-mine.png`);
                    await browser('scroll', 'down', '2000', '--selector', '.roster .scroll');
                    await browser('screenshot', `${evidence}/${label}-mine-bottom.png`);
                    assertSlots(proof, state, 1, false); return proof;
                });
                await check(`${label} inspected Teams roster shows the same read-only slots`, async () => {
                    await tab('Teams'); await inspectTeam(2);
                    const proof = await evaluate<Measurements>(measure('#team-roster-2'));
                    await writeFile(`${evidence}/${label}-teams.json`, JSON.stringify(proof, null, 2));
                    await browser('scroll', 'up', '2000', '--selector', '.teams .scroll');
                    await browser('screenshot', `${evidence}/${label}-teams.png`);
                    await evaluate(`(() => {
                        const rows=document.querySelectorAll('#team-roster-2 .roster-row');
                        const last=rows[rows.length-1],scroll=document.querySelector('.teams .scroll');
                        scroll.scrollTop+=last.getBoundingClientRect().bottom-scroll.getBoundingClientRect().bottom;
                        return true;})()`);
                    await browser('screenshot', `${evidence}/${label}-teams-bottom.png`);
                    assertSlots(proof, state, 2, true); return proof;
                });
            }
        }
        await check('Team inspection opens and closes by keyboard, one team at a time', async () => {
            await browser('set', 'viewport', '390', '844'); await seed('partial'); await open(); await tab('Teams');
            await inspectTeam(2);
            assert.equal(await evaluate('document.querySelector(".team-name button[aria-expanded=true]").textContent'),
                'Matthew');
            await inspectTeam(2, 'Space');
            assert.equal(await evaluate('document.querySelectorAll(".team-roster").length'), 0);
            await inspectTeam(2); await inspectTeam(1);
            assert.equal(await evaluate('document.querySelectorAll(".team-roster").length'), 1);
            assert.equal(await evaluate('document.querySelectorAll("#team-roster-1 .placement button").length'), 0);
            await inspectTeam(1);
            assert.equal(await evaluate('document.querySelectorAll(".team-roster").length'), 0);
        });
        await check('Placement controls move a real player to Taxi, IR and Active without adding slots', async () => {
            await seed('partial'); await open(); await tab('My roster');
            const beforeEvent = Number((await getState()).recentEvents[0]?.id ?? 0);
            await evaluate(`(() => {
                window.slotClicks=[];document.addEventListener('click',event=>window.slotClicks.push(
                    {tag:event.target.tagName,text:event.target.closest('button')?.textContent}),
                    {capture:true});return true;})()`);
            for (const [button, placement] of [['To Taxi','taxi'],['To IR','ir'],['To Active','active']] as const) {
                const state = await getState();
                const entry = state.roster.find(entry => entry.playerId === mover.id)!;
                const controls = await evaluate<string[]>(`[...document.querySelectorAll(
                    '#roster-${entry.lotId} .placement button')].map(button=>button.textContent)`);
                const index = controls.indexOf(button);
                assert(index >= 0, `${button} must be available on ${mover.name}: ${JSON.stringify(controls)}`);
                const reachable = await evaluate<boolean>(`(() => {
                    const row=document.querySelector('#roster-${entry.lotId}');
                    const scroll=document.querySelector('.roster .scroll');
                    const r=row.getBoundingClientRect(),s=scroll.getBoundingClientRect();
                    scroll.scrollTop+=r.top-s.top-(scroll.clientHeight-r.height)/2;
                    const button=row.querySelector('.placement button:nth-child(${index + 1})');
                    const b=button.getBoundingClientRect();
                    return button.contains(document.elementFromPoint((b.left+b.right)/2,(b.top+b.bottom)/2));
                })()`);
                assert(reachable, 'The placement button must be visible after panel scrolling');
                await evaluate('window.slotClicks=[];true');
                await browser('click', `#roster-${entry.lotId} .placement button:nth-child(${index + 1})`);
                await sleep(150);
                const observed = await evaluate(`({row:document.querySelector('#roster-${entry.lotId}')?.outerHTML,
                    error:document.querySelector('.toast')?.textContent,clicks:window.slotClicks,
                    tab:document.querySelector('.room').dataset.tab,
                    hit:(()=>{const b=document.querySelector('#roster-${entry.lotId} .placement button');
                        const r=b?.getBoundingClientRect();return r?{rect:r.toJSON(),
                            hit:document.elementFromPoint((r.left+r.right)/2,(r.top+r.bottom)/2)?.outerHTML}:null;})()})`);
                await writeFile(`${evidence}/placement-${placement}.json`, JSON.stringify({ controls, observed,
                    entry:(await getState()).roster.find(entry=>entry.playerId===mover.id) },null,2));
                await until(`(() => {
                    const group=document.querySelector('#roster-${entry.lotId}')?.closest('.roster-group')
                        ?.querySelector('h3')?.firstChild.textContent.trim();
                    return ${placement === 'active' ? "group==='Starters'||group==='Bench'"
                        : `group===${JSON.stringify(placement === 'taxi' ? 'Taxi' : 'IR')}`};
                })()`);
                const changed = await getState();
                assert.equal(changed.roster.find(entry => entry.playerId === mover.id)!.placement, placement);
                assertSlots(await evaluate<Measurements>(measure('.roster')), changed, 1, false);
            }
            const changes = (await getState()).recentEvents.filter(event => Number(event.id) > beforeEvent
                && event.type === 'placement' && event.data.playerId === mover.id);
            assert.deepEqual(changes.map(event => event.data.to).reverse(), ['taxi','ir','active']);
            return { changes };
        });
        await check('A fresh public Force sale scrolls to and highlights the replacement slot', async () => {
            const state = await seed('partial');
            const id = state.roster.length + 1;
            await configure({ lot: { id, playerId: freshPlayer.id, nominatorId: 2, highBidderId: 1,
                highBid: 4, status: 'open' }, draft: { lotId: id } });
            await open(); await tab('My roster');
            await browser('scroll', 'down', '2000', '--selector', '.roster .scroll');
            await act({ type: 'force', lotId: id, expectedHighBidderId: 1, expectedHighBid: 4 }, token);
            await until(`!!document.querySelector('#roster-${id}.fresh')`);
            const proof = await evaluate<{ visible: boolean; scrollTop: number; background: string }>(`(() => {
                const row=document.querySelector('#roster-${id}');const scroll=document.querySelector('.roster .scroll');
                const r=row.getBoundingClientRect(),s=scroll.getBoundingClientRect();
                return {visible:r.top>=s.top-1&&r.bottom<=s.bottom+1,scrollTop:scroll.scrollTop,
                    background:getComputedStyle(row).backgroundColor};})()`);
            assert(proof.visible, 'A new win must be visible in its panel');
            assert.notEqual(proof.background, 'rgba(0, 0, 0, 0)');
            await browser('screenshot', `${evidence}/390x844-fresh-win.png`);
            assert.equal(await evaluate(`document.querySelector('#roster-${id} strong').textContent`), freshPlayer.name);
            assertSlots(await evaluate<Measurements>(measure('.roster')), await getState(), 1, false);
            return proof;
        });
        await check('Short mobile details preserve inspected selection and all reachable slots', async () => {
            await browser('set', 'viewport', '390', '667'); const state = await seed('partial'); await open();
            await tab('Teams'); await inspectTeam(2);
            await browser('find', 'role', 'button', 'click', '--name', 'Details', '--exact');
            assert.equal(await evaluate('document.querySelector(".lot-heading button").getAttribute("aria-expanded")'),
                'true');
            assertSlots(await evaluate<Measurements>(measure('#team-roster-2')), state, 2, true);
            await browser('screenshot', `${evidence}/390x667-details-expanded.png`);
            await browser('scroll', 'up', '2000', '--selector', '.block-information');
            await browser('focus', '.lot-heading button'); await browser('press', 'Enter');
            assert.equal(await evaluate('Boolean(document.querySelector(".block .details"))'), false);
            assertSlots(await evaluate<Measurements>(measure('#team-roster-2')), state, 2, true);
            await tab('My roster');
            assertSlots(await evaluate<Measurements>(measure('.roster')), state, 1, false);
            await tab('Teams'); assert.equal(await evaluate('document.querySelectorAll("#team-roster-2").length'), 1);
            await browser('screenshot', `${evidence}/390x667-details-recovery.png`);
        });
        await check('Team inspection preserves commissioner Release and nomination labels', async () => {
            await seed('partial'); await open(); await tab('Teams'); await inspectTeam(2);
            const row = '.team-row:has([aria-controls="team-roster-2"])';
            assert(await evaluate(`document.querySelector(${JSON.stringify(row)})?.textContent.includes('12/20')`));
            await browser('click', `${row} .release`); await browser('click', `${row} .release`);
            await until(`!document.querySelector(${JSON.stringify(row + ' .release')})`);
            assert.equal((await getState()).managers[1].claimed, false);
            assert.equal(await evaluate('document.querySelectorAll("#team-roster-2").length'), 1);
            assert(await evaluate('document.querySelector(".team-row:has([aria-controls=team-roster-3])")'
                + '.textContent.includes("Nominated")'));
        });
        await check('The unassigned Active fallback keeps twenty spots with open placeholders', async () => {
            const guards = players.filter(player => player.positions.length === 1 && player.positions[0] === 'PG')
                .slice(0,16);
            assert.equal(guards.length, 16); assert.equal(matching(guards), null);
            await configure({ roster: guards.map((player,index) => ({ playerId:player.id, managerId:1,
                placement:'active', price:1, lotId:index+1 })), draft: { lotId:null, phase:'nomination' } });
            await open(); await tab('My roster');
            const proof = await evaluate<Measurements>(measure('.roster'));
            frame(proof); assert.equal(proof.groups.Active.length,20);
            assert.equal(proof.groups.Active.filter(row=>row.open).length,4);
            proof.groups.Active.forEach((row,index) => {
                assert.equal(row.label, `Active spot ${index+1} of 20, ${guards[index]?.name ?? 'open'}`);
                assert(row.reachable); if(row.open){assert(!row.interactive);assert.equal(row.tabIndex,-1);}
            });
            await browser('screenshot', `${evidence}/390x667-active-fallback.png`);
            return proof;
        });
        assert.equal(await browser('errors'), '');
    } finally {
        try {
            await browser('close');
            for (let attempt = 0; ; attempt++) {
                if (!(await execute('agent-browser', ['session','list'])).stdout.includes(session)) break;
                assert(attempt < 100); await sleep(50);
            }
        } finally {
            await new Promise<void>(resolve => server.close(() => resolve()));
            await requireClosedPort(port); await dropIsolated(isolated);
            await writeFile(`${evidence}/results.json`, JSON.stringify(results,null,2));
            await writeFile(`${evidence}/shutdown.json`, JSON.stringify({ session, browserClosed:true,
                frontendPort:port, frontendClosed:true, backendClosed:true }));
        }
    }
    assert(results.every(result => result.result === 'passed'), 'Every roster-slot check must pass');
}
withResources(main).catch(error => { console.error(error); process.exitCode=1; });
