'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AuctionPanel, dollars, HistoryPanel, PoolPanel, RosterPanel, TeamsPanel } from './components';
import type { Action, AuctionState, Player } from '../lib/types';

export default function Room() {
  const [state, setState] = useState<AuctionState | null>(null);
  const [error, setError] = useState('');
  const [connected, setConnected] = useState(true);
  const [busy, setBusy] = useState(false);
  const [offset, setOffset] = useState(0);
  const latest = useRef<AuctionState | null>(null);
  const players = useRef<Player[]>([]);
  const fetching = useRef<Promise<void> | null>(null);
  const pending = useRef(false);

  const fetchState = useCallback(async () => {
    if (fetching.current) return fetching.current;
    const sent = Date.now();
    const includePool = !latest.current || latest.current.draft.status === 'setup';
    const request = async () => {
      try {
        const response = await fetch(`/api/state${includePool ? '' : '?players=0'}`, { cache: 'no-store' });
        if (!response.ok) throw new Error('Connection lost');
        const next: AuctionState = await response.json();
        if (includePool) players.current = next.players;
        else next.players = players.current;
        latest.current = next;
        setOffset(next.serverNow - (sent + Date.now()) / 2);
        setState(next);
        setConnected(true);
      } catch {
        setConnected(false);
      } finally {
        fetching.current = null;
      }
    };
    fetching.current = request();
    return fetching.current;
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function initialize() {
      const token = localStorage.getItem('pancake-seat');
      if (token) {
        try {
          const response = await fetch('/api/restore', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token })
          });
          if (response.status === 401) localStorage.removeItem('pancake-seat');
        } catch {}
      }
      if (!cancelled) await fetchState();
    }
    void initialize();
    const poll = setInterval(() => void fetchState(), 500);
    return () => { cancelled = true; clearInterval(poll); };
  }, [fetchState]);

  async function send(body: Action | { managerId: number }, endpoint = 'action') {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      const response = await fetch(`/api/${endpoint}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      if (result.token) localStorage.setItem('pancake-seat', result.token);
      if (fetching.current) await fetching.current;
      await fetchState();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Request failed');
      await fetchState();
    } finally {
      setBusy(false);
      pending.current = false;
    }
  }

  if (!state) {
    return <main className="landing"><h1>Pancake Auction</h1>
      <p>{connected ? 'Opening the room…' : 'Connection lost. Reconnecting…'}</p></main>;
  }
  const me = state.managers.find(manager => manager.id === state.me);
  const statusText = connected ? state.draft.status === 'running' ? 'Live' : state.draft.status : 'Reconnecting';
  return (
    <main className="room">
      <header>
        <div><h1>Pancake <span>Auction</span></h1><small>NBA DYNASTY · $1,000 · 20 ACTIVE + 3 TAXI + 2 IR</small></div>
        <div className="header-state"><span className={connected ? 'connection' : 'connection offline'}>{statusText}</span>
          {me && <strong>{me.name} · {dollars(me.budget)}</strong>}
        </div>
      </header>
      {error && <div className="error" role="alert">{error}
        <button onClick={() => setError('')} aria-label="Dismiss error">×</button></div>}
      {!state.managers.length ? (
        <div className="empty"><h2>League managers are not configured</h2>
          <p>Load the ten manager names before opening the draft.</p></div>
      ) : !me ? (
        <div className="landing seats"><h2>Pick your name</h2>
          <p>Your seat stays yours when you refresh or reconnect.</p>
          <div className="seat-grid">
            {state.managers.map(manager => (
              <button key={manager.id} disabled={manager.claimed || busy}
                onClick={() => void send({ managerId: manager.id }, 'claim')}>
                <strong>{manager.name}</strong>
                <small>{manager.claimed ? 'Seat claimed' : manager.commissioner ? 'Commissioner' : 'Take this seat'}</small>
              </button>
            ))}
          </div><p>Claimed seats require the commissioner to release them.</p>
        </div>
      ) : (
        <div className="panels">
          <PoolPanel state={state} me={me} busy={busy} connected={connected} send={send} />
          <div className="center">
            <AuctionPanel state={state} me={me} busy={busy} connected={connected} send={send} offset={offset} />
            <TeamsPanel state={state} me={me} busy={busy} connected={connected} send={send} />
            <HistoryPanel state={state} me={me} busy={busy} connected={connected} send={send} />
          </div>
          <RosterPanel state={state} me={me} busy={busy} connected={connected} send={send} />
        </div>
      )}
    </main>
  );
}
