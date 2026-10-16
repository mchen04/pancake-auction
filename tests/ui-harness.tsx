const clockSample = { serverNow: Date.now(), monotonic: performance.now() };
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import Room from '../app/page';
import { AuctionProvider } from '../app/provider';
import { BlockPanel, CommissionerBar, PoolPanel } from '../app/components';
import { roomFixture } from './room-fixture';
import type { Action, AuctionState } from '../lib/types';

declare global {
    interface Window { testActions: Action[]; testRequests: string[] }
}
window.testActions = [];
window.testRequests = [];
const send = async (action: Action) => { window.testActions.push(action); };
function nextLot(state: AuctionState) {
    return { ...state, lot: { ...state.lot!, id: 102, playerId: 'room-1' } };
}
function gap(state: AuctionState): AuctionState {
    return { ...state, lot: null, draft: { ...state.draft, phase: 'nomination', lotId: null } };
}
function BidCase() {
    const [state, setState] = useState(roomFixture);
    return <>
        <button id="lot-b" onClick={() => setState(nextLot(roomFixture()))}>Lot B</button>
        <button id="gap" onClick={() => setState(gap(roomFixture()))}>Nomination gap</button>
        <BlockPanel state={state} me={state.managers[0]} busy={false} connected send={send}
            clockSample={clockSample} opening={1} setOpening={() => {}} />
    </>;
}
function ConfirmCase() {
    const initial = () => {
        const state = roomFixture();
        state.sales = [{ ...state.lot!, id: 90, status: 'sold' }];
        return state;
    };
    const [state, setState] = useState(initial);
    return <>
        <button id="lot-b" onClick={() => setState(nextLot(initial()))}>Lot B</button>
        <button id="gap" onClick={() => setState(gap(initial()))}>Nomination gap</button>
        <button id="sale-b" onClick={() => setState({
            ...initial(), sales: [{ ...initial().sales[0], id: 91, playerId: 'room-1' }]
        })}>Sale B</button>
        <CommissionerBar state={state} me={state.managers[0]} busy={false} connected send={send} />
    </>;
}
function RoomCase() {
    const config = (window as unknown as { roomConfig: { url: string; token: string } }).roomConfig;
    localStorage.setItem('pancake-seat', config.token);
    return <>
        <button id="replace" onClick={() => void fetch('/fixture/replace')}>Replace pool</button>
        <button id="live" onClick={() => void fetch('/fixture/live')}>New player lot</button>
        <button id="win" onClick={() => void fetch('/fixture/win')}>Win new player</button>
        <AuctionProvider url={config.url}><Room /></AuctionProvider>
    </>;
}
function AdpCase() {
    const state = roomFixture();
    state.players = [0, 999, 699, 1.3].map((adp, index) => ({
        ...state.players[index], adp, name: `ADP ${adp}`
    }));
    return <PoolPanel state={state} me={state.managers[0]} busy={false} connected send={send} opening={1} />;
}
const mode = new URL(location.href).searchParams.get('case');
createRoot(document.getElementById('root')!).render(mode === 'room' ? <RoomCase />
    : mode === 'confirm' ? <ConfirmCase /> : mode === 'adp' ? <AdpCase /> : <BidCase />);
