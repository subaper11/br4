// Authoritative game transitions for online play. PURE: no I/O, no clock, no randomness of its own. Everything comes in as
// arguments (state, userId, request, now, deps) and a PATCH comes out (see service.js / the commit_action SQL function).
//
// The server state is split exactly as the design requires:
//   PUBLIC   game row (board, turn, revision, clock, tahkim, result ...), players' score / tile_count / time, move history
//   PRIVATE  one rack per player (only its owner ever receives it)
//   SERVER   the tile bag, the undo snapshot Tahkim may need; neither ever leaves the server
//
// Rules are NOT re-implemented here: legality, words, scoring and the end-of-game settlement come from game/rules.js (shared with the local game).
// There is no dictionary: whether a word is valid is decided by the players through Tahkim, exactly as in local play.
import { SIZE, RACK, MIN_BAG_SWAP, DURATIONS, ABANDON_MS, PAUSE_MS, PAUSES_EACH, INCREMENT_MS, TAHKIM_CHAT_MAX, TAHKIM_CHAT_EACH, TAHKIM_MSG_MAX, TAHKIM_LOG_MAX,
  SUPPORTED_MAX_PLAYERS, MAX_SPECTATORS_CAP, PINGS_EACH, JUDGE_ABSENT_MS } from '../game/config.js';
import { TILE_MODES, tileValue, tileAlpha, tileLetter } from '../game/modes.js';
import { analyzeMove, scoreWords, wordStr, makeTileSet, settleEnd, challengePenalty } from '../game/rules.js';
import { fail } from './errors.js';
import { explainRejected } from '../game/dictionary.js';

export const STATUS = Object.freeze({ LOBBY: 'lobby', STARTING: 'starting', ACTIVE: 'active', TAHKIM: 'tahkim_pending', FINISHED: 'finished', ABANDONED: 'abandoned' });
export const PLAYING = [STATUS.ACTIVE, STATUS.TAHKIM];
export const OPEN = [STATUS.LOBBY, STATUS.STARTING, STATUS.ACTIVE, STATUS.TAHKIM];

const clone = x => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));
export const emptyBoard = () => Array.from({ length: SIZE }, () => Array(SIZE).fill(null));
export const pubTile = t => ({ id: t.id, l: t.blank ? '' : t.l, v: tileValue(t), blank: !!t.blank, ...(t.flex ? { flex: true } : {}), as: t.blank ? (t.as || null) : null, o: Number.isInteger(t.o) && t.o >= 0 && t.o <= 3 ? t.o : null });

// ---------- randomness (injected so tests are deterministic; production uses crypto) ----------
export function shuffle(a, rng) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
export function idFactory(rng) {
  const seen = new Set();
  return () => { let id; do { id = Array.from({ length: 6 }, () => 'abcdefghijkmnpqrstuvwxyz23456789'[Math.floor(rng() * 32)]).join(''); } while (seen.has(id)); seen.add(id); return id; };
}

// ---------- helpers ----------
// ---------- membership, roles and seats ----------
// A room member is a player (owns a seat and a rack), the Judge (at most one) or a spectator. Judge and spectator have NO seat (seat === null) and NO rack.
// Membership (memberOf) and seat (seatOf) are different questions: seatOf answers -1 for everybody who is not a player, strangers included, so it must never be
// used on its own to decide "is this user in the room".
export const roleOf = p => (p && p.role) || 'player';
export const memberOf = (w, userId) => w.players.find(x => x.player_id === userId) || null;
export const roleOfUser = (w, userId) => { const m = memberOf(w, userId); return m ? roleOf(m) : null; };
export const playersOf = w => w.players.filter(p => roleOf(p) === 'player');
export const judgeOf = w => w.players.find(p => roleOf(p) === 'judge') || null;
export const spectatorsOf = w => w.players.filter(p => roleOf(p) === 'spectator');
export const seatOf = (w, userId) => { const p = memberOf(w, userId); return p && roleOf(p) === 'player' && p.seat != null ? p.seat : -1; };
export const playerBySeat = (w, seat) => playersOf(w).find(p => p.seat === seat);
export const isHost = (w, userId) => w.game.host_player_id === userId;
// The Judge counts as present while the server has heard from them within JUDGE_ABSENT_MS (heartbeat / any action: the same last_seen_at as everybody else). No Judge row = absent.
export const judgePresent = (w, now) => { const j = judgeOf(w); if (!j) return false; return j.last_seen_at == null ? true : now - j.last_seen_at < JUDGE_ABSENT_MS; };
export const judgeActive = (w, now) => !!w.game.judge_enabled && judgePresent(w, now);   // a Judge room whose Judge is here: Tahkim goes through the Judge
// ---------- seats, rotation, elimination (V6.1: 2-4 players) ----------
// Seats belong to players only and are gap-free in a lobby (a leaver's seat is closed up); the seat order IS the turn order.
// A player who resigns, vanishes or runs out of time in a game of 3-4 is ELIMINATED, not deleted: games.ext.out = {"<seat>": reason}. Their row, score and moves stay for the
// history and the result card; they are skipped by the rotation, cannot act, and cannot come back by reconnecting. In a game that is down to two active players the old
// two-player rules apply unchanged (resign / abandon / time end the game).
export const outOf = g => (g.ext && g.ext.out) || {};
export const isOut = (g, seat) => outOf(g)[seat] != null;
export const playerSeats = w => playersOf(w).map(p => p.seat).sort((a, b) => a - b);
export const activeSeats = w => playerSeats(w).filter(s => !isOut(w.game, s));
// The next seat in turn order after `seat`: only seats still in the game, wrapping round, working for non-consecutive seats and for a `seat` that is itself out. null when nobody is left.
// Turn order: seat order, unless the game has a drawn order (games.ext.order, three or four players: shuffled when the game starts, see deal()). Either way the rotation skips
// seats that are out and wraps round.
export const turnOrder = w => { const o = w.game.ext && w.game.ext.order; return Array.isArray(o) && o.length ? o : playerSeats(w); };
export const nextSeat = (w, seat) => {
  const act = activeSeats(w); if (!act.length) return null;
  const ord = turnOrder(w), i = ord.indexOf(seat);
  if (i < 0) return ord.find(s => act.includes(s)) ?? act[0];   // not in the order (an unknown seat): start of the order
  for (let k = 1; k <= ord.length; k++) { const s = ord[(i + k) % ord.length]; if (act.includes(s)) return s; }
  return act[0];
};
const other = seat => 1 - seat;   // two-player shorthand kept ONLY where exactly two seats exist (never used for rotation)
export const rackOf = (w, seat) => w.racks[playerBySeat(w, seat).player_id];
const turnNo = w => w.moves.length + 1;

// ---------- ext: small public extras of a game (the `games.ext` jsonb column) ----------
//   live    boolean   the host allows live preview of the player-on-turn's tentative tiles (browsers broadcast it; the server never sees it)
//   pause   null | {by, at, until}   both clocks are stopped
//   pauses  [n0, n1]  pauses used by each seat in this game
//   undo    null | {state:'pending'|'declined', by, move_number, at}   the last mover's request to take the move back
export const extOf = g => g.ext || {};
// How words are judged in this room (V6.3): 'tahkim' = the players (or the Judge) rule on a challenged word; 'auto' = the dictionary judges every move when it is submitted and Tahkim does not exist.
export const wordJudging = g => (g.ext && g.ext.word_judging === 'auto' ? 'auto' : 'tahkim');
export const WORD_JUDGING = ['tahkim', 'auto'];
const setExt = (g, patch) => { g.ext = { ...(g.ext || {}), ...patch }; };
export const isPaused = g => !!(g.ext && g.ext.pause);
const clearUndo = w => { if (w.game.ext && w.game.ext.undo) setExt(w.game, { undo: null }); };   // acting on the move implicitly declines a pending request

