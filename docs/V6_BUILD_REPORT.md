# V6 build report — roles (V6.0), 2–4 players (V6.1), lobby slots / chat / settings / floating info (V6.2)

Version in the code: `6.0.0-wip` (becomes `6.0.0` only after the manual checks in PANDUAN_AWAM.md pass). 
**Status: BELUM SIAP RILIS.** Server logic, database and the browser flows were exercised; the deployed server function, real devices and several UI suites were not.

## 1. Verified (actually executed, result shown)
| What | Result |
|---|---|
| Server suites (real server core on an in-memory store): rooms 38, game 62, security 39, network 33, endgame 42, abandon 25, pause-undo 58, parity 10, tahkim-reason 19, draft 28, explain 15, first-draw 14, env-build 11, hardening 34, tahkim-consensus 51 | all pass, **none of the old suites was edited to make it pass** |
| `roles.mjs` (V6.0 roles) | 128 pass |
| `judge.mjs` (Ping, freeze, Judge Tahkim, Judge pause, fallback, races) | 153 pass |
| `nplayer.mjs` (V6.1: rotation incl. gaps/eliminations, N-player draw, resign/timeout/abandon elimination, majority Tahkim, undo, end/tie, rematch, privacy, races) | 114 pass |
| **Real database** (project `testmpo3`, migrations 008 + 009 applied by me, `supabase/tests/roles_rls.sql` run): constraints, capacity trigger, rack-for-non-player trigger, RLS rack isolation, no write access for Judge/Spectator/player, realtime presence policy, 2–4 seats, seat re-numbering | `ALL ROLE / RLS CHECKS PASSED`; rolled back, nothing left behind. (Found and fixed two test-script faults on the way: trigger-before-constraint ordering and an invalid room code.) |
| Browser, real Chromium, real server core behind a fake network: `e2e/run.py` 112, `e2e/local.py` 49, `e2e/pause-button.py` 46, `pwa/e2e.mjs` 92, `layout/log-icon.mjs` 509 | pass |
| Browser, new: `e2e/roles.py` (host, guest, Judge, Spectator) 57; `e2e/nplayer.py` (3 players + spectator, 4 players + judge + spectator, six viewports 360×640 … 1920×1080, elimination, reload does not revive) 54 | pass |
| `pwa/static.mjs` 431, `logic/endgame` 21, `logic/names` 22, `sync-edge-shared --check`, `stamp-sw --check`, `contrast.py` (0 failures) | pass |

Bugs found by the browser/database runs and fixed: lobby listed Judge/Spectator rows as seats; role switch lost the typed nickname; Judge verdict buttons hidden by CSS; a "hidden" match-bar button stayed visible in icon style (spectator saw the pause button); first render of seats 2–3 happened before their panels existed; two comment-swallowed braces (caught only by loading modules in Chromium; `node --check` did not catch them).

## 2. Not verified (written, never executed) — nothing here blocks the next phase, but each must be checked
1. **The `eas-game` Edge Function with the new code on a real Supabase project.** The database side is verified; the function was not deployed (I did not push ~150 KB of code through the connector; PANDUAN_AWAM Bagian A does it with one command).
2. Real Supabase **Realtime** behaviour (the `ROSTER` broadcast, presence policy in practice) with real devices.
3. `logic/engine`, `logic/startup`: need `jsdom`, not installable here (no network).
4. Layout suites `floating`, `layering`, `fluid`, `tools`, `collapse`, `feel`, `history-toggle-extra`: they crash or time out in this sandbox **identically on the original v5.5.4 archive** (`localStorage` SecurityError in the harness), so they say nothing about V6. `layout/history-toggle` fails the same way on the original (stale baseline). 
5. Real phones / real keyboards / screen readers: only Chromium emulation was used.

## 3. Needs a manual look (highest risk first)
- 3–4 player screen on a small phone: the player's own rack and buttons sit below the turn-strip and may need scrolling (360×640 shows board + strip first). 
- The Judge/Spectator view in the *duel* and *classic* layouts with the player panels hidden (desktop screenshots of both were inspected and look right; only Chromium).
- Wording of new Arabic labels (Indonesian glosses only on the role names).
- Ping Judge dialog and Judge panel on a phone.

