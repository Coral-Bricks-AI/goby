export const REVIEW_VERSION = '0.5.10';
// Unset, two instances in the same repo collide: `own_reviews()` (github.ts) counts any review
// bearing `MARKER` toward `GOBY_MAX_ROUNDS` regardless of which instance posted it, and a merge
// gate reading `STATUS_CONTEXT` by string can't tell them apart. Set `GOBY_INSTANCE` on the second
// workflow (e.g. `deepseek`) to give it its own status context and its own marker, so it gets its
// own round budget and its own status independent of the first. Unset is unchanged.
export function instanceSuffix(env: NodeJS.ProcessEnv = process.env): string {
  return (env.GOBY_INSTANCE ?? '').trim();
}
export function statusContext(env: NodeJS.ProcessEnv = process.env): string {
  const instance = instanceSuffix(env);
  return instance ? `Goby Review (${instance})` : 'Goby Review';
}
export function marker(env: NodeJS.ProcessEnv = process.env): string {
  const instance = instanceSuffix(env);
  return instance ? `goby-${instance}` : 'goby';
}
export const STATUS_CONTEXT = statusContext();
export const GATE_CONTEXT = 'Goby Gate';
export const MARKER = marker();
export const SUMMARY_PREFIX = `**${STATUS_CONTEXT}**`;
// `MARKER` is written into HTML comments verbatim, but an operator-supplied `GOBY_INSTANCE` can
// contain regex metacharacters (`v4.1`'s `.`, or worse, an unbalanced `(`/`[`), and several readers
// (github.ts, wake/records.ts) build a `RegExp` out of `MARKER` to read those comments back. Every
// such site must escape it with this, not interpolate `MARKER` directly, or a value like `a[`
// throws `SyntaxError: Invalid regular expression` out of the reader and a value like `v4.1` quietly
// matches more than it wrote.
export function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
export const MARKER_PATTERN = escapeForRegExp(MARKER);
export function botLogins(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.GOBY_BOT_LOGINS ?? 'github-actions,github-actions[bot]').split(',').map(s => s.trim()).filter(Boolean);
}
export const BOT_LOGINS = botLogins();
