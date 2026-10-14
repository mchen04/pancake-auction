# Pancake Auction

A single-page NBA dynasty startup auction for ten managers. Next.js App Router and PostgreSQL run the room. Vercel route handlers use the Node runtime. Clients poll every 500 ms. No accounts, workers, sockets, cron, ORM, or runtime sports API calls are required.

## Setup

Use Node 24 or later and a Neon database. Install dependencies with `npm ci`. Set `DATABASE_URL` for migrations and CLIs. Set `DATABASE_URL_POOLED` for the app. Set `DB_SCHEMA` to choose the schema; its default is `auction`.

Local CLIs read the authorized file `/Users/michaelchen/.config/pancake-auction/.env`. `PANCAKE_AUCTION_ENV_FILE` selects another authorized file. Neither URL belongs in the repository. On Vercel, set the two URLs and `DB_SCHEMA` as environment variables. Production cookies use HTTPS. `NEXT_DIST_DIR` optionally separates local production builds; its default is `.next`. `SEAT_COOKIE_SECURE=false` supports local HTTP simulations.

```sh
npm run migrate
EVIDENCE_DIR=/absolute/path/outside/repo npm run import:sleeper
EVIDENCE_DIR=/absolute/path/outside/repo npm run import:sleeper -- --apply
npm run league:managers
npm run league:check
npm run dev
```

`league/managers.json` contains the confirmed names: Michael, Matthew, Justin, Tianna, Kyle, Tyler, Jeremy, Jet, Petch, and Zach. Michael is commissioner. Tests, simulations, and browser checks use the same file in isolated schemas. Nomination order is randomized when the draft starts.

The manager loader uses this file by default. `--file /path/managers.json` can supply another valid ten-name configuration before the draft starts. The read-only readiness check requires the exact confirmed names and commissioner, applied migrations, a completed import with matching counts, setup status, no lots, and 10/10/5/15 production timings. Replacing a configuration before starting releases previous seat claims.
```sh
npm run seat:release -- --name "<manager name>"
npm run build
npm run start -- -p 3000
EVIDENCE_DIR=/absolute/path/outside/repo npm run verify
EVIDENCE_DIR=/absolute/path/outside/repo npm run sim -- --runs 3 --timing fast --seed 42
EVIDENCE_DIR=/absolute/path/outside/repo npm run sim -- --runs 1 --timing real --seed 42
```

`verify` runs typecheck, lint, unit tests, database tests, production build, three fast full drafts, and one real-timing full draft. It records each exit code and log path. Simulations build and start the production app on a free port. They copy the live imported pool into fresh `sim_*` schemas. Without an import, they label the synthetic fallback. Ten independent HTTP clients claim ten seats and poll concurrently. A separate process restores a saved seat token during each run. The event replay checker independently recomputes budgets, matching, eligibility, bidding, timers, sales, placement moves, and turn rotation.

Tests use `test_*` schemas and recorded import fixtures. They never call Sleeper. Both tools drop their own schemas, even on failure. `--keep-schema` preserves a schema for inspection. Fast timing uses 10/5/5/15 seconds; the shorter opening bid window speeds timeout scenarios. Real timing uses 10/10/5/15 seconds. Database tests exercise real nomination and bid expiry. Synthetic fixture setup uses longer clocks for unrelated races.

## Auction rules

| Rule | Behavior |
| --- | --- |
| Budget | $1,000 per manager; whole-dollar bids; minimum $1. |
| Order | A cryptographically random fixed permutation; straight rotation. |
| Nomination | Ten seconds; player plus opening bid; the nominator makes the first bid. |
| Timeout | With an active opening, nominate the top projected legally available player for $1. Missing projections sort last. With only taxi/IR openings, record a passed turn without marking done. |
| Bid timer | Start at ten seconds. Later accepted bids use `min(old deadline + 5s, database now + 15s)`. |
| Late bid | Reject at or after the deadline; resolve the expired lot first. |
| Maximum | Best legal placement: remaining budget minus $1 for each active opening left afterward. Taxi and IR never add reserve. |
| Give up | Everyone except the high bidder may pass. No re-entry on that lot. Managers unable to raise count as out. |
| Award | Award once at expiry, when all others are out, or on commissioner force-end. |
| Placement | Prefer Active, then Taxi, then IR, provided that placement supports the price. Owners can move players until completion. |
| Done | A manager with only taxi/IR openings may stop or resume nominations and continue bidding. |
| Completion | End when no manager can nominate, or all remaining eligible managers pass a cycle without a nomination. |

Active contains PG, SG, SF, PF, C, G, F, three UTIL, and ten bench slots. G accepts PG, SG, or G. F accepts SF, PF, or F. UTIL and bench accept any player. A bipartite matching assigns every active player to a distinct eligible slot. Moves must preserve the matching, capacity, and the budget reserve. They must also preserve any standing high bid.

Taxi has three places. A rookie (`years_exp=0`) qualifies. A non-rookie qualifies with a complete career total below 65 games. A lower bound of 65 or more fails. A smaller incomplete lower bound or missing total is unknown and fails. IR has two places. Only the exact stored injury status `Out` qualifies. `IR`, `DTD`, `GTD`, `Questionable`, `Doubtful`, and null fail.

A manager with a full active roster can still bid and nominate eligible Taxi or Out players. Their maximum is the full remaining budget. With active openings, a taxi/IR placement reserves $1 for every active opening. Taxi and IR can remain empty. Full groups, empty eligible pools, exhausted budgets, explicit Done choices, and a full cycle of timeout passes terminate without deadlock. Each nomination clears the passed-turn cycle. Taxi/IR-only teams keep their turns unless they choose Done or have no legal nomination. The event log records each passed turn and the completion reason.

