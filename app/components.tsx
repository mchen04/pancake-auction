'use client';
import { useQuery } from 'convex/react';
import { api } from '../convex/_generated/api';
import { Fragment, useEffect, useState, type ReactNode } from 'react';
import {
  canNominate, counts, legalPlacements, matching, maxBid, rankedDynastyAdp, slots, taxiEligibility, timeoutNominee
} from '../lib/rules';
import type { Action, AuctionState, Draft, Entry, Manager, Placement, Player, PrivateState, QueueAction, QueueEntry, RecentEvent } from '../lib/types';

export const dollars = (amount: number) => `$${amount}`;
export interface RoomProps {
  state: AuctionState;
  me: Manager;
  busy: boolean;
  connected: boolean;
  send: (action: Action) => Promise<void>;
  privateSeat?: PrivateState | null;
  editQueue?: (action: QueueAction) => Promise<void>;
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
  const pick = timeoutNominee(state, manager);
  return pick ? `After 24h: ${pick.name} is nominated without a bid.` : 'Time out: the turn passes.';
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

export function Deadline({ draft }: { draft: Draft }) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 60000);
    return () => clearInterval(timer);
  }, [draft.deadline, draft.status, draft.remainingMs]);
  if (draft.status === 'setup' || draft.status === 'complete') return null;
  const remaining = draft.status === 'paused' ? draft.remainingMs
    : now === null || draft.deadline === null ? null : Math.max(0, draft.deadline - now);
  const minutes = remaining === null ? null : Math.ceil(remaining / 60000);
  const label = minutes === null ? 'Loading deadline' : minutes === 0 ? 'Resolving…'
    : `${Math.floor(minutes / 60)}h ${minutes % 60}m left`;
  return <div className="deadline" role="timer">
    <strong>{draft.status === 'paused' ? 'Paused · ' : ''}{label}</strong>
    {draft.deadline && <time dateTime={new Date(draft.deadline).toISOString()}>
      {now === null ? '' : new Date(draft.deadline).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
    </time>}
  </div>;
}
function nominationBlocker(props: RoomProps, player: Player, opening: number | undefined) {
  const maximum = maxBid(props.me.budget, player, entriesOf(props.state, props.me.id), props.state.players);
  if (maximum < 1) return 'No spot';
  if (opening !== undefined && (!Number.isSafeInteger(opening) || opening < 1)) return 'Use a positive whole dollar';
  if (opening !== undefined && opening > maximum) return `Max ${dollars(maximum)}`;
  return '';
}
function myNominationTurn(state: AuctionState, me: Manager) {
  const d = state.draft;
  return d.status === 'running' && d.phase === 'nomination' && d.nominatorId === me.id;
}

