# goby-wake image: the reader, and nothing else.
#
# It talks to one thing (the GitHub API), on behalf of one repository, and prints JSON. So unlike
# the reviewer and the cleaners it does not build on `goby-base`: it needs no shell toolchain, no
# git, no `pi`, no key proxy, and no unprivileged user to drop to. A shell in an image that can
# write to your pull requests is a larger surface than a reader that only reads.
#
# Build context is the repository root, because the bundle imports the same marker grammar the
# reviewer writes: one implementation of what a record looks like, in both directions.
ARG NODE_IMAGE=node:22-slim

FROM oven/bun:1.4.4 AS build
WORKDIR /build
COPY package.json bun.lock tsconfig.json ./
RUN bun install --frozen-lockfile --ignore-scripts
COPY src/ ./src/
RUN bun build src/wakeCli.ts --target=node --outfile=/build/wake.js

FROM ${NODE_IMAGE}

# A reader that needs a network is still a reader: no package manager, no shell tools, no cache to
# reach through. `--production` installs nothing here — the bundle is self-contained — so the
# only thing in the image is the program and its version.
WORKDIR /opt/wake
COPY --from=build /build/wake.js /opt/wake/wake.js
# Read beside the bundle at run time (`src/wake/version.ts`), so every record this prints names the
# goby release that printed it.
COPY common/VERSION /opt/wake/VERSION

# The one credential, passed in by the workflow: the repository's own token, read-only.
ENV GOBY_WAKE_DAYS=30 \
    NODE_ENV=production

USER node
ENTRYPOINT ["node", "/opt/wake/wake.js"]
