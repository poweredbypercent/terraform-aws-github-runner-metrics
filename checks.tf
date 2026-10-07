# Problems that only show once the inputs are combined. Checks warn rather than block, because some
# values (a runner stack's Lambda) are only known after the first apply.

check "runner_configs" {
  assert {
    condition     = length(local.runner_configs) > 0
    error_message = "No runner configs: set runner_stacks (from the runner module's outputs) or runner_configs."
  }

  assert {
    condition     = length(local.runner_configs) == length(local.derived_runner_configs) + length(local.explicit_runner_configs)
    error_message = "A runner_configs key repeats a runner config name derived from runner_stacks; every runner_config label must be unique."
  }

  assert {
    condition     = alltrue([for c in values(local.runner_configs) : c.environment != null && c.environment != ""])
    error_message = "A runner stack's scale-up Lambda has no ENVIRONMENT variable. Pass the runner module's outputs unchanged, or describe the stack in runner_configs."
  }
}

check "github_app" {
  assert {
    condition     = local.github_ssm_parameters == null || !contains(values(local.github_ssm_parameters), "unset")
    error_message = "github_app.source = \"runner_ssm\" but the runner module's GitHub App parameter names were not found; set github_app.ssm."
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
