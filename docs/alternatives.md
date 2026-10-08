# Alternatives, and why this module exists

Before reaching for this module, check whether something you already run covers what you need.
Several tools cover part of it; none covers a terraform-aws-github-runner stack end to end.

| Tool | What it gives you | What it does not |
| --- | --- | --- |
| The runner module's own `metrics` option | CloudWatch event metrics from its Lambdas: GitHub App rate limit, job retries, spot termination warnings. | Queue depth, the instance fleet or registered runners. Fleet monitoring is still an open request: [terraform-aws-github-runner#2025](https://github.com/github-aws-runners/terraform-aws-github-runner/issues/2025). |
| [YACE](https://github.com/prometheus-community/yet-another-cloudwatch-exporter) (or a CloudWatch data source in Grafana) | SQS queue depth and oldest-message age, and per-instance EC2 metrics, from CloudWatch. | Anything from GitHub; instance counts by type, purchase option and runner config; runner-config labels. CloudWatch data arrives one to several minutes late, and YACE is a service you run and scrape. |
| GitHub runner exporters, e.g. [github-actions-exporter](https://github.com/Labbs/github-actions-exporter), [github_exporter](https://github.com/xrstf/github_exporter) | Online, offline and busy status of registered runners, from the GitHub API. | Anything from AWS. Series are per runner, so ephemeral runners churn them. A service you run and scrape, with its own GitHub credentials. |
| Hosted runner products and CI analytics services | Their own dashboards for their own runners or pipelines. | They do not observe a terraform-aws-github-runner stack. |

## What this module adds

- **Booting runners.** Instances that have launched but whose runner is not online with GitHub
  yet (a just-in-time runner is registered before it boots), found by joining EC2 instances to
  GitHub runners by instance id. With the scale-up queue, this gives the
  number of jobs waiting for a runner. No tool that reads only AWS or only GitHub can produce it.
- **The fleet by runner config.** Instances by type, spot or on-demand, and state; capacity;
  orphans. Each series carries the `runner_config` and `environment` labels, read from the runner
  module's outputs rather than configured by hand.
- **Nothing to host.** A scheduled Lambda pushes over Prometheus remote write. There is no
  exporter to run, scrape or keep alive, and it works with any receiver that accepts remote write
  (Amazon Managed Service for Prometheus, Grafana Cloud, Mimir, Prometheus).
- **Unknown is not zero.** A source that fails leaves its series out and reports
  `github_aws_runners_source_up = 0`, so an outage of AWS or GitHub reads is not mistaken for an
  idle fleet.

## When something else is enough

- **Queue depth and age only:** YACE, or CloudWatch alarms on the SQS queues, cover it.
- **Whether runners are online or busy, on a non-AWS fleet:** a GitHub runner exporter is the
  simpler choice.
- **Job and workflow durations, failures, retries:** those are CI analytics rather than fleet
  state; use a CI metrics tool, alongside this module if you also want the fleet view.
