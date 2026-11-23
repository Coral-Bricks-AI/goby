# The code-kind image: goby-base plus the harness that opens a branch, a commit and a pull
# request for a task — nothing the agent is expected to fetch for itself.
#
# Mirrors review/Dockerfile: build context is the repository root, because the publisher is
# TypeScript sharing the same GitHub client the rest of goby uses, not a second implementation of
# it in the image.
ARG BASE_IMAGE=goby-base

# Build tool only; not shipped, like review/Dockerfile.
FROM oven/bun:1.4.4 AS harness
WORKDIR /build
COPY package.json bun.lock tsconfig.json ./
RUN bun install --frozen-lockfile --ignore-scripts
COPY src/ ./src/
RUN bun build src/codeRun.ts --target=node --outfile=/build/codeRun.js
RUN bun build src/progressCli.ts --target=node --outfile=/build/progress.js

FROM ${BASE_IMAGE}

COPY --from=harness /build/codeRun.js /opt/goby/codeRun.js
COPY --from=harness /build/progress.js /opt/goby/progress.js

COPY code/entrypoint.sh /opt/goby/entrypoint.sh
COPY code/defaults.env /opt/goby/defaults.env
COPY code/prompt.md /opt/goby/prompt.md
COPY code/report_done.ts /opt/goby/report_done.ts
RUN chmod 0755 /opt/goby/entrypoint.sh

# Same shared run-record tooling the reviewer ships, from the same source so the wording and the
# arithmetic stay in one file.
COPY common/summarize_run.py common/timing.py common/usage.py common/runrecord.py /opt/common/

ENV GOBY_HOME=/opt/goby \
    PI_OFFLINE=1 \
    PI_TELEMETRY=0 \
    PI_SKIP_VERSION_CHECK=1

WORKDIR /workspace
ENTRYPOINT ["/opt/goby/entrypoint.sh"]
