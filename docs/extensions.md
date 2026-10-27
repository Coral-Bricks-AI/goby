# Extending Goby

The production implementation is TypeScript. Keep extensions behind typed
ports and do not execute a PR's own plugins in the trusted review job.
A general plugin loader is **not implemented**.

## Existing seams

- **Provider:** add a record to `src/providers/index.ts`. The common transport
  supports OpenAI-compatible chat completions and Responses API endpoints.
- **Model/endpoint:** use `--provider`, `--model`, and `--base-url` without a fork.
- **Review contract:** `SYSTEM_PROMPT`, `build_user_prompt`, and strict parsing
  are in `src/core/contract.ts`. Change tests with the contract.
- **Filters:** retraction, ignored paths, deduplication, resolved-history
  matching, and severity selection are pure functions in that module.
- **Tools/loop:** `src/core/agent.ts` accepts injected transport/tools for tests.
  Turn admission is owned by the compiled rule, not the loop.
- **GitHub:** `GitHubClient` accepts injected fetch. Publication is separate in
  `src/platforms/publish.ts`.
- **Eligibility/lifecycle:** change `src/core/rules.ts` with its kernel-checked
  laws. Never bolt a second permission predicate onto a caller.

## Future plugin design

Likely hook points are context acquisition, read-only tools, deterministic
findings, extra publication sinks, and provider registration. Before adding
loading, specify a versioned TypeScript interface, trust policy, resource
bounds, and error behavior. In particular:

1. Load only trusted installed/configured code, never `.goby/*.ts` from the PR.
2. Treat plugin failure as incomplete evidence where it affects the gate;
   silently skipping a mandatory checker must not authorize a merge.
3. Do not give model-returned text authority to invoke arbitrary shell code.
4. Preserve typed plain-data boundaries and deterministic test injection.

Highest-value future work is deterministic checks alongside the model,
labelled historical-PR benchmarks, richer trusted context, non-GitHub targets,
and prompt-injection hardening. These are not existing public APIs.
