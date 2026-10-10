/**
 * Fuzzy search for the command palette.
 *
 * "Fuzzy" means you can skip letters: "rtopt" finds "route-optimizer-v2". The risk is matching too
 * much: if the letters may be scattered across a whole sentence, almost anything matches almost
 * everything. So the rule here is: each word you type must be found, in order, INSIDE ONE WORD of
 * the item. A hyphenated key counts as one word, which is what makes key abbreviations work.
 *
 * Returns 0 for no match, otherwise a score up to 1 (higher is better). Ranking, best first:
 * the word starts with what you typed, then contains it as one piece, then contains its letters
 * in order with gaps.
 */
export function fuzzyScore(haystack: string, search: string): number {
  const words = haystack.toLowerCase().split(/\s+/).filter(Boolean);
  const tokens = search.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return 1; // nothing typed: everything is shown
  if (words.length === 0) return 0;

  let total = 0;
  for (const token of tokens) {
    let best = 0;
    for (const word of words) best = Math.max(best, scoreWord(word, token));
    if (best === 0) return 0; // every typed word must match something
    total += best;
  }
  return total / tokens.length;
}

function scoreWord(word: string, token: string): number {
  if (word === token) return 1;
  if (word.startsWith(token)) return 0.9;
  // Start of a later part of a hyphenated or dotted key: "opt" in "route-optimizer-v2".
  if (word.split(/[-_.]/).some((part) => part.startsWith(token))) return 0.8;
  if (word.includes(token)) return 0.6;
  return subsequence(word, token);
}

/** Letters in order with gaps. Scores lower the more the letters are spread out; 0 if not all found. */
function subsequence(word: string, token: string): number {
  if (token.length < 2) return 0; // a single stray letter matching anywhere is noise
  let from = 0;
  let first = -1;
  let last = -1;
  for (const char of token) {
    const at = word.indexOf(char, from);
    if (at === -1) return 0;
    if (first === -1) first = at;
    last = at;
    from = at + 1;
  }
  const span = last - first + 1;
  // Tight matches (few skipped letters) score up to 0.5; loose ones approach 0.1.
  return 0.1 + 0.4 * (token.length / span);
}
