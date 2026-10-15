import { createRoot } from 'react-dom/client';
import { AuctionProvider } from '../app/provider';
import Room from '../app/page';
const config = (window as unknown as { roomConfig: { token: string; url: string } }).roomConfig;
localStorage.setItem('pancake-seat', config.token);
const NativeSocket = window.WebSocket;
const wire = { nominations: [] as Record<string, unknown>[],
  responses: [] as Record<string, unknown>[], closes: [] as Record<string, unknown>[] };
Object.assign(window, { wire });
class RecordedSocket extends NativeSocket {
  constructor(url: string | URL, protocols?: string | string[]) {
    super(url, protocols);
    this.addEventListener('close', event => wire.closes.push({ code: event.code, at: Date.now() }));
    this.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.type === 'MutationResponse' && wire.nominations.some(n => n.requestId === message.requestId)) {
        wire.responses.push({ requestId: message.requestId, result: message.result });
      }
    });
  }
  override send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
    if (typeof data === 'string') {
      const message = JSON.parse(data);
      const action = message.args?.[0]?.action;
      if (message.type === 'Mutation' && action?.type === 'nominate') {
        wire.nominations.push({ requestId: message.requestId, action, at: Date.now() });
      }
    }
    super.send(data);
  }
}
window.WebSocket = RecordedSocket;
createRoot(document.getElementById('root')!).render(<AuctionProvider url={config.url}><Room /></AuctionProvider>);
