# goby-cleaners scanner image.
#
# One job per container: clone the pushed sha, scan every component it touched, file the
# issues, exit. Started by the post-merge workflow as a container job (see
# .github/workflows/cleaners-post-merge.yml), or by `docker run` locally.
#
# `FROM goby-base`, like the reviewer and the tide: pi, git, ripgrep, python3, the uid drop,
# the key proxy and the secret conventions are what all three need, and copying them was how
# this file drifted from the base line for line. What is left here is what a cleaner is.
#
# Deliberately NOT installed: a GitHub CLI, any cloud SDK, any agent framework beyond pi.
# The container's credentials are the model key and one repo-scoped installation token, both
# passed in at run time — and neither reaches the agent's shell.
#
# **Adding a tool.** This image is the extension point: install the binary or driver here,
# then name it via CLEANERS_TOOLS / CLEANERS_EXTENSIONS (and CLEANERS_TOOL_KEY_ENV if it needs
# a credential). See the README, "Giving the cleaner better tools".
ARG BASE_IMAGE=goby-base

FROM ${BASE_IMAGE}

# The build context is the repository root, because `common/` is copied in beside `cleaners/`.
COPY cleaners/report_finding.ts /opt/cleaners/report_finding.ts
COPY cleaners/defaults.env /opt/cleaners/defaults.env
COPY cleaners/prompt.md /opt/cleaners/prompt.md
# Root-only, and used only by model_check.py: which provider has a key decides which model to
# scan with. The agent never reads these files — it gets `/opt/goby/models/models.json`, which
# points at the proxy.
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

# The agent's models file is the base image's sanitized one, copied into the agent's own dir at
# run time: loopback and a dummy key, so the image's copy can stay read-only and a missing key
# fails loudly (in `model_check.py`) instead of half-working.
ENV PI_CODING_AGENT_DIR=/opt/cleaners \
    CLEANERS_WORK=/workspace

# `goby-base` hands `/workspace` to the agent. A cleaner needs the opposite: every run directory
# is sealed by root, and a scan that inherits the tree must not be able to rewrite a sibling's
# findings before they are filed. The writable parts are handed back one at a time by the
# entrypoint. See INVARIANTS.md, "nothing an agent runs may reach a sibling's findings".
RUN chown -R root:root /workspace \
 && mkdir -p /home/agent/.pi-agent

WORKDIR /workspace
CMD ["/opt/cleaners/entrypoint.sh"]
