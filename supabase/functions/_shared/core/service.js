// Request handling for online play: authenticate (done by the caller), load state, run ONE authoritative transition,
// commit it atomically, answer with the caller's snapshot.
//
// The Store is the only I/O boundary (supabase/functions/eas-game/store.ts in production, tests/online/memory-store.mjs in tests):
//   findOpenGameId(userId, {includeFinished}) -> id | null   the player's lobby/active game (optionally a match finished in the last 30 min); open ones win
//   getGameIdByCode(code)             -> id | null
//   load(gameId)                      -> { game, players, racks, priv, moves } | null     (times as epoch ms)
//   getAction(gameId, actionId)       -> result | null
//   createGame(game, player)          -> throws {code:'ROOM_CODE_TAKEN'} on a duplicate room code
//   commit(gameId, expectedRevision, actionId|null, userId, patch, result) -> {revision}  | {duplicate:true, result}
//                                       throws {code:'STALE_REVISION'} when the revision moved; applies everything atomically
//   touch(gameId, userId, state)      -> void         connection_state / last_seen_at only; never bumps the revision
import { GameError, fail, MSG } from './errors.js';
import * as E from './engine.js';
import { buildSnapshot } from './snapshot.js';
import { newRoomCode, normalizeRoomCode, cleanNickname } from './codes.js';
import { DURATIONS, DEFAULT_MINUTES, DEFAULT_MODE, DEFAULT_MAX_SPECTATORS, JUDGE_ABSENT_MS } from '../game/config.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = s => typeof s === 'string' && UUID.test(s);
const PINNED = new Set(['set_ready', 'submit_move', 'pass_turn', 'swap_tiles', 'request_tahkim', 'call_judge', 'request_undo', 'respond_undo', 'cancel_undo']);   // tahkim_message / tahkim_vote are NOT pinned: two players talk and choose at the same time, and the server re-reads and applies each one to the latest state (idempotent by client_action_id)   // Judge actions (judge_open_tahkim, judge_dismiss_ping, judge_verdict, judge_pause, judge_resume), check_judge and cancel_ping are not pinned either: the server re-reads and applies each to the latest state, and a Judge ruling names the move it is about instead.   // must name the revision they were based on (set_ready too: a "ready" given on a screen that has not seen the host's latest rule change is refused)

// Actions that must still work when a clock has run out (they settle the match themselves).
const NO_EXPIRY_CHECK = new Set(['resign_game', 'claim_timeout', 'claim_abandon', 'leave_room']);
// Failed room-code guesses per player (per server instance): after JOIN_FAILS_MAX misses within JOIN_WINDOW_MS further attempts are refused until the window ends.
const JOIN_FAILS_MAX = 8, JOIN_WINDOW_MS = 60000;
const joinFails = new WeakMap();   // store -> Map(userId -> {n, since})
const failsOf = store => { let m = joinFails.get(store); if (!m) { m = new Map(); joinFails.set(store, m); } return m; };

const rejected = (e, snapshot) => ({ ok: false, code: e.code, message: e.message || MSG[e.code] || MSG.SERVER_ERROR, ...(e.extra || {}), ...(snapshot ? { snapshot } : {}) });

