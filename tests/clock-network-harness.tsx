import { createRoot } from 'react-dom/client';
import { AuctionProvider } from '../app/provider';
import Room from '../app/page';

const host = window as unknown as { config: { url: string; proxyUrl: string; token: string; skew: number; disableTimeout: boolean };
    clockNetwork: { nativeNow: () => number; responses: number; offsets: number[] } };
const nativeNow = Date.now.bind(Date);
const nativeFetch = window.fetch.bind(window);
host.clockNetwork = { nativeNow, responses: 0, offsets: [] };
Date.now = () => nativeNow() + host.config.skew;
if (host.config.disableTimeout) Object.defineProperty(AbortSignal, 'timeout', { value: undefined });
window.fetch = async (input, init) => {
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
    if (body.path !== 'auction:syncTime') return nativeFetch(input, init);
    const start = nativeNow();
    const target = String(input).replace(host.config.url, host.config.proxyUrl);
    const response = await nativeFetch(target, init);
    const payload = await response.clone().json();
    host.clockNetwork.responses++;
    host.clockNetwork.offsets.push(payload.value.serverNow - (start + nativeNow()) / 2 - host.config.skew);
    return response;
};
localStorage.setItem('pancake-seat', host.config.token);
createRoot(document.getElementById('root')!).render(<AuctionProvider url={host.config.url}><Room /></AuctionProvider>);