Pause stores the exact remaining milliseconds. Resume adds that amount to the database clock. Undo removes the most recent live sale from its current placement and refunds the price. It returns the player, voids the open lot and all its bids through the lot status, restores the undone nominator, clears that manager's done flag, and pauses. Undo repeats through the sale stack. Bid and event records remain for audit. Force-end awards the current high bid immediately, including while paused.

## Database and clock

Every mutation locks the singleton draft row in one transaction. It validates the current lot ID and the seat token. Expired reads acquire the same lock and advance the room. Reads with no expired deadline use a consistent database snapshot without locking the draft row. The immutable player pool is cached from PostgreSQL while drafting. Polls can omit that pool after the first response. No decision uses a client or app-server clock. Responses include the database time for countdown display.

Constraints enforce one open lot, one live sale per player, unique passes, and increasing bids. Events record every nomination, bid, pass, sale, placement, pause/resume, undo, and force-end. Database timestamps and decision times permit replay. A trigger rejects event updates and deletes. Plain SQL migrations track applied filenames in the selected schema.

## Data sources and gaps

The explicit importer makes fifteen sequential public requests with a descriptive User-Agent and a small delay. Dry-run performs no database writes. With `EVIDENCE_DIR`, it saves a public response snapshot outside the repository. Apply reuses that snapshot within 24 hours. This avoids a second players request. Without an evidence directory, each invocation fetches again. Sleeper asks callers to fetch the players endpoint at most once per day and stay below 1,000 calls per minute. Apply locks the draft and refuses after any lot exists or the state leaves setup. There is no override. All player updates and the import record commit together.

Sources:

- [Sleeper API documentation](https://docs.sleeper.com/).
- Players: `https://api.sleeper.app/v1/players/nba`.
- Undocumented public Rotowire projections: `https://api.sleeper.app/projections/nba/2026?season_type=regular`.
- Thirteen career seasons: `https://api.sleeper.app/v1/stats/nba/regular/<season>`, for 2013 through 2025.

Players require a valid PG/SG/SF/PF/C fantasy position, an active flag, and a team, projection, or dynasty ADP. Defense entries are excluded. Display positions do not replace fantasy eligibility. Source ADP values, including zero values, are preserved. Some active free agents have ADP without a stat forecast and therefore remain in the pool.

Projected stats are per game. Scoring is PTS +1, REB +1, AST +2, STL +4, BLK +4, 3PM +1, FGM +2, FGA −1, FTM +1, FTA −1, TO −2. Sleeper calls threes `tpm` and turnovers `to`. The supplied scoring example produces 41. A missing stat line produces a null projection, displayed as “no projection.” Raw stats and dynasty ADP stay stored. Age uses Sleeper age first, then a valid birth_date at import time. Missing age and birth_date produce “age unknown.”

Career games sum regular-season `gp`. A present record with absent or null `gp` contributes zero. Trade schedules can produce more than 82 games for a player in a season. Records before 2013 are unavailable. Coverage is complete when `2026 − years_exp >= 2013`. Older players retain a partial lower bound. No unknown or incomplete total qualifies a non-rookie for taxi. Eligibility and injuries use the stored snapshot throughout the draft; there are no live injury updates.

## Identity

The first device to claim a seat receives 256 random bits. The database stores only the SHA-256 hash. The browser receives an httpOnly SameSite=Lax cookie and keeps a token copy in localStorage for cookie recovery. Refresh and reconnect preserve identity. Actions derive the manager from the token; clients do not supply an acting manager ID. Release invalidates the previous token. The commissioner sees claimed seats and can release them. The release CLI provides recovery if the commissioner loses their device.

Anyone with the link can claim an unclaimed seat first. There is no authentication beyond possession of the seat token. Share the link with the league only. Browser storage is part of the trust model. Origin checks reject cross-origin writes.

## Sleeper references and league differences

[Sleeper auction support](https://support.sleeper.com/en/articles/4056268-do-you-support-auction-drafts) and the [auction overview](https://sleeper.com/blog/auction-draft/) describe rotating nominations, the opening bid, a $1 increment, and awarding the highest bid when time expires. Sleeper resets bids under ten seconds to ten seconds. This league chooses +5 seconds, capped at fifteen. Sleeper blocks full draft columns and allows commissioner pause and undo. Sleeper resets its timer on resume. This app restores the remaining time.

Sleeper does not document the maximum-bid formula. Its screenshots and completed drafts support the inference `remaining − (open draft slots − 1)`. Startup taxi rounds count as draft slots there; IR adds none. This league reserves only active places. Sleeper's [taxi rules](https://support.sleeper.com/en/articles/3640482-how-do-taxi-squads-work) do not allow drafting directly to taxi or IR. This app supports those placements. Sleeper does not document nomination-timeout behavior. This app uses the league's automatic nomination rule.

The league PDF restricts taxi to drafted first-year rookies and disallows undrafted rookies. The card and group chat allow rookies or fewer than 65 career games. This app implements the card. The PDF names ESPN for positions. This app uses Sleeper positions, as requested.

## Delivery boundaries

The full-screen desktop page has independently scrolling pool, teams, sales, and roster panels. Narrow screens use horizontal panels. This is the functional first pass; a separate visual refinement follows. No deployment, push, PR, or commit is part of this build. The live league is configured with the confirmed names; use `league:check` before starting. Verification data never enters the live schema.