// Actions that may need the dictionary (rooms judged automatically). It is loaded lazily and cached by the host (deps.loadDictionary), then handed to the engine as deps.dictionary.
const NEEDS_DICTIONARY = new Set(['create_room', 'update_settings', 'start_game', 'submit_move']);
export async function handleRequest(store, userId, body, deps) {
  const now = deps.now(), log = deps.log || (() => {});
  const action = body?.action;
  if (NEEDS_DICTIONARY.has(action) && deps.loadDictionary && (action === 'submit_move' || action === 'start_game' || body?.settings?.word_judging === 'auto')) {
    try { deps = { ...deps, dictionary: (await deps.loadDictionary()) || null }; } catch (e) { log('dictionary_failed', { error: String(e?.message || e).slice(0, 120) }); deps = { ...deps, dictionary: null }; }
  }
  try {
    if (!isUuid(userId)) fail('NOT_MEMBER');
    switch (action) {
      case 'create_room': return await createRoom(store, userId, body, now, deps);
      case 'join_room': return await joinRoom(store, userId, body, now, deps);
      case 'reconnect': return await reconnect(store, userId, now, deps);
      case 'snapshot': return await readSnapshot(store, userId, body, now, deps);
      case 'heartbeat': return await heartbeat(store, userId, body, now, deps);
      case 'set_ready': return await mutate(store, userId, body, now, deps, (w) => E.setReady(w, userId, body.ready));
      case 'update_settings': return await mutate(store, userId, body, now, deps, (w) => E.updateSettings(w, userId, body.settings, deps));
      case 'choose_slot': return await mutate(store, userId, body, now, deps, (w) => E.chooseSlot(w, userId, body));
      case 'leave_room': return await mutate(store, userId, body, now, deps, (w) => E.leaveRoom(w, userId, now));
      case 'start_game': return await mutate(store, userId, body, now, deps, (w) => E.startGame(w, userId, now, deps));
      case 'submit_move': return await mutate(store, userId, body, now, deps, (w) => E.submitMove(w, userId, body, now, deps));
      case 'pass_turn': return await mutate(store, userId, body, now, deps, (w) => E.passTurn(w, userId, now));
      case 'swap_tiles': return await mutate(store, userId, body, now, deps, (w) => E.swapTiles(w, userId, body, now, deps));
      case 'request_tahkim': return await mutate(store, userId, body, now, deps, (w) => E.requestTahkim(w, userId, body, now));
      case 'call_judge': return await mutate(store, userId, body, now, deps, (w) => E.callJudge(w, userId, body, now));
      case 'cancel_ping': return await mutate(store, userId, body, now, deps, (w) => E.cancelPing(w, userId, now));
      case 'judge_open_tahkim': return await mutate(store, userId, body, now, deps, (w) => E.judgeOpenTahkim(w, userId, body, now));
      case 'judge_dismiss_ping': return await mutate(store, userId, body, now, deps, (w) => E.judgeDismissPing(w, userId, now));
      case 'judge_verdict': return await mutate(store, userId, body, now, deps, (w) => E.judgeVerdict(w, userId, body, now, deps));
      case 'judge_pause': return await mutate(store, userId, body, now, deps, (w) => E.judgePause(w, userId, now));
      case 'judge_resume': return await mutate(store, userId, body, now, deps, (w) => E.judgeResume(w, userId, now));
      case 'check_judge': return await mutate(store, userId, body, now, deps, (w) => E.checkJudge(w, userId, now));
      case 'tahkim_message': return await mutate(store, userId, body, now, deps, (w) => E.tahkimMessage(w, userId, body, now));
      case 'tahkim_vote': return await mutate(store, userId, body, now, deps, (w) => E.tahkimVote(w, userId, body, now, deps));
      case 'request_undo': return await mutate(store, userId, body, now, deps, (w) => E.requestUndo(w, userId, now));
      case 'cancel_undo': return await mutate(store, userId, body, now, deps, (w) => E.cancelUndo(w, userId));
      case 'respond_undo': return await mutate(store, userId, body, now, deps, (w) => E.respondUndo(w, userId, body, now, deps));
      case 'pause_game': return await mutate(store, userId, body, now, deps, (w) => E.pauseGame(w, userId, now));
      case 'resume_game': return await mutate(store, userId, body, now, deps, (w) => E.resumeGame(w, userId, now));
      case 'resign_game': return await mutate(store, userId, body, now, deps, (w) => E.resign(w, userId, now));
      case 'claim_timeout': return await mutate(store, userId, body, now, deps, (w) => E.claimTimeout(w, userId, now));
      case 'claim_abandon': return await mutate(store, userId, body, now, deps, (w) => E.claimAbandon(w, userId, now));
      case 'rematch': return await mutate(store, userId, body, now, deps, (w) => E.requestRematch(w, userId, now, deps));
      default: fail('BAD_REQUEST');
    }
  } catch (e) {
    if (e instanceof GameError) { log('action_rejected', { action, code: e.code, user: userId }); return rejected(e, e.extra?.snapshot); }
    const text = String(e?.message || e);
    log('action_error', { action, user: userId, error: text.slice(0, 200) });   // never the stack, never state
    // A missing table / column / function means the SQL migrations have not been run (or not all of them): say so instead of a generic error.
    if (/PGRST20[25]|does not exist|could not find the (function|table)|schema cache/i.test(text)) return rejected(new GameError('DB_NOT_READY', MSG.DB_NOT_READY));
    return rejected(new GameError('SERVER_ERROR', MSG.SERVER_ERROR));
  }
}

