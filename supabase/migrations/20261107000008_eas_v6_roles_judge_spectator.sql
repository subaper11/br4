-- V6.0: roles (player / judge / spectator), Judge workflow storage, role-aware realtime.
-- Migrations 001-007 are NOT edited: everything here is additive and safe to run on a database that already holds v5.x rooms
-- (every existing row becomes role 'player' with its seat untouched).
--
-- Seat model: a SEAT belongs to a PLAYER only. A Judge or a Spectator has role <> 'player' and seat NULL; they are never "seat 2".
-- game_players.seat is prepared for 0..3 (Phase 2 / V6.1); games.current_seat stays 0..1 and the engine refuses max_players > 2 until then.

-- ------------------------------------------------------------------------------------------------
-- 1. game_players: role + nullable seat + constraints
-- ------------------------------------------------------------------------------------------------
alter table public.game_players add column if not exists role text not null default 'player';
-- (every existing row takes the column default 'player')

do $$
declare c record;
begin
  -- drop the original "seat in (0,1)" check whatever its generated name is
  for c in select conname from pg_constraint
            where conrelid = 'public.game_players'::regclass and contype = 'c' and pg_get_constraintdef(oid) ilike '%seat%'
              and conname not in ('game_players_seat_range', 'game_players_role_seat') loop
    execute format('alter table public.game_players drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.game_players alter column seat drop not null;
alter table public.game_players drop constraint if exists game_players_role_check;
alter table public.game_players add constraint game_players_role_check check (role in ('player', 'judge', 'spectator'));
alter table public.game_players drop constraint if exists game_players_seat_range;
alter table public.game_players add constraint game_players_seat_range check (seat is null or seat between 0 and 3);
alter table public.game_players drop constraint if exists game_players_role_seat;
-- role/seat pairing cannot be manipulated: a player always has a seat, anyone else never has one
alter table public.game_players add constraint game_players_role_seat check ((role = 'player' and seat is not null) or (role <> 'player' and seat is null));
-- at most ONE judge per game (unique (game_id, seat) already keeps player seats unique; NULL seats never collide)
create unique index if not exists game_players_one_judge on public.game_players (game_id) where role = 'judge';
create index if not exists game_players_role_idx on public.game_players (game_id, role);

-- ------------------------------------------------------------------------------------------------
-- 2. games: room configuration
-- ------------------------------------------------------------------------------------------------
alter table public.games add column if not exists max_players integer not null default 2;
alter table public.games add column if not exists judge_enabled boolean not null default false;
alter table public.games add column if not exists max_spectators integer not null default 10;
alter table public.games drop constraint if exists games_max_players_range;
alter table public.games add constraint games_max_players_range check (max_players between 2 and 4);
alter table public.games drop constraint if exists games_max_spectators_range;
alter table public.games add constraint games_max_spectators_range check (max_spectators between 0 and 30);

-- ------------------------------------------------------------------------------------------------
-- 3. roster capacity, enforced by the database (the Edge Function checks first; this closes every race)
--    Runs inside the same transaction as the insert and takes a per-game lock, so two simultaneous joins for the last slot cannot both pass.
-- ------------------------------------------------------------------------------------------------
create or replace function public.eas_enforce_roster() returns trigger language plpgsql security definer set search_path = public as $$
declare g public.games; n integer;
begin
  perform pg_advisory_xact_lock(hashtextextended('roster:' || new.game_id::text, 0));
  select * into g from public.games where id = new.game_id;
  if not found then return new; end if;
  if new.role = 'player' then
    if g.status <> 'lobby' then raise exception 'GAME_STARTED' using errcode = 'P0001'; end if;
    select count(*) into n from public.game_players where game_id = new.game_id and role = 'player';
    if n >= g.max_players then raise exception 'ROOM_FULL' using errcode = 'P0001'; end if;
  elsif new.role = 'judge' then
    if not g.judge_enabled then raise exception 'JUDGE_DISABLED' using errcode = 'P0001'; end if;
    if exists (select 1 from public.game_players where game_id = new.game_id and role = 'judge') then raise exception 'JUDGE_TAKEN' using errcode = 'P0001'; end if;
  elsif new.role = 'spectator' then
    select count(*) into n from public.game_players where game_id = new.game_id and role = 'spectator';
    if n >= g.max_spectators then raise exception 'SPECTATORS_FULL' using errcode = 'P0001'; end if;
  end if;
  return new;
end $$;
revoke all on function public.eas_enforce_roster() from public, anon, authenticated;
drop trigger if exists eas_enforce_roster_trg on public.game_players;
create trigger eas_enforce_roster_trg before insert on public.game_players for each row execute function public.eas_enforce_roster();

-- A rack row exists for players only: a judge or a spectator can never own one (second line of defence behind the Edge Function and the owner-only policy).
create or replace function public.eas_rack_only_players() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from public.game_players gp where gp.game_id = new.game_id and gp.player_id = new.player_id and gp.role <> 'player') then
    raise exception 'RACK_FOR_NON_PLAYER' using errcode = 'P0001';
  end if;
  return new;
