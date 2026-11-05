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