const loadFor = async (store, gameId) => {
  if (!isUuid(gameId)) fail('BAD_REQUEST');
  const w = await store.load(gameId);
  if (!w) fail('ROOM_NOT_FOUND');
  return w;
};

async function snapshotResponse(store, userId, gameId, now, extra = {}) {
  const w = await loadFor(store, gameId);
  return { ok: true, ...extra, snapshot: buildSnapshot(w, userId, now) };
}

async function readSnapshot(store, userId, body, now, deps) {
  const w = await loadFor(store, body.game_id);
  deps.log?.('snapshot', { game: w.game.id });
  return { ok: true, snapshot: buildSnapshot(w, userId, now) };
}

// Refreshes the caller's last_seen_at (the server's only evidence that a player is still there) and says which revision exists, so the page can
// notice a missed realtime event without downloading a snapshot. Never bumps the revision.
async function heartbeat(store, userId, body, now, deps) {
  if (!isUuid(body.game_id)) fail('BAD_REQUEST');
  // Light read (game + players only): the heartbeat runs every 20 s per player and must not download racks, the bag and the whole move list.
  const w = await (store.loadLite ? store.loadLite(body.game_id) : store.load(body.game_id));
  if (!w) fail('ROOM_NOT_FOUND');
  const me = E.memberOf(w, userId);
  if (!me) fail('NOT_MEMBER');
  await store.touch(w.game.id, userId, 'online', now);
  const { revision, status } = w.game, role = E.roleOf(me), judge = E.judgeOf(w);
  // Nothing lapses by itself any more (a Tahkim discussion has no time limit): the heartbeat only records presence and reports the revision.
  // opp_idle_ms: a player is told how long the other PLAYER has been silent; the Judge and spectators have no opponent (null). judge_idle_ms: how long the Judge has been silent (null: no Judge).
  const opp = role === 'player' ? E.playersOf(w).find(p => p.seat !== me.seat) : null;
  return { ok: true, revision, status, server_now: now, role, opp_idle_ms: opp ? E.memberIdleMs(opp, now) : null, judge_idle_ms: judge && judge.player_id !== userId ? E.memberIdleMs(judge, now) : null,
    judge_present: !!w.game.judge_enabled && E.judgePresent(w, now) };
}

async function reconnect(store, userId, now, deps) {
  const id = await store.findOpenGameId(userId, { includeFinished: true });   // a match that just ended can still be viewed after a refresh
  if (!id) return { ok: true, snapshot: null };
  await store.touch(id, userId, 'online', now);
  deps.log?.('player_reconnected', { game: id });
  return snapshotResponse(store, userId, id, now);
}

async function createRoom(store, userId, body, now, deps) {
  const existing = await store.findOpenGameId(userId);
  if (existing) fail('ALREADY_IN_GAME', MSG.ALREADY_IN_GAME, { snapshot: (await snapshotResponse(store, userId, existing, now)).snapshot });
  const { live, word_judging, ...cols } = E.sanitizeSettings(body.settings);
  if (word_judging === 'auto' && !deps.dictionary) fail('DICT_UNAVAILABLE');
  const settings = { tile_mode: DEFAULT_MODE, minutes: DEFAULT_MINUTES, validator_mode: 'off', max_players: 2, judge_enabled: false, max_spectators: DEFAULT_MAX_SPECTATORS, ...cols, ...(word_judging === 'auto' ? { judge_enabled: false } : {}) };   // validator_mode is a legacy column: words are judged by Tahkim only
  const nick = cleanNickname(body.nickname);
  for (let attempt = 0; attempt < 8; attempt++) {
    const code = newRoomCode(deps.rng), id = deps.uuid();
    const game = { id, room_code: code, host_player_id: userId, status: E.STATUS.LOBBY, ...settings, round: 1, revision: 1, current_seat: null, current_player_id: null,
      board: E.emptyBoard(), turn_started_at: null, turn_deadline_at: null, clock_started: false, tahkim: { state: 'none' }, tahkim_available: false, bag_count: 0,
      winner_player_id: null, winner_seat: null, result: null, rematch_seats: [], started_at: null, finished_at: null, created_at: now,
      ext: { live: live ?? true, word_judging: word_judging ?? 'tahkim', pause: null, undo: null, pauses: [0, 0] } };
    const player = { player_id: userId, role: 'player', seat: 0, nickname: nick, score: 0, tile_count: 0, ms_left: settings.minutes * 60000, ready: true, connection_state: 'online' };
    try { await store.createGame(game, player); }
    catch (e) { if (e?.code === 'ROOM_CODE_TAKEN') continue; if (e?.code === 'ALREADY_IN_GAME') fail('ALREADY_IN_GAME'); throw e; }
    deps.log?.('room_created', { game: id, room: code });
    return snapshotResponse(store, userId, id, now, { created: true });
  }
  fail('SERVER_ERROR');
}

