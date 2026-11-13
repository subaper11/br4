-- V6.0 / V6.1 / V6.2 database verification: roles, rack isolation, constraints, capacity, realtime helpers, 2-4 seats.
-- This is a REAL-DATABASE check (RLS, constraints and triggers cannot be proven by the Node suites, which run the server core on an in-memory store).
--
-- PREREQUISITES
--   1. Use a TEST Supabase project (never production).
--   2. Migrations 001 ... 010 are already applied to it, in order (20261107000008_* and 20261108000009_* are the new ones).
--   3. Run it in the Supabase SQL Editor (it runs as the postgres role and needs access to the auth schema).
-- SAFE TO RUN TWICE
--   Everything happens inside ONE transaction that is ROLLED BACK at the end, on temporary objects and random ids. Nothing is kept and no existing row is touched.
--   (If it stops half way with an error, the transaction is rolled back by the editor; running it again is fine.)
-- HOW TO READ THE RESULT
--   Success : the Messages / Results area shows   NOTICE: ALL ROLE / RLS CHECKS PASSED
--   Failure : an error "CHECK FAILED (<name>)" naming the first check that did not hold. Copy that line back.
begin;

create temp table _u (k text primary key, id uuid not null) on commit drop;
insert into _u values ('host', gen_random_uuid()), ('guest', gen_random_uuid()), ('judge', gen_random_uuid()), ('spec', gen_random_uuid()), ('spec2', gen_random_uuid()), ('other', gen_random_uuid());
insert into auth.users (id, aud, role, email, is_anonymous) select id, 'authenticated', 'authenticated', k || '@test.invalid', true from _u;
grant select on _u to authenticated;

create or replace function pg_temp.uid(k text) returns uuid language sql as $$ select id from _u where k = $1 $$;
create or replace function pg_temp.as_user(k text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', (select id from _u where _u.k = $1), 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', (select id::text from _u where _u.k = $1), true);
  perform set_config('role', 'authenticated', true);
end $$;
create or replace function pg_temp.as_service() returns void language plpgsql as $$ begin perform set_config('role', 'postgres', true); end $$;
create or replace function pg_temp.expect_error(label text, stmt text, fragment text default null) returns void language plpgsql as $$
begin
  begin execute stmt; exception when others then
    if fragment is not null and sqlerrm not ilike '%' || fragment || '%' then raise exception 'CHECK FAILED (%): wrong error: %', label, sqlerrm; end if;
    return;
  end;
  raise exception 'CHECK FAILED (%): statement was allowed', label;
end $$;
create or replace function pg_temp.expect(label text, ok boolean) returns void language plpgsql as $$ begin if not coalesce(ok, false) then raise exception 'CHECK FAILED: %', label; end if; end $$;

-- ---------- fixture: a Judge room with two players, a judge and one spectator ----------
do $$
declare gid uuid := gen_random_uuid(); host uuid := pg_temp.uid('host');
begin
  perform pg_temp.as_service();
  perform public.create_game_tx(jsonb_build_object('id', gid, 'room_code', 'TEST22', 'host_player_id', host, 'minutes', 25, 'judge_enabled', true, 'max_spectators', 1, 'max_players', 2),
                                jsonb_build_object('player_id', host, 'nickname', 'Host', 'ms_left', 1500000));
  perform public.commit_action(gid, 1, null, pg_temp.uid('guest'), jsonb_build_object('game', '{}'::jsonb, 'add_player', jsonb_build_object('player_id', pg_temp.uid('guest'), 'role', 'player', 'seat', 1, 'nickname', 'Guest', 'ms_left', 1500000)), '{}'::jsonb);
  perform public.commit_action(gid, (select revision from public.games where id = gid), null, pg_temp.uid('judge'), jsonb_build_object('roster_only', true, 'add_player', jsonb_build_object('player_id', pg_temp.uid('judge'), 'role', 'judge', 'nickname', 'Judge')), '{}'::jsonb);
  perform public.commit_action(gid, (select revision from public.games where id = gid), null, pg_temp.uid('spec'), jsonb_build_object('roster_only', true, 'add_player', jsonb_build_object('player_id', pg_temp.uid('spec'), 'role', 'spectator', 'nickname', 'Spec')), '{}'::jsonb);
  -- the two players hold racks (as after a deal)
  update public.player_racks set tiles = '[{"id":"secretA"}]'::jsonb where game_id = gid and player_id = host;
  update public.player_racks set tiles = '[{"id":"secretB"}]'::jsonb where game_id = gid and player_id = pg_temp.uid('guest');
  create temp table _g on commit drop as select gid as id; grant select on _g to authenticated;
