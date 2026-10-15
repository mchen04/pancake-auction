import { createRoot } from 'react-dom/client';
import Room from '../app/page';
import type { AuctionState } from '../lib/types';

const state: AuctionState = await (await fetch('/fixture.json' + location.search)).json();
window.fetch = async () => new Response(JSON.stringify({ ...state, serverNow: Date.now() }));
createRoot(document.getElementById('root')!).render(<Room />);
