/**
 * The reviewer's findings, filtered down to what may be posted.
 *
 * Extracted from the old in-process pipeline so the filtering is a pure function: the harness
 * (pi, a shell, a model) produces claims, and everything that decides whether a claim becomes a
 * thread happens here, with tests, off a diff and a thread list rather than off a model.
 */
import * as contract from './contract.ts';
import * as diffs from './diff.ts';

export interface Selection {
  inline: contract.Finding[];
  overflow: contract.Finding[];
  withheld: { dupes: contract.Finding[]; resolved: contract.Finding[] };
  dropped: {
    paths: number;
    cap: number;
    dupe: number;
    resolved: number;
    retracted: number;
    ambiguous: number;
  };
}

export function select(
  findings: readonly contract.Finding[],
  options: {
    diff: string;
    open_threads: readonly contract.ThreadRecord[];
    resolved_history: readonly contract.ThreadRecord[];
    max_findings: number;
  },
): Selection {
  const [retractionFiltered, retracted] = contract.drop_self_retracted(findings);
  const hunks = diffs.parse_hunks(options.diff);

  // A path that resolves ambiguously (two files, same basename) is held back rather than posted
  // onto the wrong file: a wrong line is worse than a missing comment.
  const ambiguous: contract.Finding[] = [];
  const unambiguous: contract.Finding[] = [];
  let ambiguousDropped = 0;
  for (const finding of retractionFiltered) {
    const [path, collision] = diffs.resolve_diff_path(finding.path, hunks);
    if (!collision) {
      finding.path = path;
      unambiguous.push(finding);
      continue;
    }
    if (contract.keep_path(finding.path) && (!/^[ab]\//.test(finding.path) || contract.keep_path(finding.path.slice(2)))) {
      ambiguous.push(finding);
    } else {
      ambiguousDropped += 1;
    }
  }

  const deduped = contract.dedupe_findings(unambiguous);
  const kept = deduped.filter(f => contract.keep_path(f.path));
  const droppedPaths = deduped.length - kept.length + ambiguousDropped;

  for (const finding of kept) {
    if (finding.end_line === null || finding.end_line === undefined) continue;
    const end = diffs.clamp_end_to_hunk(hunks, finding.path, finding.line, finding.end_line);
    if (end !== null) finding.end_line = end;
  }

  const [fresh, dupe] = contract.split_already_raised(kept, options.open_threads);
  const [notResolved, resolved] = contract.split_resolved_rederivations(fresh, options.resolved_history);
  const ordered = [...notResolved, ...ambiguous].sort((a, b) => findings.indexOf(a) - findings.indexOf(b));
  const [selected, cap] = contract.select_findings(ordered, options.max_findings);

  const inline: contract.Finding[] = [];
  const overflow: contract.Finding[] = [];
  for (const finding of selected) {
    (ambiguous.includes(finding) || !diffs.line_in_hunks(hunks, finding.path, finding.line) ? overflow : inline).push(finding);
  }
  return {
    inline, overflow,
    withheld: { dupes: dupe, resolved },
    dropped: {
      paths: droppedPaths, cap,
      dupe: dupe.length, resolved: resolved.length,
      retracted: retracted.length, ambiguous: ambiguous.length,
    },
  };
}
