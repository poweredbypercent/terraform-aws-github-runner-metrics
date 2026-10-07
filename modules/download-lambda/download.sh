#!/usr/bin/env bash
# Downloads a release zip and verifies it before Terraform uses it.
#
# Inputs (environment): REPOSITORY, TAG, OUT, EXPECTED_SHA256 (optional), VERIFY (true|false).
# The zip only reaches OUT once it has verified; a failed check leaves nothing behind.
set -euo pipefail

asset="terraform-aws-github-runner-metrics.zip"
base="https://github.com/${REPOSITORY}/releases/download/${TAG}"
work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT

fetch() { curl --fail --silent --show-error --location --proto '=https' --retry 3 --output "$2" "$1"; }

sha256_of() {
  if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

fetch "${base}/${asset}" "${work}/${asset}"
fetch "${base}/${asset}.sha256" "${work}/${asset}.sha256"

actual="$(sha256_of "${work}/${asset}")"
published="$(cut -d' ' -f1 <"${work}/${asset}.sha256")"
if [ "${actual}" != "${published}" ]; then
  echo "${asset} ${TAG}: SHA-256 ${actual} does not match the release's checksum file (${published})" >&2
  exit 1
fi
if [ -n "${EXPECTED_SHA256}" ] && [ "${actual}" != "${EXPECTED_SHA256}" ]; then
  echo "${asset} ${TAG}: SHA-256 ${actual} does not match the pinned ${EXPECTED_SHA256}" >&2
  exit 1
fi

if [ "${VERIFY}" = "true" ]; then
  gh attestation verify "${work}/${asset}" --repo "${REPOSITORY}" >&2
fi

mkdir -p "$(dirname "${OUT}")"
mv "${work}/${asset}" "${OUT}"
