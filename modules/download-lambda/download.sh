#!/usr/bin/env bash
# Makes sure OUT holds the verified release zip, downloading it only when it does not, and prints
# {"path": OUT} for Terraform's external data source. Runs on every plan, so a zip already on disk
# (a cached or restored .build directory) is verified again rather than trusted.
#
# Arguments: REPOSITORY TAG OUT EXPECTED_SHA256 VERIFY_ATTESTATION(true|false)
# At least one of EXPECTED_SHA256 or VERIFY_ATTESTATION is the trust anchor; the release's own
# checksum file is checked too, but it comes from the same place as the zip.
# A zip only reaches OUT once it has verified; a failed check leaves nothing behind. Only the JSON
# goes to stdout.
set -euo pipefail

repository="$1" tag="$2" out="$3" expected="$4" verify="$5"
# The external data source writes its query to stdin; nothing in it is needed.
cat >/dev/null || true

if [ -z "${expected}" ] && [ "${verify}" != "true" ]; then
  echo "set sha256 or verify_attestation: without one, nothing anchors trust in the release" >&2
  exit 1
fi

asset="terraform-aws-github-runner-metrics.zip"
base="https://github.com/${repository}/releases/download/${tag}"

fetch() {
  curl --fail --silent --show-error --location --proto '=https' --retry 3 \
    --max-time 300 --max-filesize 104857600 --output "$2" "$1"
}

sha256_of() {
  if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

# Succeeds when the zip at $1 passes every configured check.
verified() {
  local zip="$1" actual
  actual="$(sha256_of "${zip}")"
  if [ -n "${expected}" ] && [ "${actual}" != "${expected}" ]; then
    echo "${asset} ${tag}: SHA-256 ${actual} does not match the pinned ${expected}" >&2
    return 1
  fi
  if [ "${verify}" = "true" ]; then
    gh attestation verify "${zip}" --repo "${repository}" \
      --signer-workflow "${repository}/.github/workflows/release.yml" \
      --source-ref "refs/tags/${tag}" \
      --deny-self-hosted-runners >&2 || return 1
  fi
}

if [ -f "${out}" ]; then
  if verified "${out}"; then
    printf '{"path": "%s"}\n' "${out}"
    exit 0
  fi
  echo "${out} does not verify; downloading it again" >&2
  rm "${out}"
fi

work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT

fetch "${base}/${asset}" "${work}/${asset}"
fetch "${base}/${asset}.sha256" "${work}/${asset}.sha256"

actual="$(sha256_of "${work}/${asset}")"
published="$(cut -d' ' -f1 <"${work}/${asset}.sha256")"
if [ "${actual}" != "${published}" ]; then
  echo "${asset} ${tag}: SHA-256 ${actual} does not match the release's checksum file (${published})" >&2
  exit 1
fi
verified "${work}/${asset}"

mkdir -p "$(dirname "${out}")"
mv "${work}/${asset}" "${out}"
printf '{"path": "%s"}\n' "${out}"
