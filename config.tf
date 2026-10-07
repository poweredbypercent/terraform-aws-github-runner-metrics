# The Lambda's configuration: one JSON document in its CONFIG environment variable, read by
# src/config/parse.ts. src/test/config.v1.json pins its shape from both sides: main.tftest.hcl
# renders it, and src/config/contract.test.ts parses it.

locals {
  lambda_config = {
    version = 1
    runner_configs = [
      for name, c in local.runner_configs : {
        name               = name
        environment        = c.environment
        max_runners        = c.max_runners
        runner_name_prefix = c.runner_name_prefix
        github_api_url     = c.github_api_url
        queues = concat(
          [{ arn = c.queues.main, kind = "main" }],
          c.queues.dead_letter == null ? [] : [{ arn = c.queues.dead_letter, kind = "dead_letter" }],
        )
        labels = c.labels
      }
    ]
    github = {
      credentials = local.github_credentials
      owners      = var.github_app.owners
    }
    remote_write = {
      url             = var.remote_write.url
      auth            = local.remote_write_auth
      headers         = var.remote_write.headers
      timeout_seconds = var.remote_write.timeout_seconds
    }
    labels                 = var.labels
    boot_grace_seconds     = var.boot_grace_seconds
    source_timeout_seconds = var.source_timeout_seconds
  }

  # Labels the metrics set themselves; constant labels may not reuse them. The same list as
  # src/domain/labels.ts, which src/model/catalogue.test.ts compares with this one.
  built_in_labels = ["environment", "runner_config", "queue", "visibility", "instance_type", "lifecycle", "state", "runner_type", "organization", "repository", "source"]

  # What the Lambda would reject on every invocation, so it would never push a sample. Each is a
  # precondition on the function (main.tf): checked at plan where the values are known, otherwise
  # at apply, before a function that cannot start is deployed.
  invalid_labels = sort(distinct(flatten([
    for labels in concat([var.labels], [for c in values(local.runner_configs) : c.labels]) : [
      for name, value in labels : name
      if !can(regex("^[a-zA-Z_][a-zA-Z0-9_]*$", name)) || startswith(name, "__") || contains(local.built_in_labels, name) || value == ""
    ]
  ])))
  invalid_runner_config_names = sort([for name in keys(local.runner_configs) : name if !can(regex("^[A-Za-z0-9_.-]+$", name))])
  runner_configs_without_environment = sort([
    for name, c in local.runner_configs : name if !can(regex("^[A-Za-z0-9_-]+$", c.environment))
  ])
  environments           = [for c in values(local.runner_configs) : c.environment if c.environment != null]
  duplicate_environments = sort(distinct([for e in local.environments : e if length([for x in local.environments : x if x == e]) > 1]))
  # The App's installation tokens are sent there: a stack's GHES_URL must be https.
  insecure_github_api_urls = sort([
    for name, c in local.runner_configs : name if !can(regex("^https://[^\\s/@?#]+(/[^\\s?#]*)?$", c.github_api_url))
  ])
  runner_configs_out_of_range = sort([
    for name, c in local.runner_configs : name if !(c.max_runners == -1 || (c.max_runners >= 0 && c.max_runners <= 100000))
  ])
}