// Authorization is checked on the SERVER for every action (hiding a button is never the protection):
//   requireMember  anybody registered in the room (any role)          -> the member row
//   requirePlayer  gameplay actions: a player only                    -> their seat   (spectator: SPECTATOR_READ_ONLY, judge: NOT_A_PLAYER)
//   requireJudge   Judge actions                                      -> the member row (spectator: SPECTATOR_READ_ONLY, player: NOT_A_JUDGE)
//   requireHost    room configuration, by games.host_player_id (never by "seat 0")
export function requireMember(w, userId) { const m = memberOf(w, userId); if (!m) fail('NOT_MEMBER'); return m; }
export function requirePlayer(w, userId, opts) {
  const m = requireMember(w, userId), r = roleOf(m);
  if (r === 'spectator') fail('SPECTATOR_READ_ONLY'); if (r !== 'player') fail('NOT_A_PLAYER');
  if (isOut(w.game, m.seat) && !(opts && opts.allowOut)) fail('ELIMINATED');   // an eliminated player watches: no action, and reconnecting does not bring them back
  return m.seat;
}
export function requireJudge(w, userId) {
  const m = requireMember(w, userId), r = roleOf(m);
  if (r === 'spectator') fail('SPECTATOR_READ_ONLY'); if (r !== 'judge') fail('NOT_A_JUDGE');
  return m;
}
export function requireHost(w, userId) { const m = requireMember(w, userId); if (!isHost(w, userId)) fail('NOT_HOST'); return m; }
const isPinging = g => !!(g.ext && g.ext.ping);   // a player called the Judge: the match waits for them (clock stopped, gameplay locked)
function requirePlaying(w) { if (w.game.status === STATUS.TAHKIM) fail('TAHKIM_PENDING'); if (w.game.status !== STATUS.ACTIVE) fail('WRONG_STATUS'); if (isPaused(w.game)) fail('PAUSED'); if (isPinging(w.game)) fail('WAITING_JUDGE'); }
function requireTurn(w, userId) { const s = requirePlayer(w, userId); requirePlaying(w); if (w.game.current_seat !== s) fail('WRONG_TURN'); return s; }

// ---------- clock ----------
// players[].ms_left is the time left when the clock was last settled; while the clock runs, the player on turn is still spending
// (now - turn_started_at). All of it is computed from SERVER timestamps, never from a browser counter.
export const clockRunning = g => !!(g.clock_started && g.turn_started_at && g.status === STATUS.ACTIVE);
export function liveMs(w, seat, now) {
  const p = playerBySeat(w, seat), g = w.game;
  return (clockRunning(g) && g.current_seat === seat) ? Math.max(0, p.ms_left - (now - g.turn_started_at)) : p.ms_left;
}
function settle(w, now) {   // charge the elapsed time to the player on turn
  const g = w.game;
  if (!clockRunning(g)) return;
  const p = playerBySeat(w, g.current_seat);
  p.ms_left = Math.max(0, p.ms_left - Math.max(0, now - g.turn_started_at)); g.turn_started_at = now;
}
function restartClock(w, now) {
  const g = w.game;
  // a pause or a Judge call keeps the clock stopped, however the code got here
  if (g.clock_started && g.status === STATUS.ACTIVE && !isPaused(g) && !isPinging(g)) { g.turn_started_at = now; g.turn_deadline_at = now + playerBySeat(w, g.current_seat).ms_left; }
  else { g.turn_started_at = null; g.turn_deadline_at = null; }
}
function nextTurn(w, now, scored) {
  settle(w, now);
  w.game.current_seat = nextSeat(w, w.game.current_seat);
  if (scored && !w.game.clock_started) w.game.clock_started = true;   // the clock starts after the first scored move, like the local game
  restartClock(w, now);
}

// ---------- patches ----------
// Only what changed is sent. players/racks are keyed by player_id.
function patchOf(w, ev, o = {}) {
  const g = w.game;
  const game = {
    status: g.status, current_seat: g.current_seat, current_player_id: g.current_seat == null ? null : playerBySeat(w, g.current_seat)?.player_id ?? null,
    board: g.board, turn_started_at: g.turn_started_at, turn_deadline_at: g.turn_deadline_at, clock_started: g.clock_started, tahkim: g.tahkim,
    tahkim_available: g.tahkim_available, bag_count: g.bag_count, tile_mode: g.tile_mode, minutes: g.minutes, round: g.round,
    started_at: g.started_at, finished_at: g.finished_at, winner_player_id: g.winner_player_id, winner_seat: g.winner_seat, result: g.result, rematch_seats: g.rematch_seats,
    max_players: g.max_players, judge_enabled: g.judge_enabled, max_spectators: g.max_spectators,
    ext: g.ext || {}
  };
  return { event: ev, ...(o.roster ? { roster_only: true } : {}), game, players: playersOf(w).slice().sort((a, b) => a.seat - b.seat).map(p => ({ player_id: p.player_id, seat: p.seat, score: p.score, tile_count: p.tile_count, ms_left: p.ms_left, ready: p.ready })),
    racks: o.racks === 'all' ? playersOf(w).map(p => ({ player_id: p.player_id, tiles: w.racks[p.player_id] })) : (o.racks || []).map(pid => ({ player_id: pid, tiles: w.racks[pid] })),
    private: o.private ? { bag: w.priv.bag, undo: w.priv.undo ?? null } : undefined, move: o.move || null, move_update: o.move_update || null,
    add_player: o.add_player || null, remove_player: o.remove_player || null, ...(o.set_roles ? { set_roles: o.set_roles } : {}) };
}
export const withBagCount = w => { w.game.bag_count = w.priv.bag.length; };
export const refill = (w, seat) => { const rack = rackOf(w, seat), bag = w.priv.bag; for (let i = 0; i < RACK && bag.length; i++) if (!rack[i]) rack[i] = bag.pop(); playerBySeat(w, seat).tile_count = rack.filter(Boolean).length; };

// ---------- lobby ----------
// Room configuration (all validated here, and again by the database constraints):
//   tile_mode, minutes, live     as before
//   max_players   2..4 in the schema; the engine plays 2 until Phase 2 (V6.1), so anything above SUPPORTED_MAX_PLAYERS is refused (MAX_PLAYERS_UNSUPPORTED)
//   judge_enabled boolean        the room has a Judge slot (at most one Judge)
//   max_spectators 0..MAX_SPECTATORS_CAP
const intIn = (v, lo, hi) => (Number.isInteger(v) && v >= lo && v <= hi ? v : fail('BAD_REQUEST'));
const sanitizeSettings = s => {
  const out = {};
  if (s?.tile_mode !== undefined) { if (!TILE_MODES[s.tile_mode]) fail('BAD_REQUEST'); out.tile_mode = s.tile_mode; }
  if (s?.minutes !== undefined) { if (!DURATIONS.includes(Number(s.minutes))) fail('BAD_REQUEST'); out.minutes = Number(s.minutes); }
  if (s?.live !== undefined) { if (typeof s.live !== 'boolean') fail('BAD_REQUEST'); out.live = s.live; }   // lives in games.ext, not in a column
  if (s?.word_judging !== undefined) { if (!WORD_JUDGING.includes(s.word_judging)) fail('BAD_REQUEST'); out.word_judging = s.word_judging; }   // also in games.ext
  if (s?.max_players !== undefined) { out.max_players = intIn(s.max_players, 2, 4); if (out.max_players > SUPPORTED_MAX_PLAYERS) fail('MAX_PLAYERS_UNSUPPORTED'); }
  if (s?.judge_enabled !== undefined) { if (typeof s.judge_enabled !== 'boolean') fail('BAD_REQUEST'); out.judge_enabled = s.judge_enabled; }
  if (s?.max_spectators !== undefined) out.max_spectators = intIn(s.max_spectators, 0, MAX_SPECTATORS_CAP);
  return out;
};
export { sanitizeSettings };

export function updateSettings(w, userId, settings, deps) {
  requireHost(w, userId);
  if (w.game.status !== STATUS.LOBBY) fail('WRONG_STATUS');
  const { live, word_judging, ...cols } = sanitizeSettings(settings);
  // Automatic judging and Tahkim exclude each other: with the dictionary there is no Judge (his only job is Tahkim) and no challenge button.
  const judging = word_judging ?? wordJudging(w.game);
  if (judging === 'auto') {
    if (word_judging === 'auto' && !(deps && deps.dictionary)) fail('DICT_UNAVAILABLE');
    if (cols.judge_enabled === true) fail('AUTO_NO_JUDGE');
    if (word_judging === 'auto') { if (judgeOf(w)) fail('JUDGE_IN_ROOM'); cols.judge_enabled = false; }
  }
  if (cols.judge_enabled === false && judgeOf(w)) fail('JUDGE_IN_ROOM');
  if (cols.max_spectators !== undefined && cols.max_spectators < spectatorsOf(w).length) fail('SPECTATORS_BELOW_COUNT');
  if (cols.max_players !== undefined && (cols.max_players < playersOf(w).length || cols.max_players <= Math.max(-1, ...playerSeats(w)))) fail('BAD_REQUEST');   // never below the seats in use
  Object.assign(w.game, cols); if (live !== undefined) setExt(w.game, { live }); if (word_judging !== undefined) setExt(w.game, { word_judging });
  playersOf(w).forEach(p => { if (p.player_id !== w.game.host_player_id) p.ready = false; });   // a guest must re-confirm after the rules changed
  return patchOf(w, 'SETTINGS_UPDATED');
}
export function setReady(w, userId, ready) {
  const seat = requirePlayer(w, userId);
  if (w.game.status !== STATUS.LOBBY) fail('WRONG_STATUS');
  playerBySeat(w, seat).ready = !!ready;
  return patchOf(w, 'PLAYER_READY');
}
// Leaving. Lobby host leaving CLOSES the room (documented policy: no host transfer in V6.0). A guest player leaves only while the room is a lobby (in a running match a
// player resigns instead). A Judge or a spectator may leave at any time before the room is over: it changes who is in the room, never the game, so it is a roster-only patch
// (no revision bump: a pending move of a player is not made stale by somebody leaving the gallery) and it never closes the room.
export function leaveRoom(w, userId, now) {
  const m = requireMember(w, userId), r = roleOf(m);
  if (r !== 'player') {
    if (w.game.status === STATUS.ABANDONED) fail('WRONG_STATUS');
    w.players = w.players.filter(x => x !== m);
    return patchOf(w, 'ROSTER_LEFT', { roster: true, remove_player: m.player_id });
  }
  if (![STATUS.LOBBY, STATUS.FINISHED].includes(w.game.status)) fail('WRONG_STATUS');   // in a running match a player resigns instead; after the match one who does not want a rematch may leave
  if (isHost(w, userId)) { w.game.status = STATUS.ABANDONED; w.game.finished_at = now; return patchOf(w, 'PLAYER_LEFT'); }   // the host closes the room (documented limit; no host hand-over yet)
  w.players = w.players.filter(x => x !== m);
  w.game.rematch_seats = [];   // the room changed: whoever still wants a rematch asks again
  if (w.game.status === STATUS.LOBBY) compactSeats(w);   // a lobby has no history: close the gap so seats stay 0..n-1 (after a match the seats are closed up when the rematch is dealt)
  return patchOf(w, 'PLAYER_LEFT', { remove_player: m.player_id });
}
// Seats are gap-free: the order of the remaining players is kept.
function compactSeats(w) { playersOf(w).sort((a, b) => a.seat - b.seat).forEach((p, i) => { p.seat = i; }); }
export const leaveLobby = leaveRoom;   // older name

