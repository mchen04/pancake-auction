'use client';
import { Fragment, useEffect, useState } from 'react';
import {
  canNominate, counts, legalPlacements, matching, maxBid, rankedDynastyAdp, slots, taxiEligibility, timeoutNominee
} from '../lib/rules';
import type { Action, AuctionState, Draft, Entry, Manager, Placement, Player, RecentEvent } from '../lib/types';

export const dollars = (amount: number) => `$${amount}`;
export interface RoomProps {
  state: AuctionState;
  me: Manager;
  busy: boolean;
  connected: boolean;
  send: (action: Action) => Promise<void>;
}

const placementLabels: Record<Placement, string> = { active: 'Active', taxi: 'Taxi', ir: 'IR' };
const statLabels: [string, string[]][] = [
  ['PTS', ['pts']], ['REB', ['reb']], ['AST', ['ast']], ['STL', ['stl']], ['BLK', ['blk']],
  ['3PM', ['tpm', 'fg3m']], ['FGM', ['fgm']], ['FGA', ['fga']], ['FTM', ['ftm']], ['FTA', ['fta']], ['TO', ['to', 'tov']]
];

function findPlayer(state: AuctionState, id: string | undefined) {
  return state.players.find(player => player.id === id)
    ?? (state.lot?.playerId === id ? state.lot?.player : undefined);
}
function entriesOf(state: AuctionState, managerId: number | null) {
  return state.roster.filter(entry => entry.managerId === managerId);
}
function nameOf(state: AuctionState, managerId: number | null | undefined) {
  return state.managers.find(manager => manager.id === managerId)?.name ?? 'Unknown';
}
function timeoutText(state: AuctionState, manager: Manager | undefined) {
  if (manager && onlyReserveOpen(entriesOf(state, manager.id))) return 'Time out: the turn passes.';
  const pick = timeoutNominee(state, manager);
  return pick ? `Time out: ${pick.name} opens at $1.` : 'Time out: the turn passes.';
}
function upcomingNominators(state: AuctionState) {
  const { order, turnIndex } = state.draft;
  return Array.from({ length: order.length - 1 }, (_, step) => order[(turnIndex + step + 1) % order.length])
    .filter(id => canNominate(state, state.managers.find(candidate => candidate.id === id)));
}
function onlyReserveOpen(entries: Entry[]) {
  const c = counts(entries);
  return c.active === 20 && (c.taxi < 3 || c.ir < 2);
}

const courtOrder = ['PG', 'SG', 'SF', 'PF', 'C', 'G', 'F'];
export function positionsLabel(player: Player) {
  return [...player.positions].sort((a, b) => courtOrder.indexOf(a) - courtOrder.indexOf(b)).join('/');
}
export function careerLabel(player: Player) {
  if (player.careerGames === null) return 'unknown';
  return player.careerGamesComplete ? String(player.careerGames) : `≥${player.careerGames}`;
}
function ageLabel(player: Player) {
  return player.age === null ? 'unknown' : String(player.age);
}
function Cell({ value, unknown, className = '', title }: {
  value: string; unknown: string | null; className?: string; title?: string;
}) {
  return unknown ? <span className="muted" title={unknown}>?</span> : <span className={className} title={title}>{value}</span>;
}
function projectionLabel(player: Player) {
  return player.projection === null ? 'none' : player.projection.toFixed(1);
}

function DynastyAdp({ value }: { value: number | null }) {
  const rank = rankedDynastyAdp(value);
  return <Cell value={rank?.toFixed(1) ?? ''} className="muted"
    unknown={rank === null ? 'Unranked by Sleeper' : null} />;
}

function InjuryTag({ status }: { status: string | null }) {
  if (!status) return null;
  return <span className={`tag injury ${status === 'Out' || status === 'IR' ? 'severe' : ''}`}>{status}</span>;
}
function EligibilityTags({ player }: { player: Player }) {
  const taxi = taxiEligibility(player);
  return (
    <>
      {player.yearsExp === 0 && <span className="tag taxi" title="Rookie: taxi eligible">Rookie</span>}
      {player.yearsExp !== 0 && taxi === 'eligible' && (
        <span className="tag taxi" title="Under 65 career games: taxi eligible">&lt;65 GP</span>
      )}
    </>
  );
}

function taxiReason(player: Player) {
  const taxi = taxiEligibility(player);
  if (player.yearsExp === 0) return 'Yes, rookie';
  if (taxi === 'eligible') return 'Yes, under 65 career games';
  if (taxi === 'ineligible') return 'No, 65 or more career games';
  return 'No, career games are not fully known';
}
function careerDetail(player: Player) {
  if (player.careerGames === null) return 'Unknown: Sleeper has no season data for him';
  if (player.careerGamesComplete) return null;
  return 'Counted from 2013–14 only, so the total is a minimum';
}
function statValue(stats: Record<string, number>, keys: string[]) {
  const key = keys.find(candidate => stats[candidate] !== undefined);
  return key === undefined ? null : stats[key];
}

