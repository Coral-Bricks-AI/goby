/**
 * The pure decisions `codeRun.ts` makes, pulled out so they have tests independent of GitHub I/O
 * — the same split `rounds.ts` draws for the reviewer's own budget.
 */

/**
 * `task` is either inline prompt text, or a path under `.goby/tasks/` in the *consumer* repo,
 * resolved relative to its root. The `.goby/tasks/` prefix is the whole grammar: anything else is
 * inline text, verbatim, however long or short.
 */
export type TaskSource =
  | { inline: true; text: string }
  | { inline: false; path: string };

export function resolve_task_source(task: string): TaskSource {
  const trimmed = task.trim();
  if (trimmed.startsWith('.goby/tasks/')) return { inline: false, path: trimmed };
  return { inline: true, text: task };
}

/** Newline- or comma-separated glob list, trimmed and with empty entries dropped. */
export function parse_allowed_paths(raw: string): string[] {
  return raw.split(/[\n,]/).map(s => s.trim()).filter(Boolean);
}

/** Deterministic per run: one task against one base commit always proposes the same branch. */
export function code_branch_name(baseSha: string, instance?: string): string {
  const suffix = instance ? `-${instance}` : '';
  return `goby/code${suffix}-${baseSha.slice(0, 10)}`;
}

export interface RoundState {
  round: number;
  maxRounds: number;
  openThreads: number;
}

/**
 * Whether the thread-fix loop should keep going, and why not when it should stop.
 *
 * Reaching the cap with open threads left is an escalation, never a silent stop: the loop must
 * say so (draft the pull request, post a comment) rather than leave a reviewer's thread
 * unanswered with no record of why nobody came back to it.
 */
export function round_decision(state: RoundState): { continue: boolean; escalate: boolean; reason: string | null } {
  if (state.openThreads === 0) return { continue: false, escalate: false, reason: null };
  if (state.round >= state.maxRounds) {
    return {
      continue: false, escalate: true,
      reason: `${state.openThreads} open thread(s) remain after ${state.maxRounds} round(s); escalating instead of continuing silently`,
    };
  }
  return { continue: true, escalate: false, reason: null };
}
