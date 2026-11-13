-- V6.1: online games of 2-4 players. Additive on top of 001-008; nothing here changes a two-player room.
-- Seats: game_players.seat was already widened to 0..3 in 008. Here games.current_seat is widened too (the turn can now belong to seat 2 or 3).
-- winner_seat, game_moves.seat and rematch_seats carry no seat range constraint (checked in 001), so they already accept 0..3.
-- Eliminated players are NOT deleted: the elimination (resign / abandon / time) is stored in games.ext.out = {"<seat>": "<reason>"}, so history and results keep every player.

do $$
declare c record;
begin
  for c in select conname from pg_constraint where conrelid = 'public.games'::regclass and contype = 'c' and pg_get_constraintdef(oid) ilike '%current_seat%' loop
    execute format('alter table public.games drop constraint %I', c.conname);
  end loop;
end $$;
alter table public.games drop constraint if exists games_current_seat_range;
alter table public.games add constraint games_current_seat_range check (current_seat is null or current_seat between 0 and 3);

-- commit_action: identical to 008 plus the seat re-numbering of the players update
create or replace function public.commit_action(
  p_game_id uuid, p_expected_revision bigint, p_client_action_id uuid, p_player_id uuid, p_patch jsonb, p_result jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  g    public.games;
  g2   public.games;
  prev jsonb;
  rec  jsonb;
  rl   text;
begin
  select * into g from public.games where id = p_game_id for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;

  if p_client_action_id is not null then
    select result into prev from public.game_actions where game_id = p_game_id and client_action_id = p_client_action_id;
    if found then return jsonb_build_object('duplicate', true, 'result', prev); end if;
  end if;

  if g.revision <> p_expected_revision then raise exception 'STALE_REVISION' using errcode = 'P0001'; end if;

  -- roster: players (with a seat and a rack) and judge / spectators (no seat, no rack). Capacity is enforced by eas_enforce_roster.
  if p_patch->'add_player' is not null and jsonb_typeof(p_patch->'add_player') = 'object' then
    rec := p_patch->'add_player';
    rl := coalesce(rec->>'role', 'player');
    begin
      insert into public.game_players (game_id, player_id, role, seat, nickname, score, tile_count, ms_left, ready, connection_state)
      values (p_game_id, (rec->>'player_id')::uuid, rl, case when rl = 'player' then (rec->>'seat')::smallint else null end, rec->>'nickname', 0, 0,
              coalesce((rec->>'ms_left')::bigint, 0), coalesce((rec->>'ready')::boolean, false), 'online');
    exception when unique_violation then
      raise exception 'SEAT_TAKEN' using errcode = 'P0001';
    end;
    if rl = 'player' then
      insert into public.player_racks (game_id, player_id, tiles) values (p_game_id, (rec->>'player_id')::uuid, '[]'::jsonb);
    end if;
  end if;
  if p_patch->>'remove_player' is not null then
    delete from public.player_racks where game_id = p_game_id and player_id = (p_patch->>'remove_player')::uuid;
    delete from public.game_players where game_id = p_game_id and player_id = (p_patch->>'remove_player')::uuid;
  end if;

  -- a judge / spectator joining or leaving changes who is in the room, not the game: the revision stays, so nobody's pending move goes stale
  if coalesce((p_patch->>'roster_only')::boolean, false) then
    update public.games set updated_at = now() where id = p_game_id;
    if p_client_action_id is not null then
      insert into public.game_actions (game_id, client_action_id, player_id, result) values (p_game_id, p_client_action_id, p_player_id, p_result);
    end if;
    return jsonb_build_object('revision', g.revision);
  end if;

  -- game row: merge the patch over the current row; only listed columns can ever change
  g2 := jsonb_populate_record(null::public.games, to_jsonb(g) || coalesce(p_patch->'game', '{}'::jsonb));
  update public.games set
    status = g2.status, tile_mode = g2.tile_mode, validator_mode = g2.validator_mode, minutes = g2.minutes, round = g2.round,
    current_seat = g2.current_seat, current_player_id = g2.current_player_id, board = g2.board, clock_started = g2.clock_started,
    turn_started_at = g2.turn_started_at, turn_deadline_at = g2.turn_deadline_at, tahkim = g2.tahkim, tahkim_available = g2.tahkim_available, ext = coalesce(g2.ext, '{}'::jsonb),
    bag_count = g2.bag_count, rematch_seats = g2.rematch_seats, winner_player_id = g2.winner_player_id, winner_seat = g2.winner_seat,
    result = g2.result, started_at = g2.started_at, finished_at = g2.finished_at,
    max_players = g2.max_players, judge_enabled = g2.judge_enabled, max_spectators = g2.max_spectators,
    last_event = p_patch->>'event', revision = g.revision + 1, updated_at = now()
  where id = p_game_id;

  for rec in select * from jsonb_array_elements(coalesce(p_patch->'players', '[]'::jsonb)) loop
    update public.game_players set
      score      = coalesce((rec->>'score')::integer, score),
      tile_count = coalesce((rec->>'tile_count')::smallint, tile_count),
      ms_left    = coalesce((rec->>'ms_left')::bigint, ms_left),
      ready      = coalesce((rec->>'ready')::boolean, ready),
      seat       = coalesce((rec->>'seat')::smallint, seat)   -- seats are re-numbered (gap-free) when a player leaves; the engine sends players in ascending NEW seat order so the unique (game_id, seat) is never hit
    where game_id = p_game_id and player_id = (rec->>'player_id')::uuid and role = 'player';
  end loop;

  for rec in select * from jsonb_array_elements(coalesce(p_patch->'racks', '[]'::jsonb)) loop
    insert into public.player_racks (game_id, player_id, tiles) values (p_game_id, (rec->>'player_id')::uuid, rec->'tiles')
    on conflict (game_id, player_id) do update set tiles = excluded.tiles;
  end loop;

  if p_patch->'private' is not null and jsonb_typeof(p_patch->'private') = 'object' then
    update public.game_private set
      bag  = case when p_patch->'private' ? 'bag'  then p_patch->'private'->'bag'  else bag  end,
      undo = case when p_patch->'private' ? 'undo' then nullif(p_patch->'private'->'undo', 'null'::jsonb) else undo end
    where game_id = p_game_id;
  end if;

  select * into g2 from public.games where id = p_game_id;

  if p_patch->'move' is not null and jsonb_typeof(p_patch->'move') = 'object' then
    rec := p_patch->'move';
    insert into public.game_moves (game_id, round, player_id, seat, turn_number, action_type, placements, formed_words, score_delta, validation_result, bingo, swap_count, revision)
    values (p_game_id, g2.round, (rec->>'player_id')::uuid, (rec->>'seat')::smallint, (rec->>'turn_number')::integer, rec->>'action_type',
            coalesce(rec->'placements', '[]'::jsonb), coalesce(rec->'formed_words', '[]'::jsonb), coalesce((rec->>'score_delta')::integer, 0),
            coalesce(rec->>'validation_result', 'skipped'), coalesce((rec->>'bingo')::boolean, false), coalesce((rec->>'swap_count')::smallint, 0), g2.revision);
  end if;
  if p_patch->'move_update' is not null and jsonb_typeof(p_patch->'move_update') = 'object' then
    rec := p_patch->'move_update';
    update public.game_moves set tahkim_status = rec->>'tahkim_status', penalty = coalesce((rec->>'penalty')::integer, 0)
    where game_id = p_game_id and round = g2.round and turn_number = (rec->>'turn_number')::integer;
  end if;

  if p_client_action_id is not null then
    insert into public.game_actions (game_id, client_action_id, player_id, result) values (p_game_id, p_client_action_id, p_player_id, p_result);
  end if;

  return jsonb_build_object('revision', g2.revision);
end $$;
revoke all on function public.commit_action(uuid, bigint, uuid, uuid, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.commit_action(uuid, bigint, uuid, uuid, jsonb, jsonb) to service_role;


grant execute on function public.commit_action(uuid, bigint, uuid, uuid, jsonb, jsonb) to service_role;
