# The runner configs to sample: read from the runner stacks' own outputs, or given explicitly, then
# brought into one shape. Everything after that is shared, so the two ways cannot drift apart.

locals {
  sqs_arn_prefix = "arn:${local.partition}:sqs:${local.region}:${local.account}"

  # Every runner config's scale-up Lambda carries its settings as environment variables
  # (ENVIRONMENT, RUNNERS_MAXIMUM_COUNT, RUNNER_NAME_PREFIX, GHES_URL, the App's SSM parameter
  # names), in both module variants: the one place to read them without copying anything.
  multi_runner_configs = flatten([
    for stack in [for s in var.runner_stacks : s if s.multi_runner != null] : [
      for key, runner in stack.multi_runner : {
        name      = key
        variables = try(runner.lambda_up.environment[0].variables, {})
        # multi-runner does not output its queues: they are derived from the environment below.
        queues = null
        labels = stack.labels
      }
    ]
  ])
  root_module_configs = [
    for stack in var.runner_stacks : {
      name      = stack.name
      variables = try(stack.runners.lambda_up.environment[0].variables, {})
      queues = stack.queues == null ? null : {
        main        = stack.queues.build_queue_arn
        dead_letter = try(stack.queues.build_queue_dlq_arn, null)
      }
      labels = stack.labels
    } if stack.runners != null
  ]
  # What each stack's scale-up Lambda said, for checks.tf to tell an unexpected runner module apart.
  stack_lambda_variables = [for c in concat(local.multi_runner_configs, local.root_module_configs) : c.variables]

  read_runner_configs = [
    for c in concat(local.multi_runner_configs, local.root_module_configs) : {
      name               = c.name
      environment        = try(c.variables.ENVIRONMENT, null)
      max_runners        = try(tonumber(c.variables.RUNNERS_MAXIMUM_COUNT), -1)
      runner_name_prefix = try(c.variables.RUNNER_NAME_PREFIX, "")
      github_url         = coalesce(var.github_enterprise_server_url, try(c.variables.GHES_URL, ""), "https://github.com")
      github_api_url     = null
      queues             = c.queues
      labels             = c.labels
    }
  ]
  given_runner_configs = [
    for name, c in var.runner_configs : {
      name               = name
      environment        = c.environment
      max_runners        = c.max_runners
      runner_name_prefix = c.runner_name_prefix
      github_url         = coalesce(var.github_enterprise_server_url, "https://github.com")
      github_api_url     = c.github_api_url
      queues             = c.queues
      labels             = c.labels
    }
  ]

  # Grouped by name, so a name given twice is reported (config.tf) rather than one silently winning.
  runner_configs_by_name        = { for c in concat(local.read_runner_configs, local.given_runner_configs) : c.name => c... }
  duplicate_runner_config_names = sort([for name, configs in local.runner_configs_by_name : name if length(configs) > 1])

  runner_configs = {
    for name, configs in local.runner_configs_by_name : name => {
      environment        = configs[0].environment
      max_runners        = configs[0].max_runners
      runner_name_prefix = configs[0].runner_name_prefix
      # github.com's API is api.github.com, GHE.com data residency's is on an api. subdomain, and
      # GitHub Enterprise Server serves it under /api/v3.
      github_api_url = configs[0].github_api_url != null ? trimsuffix(configs[0].github_api_url, "/") : (
        trimsuffix(configs[0].github_url, "/") == "https://github.com" ? "https://api.github.com" :
        can(regex("^https://[^/]+\\.ghe\\.com/?$", configs[0].github_url))
        ? replace(trimsuffix(configs[0].github_url, "/"), "https://", "https://api.")
        : "${trimsuffix(configs[0].github_url, "/")}/api/v3"
      )
      # The runner module names a config's queues "<environment>-queued-builds" and, with
      # redrive_build_queue, "<environment>-queued-builds_dead_letter". The dead-letter queue is
      # always listed: the Lambda treats one that does not exist as absent, not as a failure.
      queues = configs[0].queues != null ? configs[0].queues : {
        main        = "${local.sqs_arn_prefix}:${coalesce(configs[0].environment, "unknown")}-queued-builds"
        dead_letter = "${local.sqs_arn_prefix}:${coalesce(configs[0].environment, "unknown")}-queued-builds_dead_letter"
      }
      labels = configs[0].labels
    }
  }
}
