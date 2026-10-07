# Multi-runner stack to Amazon Managed Service for Prometheus

A runner stack built with `modules/multi-runner` of terraform-aws-github-runner v7 (AWS provider
6.x), sampled by this module and pushed to an AMP workspace in another account.

- The runner configs - environments, caps, queues - are read from `module.runners.runners_map`.
- The Lambda zip is an exact release, fetched and verified by `modules/download-lambda` against the
  SHA-256 in its release notes (`metrics_release_sha256`).
- Remote write signs with SigV4 through `prometheus_writer_role_arn`, a role in the workspace's
  account with `aps:RemoteWrite` that trusts the `lambda_role_arn` output. Apply this first: the
  trust policy cannot name a role that does not exist yet.
- GitHub is read through a dedicated read-only App, whose credentials go in the secret the module
  creates (`github_app_secret_name` output; see the main README). Only `github_owners` are queried.

```sh
terraform init
terraform apply
terraform output runner_configs   # what the module read from the stack
```
