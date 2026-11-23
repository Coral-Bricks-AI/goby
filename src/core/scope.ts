/**
 * The diff-scope check: which of a run's changed paths are not covered by any allowed glob.
 *
 * Fails closed on purpose — the empty-allowlist case included. `code/` edits a repository it does
 * not own the invariants of, so "no allowed paths configured" must mean "nothing may be touched",
 * never "anything may be touched". A consumer that wants the whole repository in scope says so
 * with an explicit `**`.
 */

/** One path segment's glob, turned into the regex fragment that matches it (no `/`, no `**`). */
function segmentToRegExp(segment: string): string {
  let pattern = '';
  for (const ch of segment) {
    if (ch === '*') pattern += '[^/]*';
    else if (ch === '?') pattern += '[^/]';
    else if ('.+^${}()|[]\\'.includes(ch)) pattern += '\\' + ch;
    else pattern += ch;
  }
  return pattern;
}

/**
 * A glob split on `/`, with a `**` segment matching zero or more whole path segments — including
 * none, so `a/**` matches `a` itself and `a/**\/b` matches `a/b` with the middle segment absent.
 * Every other segment matches exactly one path segment via `*`/`?`/literal characters.
 */
function globToRegExp(glob: string): RegExp {
  const segments = glob.split('/');
  const parts: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]!;
    if (segment === '**') {
      const atStart = parts.length === 0;
      const atEnd = i === segments.length - 1;
      if (atStart && atEnd) parts.push('.*');
      else if (atEnd) parts.push('(?:/.*)?');
      else if (atStart) parts.push('(?:.*/)?');
      else parts.push('(?:/.*)?/');
      // A trailing `/**` consumes the slash that would otherwise be joined in below.
      if (atEnd) { i = segments.length; break; }
    } else {
      if (parts.length > 0 && segments[i - 1] !== '**') parts.push('/');
      parts.push(segmentToRegExp(segment));
    }
  }
  return new RegExp(`^${parts.join('')}$`);
}

/** Normalises a path for comparison: no leading `./`, no leading `/`. Does not resolve `..`. */
function normalize(path: string): string {
  return path.replace(/^\.\//, '').replace(/^\/+/, '');
}

/**
 * A path is rejected as traversal when any segment is literally `..` — rejected outright, never
 * matched against a glob, however the glob is written. A changed path should never contain one
 * (git reports repository-relative paths), so one present is treated as adversarial rather than
 * normalised away: normalising `a/../b` to `b` would let a crafted diff path textually match an
 * allowlist entry it has no business matching.
 */
function isTraversal(path: string): boolean {
  return path.split('/').some(segment => segment === '..');
}

/**
 * Paths in `changed_paths` that are not covered by any glob in `allow_globs`. Both empty inputs
 * are handled explicitly: no changed paths is nothing out of scope; no allow globs means nothing
 * is in scope, so every changed path is out of scope (fail closed).
 */
export function out_of_scope(changed_paths: string[], allow_globs: string[]): string[] {
  if (changed_paths.length === 0) return [];
  const patterns = allow_globs.map(g => globToRegExp(normalize(g.trim())));
  const out: string[] = [];
  for (const raw of changed_paths) {
    const path = normalize(raw);
    if (!path || isTraversal(path)) { out.push(raw); continue; }
    if (allow_globs.length === 0 || !patterns.some(re => re.test(path))) out.push(raw);
  }
  return out;
}