## 4. Decisions taken (with reasons)
- **Elimination, not removal**: in a game of 3–4, resign / abandon / out-of-time marks the player out (`games.ext.out`), keeps row, score and history; two active players left → the v5.4 two-player rules apply unchanged (resign/abandon/time end the game).
- Resign sets that player's score to 0 (v5.4); abandon/time keep the score. An eliminated player keeps their score on the result card but cannot win.
- **Winner / ties**: highest final score among players still in the game; a tie at the top has no single winner (`winner_seat = null`, `result.winners` lists them).
- **Tahkim voting**: more than half of the players still in the game: 2/2, 2/3, 3/4. Splits never decide. An eliminated player's vote is removed and the rest are re-counted. A Judge, when present, rules alone (players' votes ignored).
- **Undo**: only the player whose turn it now is answers; the Judge has no part (agreed).
- **Draw for first player**: N contenders draw one tile each, only tied players redraw, blank = 0, random fair pick after 12 ties. Two players: byte-identical to before. For 3–4 the animation is replaced by a notice.
- **Blockers / claim_abandon**: two active players unchanged; 3–4: during a Tahkim only voters who have not chosen can hold it up; outside it, the player on turn. All silent blockers are eliminated.
- **Lobby leaver**: seats are closed up (0..n-1); host leaving closes the room (limit, to be revisited); after a match a non-host may leave, and a rematch starts when every remaining player (≥2) asked. Seats re-numbered at the rematch deal.
- **Floating workspace** positions two player panels only: it is switched off (with a notice) when a 3–4 player room is entered.
- **Version**: `6.0.0-wip` until the manual checklist passes.
- contrast: `--tile-blank-text` (pink) `#a03a20 → #9a3720` (4.49 → ≥ 4.5), visually negligible.

## 5. Known limits / risks
- Host leaving a lobby closes the room (no hand-over; documented).
- Supabase Presence keys are chosen by the client: a member could forge a cosmetic ghost-tile preview. It never affects game state (the server decides everything).
- A Judge whose tab is hidden stops heart-beating and counts as absent after 60 s (then the dispute falls back to the players). A Judge who heart-beats but never answers can be bypassed by the caller withdrawing the call (button added) or by resigning.
- Seats 2–3 have generic default names ("اللاعب الثالث/الرابع") until the room tells the nickname; they are never stored on the device.
- Phase 2 UI: 4 player panels exist only for the seat owner; no side-by-side opponent racks (by design: racks are private).

## 6. Files changed (summary)
Server: `supabase/functions/_shared/core/{engine,service,snapshot,errors}.js`, `eas-game/store.ts`, `js/config.js` (+ generated `_shared/game/config.js`), migrations `20261107000008_*` (roles, Judge) and `20261108000009_*` (seats 0–3), `supabase/tests/roles_rls.sql`.
Client: `js/online/{session,lobby,hud,tahkim-ui}.js`, new `js/online/role-ui.js`, `js/{ui,names}.js`, `css/{online,themes}.css`, `sw.js` (precache), `js/version.js`.
Tests: `tests/online/{roles,judge,nplayer}.mjs`, `tests/online/{lib,memory-store}.mjs`, `tests/e2e/{roles,nplayer}.py`, `tests/e2e/{fake-backend.js,server.mjs}` (presence filtered by oppId like the real backend), `tests/run-all.mjs`.
Docs: this file, `docs/ONLINE_ARCHITECTURE.md`, `README.md`, `PANDUAN_AWAM.md`.

## 7. Deploy order (details in PANDUAN_AWAM.md)
1. Database: migrations 008 and 009 (already applied to `testmpo3`; for production run them in order **after** a backup). 2. `supabase functions deploy eas-game`. 3. Frontend (Vercel preview first). 4. The 15-point manual checklist. 5. Only then change the version to `6.0.0` and release.
Old (v5.x) clients in a room that has a Judge or 3+ players do not understand it: ask players to reload (the service-worker cache hash changed).

