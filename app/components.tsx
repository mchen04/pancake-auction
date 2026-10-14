'use client';
import { useEffect, useState } from 'react';
import { counts, legalPlacements, matching, maxBid, slots, taxiEligibility } from '../lib/rules';
import type { Action, AuctionState, Draft, Entry, Manager, Placement, Player, RecentEvent } from '../lib/types';

export const dollars = (amount: number) => `$${amount}`;
export interface RoomProps {
  state: AuctionState;
  me: Manager;
  busy: boolean;
  connected: boolean;
  send: (action: Action) => Promise<void>;
}
export function careerLabel(player: Player) {
  if (player.careerGames === null) return 'unknown';
  return player.careerGamesComplete ? String(player.careerGames) : `≥ ${player.careerGames}`;
}
export function projectionLabel(player: Player) {
  return player.projection === null ? 'no projection' : `${player.projection.toFixed(1)} FPPG`;
}
export function Badges({ player }: { player: Player }) {
  const taxi = taxiEligibility(player);
  return (
    <span className="badges">
      {player.yearsExp === 0 && <b>Rookie</b>}
      {player.yearsExp !== 0 && taxi === 'eligible' && <b>&lt;65 GP</b>}
      {taxi === 'unknown' && <b className="muted">Unknown GP</b>}
      {player.injuryStatus === 'Out' && <b className="out">Out</b>}
    </span>
  );
}
export function PlayerInfo({ player }: { player: Player }) {
  return (
    <div className="player-summary">
      <small>
        {player.positions.join('/')} · {player.team || 'team unknown'} ·{' '}
        {player.age === null ? 'age unknown' : `age ${player.age}`}
      </small>
      <small>
        Injury: {player.injuryStatus || 'unknown'} · Career GP: {careerLabel(player)}
      </small>
      <small>{projectionLabel(player)}</small>
      <Badges player={player} />
    </div>
  );
}
function taxiReason(player: Player) {
  if (player.yearsExp === 0) return 'Eligible: stored experience marks a rookie.';
  if (taxiEligibility(player) === 'eligible') return 'Eligible: complete career total is below 65.';
  if (taxiEligibility(player) === 'unknown') return 'Ineligible: the career total is unknown or incomplete.';
  return 'Ineligible: career games are at least 65.';
}
export function PlayerDetails({ player }: { player: Player }) {
  return (
    <details className="player-details">
      <summary>Player details</summary>
      <p>Dynasty ADP: {player.adp === null ? 'unknown' : player.adp}</p>
      <p>Career coverage: {player.careerGamesComplete ? 'complete, 2013–2025' : 'incomplete, 2013–2025'}</p>
      <p>Taxi: {taxiReason(player)}</p>
      <p>IR: {player.injuryStatus === 'Out' ? 'Eligible: status is exactly Out.' : 'Ineligible: status must be Out.'}</p>
      {player.projectedStats ? (
        <dl className="stat-line">
          {Object.entries(player.projectedStats).map(([stat, value]) => (
            <div key={stat}><dt>{stat}</dt><dd>{value}</dd></div>
          ))}
        </dl>
      ) : <p>No projected per-game stat line.</p>}
    </details>
  );
}
export function Countdown({ draft, offset }: { draft: Draft; offset: number }) {
  const [clock, setClock] = useState(0);
  useEffect(() => {
    setClock(Date.now());
    const tick = setInterval(() => setClock(Date.now()), 100);
    return () => clearInterval(tick);
  }, []);
  const remaining = draft.status === 'paused'
    ? draft.remainingMs || 0
    : Math.max(0, (draft.deadline || 0) - clock - offset);
  const hidden = draft.status === 'setup' || draft.status === 'complete';
  const urgent = remaining < 3000 && draft.status === 'running';
  return (
    <div className={`countdown ${urgent ? 'urgent' : ''}`}>
      {hidden ? '—' : (remaining / 1000).toFixed(1)}
      <small>{draft.status === 'paused' ? 'clock frozen' : 'seconds'}</small>
    </div>
  );
}
function nominationReason(props: RoomProps, player: Player, opening: number) {
  const { state, me, busy, connected } = props;
  const entries = state.roster.filter(entry => entry.managerId === me.id);
  const maximum = maxBid(me.budget, player, entries, state.players);
  if (busy || !connected || state.draft.status !== 'running') return 'Draft is not ready for this action';
  if (state.draft.phase !== 'nomination' || state.draft.nominatorId !== me.id) {
    return 'Wait for your nomination turn';
  }
  if (maximum < 1) return 'No legal placement or budget';
  if (!Number.isInteger(opening) || opening < 1 || opening > maximum) {
    return `Opening bid must be $1–$${maximum}`;
  }
  return '';
}
export function PoolPanel(props: RoomProps) {
  const { state, send } = props;
  const [search, setSearch] = useState('');
  const [position, setPosition] = useState('');
  const [sort, setSort] = useState('projection');
  const [opening, setOpening] = useState(1);
  const [limit, setLimit] = useState(100);
  const sold = new Set(state.roster.map(entry => entry.playerId));
  const pool = state.players.filter(player => {
    const matchesName = player.name.toLowerCase().includes(search.toLowerCase());
    const matchesPosition = !position || player.positions.includes(position as Player['positions'][number]);
    return !sold.has(player.id) && matchesName && matchesPosition;
  });
  pool.sort((a, b) => {
    if (sort === 'name') return a.name.localeCompare(b.name);
    if (sort === 'adp') return (a.adp ?? Infinity) - (b.adp ?? Infinity);
    return (b.projection ?? -Infinity) - (a.projection ?? -Infinity);
  });
  return (
    <section className="panel pool">
      <div className="panel-heading"><h2>Player pool</h2><span>{pool.length} available</span></div>
      <div className="filters">
        <input aria-label="Search players" placeholder="Search players" value={search}
          onChange={event => { setSearch(event.target.value); setLimit(100); }} />
        <div>
          <select aria-label="Position filter" value={position} onChange={event => setPosition(event.target.value)}>
            <option value="">All positions</option>
            {['PG', 'SG', 'SF', 'PF', 'C'].map(p => <option key={p}>{p}</option>)}
          </select>
          <select aria-label="Sort players" value={sort} onChange={event => setSort(event.target.value)}>
            <option value="projection">Projection ↓</option><option value="adp">Dynasty ADP ↑</option>
            <option value="name">Name A–Z</option>
          </select>
        </div>
        <label>Opening bid
          <input aria-label="Opening bid" type="number" min="1" step="1" value={opening}
            onChange={event => setOpening(Number(event.target.value))} />
        </label>
      </div>
      <div className="scroll">
        {pool.slice(0, limit).map(player => {
          const reason = nominationReason(props, player, opening);
          return (
            <div className="player-row" key={player.id}>
              <div className="player-info">
                <strong>{player.name}</strong><PlayerInfo player={player} /><PlayerDetails player={player} />
              </div>
              <button title={reason || `Nominate ${player.name}`} disabled={!!reason}
                onClick={() => void send({ type: 'nominate', playerId: player.id, amount: opening })}>
                Nominate
              </button>
            </div>
          );
        })}
        {pool.length > limit && <button onClick={() => setLimit(limit + 100)}>Show 100 more players</button>}
      </div>
    </section>
  );
}
function bidReason(props: RoomProps, player: Player | undefined, highBid: number, passed: boolean) {
  const { state, me, busy, connected } = props;
  if (state.draft.status === 'paused') return 'Draft paused';
  if (busy || !connected || state.draft.status !== 'running') return 'Draft is not ready for this action';
  if (passed) return 'You gave up on this lot';
  const entries = state.roster.filter(entry => entry.managerId === me.id);
  if (!player || maxBid(me.budget, player, entries, state.players) <= highBid) return 'No legal higher bid';
  return '';
}
function CommissionerControls({ state, me, busy, send }: RoomProps) {
  if (!me.commissioner) return null;
  const d = state.draft;
  return (
    <div className="commissioner">
      <strong>Commissioner</strong>
      <div>
        {d.status === 'setup' ? (
          <button disabled={busy} onClick={() => void send({ type: 'start' })}>Start draft</button>
        ) : (
          <>
            <button disabled={busy || d.status === 'complete'}
              onClick={() => void send({ type: d.status === 'paused' ? 'resume' : 'pause' })}>
              {d.status === 'paused' ? 'Resume' : 'Pause'}
            </button>
            <button disabled={busy || !state.sales.length} onClick={() => void send({ type: 'undo' })}>
              Undo last sale
            </button>
            <button disabled={busy || !state.lot}
              onClick={() => state.lot && void send({ type: 'force', lotId: state.lot.id })}>
              Force end
            </button>
          </>
        )}
      </div>
    </div>
  );
}
function nominationText(state: AuctionState, me: Manager) {
  const d = state.draft;
  if (d.status === 'complete') {
    return d.completionReason === 'full-cycle-passed'
      ? 'Draft complete: every eligible manager passes a full cycle without a nomination.'
      : 'Draft complete: no manager has a remaining nomination.';
  }
  if (d.status === 'setup') return 'The commissioner starts the draft.';
  const entries = state.roster.filter(entry => entry.managerId === d.nominatorId);
  if (counts(entries).active === 20) return 'Taxi/IR nomination. Timeout passes this turn and keeps future turns open.';
  return d.nominatorId === me.id ? 'Choose a player and click Nominate.' : 'Timeout nominates the top legal player.';
}
export function AuctionPanel(props: RoomProps & { offset: number }) {
  const { state, me, send, busy, offset } = props;
  const [custom, setCustom] = useState(1);
  const { draft: d, lot } = state;
  const player = state.players.find(p => p.id === lot?.playerId);
  const entries = state.roster.filter(entry => entry.managerId === me.id);
  const myCounts = counts(entries);
  const maximum = player ? maxBid(me.budget, player, entries, state.players) : 0;
  const passed = state.passes.includes(me.id);
  const reason = bidReason(props, player, lot?.highBid || 0, passed);
  const nominator = state.managers.find(manager => manager.id === d.nominatorId);
  const highBidder = state.managers.find(manager => manager.id === lot?.highBidderId);
  const canPass = d.status === 'running' && !busy && !passed && me.id !== lot?.highBidderId;
  return (
    <section className="panel auction">
      <div className="panel-heading">
        <h2>{d.phase === 'bidding' ? 'On the block' : 'Nomination'}</h2><span>{nominator?.name || 'Waiting'}</span>
      </div>
      <Countdown draft={d} offset={offset} />
      {lot && player ? (
        <>
          <h2 className="player-name">{player.name}</h2>
          <PlayerInfo player={player} /><PlayerDetails player={player} />
          <div className="high-bid"><strong>{dollars(lot.highBid)}</strong><span>{highBidder?.name} leads</span></div>
          <div className="bid-buttons">
            {[1, 5].map(increment => (
              <button key={increment} disabled={!!reason || maximum < lot.highBid + increment} title={reason}
                onClick={() => void send({ type: 'bid', lotId: lot.id, amount: lot.highBid + increment })}>
                + ${increment}
              </button>
            ))}
            <button disabled={!!reason} title={reason}
              onClick={() => void send({ type: 'bid', lotId: lot.id, amount: maximum })}>Max {dollars(maximum)}</button>
          </div>
          <div className="custom-bid">
            <input aria-label="Custom bid" type="number" min={lot.highBid + 1} max={maximum} step="1"
              value={custom} onChange={event => setCustom(Number(event.target.value))} />
            <button disabled={!!reason || !Number.isInteger(custom) || custom <= lot.highBid || custom > maximum}
              onClick={() => void send({ type: 'bid', lotId: lot.id, amount: custom })}>Bid</button>
            <button className="quiet" disabled={!canPass}
              title={passed ? 'No re-entry after giving up' : 'The high bidder cannot give up'}
              onClick={() => void send({ type: 'pass', lotId: lot.id })}>{passed ? 'Given up' : 'Give up'}</button>
          </div>
          <small className="reason">{reason || `Your legal maximum is ${dollars(maximum)}`}</small>
        </>
      ) : (
        <div className="nomination-copy">
          <h2>{d.status === 'complete' ? 'Draft complete' : `${nominator?.name || 'Next manager'} nominates`}</h2>
          <p>{nominationText(state, me)}</p>
        </div>
      )}
      {(me.done || myCounts.active === 20 && (myCounts.taxi < 3 || myCounts.ir < 2))
        && d.status === 'running' && (
        <button className="quiet" disabled={busy} onClick={() => void send({ type: 'done', done: !me.done })}>
          {me.done ? 'Resume my nominations' : 'Done nominating — keep bidding'}
        </button>
      )}
      <CommissionerControls {...props} />
    </section>
  );
}
export function TeamsPanel({ state, me, busy, send }: RoomProps) {
  const current = state.players.find(player => player.id === state.lot?.playerId);
  return (
    <section className="panel teams">
      <div className="panel-heading"><h2>Teams</h2><span>Budget · Max · Open A/T/IR</span></div>
      <div className="scroll">
        {state.managers.map(manager => {
          const entries = state.roster.filter(entry => entry.managerId === manager.id);
          const c = counts(entries);
          const maximum = current ? maxBid(manager.budget, current, entries, state.players)
            : Math.max(0, manager.budget - Math.max(0, 19 - c.active));
          let label = manager.claimed ? 'Seat claimed' : 'Seat open';
          if (manager.done) label = 'Done nominating';
          if (manager.id === state.draft.nominatorId) label = 'Nominating now';
          if (current && maximum <= (state.lot?.highBid || 0)) label = 'Cannot raise';
          if (state.passes.includes(manager.id)) label = 'Given up';
          if (manager.id === state.lot?.highBidderId) label = 'High bidder';
          return (
            <div className={`team-row ${manager.id === state.draft.nominatorId ? 'nominating' : ''}`} key={manager.id}>
              <div><strong>{manager.name}</strong><small>{label}</small></div>
              <span>{dollars(manager.budget)}<small>max {dollars(maximum)}</small></span>
              <span>{20 - c.active}/{3 - c.taxi}/{2 - c.ir}</span>
              {me.commissioner && manager.claimed && (
                <button title={`Release ${manager.name}'s seat`} disabled={busy}
                  onClick={() => void send({ type: 'release', managerId: manager.id })}>Release</button>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
function moveAllowed(props: RoomProps, entry: Entry, placement: Placement) {
  const { state, me } = props;
  const player = state.players.find(p => p.id === entry.playerId)!;
  const rest = state.roster.filter(e => e.managerId === me.id && e.playerId !== entry.playerId);
  if (!legalPlacements(player, rest, state.players).includes(placement)) return false;
  const changed = [...rest, { ...entry, placement }];
  if (me.budget < 20 - counts(changed).active) return false;
  if (state.lot?.highBidderId === me.id) {
    const standing = state.players.find(p => p.id === state.lot!.playerId)!;
    if (maxBid(me.budget, standing, changed, state.players) < state.lot.highBid) return false;
  }
  return true;
}
function RosterRow(props: RoomProps & { entry: Entry; slot?: string }) {
  const { state, entry, slot, busy, send } = props;
  const player = state.players.find(p => p.id === entry.playerId)!;
  return (
    <div className="roster-row">
      <div><small>{slot || entry.placement} · {dollars(entry.price)}</small>
        <strong>{player.name}</strong><Badges player={player} />
      </div>
      <select aria-label={`Placement for ${player.name}`} value={entry.placement}
        disabled={busy || state.draft.status === 'complete'}
        onChange={event => void send({ type: 'place', playerId: player.id, placement: event.target.value as Placement })}>
        {(['active', 'taxi', 'ir'] as Placement[]).map(placement => (
          <option key={placement} value={placement} disabled={!moveAllowed(props, entry, placement)}>
            {placement === 'ir' ? 'IR' : placement === 'taxi' ? 'Taxi' : 'Active'}
          </option>
        ))}
      </select>
    </div>
  );
}
export function RosterPanel(props: RoomProps) {
  const { state, me } = props;
  const entries = state.roster.filter(entry => entry.managerId === me.id);
  const active = entries.filter(entry => entry.placement === 'active');
  const c = counts(entries);
  const assignment = matching(active.map(entry => state.players.find(p => p.id === entry.playerId)!)) || [];
  const starterSlots = assignment.length ? assignment.slice(0, 10) : Array<number>(10).fill(-1);
  const bench = assignment.slice(10).filter(index => index >= 0);
  return (
    <section className="panel roster">
      <div className="panel-heading"><h2>My roster</h2><span>{c.active}/20 · {dollars(me.budget)}</span></div>
      <div className="scroll">
        <h3>Starters</h3>
        {starterSlots.map((index, slot) => index >= 0 ? (
          <RosterRow {...props} key={active[index].playerId} entry={active[index]} slot={slots[slot]} />
        ) : <div className="empty-slot" key={slot}>{slots[slot]}<span>Open</span></div>)}
        <h3>Bench · {bench.length}/10</h3>
        {bench.map(index => <RosterRow {...props} key={active[index].playerId} entry={active[index]} slot="BENCH" />)}
        <h3>Taxi · {c.taxi}/3</h3>
        {entries.filter(e => e.placement === 'taxi').map(entry => (
          <RosterRow {...props} key={entry.playerId} entry={entry} />
        ))}
        <h3>IR · {c.ir}/2</h3>
        {entries.filter(e => e.placement === 'ir').map(entry => <RosterRow {...props} key={entry.playerId} entry={entry} />)}
      </div>
    </section>
  );
}
function eventLabel(event: RecentEvent, state: AuctionState) {
  const name = state.managers.find(manager => manager.id === event.managerId)?.name || 'Commissioner';
  if (event.type === 'nomination-pass') return `${name} passes the nomination turn on timeout`;
  if (event.type === 'done') return `${name} ${event.data.done ? 'stops' : 'resumes'} nominations`;
  if (event.type === 'complete') return event.data.reason === 'full-cycle-passed'
    ? 'Draft ends: a full cycle passes without a nomination' : 'Draft ends: no eligible nominations remain';
  if (event.type === 'sale') return `${name} wins for $${event.data.price} (${event.data.reason})`;
  if (event.type === 'bid') return `${name} bids $${event.data.amount}`;
  if (event.type === 'pass') return `${name} gives up on the lot`;
  if (event.type === 'nomination') return `${name} nominates${event.data.auto ? ' on timeout' : ''}`;
  if (event.type === 'undo') return 'Commissioner undoes the last sale and pauses';
  if (event.type === 'placement') return `${name} moves a player to ${event.data.to}`;
  return `${name}: ${event.type}`;
}
export function HistoryPanel({ state }: RoomProps) {
  return (
    <section className="panel sales">
      <div className="panel-heading"><h2>Sales and events</h2><span>{state.roster.length} drafted</span></div>
      <div className="scroll">
        {state.sales.map(sale => (
          <div className="sale-row" key={`sale-${sale.id}`}>
            <strong>{state.players.find(player => player.id === sale.playerId)?.name}</strong>
            <span>{state.managers.find(manager => manager.id === sale.highBidderId)?.name}</span>
            <b>{dollars(sale.highBid)}</b>
          </div>
        ))}
        {state.recentEvents.filter(event => !['claim', 'turn'].includes(event.type)).map(event => (
          <div className="event-row" key={event.id}>{eventLabel(event, state)}</div>
        ))}
      </div>
    </section>
  );
}