// Free choice of a place in the lobby (the room is a set of slots: player seats, the Judge's chair, the gallery). A player may sit in any EMPTY seat and move to another empty one;
// anybody may switch between player / judge / spectator while there is room. The host always keeps a player seat. A change of role resets "ready". The turn order is NOT decided by the
// seat (it is drawn when the game starts for 3-4 players).
export function chooseSlot(w, userId, req) {
  const m = requireMember(w, userId), g = w.game, cur = roleOf(m);
  if (g.status !== STATUS.LOBBY) fail('WRONG_STATUS');
  const kind = req && req.kind;
  if (kind === 'player') {
    const slot = req.slot, seats = Math.min(g.max_players ?? 2, SUPPORTED_MAX_PLAYERS);
    if (!Number.isInteger(slot) || slot < 0 || slot >= seats) fail('BAD_REQUEST');
    if (playersOf(w).some(p => p !== m && p.seat === slot)) fail('SEAT_TAKEN');
    if (cur === 'player') { if (m.seat === slot) return patchOf(w, 'SLOT_CHOSEN'); m.seat = slot; return patchOf(w, 'SLOT_CHOSEN'); }
    if (playersOf(w).length >= seats) fail('ROOM_FULL');
    m.role = 'player'; m.seat = slot; m.ready = false; m.score = 0; m.tile_count = 0; m.ms_left = g.minutes * 60000; w.racks[m.player_id] = [];
    return patchOf(w, 'SLOT_CHOSEN', { set_roles: [{ player_id: m.player_id, role: 'player', seat: slot, ready: false }] });
  }
  if (isHost(w, userId)) fail('HOST_MUST_PLAY');
  if (kind === 'judge') {
    if (!g.judge_enabled) fail('JUDGE_DISABLED');
    const j = judgeOf(w); if (j && j !== m) fail('JUDGE_TAKEN');
    if (cur === 'judge') return patchOf(w, 'SLOT_CHOSEN');
  } else if (kind === 'spectator') {
    if (cur === 'spectator') return patchOf(w, 'SLOT_CHOSEN');
    if (spectatorsOf(w).length >= (g.max_spectators ?? 0)) fail('SPECTATORS_FULL');
  } else fail('BAD_REQUEST');
  m.role = kind; m.seat = null; m.ready = false; delete w.racks[m.player_id];   // a judge / spectator has no seat and no rack
  return patchOf(w, 'SLOT_CHOSEN', { set_roles: [{ player_id: m.player_id, role: kind, seat: null, ready: false }] });
}

// Which role a joiner ends up with (decided here, re-checked by the database trigger). Never silently different from what was asked: a player who finds no free seat is
// refused (the error says whether watching is possible: extra.can_spectate) unless the request itself allowed the fallback (allow_spectator), and the answer then says so (fell_back).
const OPEN_FOR_WATCHERS = [STATUS.LOBBY, STATUS.STARTING, STATUS.ACTIVE, STATUS.TAHKIM];
export function planJoin(w, userId, want, allowSpectator) {
  const g = w.game, role = want === undefined || want === null ? 'player' : want;
  if (!['player', 'judge', 'spectator'].includes(role)) fail('BAD_REQUEST');
  if (!OPEN_FOR_WATCHERS.includes(g.status)) fail('ROOM_CLOSED');
  const specFree = spectatorsOf(w).length < (g.max_spectators ?? 0);
  if (role === 'player') {
    const free = g.status === STATUS.LOBBY && playersOf(w).length < Math.min(g.max_players ?? 2, SUPPORTED_MAX_PLAYERS);
    if (free) return { role: 'player' };
    if (allowSpectator && specFree) return { role: 'spectator', fell_back: true };
    fail(g.status === STATUS.LOBBY ? 'ROOM_FULL' : 'GAME_STARTED', undefined, { can_spectate: specFree });
  }
  if (role === 'judge') {
    if (!g.judge_enabled) fail('JUDGE_DISABLED');
    if (judgeOf(w)) fail('JUDGE_TAKEN');
    return { role: 'judge' };
  }
  if (!specFree) fail('SPECTATORS_FULL');
  return { role: 'spectator' };
}

// Deals a fresh game for the current round: bag, racks, empty board, zero scores, clock not started.
// Who starts: each player draws one tile from the bag, the higher value starts (a blank counts 0), a tie is drawn again. The tiles go back into the bag.
// The draws are public (they are only tiles of the bag, and the bag is shuffled again before the racks are dealt, so they say nothing about anyone's rack): every round is
// recorded in games.ext.first so both browsers can show the same draw. After MAX_DRAWS ties in a row (about 1 in 10^9) a coin decides.
export const MAX_DRAWS = 12;
// N players (V6.1): every contender draws one tile, the highest starts (a blank counts 0); if several share the highest value ONLY those redraw. Each round is recorded in order
// (rounds[i] = the tiles drawn by the contenders of round i, in seat order); for 3-4 players first.seats[i] names those contenders. For two players this is exactly the old
// pair-draw (same shuffles, same random numbers, same result shape). After MAX_DRAWS rounds a fair random pick among the tied contenders decides (coin: true).
export function drawFirst(bag, rng, seats = [0, 1]) {
  const rounds = [], rseats = []; let c = [...seats];
  for (let i = 0; i < MAX_DRAWS; i++) {
    shuffle(bag, rng);
    const draw = c.map((_, k) => (bag[k].flex ? { l: 'ا', v: bag[k].v, blank: false } : { l: bag[k].blank ? '' : bag[k].l, v: tileValue(bag[k]), blank: !!bag[k].blank }));   // the adaptive alif is drawn as the plain alif it is worth
    rounds.push(draw); rseats.push([...c]);
    const best = Math.max(...draw.map(d => d.v)), top = c.filter((_, k) => draw[k].v === best);
    if (top.length === 1) return { seat: top[0], rounds, ...(seats.length > 2 ? { seats: rseats } : {}) };
    c = top;
  }
  return { seat: c[Math.floor(rng() * c.length)], rounds, coin: true, ...(seats.length > 2 ? { seats: rseats } : {}) };
}
function deal(w, now, deps) {
  const g = w.game, next = idFactory(deps.rng);
  const bag = shuffle(makeTileSet(g.tile_mode, next), deps.rng);
  // deps.noDraw is for tests that need a known first player: it keeps the old rule (the host starts, and each rematch alternates)
  const seats = playerSeats(w);
  // Three or four players: the turn order is DRAWN when the game starts (and again for a rematch): the seat a player took in the lobby is only where they sit.
  // (Two players keep the plain order: a two-seat rotation has nothing to draw, and the random sequence of a two-player game stays exactly as before.)
  const order = !deps.noDraw && seats.length > 2 ? shuffle([...seats], deps.rng) : null;
  const first = deps.noDraw ? { seat: seats[(g.round - 1) % seats.length], rounds: [] } : drawFirst(bag, deps.rng, seats);
  shuffle(bag, deps.rng);   // the drawn tiles went back: the racks are dealt from a fresh shuffle
  w.priv = { bag, undo: null };
  w.racks = {};
  for (const p of [...playersOf(w)].sort((a, b) => a.seat - b.seat)) { w.racks[p.player_id] = Array(RACK).fill(null); refill(w, p.seat); }   // racks exist for players only
  playersOf(w).forEach(p => { p.score = 0; p.ms_left = g.minutes * 60000; });
  Object.assign(g, { board: emptyBoard(), status: STATUS.ACTIVE, current_seat: first.seat, clock_started: false, turn_started_at: null, turn_deadline_at: null,
    tahkim: { state: 'none' }, tahkim_available: false, winner_player_id: null, winner_seat: null, result: null, finished_at: null, rematch_seats: [], started_at: now });
  setExt(g, { pause: null, undo: null, ping: null, pings: {}, pinged: null, tahkim_declined: null, tahkim_log: [], pauses: seats.map(() => 0), out: {}, order, first: { seat: first.seat, rounds: first.rounds, ...(first.seats ? { seats: first.seats } : {}), round: g.round } });
  withBagCount(w);
}
export function startGame(w, userId, now, deps) {
  requireHost(w, userId);
  if (w.game.status !== STATUS.LOBBY) fail('WRONG_STATUS');
  if (playersOf(w).length < 2) fail('NEED_OPPONENT');
  if (wordJudging(w.game) === 'auto' && !(deps && deps.dictionary)) fail('DICT_UNAVAILABLE');   // a room promised automatic judging must be able to keep the promise
  compactSeats(w);   // seats chosen freely in the lobby may have gaps: close them up (the order of the seats is kept) before dealing   // 2 to max_players: the host may start with the seats that are filled
  if (!playersOf(w).every(p => p.player_id === w.game.host_player_id || p.ready)) fail('NOT_READY');
  w.game.round = 1;
  deal(w, now, deps);
  return patchOf(w, 'GAME_STARTED', { racks: 'all', private: true });
}