export function PoolPanel(props: RoomProps & { opening: number | undefined }) {
  const { state, me, send } = props;
  const opening = props.opening;
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
  const actions = state.draft.status !== 'complete';
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
      <div className={`scroll ${actions ? 'with-action' : ''} ${nominating ? 'nominating' : ''}`}>
        <div className="table-head pool-grid">
          <span>Player</span><span>Pos</span>
          <button className={sort === 'age' ? 'sorted' : ''} onClick={() => setSort('age')}>Age</button>
          <span title="Career NBA regular-season games">GP</span>
          <button className={sort === 'projection' ? 'sorted' : ''} onClick={() => setSort('projection')}
            title="Projected fantasy points per game">Proj</button>
          <button className={sort === 'adp' ? 'sorted' : ''} onClick={() => setSort('adp')}
            title="Sleeper dynasty ADP">ADP</button>
          {actions && <span className="sr-only">Action</span>}
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
                {actions && !nominating && <span><QuickQueue {...props} player={player} /></span>}
                {nominating && (
                  <span>
                    {blocker ? <small className="blocked">{blocker}</small> : (
                    <button className="nominate" disabled={props.busy || !props.connected} title={opening === undefined ? 'Nominate without a bid' : `Nominate with sealed bid ${dollars(opening)}`}
                      onClick={event => {
                        event.stopPropagation();
                        void send({ type: 'nominate', playerId: player.id, ...(opening === undefined ? {} : { amount: opening }),
                          nominationGeneration: state.draft.nominationGeneration });
                      }}>
                      Nominate
                    </button>
                    )}
                  </span>
                )}
              </div>
              {expanded && <><PlayerDetails player={player} /><QueueAdd {...props} player={player} /></>}
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

function Lock() {
  return <svg className="lock" width="11" height="12" viewBox="0 0 11 12" aria-hidden="true" focusable="false">
    <rect x="1" y="5" width="9" height="6.5" rx="1.2" fill="currentColor" />
    <path d="M3 5V3.6a2.5 2.5 0 0 1 5 0V5" fill="none" stroke="currentColor" strokeWidth="1.4" />
  </svg>;
}
function ResponseStrip({ state }: { state: AuctionState }) {
  const lot = state.lot!;
  const responded = lot.respondedIds ?? [];
  return <div className="responses">
    <p className="response-count">{responded.length} of {state.managers.length} responded</p>
    <ul className="response-dots" aria-label="Response status">
      {state.managers.map(manager => {
        const done = responded.includes(manager.id);
        return <li key={manager.id} className={done ? 'on' : ''} title={`${manager.name}: ${done ? 'Responded' : 'Waiting'}`}>
          <span className="sr-only">{manager.name}: {done ? 'Responded' : 'Waiting'}</span>
        </li>;
      })}
    </ul>
  </div>;
}
function BidControls(props: RoomProps & { player: Player | undefined }) {
  const { state, me, send, player, privateSeat } = props;
  const lot = state.lot!;
  const [custom, setCustom] = useState('');
  const maximum = player ? maxBid(me.budget, player, entriesOf(state, me.id), state.players) : 0;
  const ready = privateSeat?.lotId === lot.id;
  const own = ready ? privateSeat.response : null;
  const blocked = !ready || !props.connected || props.busy || state.draft.status !== 'running'
    || !!own || maximum < 1;
  const amount = Number(custom);
  const valid = custom.trim() !== '' && Number.isSafeInteger(amount) && amount >= 1 && amount <= maximum;
  const waiting = state.managers.length - (lot.respondedIds?.length ?? 0);
  return <div className="bid-controls">
    <ResponseStrip state={state} />
    {own ? <div className="own-response" role="status">
      <p><span className="check" aria-hidden="true">✓</span> Your final response: <strong>{own.amount === 0 ? 'Pass ($0)' : dollars(own.amount)}</strong>
        {own.automatic ? ' · Automatic pass' : ''}</p>
      <small>Sealed until the lot resolves{waiting > 0 ? ` · waiting on ${waiting} more` : ''}.</small>
    </div>
      : <>
        <form className="sealed-form" onSubmit={event => {
          event.preventDefault();
          if (!blocked && valid) void send({ type: 'bid', lotId: lot.id, amount });
        }}>
          <label className="money">
            <span aria-hidden="true">$</span>
            <input aria-label="Sealed bid amount" inputMode="numeric" pattern="[0-9]*" enterKeyHint="send" autoComplete="off"
              placeholder={maximum >= 1 ? `1–${maximum}` : 'Whole dollars'} value={custom}
              onChange={event => setCustom(event.target.value)} disabled={blocked} />
          </label>
          <button className="primary" disabled={blocked || !valid}>
            {valid ? `Submit ${dollars(amount)} final` : 'Submit final bid'}</button>
          <button type="button" className="pass" disabled={blocked}
            onClick={() => void send({ type: 'pass', lotId: lot.id })}>Pass ($0)</button>
        </form>
        <p className="bid-note">{!ready ? 'Loading your response…'
          : maximum < 1 ? 'No legal roster spot or budget for this player, so you pass automatically.'
            : state.draft.status === 'paused' ? 'Paused. You can respond when the draft resumes.'
              : custom.trim() !== '' && !valid ? `Use a whole dollar from $1 to ${dollars(maximum)}.`
                : <>Max {dollars(maximum)}. <strong>One final response</strong>, hidden until the lot resolves.</>}</p>
      </>}
  </div>;
}
function OpeningBid({ opening, setOpening }: {
  opening: number | undefined; setOpening: (value: number | undefined) => void
}) {
  return <div className="opening">
    <label className="money">
      <span aria-hidden="true">$</span>
      <input aria-label="Optional nomination bid" inputMode="numeric" pattern="[0-9]*" autoComplete="off" placeholder="No bid"
        value={opening ?? ''}
        onChange={event => setOpening(event.target.value === '' ? undefined : Number(event.target.value))} />
    </label>
    <span>Optional sealed bid. Leave blank to bid later like everyone else.</span>
  </div>;
}
function NominationView(props: RoomProps & {
  opening: number | undefined; setOpening: (value: number | undefined) => void
}) {
  const { state, me, busy, send } = props;
  const d = state.draft;
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
    const c = counts(entriesOf(state, me.id));
    return (
      <div className="nomination complete">
        <h2><span className="check" aria-hidden="true">✓</span> Draft complete</h2>
        <p>{d.completionReason === 'full-cycle-unsold'
          ? 'Completed under earlier auction rules.' : 'No manager can nominate another player.'}</p>
        <p>Your team: {c.active}/20 active, {c.taxi}/3 taxi, {c.ir}/2 IR, {dollars(me.budget)} left. Every revealed bid is in Results.</p>
      </div>
    );
  }
  const mine = d.nominatorId === me.id;
  return (
    <div className="nomination">
      <h2>{mine ? 'Your nomination' : `${nameOf(state, d.nominatorId)} is nominating`}</h2>
      {d.status !== 'paused' && (
        <p>{timeoutText(state, mine ? me : state.managers.find(manager => manager.id === d.nominatorId))}</p>
      )}
    </div>
  );
}
function NominationControls({ state, me, opening, setOpening }: RoomProps & {
  opening: number | undefined; setOpening: (value: number | undefined) => void
}) {
  const d = state.draft;
  if (state.lot || d.nominatorId !== me.id || (d.status !== 'running' && d.status !== 'paused')) return null;
  return (
    <div className="nomination-controls">
      <OpeningBid opening={opening} setOpening={setOpening} />
      <p className="nominate-hint">Then tap <strong>Nominate</strong> on a player in the list.</p>
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

function LastResult({ state }: RoomProps) {
  const lot = state.sales[0];
  if (!lot || state.draft.status === 'setup') return null;
  const name = findPlayer(state, lot.playerId)?.name ?? lot.playerId;
  const text = lot.status === 'unsold' ? `${name} went unsold and is back in the pool.`
    : lot.status === 'undone' ? `The ${name} sale was undone.`
      : `${nameOf(state, lot.highBidderId)} won ${name} for ${dollars(lot.highBid)}${lot.tied ? ' on tie priority' : ''}.`;
  return <p className="last-result" role="status"><span>Last lot</span> {text}</p>;
}

export function BlockPanel(props: RoomProps & {
  opening: number | undefined; setOpening: (value: number | undefined) => void
}) {
  const { state } = props;
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
                <p className="lot-status"><Lock /> Sealed bids · nominated by {nameOf(state, lot.nominatorId)}</p>
              </>
            ) : <NominationView {...props} />}
          </div>
          <Deadline draft={state.draft} />
        </div>
        {lot && player && showDetails && <PlayerDetails player={player} />}
      </div>
      {lot && <BidControls key={lot.id} {...props} player={player} />}
      <NominationControls {...props} />
      <LastWin {...props} />
      <LastResult {...props} />
    </section>
  );
}

