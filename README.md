# Pancake Auction

A single-page NBA dynasty startup auction for ten managers. Next.js renders the room. Convex stores the draft and supplies live subscriptions. Runtime code reads only the imported database pool.

## Setup

Use Node 24 or later and install dependencies with `npm ci`. These steps initialize a new local league. Preserve the data and claimed seats of an existing league.

Run `npm run backend:local` in one terminal and keep it running. It starts an anonymous local Convex backend without a cloud login. Its private CLI home and persistent database live under the ignored `.convex` directory. The CLI writes the public frontend URL for Next.js. Restarts reuse the same local data. Backend ports default to 3210 and 3211. `CONVEX_LOCAL_CLOUD_PORT` and `CONVEX_LOCAL_SITE_PORT` select different ports when needed.

In another terminal, load the managers, import the pool, and run the readiness check. Then run `npm run dev` and open `http://localhost:3000`. Keep the backend terminal running alongside Next.js. A local production preview uses `npm run build`, then `npm run start -- -p 3000`.

`CONVEX_LOCAL_DIR` optionally selects the generated local deployment configuration directory for admin commands. `CONVEX_URL` or `NEXT_PUBLIC_CONVEX_URL` selects the frontend's backend URL. `NEXT_DIST_DIR` optionally separates build output. No cloud deployment or deploy key is required for local verification.

```sh
npm run backend:local
npm run league:managers
EVIDENCE_DIR=/absolute/path/outside/repo npm run import:sleeper
EVIDENCE_DIR=/absolute/path/outside/repo npm run import:sleeper -- --apply
npm run league:check
npm run dev
npm run seat:release -- --name "<manager name>"
npm run build
npm run start -- -p 3000
EVIDENCE_DIR=/absolute/path/outside/repo npm run verify
EVIDENCE_DIR=/absolute/path/outside/repo npm run sim -- --runs 3 --timing fast --seed 42
EVIDENCE_DIR=/absolute/path/outside/repo npm run sim -- --runs 1 --timing real --seed 42
```

`league/managers.json` contains Michael, Matthew, Justin, Tianna, Kyle, Tyler, Jeremy, Jet, Petch, and Zach. Michael is commissioner. The internal manager loader refuses after the draft starts. The read-only readiness check requires the exact configuration, a completed import with matching pool counts, setup status, no lots, and production 10/10/5/15 timings. Nomination order is randomized at draft start.

Import, manager setup, and CLI recovery call internal functions through the Convex CLI admin path. They are unavailable to public clients. This phase targets local deployments only.

## Local verification

Verification is standalone after `npm ci`; it does not require the companion mini helper or a running development server. Install `agent-browser` and its Chromium browser before browser checks. The lifecycle tests also use `zip`, `unzip`, and standard Unix process tools. A cold backend cache downloads the pinned public Convex binary. Verification does not use a cloud login or fetch from Sleeper.

Set `EVIDENCE_DIR` to an absolute path outside the repository, then run `npm run verify`. Physical containment checks include symlinks, missing suffixes, and final write targets. Each backend scenario and simulation uses an isolated anonymous local backend with its own ports, database, and private CLI home. Cleanup stops owned resources and removes their state. Failed or uncertain teardown preserves state and reports an error. A backend startup failure fails the test.

`verify` runs these twelve commands in order and stops at the first failure:

| Step | Command |
| --- | --- |
| 1 | `npm run typecheck` |
| 2 | `npm run lint` |
| 3 | `npm run test` |
| 4 | `npm run test:local` |
| 5 | `npm run test:db` |
| 6 | `npm run test:ui` |
| 7 | `npm run test:volume` |
| 8 | `npm run build` |
| 9 | `npm run test:layout` |
| 10 | `npm run test:room` |
| 11 | `npm run sim -- --runs 3 --timing fast --seed 1042 --skip-build` |
| 12 | `npm run sim -- --runs 1 --timing real --seed 2042 --skip-build` |

Logs and exit codes go under `EVIDENCE_DIR/verify-<timestamp>/`. Results include browser screenshots, resource-closure records, per-draft summaries, event logs, and the seed spread. `test:local` covers backend startup, caches, locks, deadlines, restart, and cleanup. `test:db` covers real Convex transactions, scheduler guards, claims, auction races, and replay regressions. Browser suites cover the production room, connection, clock, opening bids, controls, and roster layout.

