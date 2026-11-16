# goby-base: everything a goby image needs to run an agent safely, and nothing about what it is
# for. `review/`, `cleaners/` and `tide/` are all built `FROM goby-base` and add their own harness.
#
# What it owns, and why it is shared rather than copied:
#   - the model key proxy (base/keyproxy.mjs) — the only process holding the real key;
#   - the secret conventions (base/lib.sh) — token in a root-only file, key in a root-only file;
#   - `runuser`-based uid drop, so the agent's shell cannot read either;
#   - pi, pinned, because an agent that changes personality when npm publishes makes two runs
#     incomparable.
#
# Deliberately absent: any language toolchain for the reviewed repo, and any tool the reviewer
# can install for itself. A repo that needs Go, Rust, bun or git-lfs downloads it in the sandbox
# (there is no egress filtering) or brings its own image — the workflow takes an image digest.
# Baking every runtime in here would pay image size and attack surface, on every review, for a
# container that runs untrusted code.
FROM node:24-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash ca-certificates git jq ripgrep coreutils python3 python3-venv python3-pip \
 && rm -rf /var/lib/apt/lists/*

RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent@1.4.0

COPY keyproxy.mjs /opt/goby/keyproxy.mjs
COPY lib.sh /opt/goby/lib.sh
COPY models/ /opt/goby/models/
RUN chmod 0755 /opt/goby/lib.sh

# `python3` is here for goby's own summaries, so its package manager is too: the reviewer is told to
# run the repository's tests, and a container that cannot install a test runner spends turns
# guessing instead (www#2106 spent ten on hand-written `pytest` stubs). Debian marks its Python
# `externally-managed` and the agent is not root, which is two refusals for one `pip install` — this
# drops the first, and pip falls back to `~/.local` for the second. A venv still works.
ENV GOBY_HOME=/opt/goby \
    PI_OFFLINE=1 \
    PI_TELEMETRY=0 \
    PI_SKIP_VERSION_CHECK=1 \
    PIP_BREAK_SYSTEM_PACKAGES=1

# The agent runs as this uid and never as root; the token and the model key stay in processes it
# cannot read. 10001 matches cleaners, so a finding's environment looks the same in both.
RUN useradd --create-home --uid 10001 agent && mkdir -p /run/goby /workspace \
 && chown -R agent:agent /workspace

WORKDIR /workspace
