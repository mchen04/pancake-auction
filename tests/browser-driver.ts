import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { webkit } from 'playwright-core';
import { freePort, sleep, stopProcess } from '../scripts/local-backend';
import { ownProcess, ownCleanup, runBrowser } from '../scripts/resources';
import { writeEvidenceFile } from '../scripts/evidence';

export interface Driver {
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
export const mode = process.env.AUCTION_BROWSER ?? 'chromium';
export const label = mode === 'safari' ? 'Desktop Safari' : mode === 'webkit' ? 'Playwright WebKit (not Safari)' : 'Chromium';
export const commands: { command: string; result?: unknown }[] = [];
export async function watchClockRequests(browser: Driver) {
    await browser.evaluate(`(() => {
        const fetch = window.fetch.bind(window);
        window.auctionClockRequests = 0;
        window.fetch = (input, init) => {
            if (typeof init?.body === 'string' && JSON.parse(init.body).path === 'auction:syncTime') window.auctionClockRequests++;
            return fetch(input, init);
        };
        window.dispatchEvent(new Event('focus'));
        document.dispatchEvent(new Event('visibilitychange'));
        return true;
    })()`);
}
export async function driver(): Promise<Driver> {
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
        const cache = process.env.PLAYWRIGHT_BROWSERS_PATH || `${homedir()}/Library/Caches/ms-playwright`;
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
