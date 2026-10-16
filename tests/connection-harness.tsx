import { createRoot } from 'react-dom/client';
import { useEffect, useState } from 'react';
import { useQuery } from 'convex/react';
import { AuctionProvider } from '../app/provider';
import { api } from '../convex/_generated/api';
import Room from '../app/page';

const NativeSocket = window.WebSocket;
const mode = new URL(location.href).searchParams.get('case');
const config = (window as unknown as { roomConfig: { url: string; token: string } }).roomConfig;
const control = { sockets: [] as ControlledSocket[], poolHeld: false, holdPools: mode === 'cold',
    blocked: false, syncCalls: 0, cachedTimes: [] as number[], ready: false };
Object.assign(window, { transport: control });
localStorage.setItem('pancake-seat', config.token);
const nativeFetch = window.fetch.bind(window);
window.fetch = (input, init) => {
    if (typeof init?.body === 'string' && JSON.parse(init.body).path === 'auction:syncTime') control.syncCalls++;
    return nativeFetch(input, init);
};

class ControlledSocket extends EventTarget {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    readyState = 0;
    onopen: ((event: Event) => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onclose: ((event: CloseEvent) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    private socket?: WebSocket;
    private queue: MessageEvent[] = [];
    private draining = false;
    private start: ReturnType<typeof setTimeout>;
    constructor(url: string | URL, protocols?: string | string[]) {
        super();
        control.sockets.push(this);
        const delay = mode === 'unavailable' || control.blocked ? 60000 : mode === 'cold' ? 1500 : 0;
        this.start = setTimeout(() => {
            this.socket = new NativeSocket(url, protocols);
            this.socket.onopen = event => {
                this.readyState = 1;
                control.ready = true;
                this.onopen?.(event);
            };
            this.socket.onclose = event => { this.readyState = 3; this.onclose?.(event); };
            this.socket.onerror = event => this.onerror?.(event);
            this.socket.onmessage = event => { this.queue.push(event); void this.drain(); };
        }, delay);
    }
    send(data: string) {
        const message = JSON.parse(data);
        if (message.type === 'Mutation' && message.udfPath === 'auction:syncTime') control.syncCalls++;
        this.socket!.send(data);
    }
    close(code?: number, reason?: string) {
        clearTimeout(this.start);
        if (this.socket) this.socket.close(code, reason);
        else { this.readyState = 3; this.onclose?.(new CloseEvent('close')); }
    }
    private async drain() {
        if (this.draining) return;
        this.draining = true;
        while (this.queue.length) {
            const event = this.queue.shift()!;
            const message = JSON.parse(event.data);
            let pool = false;
            let stateUpdate = false;
            for (const update of message.modifications ?? []) {
                if (update.type !== 'QueryUpdated') continue;
                if (update.value?.draft) {
                    stateUpdate = true;
                    if (mode === 'stale') update.value.serverNow -= 60000;
                    control.cachedTimes.push(update.value.serverNow);
                }
                if (update.value?.players?.length && update.value.revision) pool = true;
            }
            if (pool && !stateUpdate && control.holdPools) {
                control.poolHeld = true;
                while (control.holdPools && this.readyState !== 3) {
                    await new Promise(resolve => setTimeout(resolve, 20));
                }
                control.poolHeld = false;
            }
            if (this.readyState !== 3) {
                this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(message) }));
            }
        }
        this.draining = false;
    }
}
window.WebSocket = ControlledSocket as unknown as typeof WebSocket;
function CachedClockControl() {
    const snapshot = useQuery(api.auction.state, { token: config.token });
    const [offset, setOffset] = useState(0);
    useEffect(() => { if (snapshot) setOffset(snapshot.serverNow - Date.now()); }, [snapshot]);
    const [now, setNow] = useState(Date.now);
    useEffect(() => { const timer=setInterval(()=>setNow(Date.now()),100); return ()=>clearInterval(timer); },[]);
    const remaining = snapshot ? Math.max(0,(snapshot.draft.deadline ?? now)-now-offset)/1000 : 0;
    return snapshot && <div className="legacy-clock"><span className="digits">
        {remaining>=10?Math.ceil(remaining):remaining.toFixed(1)}</span></div>;
}
createRoot(document.getElementById('root')!).render(<AuctionProvider url={config.url}>
    <Room />{mode === 'stale' && <CachedClockControl />}
</AuctionProvider>);
