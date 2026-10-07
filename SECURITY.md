# Security

## Reporting a vulnerability

Report it privately through GitHub's [private vulnerability reporting](../../security/advisories/new)
for this repository, not in a public issue. We aim to acknowledge reports within three working days
and to fix confirmed issues within thirty.

The latest minor release of the latest major version receives fixes.

## Scope

The Lambda code, the Terraform modules, and the release pipeline that builds and publishes the zip.

## Design notes

- The GitHub App this module recommends is read-only (organisation "Self-hosted runners: Read",
  repository "Administration: Read"), and each installation token is narrowed to the one
  permission it needs. Its private key lives in Secrets Manager and never enters Terraform state.
- The function's IAM policy is generated from the features in use; read-only except for writing its
  own logs and, when configured, assuming a Prometheus writer role.
- The organisations and repositories queried come from runner instance tags, which a job may be
  able to set on its own instance: they are validated and encoded before use, and only those in
  the required `owners` allowlist are queried.
- Credentials are sent over https only, and never in a URL; secret ARNs must name one secret.
- Logs carry error messages and HTTP statuses, never request headers, tokens or secrets. A
  remote-write response body is logged only for a 400, which explains rejected samples.
- Releases are built in CI from a tagged commit on `main`, approved through a protected
  environment, are reproducible, and carry a SHA-256 and a build-provenance attestation (see the
  README for the full `gh attestation verify` command). `modules/download-lambda` requires one of
  them as a trust anchor and verifies the zip again on every plan.
