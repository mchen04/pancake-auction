# Pancake Auction

Pancake Auction runs Normal live auctions or Blind sealed-bid auctions, one player at a time.
Convex owns deadlines, bids, roster checks, and awards.
The Next.js room uses trusted seat selection and subscriptions. Ten managers start with $1,000 each.

## Setup

Use Node 24 or later. Install dependencies with `npm ci`.
These steps initialize a new local league. Preserve the data of an existing league.

Start the local backend in one terminal and keep it running:

```sh
npm ci
npm run backend:local
```

The backend runs anonymously without a cloud login.
Its private CLI home and persistent database live under the ignored `.convex` directory.
The CLI writes the public backend URL for Next.js. Restarts reuse the same local data.
Backend ports default to 3210 and 3211. Set different ports if those ports are occupied:

```sh
CONVEX_LOCAL_CLOUD_PORT=3220 CONVEX_LOCAL_SITE_PORT=3221 npm run backend:local
```

In another terminal, load the managers and preview the import before applying it:

```sh
export EVIDENCE_DIR=/absolute/path/outside/repo
npm run league:managers
npm run import:sleeper
npm run import:sleeper -- --apply
npm run league:check
npm run dev
```

The first import command is a dry run with no database writes. `--apply` writes the imported pool.
Both commands use the same evidence directory to reuse the recorded source data within 24 hours.
Manager setup and import require an empty draft in setup.
The readiness check requires ten configured managers, a completed import, no lots, and the chosen mode’s default timings.
The commissioner chooses Normal or Blind above **Start draft**. New drafts default to Blind.
Changing mode resets its timings. Starting locks the mode for the rest of the draft.

Open `http://localhost:3000`. Keep the backend running alongside Next.js.
Use `npm run dev -- -p 3001` or set `PORT` to select another frontend port.
A local production preview uses `npm run build`, then `npm run start -- -p 3000`.
The backend must remain running for that preview too.

To forget a device token saved by the earlier exclusive-seat build, run:

```sh
npm run seat:release -- --name "<manager name>"
```

Manager setup, import, readiness, and token release use the local Convex CLI admin path.
Their internal functions are unavailable to public clients.

| Variable | Purpose |
| --- | --- |
| `EVIDENCE_DIR` | Absolute directory outside the repository for import snapshots and verification evidence. |
| `CONVEX_LOCAL_DIR` | Generated deployment configuration directory for admin commands; defaults to `.convex/local/default`. |
| `CONVEX_LOCAL_CLOUD_PORT` | Local backend API port; defaults to 3210. |
| `CONVEX_LOCAL_SITE_PORT` | Local backend site port; defaults to 3211 and must differ from the API port. |
| `CONVEX_URL` | Backend URL used by Next.js; takes precedence over `NEXT_PUBLIC_CONVEX_URL`. |
| `NEXT_PUBLIC_CONVEX_URL` | Backend URL used when `CONVEX_URL` is unset; local setup supplies it. |
| `NEXT_DIST_DIR` | Optional Next.js output directory; defaults to `.next`. Use the same value for build and start. |
| `PORT` | Next.js frontend port; defaults to 3000. The `-p` command option can also select it. |

## Auction rules

Both modes use ten managers and one randomized, fixed nomination order.
Keep all ten names in `league/managers.json`. Michael is the commissioner.
Only the commissioner can change mode, while setup has no lots or roster entries.
Other managers see the choice. The selector disappears after Start.

### Normal (`live-v1`)

| Rule | Behavior |
| --- | --- |
| Nomination window | 10 seconds. Choose a player and a required opening bid from $1 to the legal maximum. |
| First bidder | The nominator leads at the opening amount. |
| Nomination timeout | With an active opening, nominate the highest-projected legal player at $1. |
| Reserve-only timeout | With only Taxi or IR openings, pass the turn without marking Done. |
| Bid window | Starts at 10 seconds. Each accepted bid sets `min(old deadline + 5 seconds, now + 15 seconds)`. |
| Bid | Whole dollars above the current high bid, up to the legal maximum. |
| Give up | Anyone except the leader can leave the lot. No re-entry. A maximum at or below the high bid also counts as out. |
| Award | Sell once at expiry, when all other managers are out, or on commissioner Force end. |
| Late bid | Resolve an expired lot first, then reject the stale bid. |
| Done | With 20 active players, stop or resume nominations. Bidding remains available. |
| Completion | End when no manager can nominate, or every remaining eligible manager passes a full cycle without a nomination. |
| Visibility | Show the live high bid, leader, give-ups, sales, and activity. No private queue or tie priority. |