export function PlayerDetails({ player }: { player: Player }) {
  const stats = player.projectedStats;
  return (
    <div className="details">
      {stats ? (
        <>
        <p className="details-label">Projected per game, 2026–27 season</p>
        <dl className="stat-line">
          {statLabels.map(([label, keys]) => {
            const value = statValue(stats, keys);
            return value === null ? null : (
              <div key={label}><dt>{label}</dt><dd>{value.toFixed(1)}</dd></div>
            );
          })}
        </dl>
        </>
      ) : <p className="muted">No 2026–27 projection from Sleeper.</p>}
      <dl className="facts">
        <dt>Taxi</dt><dd>{taxiReason(player)}</dd>
        <dt>IR</dt><dd>{player.injuryStatus === 'Out' ? 'Yes, listed Out' : 'No, not listed Out'}</dd>
        {careerDetail(player) && <><dt>Career games</dt><dd>{careerDetail(player)}</dd></>}
        <dt>NBA seasons</dt><dd>{player.yearsExp === null ? 'unknown' : player.yearsExp}</dd>
        <dt className="phone-only">Dynasty ADP</dt>
        <dd className="phone-only"><DynastyAdp value={player.adp} /></dd>
      </dl>
    </div>
  );
}

export function PlayerLine({ player }: { player: Player }) {
  return (
    <div className="player-line">
      <span>{positionsLabel(player)}</span>
      <span>{player.team ?? 'No team'}</span>
      <span>Age {ageLabel(player)}</span>
      <span>{careerLabel(player)} GP</span>
      <span>Proj {projectionLabel(player)}</span>
      <InjuryTag status={player.injuryStatus} />
      <EligibilityTags player={player} />
    </div>
  );
}

function remainingMs(draft: Draft, clock: number, offset: number) {
  if (draft.status === 'paused') return draft.remainingMs ?? 0;
  if (draft.status !== 'running' || draft.deadline === null) return null;
  return Math.max(0, draft.deadline - clock - offset);
}
export function ShotClock({ draft, offset, compact = false }: { draft: Draft; offset: number; compact?: boolean }) {
  const [clock, setClock] = useState(0);
  useEffect(() => {
    setClock(Date.now());
    const tick = setInterval(() => setClock(Date.now()), 100);
    return () => clearInterval(tick);
  }, []);
  const remaining = remainingMs(draft, clock, offset);
  const total = draft.phase === 'bidding' ? draft.capMs : draft.nominationMs;
  const urgent = remaining !== null && remaining < 4000 && draft.status === 'running';
  const digits = remaining === null ? '--' : remaining >= 10000
    ? String(Math.ceil(remaining / 1000)) : (remaining / 1000).toFixed(1);
  if (draft.status === 'setup' || draft.status === 'complete') return null;
  const caption = draft.status === 'paused' ? 'Paused' : draft.phase === 'bidding' ? 'Bid clock' : 'Nomination';
  return (
    <div className={['shot-clock', compact ? 'compact' : '', urgent ? 'urgent' : '',
      draft.status === 'paused' ? 'frozen' : ''].join(' ')}
      role="timer" aria-label={`${caption}: ${digits} seconds`}>
      <span className="digits">{digits}</span>
      <span className="caption">{caption}</span>
      <span className="drain" style={{ width: `${remaining === null ? 0 : Math.min(100, remaining / total * 100)}%` }} />
    </div>
  );
}

function nominationBlocker(props: RoomProps, player: Player, opening: number) {
  const { state, me } = props;
  const maximum = maxBid(me.budget, player, entriesOf(state, me.id), state.players);
  if (maximum < 1) return 'No spot';
  if (opening > maximum) return `Max ${dollars(maximum)}`;
  return '';
}
function myNominationTurn(state: AuctionState, me: Manager) {
  const d = state.draft;
  return d.status === 'running' && d.phase === 'nomination' && d.nominatorId === me.id;
}

