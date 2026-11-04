/**
 * What goes into a review body, from what the harness produced.
 *
 * Kept separate from the publisher so the wording is testable without a GitHub client, and so
 * the same numbers appear in the job log and in the review a human reads.
 */
import type { Finding } from './contract.ts';

export interface ReviewStats {
  model: string;
  head: string;
  base: string;
  diffLines: number;
  elapsedS: number;
  toolCalls: number;
  droppedPaths: number;
  droppedCap: number;
  droppedDupe: number;
  droppedResolved: number;
  droppedRetracted: number;
  /** The image reference the job ran, usually a `:latest` tag. */
  image: string | null;
  /** The digest that tag resolved to at the start of this run, when the registry answered. */
  imageDigest: string | null;
  /** The evidence cannot be trusted; the gate refuses a review that has one. */
  incomplete: string | null;
  /** The scan was bounded, not broken: the reviewer answered, it just stopped looking early. */
  caveat?: string | null;
}

export function build_summary(
  inline: readonly Finding[],
  overflow: readonly Finding[],
  withheld: { dupes: readonly Finding[]; resolved: readonly Finding[] },
  stats: ReviewStats,
  version: string,
): string {
  const count = inline.length + overflow.length;
  const lines = [
    `**Goby Review** — sandboxed review (v${version}) via \`${stats.model}\` on ` +
    `\`${stats.head.slice(0, 10)}\` against \`${stats.base.slice(0, 10)}\`. The reviewer cloned the ` +
    'change and could run code against it; probe commands are quoted in the finding bodies where it did.',
    '',
  ];
  if (!count && !withheld.dupes.length && !withheld.resolved.length) lines.push('No bugs found in this diff.');
  else if (!count) lines.push('No NEW bugs in this diff. Withheld finding(s):');
  else lines.push(`Found **${count}** bug(s): ${inline.length} inline below, ${overflow.length} outside the diff hunks.`);
  for (const finding of overflow) {
    lines.push(`- \`${finding.path}:${finding.line}\` **[${finding.severity}]** ${finding.title} — ${finding.detail.slice(0, 300)}`);
  }
  if (stats.droppedPaths) lines.push(`- (${stats.droppedPaths} finding(s) on ignored paths were dropped.)`);
  if (stats.droppedRetracted) lines.push(`- (${stats.droppedRetracted} self-retracted finding(s) were dropped.)`);
  if (stats.droppedCap) lines.push(`- (${stats.droppedCap} further finding(s) beyond the finding cap were not reported.)`);
  for (const [label, findings] of [['already-open', withheld.dupes], ['resolved re-derivation', withheld.resolved]] as const) {
    if (findings.length) lines.push('', `${findings.length} ${label} finding(s) withheld:`, ...findings.map(f => `- \`${f.path}:${f.line}\` **[${f.severity}]** ${f.title}`));
  }
  if (stats.incomplete) lines.push('', `**This review is incomplete:** ${stats.incomplete}`);
  if (stats.caveat) lines.push('', `Partial scan: ${stats.caveat}`);
  lines.push('', `Diff: ${stats.diffLines} lines. ${stats.toolCalls} tool call(s), ${stats.elapsedS.toFixed(1)}s.`);
  if (stats.image) {
    // The tag is what the workstation ran; the digest is what it meant at the time. Without the
    // second, a finding cannot be reproduced once `:latest` moves on.
    lines.push(`Image: \`${stats.image}\`${stats.imageDigest ? ` (\`${stats.imageDigest}\`)` : ' (digest unresolved)'}.`);
  }
  return lines.join('\n');
}