The opening stepper defaults to $1 and clamps to the legal maximum.
Bid controls offer +$1, +$5, a custom amount, Use max, and Give up.
The shot clock shows tenths below 10 seconds and becomes urgent below four seconds.

### Blind (`sealed-v1`)

| Rule | Behavior |
| --- | --- |
| Managers | Keep all ten names in `league/managers.json`. Michael is the commissioner. |
| Nomination order | Start randomizes one fixed order. Turns follow that order throughout the draft. |
| Nomination window | Each turn has 24 hours. Manual nominations can include an optional positive whole-dollar sealed bid. |
| Nomination timeout | Nominate the highest-projected legally available player, with no attached bid. |
| Bid window | Each lot has one fixed 24-hour deadline. Responses never extend it. |
| Response | Each eligible manager submits one final positive whole-dollar bid or explicit Pass ($0). No edits or re-entry. |
| Automatic pass | Managers without a legal placement or affordable $1 bid pass automatically. |
| Resolution | Resolve when all managers have responded, including automatic passes, or when the deadline arrives. Missing responses become passes. |
| Price | The highest positive bidder wins and pays their own bid. |
| Ties | Priority starts as the reverse nomination order. The highest-priority tied bidder wins and moves to the bottom. |
| Other wins | A non-tie win leaves priority unchanged. All-zero responses do not rotate priority. |
| All pass | The player stays available. The next eligible manager gets the nomination turn. |
| Done | A manager with 20 active players and open Taxi or IR places can stop nominations. They can still bid. |
| Completion | End only when no manager can legally nominate. Done managers skip nominations; other managers need an affordable legal available player. |

No-sale rotations continue while any manager can nominate. Unsold players remain available for later turns.
Each turn receives the normal 24-hour nomination window unless its owner has a legal queue entry.
A queue nominates at most one player per turn. A nomination without an amount waits for responses or its 24-hour deadline.
The nominator is eligible, so automatic passes from other managers cannot instantly resolve that blank nomination.
An immediate queued resolution requires a positive attached bid and consumes a roster place.
Each mutation permits at most one initial resolution plus one resolution per league roster place.

Taxi/IR-only nomination timeouts nominate a legal player without a bid. Done remains an explicit choice.

## Rosters and budget

Active has 20 places: PG, SG, SF, PF, C, G, F, three UTIL, and ten Bench.
G accepts PG, SG, or G. F accepts SF, PF, or F. UTIL and Bench accept any position.
A full matching must place every active player into a distinct legal spot.

Taxi has three places. Rookies qualify. Non-rookies need a complete career count below 65 games.
An incomplete count, unknown count, or count of at least 65 fails.
IR has two places. Only the exact stored injury status `Out` qualifies.

A bid must leave $1 for each active opening after placement. Taxi and IR add no reserve.
The server checks the best legal placement at submission. It prefers Active, then Taxi, then IR when awarding.
Roster moves must preserve eligibility, capacity, and reserve.
Normal moves cannot invalidate the owner's standing high bid. Blind moves must preserve the owner's positive sealed response.
In Blind, removing all legal placements gives an unresponded manager an automatic pass.
Automatic passes remain final if a later move changes eligibility.
Opening an active spot clears an invalid Done choice.

## Blind private responses and queues

These features apply only to Blind. Normal rejects queue edits and returns no private response or queue.
Public state shows each manager as Responded or Waiting. It does not distinguish a bid from a pass.
Open lots contain zero placeholders in legacy `highBid` and `highBidderId` fields. They never contain a submitted amount.
There are no bid or pass events before resolution. The public nomination event contains no initial amount or legal maximum.
Resolution publishes every manager's response, including automatic and deadline passes, plus the winner and price.
Results expands each recent lot to show those responses. Older sales load their bids on demand through `auction:result`.
That indexed query returns nothing for open or void lots.

`auction:privateSeat` requires a seat reference. It returns only that seat's current response and nomination queue.
It uses indexed owner lookups. The commissioner has no private-data override.
Every device on the same seat sees the same queue and final response; the response stays final from any device.

Tap **+ Queue** on a player row, or open a player's details to add them with an amount.
Each entry has a player and an optional positive whole-dollar amount. Blank means no attached response.
There is no queue Pass. Add, edit, remove, and reorder controls apply only to your queue.
Queues hold at most 100 distinct players. They run only on the owner's nomination turn.
They never bid on another manager's nomination.

