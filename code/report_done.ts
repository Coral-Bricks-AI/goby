/**
 * The code-kind completion tool.
 *
 * Mirrors review/report_findings.ts: the agent never ends by returning prose a harness has to
 * parse, and never needs `edit`/`write` tool calls to be believed — it ends by calling a tool
 * whose argument is already validated, and the harness reads the resulting JSONL record. Unlike
 * the reviewer, this agent *is* given `edit`/`write`: the task is to change the sandbox, and the
 * harness reads what changed from the filesystem afterward, not from this tool's payload.
 *
 * Same two things this file owns that pi cannot: the environment allowlist for the bash tool it
 * replaces, and the turn/clock budget nudges, from the same `GOBY_AGENT_TIMEOUT_S` the entrypoint
 * wraps pi in.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Type } from '@earendil-works/pi-ai';
import {
	createBashTool,
	createLocalBashOperations,
	defineTool,
	type ExtensionAPI,
} from '@earendil-works/pi-coding-agent';

// An allowlist, not a denylist, same reasoning as review/report_findings.ts: anything not named
// here cannot leak into a child process by default.
const ENV_ALLOW = new Set([
	'PATH', 'HOME', 'SHELL', 'PWD', 'TERM', 'TZ', 'LANG', 'LC_ALL', 'LC_CTYPE',
	'TMPDIR', 'USER', 'LOGNAME', 'VIRTUAL_ENV', 'PYTHONPATH', 'NODE_PATH',
	'PIP_BREAK_SYSTEM_PACKAGES',
	'GIT_OPTIONAL_LOCKS', 'GIT_TERMINAL_PROMPT',
	'GOBY_SANDBOX', 'GOBY_OUT', 'GOBY_SCRATCH', 'GOBY_REPO', 'GOBY_BASE',
]);
const PI_ENV_ALLOW = new Set([
	'PI_CODING_AGENT', 'PI_CODING_AGENT_DIR', 'PI_PACKAGE_DIR', 'PI_PROVIDER',
	'PI_MODEL', 'PI_REASONING_LEVEL', 'PI_SESSION_ID', 'PI_SESSION_FILE',
]);
const keepEnv = (name: string): boolean =>
	ENV_ALLOW.has(name) || PI_ENV_ALLOW.has(name) || name.startsWith('LC_') || name.startsWith('NVM_');

const OUT = process.env.GOBY_AGENT_OUT ?? '/workspace/out/agent';
function requiredInt(name: string): number {
	const raw = process.env[name];
	if (raw === undefined || raw.trim() === '') {
		throw new Error(`${name} is required; the code entrypoint sets it from code/defaults.env`);
	}
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
	return value;
}
const COMMAND_TIMEOUT_S = requiredInt('GOBY_BASH_TIMEOUT_S');
const DONE = join(OUT, 'done.jsonl');
const MAX_TURNS = requiredInt('GOBY_MAX_TURNS');
const MAX_TOOL_CALLS = requiredInt('GOBY_MAX_TOOL_CALLS');
const AGENT_TIMEOUT_S = requiredInt('GOBY_AGENT_TIMEOUT_S');
const CLOCK_NOTICE_LEFT_PCT = 20;
const CLOCK_WRAP_UP_LEFT_PCT = 10;
const STARTED_MS = Date.now();
const seconds_left = (): number => AGENT_TIMEOUT_S - (Date.now() - STARTED_MS) / 1000;

let tool_calls = 0;
let turns = 0;
let reported = false;
let wrap_up_requested = false;
const warned = new Set<number>();

function record(kind: string, payload: unknown) {
	mkdirSync(OUT, { recursive: true });
	appendFileSync(DONE, JSON.stringify({ kind, ...(payload as object) }) + '\n');
}

function record_notice(payload: Record<string, unknown>) {
	try {
		record('budget', payload);
	} catch {
		// The done record at the end of the run still reports the truth about the run.
	}
}

export default function (pi: ExtensionAPI) {
	pi.on('turn_start', () => {
		turns += 1;
	});

	pi.on('turn_end', event => {
		const entries = [...event.entries];
		if (reported) return undefined;
		const remaining = MAX_TURNS - turns;
		const left = seconds_left();
		const out_of_turns = turns >= MAX_TURNS;
		const out_of_time = left <= (AGENT_TIMEOUT_S * CLOCK_WRAP_UP_LEFT_PCT) / 100;
		if (!wrap_up_requested && (out_of_turns || out_of_time)) {
			wrap_up_requested = true;
			record('blocked', {
				tool_calls,
				turns,
				seconds_left: Math.round(left),
				reason: out_of_turns ? 'turns' : 'clock',
			});
			entries.push({
				type: 'custom_message' as const,
				customType: 'goby-wrap-up',
				content:
					'Budget spent. Call report_done now with a short summary of what you changed (or why you ' +
					'stopped); an incomplete task said so honestly is a valid answer. Do not start new work.',
				display: false,
			});
			return { entries, continue: true };
		}
		if (!wrap_up_requested) {
			const threshold = [10, 5, 2].find(value => remaining <= value && !warned.has(value));
			const clock_due = left <= (AGENT_TIMEOUT_S * CLOCK_NOTICE_LEFT_PCT) / 100;
			if (threshold !== undefined || clock_due) {
				if (threshold !== undefined) warned.add(threshold);
				record_notice({
					turns,
					remaining,
					threshold: threshold ?? null,
					seconds_left: clock_due ? Math.round(left) : null,
				});
				const parts = [
					...(clock_due ? [`~${Math.max(Math.round(left), 0)}s`] : []),
					...(threshold === undefined ? [] : [`${remaining} turn(s)`]),
				];
				entries.push({
					type: 'custom_message' as const,
					customType: 'goby-budget',
					content: `Budget: ${parts.join(' and ')} left. Converge: finish or back out, then call report_done.`,
					display: false,
				});
			}
		}
		return entries.length > event.entries.length ? { entries } : undefined;
	});

	pi.on('tool_call', event => {
		tool_calls += 1;
		if (event.toolName === 'report_done') return;
		if (turns > MAX_TURNS) {
			record('blocked', { tool_calls, turns, reason: 'turns' });
			return {
				block: true,
				reason: `Turn budget spent (${MAX_TURNS} turns). Call report_done now, then stop.`,
			};
		}
		if (tool_calls <= MAX_TOOL_CALLS) return;
		record('blocked', { tool_calls, turns, reason: 'tool_calls' });
		return {
			block: true,
			reason: `Tool budget spent (${MAX_TOOL_CALLS} calls). Call report_done now, then stop.`,
		};
	});

	// Same shell as the reviewer's: a wall clock per command and a filtered environment, so a
	// child process this agent spawns cannot inherit the token or the model key either.
	const local = createLocalBashOperations();
	const bash = createBashTool(process.cwd(), {
		operations: {
			exec: (command, cwd, options) => local.exec(command, cwd, {
				...options,
				timeout: options.timeout ?? COMMAND_TIMEOUT_S,
			}),
		},
		spawnHook: ({ command, cwd, env }) => ({
			command,
			cwd,
			env: Object.fromEntries(Object.entries(env).filter(([name]) => keepEnv(name))),
		}),
	});

	pi.registerTool(bash);
	const parameters = Type.Object({
		summary: Type.String({ description: 'What you changed and why, or why the task could not be done in scope. One short paragraph.' }),
		complete: Type.Boolean({ description: 'True when the task is fully done; false when you backed out or stopped partway.' }),
	});

	pi.registerTool(defineTool({
		name: 'report_done',
		label: 'Report done',
		description:
			'Call once, at the end, when you believe your edits to the sandbox are complete — or when ' +
			'you are stopping without completing the task. Carries a short summary, not a diff: the ' +
			'harness reads your actual file changes from the sandbox.',
		parameters,
		outputSchema: parameters,
		async execute(_id: string, args: { summary: string; complete: boolean }) {
			reported = true;
			record('done', { summary: args.summary, complete: args.complete, tool_calls, turns });
			return {
				content: [{ type: 'text', text: 'recorded' }],
				details: {},
			};
		},
	}));
}
