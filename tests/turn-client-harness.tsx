const clockSample = { serverNow: Date.now(), monotonic: performance.now() };
import { createRoot } from 'react-dom/client';
import { useEffect, useState } from 'react';
import { AuctionProvider } from '../app/provider';
import Room from '../app/page';
import { CommissionerBar, BlockPanel } from '../app/components';
import type { Action, AuctionState } from '../lib/types';

interface Message { type: string; requestId: number; udfPath: string; result?: { serverNow?: number } }
const host = window as unknown as { initial: AuctionState; config: { token: string; url: string; skew: number };
    replace: (change: Partial<AuctionState>) => void; actions: Action[]; control: typeof control };
const nativeNow = Date.now.bind(Date);
const nativeFetch = window.fetch.bind(window);
const control = { delay: 0, requests: {} as Record<number, string>,
    events: [] as { type: string; path?: string; at: number; serverNow?: number }[], nativeNow };
host.control = control;
host.actions = [];
if (host.config.skew) Date.now = () => nativeNow() + host.config.skew;
window.fetch = async (input, init) => {
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
    const response = await nativeFetch(input, init);
    if (body.path === 'auction:syncTime') {
        const payload = await response.clone().json();
        control.events.push({ type: 'http-clock', at: nativeNow(), serverNow: payload.value?.serverNow });
    }
    return response;
};
const NativeSocket = window.WebSocket;
class OrderedSocket extends EventTarget {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    readyState = 0;
    onopen: ((event: Event) => void) | null = null;
    onclose: ((event: CloseEvent) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    private socket: WebSocket;
    private blockedUntil = 0;
    private queue: (() => void)[] = [];
    private timer?: ReturnType<typeof setTimeout>;
    constructor(url: string | URL, protocols?: string | string[]) {
        super();
        this.socket = new NativeSocket(url, protocols);
        this.socket.onopen = event => { this.readyState = 1; this.onopen?.(event); };
        this.socket.onclose = event => { this.readyState = 3; this.onclose?.(event); };
        this.socket.onerror = event => this.onerror?.(event);
        this.socket.onmessage = event => {
            const data: Message = JSON.parse(event.data);
            const path = control.requests[data.requestId];
            const deliver = () => {
                if (data.type === 'MutationResponse') control.events.push({ type: 'delivered', path,
                    at: nativeNow(), serverNow: data.result?.serverNow });
                this.onmessage?.(event);
            };
            if (data.type === 'MutationResponse') control.events.push({ type: 'received', path,
                at: nativeNow(), serverNow: data.result?.serverNow });
            if (data.type === 'MutationResponse' && path === 'auction:actOnDraft' && control.delay) {
                this.blockedUntil = nativeNow() + control.delay;
                deliver();
            } else if (nativeNow() < this.blockedUntil || this.queue.length) {
                this.queue.push(deliver);
                if (!this.timer) this.timer = setTimeout(() => {
                    this.timer = undefined;
                    control.events.push({ type: 'transitions-released', at: nativeNow() });
                    for (const release of this.queue.splice(0)) release();
                }, Math.max(0, this.blockedUntil - nativeNow()));
            } else deliver();
        };
    }
    send(value: string) {
        const data: Message = JSON.parse(value);
        if (data.type === 'Mutation') control.requests[data.requestId] = data.udfPath;
        this.socket.send(value);
    }
    close(code?: number, reason?: string) { clearTimeout(this.timer); this.socket.close(code, reason); }
}
window.WebSocket = OrderedSocket as unknown as typeof WebSocket;
function Components() {
    const [state, setState] = useState(host.initial);
    useEffect(() => { host.replace = change => setState(current => ({ ...current, ...change })); }, []);
    const props = { state, me: state.managers[0], busy: false, connected: true,
        send: async (action: Action) => { host.actions.push(action); } };
    return <><CommissionerBar {...props} /><BlockPanel {...props}
        clockSample={clockSample} opening={1} setOpening={() => {}} /></>;
}
const room = new URL(location.href).searchParams.get('mode') === 'room';
if (room) localStorage.setItem('pancake-seat', host.config.token);
createRoot(document.getElementById('root')!).render(room
    ? <AuctionProvider url={host.config.url}><Room /></AuctionProvider> : <Components />);
