# Pancake Auction

Pancake Auction runs one sealed-bid lot at a time. Convex owns deadlines, final responses, roster checks, and awards.
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
The readiness check requires ten configured managers, a completed import, no lots, and both 24-hour windows.
Starting the auction remains a separate commissioner action in the room.

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
Roster moves must preserve eligibility, capacity, reserve, and the owner's positive sealed response.
A move that removes all legal placements gives an unresponded manager an automatic pass.
Automatic passes remain final if a later move changes eligibility.
Opening an active spot clears an invalid Done choice.

## Private responses and queues

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

Only the commissioner starts, pauses, resumes, or undoes.
Pause stores the exact remaining milliseconds. Resume creates a deadline from that remainder.
Responses and nominations are unavailable while paused. Queue edits and legal roster moves remain available.
There is no early force-award or force-end control.

Undo targets the latest sold lot shown in its confirmation. A stale target fails.
Undo refunds its price, removes its roster entry, restores the priority list from before that sale, and pauses.
It returns to that lot's nominator and grants a fresh 24-hour nomination window on resume.
It voids an open subsequent lot. Those unrevealed responses never enter public results.
Previously revealed responses remain public. A re-nomination creates a new lot and requires new responses.
Consumed queue entries stay consumed, including entries used for a voided lot. Undo does not reconstruct private queues.
Undo clears invalid Done choices. Legacy sales cannot use sealed undo.

## Deadlines and subscriptions

Convex serializes every mutation. The last response and scheduler resolve through the same transaction path.
Each deadline job carries the draft ID, lot ID, version, and expected deadline.
A mismatch, paused draft, legacy draft, or early invocation does nothing.
Pause, resume, new turns, and new lots invalidate stale jobs. Repeated calls cannot double-award.
Ordinary responses do not schedule replacement deadline jobs.

Public state contains the dynamic draft, roster, recent results, and events.
A separate query subscribes to the imported player pool. Draft changes do not resend that pool.
The private subscription returns only the caller's queue and response.
The browser updates its hours-and-minutes display once per minute without network polling or clock-sync requests.
The displayed countdown uses the device clock; the stored deadline and Convex clock decide acceptance.
An incorrect device clock cannot change a deadline or make a late response valid.

## Schema compatibility and migration

The schema retains all legacy tables and required field types, including `passes`, live-lot price fields, and old timing fields.
New draft mode, priority, lot response metadata, result bids, and event markers are optional.
The new `responses` and `queues` tables do not alter existing documents.
Adding indexes does not require document rewrites. Schema changes do not wipe data or start a draft.
The stored `passedTurns` field remains compatible but has no effect on nomination or completion.
Previously completed drafts with `completionReason: full-cycle-unsold` still load and show an earlier-rules label.
They are not reopened automatically.

A draft without `mode: sealed-v1` is legacy. Running, paused, and completed legacy drafts reject sealed actions.
Scheduled jobs also ignore them. Their old event payloads are not returned publicly.
An open legacy lot exposes no standing amount through public state.
The commissioner must arrange an explicit migration for an in-progress legacy draft; no automatic conversion exists.

An untouched legacy setup opens the normal setup room. Commissioner Start converts it to sealed mode through the existing server checks.
Start refuses a legacy setup containing any lot or roster entry and displays the server error.
Queue controls stay disabled until Start converts the setup. Legacy roster placement controls remain hidden.

`league:managers` upgrades an empty legacy setup record to sealed defaults.
It refuses when any lot or roster entry exists or the draft has left setup.
It preserves manager identities. Starting remains a separate commissioner action.
`league:check` requires sealed mode, 24-hour nomination and bid settings, ten managers, and a completed player import.

## Player data and nomination ranking

The importer stores the real Sleeper player pool and Rotowire forecasts exposed through Sleeper.
Auto-nomination sorts the stored `projection` field descending, then player ID ascending for equal values.
Missing projections sort last. It excludes sold players and players the nominator cannot legally afford or place.
It never generates a projection or attaches a timeout bid.

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
response count, and the bid, Pass and nomination controls on screen at every supported size, including short and landscape phones.
Desktop shows the queue, players, current player, teams, results and roster together. Narrower screens use one-tap tabs:
Players, Queue, Teams (phone), My roster and Results. The Queue tab shows how many players are queued.
Teams shows tie priority from highest to lowest.
My roster retains 20 active, three Taxi, and two IR rows, including empty places.
Player search, positions, projections, detailed stats, roster inspection, and placement controls remain available.

A web manifest adds the Pancake name, two PNG icons, theme colors, and `display: standalone`.
Apple web-app metadata and an Apple touch icon support Safari installation.
The icon (a basketball on a syrup pancake stack, on an opaque dark background) is drawn in `public/icon.svg`.
`apple-touch-icon.png` (180), `icon-192.png`, `icon-512.png` and `favicon.ico` are opaque renders of that file,
for example `rsvg-convert -w 180 -h 180 public/icon.svg`, flattened to RGB.
The layout includes safe-area padding and dynamic viewport height. Installation adds no offline bidding or background response automation.
The `emulated-standalone` CSS class is a layout-only test hook. It changes no auction behavior.

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
| `npm test` | Sealed engine, eligibility, roster, imports, client retry, evidence, and UI rendering boundaries. |
| `npm run test:local` | Local backend startup, cleanup, cache, ownership, network, and deadline harness regressions. |
| `npm run test:db` | Public API secrecy, queues, ties, scheduler, compatibility, undo, auth, and a complete ten-manager draft. |
| `npm run test:volume` | Player-pool subscription delivery remains separate from dynamic state. |
| `npm run build` | Production Next.js build. |
| `npm run test:layout` | Roster slots, placements, keyboard controls, compact layouts, and reconnect/pool-loading regressions. |
| `npm run test:room` | Production room follows a setup import and recovers from a real query failure. |
| `npm run test:ui` | Chromium UI through agent-browser by default. Every browser mode also checks the one-page matrix: no page scroll, and identity, deadline, response state and actions reachable at phone, landscape, short and desktop sizes. |
| `AUCTION_BROWSER=safari npm run test:ui` | Real Safari through a separate safaridriver automation session. |
| `AUCTION_BROWSER=webkit npm run test:ui` | Playwright WebKit, 390×844, mobile user agent, and touch, plus a desktop WebKit context for the one-page size matrix. This is not Safari. |
| `npm run verify` | Typecheck, lint, units, local harness, database, volume, build, layout regressions, Chromium UI, and import/error recovery, in that order. |

Use `AUCTION_NEXT_DEV=1` for bounded local Next development during Safari and WebKit checks.
Safari verification attempts a standalone WebDriver window. If unsupported, evidence labels the separate layout check as emulated standalone.
Only owned sessions and servers close. The runner does not touch existing Safari windows.
