-- V6.2: free choice of a slot in the lobby. Additive on top of 001-009.
-- A member may change role (player / judge / spectator) and seat while the room is a lobby. Capacity is enforced by the database on every role change (the Edge Function checks first).
create or replace function public.eas_enforce_roster_update() returns trigger language plpgsql security definer set search_path = public as $$
declare g public.games; n integer;
begin
  if new.role is not distinct from old.role and new.seat is not distinct from old.seat then return new; end if;
  perform pg_advisory_xact_lock(hashtextextended('roster:' || new.game_id::text, 0));
  select * into g from public.games where id = new.game_id;
  if not found then return new; end if;
  if new.role is distinct from old.role and g.status <> 'lobby' then raise exception 'GAME_STARTED' using errcode = 'P0001'; end if;
  if new.role = 'player' then
    if new.seat >= g.max_players then raise exception 'BAD_SEAT' using errcode = 'P0001'; end if;
    if new.role is distinct from old.role then
      select count(*) into n from public.game_players where game_id = new.game_id and role = 'player' and player_id <> new.player_id;
      if n >= g.max_players then raise exception 'ROOM_FULL' using errcode = 'P0001'; end if;
    end if;
  elsif new.role = 'judge' and new.role is distinct from old.role then
    if not g.judge_enabled then raise exception 'JUDGE_DISABLED' using errcode = 'P0001'; end if;
    if exists (select 1 from public.game_players where game_id = new.game_id and role = 'judge' and player_id <> new.player_id) then raise exception 'JUDGE_TAKEN' using errcode = 'P0001'; end if;
  elsif new.role = 'spectator' and new.role is distinct from old.role then
    select count(*) into n from public.game_players where game_id = new.game_id and role = 'spectator' and player_id <> new.player_id;
    if n >= g.max_spectators then raise exception 'SPECTATORS_FULL' using errcode = 'P0001'; end if;
  end if;
  return new;
end $$;
revoke all on function public.eas_enforce_roster_update() from public, anon, authenticated;
drop trigger if exists eas_enforce_roster_upd_trg on public.game_players;
create trigger eas_enforce_roster_upd_trg before update of role, seat on public.game_players for each row execute function public.eas_enforce_roster_update();

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

  -- free choice of a slot in the lobby: a member changes role (player / judge / spectator) and seat in one UPDATE (the role/seat constraint is checked per statement)
  for rec in select * from jsonb_array_elements(coalesce(p_patch->'set_roles', '[]'::jsonb)) loop
    if rec->>'role' <> 'player' then
      delete from public.player_racks where game_id = p_game_id and player_id = (rec->>'player_id')::uuid;
    end if;
    update public.game_players set role = rec->>'role', seat = (rec->>'seat')::smallint, ready = coalesce((rec->>'ready')::boolean, false)
      where game_id = p_game_id and player_id = (rec->>'player_id')::uuid;
    if rec->>'role' = 'player' then
      insert into public.player_racks (game_id, player_id, tiles) values (p_game_id, (rec->>'player_id')::uuid, '[]'::jsonb) on conflict (game_id, player_id) do nothing;
    end if;
  end loop;

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
