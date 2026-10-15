'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
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
  const [state, setState] = useState<AuctionState | null>(null);
  const [error, setError] = useState('');
  const [connected, setConnected] = useState(true);
  const [busy, setBusy] = useState(false);
  const [offset, setOffset] = useState(0);
  const [tab, setTab] = useState<Tab>('players');
  const [opening, setOpening] = useState(1);
  const [turnSeen, setTurnSeen] = useState('');
  const players = useRef<Player[]>([]);
  const fetching = useRef<Promise<void> | null>(null);
  const pending = useRef(false);

  const fetchState = useCallback(async () => {
    if (fetching.current) return fetching.current;
    const sent = Date.now();
    const includePool = players.current.length === 0;
    const request = async () => {
      try {
        const response = await fetch(`/api/state${includePool ? '' : '?players=0'}`, { cache: 'no-store' });
        if (!response.ok) throw new Error('Connection lost');
        const next: AuctionState = await response.json();
        if (includePool) players.current = next.players;
        else next.players = players.current;
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

  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => setError(''), 5000);
    return () => clearTimeout(timer);
  }, [error]);

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
    return <main className="gate"><h1 className="wordmark">Pancake Auction</h1>
      <p>{connected ? 'Opening the draft room…' : 'Can’t reach the draft room. Retrying…'}</p></main>;
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
  const turnKey = d.status === 'running' && d.phase === 'nomination' && d.nominatorId === me.id
    ? `${d.turnIndex}-${state.recentEvents.find(event => event.type === 'turn')?.id ?? ''}` : '';
  if (turnKey && turnKey !== turnSeen) {
    setTurnSeen(turnKey);
    setTab('players');
    setOpening(1);
  }
  const props = { state, me, busy, connected, send };
  return (
    <main className="room" data-tab={tab}>
      <header className="topbar">
        <h1 className="wordmark">Pancake Auction</h1>
        <p className={`headline ${state.draft.status}`}>{headline(state, me)}</p>
        {!connected && <p className="offline" role="status">Reconnecting…</p>}
        {me.commissioner && <CommissionerBar {...props} />}
        <p className="me">{me.name}</p>
      </header>
      {error && <div className="toast" role="alert">{error}<button onClick={() => setError('')} aria-label="Dismiss">×</button></div>}
      <BlockPanel {...props} offset={offset} opening={opening} setOpening={setOpening} />
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
