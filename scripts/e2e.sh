#!/usr/bin/env bash
# Runs the e2e tests against a throwaway Prometheus with its remote-write receiver enabled.
# The same script runs locally and in CI, so the two cannot drift.
#
#   scripts/e2e.sh
set -euo pipefail

# Pinned by digest; update it with the tag beside it.
image="prom/prometheus:v3.7.2@sha256:23031bfe0e74a13004252caaa74eccd0d62b6c6e7a04711d5b8bf5b7e113adc7"
name="runner-metrics-e2e-$$"

# Loopback only, on a port Docker picks: the receiver takes unauthenticated writes, and two runs
# side by side must not collide.
docker run --detach --rm --name "${name}" --publish "127.0.0.1::9090" "${image}" \
  --config.file=/etc/prometheus/prometheus.yml --web.enable-remote-write-receiver >/dev/null
trap 'docker stop "${name}" >/dev/null 2>&1 || true' EXIT
port="$(docker port "${name}" 9090/tcp | head -n 1)"
port="${port##*:}"

for _ in $(seq 1 60); do
  if curl --silent --fail --noproxy '*' "http://localhost:${port}/-/ready" >/dev/null; then break; fi
  sleep 1
done
curl --silent --fail --noproxy '*' "http://localhost:${port}/-/ready" >/dev/null

E2E_PROMETHEUS_URL="http://localhost:${port}" NO_PROXY="localhost,127.0.0.1" no_proxy="localhost,127.0.0.1" \
  npm run --silent test:e2e