// ---------- moves ----------
function parsePlacements(pl) {
  if (!Array.isArray(pl) || pl.length < 1 || pl.length > RACK) fail('BAD_REQUEST', 'عدد القطع غير صالح.');
  const ids = new Set(), cells = new Set();
  for (const x of pl) {
    if (!x || typeof x.tileId !== 'string' || !Number.isInteger(x.row) || !Number.isInteger(x.col) || x.row < 0 || x.row >= SIZE || x.col < 0 || x.col >= SIZE) fail('BAD_REQUEST');
    if (x.as !== undefined && x.as !== null && typeof x.as !== 'string') fail('BAD_REQUEST');
    if (ids.has(x.tileId) || cells.has(x.row * SIZE + x.col)) fail('BAD_REQUEST', 'قطعة أو مربع مكرر في الحركة.');
    ids.add(x.tileId); cells.add(x.row * SIZE + x.col);
  }
  return pl;
}
const snapshotForUndo = w => ({
  board: clone(w.game.board), racks: clone(w.racks), bag: clone(w.priv.bag), scores: Object.fromEntries(playersOf(w).map(p => [p.player_id, p.score])),
  tile_counts: Object.fromEntries(playersOf(w).map(p => [p.player_id, p.tile_count])), cur_seat: w.game.current_seat, started: w.game.clock_started
});

// Ends the game. reason: 'rack' | 'time' | 'resign' | 'abandon'. loserSeat is only used by 'resign' and 'abandon' (the player who gave up / vanished).
// Result lines carry everything the result card shows: {seat, score (final), raw, ded, mins, bon}.
export function finish(w, reason, now, loserSeat) {
  settle(w, now);
  const g = w.game, seats = playerSeats(w), alive = seats.filter(x => !isOut(g, x) && x !== loserSeat);
  const forfeit = reason === 'resign' || reason === 'abandon';
  if (reason === 'resign') playerBySeat(w, loserSeat).score = 0;   // surrender rule: whoever gives up drops to 0 at once and the other player wins
  const rawLine = x => ({ seat: x, score: playerBySeat(w, x).score, raw: playerBySeat(w, x).score, ded: 0, mins: 0, bon: 0, ...(isOut(g, x) ? { out: outOf(g)[x] } : {}) });
  let lines;
  if (forfeit) lines = seats.map(rawLine);
  else {   // a normal end: everybody still in the game is settled (rack deduction, clock bonus); an eliminated player keeps the score they had when they left
    const live = seats.filter(x => !isOut(g, x)), res = settleEnd(live.map(x => ({ score: playerBySeat(w, x).score, rack: rackOf(w, x), ms: playerBySeat(w, x).ms_left })));
    lines = seats.map(x => { const k = live.indexOf(x); return k < 0 ? rawLine(x) : { seat: x, ...res[k] }; });
    lines.forEach(l => { playerBySeat(w, l.seat).score = l.score; });
  }
  // Winner: a forfeit is won by the player(s) still standing (best score if more than one); otherwise the highest final score among players still in the game. A tie at the top
  // has NO single winner (winner_seat null); every top seat is listed in result.winners. An eliminated player cannot win.
  const pool = (forfeit ? alive : seats.filter(x => !isOut(g, x))), best = Math.max(...pool.map(x => lines.find(l => l.seat === x).score), -1);
  const winners = pool.filter(x => lines.find(l => l.seat === x).score === best), win = winners.length === 1 ? winners[0] : null;
  Object.assign(g, { status: STATUS.FINISHED, finished_at: now, winner_seat: win, winner_player_id: win == null ? null : playerBySeat(w, win).player_id,
    result: { reason, lines, winner_seat: win, ...(seats.length > 2 ? { winners } : {}), ...(forfeit ? { loser_seat: loserSeat } : { subject_seat: g.current_seat }) }, turn_started_at: null, turn_deadline_at: null, tahkim_available: false, rematch_seats: [] });
  w.priv.undo = null; setExt(g, { pause: null, undo: null, ping: null });
}

// A player leaves the game (resign / abandon / out of time). Two active players left: the old rules, the game ends. Otherwise the player is eliminated and the game goes on:
// the turn passes on if it was theirs, their call / pause / vote / undo request disappear, and a pending Tahkim is re-counted without them. Down to one player: the game ends.
function removeFromGame(w, seat, reason, now) {
  const g = w.game;
  if (activeSeats(w).length <= 2) { finish(w, reason, now, seat); return { state: 'finished' }; }
  settle(w, now);
  setExt(g, { out: { ...outOf(g), [seat]: reason } });
  if (reason === 'resign') playerBySeat(w, seat).score = 0;
  const x = extOf(g);
  if (x.ping && x.ping.by_seat === seat) setExt(g, { ping: null });
  if (x.pause && x.pause.by === seat) setExt(g, { pause: null });
  if (x.undo) setExt(g, { undo: null });
  if (isTahkim(g)) {
    const votes = [...(g.tahkim.votes || [])]; votes[seat] = null; g.tahkim = { ...g.tahkim, votes };
    return { state: 'out', verdict: g.tahkim.resolver === 'judge' ? null : majorityVerdict(w) };   // the remaining voters may already agree
  }
  if (g.status === STATUS.ACTIVE && g.current_seat === seat) g.current_seat = nextSeat(w, seat);
  if (g.status === STATUS.ACTIVE) restartClock(w, now);
  return { state: 'out', verdict: null };
}
// The server's answer to "this player's clock has run out".
function timeoutResult(w, seat, now) {
  const r = removeFromGame(w, seat, 'time', now);
  if (r.verdict) return { ...applyVerdict(w, r.verdict, now, null, null), ended: 'time' };
  return { patch: patchOf(w, r.state === 'out' ? 'PLAYER_OUT' : 'GAME_ENDED', { private: true, racks: 'all' }), ended: 'time' };
}