Isolated setup has a 120-second total deadline after the existing 60-second preparation-lock wait. It covers bootstrap, readiness responses, function push, and the smoke query. `AUCTION_BACKEND_SETUP_TIMEOUT_MS` overrides it within 250–300,000 ms. Cached starts normally take a few seconds; the deadline also allows a cold bootstrap download and retries. Teardown uses verified process ownership, bounded signal escalation, and checks that both backend ports close.

Simulations seed the recorded public Sleeper fixture, preserving its original `fetchedAt` and source URLs. They never re-pull data. Ten independent Convex HTTP clients claim seats and call the public API concurrently. A separate process restores a saved token during each run. Bots use seeded valuations, projections, dynasty ADP, manager bias, noise, and positional need. They raise concurrently, snipe, bid exact maximums, give up, or await expiry. Pause and resume carry the observed control generation.

Fast timings are 3/3/+1.5/4.5 seconds; real timings are 10/10/+5/15 seconds. Every draft requires at least 400 accepted bids, 25 expiry sales, three nomination timeouts, and five exact-maximum bids. Average unspent budget must stay below $150, and all 200 active spots must fill. Each draft also proves Taxi and IR wins after active rosters fill, and passes all 18 independent replay invariants.

### Optional mini companion

The companion `../tools/mini-run.sh <label> <command...>` runs checks on a separate Mac mini through existing SSH configuration. It is outside this repository and is optional. Default `verify` and `test:local` commands do not depend on it.

Each helper invocation verifies a source manifest and uses a separate remote source and dependency copy. Evidence returns to `evidence/mini/<label>/<run-id>/artifacts/` beside the repository. Use the printed invocation path rather than label-only logs. The adjacent `retrieval.json` separates the command exit from retrieval validation. Missing or mismatched evidence fails. Cleanup removes the owned run workspace and retains evidence and bounded dependency caches.

The helper's cold binary download has a 120-second total deadline for headers and body. This allows roughly 0.5 MB/s for a 60 MB archive. `MINI_RUN_BACKEND_DOWNLOAD_MS` overrides it within 250–300,000 ms. A valid cached binary needs no download.

`npm run test:helper-download` is an optional regression for that external helper. It requires `../tools/mini-run.mjs`, or `MINI_RUN_HELPER_SOURCE` pointing to the companion module, plus an external `EVIDENCE_DIR`. It uses local HTTP fixtures, real zip/unzip, and a labelled fixture executable. It does not start a real Convex backend. Neither `verify` nor `test:local` invokes it.

## Auction rules

| Rule | Behavior |
| --- | --- |
| Budget | $1,000 per manager; whole-dollar bids; minimum $1. |
| Order | A cryptographically random fixed permutation; straight rotation. |
| Nomination | Ten seconds; player plus opening bid; the nominator makes the first bid. |
| Timeout | With an active opening, nominate the top projected legally available player for $1. Missing projections sort last. With only taxi/IR openings, record a passed turn without marking done. |
| Bid timer | Start at ten seconds. Later accepted bids use `min(old deadline + 5s, Convex now + 15s)`. |
| Late bid | Reject at or after the deadline; resolve the expired lot first. |
| Maximum | Best legal placement: remaining budget minus $1 for each active opening left afterward. Taxi and IR never add reserve. |
| Give up | Everyone except the high bidder may pass. No re-entry on that lot. Managers unable to raise count as out. |
| Award | Award once at expiry, when all others are out, or on commissioner force-end. |
| Placement | Prefer Active, then Taxi, then IR, provided that placement supports the price. Owners can move players until completion. |
| Done | A manager with only taxi/IR openings may stop or resume nominations and continue bidding. |
| Completion | End when no manager can nominate, or all remaining eligible managers pass a cycle without a nomination. |

Active contains PG, SG, SF, PF, C, G, F, three UTIL, and ten bench slots. G accepts PG, SG, or G. F accepts SF, PF, or F. UTIL and bench accept any player. A bipartite matching assigns every active player to a distinct eligible slot. Moves must preserve the matching, capacity, and the budget reserve. They must also preserve any standing high bid.

Taxi has three places. A rookie (`years_exp=0`) qualifies. A non-rookie qualifies with a complete career total below 65 games. A lower bound of 65 or more fails. A smaller incomplete lower bound or missing total is unknown and fails. IR has two places. Only the exact stored injury status `Out` qualifies. `IR`, `DTD`, `GTD`, `Questionable`, `Doubtful`, and null fail.

