import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import Room from '../app/page';
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
            offset={0} opening={1} setOpening={() => {}} />
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
let server = roomFixture();
server.lot = null;
server.draft = { ...server.draft, status: 'setup', phase: 'nomination', nominatorId: null, deadline: null };
server.players = server.players.slice(0, 1);
const added = { ...roomFixture().players[1], id: 'review-new', name: 'Review Added Player' };
window.fetch = async url => {
    window.testRequests.push(String(url));
    const query = new URL(String(url), location.origin).searchParams;
    const state = structuredClone(server);
    if (query.get('players') === '0' || query.get('poolRevision') === state.poolRevision) state.players = [];
    return new Response(JSON.stringify(state), { status: 200 });
};
function RoomCase() {
    return <>
        <button id="replace" onClick={() => {
            server = { ...server, poolRevision: '2', players: [...server.players, added] };
        }}>Replace pool</button>
        <button id="live" onClick={() => {
            server = { ...server, draft: { ...server.draft, status: 'running', phase: 'bidding', nominatorId: 2 },
                lot: { id: 102, playerId: added.id, player: added, nominatorId: 2,
                    highBidderId: 2, highBid: 1, status: 'open' } };
        }}>New player lot</button>
        <button id="win" onClick={() => {
            server = { ...server, lot: null, draft: { ...server.draft, phase: 'nomination' },
                roster: [{ playerId: added.id, managerId: 1, placement: 'active', price: 1, lotId: 102 }] };
        }}>Win new player</button>
        <Room />
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
