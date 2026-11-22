# Hourglass keyper daemon, for an always-on host (Railway, any container platform).
# Build from the repository root:  docker build -f apps/keyper/Dockerfile .
#
# No secret is baked in. The container reads two environment variables at start:
#   KEYPER_MNEMONIC      the keyper account's recovery phrase
#   KEYPER_CHAIN_SECRET  the seed-chain secret as JSON {top, maxRound, genesis, roundSeconds}
# and writes only public state (state.json, releases.jsonl) to KEYPER_HOME, best mounted as a volume.
FROM node:20.20.0-slim

ENV KEYPER_HOME=/data
WORKDIR /app

# The crypto library first: the keyper depends on it as file:../../packages/hourglass.
COPY packages/hourglass/package.json packages/hourglass/package-lock.json packages/hourglass/
RUN cd packages/hourglass && npm ci --no-audit --no-fund
COPY packages/hourglass packages/hourglass

COPY apps/keyper/package.json apps/keyper/package-lock.json apps/keyper/
RUN cd apps/keyper && npm ci --include=dev --no-audit --no-fund   # tsx runs the daemon
COPY apps/keyper apps/keyper

WORKDIR /app/apps/keyper
# Runs as root: Railway mounts volumes owned by root, and the daemon must write its state there.
CMD ["npx", "tsx", "src/cli.ts", "run"]