The first legal entry nominates automatically. A valid attached amount becomes the owner's final sealed response.
A blank amount leaves that response open. Queue amounts are never clamped or changed silently.
Both enqueue and execution check availability, legal placement, budget, and reserve.
Unavailable, unaffordable, and ineligible entries stay in place with an owner-only skip reason.
They are checked again on the next turn. Successful entries are consumed.
Editing or adding a legal queue entry during your active nomination turn can execute it immediately.
Paused queues wait until resume. Empty queues receive the normal 24-hour manual nomination window.

## Pause, undo, and commissioner controls

Only the commissioner chooses the mode, starts, pauses, resumes, forces an award, or undoes.
Pause stores the exact remaining milliseconds. Resume creates a deadline from that remainder.
Bids and nominations are unavailable while paused. Blind queue edits and legal roster moves remain available.
Normal **Force end** requires two clicks confirming the current leader and amount. It also works while paused.
Blind has no Force end control.

Undo targets the latest sold lot shown in its confirmation. A stale target fails.
Undo refunds its price, removes its roster entry, returns to its nominator, and pauses.
Normal clears invalid Done flags, resumes the nominator, and grants a fresh 10-second nomination window on resume.
Blind restores the priority list from before the sale and grants a fresh 24-hour window.
Both modes void an open subsequent lot. In Blind, those unrevealed responses never enter public results.
Previously revealed responses remain public. A re-nomination creates a new lot and requires new responses.
Consumed queue entries stay consumed, including entries used for a voided lot. Undo does not reconstruct private queues.
Blind undo clears invalid Done choices. Legacy sales cannot use undo.

## Deadlines and subscriptions

Convex serializes every mutation. Both modes share one guarded expiry path.
Deadline transitions persist even when the action that discovers them fails a rule check.
Each deadline job carries the draft ID, lot ID, version, and expected deadline.
A mismatch, paused draft, legacy draft, or early invocation does nothing.
Pause, resume, new turns, and new lots invalidate stale jobs. Repeated calls cannot double-award.
Ordinary actions without a deadline change do not schedule replacement jobs.

Public state contains the dynamic draft, roster, recent results, and events.
A separate query subscribes to the imported player pool. Draft changes do not resend that pool.
Blind’s private subscription returns only the caller’s queue and response.
Blind updates its hours-and-minutes display once per minute, using the device clock without clock-sync requests.
Normal samples `auction:syncTime` and corrects its shot clock for the server offset.
The top bar shows syncing or retry status until a usable sample arrives.
The stored deadline and Convex clock decide acceptance in both modes.
An incorrect device clock cannot change a deadline or make a late response valid.

## Schema compatibility and migration

The schema retains all legacy tables and required field types, including `passes`, live-lot price fields, and old timing fields.
New draft mode, priority, lot response metadata, result bids, and event markers are optional.
The new `responses` and `queues` tables do not alter existing documents.
Adding indexes does not require document rewrites. Schema changes do not wipe data or start a draft.
Normal uses `passedTurns` for full-cycle completion. Blind ignores it.
Previously completed drafts with `completionReason: full-cycle-unsold` still load and show an earlier-rules label.
They are not reopened automatically.

The optional mode field accepts `sealed-v1` and `live-v1`. Existing sealed drafts keep Blind behavior.
A draft without a mode is legacy. Running, paused, and completed legacy drafts remain read-only.
Scheduled jobs also ignore them. Their old event payloads are not returned publicly.
An open legacy lot exposes no standing amount through public state.
The commissioner must arrange an explicit migration for an in-progress legacy draft; no automatic conversion exists.

An untouched legacy setup opens the setup room. Selecting a mode converts it to that mode’s defaults.
Start without a selection converts legacy setup to Blind.
Both actions refuse a legacy setup containing any lot or roster entry.
Choosing Blind or starting a legacy setup enables its queue controls.
Legacy roster placement controls remain hidden.

`league:managers` upgrades an empty legacy setup record to Blind defaults and preserves an already chosen mode.
It refuses when any lot or roster entry exists or the draft has left setup.
It preserves manager identities. Starting remains a separate commissioner action.
`league:check` requires ten managers, a completed import, and the chosen mode’s defaults.
Normal requires 10-second nomination, 10-second bidding, 5-second extension, and a 15-second cap.
Blind requires 24-hour nomination and bidding, no extension, and a 24-hour cap.

