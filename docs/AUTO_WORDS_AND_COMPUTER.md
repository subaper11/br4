# Automatic word judging and the computer opponent

Adapted from the VS3 build, but rewritten around this game's own pieces (three tile modes, idhafah rule, Tahkim, the shared rules in `js/rules.js`).

## 1. Word judging in online rooms: exactly one of two

The host picks **الحكم على الكلمات** in the lobby: **تحكيم اللاعبين** (Tahkim, default) or **قاموس تلقائي**.

| | Tahkim room | Automatic room |
|---|---|---|
| who judges | the players / the Judge | the dictionary, when the move is submitted |
| Tahkim button, Judge seat | yes | **gone** (server answers `TAHKIM_OFF`; `AUTO_NO_JUDGE` if a Judge is asked for) |
| unknown word | played, may be challenged | **refused**, tiles stay with the player |
| doubtful word | played | accepted, stored as `uncertain` |
| Undo (ask the opponent) | yes | yes |

Stored in `games.ext.word_judging`: no migration. `snapshot.game.word_judging` tells the browsers.

## 2. The dictionary (`js/dictionary.js`, `data/words.bin`)

Same code in the browser and the Edge Function (mirrored by `tools/sync-edge-shared.mjs`). Policy: **reject only what is clearly unknown, accept the questionable.**

1. **Shape**: ة / ى not final, ئـ at the end, plain ئ before another letter, إ inside a word.
2. **Idhafah** (never allowed): closed set of preposition + pronoun (لي لك له به منه فيه عليه…), common possessable nouns + pronoun (كتابي بيتهم قلمك مدرستها…), and noun + ـهم ـها ـكم ـك ـه ـي when the stem is listed and the word has no forms of its own (so مالك، عربي stay allowed).
3. **The list**: the word, ال + the word, or an inflected form of a listed word (plural, dual, feminine, verb endings). Basic mode also reads a final ه as ة and a medial ي / و as ئ / ؤ (it has no such tiles).

Known limits: the list is stored folded (أ إ آ → ا), so the hamza seat on an alif is not judged; and it was built without many words that carry a hamza on an alif (أكل، أرض، يأكل…), so a word containing أ/إ/آ that it does not know is **accepted** (reported as `uncertain`). Rare names and new loanwords are rejected: that is what the Tahkim room option is for. A source list that keeps the hamza would remove both limits.

Credit: the list derives from AyaSpell (GPL / LGPL / MPL): see `data/AYASPELL-*.txt` and `data/README-wordlist.txt`.

## 3. Play against the computer (local)

Cover → **VS COMPUTER** → level (سهل / متوسط / صعب) → mode → duration, then the usual start. Player 2 is the computer.

- `js/bot-search.js` finds moves (every row/column span, rack DFS, cross-words checked as tiles land; blanks and the adaptive alif's other forms in a second pass). `js/bot-worker.js` runs it off the main thread; without Worker support it runs on the main thread under a 450 ms budget.
- The computer uses the dictionary's **strict** reading (`isReal`) so it never plays a stray list entry.
- Its move is played tile by tile through the game's own `place` / `submit`, so scoring, clocks, history, first-move rule and the 50-point bingo are exactly the game's. With no move it swaps (if the bag allows) or passes.
- Against the computer: no challenges and no Undo; the human's words are judged by the dictionary too (lenient reading). The computer's rack is always face down. A new game keeps the same opponent (reload to go back to two players). Saved matches remember the computer.

## 4. Tests

`tests/online/auto-words.mjs` (server), `tests/e2e/autowords.py` (two browsers), `tests/e2e/bot.py` (browser vs computer). All are in `tests/run-all.mjs`.
