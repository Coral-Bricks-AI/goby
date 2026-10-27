/** Unified-diff ranges on the new (RIGHT) side. Deleted/binary files have no entry. */
export class Hunk {
  readonly new_start: number;
  readonly new_count: number;
  constructor({ new_start, new_count }: { new_start: number; new_count: number }) {
    this.new_start = new_start;
    this.new_count = new_count;
  }
}
export type Hunks = Record<string, Hunk[]>;

export function parse_hunks(diff: string): Hunks {
  // Null prototype prevents a repository path such as __proto__ being special.
  const hunks: Hunks = Object.create(null);
  let path: string | null = null;
  for (const line of diff.split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/u)) {
    const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (match) {
      if (path === null) continue;
      const start = Number(match[1]);
      const count = Number(match[2] ?? 1);
      if (count > 0) (hunks[path] ??= []).push(new Hunk({ new_start: start, new_count: count }));
      continue;
    }
    if (line.startsWith('+++ b/')) path = line.slice(6);
    else if (line.startsWith('+++ ') || line.startsWith('diff --git ')) path = null;
  }
  return hunks;
}
export function line_in_hunks(hunks: Hunks, path: string, line: number): boolean {
  return (Object.hasOwn(hunks, path) ? hunks[path] : []).some(h =>
    h.new_start <= line && line <= h.new_start + h.new_count - 1);
}
export function clamp_end_to_hunk(hunks: Hunks, path: string, line: number, end_line: number | null): number | null {
  if (end_line === null) return null;
  for (const hunk of Object.hasOwn(hunks, path) ? hunks[path] : []) {
    const last = hunk.new_start + hunk.new_count - 1;
    if (hunk.new_start <= line && line <= last) return Math.min(end_line, last);
  }
  return null;
}
export function resolve_diff_path(path: string, hunks: Hunks): [string, boolean] {
  const stripped = /^(a|b)\//.test(path) ? path.slice(2) : null;
  if (Object.hasOwn(hunks, path)) return [path, stripped !== null && Object.hasOwn(hunks, stripped)];
  if (stripped !== null && Object.hasOwn(hunks, stripped)) return [stripped, false];
  return [path, false];
}
