/**
 * Company-name normalization tiers shared by the defendant migration and the
 * Defendants dedupe tooling. Each tier is strictly looser than the previous
 * one: matchKey ⊆ dbaKey ⊆ coreKey (more names collide as you go down).
 *
 * Policy (user-confirmed 2026-07-10): matchKey collisions are treated as the
 * SAME company automatically; dbaKey/coreKey/fuzzy collisions are only ever
 * flagged for manual review — an "LLC" and a "Corp" can be distinct legal
 * entities even when the base name is identical.
 */

/** Case/whitespace-insensitive — used to compare field VALUES. */
export function normalizeName(name: string): string {
  return name.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Case/whitespace/punctuation/diacritics-insensitive — the auto-match key.
 * "Angie´s List Inc." and "Angie's List Inc" collapse to "angie s list inc".
 */
export function matchKey(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // combining accents left by NFKD
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// After matchKey, "d/b/a" reads "d b a"; also match the undelimited forms.
const TRADE_NAME_TAIL = /\b(?:d ?b ?a|f ?k ?a|a ?k ?a)\b/;

/** matchKey with the trade-name tail (d/b/a …, f/k/a …, a/k/a …) cut off. */
export function dbaKey(name: string): string {
  return matchKey(name).split(TRADE_NAME_TAIL)[0].trim();
}

const CORPORATE_SUFFIXES =
  /\b(?:incorporated|corporation|companies|company|limited|holdings|group|l ?l ?c|l ?l ?p|pllc|lp|inc|corp|co|ltd|plc|pc|pa)\b/g;

/** dbaKey with corporate suffixes and articles removed — loosest exact tier. */
export function coreKey(name: string): string {
  return dbaKey(name)
    .replace(CORPORATE_SUFFIXES, " ")
    .replace(/\bthe\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Levenshtein-based similarity in [0, 1]; 1 = identical. Meant to be run on
 * coreKey forms so punctuation and suffix noise don't inflate the distance.
 */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const m = a.length;
  const n = b.length;
  if (!m || !n) return 0;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = new Array<number>(n + 1);
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return 1 - prev[n] / Math.max(m, n);
}

/** Cheap pre-filter: skip similarity() when lengths alone rule out `min`. */
export function lengthsComparable(a: string, b: string, min: number): boolean {
  const max = Math.max(a.length, b.length);
  return max > 0 && 1 - Math.abs(a.length - b.length) / max >= min;
}
