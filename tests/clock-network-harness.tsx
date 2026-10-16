import { ClockSamples } from '../lib/clock-samples';
import { createRoot } from 'react-dom/client';
import { AuctionProvider } from '../app/provider';
import Room from '../app/page';

const host = window as unknown as { config: { url: string; proxyUrl: string; token: string; skew: number; disableTimeout: boolean };
    clockNetwork: { nativeNow: () => number; responses: number; requests: number[]; offsets: number[]; accepted: unknown[]; freeze: () => void; wake: () => void } };
const nativeNow = Date.now.bind(Date);
const nativeFetch = window.fetch.bind(window);
const nativeMonotonic = performance.now.bind(performance);
let pausedAt: number | null = null;
let slept = 0;
const accepted: unknown[] = [];
host.clockNetwork = { nativeNow, responses: 0, requests: [], offsets: [], accepted,
    freeze: () => { pausedAt = nativeMonotonic(); },
    wake: () => { if (pausedAt !== null) slept += nativeMonotonic() - pausedAt; pausedAt = null; } };
Object.defineProperty(performance, 'now', { value: () => (pausedAt ?? nativeMonotonic()) - slept });
const accept = ClockSamples.prototype.accept;
ClockSamples.prototype.accept = function(...args: Parameters<typeof accept>) {
    const result = accept.apply(this, args);
    if (result !== null) accepted.push(result);
    return result;
};
Date.now = () => nativeNow() + host.config.skew;
if (host.config.disableTimeout) Object.defineProperty(AbortSignal, 'timeout', { value: undefined });
window.fetch = async (input, init) => {
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
    if (body.path !== 'auction:syncTime') return nativeFetch(input, init);
    const start = nativeNow();
    host.clockNetwork.requests.push(start);
    const target = String(input).replace(host.config.url, host.config.proxyUrl);
    const response = await nativeFetch(target, init);
    const payload = await response.clone().json();
    host.clockNetwork.responses++;
    host.clockNetwork.offsets.push(payload.value.serverNow - (start + nativeNow()) / 2 - host.config.skew);
    return response;
};
localStorage.setItem('pancake-seat', host.config.token);
createRoot(document.getElementById('root')!).render(<AuctionProvider url={host.config.url}><Room /></AuctionProvider>);