A manager with a full active roster can still bid and nominate eligible Taxi or Out players. Their maximum is the full remaining budget. With active openings, a taxi/IR placement reserves $1 for every active opening. Taxi and IR can remain empty. Full groups, empty eligible pools, exhausted budgets, explicit Done choices, and a full cycle of timeout passes terminate without deadlock. Each nomination clears the passed-turn cycle. A roster move clears that manager’s earlier pass because their legal nominations can change. Taxi/IR-only teams keep their turns unless they choose Done or have no legal nomination. The event log records each passed turn and the completion reason.

Pause stores the exact remaining milliseconds. Resume adds that amount to the Convex mutation clock. Undo targets the sale shown in its confirmation. A changed latest sale produces a 409 instead of undoing another sale. Undo removes the confirmed sale from its current placement and refunds the price. It returns the player, voids the open lot and all its bids through the lot status, restores the undone nominator, and pauses. It clears the nominator's Done flag and any Done flag made invalid by an active spot reopening. Undo repeats through the sale stack. Bid and event records remain for audit. Automatic awards wait while paused. Resume evaluates expiry and all-out inside the serializable transaction. Force-end awards the current high bid immediately, including while paused.

## Storage and clock

Convex mutations are serializable transactions. Every action validates its seat token, current lot, legal placements, budget, and current draft state inside one mutation. Competing claims, bids, passes, awards, moves, and undos commit atomically. Rule rejections preserve any deadline transition already resolved by that transaction.

A singleton draft document holds the monotonic version and the production timing settings. Each running deadline schedules an internal mutation with draft ID, lot ID, version, and expected deadline. The handler does nothing unless every field still matches and the deadline has passed. Pause invalidates earlier timers. Resume restores the exact frozen remainder and schedules a new timer. Mutation-time `Date.now()` comes from Convex; clients supply no decision clock. Dedicated HTTP samples anchor countdowns to browser monotonic time. A detected forward wall/monotonic gap over one second hides digits until sampling recovers. The status reads "Clock not synced. Retrying…". Ordinary focus and backward corrections keep a valid anchor.

State subscriptions include dynamic draft data and an import revision. A separate pool query subscribes to the imported pool document. Draft changes do not resend that pool. Import revisions come from stored completed imports, so warm clients and separate processes observe refreshes. Current lots also contain player data; missing pool entries retain safe UI fallbacks.

