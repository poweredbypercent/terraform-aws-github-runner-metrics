#!/usr/bin/env bats
# Tests for download.sh: a zip only lands once it verifies, one already on disk is verified again,
# and only JSON reaches stdout. curl and gh are stubbed: curl serves files from a fake release
# directory and counts its calls, gh records its arguments.
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
echo x >>"$RELEASE_DIR/../curl-calls"
out=""; url=""
while [ $# -gt 0 ]; do
  case "$1" in --output) out="$2"; shift 2 ;; http*) url="$1"; shift ;; *) shift ;; esac
done
src="$RELEASE_DIR/$(basename "$url")"
[ -f "$src" ] || exit 22
cp "$src" "$out"
EOF
  cat >"$WORK/bin/gh" <<'EOF'
#!/usr/bin/env bash
echo "$*" >"$RELEASE_DIR/../gh-args"
exit "${GH_EXIT:-0}"
EOF
  chmod +x "$WORK/bin/curl" "$WORK/bin/gh"
  export PATH="$WORK/bin:$PATH" RELEASE_DIR="$WORK/release"
  OUT="$WORK/out/lambda.zip"
}

teardown() {
  rm -rf "$WORK"
}

# download EXPECTED_SHA256 VERIFY
download() { bash "$SCRIPT" acme/metrics v1.2.3 "$OUT" "$1" "$2" </dev/null; }
curl_calls() { if [ -f "$WORK/curl-calls" ]; then wc -l <"$WORK/curl-calls" | tr -d ' '; else echo 0; fi; }

@test "downloads a zip that matches the pinned checksum, and prints only its path" {
  run --separate-stderr -0 download "$GOOD" false
  [ "$output" = "{\"path\": \"$OUT\"}" ]
  [ "$(cat "$OUT")" = "zip bytes" ]
}

@test "refuses to run without a trust anchor" {
  run -1 download "" false
  [[ "$output" == *"set sha256 or verify_attestation"* ]]
  [ "$(curl_calls)" = 0 ]
}

@test "refuses a zip that does not match the pinned checksum, and leaves nothing" {
  run -1 download "$(printf '0%.0s' $(seq 1 64))" false
  [[ "$output" == *"does not match the pinned"* ]]
  [ ! -e "$OUT" ]
}

@test "refuses a zip that does not match the release's own checksum file" {
  printf 'tampered' >"$WORK/release/terraform-aws-github-runner-metrics.zip"
  run -1 download "$GOOD" false
  [[ "$output" == *"does not match the release's checksum file"* ]]
  [ ! -e "$OUT" ]
}

@test "fails when the release has no such asset" {
  rm "$WORK/release/terraform-aws-github-runner-metrics.zip.sha256"
  run -22 download "$GOOD" false
  [ ! -e "$OUT" ]
}

@test "reuses a zip on disk that verifies, without downloading" {
  run -0 download "$GOOD" false
  calls="$(curl_calls)"
  run --separate-stderr -0 download "$GOOD" false
  [ "$output" = "{\"path\": \"$OUT\"}" ]
  [ "$(curl_calls)" = "$calls" ]
}

@test "replaces a zip on disk that no longer verifies" {
  run -0 download "$GOOD" false
  printf 'swapped' >"$OUT"
  run -0 download "$GOOD" false
  [ "$(cat "$OUT")" = "zip bytes" ]
}

@test "verifies the attestation against the release workflow, the tag and a hosted runner" {
  run -0 download "" true
  args="$(cat "$WORK/gh-args")"
  [[ "$args" == *"--repo acme/metrics"* ]]
  [[ "$args" == *"--signer-workflow acme/metrics/.github/workflows/release.yml"* ]]
  [[ "$args" == *"--source-ref refs/tags/v1.2.3"* ]]
  [[ "$args" == *"--deny-self-hosted-runners"* ]]
}

@test "refuses a zip whose attestation does not verify" {
  GH_EXIT=1 run -1 download "" true
  [ ! -e "$OUT" ]
}
