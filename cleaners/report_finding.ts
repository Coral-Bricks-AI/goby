/**
 * goby-cleaners emit tool.
 *
 * The hunter never returns prose that a harness has to parse. It ends by calling a tool
 * whose arguments are already validated, and the harness reads the resulting JSONL. That
 * is the whole reason this project uses pi instead of a prompt-and-regex harness: a
 * malformed finding is a failed tool call, not a silently dropped paragraph.
 *
 * There is exactly one emit tool. v1 has no second stage and no second model: the hunter
 * is the only thing between a claim and a GitHub issue, so the claim has to carry a command
 * that made the defect happen, and a second command that made it stop.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import {
	createBashTool,
	defineTool,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

// The hunter has to execute things to prove anything, and it executes code from the repo
// under review. A child process inherits the environment, so without this the checkout
// could read the gateway key straight out of `env`. The tool name is `bash`, so this
// replaces the built-in and the model still sees only one shell.
//
// An allowlist, not a denylist: a denylist has to guess every credential name, and it
// missed GITHUB_TOKEN and CORAL_INTERNAL_API_SECRET on the first pass. Anything not named
// here is dropped, so a new secret in the caller's environment cannot leak by default.
const ENV_ALLOW = new Set([
	"PATH", "HOME", "SHELL", "PWD", "TERM", "TZ", "LANG", "LC_ALL", "LC_CTYPE",
	"TMPDIR", "USER", "LOGNAME", "VIRTUAL_ENV", "PYTHONPATH", "NODE_PATH",
	// The read-only reference tree is writable to nobody, so git must not take an optional
	// lock: `git status` / `git diff` would otherwise try to refresh the index and fail.
	"GIT_OPTIONAL_LOCKS", "GIT_TERMINAL_PROMPT",
	// The two CLEANERS_* a shell needs: a writable copy of the tree, and scratch space.
	"CLEANERS_SANDBOX",
	"CLEANERS_SCRATCH",
]);

// The PI_* names pi itself documents for a shell tool. Named one by one rather than by
// prefix: a prefix rule turns any PI_*-named secret into a leak channel, which is exactly
// how the denylist failed before.
const PI_ENV_ALLOW = new Set([
	"PI_CODING_AGENT", "PI_CODING_AGENT_DIR", "PI_PACKAGE_DIR", "PI_PROVIDER",
	"PI_MODEL", "PI_REASONING_LEVEL", "PI_SESSION_ID", "PI_SESSION_FILE",
]);

function keepEnv(name: string): boolean {
	return ENV_ALLOW.has(name) || PI_ENV_ALLOW.has(name)
		|| name.startsWith("LC_") || name.startsWith("NVM_");
}

const OUT_DIR = process.env.CLEANERS_OUT ?? "/scratch/out";
// One container hunts several components; without this the filing step cannot tell which
// component a finding belongs to, and the dedupe key is component-shaped.
const COMPONENT = process.env.CLEANERS_COMPONENT ?? "";

function emit(kind: string, record: unknown) {
	mkdirSync(OUT_DIR, { recursive: true });
	appendFileSync(join(OUT_DIR, `${kind}.jsonl`), JSON.stringify(record) + "\n");
}

const FindingShape = {
	title: Type.String({ description: "One sentence, specific: what breaks and when." }),
	severity: Type.Union([Type.Literal("high"), Type.Literal("medium"), Type.Literal("low")]),
	file: Type.String({ description: "Repo-relative path of the code that is wrong." }),
	line: Type.Number({ description: "1-based line the claim is anchored to." }),
	invariant: Type.String({
		description: "The rule from the component brief this code violates. Quote it.",
	}),
	trigger: Type.String({
		description: "Concrete input/state that reaches the bad path. Not a category, an instance.",
	}),
	observed: Type.String({ description: "What the code actually does." }),
	expected: Type.String({ description: "What it must do instead." }),
	repro_command: Type.String({
		description: "The exact command you ran to make the defect happen. Empty is not allowed.",
	}),
	repro_output: Type.String({
		description: "What that command actually printed. Copied from the run, never reconstructed.",
	}),
	flip_command: Type.String({
		description:
			"After changing the suspected line in the sandbox, the command you re-ran to show " +
			"the defect is gone. Empty is not allowed.",
	}),
	flip_output: Type.String({
		description: "What the re-run printed. Copied, never reconstructed.",
	}),
	confidence: Type.Union([Type.Literal("high"), Type.Literal("medium"), Type.Literal("low")], {
		description: "low means you are guessing; do not report those.",
	}),
};

const reportFinding = defineTool({
	name: "report_finding",
	label: "Report finding",
	description:
		"Report one candidate defect. Call once per distinct defect. Every claim must be grounded " +
		"in code you actually read, with a runnable repro and the run that shows it is gone.",
	parameters: Type.Object(FindingShape),
	outputSchema: Type.Object(FindingShape),
	execute(_id, p) {
		// There is no second stage and no second model, so this is the only thing standing
		// between a plausible story and a GitHub issue a human has to read. Two required
		// runs: one that fails, and one that passes once the blamed line is changed. The
		// second is what turns "a harness fails" into "this line causes it".
		if (!p.repro_command.trim() || !p.repro_output.trim()) {
			throw new Error(
				"a finding needs a repro_command you ran and its real repro_output; " +
					"a claim you could not make fail is not a finding",
			);
		}
		if (!p.flip_command.trim() || !p.flip_output.trim()) {
			throw new Error(
				"a finding needs flip_command and flip_output: change the suspected line in " +
					"the sandbox, re-run, and show the defect is gone. A repro that still fails " +
					"after the line is patched was never testing that line.",
			);
		}
		const record = { ...p, component: COMPONENT, reported_at: new Date().toISOString() };
		emit("findings", record);
		return {
			content: [{ type: "text", text: `Recorded: ${p.title}` }],
			details: { recorded: true },
			structuredContent: record,
		} as never;
	},
});

export default function (pi: ExtensionAPI) {
	pi.registerTool(reportFinding);

	const sanitizedBash = createBashTool(process.cwd(), {
		spawnHook: ({ command, cwd, env }) => ({
			command,
			cwd,
			env: Object.fromEntries(
				Object.entries(env).filter(([name]) => keepEnv(name)),
			),
		}),
	});
	pi.registerTool({ ...sanitizedBash, name: "bash" });

	// pi has no turn cap, and a prompt asking for one is a suggestion: the first
	// unbudgeted run went to 75 turns and 81 tool calls while the prompt asked for 40.
	// The cap has to be enforced by the harness, and it must never block the emit
	// tools, or a run that hits the wall could not report what it already found.
	const maxTools = Number(process.env.CLEANERS_MAX_TOOLS ?? 60);
	let calls = 0;
	pi.on("tool_call", (event) => {
		if (event.toolName === "report_finding") return;
		calls += 1;
		if (calls > maxTools) {
			return {
				block: true,
				reason:
					`exploration budget exhausted (${maxTools} tool calls). Stop exploring: call ` +
					`report_finding now for each defect you can already evidence. Anything you only ` +
					`describe in your final message is discarded, so an unreported finding is lost.`,
			};
		}
	});
}