end $$;
revoke all on function public.eas_rack_only_players() from public, anon, authenticated;
drop trigger if exists eas_rack_only_players_trg on public.player_racks;
create trigger eas_rack_only_players_trg before insert or update on public.player_racks for each row execute function public.eas_rack_only_players();

-- ------------------------------------------------------------------------------------------------
-- 4. membership helpers + role-aware realtime
--    Reading a room (rows, the game channel) is open to EVERY member. Publishing presence (where the live-preview draft travels) is open to players and the judge only:
--    a spectator can listen but cannot say anything on the channel. Browsers still cannot publish broadcasts; only the server does.
-- ------------------------------------------------------------------------------------------------
create or replace function public.eas_member_role(p_game_id uuid) returns text language sql stable security definer set search_path = public as $$
  select gp.role from public.game_players gp where gp.game_id = p_game_id and gp.player_id = (select auth.uid());
$$;
revoke all on function public.eas_member_role(uuid) from public, anon;
grant execute on function public.eas_member_role(uuid) to authenticated;

create or replace function public.eas_can_track(p_game_id uuid) returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.game_players gp where gp.game_id = p_game_id and gp.player_id = (select auth.uid()) and gp.role in ('player', 'judge'));
$$;
revoke all on function public.eas_can_track(uuid) from public, anon;
grant execute on function public.eas_can_track(uuid) to authenticated;

drop policy if exists "members track presence" on realtime.messages;
create policy "players and judge track presence" on realtime.messages for insert to authenticated
  with check (
    realtime.messages.extension = 'presence'
    and (select realtime.topic()) like 'game:%'
    and public.eas_can_track(((regexp_match((select realtime.topic()), '^game:([0-9a-f-]{36})$'))[1])::uuid)
  );
-- "members receive game channel" (select) from migration 02 is unchanged: every role may listen.

-- Judge / spectator joins and leaves do not bump games.revision (a spectator arriving must not make a player's pending move stale),
-- so the roster change is announced on its own. Clients answer by fetching a fresh snapshot.
create or replace function public.eas_roster_announce() returns trigger language plpgsql security definer set search_path = public as $$
declare gid uuid; r text; rev bigint;
begin
  gid := coalesce(new.game_id, old.game_id); r := coalesce(new.role, old.role);
  if r = 'player' then return null; end if;
  begin
    select revision into rev from public.games where id = gid;
    if rev is not null then
      perform realtime.send(jsonb_build_object('revision', rev, 'event', 'ROSTER', 'status', null), 'ROSTER', 'game:' || gid::text, true);
    end if;
  exception when others then null;   -- an announcement must never break the join / leave itself
  end;
  return null;
end $$;
revoke all on function public.eas_roster_announce() from public, anon, authenticated;
drop trigger if exists eas_roster_announce_trg on public.game_players;
create trigger eas_roster_announce_trg after insert or delete on public.game_players for each row execute function public.eas_roster_announce();

-- ------------------------------------------------------------------------------------------------
-- 5. create_game_tx / commit_action, role-aware
-- ------------------------------------------------------------------------------------------------
create or replace function public.create_game_tx(p_game jsonb, p_player jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  begin
    insert into public.games (id, room_code, host_player_id, status, tile_mode, validator_mode, minutes, round, revision, board, tahkim, bag_count, ext, max_players, judge_enabled, max_spectators)
    values ((p_game->>'id')::uuid, p_game->>'room_code', (p_game->>'host_player_id')::uuid, 'lobby',
            coalesce(p_game->>'tile_mode', 'expanded'), 'off', coalesce((p_game->>'minutes')::integer, 25),
            1, 1, coalesce(p_game->'board', '[]'::jsonb), '{"state":"none"}'::jsonb, 0, coalesce(p_game->'ext', '{}'::jsonb),
            coalesce((p_game->>'max_players')::integer, 2), coalesce((p_game->>'judge_enabled')::boolean, false), coalesce((p_game->>'max_spectators')::integer, 10));
  exception when unique_violation then
    raise exception 'ROOM_CODE_TAKEN' using errcode = 'P0001';
  end;
  insert into public.game_players (game_id, player_id, role, seat, nickname, score, tile_count, ms_left, ready, connection_state)
  values ((p_game->>'id')::uuid, (p_player->>'player_id')::uuid, 'player', 0, p_player->>'nickname', 0, 0, (p_player->>'ms_left')::bigint, true, 'online');
  insert into public.player_racks (game_id, player_id, tiles) values ((p_game->>'id')::uuid, (p_player->>'player_id')::uuid, '[]'::jsonb);
  insert into public.game_private (game_id, bag, undo) values ((p_game->>'id')::uuid, '[]'::jsonb, null);
end $$;
revoke all on function public.create_game_tx(jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.create_game_tx(jsonb, jsonb) to service_role;

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
      ready      = coalesce((rec->>'ready')::boolean, ready)
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

-- Judge state (ping, ping quota, Judge pause) lives in games.ext (jsonb, already part of the commit above), which carries no private data;
-- the Judge ruling lives in games.tahkim (resolver, resolver_player_id). Nothing else to add.
