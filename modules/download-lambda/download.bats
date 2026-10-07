#!/usr/bin/env bats
# Tests for download.sh: a zip only lands once it verifies. curl is stubbed to serve files from a
# fake release directory.
bats_require_minimum_version 1.5.0

setup() {
  SCRIPT="$(cd "$(dirname "$BATS_TEST_FILENAME")" && pwd)/download.sh"
  WORK="$(mktemp -d)"
  mkdir -p "$WORK/bin" "$WORK/release"
  printf 'zip bytes' >"$WORK/release/terraform-aws-github-runner-metrics.zip"
  GOOD="$(cd "$WORK/release" && (sha256sum terraform-aws-github-runner-metrics.zip 2>/dev/null || shasum -a 256 terraform-aws-github-runner-metrics.zip) | cut -d' ' -f1)"
  printf '%s  terraform-aws-github-runner-metrics.zip\n' "$GOOD" >"$WORK/release/terraform-aws-github-runner-metrics.zip.sha256"
  cat >"$WORK/bin/curl" <<'EOF'
#!/usr/bin/env bash
out=""; url=""
while [ $# -gt 0 ]; do
  case "$1" in --output) out="$2"; shift 2 ;; http*) url="$1"; shift ;; *) shift ;; esac
done
src="$RELEASE_DIR/$(basename "$url")"
[ -f "$src" ] || exit 22
cp "$src" "$out"
EOF
  chmod +x "$WORK/bin/curl"
  export PATH="$WORK/bin:$PATH" RELEASE_DIR="$WORK/release"
  export REPOSITORY=acme/metrics TAG=v1.2.3 OUT="$WORK/out/lambda.zip" EXPECTED_SHA256="" VERIFY=false
}

teardown() {
  rm -rf "$WORK"
}

@test "downloads a zip that matches the release checksum" {
  run -0 bash "$SCRIPT"
  [ "$(cat "$OUT")" = "zip bytes" ]
}

@test "accepts a matching pinned checksum" {
  EXPECTED_SHA256="$GOOD" run -0 bash "$SCRIPT"
  [ -f "$OUT" ]
}

@test "refuses a zip that does not match the pinned checksum, and leaves nothing" {
  EXPECTED_SHA256="$(printf '0%.0s' $(seq 1 64))" run -1 bash "$SCRIPT"
  [[ "$output" == *"does not match the pinned"* ]]
  [ ! -e "$OUT" ]
}

@test "refuses a zip that does not match the release's own checksum file" {
  printf 'tampered' >"$WORK/release/terraform-aws-github-runner-metrics.zip"
  run -1 bash "$SCRIPT"
  [[ "$output" == *"does not match the release's checksum file"* ]]
  [ ! -e "$OUT" ]
}

@test "fails when the release has no such asset" {
  rm "$WORK/release/terraform-aws-github-runner-metrics.zip.sha256"
  run -22 bash "$SCRIPT"
  [ ! -e "$OUT" ]
}
