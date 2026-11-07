# Trust model

Goby Review runs the pull request. That is the point — a reviewer with a shell can run the tests,
write a probe and watch a theory fail, and a reviewer that only reads a diff cannot. The design
question is therefore not "can it run the code" but "what can that code reach".

## The two secrets, and where they live

| secret | where it is | what can read it |
|---|---|---|
| `GITHUB_TOKEN` (`pull-requests: write`, `statuses: write`) | root-only file `/run/goby/token` | the root entrypoint and the publisher step only |
| the model key | root-only file `/run/goby/model-key` | the key proxy only |

The reviewer runs as uid 10001 with an empty environment (`runuser … env -i`). It cannot read
either file: `/proc/PID/environ` for a different uid needs ptrace access, and both files are
`0600` root.

The model key cannot be hidden in another uid the way the token is, because the agent's own
process is the one calling the model — true of the reviewer and of a cleaner alike. So it never
sees the key either: `models.json` points at `http://127.0.0.1:8787/v1` with a dummy credential,
and the loopback proxy replaces the provider's key header (`authorization`, or `x-api-key` for
Anthropic) with the real key before forwarding upstream. The agent holds a string that
is worthless outside the container.

What that means in practice: code from the pull request can make model calls (it was going to
anyway) and cannot post to GitHub. The blast radius of a malicious pull request is its own
container.

## What is and is not proven

- **Proven:** the process that can write to the pull request never runs pull-request code. That is
  a uid boundary plus an environment allowlist, and it is the invariant the whole shape exists for.
- **Not proven:** a container escape. If the reviewer reaches root inside the container it can
  read the token file. Closing that needs a second job with a separate filesystem, which buys one
  more boundary at the cost of the simplest design we have. It is not in scope yet, and it should
  be a deliberate decision rather than an accident.
- **Not proven:** the model resists prompt injection. A `CLAUDE.md` in the pull request is read by
  the reviewer, and a review that is talked into reporting nothing can still produce a green gate.
  The gate proves the evidence satisfies a policy, not that the reviewer was honest.

## Triggers

Use `pull_request`, never `pull_request_target`. The latter runs from the base branch with secrets
present and then executes the pull request, which inverts this entire document. Fork pull requests
are skipped: they receive no secrets, so the job would fail rather than review.

## Network

There is no egress filtering. The reviewer can reach the network, which is what lets it install a
toolchain the image does not ship and run the project's own test suite. With the key behind the
proxy, network access gives up little: everything worth stealing is either already in the
repository being reviewed or unreachable by design. Filtering can be added later as an allowlist in the shared entrypoint if a
concrete need shows up; it is not free (IP rotation, installs that stop working) and it is not
needed to keep the token out of reach.

## Reviewer identity

Statuses and comments are posted by `github-actions` when the workflow uses `GITHUB_TOKEN`. That
means other workflows in the same repository share the identity — protect workflow files with
branch protection, or configure a dedicated app and set `GOBY_BOT_LOGINS` to its login. This is an
authorization boundary in the gate, not just display metadata.

## What the gate does not cover

GitHub commit statuses have no compare-and-swap API, so the gate is not an atomic lock: there is a
time-of-check window between reading evidence and the merge. Branch protection remains the
authoritative merge-time check. See [merge-gate](merge-gate.md).
