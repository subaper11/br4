// What a room member is allowed to see (a player, the Judge or a spectator). This is the ONLY place server state becomes client-visible data, so the privacy rules are
// enforced here once: the board, scores, tile COUNTS, clock, Tahkim state and move history are public; a PLAYER's own rack is
// included; no other rack, the bag (only its size) and the undo snapshot are never included. The Judge and the spectators receive me.rack = [] and no rack of anyone, on every path
// (snapshot, reconnect, duplicate answer, stale-state error): they all come through this function.
import { STATUS, clockRunning, memberOf, roleOf, playersOf, judgeOf, spectatorsOf, judgePresent, playerBySeat, idleMs, memberIdleMs, blockingSeat, blockingSeats, outOf, extOf, wordJudging } from './engine.js';
import { PAUSES_EACH, PINGS_EACH } from '../game/config.js';
import { fail } from './errors.js';

export function historyItem(m) {
  const it = { n: m.turn_number, p: m.seat, type: m.action_type, words: m.formed_words || [], total: m.score_delta, bingo: !!m.bingo };
  if (m.action_type === 'swap') it.cnt = m.swap_count;
  if (m.action_type === 'move') it.cells = (m.placements || []).map(x => [x.row, x.col]);   // where the move landed (the board is public; tile ids are not sent)
  if (m.tahkim_status) it.st = m.tahkim_status;
  if (m.penalty) it.pen = m.penalty;
  return it;
}

export function buildSnapshot(w, userId, now) {
  const me0 = memberOf(w, userId);
  if (!me0) fail('NOT_MEMBER');
  const role = roleOf(me0), isPlayer = role === 'player', g = w.game, x = extOf(g), seat = isPlayer ? me0.seat : null, mine = isPlayer ? playerBySeat(w, seat) : null;
  const judge = judgeOf(w), roster = playersOf(w).slice().sort((a, b) => a.seat - b.seat), pingsOf = p => Math.max(0, PINGS_EACH - ((x.pings || {})[p.player_id] || 0));
  // Spectators see the public state of a dispute but not the players' private discussion with the Judge.
  const tahkim = role === 'spectator' && g.tahkim && g.tahkim.chat ? { ...g.tahkim, chat: [], chat_count: g.tahkim.chat.length } : g.tahkim;
  return {
    server_now: now,
    game: {
      id: g.id, room_code: g.room_code, host_player_id: g.host_player_id, status: g.status, tile_mode: g.tile_mode, minutes: g.minutes,
      round: g.round, revision: g.revision, current_seat: g.current_seat, turn_started_at: g.turn_started_at, turn_deadline_at: g.turn_deadline_at, clock_running: clockRunning(g),
      clock_started: g.clock_started, tahkim, tahkim_available: !!g.tahkim_available, bag_count: g.bag_count, result: g.result, winner_seat: g.winner_seat,
      rematch_seats: g.rematch_seats || [], started_at: g.started_at, finished_at: g.finished_at,
      max_players: g.max_players ?? 2, judge_enabled: !!g.judge_enabled, max_spectators: g.max_spectators ?? 0,
      word_judging: wordJudging(g),   // 'tahkim' (players / Judge rule on a challenged word) or 'auto' (the dictionary judges every move; no Tahkim)
      live: x.live !== false,   // live preview of the tentative tiles: on unless the host switched it off
      order: Array.isArray(x.order) ? x.order : null,   // the drawn turn order of a 3-4 player game (seats); null = seat order
      pause: x.pause || null, pauses_left: roster.map(p => Math.max(0, PAUSES_EACH - ((x.pauses || [])[p.seat] || 0))),   // by seat order
      out: outOf(g),   // eliminated seats: {"<seat>": reason}
      judge_present: !!g.judge_enabled && judgePresent(w, now),   // a Judge room whose Judge is here: players call the Judge instead of opening a consensus Tahkim
      ping: x.ping || null,   // a player called the Judge and the match waits (public: who, which move, why)
      waiting_judge: !!x.ping && g.status === STATUS.ACTIVE,
      pings_left: roster.map(pingsOf),   // by seat
      first: x.first || null,   // how the first player was drawn: [[tile, tile], ...] (public, see drawFirst)
      tahkim_log: x.tahkim_log || [],   // resolved Tahkim records of this round (public, server-confirmed)
      tahkim_declined: x.tahkim_declined ?? null,   // the move number whose challenge the opponent declined
      undo_req: x.undo || null   // the mover's request to take a move back (public; NOT the private undo snapshot)
    },
    // players: the people who hold a seat. The Judge and the spectators are listed separately and never get a seat.
    players: roster.map(p => ({ player_id: p.player_id, seat: p.seat, nickname: p.nickname, score: p.score, tile_count: p.tile_count,
      ms_left: p.ms_left, ready: p.ready, connection_state: p.connection_state, idle_ms: idleMs(w, p.seat, now), out: outOf(g)[p.seat] ?? null })),
    judge: judge ? { player_id: judge.player_id, nickname: judge.nickname, online: judgePresent(w, now), idle_ms: memberIdleMs(judge, now) } : null,
    spectator_count: spectatorsOf(w).length,
    spectators: g.status === STATUS.LOBBY ? spectatorsOf(w).map(p => ({ player_id: p.player_id, nickname: p.nickname })) : [],   // names are shown in the lobby's gallery row only
    // a change of who is in the room does not change the revision, so the page compares this to notice it
    roster: (judge ? judge.player_id : '-') + ':' + spectatorsOf(w).length,
    waiting_seats: [STATUS.ACTIVE, STATUS.TAHKIM].includes(g.status) ? blockingSeats(w, isPlayer ? seat : null) : [],
    waiting_seat: [STATUS.ACTIVE, STATUS.TAHKIM].includes(g.status) ? blockingSeat(w, isPlayer ? seat : null) : null,   // who the match is waiting for (the only seat that can be claimed against)
    board: g.board,
    moves: w.moves.map(historyItem),
    me: { player_id: userId, role, seat, rack: isPlayer && mine ? (w.racks[mine.player_id] || []) : [] }
  };
}
