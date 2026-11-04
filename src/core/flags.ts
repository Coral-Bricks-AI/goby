/**
 * Feature switches, as pure functions so the behaviour has a test.
 *
 * There is one: the gate. It is worth a flag because it is the only part of a review that can
 * fail for a reason unrelated to the code — a policy about evidence — and until a repository
 * actually requires it in branch protection, that failure is noise on every pull request.
 */
export type Env = Record<string, string | undefined>;

/** `GOBY_GATE` must be explicitly `on`. Absent, empty, `off`, `false`, anything else: off. */
export function gate_enabled(env: Env = process.env): boolean {
  return (env.GOBY_GATE ?? '').trim().toLowerCase() === 'on';
}
