/**
 * goby-tide emit tool.
 *
 * The sweep never returns prose a harness has to parse. It ends by calling a tool whose
 * arguments are already validated, and the harness reads the resulting JSONL.
 *
 * There is one emit tool and no second stage. What stands between a plausible refactor and a
 * GitHub issue is a different contract from the cleaner's, because the claim is different: a
 * cleaner must make a defect happen and then make it stop, and a tide must *not* make anything
 * happen. So the required runs are the suite before the change and the same suite after it —
 * the two runs that show a refactor is a refactor. A plan with no runs is still allowed, but
 * only if the agent says why, and the issue says "not verified" in the same words.
 *
 * The diff is deliberately NOT an argument: the harness reads it out of the sandbox with
 * `git diff` after the run, so the change a reviewer reads is the change that was tested.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import {
	createBashTool,
	defineTool,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

// The scan executes code from the repository under review, and a child process inherits the
// environment. Without this the checkout could read the model key straight out of `env`. The
// tool name is `bash`, so this replaces the built-in and the model still sees only one shell.
//
// An allowlist, not a denylist: a denylist has to guess every credential name, and it missed the
// token and the key on the first pass in the parent project. Anything not named here is dropped.
const ENV_ALLOW = new Set([
	"PATH", "HOME", "SHELL", "PWD", "TERM", "TZ", "LANG", "LC_ALL", "LC_CTYPE",
	"TMPDIR", "USER", "LOGNAME", "VIRTUAL_ENV", "PYTHONPATH", "NODE_PATH", "CI",
	// The reference tree is writable to nobody, so git must not take an optional lock.
	"GIT_OPTIONAL_LOCKS", "GIT_TERMINAL_PROMPT",
	// The two TIDE_* a shell needs: the writable copy of the tree, and scratch space.
	"TIDE_SANDBOX",
	"TIDE_SCRATCH",
]);

// The PI_* names pi documents for a shell tool, named one by one rather than by prefix: a prefix
// rule turns any PI_*-named secret into a leak channel.
const PI_ENV_ALLOW = new Set([
	"PI_CODING_AGENT", "PI_CODING_AGENT_DIR", "PI_PACKAGE_DIR", "PI_PROVIDER",
	"PI_MODEL", "PI_REASONING_LEVEL", "PI_SESSION_ID", "PI_SESSION_FILE",
]);

function keepEnv(name: string): boolean {
	return ENV_ALLOW.has(name) || PI_ENV_ALLOW.has(name)
		|| name.startsWith("LC_") || name.startsWith("NVM_");
}

const OUT_DIR = process.env.TIDE_OUT ?? "/scratch/out";
// The cap is image-owned (`tide/defaults.env`) and exported by the entrypoint; a numeric fallback
// here would be a second source of truth, so a missing value fails loudly.
function requiredInt(name: string): number {
	const raw = process.env[name];
	if (raw === undefined || raw.trim() === "") {
		throw new Error(`${name} is required; the tide entrypoint sets it from tide/defaults.env`);
	}
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
	return value;
}

// One container scans several candidates; without these the filing step cannot tell which
// measurement a proposal belongs to, and the dedupe key is measurement-shaped.
const CHECK = process.env.TIDE_CHECK ?? "";
const PATH_UNDER_TEST = process.env.TIDE_PATH ?? "";

function emit(kind: string, record: unknown) {
	mkdirSync(OUT_DIR, { recursive: true });
	appendFileSync(join(OUT_DIR, `${kind}.jsonl`), JSON.stringify(record) + "\n");
}

const ProposalShape = {
	summary: Type.String({
		description:
			"One paragraph: why this measurement is a problem *in this codebase*. Name what is " +
			"in the file, not the category it falls into.",
	}),
	plan: Type.String({
		description:
			"The ordered steps that remove it: what moves where, which seam to cut on, and what " +
			"to do first. Markdown list. Specific enough that someone else could follow it.",
	}),
	applied: Type.Boolean({
		description:
			"true when you actually made the change in the sandbox and ran the suite after it.",
	}),
	tests_command: Type.String({
		description: "The command that runs the project's own suite. Same command before and after.",
	}),
	tests_output_before: Type.String({
		description:
			"What that command printed *before* you changed anything, copied from the run. " +
			"Required when applied is true.",
	}),
	tests_output_after: Type.String({
		description:
			"What the same command printed after the change, copied from the run. Required when " +
			"applied is true. Same pass/fail state as before, or this is not a refactor.",
	}),
	unverified_reason: Type.String({
		description:
			"Why you could not run the suite (no test command, missing toolchain, a service the " +
			"container cannot reach). Required when applied is false.",
	}),
	risk: Type.String({
		description:
			"What a reviewer must check did not change: public API, error text, ordering, the " +
			"files the tests do not cover.",
	}),
	confidence: Type.Union([Type.Literal("high"), Type.Literal("medium"), Type.Literal("low")], {
		description: "low means you are guessing; do not report those.",
	}),
};

const reportProposal = defineTool({
	name: "report_proposal",
	label: "Report proposal",
	description:
		"Report the plan that removes one measured smell. Call once per smell. The measurement " +
		"is given to you, not chosen by you: do not report a different file or a different check.",
	parameters: Type.Object(ProposalShape),
	outputSchema: Type.Object(ProposalShape),
	execute(_id, p) {
		// The measurement is the detector's. A proposal that names something else cannot be
		// matched to a candidate, and filing it would put a number on an issue that the sweep
		// never measured.
		const summary = p.summary.trim();
		const plan = p.plan.trim();
		const risk = p.risk.trim();
		if (!summary) throw new Error("summary is required: why is this a smell here?");
		if (!plan) throw new Error("plan is required: the ordered steps that remove it");
		if (!risk) throw new Error("risk is required: what must a reviewer check did not change?");
		if (p.applied) {
			if (!p.tests_command.trim() || !p.tests_output_before.trim() || !p.tests_output_after.trim()) {
				throw new Error(
					"applied is true, so tests_command, tests_output_before and tests_output_after " +
						"are all required. Run the project's suite before the change and after it, and " +
						"copy what each printed. A change with no before-run is a change nobody can " +
						"compare against.",
				);
			}
		} else if (!p.unverified_reason.trim()) {
			throw new Error(
				"applied is false, so unverified_reason is required: an issue that says 'not " +
					"verified' without saying why is a plan a human has to test themselves.",
			);
		}
		const record = {
			...p,
			check: CHECK,
			path: PATH_UNDER_TEST,
			reported_at: new Date().toISOString(),
		};
		emit("proposals", record);
		return {
			content: [{ type: "text", text: `Recorded: ${CHECK} on ${PATH_UNDER_TEST}` }],
			details: { recorded: true },
			structuredContent: record,
		} as never;
	},
});

export default function (pi: ExtensionAPI) {
	pi.registerTool(reportProposal);

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

	// pi has no tool cap of its own, and a prompt asking for one is a suggestion. The cap has to
	// be enforced by the harness, and it must never block the emit tool: a run that hits the wall
	// with a plan already formed must still be able to report it.
	const maxTools = requiredInt("TIDE_MAX_TOOLS");
	let calls = 0;
	pi.on("tool_call", (event) => {
		if (event.toolName === "report_proposal") return;
		calls += 1;
		if (calls > maxTools) {
			return {
				block: true,
				reason:
					`exploration budget exhausted (${maxTools} tool calls). Stop exploring: call ` +
					`report_proposal now with the plan you have. Anything you only describe in your ` +
					`final message is discarded.`,
			};
		}
	});
}
