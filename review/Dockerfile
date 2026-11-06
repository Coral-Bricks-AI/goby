# The reviewer image: goby-base plus the harness, and nothing the reviewer is expected to fetch
# for itself.
#
# Build context is the repository root, because the publisher is TypeScript that imports the same
# contract, receipt and gate code the rest of goby uses — one implementation of what may be
# posted, not a second one in the image.
# `goby-base` resolves to the image built from base/ on the docker daemon. Overridable so a
# registry-published base can be pinned instead.
ARG BASE_IMAGE=goby-base

# The harness is built here and only its output is shipped. bun is a build tool: shipping it would
# add ~50 MB to every pull, for a repository whose tests may never touch it. A repo whose tests
# are bun's installs bun in the sandbox, like any other toolchain the base does not carry.
FROM oven/bun:1.4.4 AS harness
WORKDIR /build
COPY package.json bun.lock tsconfig.json ./
RUN bun install --frozen-lockfile --ignore-scripts
COPY src/ ./src/
RUN bun build src/reviewRun.ts --target=node --outfile=/build/reviewRun.js

FROM ${BASE_IMAGE}

COPY --from=harness /build/reviewRun.js /opt/goby/reviewRun.js

COPY review/entrypoint.sh /opt/goby/entrypoint.sh
COPY review/defaults.env /opt/goby/defaults.env
COPY review/prompt.md /opt/goby/prompt.md
COPY review/report_findings.ts /opt/goby/report_findings.ts
RUN chmod 0755 /opt/goby/entrypoint.sh

# The agent's own pi config lives here; the image copy stays read-only, so a missing key fails
# loudly instead of half-working from a baked file.
ENV GOBY_HOME=/opt/goby \
    PI_OFFLINE=1 \
    PI_TELEMETRY=0 \
    PI_SKIP_VERSION_CHECK=1

WORKDIR /workspace
ENTRYPOINT ["/opt/goby/entrypoint.sh"]
