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
- Logs carry error messages and HTTP statuses, never request headers, tokens or secrets.
- Releases are built in CI from a tagged commit on `main`, are reproducible, and carry a SHA-256 and
  a build-provenance attestation: `gh attestation verify <zip> --repo poweredbypercent/terraform-aws-github-runner-metrics`.
