# What the Lambda would reject on every invocation (src/config/parse.ts), or the role would grant
# too widely, refused before anything is deployed. Each entry of `rejected` lists one rule's
# offenders and is a precondition on what it protects (main.tf, iam.tf): checked at plan where the
# values are known, otherwise at apply. A rule about one variable alone is that variable's
# validation instead (variables.tf). The patterns are the Lambda's own, and
# src/config/parity.test.ts checks each is written here or there exactly as the Lambda has it.

locals {
  # Labels the metrics set themselves; constant labels may not reuse them.
  built_in_labels = ["environment", "runner_config", "queue", "visibility", "instance_type", "lifecycle", "state", "runner_type", "organization", "repository", "source"]

  runner_configs_by_environment = { for name, c in local.runner_configs : c.environment => name... if c.environment != null }

  rejected = {
    duplicate_names = sort([for name, configs in local.runner_configs_by_name : name if length(configs) > 1])
    names           = sort([for name in keys(local.runner_configs) : name if !can(regex("^[A-Za-z0-9_.-]+$", name))])
    environments    = sort([for name, c in local.runner_configs : name if !can(regex("^[A-Za-z0-9_-]+$", c.environment))])
    duplicate_environments = sort([
      for environment, names in local.runner_configs_by_environment : environment if length(names) > 1
    ])
    # The App's installation tokens are sent there.
    github_api_urls = sort([
      for name, c in local.runner_configs : name
      if !startswith(c.github_api_url, "https://") || !can(regex("^https?://[A-Za-z0-9_.-]+(:[0-9]{1,5})?(/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*)?$", c.github_api_url))
    ])
    runner_caps = sort([
      for name, c in local.runner_configs : name if !(c.max_runners == -1 || (c.max_runners >= 0 && c.max_runners <= 100000))
    ])
    labels = sort(distinct(flatten([
      for labels in concat([var.labels], [for c in values(local.runner_configs) : c.labels]) : [
        for name, value in labels : name
        if !can(regex("^[a-zA-Z_][a-zA-Z0-9_]*$", name)) || startswith(name, "__") || contains(local.built_in_labels, name) || value == ""
      ]
    ])))
    # A conditional, not ||: Terraform before 1.12 evaluates both sides of ||, and null has no keys.
    ssm_parameters = local.github_ssm_parameters == null ? [] : sort([for kind, name in local.github_ssm_parameters : kind if name == null])

    # They go into the role's policy, where a wildcard would grant everything it matches.
    queue_arns = sort([
      for arn in local.queue_arns : arn
      if !can(regex("^arn:aws[a-z-]*:sqs:[a-z0-9-]+:[0-9]{12}:([A-Za-z0-9_-]{1,80}|[A-Za-z0-9_-]{1,75}\\.fifo)$", arn))
    ])
    ssm_parameter_names = local.github_ssm_parameters == null ? [] : sort([
      for name in compact(values(local.github_ssm_parameters)) : name if !can(regex("^/?[A-Za-z0-9_.-]+(/[A-Za-z0-9_.-]+)*$", name))
    ])
  }
}