export function submitMove(w, userId, req, now, deps) {
  const seat = requireTurn(w, userId), g = w.game;
  if (liveMs(w, seat, now) <= 0) return timeoutResult(w, seat, now);
  const placements = parsePlacements(req.placements), rack = rackOf(w, seat);
  const board = clone(g.board).map(r => r.map(t => t && { ...t }));
  const move = [];
  for (const x of placements) {
    const slot = rack.findIndex(t => t && t.id === x.tileId);
    if (slot < 0) fail('TILE_NOT_OWNED');
    if (board[x.row][x.col]) fail('MOVE_INVALID', 'هذا المربع مشغول.');
    const src = rack[slot], t = { id: src.id, l: src.l, v: src.v, blank: src.blank, ...(src.flex ? { flex: true } : {}), as: null, o: seat };
    if (src.blank) { if (typeof x.as !== 'string' || ![...tileAlpha(g.tile_mode, src)].includes(x.as)) fail('MOVE_INVALID', src.flex ? 'اختر صورة صالحة للألف المرنة.' : 'اختر حرفًا صالحًا للقطعة الفارغة.'); t.as = x.as; }
    else if (x.as) fail('BAD_REQUEST');
    board[x.row][x.col] = t; move.push({ t, r: x.row, c: x.col, slot });
  }
  const a = analyzeMove(board, move);
  if (a.err) fail('MOVE_INVALID', a.err);
  const r = scoreWords(a.words, a.isNew, move.length);
  // Word judging: in a 'tahkim' room the players judge (Tahkim), the server never does. In an 'auto' room the dictionary judges every word NOW, before anything is committed:
  // a clearly unknown word refuses the whole move (the tiles stay with the player), a doubtful one is accepted and recorded as 'uncertain'.
  let validation = 'skipped';
  if (wordJudging(g) === 'auto') {
    const dict = deps && deps.dictionary; if (!dict) fail('DICT_UNAVAILABLE');
    const res = dict.judgeAll(a.words.map(x => x.map(y => tileLetter(y.t)).join('')), { mode: g.tile_mode });
    const bad = res.filter(x => !x.ok);
    if (bad.length) fail('WORD_UNKNOWN', explainRejected(bad), { words: bad.map(x => ({ w: x.word, why: x.why })) });
    validation = res.some(x => x.soft) ? 'uncertain' : 'valid';
  }
  // ---- commit to the working copy ----
  const undo = snapshotForUndo(w), p = playerBySeat(w, seat);
  move.forEach(e => { rack[e.slot] = null; });
  g.board = board.map(row => row.map(t => t && pubTile(t)));
  p.score += r.total; refill(w, seat);
  w.priv.undo = undo; g.tahkim = { state: 'none' }; g.tahkim_available = true; clearUndo(w);
  const row = { player_id: userId, seat, turn_number: turnNo(w), action_type: 'move', placements: placements.map(x => ({ tileId: x.tileId, row: x.row, col: x.col, as: x.as || null })),
    formed_words: r.list, score_delta: r.total, validation_result: validation, bingo: r.bingo, swap_count: 0 };
  if (!rack.some(Boolean)) { finish(w, 'rack', now); withBagCount(w); return { patch: patchOf(w, 'GAME_ENDED', { racks: 'all', private: true, move: row }), result: { score: r.total, words: r.list }, ended: 'rack' }; }
  nextTurn(w, now, true); withBagCount(w);
  p.ms_left += INCREMENT_MS; undo.inc = INCREMENT_MS; w.priv.undo = undo;   // chess clock: +5 s for the mover; remembered so a voided / taken-back move gives it back
  return { patch: patchOf(w, 'MOVE_COMMITTED', { racks: [userId], private: true, move: row }), result: { score: r.total, words: r.list } };
}

export function passTurn(w, userId, now) {
  const seat = requireTurn(w, userId);
  if (liveMs(w, seat, now) <= 0) return timeoutResult(w, seat, now);
  w.priv.undo = null; w.game.tahkim = { state: 'none' }; w.game.tahkim_available = false; clearUndo(w);
  const row = { player_id: userId, seat, turn_number: turnNo(w), action_type: 'pass', placements: [], formed_words: [], score_delta: 0, validation_result: 'skipped', bingo: false, swap_count: 0 };
  nextTurn(w, now, false);   // passing is unlimited, exactly like the local game
  return { patch: patchOf(w, 'PASS_COMMITTED', { private: true, move: row }) };
}

export function swapTiles(w, userId, req, now, deps) {
  const seat = requireTurn(w, userId), g = w.game;
  if (liveMs(w, seat, now) <= 0) return timeoutResult(w, seat, now);
  const ids = req.tileIds;
  if (!Array.isArray(ids) || !ids.length || ids.length > RACK || new Set(ids).size !== ids.length || ids.some(i => typeof i !== 'string')) fail('BAD_REQUEST');
  if (w.priv.bag.length < MIN_BAG_SWAP) fail('SWAP_NOT_ALLOWED', `لا يمكن التبديل: في الكيس ${w.priv.bag.length} قطع فقط (الحد الأدنى ${MIN_BAG_SWAP}).`);
  const rack = rackOf(w, seat);
  const idx = ids.map(id => { const i = rack.findIndex(t => t && t.id === id); if (i < 0) fail('TILE_NOT_OWNED'); return i; }).sort((a, b) => a - b);
  const drawn = w.priv.bag.splice(0, idx.length), old = idx.map(i => rack[i]);
  idx.forEach((i, k) => { rack[i] = drawn[k]; });
  w.priv.bag.push(...old.map(t => ({ ...t, as: null }))); shuffle(w.priv.bag, deps.rng);
  w.priv.undo = null; g.tahkim = { state: 'none' }; g.tahkim_available = false; clearUndo(w);
  const row = { player_id: userId, seat, turn_number: turnNo(w), action_type: 'swap', placements: [], formed_words: [], score_delta: 0, validation_result: 'skipped', bingo: false, swap_count: idx.length };
  nextTurn(w, now, false); withBagCount(w);
  return { patch: patchOf(w, 'SWAP_COMMITTED', { racks: [userId], private: true, move: row }) };
}

// ---------- Tahkim: two ways to settle a dispute ----------
// State machine:  none -> pending (discussion open) -> resolved_valid | resolved_invalid  (-> none again on the next committed action)
//   Every dispute has a RESOLVER, stored in games.tahkim.resolver:
//   'consensus'  (room without a Judge, or the Judge is not here)  the two players talk and each selects a verdict; it ends only in a MUTUAL agreement (v5.5 rule, unchanged).
//   'judge'      (room with a Judge who is here)                    the Judge alone gives the final verdict; the players may talk to the Judge, their own selections do nothing.
//   * The challenger is the player now on turn (as in the local game). Asking opens the discussion for everybody at once: no approval step.
//   * status = tahkim_pending: every gameplay action is refused (TAHKIM_PENDING) and both clocks are stopped (turn_started_at = null) until the dispute is resolved.
//   * The verdict is applied by ONE function (applyVerdict) inside one commit (one transaction, revision compare-and-set): it can happen once only.
//   * There is no time limit and nothing lapses by itself. If the Judge disappears the dispute falls back, once, to 'consensus' (judgeFallback); a player who stays away is
//     dealt with by the existing claim_abandon / resign actions.
// The whole discussion lives in games.tahkim, so a refresh or a reconnection restores it exactly. A reason is mandatory for a player's request. Control characters and line breaks are removed.
export const TAHKIM_REASON_MIN = 3, TAHKIM_REASON_MAX = 160;
const cleanText = (r, keepSpaces = false) => (typeof r === 'string' ? r.replace(/[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e]+/g, ' ').replace(/\s+/g, ' ').trim() : '');
export const cleanReason = r => cleanText(r);
export const cleanChat = r => cleanText(r);
export const isTahkim = g => g.status === STATUS.TAHKIM && g.tahkim && g.tahkim.state === 'pending';
const lastMove = w => w.moves[w.moves.length - 1];
// the last move can still be disputed: it is a scored move, nobody has acted on it, and its undo snapshot is still there
const disputable = w => { const last = lastMove(w); return !!(w.priv.undo && last && last.action_type === 'move' && !last.tahkim_status) ? last : null; };
const pendingTahkim = (w, last, over) => ({ state: 'pending', move_number: last.turn_number, requested_at: 0, words: (last.formed_words || []).map(x => x.w), votes: Array(Math.max(2, ...playersOf(w).map(p => p.seat + 1))).fill(null), chat: [], seq: 0, ...over });

export function requestTahkim(w, userId, req, now) {
  const seat = requireTurn(w, userId), g = w.game, last = lastMove(w);
  if (wordJudging(g) === 'auto') fail('TAHKIM_OFF');   // automatic judging: there is no Tahkim in this room
  if (judgeActive(w, now)) fail('USE_JUDGE');   // a Judge room: the dispute goes through call_judge
  if (!disputable(w)) fail('NO_TAHKIM');
  if (extOf(g).tahkim_declined === last.turn_number) fail('TAHKIM_DECLINED');
  const reason = cleanReason(req && req.reason);
  if ([...reason].length < TAHKIM_REASON_MIN) fail('REASON_REQUIRED');
  if ([...reason].length > TAHKIM_REASON_MAX) fail('BAD_REQUEST', 'السبب طويل جدًا.');
  settle(w, now); clearUndo(w);
  g.status = STATUS.TAHKIM; g.turn_started_at = null; g.turn_deadline_at = null;   // both clocks stop now and stay stopped until the dispute is resolved
  g.tahkim = pendingTahkim(w, last, { challenger_seat: seat, reason, requested_at: now, resolver: 'consensus' });
  return { patch: patchOf(w, 'TAHKIM_REQUESTED', { private: true }) };
}

