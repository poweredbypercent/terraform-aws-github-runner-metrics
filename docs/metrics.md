# Metrics

All metrics are gauges. Every series also carries the constant labels you configure.
Generated from `src/model/catalogue.ts` by `npm run docs:metrics`; do not edit by hand.

| Metric | Labels | Source | Meaning |
| --- | --- | --- | --- |
| `github_aws_runners_capacity` | `environment`, `runner_config` | config | The most runners this runner config may run at once (runners_maximum_count). Not reported when unlimited. |
| `github_aws_runners_scale_up_queue_messages` | `environment`, `runner_config`, `queue`, `visibility` | sqs | Jobs in the scale-up queue. queue="main": waiting for the scale-up lambda (visible), being handled or backing off after the runner cap or a capacity error (in_flight), or delayed. queue="dead_letter": jobs that failed scale-up repeatedly and will not get a runner. |
| `github_aws_runners_scale_up_queue_oldest_message_age_seconds` | `environment`, `runner_config`, `queue` | cloudwatch | Age of the oldest message in the queue (CloudWatch ApproximateAgeOfOldestMessage, about a minute behind). Grows while depth stays flat when scale-up keeps failing. |
| `github_aws_runners_instances` | `environment`, `runner_config`, `instance_type`, `lifecycle`, `state` | ec2 | Runner EC2 instances, pending or running, by type, purchase option and state. Orphans are counted separately. |
| `github_aws_runners_orphan_instances` | `environment`, `runner_config` | ec2 | Instances the runner module marked as never having registered (ghr:orphan); scale-down terminates them. |
| `github_aws_runners_booting_runners` | `environment`, `runner_config` | github | Instances launched more than the boot grace period ago that have not registered with GitHub yet. Needs both EC2 and GitHub; not reported when either failed. |
| `github_aws_runners_registered_runners` | `environment`, `runner_config`, `runner_type`, `organization`, `repository` | github | Runners of this stack registered with GitHub, in any state. |
| `github_aws_runners_busy_runners` | `environment`, `runner_config`, `runner_type`, `organization`, `repository` | github | Registered runners running a job. |
| `github_aws_runners_idle_runners` | `environment`, `runner_config`, `runner_type`, `organization`, `repository` | github | Registered runners online and waiting for a job (for example a warm pool). |
| `github_aws_runners_offline_runners` | `environment`, `runner_config`, `runner_type`, `organization`, `repository` | github | Registered runners GitHub reports offline. |
| `github_aws_runners_source_up` | `source` | sampler | Whether the source answered this sample: 1 yes, 0 failed. A source that is not configured (GitHub without credentials) is not reported. |
| `github_aws_runners_last_sample_timestamp_seconds` | - | sampler | When this sample was taken (Unix seconds). Alert on time() minus this to catch a sampler that has stopped. |
| `github_aws_runners_sample_duration_seconds` | - | sampler | How long reading the sources took. |