export function PoolPanel(props: RoomProps & { opening: number }) {
  const { state, me, send, opening } = props;
  const [search, setSearch] = useState('');
  const [position, setPosition] = useState('');
  const [sort, setSort] = useState('projection');
  const [limit, setLimit] = useState(150);
  const [open, setOpen] = useState<string | null>(null);
  const sold = new Set(state.roster.map(entry => entry.playerId));
  const query = search.trim().toLowerCase();
  const pool = state.players.filter(player => !sold.has(player.id)
    && (!query || player.name.toLowerCase().includes(query) || (player.team ?? '').toLowerCase() === query)
    && (!position || (position === 'TAXI' ? taxiEligibility(player) === 'eligible'
      : position === 'OUT' ? player.injuryStatus === 'Out'
        : player.positions.includes(position as Player['positions'][number]))));
  pool.sort((a, b) => {
    if (sort === 'age') return (a.age ?? Infinity) - (b.age ?? Infinity);
    if (sort === 'adp') return (rankedDynastyAdp(a.adp) ?? Infinity) - (rankedDynastyAdp(b.adp) ?? Infinity);
    return (b.projection ?? -Infinity) - (a.projection ?? -Infinity);
  });
  const nominating = myNominationTurn(state, me);
  const lotPlayer = state.lot?.playerId;
  return (
    <section className="panel pool" aria-label="Players">
      <div className="pool-filters">
        <input type="search" aria-label="Search players or team" placeholder="Search name or team"
          value={search} onChange={event => { setSearch(event.target.value); setLimit(150); }} />
        <select className="position-select" aria-label="Filter players by position" value={position}
          onChange={event => setPosition(event.target.value)}>
          {['', 'PG', 'SG', 'SF', 'PF', 'C', 'TAXI', 'OUT'].map(value => (
            <option key={value || 'all'} value={value}>
              {value === '' ? 'All' : value === 'TAXI' ? 'Taxi' : value === 'OUT' ? 'Out' : value}
            </option>
          ))}
        </select>
        <div className="segmented" role="group" aria-label="Filter players">
          {['', 'PG', 'SG', 'SF', 'PF', 'C', 'TAXI', 'OUT'].map(value => (
            <button key={value || 'all'} aria-pressed={position === value} onClick={() => setPosition(value)}>
              {value === '' ? 'All' : value === 'TAXI' ? 'Taxi' : value === 'OUT' ? 'Out' : value}
            </button>
          ))}
        </div>
      </div>
      <div className={`scroll ${nominating ? 'nominating' : ''}`}>
        <div className="table-head pool-grid">
          <span>Player</span><span>Pos</span>
          <button className={sort === 'age' ? 'sorted' : ''} onClick={() => setSort('age')}>Age</button>
          <span title="Career NBA regular-season games">GP</span>
          <button className={sort === 'projection' ? 'sorted' : ''} onClick={() => setSort('projection')}
            title="Projected fantasy points per game">Proj</button>
          <button className={sort === 'adp' ? 'sorted' : ''} onClick={() => setSort('adp')}
            title="Sleeper dynasty ADP">ADP</button>
          {nominating && <span />}
        </div>
        {pool.slice(0, limit).map(player => {
          const blocker = nominating ? nominationBlocker(props, player, opening) : '';
          const expanded = open === player.id;
          return (
            <Fragment key={player.id}>
              <div className={`pool-row pool-grid ${expanded ? 'expanded' : ''} ${lotPlayer === player.id ? 'on-block' : ''}`}
                onClick={() => setOpen(expanded ? null : player.id)}>
                <span className="name">
                  <button className="name-button" aria-expanded={expanded} title={player.name}
                    onClick={event => { event.stopPropagation(); setOpen(expanded ? null : player.id); }}>
                    {player.name}
                  </button>
                  <small>{player.team ?? 'No team'}</small>
                  <InjuryTag status={player.injuryStatus} />
                  <EligibilityTags player={player} />
                </span>
                <span>{positionsLabel(player)}</span>
                <Cell value={ageLabel(player)} unknown={player.age === null ? 'Age unknown' : null} />
                <Cell value={careerLabel(player)} unknown={player.careerGames === null ? 'Career games unknown' : null}
                  title={player.careerGamesComplete ? undefined : `At least ${player.careerGames}; counted from 2013–14 only`} />
                <Cell value={projectionLabel(player)} className="strong"
                  unknown={player.projection === null ? 'No Sleeper projection' : null} />
                <DynastyAdp value={player.adp} />
                {nominating && (
                  <span>
                    {blocker ? <small className="blocked">{blocker}</small> : (
                    <button className="nominate" disabled={props.busy || !props.connected} title={`Nominate at ${dollars(opening)}`}
                      onClick={event => {
                        event.stopPropagation();
                        void send({ type: 'nominate', playerId: player.id, amount: opening,
                          nominationGeneration: state.draft.nominationGeneration });
                      }}>
                      Nominate
                    </button>
                    )}
                  </span>
                )}
              </div>
              {expanded && <PlayerDetails player={player} />}
            </Fragment>
          );
        })}
        {pool.length === 0 && <p className="empty-note">No available players match.</p>}
        {pool.length > limit && (
          <button className="more" onClick={() => setLimit(limit + 150)}>Show more ({pool.length - limit} left)</button>
        )}
      </div>
    </section>
  );
}

function bidBlocker(props: RoomProps, maximum: number, passed: boolean) {
  const { state, me, busy, connected } = props;
  const lot = state.lot;
  if (!lot) return 'No player on the block';
  if (state.draft.status === 'paused') return 'Draft paused';
  if (state.draft.status !== 'running') return 'Draft is not live';
  if (!connected) return 'Reconnecting';
  if (busy) return 'Sending';
  if (lot.highBidderId === me.id) return 'You have the high bid';
  if (passed) return 'You gave up on this player';
  if (maximum <= lot.highBid) return maximum < 1 ? 'No open spot fits this player' : `Your max is ${dollars(maximum)}`;
  return '';
}

