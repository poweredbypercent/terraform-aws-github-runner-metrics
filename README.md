# terraform-aws-github-runner-metrics

Prometheus metrics for self-hosted GitHub Actions runners built with
[terraform-aws-github-runner](https://github.com/github-aws-runners/terraform-aws-github-runner):
how many jobs are waiting for a runner and at which stage, how long the oldest has waited, how
many runners are booting, busy and idle, on which instance types, and how close each runner config
is to its cap.

A small Lambda samples the runner stack every minute and pushes gauges to any Prometheus
remote-write endpoint: Amazon Managed Service for Prometheus, Grafana Cloud, Mimir, or Prometheus
itself. Add it beside a runner stack by passing the stack's outputs; nothing has to be copied by
hand.

## What it measures

Where a job can be on its way to a runner, and how each stage shows:

| Stage | Seen through | Metric |
| --- | --- | --- |
| Waiting for the scale-up Lambda, or backing off at the runner cap or a capacity error | SQS | `github_aws_runners_scale_up_queue_messages{queue="main"}` |
| Failed scale-up repeatedly; will not get a runner | SQS | `github_aws_runners_scale_up_queue_messages{queue="dead_letter"}` |
| How long the oldest job has waited | CloudWatch | `github_aws_runners_scale_up_queue_oldest_message_age_seconds` |
| Instance launched, runner not online yet | EC2 joined to GitHub by instance id | `github_aws_runners_booting_runners` |
| Registered: running a job, idle (a warm pool), offline | GitHub | `github_aws_runners_{busy,idle,offline,registered}_runners` |

Plus runner instances by type, purchase option and state, orphaned instances, each runner config's
cap, and the sampler's own health. Every metric, its labels and its meaning:
[docs/metrics.md](docs/metrics.md).

Series are labelled `environment` (the stack's `ghr:environment`) and `runner_config`, plus any
constant labels you set. When a source cannot be read, its series are left out rather than reported
as zero, and `github_aws_runners_source_up{source}` says which failed.

## How it works

```
EventBridge (every minute)
  └─ Lambda ──┬─ SQS            scale-up and dead-letter queue depth
              ├─ CloudWatch     oldest-message age
              ├─ EC2            runner instances (ghr:* tags)
              ├─ GitHub API     registered runners, as a read-only GitHub App
              └─ remote_write ──▶ Prometheus
```

The runner configs - their environment, cap, runner name prefix, queues and GitHub Enterprise Server
URL - are read from each runner config's scale-up Lambda in the stack's outputs, for both the root
module and `modules/multi-runner`. The organisations and repositories to ask GitHub about come from
the instances' `ghr:Type` and `ghr:Owner` tags, limited to the ones you allow in
`github_app.owners`; organisation and repository runners both work.

A configuration the Lambda could not run with - no runner configs, a runner config without an
environment, a name or environment given twice, an invalid label - fails the plan (or the apply,
for values only known then) rather than deploying a function that fails every minute.

## Usage

```hcl
module "metrics_lambda" {
  source      = "github.com/poweredbypercent/terraform-aws-github-runner-metrics//modules/download-lambda?ref=v0.1.0"
  release_tag = "v0.1.0"
  sha256      = "<from the release notes>"
}

module "runner_metrics" {
  source = "github.com/poweredbypercent/terraform-aws-github-runner-metrics?ref=v0.1.0"

  # modules/multi-runner:
  runner_stacks = [{ multi_runner = module.runners.runners_map }]
  # or the root module, named (it is the runner_config label):
  # runner_stacks = [{ name = "ci", runners = module.runner.runners, queues = module.runner.queues }]

  remote_write = {
    url  = "https://aps-workspaces.eu-west-1.amazonaws.com/workspaces/ws-.../api/v1/remote_write"
    auth = { sigv4 = { role_arn = "arn:aws:iam::<monitoring account>:role/prometheus-writer" } }
  }

  lambda_zip = {
    path             = module.metrics_lambda.path
    source_code_hash = module.metrics_lambda.source_code_hash
  }

  # The organisations (or "owner/repo") the runners register in: see GitHub access.
  github_app = { owners = ["<your organisation>"] }

  labels = { cluster = "ci" }
}
```

Full examples: [multi-runner with AMP](examples/multi-runner-amp) and
[the root module with Grafana Cloud](examples/single-runner-grafana-cloud). Check what the module
read from your stack with `terraform output runner_configs`.

### Getting the Lambda code

Each release publishes `terraform-aws-github-runner-metrics.zip`, its SHA-256 and a build
provenance attestation. Either:

- use `modules/download-lambda`, which downloads an exact release and refuses it unless it matches
  the SHA-256 you pin, its attestation (`verify_attestation = true`), or both - one is required -
  and verifies the zip on disk again on every plan; or
- copy the zip to your own S3 bucket and pass `lambda_zip = { s3 = { bucket, key, object_version } }`;
  the version is required, so exactly the object you verified is deployed.

The SHA-256 pin covers the zip. The module's own code, `download.sh` included, comes from the
`?ref=` you give the module source and runs where Terraform plans: pin it to the commit the tag
points at (`?ref=<commit SHA>`) if you do not want to rely on tags being immutable.

Verify a release by hand with `sha256sum -c` and:

```sh
gh attestation verify terraform-aws-github-runner-metrics.zip \
  --repo poweredbypercent/terraform-aws-github-runner-metrics \
  --signer-workflow poweredbypercent/terraform-aws-github-runner-metrics/.github/workflows/release.yml \
  --source-ref refs/tags/<vX.Y.Z> --deny-self-hosted-runners
```

Releases are exact `vX.Y.Z` tags only; there are no floating `vX` tags to pin by mistake.

### GitHub access

Busy, idle, offline and booting runners come from the GitHub API, read as a GitHub App. Create a
dedicated, read-only one:

1. In your organisation's settings, create a GitHub App with no webhook and only these permissions:
   - Organization: **Self-hosted runners: Read-only** (organisation runners)
   - Repository: **Administration: Read-only** (only for repository runners)
2. Install it on the organisation and generate a private key.
3. Put its id and key in the secret the module created (`github_app_secret_name` output):

   ```sh
   (umask 077 && jq -n --arg id "<app id>" --rawfile key app.private-key.pem '{app_id: $id, private_key: $key}' >github-app.json)
   aws secretsmanager put-secret-value --secret-id <github_app_secret_name> --secret-string file://github-app.json
   rm github-app.json
   ```

The Lambda picks it up at the next sample (a later change to it, within ten minutes). Until then
it reports everything except the GitHub series. The private key never passes through Terraform or
its state. Each installation token is narrowed to the one permission listing runners needs.

`github_app.owners` is required: the organisations (or `owner/repo` targets) your runners register
in. Only those are queried, whatever the instances' `ghr:Owner` tags say, so a job that can tag its
own instance cannot point the App at another organisation it is installed on.

Other options (`github_app.source`): a secret you manage (`existing_secret`), the runner module's
own App from its SSM parameters (`runner_ssm` - it works, but that App can register runners, so it
is more access than this needs), or no GitHub at all (`disabled`). GitHub Enterprise Server and
GHE.com are followed from the runner stack's `GHES_URL`, or set `github_enterprise_server_url`.

### Remote-write targets

| Target | `remote_write.auth` |
| --- | --- |
| Amazon Managed Service for Prometheus | `sigv4 = { role_arn = "<writer role in the workspace's account>" }`, or `sigv4 = {}` with `aps:RemoteWrite` granted through `additional_policy_json` |
| Grafana Cloud | `basic = { secret_arn = "<secret with {\"username\": \"<instance id>\", \"password\": \"<token>\"}>" }` |
| Mimir, or anything behind a proxy | `bearer = { secret_arn = "..." }` or `basic`; `headers = { "X-Scope-OrgID" = "<tenant>" }` |
| Prometheus with `--web.enable-remote-write-receiver` | none |

For AMP in another account, the writer role trusts the Lambda's role (`lambda_role_arn` output):

```json
{
  "Effect": "Allow",
  "Principal": { "AWS": "<lambda_role_arn>" },
  "Action": "sts:AssumeRole"
}
```

Apply this module first: a trust policy cannot name a role that does not exist yet.

Pushes use remote write 1.0. A rejected push (4xx) is not retried - the next sample is - and the
function is not retried by EventBridge either, so samples always arrive in order. Redirects are not
followed: `remote_write.url` must be the endpoint itself.

## Useful queries

```promql
# Jobs waiting for a runner, by runner config: still queued, plus launched but not online yet.
# Booting is left out whenever GitHub is unavailable; `or` falls back to the queue alone.
sum by (runner_config) (github_aws_runners_scale_up_queue_messages{queue="main"})
  + sum by (runner_config) (github_aws_runners_booting_runners)
  or sum by (runner_config) (github_aws_runners_scale_up_queue_messages{queue="main"})

# Jobs stuck in a dead-letter queue: they will not get a runner
sum by (runner_config) (github_aws_runners_scale_up_queue_messages{queue="dead_letter"}) > 0

# The oldest waiting job, in seconds
max by (runner_config) (github_aws_runners_scale_up_queue_oldest_message_age_seconds{queue="main"})

# How full each runner config is. Orphans count against the cap like any instance; the runner
# module applies the cap per owner, so with repository runners in several repositories this is
# an average, and can pass 1.
(
  sum by (runner_config) (github_aws_runners_instances)
  + sum by (runner_config) (github_aws_runners_orphan_instances)
) / on (runner_config) github_aws_runners_capacity

# The sampler stopped: its series disappear, so alert on their absence.
absent_over_time(github_aws_runners_last_sample_timestamp_seconds[10m])
```

## Limitations

- One-minute resolution; the queue's oldest-message age lags about a minute behind (CloudWatch).
- A job GitHub has not yet delivered to the scale-up queue is not visible to AWS, and one whose
  scale-up hit an unexpected error is removed from the queue by the runner module.
- With `enable_job_queued_check` off, a job an idle pool runner took still launches an instance:
  booting counts instances, so it can overstate demand briefly.
- A registered runner is placed in a runner config through its instance. Once the instance has
  gone (an offline runner left behind by a spot interruption), it is placed only by a
  `runner_name_prefix` that belongs to one runner config; with the default empty prefix it is not
  counted in `offline_runners`.
- The GitHub App must be installed on every organisation or repository in `owners`; runners
  registering anywhere else are not counted, and booting is not reported for their runner config.
- Lambda environment variables are limited to 4 KB: around a dozen runner configs per module
  instance.
- One region per module instance: the queues must be in the region it is deployed in.
- `github_app.source = "runner_ssm"` reads one App; with the runner module's several-App rotation
  (v7.11), the first.

## Relation to terraform-aws-github-runner

The runner module's own `metrics` option publishes event metrics to CloudWatch (GitHub App rate
limit, job retries, spot interruptions). This module adds the fleet's state as Prometheus gauges;
the two complement each other. It covers the fleet monitoring asked for in
[github-aws-runners/terraform-aws-github-runner#2025](https://github.com/github-aws-runners/terraform-aws-github-runner/issues/2025).
For how it compares with exporters you may already run (YACE, GitHub runner exporters), and when
one of those is enough, see [docs/alternatives.md](docs/alternatives.md).

## Compatibility

| | Tested in CI |
| --- | --- |
| terraform-aws-github-runner | v6.5 on AWS provider 5.x, v7.11 on 6.x (both examples) |
| Terraform | validated on 1.5 and the latest release; `terraform test` on 1.7, 1.11 and the latest |
| AWS provider | 5.77 (the floor), the latest 5.x and the latest 6.x |
| Lambda runtime | Node.js 22 and 24 (`lambda_runtime`) |

## Development

```sh
nvm use && npm ci
npm run verify     # lint, types, unit tests, bats, reproducible zip
scripts/e2e.sh     # against a real Prometheus (Docker)
terraform init -backend=false && terraform test
```

See [CONTRIBUTING.md](CONTRIBUTING.md). Licensed under the [MIT licence](LICENSE).

## Reference

<!-- BEGIN_TF_DOCS -->
## Requirements

| Name | Version |
|------|---------|
| terraform | >= 1.5 |
| aws | >= 5.77 |

## Providers

| Name | Version |
|------|---------|
| aws | >= 5.77 |

## Modules

No modules.

## Resources

| Name | Type |
|------|------|
| [aws_cloudwatch_event_rule.schedule](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/cloudwatch_event_rule) | resource |
| [aws_cloudwatch_event_target.schedule](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/cloudwatch_event_target) | resource |
| [aws_cloudwatch_log_group.lambda](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/cloudwatch_log_group) | resource |
| [aws_iam_role.lambda](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/iam_role) | resource |
| [aws_iam_role_policy.additional](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/iam_role_policy) | resource |
| [aws_iam_role_policy.lambda](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/iam_role_policy) | resource |
| [aws_iam_role_policy_attachment.vpc](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/iam_role_policy_attachment) | resource |
| [aws_iam_role_policy_attachment.xray](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/iam_role_policy_attachment) | resource |
| [aws_lambda_function.this](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/lambda_function) | resource |
| [aws_lambda_function_event_invoke_config.this](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/lambda_function_event_invoke_config) | resource |
| [aws_lambda_permission.schedule](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/lambda_permission) | resource |
| [aws_secretsmanager_secret.github_app](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/secretsmanager_secret) | resource |
| [aws_caller_identity.current](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/data-sources/caller_identity) | data source |
| [aws_iam_policy_document.assume](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/data-sources/iam_policy_document) | data source |
| [aws_iam_policy_document.lambda](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/data-sources/iam_policy_document) | data source |
| [aws_partition.current](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/data-sources/partition) | data source |
| [aws_region.current](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/data-sources/region) | data source |

## Inputs

| Name | Description | Type | Default | Required |
|------|-------------|------|---------|:--------:|
| lambda\_zip | The function code: a release zip of this module's version. Either a local file (path; use<br/>modules/download-lambda to fetch and verify one) or an object in S3, pinned by its<br/>object\_version: the function runs with access to the GitHub App's key, so it deploys exactly the<br/>object you verified, and a new version is deployed by changing it. | <pre>object({<br/>    path             = optional(string)<br/>    source_code_hash = optional(string)<br/>    s3 = optional(object({<br/>      bucket         = string<br/>      key            = string<br/>      object_version = string<br/>    }))<br/>  })</pre> | n/a | yes |
| remote\_write | The Prometheus remote\_write endpoint, and how to authenticate to it. At most one of:<br/><br/>  sigv4    Amazon Managed Service for Prometheus. role\_arn: a writer role to assume (for a<br/>           workspace in another account); without it the Lambda's own role signs, and needs<br/>           aps:RemoteWrite (see additional\_policy\_json).<br/>  basic    a Secrets Manager secret with {"username": "...", "password": "..."} (Grafana Cloud).<br/>  bearer   a Secrets Manager secret with {"token": "..."} or the bare token.<br/><br/>headers: plain, non-secret extras such as X-Scope-OrgID for Mimir; they are visible in the<br/>function's configuration, so a header named like a credential (key, token, secret, auth...)<br/>is refused.<br/><br/>The URL must be the endpoint itself: a redirect is not followed. With sigv4 and no region, the<br/>region is read from an AWS hostname (an AMP or VPC endpoint URL). | <pre>object({<br/>    url = string<br/>    auth = optional(object({<br/>      sigv4 = optional(object({<br/>        region      = optional(string)<br/>        service     = optional(string, "aps")<br/>        role_arn    = optional(string)<br/>        external_id = optional(string)<br/>      }))<br/>      basic  = optional(object({ secret_arn = string }))<br/>      bearer = optional(object({ secret_arn = string }))<br/>    }), {})<br/>    headers         = optional(map(string), {})<br/>    timeout_seconds = optional(number, 10)<br/>  })</pre> | n/a | yes |
| additional\_policy\_json | Extra IAM policy for the function's role, for example aps:RemoteWrite on a same-account workspace when no sigv4.role\_arn is used. | `string` | `null` | no |
| boot\_grace\_seconds | Instances younger than this are not counted as booting: they are always unregistered. | `number` | `30` | no |
| github\_app | Where the GitHub App credentials that read registered runners (busy, idle, offline, booting)<br/>come from:<br/><br/>  create\_secret     (default) the module creates an empty Secrets Manager secret; put<br/>                    {"app\_id": "...", "private\_key": "<PEM>"} in it. Until then GitHub is skipped.<br/>  existing\_secret   a secret you manage, same JSON, in secret\_arn.<br/>  runner\_ssm        the runner module's own App, from its SSM parameters. Works, but that App<br/>                    can register runners: more access than reading them needs.<br/>  disabled          no GitHub: queue, instance and capacity metrics only.<br/><br/>The recommended App is dedicated and read-only: organisation "Self-hosted runners: Read", plus<br/>repository "Administration: Read" for repository-level runners.<br/><br/>owners (required unless disabled): the organisations or "owner/repo" targets to query; matched<br/>without regard to case. The instances' ghr:Owner tags say where each runner registers, and a<br/>job that can tag its own instance could otherwise point the App at another organisation it is<br/>installed on.<br/><br/>ssm (runner\_ssm only): the runner module's parameter names, { app\_id\_parameter\_name,<br/>private\_key\_base64\_parameter\_name }, when they cannot be read from the runner stacks.<br/><br/>recovery\_window\_in\_days (create\_secret only): how long a destroyed secret can be restored, 0 or<br/>7-30. While it lasts, its name cannot be used again, so a destroy and re-apply of the same<br/>name\_prefix fails; set 0 where that matters.<br/><br/>A customer-managed key on an existing secret goes in secrets\_kms\_key\_arns. | <pre>object({<br/>    source                  = optional(string, "create_secret")<br/>    secret_arn              = optional(string)<br/>    recovery_window_in_days = optional(number, 30)<br/>    ssm = optional(object({<br/>      app_id_parameter_name             = string<br/>      private_key_base64_parameter_name = string<br/>    }))<br/>    owners = optional(list(string), [])<br/>  })</pre> | `{}` | no |
| github\_enterprise\_server\_url | GitHub Enterprise Server base URL (e.g. https://github.example.com) for every stack, overriding what the runner stacks say. null: from each stack, else github.com. | `string` | `null` | no |
| iam\_role\_path | Path for the function's role. | `string` | `"/"` | no |
| kms\_key\_arn | Customer-managed KMS key for the log group, the function's environment and the created secret. The key policy must allow logs.<region>.amazonaws.com. null: AWS-managed keys. | `string` | `null` | no |
| labels | Constant labels added to every series, for example { cluster = "ci" }: Prometheus label names, not a built-in label, non-empty values. | `map(string)` | `{}` | no |
| lambda\_architecture | arm64 or x86\_64; the code is plain JavaScript and runs on either. | `string` | `"arm64"` | no |
| lambda\_memory\_size | Memory in MB. The bundled AWS SDK starts faster with a little more than the minimum. | `number` | `256` | no |
| lambda\_runtime | nodejs22.x works with every supported AWS provider; nodejs24.x needs one that knows it. | `string` | `"nodejs22.x"` | no |
| lambda\_timeout | Seconds. Keep it under the schedule interval so samples never overlap, and long enough for a slow sample: at least 2 x source\_timeout\_seconds + remote\_write.timeout\_seconds + 5, which the module enforces. | `number` | `45` | no |
| log\_retention\_in\_days | CloudWatch Logs retention for the function's log group. | `number` | `30` | no |
| name\_prefix | Names the function, role, schedule, log group and secret. | `string` | `"github-runner-metrics"` | no |
| permissions\_boundary\_arn | Permissions boundary for the function's role. | `string` | `null` | no |
| reserved\_concurrent\_executions | 1 keeps samples from overlapping (remote write rejects out-of-order samples) and keeps the caches in one warm container. -1 removes the reservation, for accounts with no concurrency to spare. | `number` | `1` | no |
| runner\_configs | Runner configs given explicitly, for stacks whose outputs are not to hand (another state, another<br/>tool). The key is the runner\_config label. `environment` is the stack's ghr:environment tag<br/>value. `queues` defaults to "<environment>-queued-builds" and its "\_dead\_letter" queue in this<br/>account and region; give them for queues named otherwise, as<br/>{ main = "<ARN>", dead\_letter = "<ARN>" } with dead\_letter optional. `max_runners` -1 is<br/>unlimited. `labels` are added to this runner config's series (Prometheus label names, not a<br/>built-in label, non-empty values). | <pre>map(object({<br/>    environment        = string<br/>    max_runners        = optional(number, -1)<br/>    runner_name_prefix = optional(string, "")<br/>    github_api_url     = optional(string)<br/>    queues = optional(object({<br/>      main        = string<br/>      dead_letter = optional(string)<br/>    }))<br/>    labels = optional(map(string), {})<br/>  }))</pre> | `{}` | no |
| runner\_stacks | Runner stacks built with terraform-aws-github-runner, passed straight from their outputs so<br/>nothing has to be copied by hand:<br/><br/>  { multi\_runner = module.runners.runners\_map }                     # modules/multi-runner<br/>  { runners = module.runner.runners, queues = module.runner.queues } # the root module<br/><br/>Each runner config's environment, runner cap, runner name prefix, queues and GitHub Enterprise<br/>Server URL are read from its scale-up Lambda's configuration. `name` is the runner\_config label<br/>of a root-module stack, and required for one (multi-runner stacks use their map keys); `labels`<br/>are added to that stack's series. | <pre>list(object({<br/>    name         = optional(string)<br/>    multi_runner = optional(any)<br/>    runners      = optional(any)<br/>    queues       = optional(any)<br/>    labels       = optional(map(string), {})<br/>  }))</pre> | `[]` | no |
| schedule\_enabled | Set false to pause sampling without destroying anything. | `bool` | `true` | no |
| schedule\_expression | How often to sample. One minute is the finest EventBridge allows and the recommended rate. | `string` | `"rate(1 minute)"` | no |
| secrets\_kms\_key\_arns | Other customer-managed keys that encrypt secrets or parameters this module reads (an existing GitHub App secret, a remote-write credential, the runner module's SSM parameters). | `list(string)` | `[]` | no |
| source\_timeout\_seconds | Budget for each source (SQS, CloudWatch, EC2, GitHub) in each sample. | `number` | `10` | no |
| tags | Tags for every resource. | `map(string)` | `{}` | no |
| tracing\_mode | X-Ray tracing: null (off), PassThrough or Active. | `string` | `null` | no |
| vpc\_config | Run the function in a VPC. It needs outbound access to GitHub, the remote-write endpoint and the AWS APIs it calls (SQS, CloudWatch, EC2, Secrets Manager, SSM, STS). | <pre>object({<br/>    subnet_ids         = list(string)<br/>    security_group_ids = list(string)<br/>  })</pre> | `null` | no |

## Outputs

| Name | Description |
|------|-------------|
| github\_app\_secret\_arn | The secret to put the GitHub App's credentials in, when this module created it. |
| github\_app\_secret\_name | The created secret's name, for aws secretsmanager put-secret-value --secret-id. |
| lambda\_function\_arn | The sampler function's ARN. |
| lambda\_function\_name | The sampler function. |
| lambda\_role\_arn | The function's role. Trust it from a remote-write writer role in another account (remote\_write.auth.sigv4.role\_arn); see the README. |
| lambda\_role\_name | The function's role name, for attaching more permissions. |
| log\_group\_name | Where the function logs: one JSON line per sample, plus a line per failed source. |
| runner\_configs | The runner configs as the module derived them (environment, cap, main and dead-letter queue, GitHub API). Check this first when a series looks wrong. |
<!-- END_TF_DOCS -->