## Player data and nomination ranking

The importer stores the real Sleeper player pool and Rotowire forecasts exposed through Sleeper.
Auto-nomination sorts the stored `projection` field descending, then player ID ascending for equal values.
Missing projections sort last. It excludes sold players and players the nominator cannot legally afford or place.
It never generates a projection. Normal timeout nominations open at $1; Blind timeout nominations attach no bid.

The recorded verification fixture was fetched on 2026-10-14 at 21:21 UTC.
Tests retain that timestamp and its source URLs. Unit and import-regression fixtures with invented players are marked as synthetic.
The full draft and browser suites use `tests/fixtures/sleeper-pool.json`.

Sources:

- Players: `https://api.sleeper.app/v1/players/nba`.
- Projections: `https://api.sleeper.app/projections/nba/2026?season_type=regular`.
- Career seasons: `https://api.sleeper.app/v1/stats/nba/regular/<season>`, 2013 through 2025.

Projected scoring is PTS +1, REB +1, AST +2, STL +4, BLK +4, 3PM +1, FGM +2, FGA −1, FTM +1, FTA −1, TO −2.
Missing forecasts remain null. Raw projected stats and dynasty ADP remain stored.
Null, non-positive, and at least 999 ADP values display as unranked and sort last.
Career coverage is complete when `2026 − years_exp >= 2013`. Older players retain an incomplete lower bound.
Injuries and eligibility use the imported snapshot throughout the draft.

The importer performs fifteen sequential public requests. Dry-run writes no database data.
Its external cache retains the original fetch time and expires after 24 hours. Reuse does not extend that age.
Import is refused after any draft activity. Verification uses recorded data and local HTTP fixtures, without source-network requests.

## Identity and installation

This league trusts its managers. Anyone with the link picks a name from the list; there is no password, code or lock,
so a manager can open their team on several phones, browsers or the installed app at once, and could pick another name.
This is trusted identity selection, not authentication. Share the link only with the league.
Selecting a name returns the nonsecret seat reference `seat:<manager id>`. The browser remembers it in localStorage,
and mutations derive the acting manager from it. Tapping your name in the top bar switches manager.
The first selection marks a manager as joined. Sealed amounts never appear in public state, whichever name is selected.
A 256-bit device token saved by the earlier exclusive-seat build still opens its seat and is converted on load.

The room is one screen tall on desktop, tablet and phone, including the installed web app. The page itself never scrolls; only panels do.
The top bar always shows your name, budget left and active roster count. The current-player card keeps the deadline,
live leader or response count, and the bid, pass and nomination controls on screen, including short and landscape phones.
Desktop shows players, current player, teams, results and roster together. Blind also shows the private queue.
Narrower screens put Players, Teams (phone), My roster and Results tabs along the bottom edge.
Blind adds a Queue tab with its entry count.
On phones the selected panel fills the space between the top bar and the current-player card, and the card sits just
above the tabs, so the bid, Pass and nomination controls stay within thumb reach. The phone top bar drops the wordmark.
Blind Teams shows tie priority from highest to lowest. Normal Teams shows the leader, give-ups, and who can still raise.
My roster retains 20 active, three Taxi, and two IR rows, including empty places.
Player search, positions, projections, detailed stats, roster inspection, and placement controls remain available.

A web manifest adds the Pancake name, two PNG icons, theme colors, and `display: standalone`.
Apple web-app metadata and an Apple touch icon support Safari installation.
The icon (a basketball on a syrup pancake stack, on an opaque dark background) is drawn in `public/icon.svg`.
`apple-touch-icon.png` (180), `icon-192.png`, `icon-512.png` and `favicon.ico` are opaque renders of that file,
for example `rsvg-convert -w 180 -h 180 public/icon.svg`, flattened to RGB.
The layout includes safe-area padding and dynamic viewport height. Installation adds no offline bidding or background response automation.
The `emulated-standalone` CSS class is a layout-only test hook. It changes no auction behavior.
Safe-area insets flow through the `--safe-top`, `--safe-right`, `--safe-bottom` and `--safe-left` CSS variables,
so layout tests can apply iPhone insets.

### Updates

