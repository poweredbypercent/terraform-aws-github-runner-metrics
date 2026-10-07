# Problems that only show once the inputs are combined. Checks warn rather than block, because some
# values (a runner stack's Lambda) are only known after the first apply.

check "runner_configs" {
  assert {
    condition     = length(local.runner_configs) > 0
    error_message = "No runner configs: set runner_stacks (from the runner module's outputs) or runner_configs."
  }

  assert {
    condition = (
      length(local.stack_config_names) == length(local.stack_variables) &&
      length(local.runner_configs) == length(local.derived_runner_configs) + length(local.explicit_runner_configs)
    )
    error_message = "A runner config name appears more than once (in two runner_stacks, or in runner_stacks and runner_configs); every runner_config label must be unique."
  }

  assert {
    # The same rule the Lambda applies; a multi-runner map key becomes the name.
    condition     = alltrue([for name in keys(local.runner_configs) : can(regex("^[A-Za-z0-9_.-]+$", name))])
    error_message = "Runner config names (multi-runner keys, runner_stacks[].name, runner_configs keys) may contain only letters, digits, '.', '-' and '_'."
  }

  assert {
    condition     = alltrue([for c in values(local.runner_configs) : c.environment != null && c.environment != ""])
    error_message = "A runner stack's scale-up Lambda has no ENVIRONMENT variable. Pass the runner module's outputs unchanged, or describe the stack in runner_configs."
  }

  assert {
    # The Lambda's SQS and CloudWatch clients are in its own region.
    condition     = alltrue([for arn in local.queue_arns : split(":", arn)[3] == local.region])
    error_message = "Every queue must be in the region this module is deployed in; deploy one instance of the module per region."
  }
}

check "github_app" {
  assert {
    # A conditional, not ||: Terraform before 1.12 evaluates both sides of ||, and values(null) fails.
    condition     = local.github_ssm_parameters == null ? true : length(compact(values(local.github_ssm_parameters))) == 2
    error_message = "github_app.source = \"runner_ssm\" but the runner module's GitHub App parameter names were not found; set github_app.ssm."
  }

  assert {
    condition     = local.github_ssm_parameters == null || var.github_app.ssm != null || length(local.stack_ssm_parameters) <= 1
    error_message = "github_app.source = \"runner_ssm\" reads one App, but the runner stacks use different ones; set github_app.ssm, or use a dedicated App."
  }
}

check "timeout_budget" {
  assert {
    # GitHub waits for EC2, so two source budgets run back to back, then the push.
    condition     = var.lambda_timeout >= 2 * var.source_timeout_seconds + var.remote_write.timeout_seconds + 5
    error_message = "lambda_timeout is too short to finish a slow sample: it needs 2 x source_timeout_seconds + remote_write.timeout_seconds + 5 seconds."
  }
}

check "lambda_config_size" {
  assert {
    # Lambda allows 4 KB of environment variables in total; the runner configs are nearly all of
    # the configuration, and unlike the secret ARNs they are known at plan time.
    condition     = length(jsonencode(local.lambda_config.runner_configs)) < 3200
    error_message = "The sampler's configuration is close to Lambda's 4 KB environment limit; split the runner stacks across two instances of this module."
  }
}
