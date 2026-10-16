'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useConvexConnectionState } from 'convex/react';
import { api } from '../convex/_generated/api';
import { useClockOffset } from './use-clock-offset';
import {
  BlockPanel, CommissionerBar, PoolPanel, ResultsPanel, RosterPanel, TeamsPanel, turnsUntil
} from './components';
import type { Action, AuctionState, Manager, Player } from '../lib/types';

type Tab = 'players' | 'teams' | 'roster' | 'results';
const tabs: [Tab, string][] = [['players', 'Players'], ['teams', 'Teams'], ['roster', 'My roster'], ['results', 'Results']];

function headline(state: AuctionState, me: Manager) {
  const d = state.draft;
  if (d.status === 'paused') return me.commissioner ? 'Paused' : 'Paused by the commissioner';
  if (d.status !== 'running') return '';
  const turns = turnsUntil(state, me);
  if (turns === null || turns === 0) return '';
  return turns === 1 ? 'You nominate next' : `You nominate in ${turns} turns`;
}

export default function Room() {
  const [token, setToken] = useState<string | undefined>();
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const connection = useConvexConnectionState();
  const connected = connection.isWebSocketConnected;
  const [connectionTimedOut, setConnectionTimedOut] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pendingControl, setPendingControl] = useState<'pause' | 'resume' | null>(null);
  const clock = useClockOffset(connected, connection.connectionCount);
  const [tab, setTab] = useState<Tab>('players');
  const [opening, setOpening] = useState(1);
  const [openingSubmission, setOpeningSubmission] = useState(0);
  const [turnSeen, setTurnSeen] = useState('');
  const pending = useRef(false);
  const claim = useMutation(api.auction.claimSeat);
  const restore = useMutation(api.auction.restoreSeat);
  const mutate = useMutation(api.auction.actOnDraft);
  const snapshot = useQuery(api.auction.state, ready ? { token } : 'skip');
  const pool = useQuery(api.auction.pool, snapshot ? { revision: snapshot.poolRevision } : 'skip');
  const [loadedPool, setLoadedPool] = useState<{ revision: string; players: Player[] }>();
  if (pool && pool.revision === snapshot?.poolRevision && pool !== loadedPool) setLoadedPool(pool);
  const availablePool = pool?.revision === snapshot?.poolRevision ? pool : loadedPool;
  const state: AuctionState | null = snapshot && availablePool
    ? { ...snapshot, players: availablePool.players } : null;

  useEffect(() => {
    let cancelled = false;
    async function initialize() {
      const saved = localStorage.getItem('pancake-seat') || undefined;
      if (saved) {
        try {
          const result = await restore({ token: saved });
          if (result.ok && !cancelled) setToken(saved);
          else if (!result.ok && result.status === 401) localStorage.removeItem('pancake-seat');
        } catch {
          if (!cancelled) setToken(saved);
        }
      }
      if (!cancelled) setReady(true);
    }
    void initialize();
    return () => { cancelled = true; };
  }, [restore]);

  useEffect(() => {
    const timer = setTimeout(() => setConnectionTimedOut(true), 10000);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => setError(''), 5000);
    return () => clearTimeout(timer);
  }, [error]);

  const send = useCallback(async (body: Action | { managerId: number }, endpoint = 'action') => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    if ('type' in body && (body.type === 'pause' || body.type === 'resume')) setPendingControl(body.type);
    setError('');
    if ('type' in body && body.type === 'nominate') {
      setOpening(body.amount);
      setOpeningSubmission(value => value + 1);
    }
    try {
      const result = endpoint === 'claim' && 'managerId' in body
        ? await claim({ managerId: body.managerId })
        : 'type' in body ? await mutate({ token: token || '', action: body }) : null;
      if (!result) throw new Error('Invalid action');
      if (!result.ok) throw new Error(result.error);
      if (typeof result.value === 'string') {
        localStorage.setItem('pancake-seat', result.value);
        setToken(result.value);
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Request failed');
    } finally {
      setBusy(false);
      setPendingControl(null);
      pending.current = false;
    }
  }, [claim, mutate, token]);

  if (!state) {
    return <main className="gate"><h1 className="wordmark">Pancake Auction</h1>
      <p>{!connected && (connection.hasEverConnected || connectionTimedOut)
        ? 'Can’t reach the draft room. Retrying…' : 'Opening the draft room…'}</p></main>;
  }
  const me = state.managers.find(manager => manager.id === state.me);
  if (!state.managers.length) {
    return <main className="gate"><h1 className="wordmark">Pancake Auction</h1>
      <p>The league’s managers aren’t loaded yet. The commissioner runs the league setup first.</p></main>;
  }
  if (!me) {
    return (
      <main className="gate">
        <h1 className="wordmark">Pancake Auction</h1>
        <h2>Who are you?</h2>
        <div className="seat-grid">
          {state.managers.map(manager => (
            <button key={manager.id} disabled={manager.claimed || busy}
              onClick={() => void send({ managerId: manager.id }, 'claim')}>
              <strong>{manager.name}</strong>
              <small>{manager.claimed ? 'Taken' : manager.commissioner ? 'Commissioner' : ' '}</small>
            </button>
          ))}
        </div>
        <p>This browser remembers your seat. If yours shows Taken, ask Michael.</p>
        {error && <p className="gate-error" role="alert">{error}</p>}
      </main>
    );
  }
  const d = state.draft;
  const turnKey = (d.status === 'running' || d.status === 'paused')
    && d.phase === 'nomination' && d.nominatorId === me.id
    ? `${d.turnSequence ?? 0}` : '';
  if (turnKey && turnKey !== turnSeen) {
    setTurnSeen(turnKey);
    setTab('players');
    setOpening(1);
  }
  const props = { state, me, busy, connected, send };
  return (
    <main className="room" data-tab={tab} data-clock-status={clock.status}>
      <header className="topbar">
        <h1 className="wordmark">Pancake Auction</h1>
        <p className={`headline ${state.draft.status}`}>{headline(state, me)}</p>
        {!connected && <p className="offline" id="room-connection-status" role="status">Reconnecting…</p>}
        {(clock.status === 'syncing' || clock.status === 'retrying') && (
          <p className="offline clock-status" role="status">
            {clock.status === 'retrying' ? 'Clock not synced. Retrying…' : 'Syncing clock…'}
          </p>
        )}
        {me.commissioner && <CommissionerBar {...props} pendingControl={pendingControl} />}
        <p className="me">{me.name}</p>
      </header>
      {error && <div className="toast" role="alert">{error}<button onClick={() => setError('')} aria-label="Dismiss">×</button></div>}
      <BlockPanel {...props} clockSample={clock.sample} opening={opening} setOpening={setOpening}
        openingSubmission={openingSubmission} />
      <nav className="tabbar" role="tablist">
        {tabs.map(([value, label]) => (
          <button key={value} role="tab" aria-selected={tab === value} onClick={() => setTab(value)}>{label}</button>
        ))}
      </nav>
      <PoolPanel {...props} opening={opening} />
      <TeamsPanel {...props} />
      <RosterPanel {...props} />
      <ResultsPanel {...props} />
    </main>
  );
}