There is no service worker: the page is rendered per request and never cached, and its scripts have content-hashed names.
Each build carries a version, a hash of `app/`, `lib/`, `public/`, `convex/_generated/`, `next.config.ts` and
`package-lock.json` (`PANCAKE_APP_VERSION` overrides it, for tests). `/version.json` serves the live build's version.
When the app is opened, shown again, focused, or comes back online, it compares the two and reloads once to the new build.
It waits while an amount is typed but not sent, a text field is focused, or a request is in flight.
This includes Normal custom bids and opening amounts. It applies when the
edit ends or on the next open. A failed or offline check changes nothing. At most two reloads toward one version happen in
ten minutes, so a stale page can never loop. The saved seat and other stored data are untouched.
An update reaches phones only once it is deployed. A page opened before the updater shipped has no updater; it picks it up
the next time it is fully reloaded or reopened after being closed.

## Local verification

Verification creates its own backends and frontend servers after `npm ci`.
Install `agent-browser` and its Chromium browser before browser checks.
The lifecycle tests also require `zip`, `unzip`, and standard Unix process tools.
Set `EVIDENCE_DIR` to a directory outside the repository. All test receipts and screenshots belong there.
The isolated harness starts anonymous local Convex with fresh state and free ports.
It passes an explicit local URL and a freshly generated local backend key to normal project tooling.
It never chooses a cloud deployment or reads account credentials.
Test fixture functions are copied into isolated backend directories only. They are absent from the deployed `convex/` source.
Simulated clock and shortened deadline controls exist only in those copied fixtures.

| Command | Coverage |
| --- | --- |
| `npm run typecheck` | TypeScript checks. |
| `npm run lint` | ESLint, without warnings. |
| `npm test` | Both mode defaults and rendering, clock samples, timer arithmetic, replay failures, sealed rules, roster, imports, and client retry. |
| `npm run test:local` | Local backend startup, cleanup, cache, ownership, network, and deadline harness regressions. |
| `npm run test:db` | Both engines, mode validation, legacy gates, trusted seats, races, timers, undo, queues, ties, privacy, and completion. |
| `npm run test:live` | Normal database rules, stale turns, Done, timers, and races. |
| `npm run test:live-client` | Normal opening bids, stale tabs, clock delays and jumps, nomination replay, and rendering controls. |
| `npm run test:volume` | Player-pool subscription delivery remains separate from dynamic state. |
| `npm run build` | Production Next.js build. |
| `npm run test:layout` | Roster slots, placements, keyboard controls, compact layouts, and reconnect/pool-loading regressions. |
| `npm run test:room` | Production room follows a setup import and recovers from a real query failure. |
| `npm run test:ui` | Both rooms through Chromium by default: controls, another device, refresh, and the full one-page size matrix. Screenshots include 390×844 standalone, 375×667, and 1440×900. |
| `AUCTION_BROWSER=safari npm run test:ui` | Real Safari through a separate safaridriver automation session. |
| `AUCTION_BROWSER=webkit npm run test:ui` | Playwright WebKit, 390×844, mobile user agent, and touch, plus a desktop WebKit context for the one-page size matrix. This is not Safari. |
| `npm run test:update` | Two production builds behind one local origin: an open iPhone-standalone WebKit client on build A loads build B on its next focus with one reload, keeps its seat, waits for a typed amount, survives failed and offline checks, and stops after two reloads toward a version that is never served. |
| `npm run sim -- --runs 3 --seed 1042` | Three seeded Normal drafts with fast fixture timings, competition floors, and independent event replay. |
| `npm run sim -- --timing real --seed 1042` | Normal simulation with real 10-second windows and 5-second extensions. |
| `npm run sim -- --mode blind --runs 3 --seed 1042` | Three complete Blind drafts: ties, unsold lots, both timeouts, queues, two devices, reconnect, and independent award/priority/reserve audits. |
| `npm run verify` | All checks above except real timing and alternate browsers; includes three fast Normal and three Blind simulations. |

Simulation summaries and event logs go under `EVIDENCE_DIR`. A draft passes only at `complete` with all invariants satisfied.
Normal accepts `--skip-build` after a production build. `--check-import` checks imports only; it does not complete a draft.
WebKit uses `PLAYWRIGHT_BROWSERS_PATH` when set, otherwise the existing local browser cache.
Use `AUCTION_NEXT_DEV=1` for bounded local Next development during Safari and WebKit checks.
Safari verification attempts a standalone WebDriver window. If unsupported, evidence labels the separate layout check as emulated standalone.
Only owned sessions and servers close. The runner does not touch existing Safari windows.