Tables hold drafts, managers, pools, imports, lots, roster entries, passes, and append-only events. All public writes use the engine; no public reset, import, or event-edit function exists. Internal admin functions have narrow setup and recovery purposes. Test fixture functions are copied into isolated test backends only. The scheduler and transactions follow the [Convex mutation](https://docs.convex.dev/functions/mutation-functions), [scheduler](https://docs.convex.dev/scheduling/scheduled-functions), and [local testing](https://docs.convex.dev/testing/convex-backend) documentation.

## Data sources and gaps

The explicit importer makes fifteen sequential public requests with a descriptive User-Agent and a small delay. Dry-run performs no database writes. With `EVIDENCE_DIR`, it saves a public response snapshot outside the repository. Snapshots and individual source caches store their original fetch time. Apply reuses them for less than 24 hours from that time; reuse never updates their age or file. This avoids a second players request. Without an evidence directory, each invocation fetches again. Sleeper asks callers to fetch the players endpoint at most once per day and stay below 1,000 calls per minute. The internal import mutation refuses after any lot exists or the state leaves setup. There is no override. All player updates and the import record commit together.

Sources:

- [Sleeper API documentation](https://docs.sleeper.com/).
- Players: `https://api.sleeper.app/v1/players/nba`.
- Undocumented public Rotowire projections: `https://api.sleeper.app/projections/nba/2026?season_type=regular`.
- Thirteen career seasons: `https://api.sleeper.app/v1/stats/nba/regular/<season>`, for 2013 through 2025.

Players require a valid PG/SG/SF/PF/C fantasy position, an active flag, and a team, projection, or dynasty ADP. Defense entries are excluded. Display positions do not replace fantasy eligibility. Source ADP values, including zero values, are preserved. Some active free agents have ADP without a stat forecast and therefore remain in the pool.

None of the snapshot’s 1,858 ADP values are non-positive, so zero is not established as a valid rank. Real ranks span 1.3–699; 1,022 entries jump to the 999 sentinel, including 1,016 imported pool players. Null, non-positive, and ≥999 values show “?” with an “Unranked by Sleeper” tooltip, sort last, and add no ADP valuation.

Projected stats are per game. Scoring is PTS +1, REB +1, AST +2, STL +4, BLK +4, 3PM +1, FGM +2, FGA −1, FTM +1, FTA −1, TO −2. Sleeper calls threes `tpm` and turnovers `to`. The supplied scoring example produces 41. A missing stat line produces a null projection, displayed as “no projection.” Raw stats and dynasty ADP stay stored. Age uses Sleeper age first, then a valid birth_date at import time. Missing age and birth_date produce “age unknown.”

Career games sum regular-season `gp`. A present record with absent or null `gp` contributes zero. Trade schedules can produce more than 82 games for a player in a season. Records before 2013 are unavailable. Coverage is complete when `2026 − years_exp >= 2013`. Older players retain a partial lower bound. No unknown or incomplete total qualifies a non-rookie for taxi. Eligibility and injuries use the stored snapshot throughout the draft; there are no live injury updates.

## Identity

The first device to claim a seat receives 256 random bits. The database stores only the SHA-256 hash. The browser keeps the token in localStorage and passes it explicitly to Convex identity queries and mutations. Refresh and reconnect preserve identity. Actions derive the manager from the token; clients do not supply an acting manager ID. Release invalidates the previous token. The commissioner sees claimed seats and can release them. The release CLI provides recovery if the commissioner loses their device.

Anyone with the link can claim an unclaimed seat first. There is no authentication beyond possession of the seat token. Share the link with the league only. Browser storage is part of the trust model. Mutations require the seat token; they do not use ambient cookie authority.

## Sleeper references and league differences

[Sleeper auction support](https://support.sleeper.com/en/articles/4056268-do-you-support-auction-drafts) and the [auction overview](https://sleeper.com/blog/auction-draft/) describe rotating nominations, the opening bid, a $1 increment, and awarding the highest bid when time expires. Sleeper resets bids under ten seconds to ten seconds. This league chooses +5 seconds, capped at fifteen. Sleeper blocks full draft columns and allows commissioner pause and undo. Sleeper resets its timer on resume. This app restores the remaining time.

Sleeper does not document the maximum-bid formula. Its screenshots and completed drafts support the inference `remaining − (open draft slots − 1)`. Startup taxi rounds count as draft slots there; IR adds none. This league reserves only active places. Sleeper's [taxi rules](https://support.sleeper.com/en/articles/3640482-how-do-taxi-squads-work) do not allow drafting directly to taxi or IR. This app supports those placements. Sleeper does not document nomination-timeout behavior. This app uses the league's automatic nomination rule.

The league PDF restricts taxi to drafted first-year rookies and disallows undrafted rookies. The card and group chat allow rookies or fewer than 65 career games. This app implements the card. The PDF names ESPN for positions. This app uses Sleeper positions, as requested.

## Draft room

One full-screen page uses panel scrolling without document scrolling. Wide screens show Players, the auction block, Teams, Results, and My roster. At 1219 px and below, Players, My roster, and Results use tabs beside the auction block and Teams. At 860 px and below, all four tabs sit below the auction block. The Players tab opens when a new nomination turn starts.

My roster shows 10 starter rows, 10 Bench rows, 3 Taxi rows, and 2 IR rows. Every empty spot shows a muted Open placeholder, including on mobile. An occupied player replaces a placeholder rather than adding a row. Group counts supplement the rows. If active matching is unavailable, the fallback still shows all 20 active spots.

Activate a team-name button or its visible chevron to inspect that roster below the team row. Enter and Space work too. Only one team roster opens at a time; activating the same team closes it. Inspected rosters use the same occupied and empty slots, player details, and panel scrolling. They are read-only, including when inspecting your own team. My roster retains placement controls. Below 390 px, a commissioner's Release control sits inside the expanded team row.

Player rows show positions, team, age, career games, projection, dynasty ADP, injury, and taxi tags. Player details show the projected stat line and eligibility reasons. Unknown values show "?" in table cells and explicit text in the lot line and details. A winner can move a player to any legal group from My roster or the win banner. Undo, Force end, and seat release require confirmation.

## Delivery boundaries

No deployment, push or PR is part of this stage. Use `league:check` before starting the live draft. Verification data never enters a cloud deployment.

## Compact-screen regression checks

`npm run test:layout` uses the stored real player pool and a separate headless Chromium browser.
The browser harness loads built production fonts when available; roster checks also exercise fallback fonts.
It checks the desktop layout boundary and all four phone tabs with Giannis details open and closed.
At 390×667 and 390×844, each selected tab keeps at least 100 pixels of scroll space.
Player information scrolls inside the auction block while the normal bid controls remain visible.
