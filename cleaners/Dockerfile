# goby-cleaners scanner image.
#
# One job per container: clone the pushed sha, scan every component it touched, file the
# issues, exit. Started by the post-merge workflow as a container job (see
# .github/workflows/cleaners-post-merge.yml), or by `docker run` locally.
#
# Deliberately NOT installed: a GitHub CLI, any cloud SDK, any agent framework beyond pi.
# The container's credentials are the model key and one repo-scoped installation token, both
# passed in at run time — and neither reaches the agent's shell.
#
# **Adding a tool.** This image is the extension point: install the binary or driver here,
# then name it via CLEANERS_TOOLS / CLEANERS_EXTENSIONS (and CLEANERS_TOOL_KEY_ENV if it needs
# a credential). See the README, "Giving the cleaner better tools".

FROM node:24-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash ca-certificates git jq ripgrep coreutils python3 python3-venv \
 && rm -rf /var/lib/apt/lists/*

# Pinned, not floating: a cleaner that changes personality because npm published cannot be
# compared across weeks, and phase 0's numbers would stop meaning anything.
RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent@1.4.0

# The build context is the repository root, because `common/` is copied in beside `cleaners/`.
COPY cleaners/report_finding.ts /opt/cleaners/report_finding.ts
COPY cleaners/defaults.env /opt/cleaners/defaults.env
COPY cleaners/prompt.md /opt/cleaners/prompt.md
COPY common/models/ /opt/cleaners/models/
COPY cleaners/cleaner.sh /opt/cleaners/cleaner.sh
COPY cleaners/entrypoint.sh /opt/cleaners/entrypoint.sh
COPY cleaners/post_findings.py /opt/cleaners/post_findings.py
COPY cleaners/plan.py /opt/cleaners/plan.py
# Shared with goby-tide: the filing machinery, the credential check, the run summary, the cost
# line, and the provider model files. One copy in the repository, one copy in each image.
COPY common/issues.py /opt/common/issues.py
COPY common/model_check.py common/summarize_run.py common/usage.py /opt/common/
RUN chmod +x /opt/cleaners/*.sh /opt/cleaners/*.py

# The one provider file a scan needs is copied into the agent's own dir at run time, so the
# image's copy stays read-only and a missing key fails loudly instead of half-working.
ENV PI_CODING_AGENT_DIR=/opt/cleaners \
    PI_OFFLINE=1 \
    PI_TELEMETRY=0 \
    PI_SKIP_VERSION_CHECK=1 \
    CLEANERS_WORK=/workspace

# The entrypoint runs as root so each scan can be dropped to `agent` with no environment
# at all; see entrypoint.sh. The agent never runs as root and never sees a credential.
RUN useradd --create-home --uid 10001 agent && mkdir -p /workspace /home/agent/.pi-agent

WORKDIR /workspace
CMD ["/opt/cleaners/entrypoint.sh"]
