// Automatic word judging: the dictionary. Pure (no DOM, no I/O): it is given the bytes of data/words.bin, so the browser (local play against the
// computer) and the Edge Function (online rooms set to "automatic") run the SAME code. Mirrored to supabase/functions/_shared/game by tools/sync-edge-shared.mjs.
//
// Source: data/words.bin = a Bloom filter of Arabic word forms built from the AyaSpell dictionary (see data/README-wordlist.txt for the credit and licence).
// The list stores the SKELETON of a word: أ إ آ ٱ are folded to ا and ى to ي, diacritics and tatweel are removed. ة ؤ ئ ء keep their own letters.
//
// Policy (decided by the owner): reject only words that are CLEARLY unknown, and accept the questionable ones.
//   check(raw, {mode})  is that lenient judge, used for human moves.      -> {ok:true} | {ok:false, why:'shape'|'idhafa'|'unknown'}
//   isReal(raw, {mode}) is a strict judge, used only by the computer opponent, which tries thousands of strings and so must not find stray entries.
// `raw` is the word as the TILES spell it: a joining hamza-on-ya tile is 'ئـ' (ئ + tatweel), the plain one is 'ئ'. Pass the tile letters, not wordStr().
//
// What is judged, in order:
//   1. shape      letter positions no Arabic word has: ة or ى before the last letter, ئـ at the end, plain ئ before another letter, إ inside a word.
//   2. idhafa     the owner's rule: an attached pronoun is never allowed (لي لك له به منه فيه عليه ... and noun + ـهم ـها ـكم ـك ـه ـي ...).
//   3. the list   the word itself, or ال + a listed word, or an inflected form of a listed word (plural, dual, feminine, verb endings): that last step is the leniency.
// The mode tailors step 3: Basic has no ة ء ؤ ئ tiles, so ـه stands for ـة and a medial ي / و may stand for ئ / ؤ; Expanded and Adaptive match the letters they were given.
// Limits, stated plainly: the list cannot tell أ from ا or إ from ا (it is stored folded), so the hamza seat on an alif is not judged; and a word the list does
// not know (a rare name, a new loanword) is rejected, which is exactly what the owner's "automatic or Tahkim" room choice is for.

const DIAC = /[\u064B-\u0652\u0654\u0655\u0670\u0640]/g;
const FOLD = w => w.replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي');
export function normalize(w) {
  w = String(w == null ? '' : w);
  if (w.normalize) w = w.normalize('NFKC');
  return FOLD(w.replace(DIAC, '')).trim();
}

// ---------- the Bloom filter (the file format of data/words.bin: 'AWL1', m bits, k hashes, n words) ----------
function hash(s, seed) {
  let x = seed >>> 0;
  for (let i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 16777619) >>> 0; }
  x ^= x >>> 15; x = Math.imul(x, 2246822507) >>> 0; x ^= x >>> 13; x = Math.imul(x, 3266489909) >>> 0; x ^= x >>> 16;
  return x >>> 0;
}
function loadBloom(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.length < 16 || bytes[0] !== 0x41 || bytes[1] !== 0x57 || bytes[2] !== 0x4C || bytes[3] !== 0x31) throw new Error('words.bin: bad file');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const m = dv.getUint32(4, true), k = bytes[8], n = dv.getUint32(12, true);
  const has = word => {
    const h1 = hash(word, 2166136261), h2 = (hash(word, 0x9747b28c) | 1) >>> 0;
    for (let i = 0; i < k; i++) {
      const idx = ((h1 + Math.imul(i, h2)) >>> 0) % m;
      if (!((bytes[16 + (idx >> 3)] >> (idx & 7)) & 1)) return false;
    }
    return true;
  };
  return { has, count: n };
}

