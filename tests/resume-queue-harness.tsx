import { createRoot } from 'react-dom/client';
import { useMutation, useQuery } from 'convex/react';
import { makeFunctionReference } from 'convex/server';
import { AuctionProvider } from '../app/provider';
import { api } from '../convex/_generated/api';
import Room from '../app/page';

const config = (window as unknown as { roomConfig: { url: string; token: string } }).roomConfig;
const NativeSocket = window.WebSocket;
const transport = { blocked: false, holdActions: false, sockets: [] as ControlledSocket[], held: [] as (() => void)[] };
Object.assign(window, { transport });
localStorage.setItem('pancake-seat', config.token);
class ControlledSocket {
    static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
    readyState = 0;
    onopen: ((event: Event) => void) | null = null;
    onclose: ((event: CloseEvent) => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    private socket?: WebSocket;
    private timer: ReturnType<typeof setTimeout>;
    constructor(url: string | URL, protocols?: string | string[]) {
        transport.sockets.push(this);
        this.timer = setTimeout(() => {
            this.socket = new NativeSocket(url, protocols);
            this.socket.onopen = event => { this.readyState = 1; this.onopen?.(event); };
            this.socket.onclose = event => { this.readyState = 3; this.onclose?.(event); };
            this.socket.onmessage = event => this.onmessage?.(event);
            this.socket.onerror = event => this.onerror?.(event);
        }, transport.blocked ? 60000 : 0);
    }
    send(data: string) {
        const value = JSON.parse(data);
        if (transport.holdActions && value.type === 'Mutation' && value.udfPath === 'auction:actOnDraft') {
            transport.held.push(() => this.socket!.send(data));
        } else this.socket!.send(data);
    }
    close() {
        clearTimeout(this.timer);
        if (this.socket) this.socket.close();
        else { this.readyState = 3; this.onclose?.(new CloseEvent('close')); }
    }
}
window.WebSocket = ControlledSocket as unknown as typeof WebSocket;
function QueueControl() {
    const state = useQuery(api.auction.state, { token: config.token });
    const mutate = useMutation(makeFunctionReference<'mutation', { token: string; action: Record<string, unknown> },
        { ok: boolean; error?: string }>('auction:actOnDraft'));
    Object.assign(window, { pauseControl: { state, queue: (type: 'pause' | 'resume') => {
        const action: Record<string, unknown> = { type };
        const generation = (state?.draft as { controlGeneration?: string })?.controlGeneration;
        if (generation !== undefined) action[type === 'resume' ? 'expectedPause' : 'expectedRunning'] = generation;
        Object.assign(window, { queuedResult: null });
        void mutate({ token: config.token, action }).then(result => Object.assign(window, { queuedResult: result }));
    } } });
    return null;
}
createRoot(document.getElementById('root')!).render(<AuctionProvider url={config.url}><Room /><QueueControl /></AuctionProvider>);
