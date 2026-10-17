'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useConvexConnectionState } from 'convex/react';
import { api } from '../convex/_generated/api';
import {
  BlockPanel, CommissionerBar, dollars, PoolPanel, QueuePanel, ResultsPanel, RosterPanel, TeamsPanel, turnsUntil
} from './components';
import { counts } from '../lib/rules';
import type { Action, AuctionState, Manager, Player, PrivateState, QueueAction } from '../lib/types';

type Tab = 'players' | 'queue' | 'teams' | 'roster' | 'results';
const tabs: [Tab, string][] = [['players', 'Players'], ['queue', 'Queue'], ['teams', 'Teams'], ['roster', 'My roster'],
  ['results', 'Results']];

function headline(state: AuctionState, me: Manager, privateSeat: PrivateState | null | undefined) {
  const d = state.draft;
  if (d.status === 'paused') return me.commissioner ? 'Paused' : 'Paused by the commissioner';
  if (d.status === 'complete') return 'Draft complete';
  if (d.status !== 'running') return '';
  if (state.lot && privateSeat?.lotId === state.lot.id) {
    return privateSeat.response ? 'Response sent · sealed' : 'Your sealed bid is open';
  }
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
  const [tab, setTab] = useState<Tab>('players');
  const [opening, setOpening] = useState<number | undefined>();
  const [turnSeen, setTurnSeen] = useState('');
  const pending = useRef(false);
  const claim = useMutation(api.auction.claimSeat);
  const restore = useMutation(api.auction.restoreSeat);
  const mutate = useMutation(api.auction.actOnDraft);
  const queueMutation = useMutation(api.auction.editQueue);
  const privateSeat = useQuery(api.auction.privateSeat, token ? { token } : 'skip');
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
  if (d.mode !== 'sealed-v1' && d.status !== 'setup') return <main className="gate"><h1 className="wordmark">Pancake Auction</h1>
    <p>Legacy draft is read-only. Commissioner migration is required.</p></main>;
  const turnKey = (d.status === 'running' || d.status === 'paused')
    && d.phase === 'nomination' && d.nominatorId === me.id
    ? `${d.turnSequence ?? 0}` : '';
  if (turnKey && turnKey !== turnSeen) {
    setTurnSeen(turnKey);
    setTab('players');
    setOpening(undefined);
  }
  const editQueue = async (action: QueueAction) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    try {
      const result = await queueMutation({ token: token || '', action });
      if (!result.ok) throw new Error(result.error);
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Queue update failed'); }
    finally { setBusy(false); pending.current = false; }
  };
  const props = { state, me, busy, connected, send, privateSeat, editQueue };
  const mine = counts(state.roster.filter(entry => entry.managerId === me.id));
  const queued = privateSeat?.queue.length ?? 0;
  return (
    <main className="room" data-tab={tab}>
      <header className="topbar">
        <h1 className="wordmark">Pancake Auction</h1>
        <p className={`headline ${state.draft.status}`}>{headline(state, me, privateSeat)}</p>
        {!connected && <p className="offline" id="room-connection-status" role="status">Reconnecting…</p>}
        {me.commissioner && <CommissionerBar {...props} pendingControl={pendingControl} />}
        <div className="me-box">
          <p className="me" title={me.name}>{me.name}</p>
          <p className="me-budget">{dollars(me.budget)} left · {mine.active}/20</p>
        </div>
      </header>
      {error && <div className="toast" role="alert">{error}<button onClick={() => setError('')} aria-label="Dismiss">×</button></div>}
      <BlockPanel {...props} opening={opening} setOpening={setOpening} />
      <nav className="tabbar" role="tablist">
        {tabs.map(([value, label]) => (
          <button key={value} role="tab" className={`tab-${value}`} aria-selected={tab === value} onClick={() => setTab(value)}
            aria-label={value === 'queue' ? `Queue, ${queued} queued` : undefined}>
            {label}{value === 'queue' && queued > 0 && <span className="badge" aria-hidden="true">{queued}</span>}
          </button>
        ))}
      </nav>
      <QueuePanel {...props} />
      <PoolPanel {...props} opening={opening} />
      <TeamsPanel {...props} />
      <RosterPanel {...props} />
      <ResultsPanel {...props} />
    </main>
  );
}