## 8. Release decision
**Not ready.** Ready for the manual stage: everything that can be proven without a deployed function and real devices was proven.


---
# V6.2 — the five requests (this round)
Decisions you made: chat = players + Judge, ephemeral; slot = seat only, the turn order is DRAWN at the start; slot layout = one row of numbered cards, no VS.

| # | Request | What was built | Evidence |
|---|---|---|---|
| 1 | Settings hierarchy | "الأساسيات / Utama" card first: **fullscreen button on top**, then theme, layout, rack visibility, pause. Everything else folded into "خيارات إضافية" (names, touch, start of match, live preview); app/install folded too. | Screenshots (mobile + desktop) inspected; `e2e/local.py`, `e2e/run.py` updated only to unfold the group before touching a folded control |
| 2 | Rules too narrow | One button in the settings opens the rules in their **own large window** (up to 56 rem wide, 1.05 rem type, 1.85 line height; full-width bottom sheet on phones). | Screenshots; 7 end-of-game rules + word rules render |
| 3 | Word log as chat | Online, the log gets **Words / Chat tabs** (players + Judge). Chat is **ephemeral**: it travels in presence, nothing is stored. Notification **only on the chat**: a count on the chat tab, a dot on the log button, a toast, a screen-reader line; nothing is ever written into the word log or the decision log. Rate-limited (1 / 0.6 s), 200 chars, text rendered as text. Spectators neither write nor read. | `e2e/chat.py` 18 pass (badge, dot, no leak into logs, XSS, rate limit, judge line, ephemeral after refresh) |
| 4 | MOBA-style room | The lobby is **a row of numbered slot cards** (2–4): an empty card is a dashed button "اجلس هنا", your card is highlighted. Judge chair and gallery in their own row (names listed). Anybody can move to any empty seat or switch between player / judge / spectator before the start (the host keeps a player seat). At the start gaps are closed and, for 3–4 players, the **turn order is drawn** (`game.order`, shown in that order in the strip); two players keep the plain order. | `slots.mjs` 36 pass; `e2e/slots.py` 16 pass; **migration 010 applied to `testmpo3` and its checks run: `V6.2 SLOT CHECKS PASSED`** |
| 5 | Floating player info | The players-info strip is now a workspace module: **move by its grip, resize by the corner handle, position remembered**. Seat 3/4 rack panels also join the workspace. | `e2e/floatplayers.py` 12 pass (move, resize, reload keeps place, seat-3 rack moves) |

## Verified in this round
Server: rooms 38, game 62, security 39, network 33, endgame 42, abandon 25, pause-undo 58, parity 10, tahkim-reason 19, draft 28, explain 15, first-draw 14, env-build 11, hardening 34, tahkim-consensus 51, roles 128, judge 153, nplayer 114, **slots 36**. Browser: run 112, local 49, pause-button 46, pwa/e2e 92, layout/log-icon 509, roles 57, nplayer 54, **chat 18, floatplayers 12, slots 16**. pwa/static 436, logic/endgame 21, logic/names 22, contrast 0 failures, shared files in sync, service worker current (68 files). Real database `testmpo3`: migrations 008, 009, **010** applied; `roles_rls.sql` (008/009 part) passed; the 010 checks passed as a separate run.

## Not verified / limits (new)
- The Edge Function with this code is still **not deployed** (PANDUAN_AWAM Bagian A) — nothing online works against `testmpo3` until it is.
- Chat on **real Supabase Realtime** (it relies on presence metadata size/latency; tested only against the fake transport). Presence keys can be forged by a member (same known limit as the live tile preview): a line's sender is looked up from the room roster by key, unknown keys are ignored.
- Chat lines are lost on refresh by design; a latecomer sees at most the last 12 lines each member still holds.
- `data-hist="drawer"` layouts: the log must be opened to see the tabs; the unread dot is on the log button.
- The floating workspace with the new strip/panels was tested with Chromium at 1280×800 only.
- A turn order drawn for 3–4 players means the lobby seat number is not the turn number (the lobby says so).
