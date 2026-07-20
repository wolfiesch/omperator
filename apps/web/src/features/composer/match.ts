// Tiered query ranking (exact / prefix / boundary / includes /
// fuzzy-subsequence) shared by the slash palette and the file-reference
// picker. Adapted from T3 Code packages/shared/src/searchRanking.ts (MIT,
// T3 Tools Inc., commit f61fa9499d96fee825492aba204593c37b27e0cb); see
// provenance/t3code/imports/f2-transcript-20260711.json.

export function scoreSubsequenceMatch(value: string, query: string): number | null {
  if (query === "") return 0;
  let queryIndex = 0;
  let firstMatchIndex = -1;
  let previousMatchIndex = -1;
  let gapPenalty = 0;
  for (let valueIndex = 0; valueIndex < value.length; valueIndex += 1) {
    if (value[valueIndex] !== query[queryIndex]) continue;
    if (firstMatchIndex === -1) firstMatchIndex = valueIndex;
    if (previousMatchIndex !== -1) gapPenalty += valueIndex - previousMatchIndex - 1;
    previousMatchIndex = valueIndex;
    queryIndex += 1;
    if (queryIndex === query.length) {
      const spanPenalty = valueIndex - firstMatchIndex + 1 - query.length;
      const lengthPenalty = Math.min(64, value.length - query.length);
      return firstMatchIndex * 2 + gapPenalty * 3 + spanPenalty + lengthPenalty;
    }
  }
  return null;
}

export interface ScoreTiers {
  readonly exactBase: number;
  readonly prefixBase?: number;
  readonly boundaryBase?: number;
  readonly includesBase?: number;
  readonly fuzzyBase?: number;
}

export function scoreQueryMatch(value: string, query: string, tiers: ScoreTiers): number | null {
  if (value === "" || query === "") return null;
  const lengthPenalty = Math.min(64, Math.max(0, value.length - query.length));
  if (value === query) return tiers.exactBase;
  if (tiers.prefixBase !== undefined && value.startsWith(query)) {
    return tiers.prefixBase + lengthPenalty;
  }
  if (tiers.boundaryBase !== undefined) {
    for (const marker of ["-", "_", "/", " "]) {
      const index = value.indexOf(`${marker}${query}`);
      if (index !== -1) return tiers.boundaryBase + (index + marker.length) * 2 + lengthPenalty;
    }
  }
  if (tiers.includesBase !== undefined) {
    const index = value.indexOf(query);
    if (index !== -1) return tiers.includesBase + index * 2 + lengthPenalty;
  }
  if (tiers.fuzzyBase !== undefined) {
    const fuzzy = scoreSubsequenceMatch(value, query);
    if (fuzzy !== null) return tiers.fuzzyBase + fuzzy;
  }
  return null;
}