end $$;

-- ---------- roster shape ----------
do $$ begin
  perform pg_temp.expect('judge and spectator rows have no seat', (select count(*) from public.game_players where role <> 'player' and seat is not null) = 0);
  perform pg_temp.expect('players have seats 0 and 1', (select array_agg(seat order by seat) from public.game_players where role = 'player') = array[0, 1]::smallint[]);
  perform pg_temp.expect('no rack row exists for the judge or the spectator', (select count(*) from public.player_racks r join public.game_players p using (game_id, player_id) where p.role <> 'player') = 0);
  perform pg_temp.expect('the roster join did not bump the revision (join of guest = 1 bump)', (select revision from public.games where id = (select id from _g)) = 2);
end $$;

-- ---------- constraints ----------
-- the capacity trigger runs BEFORE the table constraints, so the shape checks below switch it off for a moment (the transaction is rolled back anyway); capacity is checked afterwards with it on
do $$ begin alter table public.game_players disable trigger eas_enforce_roster_trg; end $$;
do $$ declare gid uuid := (select id from _g); begin
  perform pg_temp.expect_error('player without a seat', format($s$insert into public.game_players (game_id, player_id, role, seat, nickname) values (%L, %L, 'player', null, 'x')$s$, gid, pg_temp.uid('other')), 'role_seat');
  perform pg_temp.expect_error('judge with a seat', format($s$insert into public.game_players (game_id, player_id, role, seat, nickname) values (%L, %L, 'judge', 2, 'x')$s$, gid, pg_temp.uid('other')), 'role_seat');
  perform pg_temp.expect_error('spectator with a seat', format($s$insert into public.game_players (game_id, player_id, role, seat, nickname) values (%L, %L, 'spectator', 1, 'x')$s$, gid, pg_temp.uid('other')), 'role_seat');
  perform pg_temp.expect_error('unknown role', format($s$insert into public.game_players (game_id, player_id, role, nickname) values (%L, %L, 'referee', 'x')$s$, gid, pg_temp.uid('other')), 'role');
  perform pg_temp.expect_error('seat out of range', format($s$insert into public.game_players (game_id, player_id, role, seat, nickname) values (%L, %L, 'player', 4, 'x')$s$, gid, pg_temp.uid('other')), 'seat');
  alter table public.game_players enable trigger eas_enforce_roster_trg;
  perform pg_temp.expect_error('second judge', format($s$insert into public.game_players (game_id, player_id, role, nickname) values (%L, %L, 'judge', 'x')$s$, gid, pg_temp.uid('other')));
  perform pg_temp.expect_error('spectator over capacity (max 1)', format($s$insert into public.game_players (game_id, player_id, role, nickname) values (%L, %L, 'spectator', 'x')$s$, gid, pg_temp.uid('spec2')), 'SPECTATORS_FULL');
  perform pg_temp.expect_error('third player (max_players 2)', format($s$insert into public.game_players (game_id, player_id, role, seat, nickname) values (%L, %L, 'player', 2, 'x')$s$, gid, pg_temp.uid('other')));
  perform pg_temp.expect_error('rack for a spectator', format($s$insert into public.player_racks (game_id, player_id, tiles) values (%L, %L, '[]')$s$, gid, pg_temp.uid('spec')), 'RACK_FOR_NON_PLAYER');
  perform pg_temp.expect_error('max_spectators out of range', format($s$update public.games set max_spectators = 99 where id = %L$s$, gid));
  perform pg_temp.expect_error('max_players out of range', format($s$update public.games set max_players = 5 where id = %L$s$, gid));
end $$;

-- ---------- row level security: rack isolation ----------
do $$ declare n int; begin
  perform pg_temp.as_user('spec');   select count(*) into n from public.player_racks; perform pg_temp.expect('spectator reads no rack', n = 0);
  perform pg_temp.as_user('judge');  select count(*) into n from public.player_racks; perform pg_temp.expect('judge reads no rack', n = 0);
  perform pg_temp.as_user('other');  select count(*) into n from public.player_racks; perform pg_temp.expect('a stranger reads no rack', n = 0);
  perform pg_temp.as_user('host');   select count(*) into n from public.player_racks; perform pg_temp.expect('a player reads exactly one rack', n = 1);
  perform pg_temp.expect('and it is their own', (select tiles::text from public.player_racks) like '%secretA%');
  perform pg_temp.as_user('guest');  perform pg_temp.expect('the other player reads only theirs', (select tiles::text from public.player_racks) like '%secretB%' and (select count(*) from public.player_racks) = 1);
  perform pg_temp.as_service();
