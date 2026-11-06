# goby-tide image: the scheduled sweep.
#
# `FROM goby-base`, like the reviewer: pi, git, ripgrep, python3 and the uid drop are exactly what
# this product needs, and copying them was how the cleaner grew a second copy of the same apt
# line. The harness is Python plus one pi extension, so there is no build stage and no bun.
#
# Deliberately NOT installed: a language toolchain for the swept repository, a GitHub CLI, any
# cloud SDK. A repository whose tests need bun, Go or Rust installs them in the sandbox (there is
# no egress filtering), or brings its own image — the workflow takes a digest.
ARG BASE_IMAGE=goby-base

FROM ${BASE_IMAGE}

# Shared with goby-cleaners: the filing machinery, the credential check, the run summary, the
# cost line, and the provider model files. One copy in the repository, one copy in each image.
COPY common/issues.py /opt/common/issues.py
COPY common/model_check.py common/summarize_run.py common/usage.py /opt/common/
COPY common/models/ /opt/tide/models/

COPY tide/detect.py tide/collect.py tide/post_issues.py /opt/tide/
COPY tide/tide.sh tide/entrypoint.sh /opt/tide/
COPY tide/defaults.env tide/prompt.md tide/report_proposal.ts /opt/tide/
RUN chmod 0755 /opt/tide/*.sh /opt/tide/*.py

# The agent's own pi config lives here; the image copy stays read-only, so a missing key fails
# loudly instead of half-working from a baked file.
ENV PI_CODING_AGENT_DIR=/opt/tide \
    PI_OFFLINE=1 \
    PI_TELEMETRY=0 \
    PI_SKIP_VERSION_CHECK=1 \
    TIDE_WORK=/workspace

# The entrypoint runs as root so each scan can be dropped to `agent` with no environment at all;
# see entrypoint.sh. The agent never runs as root and never sees a credential. The `agent` user
# (uid 10001) and a `/workspace` it owns come from goby-base.
WORKDIR /workspace
CMD ["/opt/tide/entrypoint.sh"]