function BidControls(props: RoomProps & { player: Player | undefined; offset: number }) {
  const { state, me, send, player } = props;
  const lot = state.lot!;
  const [custom, setCustom] = useState('');
  const maximum = player ? maxBid(me.budget, player, entriesOf(state, me.id), state.players) : 0;
  const passed = state.passes.includes(me.id);
  const blocker = player ? bidBlocker(props, maximum, passed) : 'Player data is loading';
  const customAmount = Number(custom);
  const customValid = Number.isInteger(customAmount) && customAmount > lot.highBid && customAmount <= maximum;
  const bid = (amount: number) => void send({ type: 'bid', lotId: lot.id, amount });
  const canGiveUp = !passed && lot.highBidderId !== me.id && state.draft.status === 'running' && !props.busy;
  return (
    <div className="bid-controls">
      <p className="pinned-lead">
        <strong>{dollars(lot.highBid)}</strong>
        <span>{lot.highBidderId === me.id ? 'You lead' : `${nameOf(state, lot.highBidderId)} leads`}</span>
        <small>Nominated by {nameOf(state, lot.nominatorId)}</small>
        <ShotClock draft={state.draft} offset={props.offset} compact />
      </p>
      <div className="bid-buttons">
        {[1, 5].map(step => (
          <button key={step} className="primary" disabled={!!blocker || lot.highBid + step > maximum}
            title={blocker} onClick={() => bid(lot.highBid + step)}>
            <span className="step">+{step}</span><span>{dollars(lot.highBid + step)}</span>
          </button>
        ))}
        <form className="custom" onSubmit={event => {
          event.preventDefault();
          if (!blocker && customValid) {
            bid(customAmount);
            setCustom('');
          }
        }}>
          <input aria-label="Bid amount" inputMode="numeric" placeholder="Amount"
            value={custom} onChange={event => setCustom(event.target.value.replace(/\D/g, ''))} disabled={!!blocker} />
          <button className="primary" disabled={!!blocker || !customValid}>Bid</button>
        </form>
      </div>
      <div className="bid-footer">
        <button className="ghost small" disabled={!canGiveUp} onClick={() => void send({ type: 'pass', lotId: lot.id })}>
          {passed ? 'Gave up' : 'Give up'}
        </button>
        <p className="bid-note">
          {lot.highBidderId === me.id ? `Your max is ${dollars(maximum)}.` : blocker || (custom && customAmount <= lot.highBid ? (
            <>
              Must beat {dollars(lot.highBid)}.{' '}
              <button className="link" onClick={() => setCustom(String(lot.highBid + 1))}>Use {dollars(lot.highBid + 1)}</button>
            </>
          ) : custom && customAmount > maximum ? (
            <>
              Your max is {dollars(maximum)}.{' '}
              <button className="link" onClick={() => setCustom(String(maximum))}>Use max</button>
            </>
          ) : (
            <>
              You can bid up to {dollars(maximum)}.{' '}
              <button className="link" onClick={() => setCustom(String(maximum))}>Use max</button>
            </>
          ))}
        </p>
      </div>
    </div>
  );
}

function OpeningBid({ opening, setOpening, cap }: { opening: number; setOpening: (value: number) => void; cap: number }) {
  const [text, setText] = useState<string | null>(null);
  return (
    <div className="opening">
      <span>Open at</span>
      <button className="secondary" aria-label="Lower opening bid" disabled={opening <= 1}
        onClick={() => setOpening(Math.max(1, opening - 1))}>−</button>
      <input aria-label="Opening bid" inputMode="numeric" value={text ?? String(opening)}
        onFocus={event => { setText(String(opening)); event.target.select(); }}
        onBlur={() => setText(null)}
        onChange={event => {
          const digits = event.target.value.replace(/\D/g, '');
          setText(digits);
          if (digits) setOpening(Math.max(1, Math.min(cap, Number(digits))));
        }} />
      <button className="secondary" aria-label="Raise opening bid" disabled={opening >= cap}
        onClick={() => setOpening(Math.min(cap, opening + 1))}>+</button>
    </div>
  );
}

function NominationView(props: RoomProps & { opening: number; setOpening: (value: number) => void }) {
  const { state, me, busy, send, opening, setOpening } = props;
  const d = state.draft;
  const myEntries = entriesOf(state, me.id);
  if (d.status === 'setup') {
    return (
      <div className="nomination">
        <h2>{me.commissioner ? `${state.managers.filter(m => m.claimed).length} of ${state.managers.length} managers joined`
          : `Waiting for ${nameOf(state, state.managers.find(m => m.commissioner)?.id)} to start`}</h2>
        {!me.commissioner && <p>{state.managers.filter(m => m.claimed).length} of {state.managers.length} managers joined.</p>}
        {me.commissioner && (
          <button className="primary large" disabled={busy} onClick={() => void send({ type: 'start' })}>Start draft</button>
        )}
      </div>
    );
  }
  if (d.status === 'complete') {
    return (
      <div className="nomination">
        <h2>Draft complete</h2>
        <p>{d.completionReason === 'full-cycle-passed'
          ? 'Every manager who could still nominate passed a full round.' : 'No manager can add another player.'}</p>
      </div>
    );
  }
  const mine = d.nominatorId === me.id;
  const cap = Math.max(1, me.budget - Math.max(0, 19 - counts(myEntries).active));
  return (
    <div className="nomination">
      <h2>{mine ? 'Your nomination' : `${nameOf(state, d.nominatorId)} is nominating`}</h2>
      {mine ? (
        <>
          {d.status !== 'paused' && <p>{timeoutText(state, me)}</p>}
          <OpeningBid opening={opening} setOpening={setOpening} cap={cap} />
        </>
      ) : d.status !== 'paused' && (
        <p>{timeoutText(state, state.managers.find(manager => manager.id === d.nominatorId))}</p>
      )}
    </div>
  );
}

