/**
 * The review emit tool.
 *
 * The reviewer never returns prose a harness has to parse: it ends by calling a tool whose
 * arguments are already validated, and the harness reads the resulting JSONL. A malformed
 * finding is then a failed tool call, not a silently dropped paragraph — the same reason
 * cleaners uses this shape.
 *
 * Two things this file owns, both because pi cannot:
 *   - the findings schema (`path`/`line` required, severity normalised by the publisher);
 *   - the turn cap. pi has no budget of its own, and a prompt asking for one is a suggestion.
 *
 * It also replaces the built-in `bash` tool with an allowlisted-environment one: the agent runs
 * with a shell on purpose (it clones, greps, writes probes), and a child process inherits the
 * environment, so the environment it can inherit has to be chosen rather than assumed.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Type } from '@earendil-works/pi-ai';
import {
	createBashTool,
	defineTool,
	type ExtensionAPI,
} from '@earendil-works/pi-coding-agent';

// An allowlist, not a denylist: a denylist has to guess every credential name, and it missed the
// token and the model key on its first pass. Anything not named here is dropped, so a secret
// added to the caller's environment later cannot leak by default.
const ENV_ALLOW = new Set([
	'PATH', 'HOME', 'SHELL', 'PWD', 'TERM', 'TZ', 'LANG', 'LC_ALL', 'LC_CTYPE',
	'TMPDIR', 'USER', 'LOGNAME', 'VIRTUAL_ENV', 'PYTHONPATH', 'NODE_PATH',
	// git must not take optional locks in the read-only reference tree.
	'GIT_OPTIONAL_LOCKS', 'GIT_TERMINAL_PROMPT',
	// What the reviewer's shell legitimately needs: the writable sandbox, its output directory,
	// and the repository coordinates it reports findings against.
	'GOBY_SANDBOX', 'GOBY_OUT', 'GOBY_SCRATCH', 'GOBY_REPO', 'GOBY_HEAD', 'GOBY_BASE',
]);
const PI_ENV_ALLOW = new Set([
	'PI_CODING_AGENT', 'PI_CODING_AGENT_DIR', 'PI_PACKAGE_DIR', 'PI_PROVIDER',
	'PI_MODEL', 'PI_REASONING_LEVEL', 'PI_SESSION_ID', 'PI_SESSION_FILE',
]);
const keepEnv = (name: string): boolean =>
	ENV_ALLOW.has(name) || PI_ENV_ALLOW.has(name) || name.startsWith('LC_') || name.startsWith('NVM_');

// Its own directory: findings are the reviewer's evidence, and it must not be able to rewrite the
// job description it is judged against.
const OUT = process.env.GOBY_AGENT_OUT ?? '/workspace/out/agent';
const FINDINGS = join(OUT, 'findings.jsonl');
// The cap is a property of the harness, not a suggestion in the prompt.
const MAX_TOOL_CALLS = Number(process.env.GOBY_MAX_TOOL_CALLS ?? 80);

let tool_calls = 0;

function record(kind: string, payload: unknown) {
	mkdirSync(OUT, { recursive: true });
	appendFileSync(FINDINGS, JSON.stringify({ kind, ...(payload as object) }) + '\n');
}

export default function (pi: ExtensionAPI) {
	pi.on('tool_call', event => {
		tool_calls += 1;
		if (tool_calls <= MAX_TOOL_CALLS) return;
		record('blocked', { tool_calls });
		if (event.toolName === 'report_findings') return;
		// Stop looking and report. The one thing a blocked call must not do is leave the model
		// with nothing to say, so the block message names the emit tool.
		return {
			block: true,
			reason: `Tool budget spent (${MAX_TOOL_CALLS} calls). Call report_findings now with what you have verified, then stop. A finding you did not verify is worse than one you skipped.`,
		};
	});

	// The reviewer's shell, with the environment above and no other.
	const bash = createBashTool({ env: (current: Record<string, string | undefined>) => {
		const kept: Record<string, string> = {};
		for (const [name, value] of Object.entries(current)) {
			if (value !== undefined && keepEnv(name)) kept[name] = value;
		}
		return kept;
	} });

	pi.registerTool(bash);
	const parameters = Type.Object({
		findings: Type.Array(Type.Object({
			path: Type.String({ description: 'Repository-relative path, exactly as in the diff (no a/ or b/).' }),
			line: Type.Integer({ minimum: 1, description: 'Line in the file AFTER the change.' }),
			end_line: Type.Optional(Type.Integer({ minimum: 1, description: 'Last line of a multi-line finding.' })),
			severity: Type.Union([Type.Literal('high'), Type.Literal('medium'), Type.Literal('low')]),
			title: Type.String({ description: 'One line: what is wrong.' }),
			detail: Type.String({ description: 'Why it is wrong, and what you ran to check it.' }),
		}), { description: 'Findings to report. Empty when you found nothing.' }),
	});

	pi.registerTool(defineTool({
		name: 'report_findings',
		label: 'Report findings',
		description:
			'Report the bugs you found and verified. Call once at the end with every finding, then stop. ' +
			'An empty array is a valid answer: most changes have no bug.',
		parameters,
		// `execute` is a method of the definition, not a second argument: passing it separately
		// produced a tool the model could call and the runtime could not run.
		outputSchema: parameters,
		async execute(_id: string, args: { findings: unknown[] }) {
			record('findings', { findings: args.findings, tool_calls });
			return {
				content: [{ type: 'text', text: `recorded ${args.findings.length} finding(s)` }],
				details: {},
			};
		},
	}));
}