// Chat: the players and the Judge of the room may write; a spectator never. An entry names its author by player id and role (a Judge has no seat: s = null);
// `s` (the seat) is kept for the entries and clients of v5.x.
export function tahkimMessage(w, userId, req, now) {
  const m = requireMember(w, userId), r = roleOf(m), g = w.game;
  if (r === 'spectator') fail('SPECTATOR_READ_ONLY');
  if (!isTahkim(g)) fail('NOT_IN_TAHKIM');
  const text = cleanChat(req && req.text);
  if (!text) fail('EMPTY_MESSAGE');
  if ([...text].length > TAHKIM_MSG_MAX) fail('BAD_REQUEST', 'الرسالة طويلة جدًا.');
  const chat = g.tahkim.chat || [], mine = x => (x.pid ? x.pid === userId : x.s === m.seat);
  if (chat.length >= TAHKIM_CHAT_MAX || chat.filter(mine).length >= TAHKIM_CHAT_EACH) fail('CHAT_FULL');
  const seq = (g.tahkim.seq || chat.length) + 1;
  g.tahkim = { ...g.tahkim, seq, chat: [...chat, { n: seq, s: r === 'player' ? m.seat : null, pid: userId, role: r, nick: m.nickname, t: text, at: now }] };
  return { patch: patchOf(w, 'TAHKIM_MESSAGE') };
}

// The voters are the players still in the game. A verdict needs MORE THAN HALF of them (floor(n/2) + 1): 2 of 2, 2 of 3, 3 of 4. Two players: both must agree, exactly as in v5.5.
// A split (1-1, 2-2, 1-1-abstain...) never decides: the discussion goes on and everybody may change or withdraw their choice. A voter who has not chosen simply has no vote.
export function majorityVerdict(w) {
  const g = w.game, voters = activeSeats(w), votes = (g.tahkim && g.tahkim.votes) || [], need = Math.floor(voters.length / 2) + 1;
  for (const v of ['valid', 'invalid']) if (voters.filter(s => votes[s] === v).length >= need) return v;
  return null;
}
// verdict: 'valid' (صحيح) | 'invalid' (خطأ) | null (withdraw my selection). Consensus only: resolves in the same step when both players hold the same verdict.
export function tahkimVote(w, userId, req, now, deps) {
  const seat = requirePlayer(w, userId), g = w.game;
  if (!isTahkim(g)) fail('NOT_IN_TAHKIM');
  if (g.tahkim.resolver === 'judge') fail('JUDGE_DECIDES');   // the Judge rules: a player's selection cannot settle (or even influence) it
  const v = req && req.verdict;
  if (v !== 'valid' && v !== 'invalid' && v !== null) fail('BAD_REQUEST');
  const votes = [...(g.tahkim.votes || [null, null])]; votes[seat] = v;
  g.tahkim = { ...g.tahkim, votes };
  const win = majorityVerdict(w);
  if (win) return applyVerdict(w, win, now, deps, null);   // a majority independently chose the same: the server finalises it atomically
  return { patch: patchOf(w, 'TAHKIM_VOTE') };   // different, or the other player has not chosen yet: the discussion continues
}

// The verdict is applied exactly once (the caller's commit is a single transaction guarded by the revision, and status leaves TAHKIM here). `by` is the Judge who ruled
// ({player_id, nickname}) or null for a mutual agreement. A dispute without a challenger (the Judge opened it on their own) charges nobody.
function applyVerdict(w, verdict, now, deps, by) {
  const g = w.game, t = g.tahkim, challenger = t.challenger_seat ?? null, u = w.priv.undo, last = lastMove(w);
  if (!u || !last) fail('NO_TAHKIM');
  const rec = { move_number: t.move_number, round: g.round, words: t.words || [], challenger_seat: challenger, reason: t.reason, verdict, at: now,
    players: playerSeats(w).map(s => playerBySeat(w, s)?.nickname || ''), messages: (t.chat || []).length,
    resolver: by ? 'judge' : 'consensus', ...(by ? { resolver_player_id: by.player_id, resolver_nick: by.nickname } : {}), ...(t.fallback ? { fallback: true } : {}) };
  const log = [...(extOf(g).tahkim_log || []), rec].slice(-TAHKIM_LOG_MAX);
  const done = { move_number: t.move_number, challenger_seat: challenger, reason: t.reason, resolved_at: now, resolver: rec.resolver, ...(by ? { resolver_player_id: by.player_id } : {}) };
  g.status = STATUS.ACTIVE; setExt(g, { tahkim_log: log });
  if (verdict === 'valid') {
    let pen = 0;
    if (challenger != null) { const ch = playerBySeat(w, challenger); pen = challengePenalty(ch.score); ch.score -= pen; }
    w.priv.undo = null; g.tahkim_available = false; g.tahkim = { ...done, state: 'resolved_valid' };
    restartClock(w, now);
    return { patch: patchOf(w, 'TAHKIM_RESOLVED', { private: true, move_update: { turn_number: last.turn_number, tahkim_status: 'ok', penalty: pen } }), verdict: 'valid', penalty: pen };
  }
  // invalid: the move is void. Board, racks, bag and scores go back to before the move (clocks are kept), and the mover loses the turn.
  g.board = clone(u.board);
  for (const p of playersOf(w)) { w.racks[p.player_id] = clone(u.racks[p.player_id]); p.score = u.scores[p.player_id]; p.tile_count = u.tile_counts[p.player_id]; }
  w.priv.bag = clone(u.bag); if (deps && deps.rng) shuffle(w.priv.bag, deps.rng);   // the mover saw the tiles they drew: put them back in a NEW order
  [...w.priv.bag, ...Object.values(w.racks).flat()].forEach(t2 => { if (t2 && t2.blank) t2.as = null; });
  g.clock_started = u.started; g.tahkim = { ...done, state: 'resolved_invalid' };
  { const m = playerBySeat(w, u.cur_seat); m.ms_left = Math.max(0, m.ms_left - (u.inc || 0)); }   // a voided move earns no time
  w.priv.undo = null; g.tahkim_available = false; withBagCount(w);
  g.current_seat = u.cur_seat; nextTurn(w, now, false);   // restores the mover, then the turn passes to the challenger
  return { patch: patchOf(w, 'TAHKIM_RESOLVED', { racks: 'all', private: true, move_update: { turn_number: last.turn_number, tahkim_status: 'void', penalty: 0 } }), verdict: 'invalid' };
}

// ---------- the Judge ----------
// call_judge (a player)  ->  waiting for the Judge: the clock stops, gameplay is locked (status stays 'active'; games.ext.ping says why: no second freeze mechanism)
//   judge_open_tahkim    ->  a Tahkim with resolver 'judge' (the ping becomes the dispute: same move, same challenger, same reason)
//   judge_dismiss_ping   ->  the ping is cleared and the clock goes on (the ping still counts against the caller's quota)
//   judge_verdict        ->  the Judge's ruling is final, applied once by applyVerdict
//   Judge not here for JUDGE_ABSENT_MS -> judgeFallback: the open ping / ruling becomes a normal consensus Tahkim, once, nothing lost.
// Quota and the "already asked on this move" memory live in games.ext (pings: {playerId: used}, pinged: {n, pids}), i.e. on the server and in the database, never in a browser.
const DEFAULT_PING_REASON = 'استدعاء الحكم', DEFAULT_JUDGE_REASON = 'بمبادرة الحكم';

export function callJudge(w, userId, req, now) {
  const seat = requirePlayer(w, userId), g = w.game, x = extOf(g);
  if (wordJudging(g) === 'auto') fail('TAHKIM_OFF');
  if (g.status === STATUS.TAHKIM) fail('TAHKIM_PENDING');
  if (g.status !== STATUS.ACTIVE) fail('WRONG_STATUS');
  if (isPaused(g)) fail('PAUSED');
  if (x.ping) fail('WAITING_JUDGE');
  if (!judgeActive(w, now)) fail('JUDGE_NOT_AVAILABLE');
  if (g.current_seat !== seat) fail('WRONG_TURN');
  const last = disputable(w); if (!last) fail('NO_TAHKIM');
  if (x.tahkim_declined === last.turn_number) fail('TAHKIM_DECLINED');
  const pings = { ...(x.pings || {}) }, used = pings[userId] || 0;
  if (used >= PINGS_EACH) fail('PING_LIMIT');
  if (x.pinged && x.pinged.n === last.turn_number && (x.pinged.pids || []).includes(userId)) fail('PING_DUPLICATE');
  const reason = cleanReason(req && req.reason);
  if ([...reason].length > TAHKIM_REASON_MAX) fail('BAD_REQUEST', 'السبب طويل جدًا.');
  settle(w, now); clearUndo(w);
  pings[userId] = used + 1;
  const pinged = x.pinged && x.pinged.n === last.turn_number ? { n: last.turn_number, pids: [...(x.pinged.pids || []), userId] } : { n: last.turn_number, pids: [userId] };
  g.turn_started_at = null; g.turn_deadline_at = null;
  setExt(g, { ping: { by_pid: userId, by_seat: seat, move_number: last.turn_number, reason: reason || null, at: now }, pings, pinged });
  return patchOf(w, 'JUDGE_CALLED');
}
// The caller may take the call back (the Judge never answered, or it was a mistake). The call still counts.
export function cancelPing(w, userId, now) {
  requirePlayer(w, userId);
  const x = extOf(w.game);
  if (!x.ping || x.ping.by_pid !== userId || w.game.status !== STATUS.ACTIVE) fail('NO_PING');
  setExt(w.game, { ping: null }); restartClock(w, now);
  return patchOf(w, 'PING_CANCELLED');
}