const placementPlaces: Record<Placement, string> = { active: 'your active roster', taxi: 'taxi', ir: 'IR' };
function LastWin(props: RoomProps) {
  const { state, me, send, busy } = props;
  const [dismissed, setDismissed] = useState<number | null>(null);
  const sale = state.sales.find(candidate => candidate.highBidderId === me.id);
  const newer = sale && ((state.lot?.id ?? 0) > sale.id || (state.sales[0]?.id ?? 0) > sale.id);
  const entry = sale && sale.id !== dismissed && !newer
    ? state.roster.find(candidate => candidate.lotId === sale.id) : undefined;
  if (!entry || state.draft.status === 'complete') return null;
  const player = findPlayer(state, entry.playerId);
  if (!player) return null;
  const moves = (['active', 'taxi', 'ir'] as Placement[])
    .filter(placement => placement !== entry.placement && !moveBlocker(props, entry, placement));
  if (!moves.length) return null;
  return (
    <div className="last-win">
      <span>You won <strong>{player.name}</strong> for {dollars(entry.price)}, placed on {placementPlaces[entry.placement]}.</span>
      <div className="placement" role="group" aria-label={`Placement for ${player.name}`}>
        <button disabled={busy} onClick={() => setDismissed(entry.lotId)}>Keep</button>
        {moves.map(placement => (
          <button key={placement} disabled={busy} onClick={() => {
            setDismissed(entry.lotId);
            void send({ type: 'place', playerId: entry.playerId, placement });
          }}>
            To {placementLabels[placement]}
          </button>
        ))}
      </div>
    </div>
  );
}

export function BlockPanel(props: RoomProps & { offset: number; opening: number; setOpening: (value: number) => void }) {
  const { state, offset } = props;
  const [detailsFor, setDetailsFor] = useState<number | null>(null);
  const lot = state.lot;
  const showDetails = lot !== null && detailsFor === lot.id;
  const player = findPlayer(state, lot?.playerId);
  return (
    <section className={`panel block ${lot ? 'bidding' : ''}`} aria-label="Current player">
      <div className="block-information">
        <div className="block-top">
          <div className="block-main">
            {lot ? (
              <>
                <div className="lot-heading">
                  <h2 title={player?.name ?? lot.playerId}>{player?.name ?? lot.playerId}</h2>
                  <button className="link" aria-expanded={showDetails}
                    onClick={() => setDetailsFor(showDetails || !lot ? null : lot.id)}>
                    {showDetails ? 'Hide details' : 'Details'}
                  </button>
                </div>
                {player ? <PlayerLine player={player} /> : <p className="muted">Player data is loading</p>}
                <div className="high-bid">
                  <strong>{dollars(lot.highBid)}</strong>
                  <span>{lot.highBidderId === props.me.id ? 'You lead' : `${nameOf(state, lot.highBidderId)} leads`}</span>
                  <small>Nominated by {nameOf(state, lot.nominatorId)}</small>
                </div>
              </>
            ) : <NominationView {...props} />}
          </div>
          <ShotClock draft={state.draft} offset={offset} />
        </div>
        {lot && player && showDetails && <PlayerDetails player={player} />}
      </div>
      {lot && <BidControls key={lot.id} {...props} player={player} />}
      <LastWin {...props} />
    </section>
  );
}

function teamStatus(state: AuctionState, manager: Manager, maximum: number) {
  const lot = state.lot;
  if (lot?.highBidderId === manager.id) return { text: `Leads ${dollars(lot.highBid)}`, tone: 'lead' };
  if (lot && state.passes.includes(manager.id)) return { text: 'Gave up', tone: 'muted' };
  if (lot && maximum <= lot.highBid) return { text: 'Can’t raise', tone: 'muted' };
  if (!lot && state.draft.nominatorId === manager.id && state.draft.status !== 'complete') {
    return { text: 'Nominating', tone: 'turn' };
  }
  if (manager.done) return { text: 'Not nominating', tone: 'muted' };
  if (!manager.claimed && state.draft.status !== 'complete') return { text: 'Not joined', tone: 'muted' };
  return { text: '', tone: '' };
}

