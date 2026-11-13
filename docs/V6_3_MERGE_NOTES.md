# Merge: v5.6.0 features -> v6.2-wip (this round)

## Ported from 5.6
- **Adaptive alif mode (`adaptive`)**: 91 tiles, 6 flexible alif tiles worth 1 point (ا أ إ آ ؤ ى ئـ ئ), teal look, picker with the 8 forms, works in 2-4 player rooms, drafts/ghost preview, saved local games, first-draw (drawn as plain ا, value 1). Server: `engine.js` (pubTile, drawFirst, place), shared `modes.js`/`rules.js`/`config.js` re-synced.
- **Expanded mode**: ئـ (joining, x2, value 6) and ئ (final, x1, value 8) are separate tiles; bag is 102 tiles (tests updated: 101 -> 102).
- **Word rules**: «اللام الملتصقة بالفعل المضارع» removed (list + judge question 2).
- **How to play**: 6.2's single-page rules window replaced by 5.6's tabbed full-height view (Basics, Points, Letters per mode, Words, Tahkim). Texts adjusted to 6.2 reality: 2-4 players, majority Tahkim, the referee (حَكَم / Wasit) rules alone, elimination, winner/tie, drawn turn order.
- Migration `20261111000011_eas_v6_2_adaptive_mode.sql` (replaces the `tile_mode` CHECK). **Not yet applied to any database.**

## Deliberately NOT ported (your decisions)
- 5.6's server-stored match chat (6.2 keeps its ephemeral presence chat), 5.6 `histtabs.js`, 5.6 Settings layout (6.2's stays).

## Verified here
Server suites: rooms 38, game 62, security 39, network 33, endgame 42, abandon 25, pause-undo 58, parity 10, tahkim-reason 19, draft 32, explain 15, first-draw 14, env-build 11, hardening 34, tahkim-consensus 51, roles 128, judge 153, nplayer 114, slots 36, **adaptive 43** - all pass.
Browser (Chromium): e2e run 112, local 49, pause-button 46, roles 57, chat 18, slots 16, nplayer 54, floatplayers 12, **adaptive 25 (desktop + phone)**; pwa/static 445, pwa/e2e 92, logic/endgame 21, logic/names 22, contrast 0 failures, edge-shared and sw in sync.
Not run: `layout/log-icon.mjs` (needs `@sparticuz/chromium`, absent here; also fails on the original 6.2 archive), `logic/engine.mjs` (needs jsdom; only the 101 -> 102 constant was updated by hand), the Edge Function on a real Supabase project, real devices.

## Round 2 (visual decisions)
- **Board detail by cell size** (css/style.css, container queries on `.board`): board >= 480px full "x2 حرف"; 340-479px short "x2 ح"/"x2 ك" (star label hidden); < 340px bonus squares are colour only and tile values are hidden (letters only). Pure CSS, no script. Thresholds are the three numbers at the end of style.css.
- **Last-move marker**: the dot is replaced by a static inset ring in the placer's colour (css/online.css `.sq.lm::after`): no animation, shadow or filter.
- **Four player colours**: --tile-p3 deep teal `#0a5f59`, --tile-p4 burnt amber `#854d00` in all four themes (both >= 4.5:1 on every tile face; a brighter orange cannot reach 4.5:1 on the cream tiles). Fixed a real bug: `tileHTML` only set `data-o` for seats 0 and 1, so seats 3-4 had no colour at all.
- Tests: new `tests/e2e/board-detail.py` (16), contrast test now checks four colours and all pairwise distances.
- Not changed yet (awaiting decision): panel/scoreboard accents of seats 3-4 (still reuse seat 1-2 accents), blur and glow effects (see audit).

## Round 3 (performance + panel accents)
- **Graphics level** (Settings > More options > Graphics): `low` (default for everyone, the base game), `mid`, `high`. `<html data-fx>` is set by `js/prefs.js` (stored as `eas.fx`, invalid value -> low); `css/fx.css` (loaded last, precached) only switches the original effects off, so `high` = the game exactly as it looked before.
  - low: no backdrop blur anywhere; overlay/dialog/panel backgrounds made more opaque to compensate; no board/rack saturate filter during Tahkim; no box-shadow glow loops (held tile = steady ring, also under reduced motion); no first-draw bob/pulse.
  - mid: + blur behind the pause, "who starts?" and Tahkim overlays, + glowing pulses.
  - high: + blur behind floating dialogue/panels/tools, + Tahkim board dimming filter, + first-draw bob.
- Audit of the rest (no change needed): no canvas, no requestAnimationFrame loops (only throttled resize/drag), one 250 ms timer that updates clock text only, board cells diffed on render, other infinite animations are opacity/transform only.
- **Panel accents seats 3-4**: --player-3 light teal / --player-4 amber per theme (classic `#5fd6c9`/`#f2862b`, dark `#5ad8cc`/`#ef7b2b`, pink `#6fd9c8`/`#f59a3c`, desert `#0c6b4a`/`#6e6200`: desert's seat 2 is already a blue-teal and seat 1 an orange-brown, so there the teal is greener and the amber a dark ochre). Applied to player panels, match HUD, result cards. contrast.py checks all four accents (>= 4.5:1, pairwise dE >= 28).
- Tests: new `tests/e2e/fx.py` (12); `tests/pwa/e2e.mjs` touch-feedback test now checks low (steady ring) and mid (pulse).
