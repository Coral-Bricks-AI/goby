# Goby repo notes for coding agents

Goby ships images; consumers default to `:latest` for both review and cleaners. Prefer changes that
live inside the image — code, prompts, extensions, and the image-owned defaults — so a merge to main
and the image publish reach every consumer automatically.

- Tunable defaults belong in `review/defaults.env` or `cleaners/defaults.env`, not in workflow YAML
  or a vendored copy. Workflow-only changes do not propagate through `:latest`; consumers must
  re-copy them.
- YAML changes are normal while the product is young. Keep the shipped workflow and the consumer
  copy in sync, and say in the PR that consumers need to re-copy.
- Only the default branch publishes `:latest`; reviews report the digest they resolved, so a finding
  stays attributable to the bytes that produced it.
- Arm auto-merge when you open a pull request: `gh pr merge <n> --auto --squash`. `main` requires
  `check` and `Goby Review` and every conversation resolved, so GitHub merges it when those are true.
  Arm it with a person's token, never a `GITHUB_TOKEN` inside CI: that merge starts no `push`
  workflows, so `:latest` would never publish and the post-merge cleaners would never scan.

## A review round, from the other side

1. Read every thread and decide whether it is worth fixing.
2. Fix it, then commit.
3. Push.
4. Reply `fixed in <short sha>`, then resolve the thread.

Push before replying: resolving releases the merge. A resolved thread is not re-reported, so resolve
only what you fixed, or reply why it is out of scope.

When there is no pull request to review, `gh issue list --label goby-cleaners --state open` is the next
best backlog: those are defects goby cleaners reproduced in this repository, and each one has a
repro and a flip to start from.

## Testing the container without a pull request

The image is most of the product, and everything inside it runs locally in under a minute: the
clone, `prepare`, the rendered prompt, the sandbox, the agent and its tools. What still needs a real
pull request is the Actions side — the runner, the image pull, and publishing the review and its
statuses — so use the loop below to iterate and a plain PR to confirm the wiring.

```bash
docker build -t goby-base base
docker build --build-arg BASE_IMAGE=goby-base -f review/Dockerfile -t goby-review .

# A provider key belongs in a file, never on the command line: argv shows up in `ps` and in history.
printf 'CORALBRICKS_API_KEY=%s\n' "$KEY" > /tmp/goby.env && chmod 600 /tmp/goby.env
docker run --rm --env-file /tmp/goby.env -v "$PWD/out:/workspace/out" --entrypoint bash goby-review -lc \
  'pi --mode json --model coral/deepseek-v4.1-flash-fast --no-session \
     --extension /opt/goby/report_findings.ts --tools bash,read,grep,find,ls,report_findings \
     "Read /workspace/out/prompt.md. Do it, then call report_findings." > /workspace/out/events.jsonl'
```

`base/models/models.json` points at the loopback proxy, so either run the real entrypoint (which
starts it, and needs `GITHUB_TOKEN` plus the `GOBY_*` inputs) or copy the file and set `baseUrl` to
the provider directly. `events.jsonl` is the stream the review reads, so
`python3 common/timing.py events.jsonl --agent-seconds N --json` reproduces the timing line from it:
that is how the token, character and per-request accounting gets checked without waiting for a PR,
and how a claim about a provider's behaviour gets settled from the wire rather than from a doc.