// ---------- hand-checked data ----------
const set = s => new Set(s.trim().split(/\s+/));
// Two-letter words: the list holds hundreds of 2-letter fragments that are not words, so a 2-letter word must be on this checked list. Attached-pronoun forms
// (لي لك له بي به) are deliberately NOT here, and the alif words (أب أم أخ أن إن إذ أي أو) are, because the game has the hamza tiles (their skeleton starts with ا).
const WORD2 = set(`بت بث بح بخ بر بط بع بق بك بل بن بل تب تل تم تو ثب ثج ثر ثق ثم جئ جب جد جذ جر جز جس جص جف جل جم جن جو حب حت حث حج حد حر حز حس حش حص حض حط حظ حق حك حل حم حن حي
خب خد خذ خر خز خس خص خض خط خف خل خن دب در دس دع دف دق دك دل دم دن ذا ذب ذر ذق ذل ذم ذو ذي رب رث رج رخ رد رز رس رش رص رض رف رق رم رن ري زج زد زر زف زق زل زم زن زي سب ست سح سد سر سك سل سم سن
شب شج شح شد شذ شر شط شف شق شك شل شم صب صح صد صر صغ صف صك صل صم صن صه ضب ضج ضخ ضد ضر ضع ضل ضم ضن طب طر طف طل طم طن طي ظل ظن عج عد عز عس عش عض عظ عف عق عم عن عي غب غث غد غر غش غص غض غط غل غم غن غي
فئ فت فج فخ فذ فر فش فص فض فظ فك فل فم فن في قئ قح قد قر قس قش قص قط قف قل قم كب كد كر كف كل كم كن كي لا لب لذ لص لط لف لم لن لو ما مت مج مخ مد مذ مر مس مص مط مع مل من نث ند نر نص نط نق نل نم
ها هب هد هر هز هش هل هم هن هو هي ود ول يا يد يم اب ام ان اخ اذ اي او`);
// Real two-letter nouns that may follow ال (الأب، اليد، الدم، الفم ...).
const NOUN2 = set(`بت بث بر بط بق بن تب تل تم تو ثج جب جد جذ جر جز جس جص جف جل جم جن جو حب حت حث حج حد حر حز حس حش حص حض حط حظ حق حك حل حن حي خب خد خذ خر خز خس خص خط خف خل خن دب در دس دف دق دك دل دم دن
ذب ذر ذل ذم رب رث رج رخ رد رز رس رش رص رض رف رق رم ري زج زر زف زق زل زم زن زي سب ست سح سد سر سك سل سم سن شب شج شح شد شذ شر شط شف شق شك شل شم صب صد صر صف صك صل صم صن ضب ضج ضخ ضد ضر ضم ضن طب طر طف طل طم طن طي
ظن عج عد عز عس عش عض عف عق عم عي غب غث غد غر غش غض غط غل غم غن غي فت فج فخ فذ فر فش فص فض فظ فك فل فم فن قح قر قس قش قص قط قل كب كد كر كف كل كم كن لب لذ لص لط لف مت مج مخ مد مر مس مص مط مل نث ند نص نم هد هر هز هش هم ود يد يم اب ام اخ`);
// Words the owner confirmed as real even though the list may not carry them (skeleton spelling).
const ALLOWED = set('كرسي حديقة قصة صحيفة لغة جبال صحراء طئ سقاف');