export function TeamsPanel({ state, me, busy, send }: RoomProps) {
  const current = findPlayer(state, state.lot?.playerId);
  const seatsEditable = me.commissioner && (state.draft.status === 'setup' || state.draft.status === 'paused');
  const live = state.draft.status === 'running' || state.draft.status === 'paused';
  const upcoming = live ? upcomingNominators(state) : [];
  return (
    <section className="panel teams" aria-label="Teams">
      <div className="scroll">
        <div className={`table-head team-grid ${seatsEditable ? 'with-admin' : ''} ${live ? 'with-turn' : ''}`}>
          <span>Team</span><span>Left</span><span title={current ? `Max bid on ${current.name}` : 'Max bid'}>Max</span>
          <span>Active</span><span>Taxi</span><span>IR</span>
          {live && <span title="Nominations until this team's turn">Turn</span>}{seatsEditable && <span />}
        </div>
        {state.managers.map(manager => {
          const entries = entriesOf(state, manager.id);
          const c = counts(entries);
          const maximum = current ? maxBid(manager.budget, current, entries, state.players)
            : Math.max(0, manager.budget - Math.max(0, 19 - c.active));
          const status = teamStatus(state, manager, maximum);
          const turnLabel = !live ? '' : manager.id === state.draft.nominatorId ? 'Now'
            : upcoming.includes(manager.id) ? String(upcoming.indexOf(manager.id) + 1) : '—';
          const turn = !state.lot && state.draft.nominatorId === manager.id && state.draft.status !== 'complete';
          return (
            <div key={manager.id}
              className={`team-row team-grid ${seatsEditable ? 'with-admin' : ''} ${live ? 'with-turn' : ''} ${manager.id === me.id ? 'me' : ''} ${turn ? 'turn' : ''}`}>
              <span className="team-name">
                <b>{manager.name}</b>
                {status.text && <span className={`status ${status.tone}`}>{status.text}</span>}
                {live && turnLabel !== '—' && (
                  <span className="turn-inline">
                    {turnLabel !== 'Now' ? `Turn ${turnLabel}` : state.lot ? 'Nominated' : 'Nominating'}
                  </span>
                )}
              </span>
              <span className="num">{dollars(manager.budget)}</span>
              <span className="num">{dollars(maximum)}</span>
              <span className={`num ${c.active === 20 ? 'full' : ''}`}>{c.active}/20</span>
              <span className={`num ${c.taxi === 3 ? 'full' : ''}`}>{c.taxi}/3</span>
              <span className={`num ${c.ir === 2 ? 'full' : ''}`}>{c.ir}/2</span>
              {live && (
                <span className="num turn-col" title={turnLabel === '—' ? 'Not in the nomination rotation' : undefined}>
                  {turnLabel}
                </span>
              )}
              {seatsEditable && (
                <span>
                  {manager.claimed && manager.id !== me.id && seatsEditable && (
                    <ConfirmButton className="release ghost small" label="Release" confirmLabel={`Release ${manager.name}?`}
                      disabled={busy}
                      title={`Release ${manager.name}'s seat so they can rejoin on another device`}
                      onConfirm={() => void send({ type: 'release', managerId: manager.id })} />
                  )}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function moveBlocker(props: RoomProps, entry: Entry, placement: Placement) {
  const { state, me } = props;
  const player = findPlayer(state, entry.playerId);
  if (!player) return 'Player data is loading';
  const rest = state.roster.filter(e => e.managerId === me.id && e.playerId !== entry.playerId);
  if (!legalPlacements(player, rest, state.players).includes(placement)) {
    if (placement === 'taxi') return taxiEligibility(player) === 'eligible' ? 'Taxi is full' : 'Not taxi eligible';
    if (placement === 'ir') return player.injuryStatus === 'Out' ? 'IR is full' : 'Only players listed Out';
    return 'No active spot fits him';
  }
  const changed = [...rest, { ...entry, placement }];
  if (me.budget < 20 - counts(changed).active) return 'Keep $1 for each open active spot';
  if (state.lot?.highBidderId === me.id) {
    const standing = findPlayer(state, state.lot.playerId);
    if (!standing) return 'Current player data is loading';
    if (maxBid(me.budget, standing, changed, state.players) < state.lot.highBid) return 'Would break your high bid';
  }
  return '';
}

function PlacementSwitch(props: RoomProps & { entry: Entry }) {
  const { entry, busy, send, state } = props;
  if (state.draft.status === 'complete') return null;
  const moves = (['active', 'taxi', 'ir'] as Placement[])
    .filter(placement => placement !== entry.placement && !moveBlocker(props, entry, placement));
  if (!moves.length) return null;
  return (
    <div className="placement" role="group" aria-label={`Move ${findPlayer(state, entry.playerId)?.name}`}>
      {moves.map(placement => (
        <button key={placement} disabled={busy}
          onClick={() => void send({ type: 'place', playerId: entry.playerId, placement })}>
          To {placementLabels[placement]}
        </button>
      ))}
    </div>
  );
}

function RosterRow(props: RoomProps & { entry: Entry; slot: string; fresh?: boolean }) {
  const { state, entry, slot, fresh } = props;
  const player = findPlayer(state, entry.playerId);
  return (
    <div className={`roster-row ${fresh ? 'fresh' : ''}`} id={`roster-${entry.lotId}`}>
      <span className="slot">{slot}</span>
      <span className="roster-name">
        <strong title={player?.name ?? entry.playerId}>{player?.name ?? entry.playerId}</strong>
        <small>{player ? positionsLabel(player) : 'Player data is loading'} · {dollars(entry.price)}</small>
        {player && <><InjuryTag status={player.injuryStatus} /><EligibilityTags player={player} /></>}
      </span>
      <PlacementSwitch {...props} />
    </div>
  );
}
function OpenSlot({ slot }: { slot: string }) {
  return <div className="roster-row open"><span className="slot">{slot}</span><span className="muted">Open</span></div>;
}

export function RosterPanel(props: RoomProps) {
  const { state, me } = props;
  const entries = entriesOf(state, me.id);
  const active = entries.filter(entry => entry.placement === 'active');
  const taxi = entries.filter(entry => entry.placement === 'taxi');
  const ir = entries.filter(entry => entry.placement === 'ir');
  const c = counts(entries);
  const pauseReason = state.draft.status === 'paused' ? 'Available when the draft resumes' : undefined;
  const activePlayers = active.map(entry => findPlayer(state, entry.playerId));
  const assignment = activePlayers.every(player => player !== undefined)
    ? matching(activePlayers) ?? Array<number>(slots.length).fill(-1) : Array<number>(slots.length).fill(-1);
  const assigned = new Set<number>(assignment.filter(index => index >= 0));
  const pendingEntries = active.filter((_, index) => !assigned.has(index));
  const bench = assignment.slice(10).filter(index => index >= 0);
  const latestWin = state.sales.find(sale => sale.highBidderId === me.id)?.id ?? null;
  const freshLot = latestWin !== null && (state.lot?.id ?? 0) <= latestWin && (state.sales[0]?.id ?? 0) <= latestWin
    ? latestWin : null;
  useEffect(() => {
    if (freshLot !== null) document.getElementById(`roster-${freshLot}`)?.scrollIntoView({ block: 'nearest' });
  }, [freshLot]);
  return (
    <section className="panel roster" aria-label="My roster">
      <div className="panel-head">
        <h2>My roster</h2>
        <span className="narrow-only">
          {dollars(me.budget)} left · max {dollars(Math.max(0, me.budget - Math.max(0, 19 - c.active)))} · {c.active}/20 active
        </span>
      </div>
      <div className="scroll">
        {pendingEntries.length ? <>
          <h3>Active</h3>
          {pendingEntries.map(entry => <RosterRow {...props} key={entry.playerId} entry={entry} slot="Active"
            fresh={entry.lotId === freshLot} />)}
        </> : <>
          <h3>Starters</h3>
          {assignment.slice(0, 10).map((index, slot) => index >= 0
            ? <RosterRow {...props} key={active[index].playerId} entry={active[index]} slot={slots[slot]}
              fresh={active[index].lotId === freshLot} />
            : <OpenSlot key={`slot-${slot}`} slot={slots[slot]} />)}
          <h3>Bench <span>{bench.length}/10</span></h3>
          {bench.map(index => (
            <RosterRow {...props} key={active[index].playerId} entry={active[index]} slot=""
              fresh={active[index].lotId === freshLot} />
          ))}
        </>}
        {(me.done || (onlyReserveOpen(entries) && me.budget >= 1)) && state.draft.status !== 'complete'
          && state.draft.status !== 'setup' && (
          <div className="skip-note">
            <p>
              {me.done ? 'You are skipping your nominations.' : 'Only taxi and IR spots are left.'} You can still bid.
              {pauseReason && <span id={`nomination-pause-${me.id}`}> {pauseReason}.</span>}
            </p>
            <button className="ghost small" disabled={props.busy || state.draft.status !== 'running'}
              title={pauseReason} aria-describedby={pauseReason ? `nomination-pause-${me.id}` : undefined}
              onClick={() => void props.send({ type: 'done', done: !me.done,
                nominationGeneration: state.draft.nominationGeneration })}>
              {me.done ? 'Nominate again' : 'Skip my nominations'}
            </button>
          </div>
        )}
        <h3 title="Rookies or players under 65 career games">Taxi <span>{c.taxi}/3</span></h3>
        {taxi.map(entry => <RosterRow {...props} key={entry.playerId} entry={entry} slot="" fresh={entry.lotId === freshLot} />)}
        <h3 title="Only players listed Out">IR <span>{c.ir}/2</span></h3>
        {ir.map(entry => <RosterRow {...props} key={entry.playerId} entry={entry} slot="" fresh={entry.lotId === freshLot} />)}
      </div>
    </section>
  );
}

function eventText(event: RecentEvent, state: AuctionState) {
  const name = nameOf(state, event.managerId);
  const player = findPlayer(state, String(event.data.playerId ?? ''))?.name;
  switch (event.type) {
    case 'nomination': return `${name} nominated ${player ?? 'a player'}${event.data.auto ? ' (time ran out)' : ''}`;
    case 'nomination-pass': return `${name} passed (time ran out)`;
    case 'bid': return `${name} bid ${dollars(Number(event.data.amount))}`;
    case 'pass': return `${name} gave up`;
    case 'sale': return `${name} won ${player ?? 'a player'} for ${dollars(Number(event.data.price))}`;
    case 'placement': return `${name} moved ${player ?? 'a player'} to ${placementLabels[event.data.to as Placement] ?? event.data.to}`;
    case 'done': return `${name} ${event.data.done ? 'is skipping nominations' : 'resumed nominations'}`;
    case 'undo': return 'Commissioner undid the last sale';
    case 'pause': return 'Commissioner paused the draft';
    case 'resume': return 'Commissioner resumed the draft';
    case 'force': return 'Commissioner ended bidding';
    case 'start': return 'Draft started';
    case 'release': return 'Commissioner released a seat';
    case 'complete': return 'Draft complete';
    default: return null;
  }
}

export function ResultsPanel({ state }: RoomProps) {
  const [view, setView] = useState<'sales' | 'activity'>('sales');
  const sales = [...state.roster].sort((a, b) => b.lotId - a.lotId);
  const activity = state.recentEvents
    .map(event => ({ event, text: eventText(event, state) }))
    .filter((item): item is { event: RecentEvent; text: string } => item.text !== null);
  return (
    <section className="panel results" aria-label="Results">
      <div className="panel-head">
        <div className="segmented tabs" role="tablist">
          <button role="tab" aria-selected={view === 'sales'} onClick={() => setView('sales')}>
            Sales · {sales.length}
          </button>
          <button role="tab" aria-selected={view === 'activity'} onClick={() => setView('activity')}>Activity</button>
        </div>
      </div>
      <div className="scroll">
        {view === 'sales' ? sales.map(entry => (
          <div className="result-row" key={entry.lotId}>
            <strong>{findPlayer(state, entry.playerId)?.name ?? entry.playerId}</strong>
            <span>{nameOf(state, entry.managerId)}</span>
            <b>{dollars(entry.price)}</b>
          </div>
        )) : activity.map(({ event, text }) => (
          <div className="activity-row" key={event.id}>{text}</div>
        ))}
        {view === 'sales' && sales.length === 0 && <p className="empty-note">No players sold yet.</p>}
      </div>
    </section>
  );
}

function ConfirmButton({ label, confirmLabel, disabled, className, onConfirm, title }: {
  label: string; confirmLabel: string; disabled: boolean; className: string; onConfirm: () => void; title?: string;
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(timer);
  }, [armed]);
  return (
    <button className={`${className} ${armed ? 'armed' : ''}`} disabled={disabled} title={title}
      aria-label={armed ? confirmLabel : label}
      onClick={() => { if (armed) { setArmed(false); onConfirm(); } else setArmed(true); }}>
      {armed ? confirmLabel : label}
    </button>
  );
}
function undoLabel(state: AuctionState) {
  const last = state.sales[0];
  return last ? `Undo ${findPlayer(state, last.playerId)?.name ?? last.playerId} ${dollars(last.highBid)}?` : 'Undo?';
}

export function CommissionerBar({ state, busy, send }: RoomProps) {
  const d = state.draft;
  if (d.status === 'setup' || d.status === 'complete') {
    return d.status === 'complete' && state.sales.length ? (
      <div className="commish">
        <ConfirmButton key={`undo-${state.sales[0]?.id ?? 'none'}`} className="ghost small" label="Undo last sale"
          confirmLabel={undoLabel(state)} disabled={busy}
          onConfirm={() => state.sales[0] && void send({ type: 'undo', lotId: state.sales[0].id })} />
      </div>
    ) : null;
  }
  return (
    <div className="commish">
      <ConfirmButton key={`undo-${state.sales[0]?.id ?? 'none'}`} className="ghost small" label="Undo last sale"
        confirmLabel={undoLabel(state)} disabled={busy || !state.sales.length} title="Returns the player and refunds the price, then pauses"
        onConfirm={() => state.sales[0] && void send({ type: 'undo', lotId: state.sales[0].id })} />
      <ConfirmButton key={`force-${state.lot?.id}-${state.lot?.highBidderId}-${state.lot?.highBid}`} className="ghost small" label="Force end"
        confirmLabel={state.lot ? `Sell to ${nameOf(state, state.lot.highBidderId)} ${dollars(state.lot.highBid)}?` : 'Sell?'}
        disabled={busy || !state.lot} title="Sell now to the high bidder"
        onConfirm={() => state.lot && void send({ type: 'force', lotId: state.lot.id,
          expectedHighBidderId: state.lot.highBidderId, expectedHighBid: state.lot.highBid })} />
      <button className="secondary small" disabled={busy}
        onClick={() => void send({ type: d.status === 'paused' ? 'resume' : 'pause' })}>
        {d.status === 'paused' ? 'Resume' : 'Pause'}
      </button>
    </div>
  );
}

export function turnsUntil(state: AuctionState, me: Manager) {
  const { status, phase, nominatorId } = state.draft;
  if (status !== 'running' && status !== 'paused') return null;
  if (nominatorId === me.id && phase === 'nomination') return 0;
  if (!canNominate(state, me)) return null;
  const position = upcomingNominators(state).indexOf(me.id);
  return position < 0 ? null : position + 1;
}