export function judgeOpenTahkim(w, userId, req, now) {
  const j = requireJudge(w, userId), g = w.game, x = extOf(g);
  if (wordJudging(g) === 'auto') fail('TAHKIM_OFF');
  if (g.status === STATUS.TAHKIM) fail('TAHKIM_PENDING');
  if (g.status !== STATUS.ACTIVE) fail('WRONG_STATUS');
  if (isPaused(g)) fail('PAUSED');
  const last = disputable(w); if (!last) fail('NO_TAHKIM');
  if (req && req.move_number != null && req.move_number !== last.turn_number) fail('STALE_STATE');
  const ping = x.ping && x.ping.move_number === last.turn_number ? x.ping : null;
  const reason = (ping && ping.reason) || cleanReason(req && req.reason) || (ping ? DEFAULT_PING_REASON : DEFAULT_JUDGE_REASON);
  if ([...reason].length > TAHKIM_REASON_MAX) fail('BAD_REQUEST', 'السبب طويل جدًا.');
  settle(w, now); clearUndo(w);
  setExt(g, { ping: null });
  g.status = STATUS.TAHKIM; g.turn_started_at = null; g.turn_deadline_at = null;
  // challenger_seat: the player who called, or null when the Judge opened it alone (then nobody is charged a challenge penalty). The Judge is recorded as resolver, never as a seat.
  g.tahkim = pendingTahkim(w, last, { challenger_seat: ping ? ping.by_seat : null, reason, requested_at: now, resolver: 'judge', resolver_player_id: j.player_id, resolver_role: 'judge', via_ping: !!ping });
  return { patch: patchOf(w, 'TAHKIM_REQUESTED', { private: true }) };
}
export function judgeDismissPing(w, userId, now) {
  requireJudge(w, userId);
  const g = w.game;
  if (g.status !== STATUS.ACTIVE || !extOf(g).ping) fail('NO_PING');
  setExt(g, { ping: null }); restartClock(w, now);
  return patchOf(w, 'PING_DISMISSED');
}
export function judgeVerdict(w, userId, req, now, deps) {
  const j = requireJudge(w, userId), g = w.game;
  if (!isTahkim(g)) fail('NOT_IN_TAHKIM');
  if (g.tahkim.resolver !== 'judge' || g.tahkim.resolver_player_id !== userId) fail('NOT_RESOLVER');   // the room fell back to the players, or this is another Judge's ruling
  const v = req && req.verdict;
  if (v !== 'valid' && v !== 'invalid') fail('BAD_REQUEST');
  if (req.move_number != null && req.move_number !== g.tahkim.move_number) fail('STALE_STATE');
  return applyVerdict(w, v, now, deps, { player_id: j.player_id, nickname: j.nickname });
}

// The Judge is gone (no Judge row, or silent for JUDGE_ABSENT_MS) while the match waits for them: hand the dispute to the players, once. Returns what it did, or false.
//   open ping        -> a consensus Tahkim on the same move, same challenger, same reason (the ping's own reason, or a default)
//   Judge's ruling   -> the same discussion (reason, chat) continues as consensus; the players' selections start empty
// A ping whose move can no longer be disputed is simply cleared and the clock restarted. Applied on the working copy by the service before every action, and by check_judge.
export function judgeFallback(w, now) {
  const g = w.game, x = extOf(g);
  if (judgePresent(w, now)) return false;
  if (g.status === STATUS.ACTIVE && x.ping) {
    const p = x.ping, last = disputable(w);
    setExt(g, { ping: null });
    if (!last || last.turn_number !== p.move_number) { restartClock(w, now); return 'cleared'; }
    g.status = STATUS.TAHKIM; g.turn_started_at = null; g.turn_deadline_at = null;
    g.tahkim = pendingTahkim(w, last, { challenger_seat: p.by_seat, reason: p.reason || DEFAULT_PING_REASON, requested_at: now, resolver: 'consensus', fallback: true, via_ping: true });
    return 'tahkim';
  }
  if (isTahkim(g) && g.tahkim.resolver === 'judge') {
    const { resolver_player_id, resolver_role, ...rest } = g.tahkim;
    g.tahkim = { ...rest, resolver: 'consensus', fallback: true, votes: (rest.votes || [null, null]).map(() => null) };
    return 'consensus';
  }
  return false;
}
// A player's request to apply the fallback (the browser asks once the Judge has been silent long enough; the SERVER decides from its own last_seen_at).
export function checkJudge(w, userId, now) {
  requirePlayer(w, userId);
  if (!judgeFallback(w, now)) fail('JUDGE_PRESENT');
  return patchOf(w, 'JUDGE_FALLBACK');
}

// ---------- undo with the opponent's approval ----------
// The player who has just moved (and so is waiting for the other one) may ask to take the move back, provided the other player has not acted yet.
// The player on turn answers. Approval restores board, racks, bag and scores to before the move and gives the turn back to the mover (clocks are kept,
// the responder's thinking time is charged). Declining ends it: the same move cannot be asked for again. Acting on the move (move, pass, swap, Tahkim)
// is an implicit decline. The move stays in the history, marked void. (Players only: the Judge has a ruling, not an undo.)
export function requestUndo(w, userId, now) {
  const seat = requirePlayer(w, userId), g = w.game, last = lastMove(w), x = extOf(g);
  if (g.status === STATUS.TAHKIM) fail('TAHKIM_PENDING');
  if (g.status !== STATUS.ACTIVE) fail('WRONG_STATUS');
  if (isPaused(g)) fail('PAUSED');
  if (isPinging(g)) fail('WAITING_JUDGE');
  if (!w.priv.undo || !last || last.action_type !== 'move' || last.tahkim_status || last.seat !== seat || g.current_seat === seat) fail('NO_UNDO');
  if (x.undo && x.undo.move_number === last.turn_number) fail(x.undo.state === 'pending' ? 'UNDO_PENDING' : 'UNDO_DECLINED');
  setExt(g, { undo: { state: 'pending', by: seat, move_number: last.turn_number, at: now } });
  return patchOf(w, 'UNDO_REQUESTED');
}
export function cancelUndo(w, userId) {
  const seat = requirePlayer(w, userId), x = extOf(w.game).undo;
  if (!x || x.state !== 'pending' || x.by !== seat) fail('NO_UNDO');
  setExt(w.game, { undo: null });
  return patchOf(w, 'UNDO_CANCELLED');
}
export function respondUndo(w, userId, req, now, deps) {
  const seat = requirePlayer(w, userId), g = w.game, x = extOf(g).undo;
  if (g.status !== STATUS.ACTIVE) fail('WRONG_STATUS');
  if (isPaused(g)) fail('PAUSED');
  if (isPinging(g)) fail('WAITING_JUDGE');
  if (!x || x.state !== 'pending' || x.by === seat || g.current_seat !== seat) fail('NO_UNDO');   // only the player whose turn it now is answers (in a game of 3-4 the others have no say)
  if (typeof req.accept !== 'boolean') fail('BAD_REQUEST');
  if (!req.accept) { setExt(g, { undo: { ...x, state: 'declined' } }); return patchOf(w, 'UNDO_DECLINED'); }
  const u = w.priv.undo, last = lastMove(w);
  if (!u || !last || last.turn_number !== x.move_number) fail('NO_UNDO');
  settle(w, now);   // the responder's thinking time up to now is charged to them
  g.board = clone(u.board);
  for (const p of playersOf(w)) { w.racks[p.player_id] = clone(u.racks[p.player_id]); p.score = u.scores[p.player_id]; p.tile_count = u.tile_counts[p.player_id]; }
  w.priv.bag = clone(u.bag); if (deps && deps.rng) shuffle(w.priv.bag, deps.rng);   // same reason as a voided move: the mover knows the tiles they drew
  [...w.priv.bag, ...Object.values(w.racks).flat()].forEach(t => { if (t && t.blank) t.as = null; });
  g.clock_started = u.started; g.current_seat = u.cur_seat;
  { const m = playerBySeat(w, u.cur_seat); m.ms_left = Math.max(0, m.ms_left - (u.inc || 0)); }   // a move taken back earns no time
  w.priv.undo = null; g.tahkim_available = false; g.tahkim = { state: 'none' }; withBagCount(w); setExt(g, { undo: null });
  restartClock(w, now);
  return { patch: patchOf(w, 'UNDO_ACCEPTED', { racks: 'all', private: true, move_update: { turn_number: last.turn_number, tahkim_status: 'void', penalty: 0 } }) };
}