// Alif words that are real but missing from the list (it was built without most hamza-on-alif words), written in skeleton spelling.
const ALIF_REAL = set(`اخذ اكل امر انف اذن الف ابو اخو اخت اذا اما اول اين اية امن امل ابا اثر اهل اسم اسد ابن ارض اخر اكد ايد ايا اجر اجل ارب اتي ادب اصل افق امة اسر اسف اهم ابد ابل اعد اعم اخي ابي امي`);
// Common nouns whose attached-pronoun form is not also an ordinary adjective (so يومي، ديني، وطني، مالك stay allowed): noun + attached pronoun (كتابي، بيتهم، قلمك، مدرستها ...) is the idhafah the owner forbids in every form. The words themselves stay allowed.
const POSS_NOUNS = `كتاب بيت قلم باب كرسي دفتر سيارة مدرسة جامعة غرفة حقيبة طاولة نافذة صديق صديقة معلم معلمة طالب طالبة ولد بنت ابن اخ اخت اب ام جد جدة عم عمة زوج زوجة رجل امراة اسم وجه راس يد عين اذن انف فم دار بستان حديقة كلمة لغة فكرة قصة رسالة صورة لعبة هدية سؤال جواب`.split(/\s+/);
for (const w of POSS_NOUNS) ALLOWED.add(w.replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي'));   // the nouns themselves are words
const IDH_ENDS = ['ي', 'ك', 'ه', 'ها', 'هم', 'هن', 'هما', 'كم', 'كما', 'كن', 'نا'];
// The attached-pronoun forms of the prepositions: the closed set that is never a word of its own.
const IDH_STEMS = {
  ل: ['ي', 'ك', 'ه', 'ها', 'هم', 'هن', 'هما', 'كم', 'كما', 'نا'], ب: ['ي', 'ك', 'ه', 'ها', 'هم', 'هن', 'هما', 'كم', 'كما', 'كن', 'نا'],
  من: ['ي', 'ك', 'ه', 'ها', 'هم', 'هن', 'هما', 'كم', 'كما', 'كن', 'ا'], في: ['ك', 'ه', 'ها', 'هم', 'هن', 'هما', 'كم', 'كما', 'كن', 'نا'],
  عل: ['يك', 'يه', 'يها', 'يهم', 'يهن', 'يهما', 'يكم', 'يكما', 'يكن', 'ينا'], الي: ['ك', 'ه', 'ها', 'هم', 'هن', 'هما', 'كم', 'كما', 'كن', 'نا'],
  عن: ['ي', 'ك', 'ه', 'ها', 'هم', 'هن', 'هما', 'كم', 'كما', 'كن', 'ا'], مع: ['ي', 'ك', 'ه', 'ها', 'هم', 'هن', 'هما', 'كم', 'كما', 'كن', 'نا'],
  لد: ['ي', 'يك', 'يه', 'يها', 'يهم', 'يهن', 'يهما', 'يكم', 'يكما', 'ينا']
};
const IDH_CLOSED = new Set();
for (const n of POSS_NOUNS) { const f = n.replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي'), base = f.endsWith('ة') ? f.slice(0, -1) + 'ت' : f; for (const e of IDH_ENDS) { if (f.endsWith('ي') && e === 'ي') continue; if (f.length + e.length > 3) IDH_CLOSED.add(base + e); } }
for (const [p, ends] of Object.entries(IDH_STEMS)) for (const e of ends) IDH_CLOSED.add(p + e);
// Relatives that back a word up: a real word usually has a plural, a feminine, a verb form ... listed too; stray entries do not.
const REL_SUF = ['ة', 'ات', 'ان', 'ين', 'ون', 'وا', 'ت', 'تين', 'ية', 'ا', 'ي'];
const REL_PRE = ['ي', 'ت', 'ن', 'م'];
// Inflections that the leniency step strips (nominal first, then verbal).
const INFL_SUF = ['ات', 'ون', 'ين', 'ان', 'ة', 'وا', 'تم', 'تن', 'نا', 'ت', 'ن', 'ا'];
const INFL_PRE = ['ي', 'ت', 'ن', 'ا', 'م'];
const POSS_SUF = ['كما', 'هما', 'كم', 'كن', 'هم', 'هن', 'ها', 'ك', 'ه', 'ي'];

export function createDictionary(buffer) {
  const bloom = loadBloom(buffer), has = bloom.has;

  const related = (w, need = 1) => {
    let n = 0;
    for (const s of REL_SUF) { if (has(w + s) && ++n >= need) return true; }
    for (const p of REL_PRE) { if (has(p + w) && ++n >= need) return true; }
    return n >= need;
  };
  // Does the word carry inflections of its own? Attached-pronoun forms (كتابهم) never do, real words (مالك، عربي) usually do.
  const ownForms = w => has(w + 'ة') || has(w + 'ات') || has(w + 'ون') || has(w + 'ين') || has(w + 'ان') || has('ي' + w) || has('ت' + w) || has('ن' + w);

  // Rule 2: a noun / verb + attached pronoun. Fires only when the stem is a listed word and the word has no forms of its own.
  const possessive = w => {
    if (IDH_CLOSED.has(w)) return true;
    for (const s of POSS_SUF) {
      if (w.length - s.length < 3 || !w.endsWith(s)) continue;
      const stem = w.slice(0, -s.length);
      if (has(stem) && !ownForms(w)) return true;
    }
    return false;
  };

  // The list itself, with the leniency steps. `loose` = false is the strict (computer) reading: the word, or ال + the word, and nothing derived.
  const known = (w, loose) => {
    if (w.length < 2) return false;
    if (ALLOWED.has(w) || ALIF_REAL.has(w)) return true;
    if (w.length === 2) return WORD2.has(w);
    if (has(w)) return true;
    if (w.startsWith('ال') && w.length >= 4) {
      const r = w.slice(2);
      if (r.length === 2) { if (NOUN2.has(r) && has(r)) return true; }
      else if (ALLOWED.has(r) || (has(r) && !has(r + '#'))) return true;   // ال never meets a verb (the file marks those words with a '#' twin key)
    }
    if (!loose) return false;
    // ---- leniency: an inflected form of a listed word ----
    let b = w.startsWith('ال') && w.length >= 5 ? w.slice(2) : w;
    for (let pi = -1; pi < INFL_PRE.length; pi++) {
      const p = pi < 0 ? '' : INFL_PRE[pi];
      if (p && !b.startsWith(p)) continue;
      const rest = b.slice(p.length);
      for (let si = -1; si < INFL_SUF.length; si++) {
        const s = si < 0 ? '' : INFL_SUF[si];
        if (!p && !s) continue;
        if (s && !rest.endsWith(s)) continue;
        const stem = s ? rest.slice(0, -s.length) : rest;
        if (stem.length < 3 || !has(stem)) continue;
        if (stem.length >= 4 || related(stem)) return true;
      }
    }
    return false;
  };

  // Rule 1: the shape of the word as the tiles spell it.
  const badShape = raw => {
    const t = String(raw == null ? '' : raw).replace(/[\u064B-\u0652\u0654\u0655\u0670]/g, '');
    if (/ئـ\s*$/.test(t)) return true;                        // the joining hamza tile can never end a word
    if (/ئ(?![ـ])./su.test(t)) return true;                    // the plain hamza tile only ends a word
    if (/[ةى]./su.test(t)) return true;                         // ة and ى only close a word
    for (let i = 0; i < t.length; i++) if (t[i] === 'إ' && i !== 0 && t.slice(0, i) !== 'ال') return true;   // إ opens a word (or follows ال)
    return false;
  };

  // The spellings a mode accepts for the same word. Basic has no ة / ء / ؤ / ئ tile: a final ه may stand for ة, and a medial ي / و for ئ / ؤ.
  const variants = (w, mode) => {
    const out = [w];
    if (mode !== 'basic') return out;
    if (w.length > 2 && w.endsWith('ه')) out.push(w.slice(0, -1) + 'ة');
    for (let i = 1; i < w.length - 1; i++) {
      if (w[i] === 'ي') out.push(w.slice(0, i) + 'ئ' + w.slice(i + 1));
      else if (w[i] === 'و') out.push(w.slice(0, i) + 'ؤ' + w.slice(i + 1));
    }
    return out;
  };

  function judge(raw, mode, loose) {
    if (badShape(raw)) return { ok: false, why: 'shape' };
    const w = normalize(raw);
    if (w.length < 2) return { ok: false, why: 'shape' };
    let idh = false;
    for (const v of variants(w, mode)) {
      if (possessive(v)) { idh = true; continue; }
      if (known(v, loose)) return { ok: true };
    }
    if (idh) return { ok: false, why: 'idhafa' };
    // The list was built without many words that carry a hamza on an alif (أكل، أرض، يأكل ...), so such a word cannot be called unknown: accepted (lenient policy).
    if (loose && w.length >= 3) {
      if (mode !== 'basic' && /[أإآ]/.test(raw)) return { ok: true, soft: true };
      if (mode === 'basic' && w.length <= 5 && /^ا[^ل]/.test(w)) return { ok: true, soft: true };
    }
    return { ok: false, why: 'unknown' };
  }

  // ---- the computer's trust filter: a word must be backed up by related forms, so stray list entries are never played ----
  const PRONOUN_END = /(هو|هم|هن|ها|هما|كم|كن|كما|ني|نا|تهم|تها|ته|تك|تنا|تني)$/;
  function trusted(raw) {
    let w = normalize(raw);
    if (w.length >= 4 && w.startsWith('ال')) w = w.slice(2);
    if (ALLOWED.has(w) || ALIF_REAL.has(w)) return true;
    if (w.charAt(0) === 'ا' && w.length <= 3) return false;   // the list knows many stray 3-letter alif fragments
    if (w.length <= 2) return true;
    if (/ءي$/.test(w)) return false;
    if (w.length >= 4 && PRONOUN_END.test(w) && !ownForms(w)) return false;
    let need = w.length === 3 ? 3 : w.length === 4 ? 2 : 1;
    if (w.length >= 4 && w.length <= 6 && (/ة$/.test(w) || /اء$/.test(w))) need = 0;
    if (need === 0) return true;
    let n = 0;
    for (const s of REL_SUF) {
      if (has(w + s)) n++;
      if (n < need && w.length > 3 && w.endsWith(s) && has(w.slice(0, -s.length))) n++;
      if (n >= need) return true;
    }
    for (const p of REL_PRE) {
      if (has(p + w)) n++;
      if (n < need && w.length > 3 && w.charAt(0) === p && has(w.slice(1))) n++;
      if (n >= need) return true;
    }
    return n >= need;
  }

  return {
    count: bloom.count,
    normalize,
    /** Lenient judge for human moves. */
    check: (raw, opts = {}) => judge(raw, opts.mode || 'expanded', true),
    /** Strict judge for the computer opponent: a listed, trusted, rule-abiding word. */
    isReal: (raw, opts = {}) => { const r = judge(raw, opts.mode || 'expanded', false); return r.ok && trusted(raw); },
    /** words: raw tile spellings. Returns one verdict per word, in order: {word, ok, why?, soft?} (soft = accepted although the list cannot confirm it). */
    judgeAll: (words, opts = {}) => words.map(raw => ({ word: normalize(raw) || String(raw), ...judge(raw, opts.mode || 'expanded', true) })),
    /** The clearly unknown ones only: [{word, why}]. */
    rejected: (words, opts = {}) => words.map(raw => ({ word: normalize(raw) || String(raw), ...judge(raw, opts.mode || 'expanded', true) })).filter(r => !r.ok).map(({ word, why }) => ({ word, why }))
  };
}

// One Arabic sentence for the words a judge refused (shown to the player; the server and the local game use the same text).
const WHY = { unknown: 'غير معروفة في القاموس', idhafa: 'ممنوعة: ضمير متصل (إضافة)', shape: 'شكلها غير صالح' };
export const explainRejected = bad => bad.slice(0, 2).map(x => `«${x.word}» ${WHY[x.why] || WHY.unknown}`).join(' · ') + (bad.length > 2 ? ` · +${bad.length - 2}` : '') + '. عدّل الكلمة أو أعد القطع.';
