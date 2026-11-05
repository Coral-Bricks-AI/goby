/**
 * What a blocked record means for the reader.
 *
 * The extension records *why* it stopped the reviewer; this turns that into the sentence a human
 * reads. Kept separate from the publisher because the first version said "tool-call budget" for
 * every block, including the turn-budget one it had just introduced — importing the publisher to
 * test that would run the publisher.
 */
export function caveat_for(record: Record<string, unknown>): string | null {
  if (record.kind !== 'blocked') return null;
  return record.reason === 'turns'
    ? `the reviewer reached its turn budget (${String(record.turns ?? '?')} turns), so the scan was bounded — findings it would have made later in the change are missing.`
    : 'the reviewer reached its tool-call budget, so the scan was bounded — findings it would have made later in the change are missing.';
}

/** One sentence per block reason: a run can block on turns 21, 22 and 23 with the same reason. */
export function caveats_for(records: readonly Record<string, unknown>[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    if (record.kind !== 'blocked') continue;
    const key = record.reason === 'turns' ? 'turns' : 'tool_calls';
    if (seen.has(key)) continue;
    const caveat = caveat_for(record);
    if (caveat !== null) {
      seen.add(key);
      out.push(caveat);
    }
  }
  return out;
}