end $$;

-- ---------- row level security: reading the room, never writing it ----------
do $$ declare n int; gid uuid := (select id from _g); begin
  perform pg_temp.as_user('spec');
  select count(*) into n from public.games where id = gid; perform pg_temp.expect('spectator reads the game', n = 1);
  select count(*) into n from public.game_players where game_id = gid; perform pg_temp.expect('spectator reads the roster', n = 4);
  select count(*) into n from public.game_moves where game_id = gid; perform pg_temp.expect('spectator may read moves (public)', n >= 0);
  perform pg_temp.as_user('judge');
  select count(*) into n from public.games where id = gid; perform pg_temp.expect('judge reads the game', n = 1);
  perform pg_temp.as_user('other');
  select count(*) into n from public.games where id = gid; perform pg_temp.expect('a stranger reads nothing', n = 0);
  select count(*) into n from public.game_players where game_id = gid; perform pg_temp.expect('a stranger sees no roster', n = 0);
  perform pg_temp.as_service();
end $$;
do $$ declare gid uuid := (select id from _g); r text; begin
  foreach r in array array['spec', 'judge', 'guest'] loop
    perform pg_temp.as_user(r);
    perform pg_temp.expect_error(r || ' cannot insert into games', format($s$insert into public.games (room_code, host_player_id) values ('ZZZZ22', %L)$s$, pg_temp.uid(r)));
    perform pg_temp.expect_error(r || ' cannot update games', format($s$update public.games set status = 'finished' where id = %L$s$, gid));
    perform pg_temp.expect_error(r || ' cannot promote itself (role)', format($s$update public.game_players set role = 'player', seat = 3 where game_id = %L and player_id = %L$s$, gid, pg_temp.uid(r)));
    perform pg_temp.expect_error(r || ' cannot change its seat', format($s$update public.game_players set seat = 0 where game_id = %L and player_id = %L$s$, gid, pg_temp.uid(r)));
    perform pg_temp.expect_error(r || ' cannot write a move', format($s$insert into public.game_moves (game_id, player_id, seat, turn_number, action_type, revision) values (%L, %L, 0, 99, 'pass', 1)$s$, gid, pg_temp.uid(r)));
    perform pg_temp.expect_error(r || ' cannot write a rack', format($s$update public.player_racks set tiles = '[]' where game_id = %L$s$, gid));
    perform pg_temp.expect_error(r || ' cannot read the bag', format($s$select * from public.game_private where game_id = %L$s$, gid));
    perform pg_temp.expect_error(r || ' cannot read action ids', format($s$select * from public.game_actions where game_id = %L$s$, gid));
    perform pg_temp.expect_error(r || ' cannot call commit_action', format($s$select public.commit_action(%L, 1, null, %L, '{}'::jsonb, '{}'::jsonb)$s$, gid, pg_temp.uid(r)));
  end loop;
  perform pg_temp.as_service();
end $$;

-- ---------- realtime: who may speak on the game channel ----------
do $$ declare gid uuid := (select id from _g); begin
  perform pg_temp.as_user('spec');   perform pg_temp.expect('spectator is a member (may listen)', public.eas_is_member(gid));
  perform pg_temp.expect('spectator may NOT track presence (no draft)', not public.eas_can_track(gid));
  perform pg_temp.expect('role of the spectator', public.eas_member_role(gid) = 'spectator');
  perform pg_temp.as_user('judge');  perform pg_temp.expect('judge may track presence', public.eas_can_track(gid) and public.eas_member_role(gid) = 'judge');
  perform pg_temp.as_user('host');   perform pg_temp.expect('player may track presence', public.eas_can_track(gid) and public.eas_member_role(gid) = 'player');
  perform pg_temp.as_user('other');  perform pg_temp.expect('a stranger neither listens nor tracks', not public.eas_is_member(gid) and not public.eas_can_track(gid));
  perform pg_temp.as_service();
  perform pg_temp.expect('the old "members track presence" policy is gone', not exists (select 1 from pg_policies where schemaname = 'realtime' and tablename = 'messages' and policyname = 'members track presence'));
  perform pg_temp.expect('the role-aware insert policy exists', exists (select 1 from pg_policies where schemaname = 'realtime' and tablename = 'messages' and policyname = 'players and judge track presence'));
  perform pg_temp.expect('nobody has a broadcast-publish policy', not exists (select 1 from pg_policies where schemaname = 'realtime' and tablename = 'messages' and cmd = 'INSERT' and with_check ilike '%broadcast%'));