async function joinRoom(store, userId, body, now, deps) {
  const fails = failsOf(store), f = fails.get(userId);
  if (f && now - f.since < JOIN_WINDOW_MS && f.n >= JOIN_FAILS_MAX) fail('RATE_LIMITED');   // guessing codes: stop after a handful of misses
  const miss = () => { const g = fails.get(userId); if (!g || now - g.since >= JOIN_WINDOW_MS) fails.set(userId, { n: 1, since: now }); else g.n++; fail('ROOM_NOT_FOUND'); };
  const code = normalizeRoomCode(body.code);
  const id = code && await store.getGameIdByCode(code);
  if (!id) miss();
  const w = await store.load(id);
  if (!w) miss();
  return await joinLoaded(store, userId, body, w, id, now, deps, miss);
}

// Join as player, judge or spectator. A returning member is never "joining again" (same role as before). Capacity and roles are decided from the freshly loaded room and
// re-checked by the database in the same transaction as the insert; when somebody else got in first (the revision moved) the room is re-read and the decision repeated.
async function joinLoaded(store, userId, body, w0, id, now, deps, miss) {
  let w = w0;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (E.memberOf(w, userId)) { await store.touch(id, userId, 'online', now); return snapshotResponse(store, userId, id, now, { rejoined: true, role: E.roleOf(E.memberOf(w, userId)) }); }
    const mine = await store.findOpenGameId(userId);
    if (mine) fail('ALREADY_IN_GAME', MSG.ALREADY_IN_GAME, { snapshot: (await snapshotResponse(store, userId, mine, now)).snapshot });
    const plan = E.planJoin(w, userId, body.role, body.allow_spectator === true);
    let nick = cleanNickname(body.nickname);
    if (w.players.some(p => p.nickname === nick)) nick = cleanNickname(nick + ' 2');
    const player = plan.role === 'player';
    const add = { player_id: userId, role: plan.role, seat: player ? E.playersOf(w).length : null, nickname: nick, score: 0, tile_count: 0, ms_left: player ? w.game.minutes * 60000 : 0, ready: false, connection_state: 'online' };
    if (player) add.seat = [0, 1, 2, 3].find(s => !E.playersOf(w).some(p => p.seat === s));   // the lowest free seat
    const patch = { event: player ? 'PLAYER_JOINED' : 'ROSTER_JOINED', game: {}, players: [], racks: [], add_player: add, ...(player ? {} : { roster_only: true }) };
    try {
      await commitPatch(store, w, null, userId, patch, { action: 'join_room', role: plan.role }, now, deps, 'join_room');
    } catch (e) {
      if (e instanceof GameError && ['CONFLICT', 'ROOM_FULL', 'GAME_STARTED', 'JUDGE_TAKEN', 'SPECTATORS_FULL'].includes(e.code) && attempt < 3) { w = await loadFor(store, id); continue; }   // lost a race: decide again on the new state
      throw e;
    }
    return snapshotResponse(store, userId, id, now, { role: plan.role, ...(plan.fell_back ? { fell_back: true } : {}) });
  }
  fail('CONFLICT');
}