function teamStatus(state: AuctionState, manager: Manager) {
  if (state.lot) return { text: state.lot.respondedIds?.includes(manager.id) ? 'Responded' : 'Waiting', tone: 'muted' };
  if (state.draft.nominatorId === manager.id && state.draft.status !== 'complete') return { text: 'Nominating', tone: 'turn' };
  if (manager.done) return { text: 'Not nominating', tone: 'muted' };
  if (!manager.claimed && state.draft.status !== 'complete') return { text: 'Not joined', tone: 'muted' };
  return { text: '', tone: '' };
}

export function TeamsPanel(props: RoomProps) {
  const { state, me, busy, send } = props;
  const [inspectedId, setInspectedId] = useState<number | null>(null);
  const current = findPlayer(state, state.lot?.playerId);
  const seatsEditable = me.commissioner && (state.draft.status === 'setup' || state.draft.status === 'paused');
  const live = state.draft.status === 'running' || state.draft.status === 'paused';
  const upcoming = live ? upcomingNominators(state) : [];
  return (
    <section className="panel teams" aria-label="Teams">
      <div className="scroll">
        <div className="priority" aria-label="Tie priority"><strong>Tie priority · highest first</strong>
          <p>{state.draft.tiePriority?.map(id => nameOf(state, id)).join(' → ') || 'Set when the draft starts'}</p>
        </div>
        <div className={`table-head team-grid ${seatsEditable ? 'with-admin' : ''} ${live ? 'with-turn' : ''}`}>
          <span>Team</span><span>Left</span><span title={current ? `Max bid on ${current.name}` : 'Max bid'}>Max</span>
          <span>Active</span><span>Taxi</span><span>IR</span>
          {live && <span title="Nominations until this team's turn">Turn</span>}
          {seatsEditable && <span className="team-release-heading" />}
        </div>
        {state.managers.map(manager => {
          const entries = entriesOf(state, manager.id);
          const c = counts(entries);
          const maximum = current ? maxBid(manager.budget, current, entries, state.players)
            : Math.max(0, manager.budget - Math.max(0, 19 - c.active));
          const status = teamStatus(state, manager);
          const turnLabel = !live ? '' : manager.id === state.draft.nominatorId ? 'Now'
            : upcoming.includes(manager.id) ? String(upcoming.indexOf(manager.id) + 1) : '—';
          const turn = !state.lot && state.draft.nominatorId === manager.id && state.draft.status !== 'complete';
          const rowClass = ['team-row', 'team-grid', seatsEditable ? 'with-admin' : '', live ? 'with-turn' : '',
            manager.id === me.id ? 'me' : '', turn ? 'turn' : '',
            inspectedId === manager.id ? 'inspected' : ''].join(' ');
          return (
            <Fragment key={manager.id}>
              <div className={rowClass}>
                <span className="team-name">
                  <button className="team-inspect" aria-expanded={inspectedId === manager.id}
                    aria-controls={`team-roster-${manager.id}`}
                    title={inspectedId === manager.id ? 'Hide roster' : 'View roster'}
                    onClick={() => setInspectedId(inspectedId === manager.id ? null : manager.id)}>
                    <span className="team-inspect-name">{manager.name}</span>
                    <svg className="team-inspect-cue" width="8" height="10" viewBox="0 0 8 10"
                      aria-hidden="true" focusable="false">
                      <path d="m2 1 4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.5" />
                    </svg>
                  </button>
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
                  <span className="team-release">
                    {manager.claimed && manager.id !== me.id && seatsEditable && (
                      <ConfirmButton className="release ghost small" label="Release" confirmLabel={`Release ${manager.name}?`}
                        disabled={busy}
                        title={`Release ${manager.name}'s seat so they can rejoin on another device`}
                        onConfirm={() => void send({ type: 'release', managerId: manager.id })} />
                    )}
                  </span>
                )}
              </div>
              {inspectedId === manager.id && (
                <div className="team-roster" id={`team-roster-${manager.id}`}
                  role="region" aria-label={`${manager.name}'s roster`}>
                  <RosterSlots {...props} manager={manager} readOnly />
                </div>
              )}
            </Fragment>
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
  const own = props.privateSeat?.lotId === state.lot?.id ? props.privateSeat?.response : null;
  if (state.lot && own && own.amount > 0) {
    const standing = findPlayer(state, state.lot.playerId);
    if (!standing || maxBid(me.budget, standing, changed, state.players) < own.amount) return 'Would break your sealed response';
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

function RosterSlot(props: RoomProps & {
  entry?: Entry; slot: string; position: string; index: number; capacity: number; fresh?: boolean; readOnly?: boolean
}) {
  const { state, entry, slot, position, index, capacity, fresh, readOnly } = props;
  const player = findPlayer(state, entry?.playerId);
  const label = `${position} spot ${index + 1} of ${capacity}, ${entry ? player?.name ?? entry.playerId : 'open'}`;
  return (
    <div className={`roster-row ${entry ? fresh ? 'fresh' : '' : 'open'}`} role="group" aria-label={label}
      id={entry && !readOnly ? `roster-${entry.lotId}` : undefined}>
      <span className="slot">{slot}</span>
      {entry ? <>
        <span className="roster-name">
          <strong title={player?.name ?? entry.playerId}>{player?.name ?? entry.playerId}</strong>
          <small>{player ? positionsLabel(player) : 'Player data is loading'} · {dollars(entry.price)}</small>
          {player && <><InjuryTag status={player.injuryStatus} /><EligibilityTags player={player} /></>}
        </span>
        {!readOnly && <PlacementSwitch {...props} entry={entry} />}
      </> : <span className="muted">Open</span>}
    </div>
  );
}
function RosterGroup(props: RoomProps & {
  name: string; code: string; capacity: number; entries: (Entry | undefined)[]; positions?: string[];
  freshLot?: number | null; readOnly?: boolean; title?: string; showCount?: boolean
}) {
  return (
    <div className="roster-group">
      <h3 title={props.title}>{props.name}{props.showCount && (
        <span>{props.entries.filter(Boolean).length}/{props.capacity}</span>
      )}</h3>
      {Array.from({ length: props.capacity }, (_, index) => (
        <RosterSlot {...props} key={index} index={index} entry={props.entries[index]}
          slot={props.positions?.[index] ?? props.code} position={props.positions?.[index] ?? props.name}
          fresh={props.entries[index]?.lotId === props.freshLot} />
      ))}
    </div>
  );
}
function RosterSlots(props: RoomProps & {
  manager: Manager; readOnly?: boolean; freshLot?: number | null; children?: ReactNode
}) {
  const entries = entriesOf(props.state, props.manager.id);
  const active = entries.filter(entry => entry.placement === 'active');
  const activePlayers = active.map(entry => findPlayer(props.state, entry.playerId));
  const assignment = activePlayers.every(player => player !== undefined)
    ? matching(activePlayers) ?? Array<number>(slots.length).fill(-1) : Array<number>(slots.length).fill(-1);
  const assigned = new Set<number>(assignment.filter(index => index >= 0));
  const pendingEntries = active.filter((_, index) => !assigned.has(index));
  const bench = assignment.slice(10).filter(index => index >= 0).map(index => active[index]);
  return (
    <div className="roster-slots">
      {pendingEntries.length ? (
        <RosterGroup {...props} name="Active" code="Active" capacity={20} entries={pendingEntries} />
      ) : <>
        <RosterGroup {...props} name="Starters" code="" capacity={10} positions={slots.slice(0, 10)}
          entries={assignment.slice(0, 10).map(index => active[index])} />
        <RosterGroup {...props} name="Bench" code="BN" capacity={10} entries={bench} showCount />
      </>}
      {props.children}
      <RosterGroup {...props} name="Taxi" code="TX" capacity={3} showCount
        entries={entries.filter(entry => entry.placement === 'taxi')} title="Rookies or players under 65 career games" />
      <RosterGroup {...props} name="IR" code="IR" capacity={2} showCount
        entries={entries.filter(entry => entry.placement === 'ir')} title="Only players listed Out" />
    </div>
  );
}
function NominationPreference(props: RoomProps) {
  const { state, me } = props;
  const entries = entriesOf(state, me.id);
  const pauseReason = state.draft.status === 'paused' ? 'Available when the draft resumes' : undefined;
  if (!(me.done || onlyReserveOpen(entries) && me.budget >= 1)
    || state.draft.status === 'complete' || state.draft.status === 'setup') return null;
  return (
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
  );
}

export function RosterPanel(props: RoomProps) {
  const { state, me } = props;
  const c = counts(entriesOf(state, me.id));
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
        <RosterSlots {...props} manager={me} freshLot={freshLot}><NominationPreference {...props} /></RosterSlots>
      </div>
    </section>
  );
}

function eventText(event: RecentEvent, state: AuctionState) {
  const name = nameOf(state, event.managerId);
  const player = findPlayer(state, String(event.data.playerId ?? ''))?.name;
  switch (event.type) {
    case 'nomination': return `${name} nominated ${player ?? 'a player'}${event.data.source === 'timeout' ? ' (time ran out)' : ''}`;
    case 'resolution': return event.data.status === 'unsold' ? `${player ?? 'Player'} went unsold` : `${name} won ${player ?? 'a player'} for ${dollars(Number(event.data.price))}`;
    case 'sale': return `${name} won ${player ?? 'a player'} for ${dollars(Number(event.data.price))}`;
    case 'placement': return `${name} moved ${player ?? 'a player'} to ${placementLabels[event.data.to as Placement] ?? event.data.to}`;
    case 'done': return `${name} ${event.data.done ? 'is skipping nominations' : 'resumed nominations'}`;
    case 'undo': return 'Commissioner undid the last sale';
    case 'pause': return 'Commissioner paused the draft';
    case 'resume': return 'Commissioner resumed the draft';
    case 'start': return 'Draft started';
    case 'release': return 'Commissioner released a seat';
    case 'complete': return 'Draft complete';
    default: return null;
  }
}

export function ResultsPanel({ state }: RoomProps) {
  const [view, setView] = useState<'sales' | 'activity'>('sales');
  const [historyId, setHistoryId] = useState<number | null>(null);
  const historical = useQuery(api.auction.result, historyId === null ? 'skip' : { lotId: historyId });
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
        {view === 'sales' && state.sales.map(lot => <details className="revealed-lot" key={lot.id}>
          <summary>{findPlayer(state, lot.playerId)?.name ?? lot.playerId} · {lot.status === 'unsold' ? 'Unsold'
            : lot.status === 'undone' ? 'Undone' : `${nameOf(state, lot.highBidderId)} won for ${dollars(lot.highBid)}`}</summary>
          <p>{lot.tied ? 'Tie priority decided this lot.' : ''}</p>
          {lot.bids?.map(bid => <p key={bid.managerId}>{nameOf(state, bid.managerId)}: {bid.amount === 0 ? 'Pass ($0)' : dollars(bid.amount)}{bid.automatic ? ` · ${bid.automatic}` : ''}</p>)}
        </details>)}
        {view === 'sales' ? sales.filter(entry => !state.sales.some(lot => lot.id === entry.lotId)).map(entry => (
          <Fragment key={entry.lotId}><div className="result-row">
            <button className="link" aria-expanded={historyId === entry.lotId}
              onClick={() => setHistoryId(historyId === entry.lotId ? null : entry.lotId)}>
              {findPlayer(state, entry.playerId)?.name ?? entry.playerId}</button>
            <span>{nameOf(state, entry.managerId)}</span>
            <b>{dollars(entry.price)}</b>
          </div>
          {historyId === entry.lotId && <div className="revealed-lot">
            {historical?.bids?.map(bid => <p key={bid.managerId}>{nameOf(state, bid.managerId)}: {bid.amount === 0 ? 'Pass ($0)' : dollars(bid.amount)}</p>)}
          </div>}</Fragment>
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
  const last = state.sales.find(lot => lot.status === 'sold');
  return last ? `Undo ${findPlayer(state, last.playerId)?.name ?? last.playerId} ${dollars(last.highBid)}?` : 'Undo?';
}

export function CommissionerBar({ state, busy, connected, send, pendingControl }: RoomProps & {
  pendingControl?: 'pause' | 'resume' | null;
}) {
  const d = state.draft;
  const latestSale = state.sales.find(lot => lot.status === 'sold');
  if (d.mode !== 'sealed-v1') return null;
  if (d.status === 'setup' || d.status === 'complete') {
    return d.status === 'complete' && latestSale ? (
      <div className="commish">
        <ConfirmButton key={`undo-${latestSale?.id ?? 'none'}`} className="ghost small" label="Undo last sale"
          confirmLabel={undoLabel(state)} disabled={busy}
          onConfirm={() => latestSale && void send({ type: 'undo', lotId: latestSale.id })} />
      </div>
    ) : null;
  }
  return (
    <div className="commish">
      <ConfirmButton key={`undo-${latestSale?.id ?? 'none'}`} className="ghost small" label="Undo last sale"
        confirmLabel={undoLabel(state)} disabled={busy || !latestSale} title="Returns the player and refunds the price, then pauses"
        onConfirm={() => latestSale && void send({ type: 'undo', lotId: latestSale.id })} />
      <button className="secondary small" disabled={busy || !connected} aria-busy={Boolean(pendingControl)}
        title={!connected ? 'Reconnecting…' : undefined}
        aria-describedby={!connected ? 'room-connection-status' : undefined}
        onClick={() => void send(d.status === 'paused'
          ? { type: 'resume', expectedPause: d.controlGeneration }
          : { type: 'pause', expectedRunning: d.controlGeneration })}>
        {pendingControl === 'resume' ? 'Resuming…' : pendingControl === 'pause' ? 'Pausing…'
          : d.status === 'paused' ? 'Resume' : 'Pause'}
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

function QueueAdd(props: RoomProps & { player: Player }) {
  const [amount, setAmount] = useState('');
  const value = amount === '' ? undefined : Number(amount);
  const error = nominationBlocker(props, props.player, value);
  const queued = props.privateSeat?.queue.some(entry => entry.playerId === props.player.id);
  return <form className="queue-add" onSubmit={event => {
    event.preventDefault();
    if (!error) void props.editQueue?.({ type: 'add', playerId: props.player.id, ...(value === undefined ? {} : { amount: value }) });
  }}>
    <input aria-label={`Queue bid for ${props.player.name}`} inputMode="numeric" placeholder="Optional sealed bid"
      value={amount} onChange={event => setAmount(event.target.value)} />
    <button disabled={props.busy || !props.connected || !!error || queued || props.state.draft.status === 'complete'}>
      {queued ? 'Queued' : 'Add to my queue'}</button>
    {error && <span>{error}</span>}
  </form>;
}
function QuickQueue(props: RoomProps & { player: Player }) {
  const { player, privateSeat } = props;
  const queued = privateSeat?.queue.some(entry => entry.playerId === player.id);
  if (maxBid(props.me.budget, player, entriesOf(props.state, props.me.id), props.state.players) < 1) {
    return <small className="blocked">No spot</small>;
  }
  return <button className={`queue-quick ${queued ? 'queued' : ''}`}
    disabled={props.busy || !props.connected || !privateSeat || queued}
    aria-label={queued ? `${player.name} is in your queue` : `Add ${player.name} to your queue`}
    onClick={event => {
      event.stopPropagation();
      void props.editQueue?.({ type: 'add', playerId: player.id });
    }}>
    {queued ? 'Queued' : '+ Queue'}
  </button>;
}
function QueueRow(props: RoomProps & { entry: QueueEntry; index: number; entries: QueueEntry[] }) {
  const { entry, entries, index } = props;
  const [amount, setAmount] = useState(entry.amount === undefined ? '' : String(entry.amount));
  const value = amount === '' ? undefined : Number(amount);
  const valid = value === undefined || Number.isSafeInteger(value) && value >= 1;
  const dirty = value !== entry.amount;
  function move(offset: number) {
    const ids = entries.map(entry => entry.id);
    [ids[index], ids[index + offset]] = [ids[index + offset], ids[index]];
    void props.editQueue?.({ type: 'reorder', ids });
  }
  const name = findPlayer(props.state, entry.playerId)?.name ?? entry.playerId;
  return <li className="queue-row" data-player={entry.playerId}>
    <span className="queue-rank">{index + 1}</span>
    <span className="queue-name">
      <strong title={name}>{name}</strong>
      {entry.reason && <small className="queue-reason">Skipped: {entry.reason}. Kept for your next turn.</small>}
    </span>
    <form onSubmit={event => {
      event.preventDefault();
      if (valid && dirty) void props.editQueue?.({ type: 'edit', id: entry.id, ...(value === undefined ? {} : { amount: value }) });
    }}>
      <label className="money">
        <span aria-hidden="true">$</span>
        <input aria-label={`Queued bid for ${name}`} placeholder="No bid" inputMode="numeric" pattern="[0-9]*" autoComplete="off"
          value={amount} onChange={event => setAmount(event.target.value)} />
      </label>
      <button disabled={props.busy || !valid || !dirty}>Save</button>
    </form>
    <div className="queue-actions">
      <button aria-label={`Move ${name} up`} disabled={props.busy || index === 0} onClick={() => move(-1)}>↑</button>
      <button aria-label={`Move ${name} down`} disabled={props.busy || index === entries.length - 1} onClick={() => move(1)}>↓</button>
      <button aria-label={`Remove ${name}`} disabled={props.busy}
        onClick={() => void props.editQueue?.({ type: 'remove', id: entry.id })}>✕</button>
    </div>
  </li>;
}
export function QueuePanel(props: RoomProps) {
  const entries = props.privateSeat?.queue ?? [];
  return <section className="panel queue" aria-label="My queue">
    <div className="panel-head">
      <h2>My queue · {entries.length}</h2>
      <span>Private · runs only on your turn</span>
    </div>
    <div className="scroll">
      {entries.length ? <ol className="queue-list">{entries.map((entry, index) => <QueueRow {...props}
        key={`${entry.id}:${entry.amount ?? ''}`} entry={entry} index={index} entries={entries} />)}</ol>
        : <p className="empty-note">Empty. Tap <strong>+ Queue</strong> on a player. When your turn starts,
          the first legal player is nominated for you.</p>}
    </div>
    {entries.length > 0 && <p className="queue-foot">An amount becomes your sealed bid. Blank nominates without a bid.</p>}
  </section>;
}