// ---------- pause ----------
// Player pause: either player may stop both clocks (PAUSES_EACH times each, PAUSE_MS at most). While paused nothing can be played. The player who paused may resume
// at any time; the other player may resume once the time is up; the first gameplay action after it also resumes (autoResume). Both clocks only restart at the resume.
// Judge pause: the Judge may stop the match at any time, without quota and WITHOUT an expiry (pause.until = null, pause.role = 'judge'). While the Judge is here only the Judge can resume it;
// once the Judge has been gone for JUDGE_ABSENT_MS a player may. It reuses the same pause field and the same clock handling: there is no second freeze mechanism.
export function pauseGame(w, userId, now) {
  const seat = requirePlayer(w, userId), g = w.game, x = extOf(g);
  if (g.status === STATUS.TAHKIM) fail('TAHKIM_PENDING');
  if (g.status !== STATUS.ACTIVE) fail('WRONG_STATUS');
  if (x.pause) fail('PAUSED');
  if (x.ping) fail('WAITING_JUDGE');
  if (x.undo && x.undo.state === 'pending') fail('UNDO_PENDING');
  const used = (x.pauses || [0, 0])[seat] || 0;
  if (used >= PAUSES_EACH) fail('NO_PAUSES_LEFT');
  settle(w, now);
  const pauses = [...(x.pauses || [0, 0])]; pauses[seat] = used + 1;
  g.turn_started_at = null; g.turn_deadline_at = null;
  setExt(g, { pause: { by: seat, at: now, until: now + PAUSE_MS }, pauses });
  return patchOf(w, 'GAME_PAUSED');
}
export function resumeGame(w, userId, now) {
  const seat = requirePlayer(w, userId), g = w.game, x = extOf(g);
  if (g.status !== STATUS.ACTIVE || !x.pause) fail('NOT_PAUSED');
  if (x.pause.role === 'judge') { if (judgePresent(w, now)) fail('JUDGE_PAUSED'); }   // only the Judge resumes their own pause, unless the Judge is gone
  else if (x.pause.by !== seat && now < x.pause.until) fail('NOT_YOURS_TO_RESUME');
  setExt(g, { pause: null }); restartClock(w, now);
  return patchOf(w, 'GAME_RESUMED');
}
export function judgePause(w, userId, now) {
  const j = requireJudge(w, userId), g = w.game, x = extOf(g);
  if (g.status === STATUS.TAHKIM) fail('TAHKIM_PENDING');
  if (g.status !== STATUS.ACTIVE) fail('WRONG_STATUS');
  if (x.pause) fail('PAUSED');
  settle(w, now);
  g.turn_started_at = null; g.turn_deadline_at = null;
  setExt(g, { pause: { by: null, role: 'judge', pid: j.player_id, at: now, until: null } });
  return patchOf(w, 'GAME_PAUSED');
}
export function judgeResume(w, userId, now) {
  requireJudge(w, userId);
  const g = w.game, x = extOf(g);
  if (g.status !== STATUS.ACTIVE || !x.pause) fail('NOT_PAUSED');
  setExt(g, { pause: null }); restartClock(w, now);   // the Judge may end any pause, their own or a player's
  return patchOf(w, 'GAME_RESUMED');
}
// Called by the service before any action (except resume itself): an expired player pause ends by itself, so a stopped game can never block play. A Judge pause has no expiry.
export function autoResume(w, now) {
  const g = w.game, x = extOf(g);
  if (x.pause && x.pause.until != null && g.status === STATUS.ACTIVE && now >= x.pause.until) { setExt(g, { pause: null }); restartClock(w, now); }
}

// ---------- things that happen because time passed (applied by the service before any action and by the heartbeat) ----------
// A clock that has run out ends the game as soon as ANY request reaches the server, so an expired player can no longer freeze it with a pause, a Tahkim request or an undo.
export function expiredPatch(w, now) {
  const g = w.game;
  if (g.status !== STATUS.ACTIVE || !clockRunning(g) || liveMs(w, g.current_seat, now) > 0) return null;
  return timeoutResult(w, g.current_seat, now);
}
// ---------- end / time / resign / rematch ----------
export function resign(w, userId, now) {
  const seat = requirePlayer(w, userId);
  if (!PLAYING.includes(w.game.status)) fail('WRONG_STATUS');
  const r = removeFromGame(w, seat, 'resign', now);   // two active players: the game ends (v5.4); 3-4: the player is eliminated and the others play on
  if (r.verdict) return applyVerdict(w, r.verdict, now, null, null);
  return { patch: patchOf(w, r.state === 'out' ? 'PLAYER_OUT' : 'GAME_ENDED', { private: true, racks: 'all' }) };
}
// Any member may ask (the browser of a Judge or a spectator also notices a stopped clock); only the server's own clock decides.
export function claimTimeout(w, userId, now) {
  requireMember(w, userId);
  if (w.game.status !== STATUS.ACTIVE) fail('WRONG_STATUS');
  if (!clockRunning(w.game) || liveMs(w, w.game.current_seat, now) > 0) fail('NOT_EXPIRED');
  const { ended, ...res } = timeoutResult(w, w.game.current_seat, now);
  return res;
}
// The player the match is waiting for: whoever is on turn. While a Tahkim discussion is open BOTH players are needed (it ends only in a mutual agreement),
// so each of them is waiting for the other one: pass the asking player's seat as `viewer`. While the match waits for the JUDGE (a call, the Judge's ruling, a Judge pause)
// it is not waiting for any player: nobody can claim abandon against a player then (a silent Judge is handled by judgeFallback / the player's resume instead).
export function blockingSeats(w, viewer) {
  const g = w.game, x = g.ext || {};
  if (x.ping || (x.pause && x.pause.role === 'judge')) return [];
  if (g.status === STATUS.TAHKIM) {
    if (g.tahkim && g.tahkim.resolver === 'judge') return [];
    const others = activeSeats(w).filter(s => s !== viewer);
    if (viewer == null) return [];
    // two active players: each needs the other (v5.5). Three or four: only the voters who have not chosen yet can hold the dispute up (the rest can already make a majority).
    return others.length === 1 ? others : others.filter(s => ((g.tahkim.votes || [])[s] ?? null) == null);
  }
  return g.current_seat == null ? [] : [g.current_seat];
}
export const blockingSeat = (w, viewer) => blockingSeats(w, viewer)[0] ?? null;
// How long the server has heard nothing from a player (every action and every heartbeat refreshes last_seen_at).
export const idleMs = (w, seat, now) => { const p = playerBySeat(w, seat); return p && p.last_seen_at != null ? Math.max(0, now - p.last_seen_at) : 0; };
export const memberIdleMs = (m, now) => (m && m.last_seen_at != null ? Math.max(0, now - m.last_seen_at) : 0);
// The other player may end the match in their favour once the one being waited for has been silent for ABANDON_MS. Only the server's
// own knowledge counts, so a browser cannot claim early, and nobody can claim against a player who is not the one holding the match up.
export function claimAbandon(w, userId, now) {
  const seat = requirePlayer(w, userId);
  if (!PLAYING.includes(w.game.status)) fail('WRONG_STATUS');
  const gone = blockingSeats(w, seat).filter(s => s !== seat && idleMs(w, s, now) >= ABANDON_MS);
  if (!gone.length) fail('NOT_ABANDONED');
  let verdict = null;
  for (const s of gone) { const r = removeFromGame(w, s, 'abandon', now); if (r.state === 'finished') { verdict = null; break; } verdict = r.verdict || verdict; }   // 3-4 players: every silent blocker is eliminated; at two the game ends
  if (verdict && w.game.status === STATUS.TAHKIM) return applyVerdict(w, verdict, now, null, null);
  return { patch: patchOf(w, w.game.status === STATUS.FINISHED ? 'GAME_ENDED' : 'PLAYER_OUT', { private: true, racks: 'all' }) };
}
export function requestRematch(w, userId, now, deps) {
  const seat = requirePlayer(w, userId, { allowOut: true }), g = w.game;
  if (g.status !== STATUS.FINISHED) fail('WRONG_STATUS');
  const set = new Set(g.rematch_seats || []); set.add(seat); g.rematch_seats = [...set].sort();
  // a rematch starts when EVERY player still in the room has asked (and there are at least two); a player who does not want one leaves the room
  if (set.size < 2 || set.size < playersOf(w).length) return { patch: patchOf(w, 'REMATCH_REQUESTED') };
  compactSeats(w); g.round += 1; deal(w, now, deps);   // a brand-new bag and racks; nothing of the previous round is reused. The Judge and the spectators stay in the room.
  return { patch: patchOf(w, 'GAME_STARTED', { racks: 'all', private: true }) };
}
