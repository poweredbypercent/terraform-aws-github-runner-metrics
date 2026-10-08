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
  own logs and, when configured, assuming a Prometheus writer role. It names exactly the queues,
  secrets, parameters, keys and role in the configuration, and the module refuses wildcards in
  any of them, including the queues and parameters it reads from a runner stack's outputs, before
  the policy is written. The EC2 and CloudWatch reads, which take no resource, are limited to the
  module's region.
- The organisations and repositories queried come from runner instance tags, which a job may be
  able to set on its own instance: they are validated and encoded before use, and only those in
  the required `owners` allowlist are queried.
- Credentials are sent over https only, and never in a URL; secret ARNs must name one secret.
  Remote-write redirects are not followed, so signed headers and samples only go to the configured
  endpoint. Plain `headers` named like a credential are refused: they would be visible in the
  function's configuration.
- The runner stacks' outputs are trusted configuration, like the module's own inputs: they name
  the queues and parameters the role may read, and a stack's GitHub Enterprise Server URL is where
  the App's tokens are sent. `github_enterprise_server_url` overrides every stack's, so set it to
  pin that destination when the stacks are maintained by others.
- Logs carry error messages and HTTP statuses, never request headers, tokens or secrets. A
  remote-write response body is logged only for a 400, which explains rejected samples. Answers
  from GitHub are checked where they arrive and never quoted in errors.
- Releases are built in CI from a tagged commit on `main` and are reproducible. Once a reviewer
  approves the protected `release` environment, the published zip is checked against the hash the
  build computed, attested, and published with its SHA-256 (see the README for the full
  `gh attestation verify` command). `modules/download-lambda` requires the SHA-256 pin or the
  attestation as a trust anchor and verifies the zip again on every plan. The pinned SHA-256 is the
  stronger anchor: the attestation names the tag, so it relies on the repository's tag ruleset as
  well. Drafts, which anyone with write access can edit, are not trusted: every draft for the tag
  is deleted, and the release published is the one the run created, by its id, after its assets'
  digests are checked against the build's.
- The S3 deployment path requires the object version, so the deployed code is the object that was
  verified. The module's own code, `download.sh` included, comes from the module source's `?ref=`;
  pin it to a commit to rely on nothing else.
