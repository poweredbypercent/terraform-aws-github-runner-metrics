# Root-module stack to Grafana Cloud

A runner stack built with the root module of terraform-aws-github-runner v6 (AWS provider 5.x), one
runner config, sampled by this module and pushed to Grafana Cloud.

- The runner config and its queues are read from `module.runner.runners` and `module.runner.queues`.
- The Lambda zip is copied by your pipeline to your own bucket (`lambda_bucket`), verified there,
  and deployed by object version (`lambda_object_version`), for pipelines that cannot download
  during a plan.
- Remote write uses basic auth from a secret you manage: `{"username": "<instance id>",
  "password": "<access-policy token>"}` (`grafana_cloud_credentials_secret_arn`).
- GitHub is read through a dedicated read-only App whose credentials are in a secret you manage
  (`github_app_metrics_secret_arn`). Only `github_owners` are queried.

The runner module hashes its own Lambda zips when it plans, so download them first, into
`runner_lambda_zips_dir` (its `examples/lambdas-download` does the same):

```sh
mkdir -p lambdas
for name in webhook runners runner-binaries-syncer; do
  curl -fL -o "lambdas/${name}.zip" \
    "https://github.com/github-aws-runners/terraform-aws-github-runner/releases/download/v6.5.9/${name}.zip"
done
terraform init
terraform apply
terraform output runner_configs   # what the module read from the stack
```
