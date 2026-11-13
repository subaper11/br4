// V6.3: rooms can judge words automatically (the dictionary) instead of by Tahkim. The two exclude each other.
import fs from 'fs'; import path from 'path'; import { fileURLToPath } from 'url';
import { makeWorld, suite, across } from './lib.mjs';
import { createDictionary } from '../../supabase/functions/_shared/game/dictionary.js';
const { ok, group, done } = suite('online: automatic word judging (dictionary) vs Tahkim');
const bin = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'words.bin'));
const dict = createDictionary(bin);
const withDict = w => { w.deps.loadDictionary = async () => dict; return w; };

group('default rooms are unchanged: Tahkim, no dictionary');
{
  const w = makeWorld(); await w.start({ minutes: 10 });
  ok(w.snap.A.game.word_judging === 'tahkim', 'a new room judges by Tahkim');
  w.giveRack('A', [...'ضصثق']); await w.call('A', 'snapshot');
  const mv = await w.call('A', 'submit_move', { placements: across(w.snap.A, 'ضصثق') });
  ok(mv.ok, 'any word is accepted in a Tahkim room (the players judge)');
  ok(mv.snapshot.game.tahkim_available === true, 'and can be challenged');
}

group('choosing automatic judging');
{
  const w = makeWorld();   // no dictionary on this server
  const c = await w.raw('A', { action: 'create_room', nickname: 'A', settings: { word_judging: 'auto' } });
  ok(!c.ok && c.code === 'DICT_UNAVAILABLE', 'a room cannot be made automatic while the server has no dictionary: ' + c.code);
}
{
  const w = withDict(makeWorld());
  const c = await w.raw('A', { action: 'create_room', nickname: 'A', settings: { word_judging: 'auto' } });
  ok(c.ok && c.snapshot.game.word_judging === 'auto' && c.snapshot.game.judge_enabled === false, 'an automatic room has no Judge seat');
  w.snap.A = c.snapshot; w.useGame(c.snapshot.game.id);
  const j = await w.call('A', 'update_settings', { settings: { judge_enabled: true } });
  ok(!j.ok && j.code === 'AUTO_NO_JUDGE', 'a Judge cannot be switched on in an automatic room: ' + j.code);
  const back = await w.call('A', 'update_settings', { settings: { word_judging: 'tahkim' } });
  ok(back.ok && back.snapshot.game.word_judging === 'tahkim', 'the host can go back to Tahkim');
  const jj = await w.call('A', 'update_settings', { settings: { judge_enabled: true } });
  ok(jj.ok && jj.snapshot.game.judge_enabled === true, 'and then the Judge option is available again');
  const again = await w.call('A', 'update_settings', { settings: { word_judging: 'auto' } });
  ok(again.ok && again.snapshot.game.judge_enabled === false, 'switching to automatic clears the empty Judge seat');
  const bad = await w.call('A', 'update_settings', { settings: { word_judging: 'both' } });
  ok(!bad.ok && bad.code === 'BAD_REQUEST', 'only the two values exist');
}

group('the dictionary judges every move, and Tahkim does not exist');
{
  const w = withDict(makeWorld()); await w.start({ minutes: 10, word_judging: 'auto' });
  ok(w.snap.A.game.word_judging === 'auto', 'the room is automatic after start');
  w.giveRack('A', [...'ضصثق']); await w.call('A', 'snapshot');
  const bad = await w.call('A', 'submit_move', { placements: across(w.snap.A, 'ضصثق') });
  ok(!bad.ok && bad.code === 'WORD_UNKNOWN' && /ضصثق/.test(bad.message), 'a clearly unknown word refuses the move: ' + bad.code + ' ' + bad.message);
  const s = (await w.call('A', 'snapshot')).snapshot;
  ok(s.board.flat().every(x => !x) && s.me.rack.filter(Boolean).length === 4 && s.game.current_seat === 0, 'nothing was committed: the board is empty, the rack and the turn are untouched');
  w.giveRack('A', [...'كتابي']); await w.call('A', 'snapshot');
  const idh = await w.call('A', 'submit_move', { placements: across(w.snap.A, 'كتابي') });
  ok(!idh.ok && idh.code === 'WORD_UNKNOWN' && /ضمير متصل/.test(idh.message), 'an attached pronoun (idhafa) is refused: ' + idh.message);
  w.giveRack('A', [...'كتاب']); await w.call('A', 'snapshot');
  const good = await w.call('A', 'submit_move', { placements: across(w.snap.A, 'كتاب') });
  ok(good.ok && good.snapshot.game.current_seat === 1, 'a real word is accepted and the turn passes');
  const row = w.server().moves.at(-1); ok(row.validation_result === 'valid', 'the move is recorded as validated: ' + row.validation_result);
  await w.call('B', 'snapshot');
  const t = await w.call('B', 'request_tahkim', { reason: 'اختبار' }); ok(!t.ok && t.code === 'TAHKIM_OFF', 'request_tahkim is refused: ' + t.code);
  const j = await w.call('B', 'call_judge', { reason: 'اختبار' }); ok(!j.ok && j.code === 'TAHKIM_OFF', 'call_judge is refused: ' + j.code);
  const u = await w.call('A', 'request_undo'); ok(u.ok, 'undo (ask the opponent) still works');
}

group('the dictionary vanishing mid-match never lets a word through unjudged');
{
  const w = withDict(makeWorld()); await w.start({ minutes: 10, word_judging: 'auto' });
  w.deps.loadDictionary = async () => { throw new Error('gone'); };
  w.giveRack('A', [...'كتاب']); await w.call('A', 'snapshot');
  const r = await w.call('A', 'submit_move', { placements: across(w.snap.A, 'كتاب') });
  ok(!r.ok && r.code === 'DICT_UNAVAILABLE', 'refused with a clear message instead of accepting blindly: ' + r.code);
}
done();
