// Web Worker for the computer opponent: loads the word list once, then answers search requests so the page never freezes while the computer thinks.
//   in : { id, grid, rack, mode, level, budget }      out : { id, candidates, count, timedOut, ms } | { id, error }
import { createDictionary } from './dictionary.js';
import { solve } from './bot-search.js';

let dict = null, loading = null;
const load = () => (loading ||= fetch(new URL('../data/words.bin', import.meta.url)).then(r => { if (!r.ok) throw new Error('words.bin ' + r.status); return r.arrayBuffer(); })
  .then(b => (dict = createDictionary(new Uint8Array(b)))).catch(e => { loading = null; throw e; }));

onmessage = async e => {
  const m = e.data;
  try { await load(); postMessage({ id: m.id, ...solve(m, dict) }); }
  catch (err) { postMessage({ id: m.id, error: String(err && err.message || err) }); }
};
