# Test environment for @mcpaql/pi-bridge.
#
# Provides a host-isolated runtime for `npm test` so local dev doesn't
# accumulate spawned children, port bindings, or filesystem leakage
# between iterations.
#
# Variations: pass NODE_VERSION as a build arg to test against different
# Node majors. Default 20 matches package.json's engines.node field.
#
# Usage (via npm scripts):
#   npm run test:docker         build + run the suite under default Node
#   npm run test:docker:shell   drop into the container for debugging
#   npm run test:matrix         run against Node 20, 22, and 24
#
# CI keeps using ubuntu-latest runners directly; this image exists for
# local iteration. If CI/local parity ever matters, rewire ci.yml to use
# this image instead of installing Node directly.

ARG NODE_VERSION=20
FROM node:${NODE_VERSION}-bookworm-slim

WORKDIR /app

# Install deps first so the layer caches across source-only changes.
COPY package.json package-lock.json ./
RUN npm ci

# Source last.
COPY . .

CMD ["npm", "test"]