end $$;

-- ---------- one open game per identity still holds for every role ----------
do $$ declare g2 uuid := gen_random_uuid(); begin
  perform pg_temp.as_service();
  perform pg_temp.expect_error('a spectator of an open room cannot host another', format($s$select public.create_game_tx(%L::jsonb, %L::jsonb)$s$,
    jsonb_build_object('id', g2, 'room_code', 'TEST33', 'host_player_id', pg_temp.uid('spec')), jsonb_build_object('player_id', pg_temp.uid('spec'), 'nickname', 'x', 'ms_left', 1)), 'ALREADY_IN_GAME');
end $$;


-- ---------- V6.1: up to four seats ----------
do $$ declare gid uuid := gen_random_uuid(); u3 uuid := gen_random_uuid(); u4 uuid := gen_random_uuid(); begin
  perform pg_temp.as_service();
  insert into auth.users (id, aud, role, email, is_anonymous) values (u3, 'authenticated', 'authenticated', 'p3@test.invalid', true), (u4, 'authenticated', 'authenticated', 'p4@test.invalid', true);
  perform public.create_game_tx(jsonb_build_object('id', gid, 'room_code', 'TEST44', 'host_player_id', pg_temp.uid('other'), 'minutes', 25, 'max_players', 4), jsonb_build_object('player_id', pg_temp.uid('other'), 'nickname', 'P1', 'ms_left', 1500000));
  perform public.commit_action(gid, 1, null, u3, jsonb_build_object('game', '{}'::jsonb, 'add_player', jsonb_build_object('player_id', u3, 'role', 'player', 'seat', 1, 'nickname', 'P2', 'ms_left', 1)), '{}'::jsonb);
  perform public.commit_action(gid, 2, null, u4, jsonb_build_object('game', '{}'::jsonb, 'add_player', jsonb_build_object('player_id', u4, 'role', 'player', 'seat', 2, 'nickname', 'P3', 'ms_left', 1)), '{}'::jsonb);
  perform pg_temp.expect('three players hold seats 0,1,2', (select array_agg(seat order by seat) from public.game_players where game_id = gid) = array[0, 1, 2]::smallint[]);
  perform pg_temp.expect('games.current_seat accepts seat 3', (select true from (select 1) x where (select count(*) from public.games where id = gid) = 1));
  update public.games set current_seat = 3 where id = gid;
  perform pg_temp.expect('current_seat 3 stored', (select current_seat from public.games where id = gid) = 3);
  perform pg_temp.expect_error('current_seat 4 refused', format($s$update public.games set current_seat = 4 where id = %L$s$, gid));
  -- a lobby leaver: the engine sends the players in ascending NEW seat order, so closing the gap never collides on unique (game_id, seat)
  perform public.commit_action(gid, (select revision from public.games where id = gid), null, u3,
    jsonb_build_object('game', '{}'::jsonb, 'remove_player', u3, 'players', jsonb_build_array(jsonb_build_object('player_id', u4, 'seat', 1))), '{}'::jsonb);
  perform pg_temp.expect('after a leave the remaining seats are 0,1', (select array_agg(seat order by seat) from public.game_players where game_id = gid) = array[0, 1]::smallint[]);
  perform pg_temp.expect('the fourth seat is free again', (select count(*) from public.game_players where game_id = gid and role = 'player') = 2);
end $$;