async function commitPatch(store, w, actionId, userId, patch, result, now, deps, action) {
  let r;
  try { r = await store.commit(w.game.id, w.game.revision, actionId, userId, patch, result); }
  catch (e) {
    if (e?.code === 'STALE_REVISION') fail('CONFLICT');
    if (e?.code === 'SEAT_TAKEN') fail('ROOM_FULL');
    if (['ROOM_FULL', 'GAME_STARTED', 'JUDGE_DISABLED', 'JUDGE_TAKEN', 'SPECTATORS_FULL'].includes(e?.code)) fail(e.code);
    if (e?.code === 'ALREADY_IN_GAME') fail('ALREADY_IN_GAME');
    throw e;
  }
  deps.log?.('action_committed', { action, game: w.game.id, revision: r.revision, event: patch.event });
  return r;
}

// One authoritative gameplay/lobby mutation.
async function mutate(store, userId, body, now, deps, fn) {
  const action = body.action;
  if (!isUuid(body.game_id)) fail('BAD_REQUEST');
  const actionId = body.client_action_id;
  if (!isUuid(actionId)) fail('BAD_REQUEST', 'معرّف الإجراء مفقود.');
  // Idempotency: a retry of an action that already committed answers with the current state instead of acting twice.
  const done = await store.getAction(body.game_id, actionId);
  if (done) {
    if (done.player_id !== userId) fail('NOT_MEMBER');
    deps.log?.('action_duplicate', { action, game: body.game_id });
    return snapshotResponse(store, userId, body.game_id, now, { duplicate: true, ...(done.result || {}) });
  }
  for (let attempt = 0; attempt < (PINNED.has(action) ? 2 : 6); attempt++) {   // unpinned actions (lobby, Tahkim chat / vote) re-read and retry when they race with the other player's
    const w = await loadFor(store, body.game_id);
    const me = E.memberOf(w, userId); if (!me) fail('NOT_MEMBER');
    if (PINNED.has(action) && body.base_revision !== w.game.revision)
      fail('STALE_STATE', MSG.STALE_STATE, { snapshot: buildSnapshot(w, userId, now) });
    w.game = { ...w.game }; w.players = w.players.map(p => ({ ...p }));
    E.memberOf(w, userId).last_seen_at = now;   // whoever acts is here right now (working copy only: a Judge acting is never "absent" for their own request)
    if (action !== 'resume_game' && action !== 'judge_resume') E.autoResume(w, now);
    if (action !== 'check_judge' && action !== 'leave_room') E.judgeFallback(w, now);   // a vanished Judge never leaves the match waiting: it falls back to the players (see engine.judgeFallback)   // an expired pause ends by itself
    // Time that passed decides first: an expired clock ends the match. It replaces the requested action
    // (the caller receives the new state), so an expired player cannot dodge the clock with a pause, an undo or a Tahkim request.
    const pre = NO_EXPIRY_CHECK.has(action) ? null : E.expiredPatch(w, now);
    let out = pre || await fn(w);
    if (!out.patch) out = { patch: out };
    const { patch, ended, ...extra } = out;
    let r;
    try { r = await store.commit(w.game.id, w.game.revision, actionId, userId, patch, { action, ...extra }); }
    catch (e) {
      if (e?.code === 'STALE_REVISION') {
        if (PINNED.has(action)) fail('STALE_STATE', MSG.STALE_STATE, { snapshot: buildSnapshot(await loadFor(store, body.game_id), userId, now) });
        continue;   // an unpinned lobby action raced with another one: re-read and try once more
      }
      if (e?.code === 'DUPLICATE_ACTION') return snapshotResponse(store, userId, body.game_id, now, { duplicate: true });
      throw e;
    }
    if (r.duplicate) return snapshotResponse(store, userId, body.game_id, now, { duplicate: true });
    deps.log?.('action_committed', { action, game: w.game.id, revision: r.revision, event: patch.event });
    await store.touch(w.game.id, userId, 'online', now).catch(() => {});   // any action proves the player is there
    const fresh = await loadFor(store, body.game_id);
    if (!E.memberOf(fresh, userId)) return { ok: true, left: true };   // the caller just left the room: nothing of it may be shown to them any more
    const snapshot = buildSnapshot(fresh, userId, now);
    if (ended === 'time') return { ok: false, code: 'TIME_UP', message: MSG.TIME_UP, snapshot };
    return { ok: true, ...extra, snapshot };
  }
  fail('CONFLICT');
}
