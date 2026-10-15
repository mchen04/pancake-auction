import { createRoot } from 'react-dom/client';
import { AuctionProvider } from '../app/provider';
import Room from '../app/page';

const NativeSocket = window.WebSocket;
const config = (window as unknown as { roomConfig: { url: string; token: string } }).roomConfig;
const transport = {
    bids: [] as { requestId: number; lotId: number; amount: number; at: number }[],
    responses: [] as { requestId: number; ok: boolean; status?: number; error?: string }[],
    closes: [] as { code: number; reason: string; at: number }[],
    busyStates: [] as boolean[],
    feedback: [] as string[]
};
Object.assign(window, { transport });
localStorage.setItem('pancake-seat', config.token);

class RecordedSocket extends NativeSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        this.addEventListener('close', event => {
            transport.closes.push({ code: event.code, reason: event.reason, at: Date.now() });
        });
        this.addEventListener('message', event => {
            const message = JSON.parse(event.data);
            if (message.type !== 'MutationResponse'
                || !transport.bids.some(bid => bid.requestId === message.requestId)) return;
            transport.responses.push({ requestId: message.requestId, ok: message.result?.ok === true,
                status: message.result?.status, error: message.result?.error });
        });
    }
    override send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
        if (typeof data === 'string') {
            const message = JSON.parse(data);
            const action = message.args?.[0]?.action;
            if (message.type === 'Mutation' && message.udfPath === 'auction:actOnDraft' && action?.type === 'bid') {
                transport.bids.push({ requestId: message.requestId, lotId: action.lotId,
                    amount: action.amount, at: Date.now() });
            }
        }
        super.send(data);
    }
}
window.WebSocket = RecordedSocket;
new MutationObserver(() => {
    const pause = [...document.querySelectorAll<HTMLButtonElement>('.commish button')]
        .find(button => button.textContent === 'Pause');
    if (pause && transport.busyStates.at(-1) !== pause.disabled) transport.busyStates.push(pause.disabled);
    for (const selector of ['.bid-note', '.offline[role="status"]']) {
        const text = document.querySelector(selector)?.textContent ?? '';
        if (/Sending|Reconnecting/.test(text) && !transport.feedback.includes(text)) transport.feedback.push(text);
    }
}).observe(document.getElementById('root')!, { subtree: true, childList: true, characterData: true,
    attributes: true, attributeFilter: ['disabled'] });
createRoot(document.getElementById('root')!).render(<AuctionProvider url={config.url}><Room /></AuctionProvider>);