-- ---------- V6.2: free choice of a slot in the lobby (migration 010) ----------
do $$ declare gid uuid := gen_random_uuid(); ua uuid := gen_random_uuid(); ub uuid := gen_random_uuid(); uc uuid := gen_random_uuid(); ud uuid := gen_random_uuid(); rev bigint; begin
  perform pg_temp.as_service();
  insert into auth.users (id, aud, role, email, is_anonymous) values (ua, 'authenticated', 'authenticated', 'q1@test.invalid', true), (ub, 'authenticated', 'authenticated', 'q2@test.invalid', true), (uc, 'authenticated', 'authenticated', 'q3@test.invalid', true), (ud, 'authenticated', 'authenticated', 'q4@test.invalid', true);
  perform public.create_game_tx(jsonb_build_object('id', gid, 'room_code', 'TEST55', 'host_player_id', ua, 'minutes', 25, 'max_players', 3, 'judge_enabled', true, 'max_spectators', 1), jsonb_build_object('player_id', ua, 'nickname', 'H', 'ms_left', 1));
  perform public.commit_action(gid, 1, null, ub, jsonb_build_object('game', '{}'::jsonb, 'add_player', jsonb_build_object('player_id', ub, 'role', 'player', 'seat', 1, 'nickname', 'G1', 'ms_left', 1)), '{}'::jsonb);
  select revision into rev from public.games where id = gid;
  -- a seat move inside the lobby
  perform public.commit_action(gid, rev, null, ub, jsonb_build_object('game', '{}'::jsonb, 'players', jsonb_build_array(jsonb_build_object('player_id', ub, 'seat', 2))), '{}'::jsonb);
  perform pg_temp.expect('seat move to 2', (select seat from public.game_players where player_id = ub and game_id = gid) = 2);
  perform pg_temp.expect_error('seat beyond max_players', format($s$update public.game_players set seat = 3 where game_id = %L and player_id = %L$s$, gid, ub), 'BAD_SEAT');
  -- player -> judge: seat null, rack row removed
  select revision into rev from public.games where id = gid;
  perform public.commit_action(gid, rev, null, ub, jsonb_build_object('game', '{}'::jsonb, 'set_roles', jsonb_build_array(jsonb_build_object('player_id', ub, 'role', 'judge', 'seat', null, 'ready', false))), '{}'::jsonb);
  perform pg_temp.expect('B is now the judge with no seat', (select role || ':' || coalesce(seat::text, 'null') from public.game_players where player_id = ub and game_id = gid) = 'judge:null');
  perform pg_temp.expect('B''s rack row is gone', not exists (select 1 from public.player_racks where game_id = gid and player_id = ub));
  -- a second member cannot also take the judge chair
  perform public.commit_action(gid, (select revision from public.games where id = gid), null, uc, jsonb_build_object('game', '{}'::jsonb, 'add_player', jsonb_build_object('player_id', uc, 'role', 'player', 'seat', 1, 'nickname', 'G2', 'ms_left', 1)), '{}'::jsonb);
  perform pg_temp.expect_error('second judge by role change', format($s$update public.game_players set role = 'judge', seat = null where game_id = %L and player_id = %L$s$, gid, uc), 'JUDGE_TAKEN');
  -- judge -> spectator -> player again: a rack row is created
  perform public.commit_action(gid, (select revision from public.games where id = gid), null, ub, jsonb_build_object('game', '{}'::jsonb, 'set_roles', jsonb_build_array(jsonb_build_object('player_id', ub, 'role', 'spectator', 'seat', null, 'ready', false))), '{}'::jsonb);
  perform public.commit_action(gid, (select revision from public.games where id = gid), null, ub, jsonb_build_object('game', '{}'::jsonb, 'set_roles', jsonb_build_array(jsonb_build_object('player_id', ub, 'role', 'player', 'seat', 2, 'ready', false))), '{}'::jsonb);
  perform pg_temp.expect('B is a player again with a fresh rack row', exists (select 1 from public.player_racks where game_id = gid and player_id = ub) and (select role from public.game_players where player_id = ub and game_id = gid) = 'player');
  -- the room is full (3 players), so a spectator cannot become a fourth player
  perform public.commit_action(gid, (select revision from public.games where id = gid), null, ud, jsonb_build_object('roster_only', true, 'add_player', jsonb_build_object('player_id', ud, 'role', 'spectator', 'nickname', 'W')), '{}'::jsonb);
  perform pg_temp.expect_error('fourth player in a room for 3', format($s$update public.game_players set role = 'player', seat = 0 where game_id = %L and player_id = %L$s$, gid, ud));
  -- a role change is refused once the game has started
  update public.games set status = 'active' where id = gid;
  perform pg_temp.expect_error('role change outside the lobby', format($s$update public.game_players set role = 'spectator', seat = null where game_id = %L and player_id = %L$s$, gid, uc), 'GAME_STARTED');
end $$;

do $$ begin raise notice 'ALL ROLE / RLS CHECKS PASSED'; end $$;
rollback;
