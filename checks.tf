# Problems that degrade the samples without stopping them. They warn rather than block; what would
# stop every sample is refused instead (validation.tf).

check "queue_region" {
  assert {
    # The Lambda's SQS and CloudWatch clients are in its own region.
    condition     = alltrue([for arn in local.queue_arns : try(split(":", arn)[3], "") == local.region])
    error_message = "Every queue must be in the region this module is deployed in; deploy one instance of the module per region."
  }
}

check "runner_module" {
  assert {
    # The runner module sets both on every scale-up Lambda; without them capacity is not reported
    # and runners cannot be placed by their name prefix. A runner module this module does not know?
    condition = alltrue([
      for variables in local.stack_lambda_variables :
      can(variables.RUNNERS_MAXIMUM_COUNT) && can(variables.RUNNER_NAME_PREFIX)
    ])
    error_message = "A runner stack's scale-up Lambda has no RUNNERS_MAXIMUM_COUNT or RUNNER_NAME_PREFIX: its capacity is not reported. Is the runner module a version this module supports?"
  }
}

check "github_app" {
  assert {
    condition     = local.github_ssm_parameters == null || var.github_app.ssm != null || length(local.stack_ssm_parameters) <= 1
    error_message = "github_app.source = \"runner_ssm\" reads one App, but the runner stacks use different ones; set github_app.ssm, or use a dedicated App."
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
