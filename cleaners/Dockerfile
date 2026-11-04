# coral-cleaners hunter task image.
#
# One job per container: clone the pushed sha, hunt every component it touched, file the
# issues, exit. Started by the post-merge workflow as a container job (see
# .github/workflows/cleaners-post-merge.yml), or by `docker run` locally.
#
# Deliberately NOT installed: a GitHub CLI, any cloud SDK, any agent framework beyond pi.
# The container's credentials are the model key and one repo-scoped installation token, both
# passed in at run time — and neither reaches the agent's shell.
#
# **Adding a tool.** This image is the extension point: install the binary or driver here,
# then name it via CLEANERS_TOOLS / CLEANERS_EXTENSIONS (and CLEANERS_TOOL_KEY_ENV if it needs
# a credential). See the README, "Giving the hunter better tools".

FROM node:24-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash ca-certificates git git-lfs jq ripgrep coreutils python3 python3-venv \
 && rm -rf /var/lib/apt/lists/*

# Pinned, not floating: a hunter that changes personality because npm published cannot be
# compared across weeks, and phase 0's numbers would stop meaning anything.
RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent@1.4.0

COPY report_finding.ts /opt/cleaners/report_finding.ts
COPY prompt.md /opt/cleaners/prompt.md
COPY models/ /opt/cleaners/models/
COPY hunt.sh /opt/cleaners/hunt.sh
COPY entrypoint.sh /opt/cleaners/entrypoint.sh
COPY post_findings.py /opt/cleaners/post_findings.py
COPY model_check.py /opt/cleaners/model_check.py
COPY plan.py /opt/cleaners/plan.py
COPY summarize_run.py /opt/cleaners/summarize_run.py
COPY usage.py /opt/cleaners/usage.py
RUN chmod +x /opt/cleaners/*.sh /opt/cleaners/*.py

# The one provider file a hunt needs is copied into the agent's own dir at run time, so the
# image's copy stays read-only and a missing key fails loudly instead of half-working.
ENV PI_CODING_AGENT_DIR=/opt/cleaners \
    PI_OFFLINE=1 \
    PI_TELEMETRY=0 \
    PI_SKIP_VERSION_CHECK=1 \
    CLEANERS_WORK=/workspace

# The entrypoint runs as root so each hunt can be dropped to `hunter` with no environment
# at all; see entrypoint.sh. The agent never runs as root and never sees a credential.
RUN useradd --create-home --uid 10001 hunter && mkdir -p /workspace /home/hunter/.pi-agent

WORKDIR /workspace
CMD ["/opt/cleaners/entrypoint.sh"]
