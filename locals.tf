data "aws_partition" "current" {}
data "aws_region" "current" {}
data "aws_caller_identity" "current" {}

locals {
  # The region's id is its name on aws 5.x and 6.x alike. 6.x deprecates it (and `name`) in favour
  # of `region`, which 5.x does not have; switch to `region` once 5.x support is dropped.
  region    = data.aws_region.current.id
  account   = data.aws_caller_identity.current.account_id
  partition = data.aws_partition.current.partition

  sqs_arn_prefix = "arn:${local.partition}:sqs:${local.region}:${local.account}"

  # ---------------------------------------------------------------------------------------------
  # Runner configs, read from the runner stacks' own outputs
  # ---------------------------------------------------------------------------------------------

  # Every runner config's scale-up Lambda carries its settings as environment variables
  # (ENVIRONMENT, RUNNERS_MAXIMUM_COUNT, RUNNER_NAME_PREFIX, GHES_URL, the App's SSM parameter
  # names), in both module variants: the one place to read them without copying anything.
  stack_runner_configs = merge(concat([{}], [
    for index, stack in var.runner_stacks : (
      stack.multi_runner != null
      ? {
        for key, runner in stack.multi_runner : key => {
          variables  = try(runner.lambda_up.environment[0].variables, {})
          queue_arns = null # multi-runner does not output its queues: derived below
          labels     = stack.labels
        }
      }
      : {
        (coalesce(stack.name, length(var.runner_stacks) == 1 ? "default" : "stack-${index}")) = {
          variables = try(stack.runners.lambda_up.environment[0].variables, {})
          queue_arns = stack.queues == null ? null : compact([
            try(stack.queues.build_queue_arn, null),
            try(stack.queues.build_queue_dlq_arn, null),
          ])
          labels = stack.labels
        }
      }
    )
  ])...)

  # GitHub Enterprise Server serves its API under /api/v3; GHE.com data residency on an api.
  # subdomain. github.com when neither is set.
  ghes_api_url = {
    for name, c in local.stack_runner_configs : name => (
      var.github_enterprise_server_url != null ? var.github_enterprise_server_url : try(c.variables.GHES_URL, "")
    )
  }

  derived_runner_configs = {
    for name, c in local.stack_runner_configs : name => {
      environment        = try(c.variables.ENVIRONMENT, null)
      max_runners        = try(tonumber(c.variables.RUNNERS_MAXIMUM_COUNT), -1)
      runner_name_prefix = try(c.variables.RUNNER_NAME_PREFIX, "")
      github_api_url = (
        local.ghes_api_url[name] == "" ? "https://api.github.com" :
        can(regex("^https://[^/]+\\.ghe\\.com/?$", local.ghes_api_url[name]))
        ? replace(trimsuffix(local.ghes_api_url[name], "/"), "https://", "https://api.")
        : "${trimsuffix(local.ghes_api_url[name], "/")}/api/v3"
      )
      # The runner module names a config's queues "<environment>-queued-builds" and, with
      # redrive_build_queue, "<environment>-queued-builds_dead_letter". The dead-letter queue is
      # always listed: the Lambda treats one that does not exist as absent, not as a failure.
      queue_arns = c.queue_arns != null ? c.queue_arns : [
        "${local.sqs_arn_prefix}:${try(c.variables.ENVIRONMENT, "")}-queued-builds",
        "${local.sqs_arn_prefix}:${try(c.variables.ENVIRONMENT, "")}-queued-builds_dead_letter",
      ]
      labels = c.labels
    }
  }

  explicit_runner_configs = {
    for name, c in var.runner_configs : name => {
      environment        = c.environment
      max_runners        = c.max_runners
      runner_name_prefix = c.runner_name_prefix
      github_api_url = coalesce(
        c.github_api_url,
        var.github_enterprise_server_url == null ? null : "${trimsuffix(var.github_enterprise_server_url, "/")}/api/v3",
        "https://api.github.com",
      )
      queue_arns = c.queue_arns != null ? c.queue_arns : [
        "${local.sqs_arn_prefix}:${c.environment}-queued-builds",
        "${local.sqs_arn_prefix}:${c.environment}-queued-builds_dead_letter",
      ]
      labels = c.labels
    }
  }

  runner_configs = merge(local.derived_runner_configs, local.explicit_runner_configs)
  queue_arns     = distinct(flatten([for c in values(local.runner_configs) : c.queue_arns]))

  # ---------------------------------------------------------------------------------------------
  # GitHub App credentials
  # ---------------------------------------------------------------------------------------------

  first_stack_variables = try(values(local.stack_runner_configs)[0].variables, {})
  github_ssm_parameters = var.github_app.source != "runner_ssm" ? null : {
    app_id = coalesce(
      try(var.github_app.ssm.app_id_parameter_name, null),
      try(local.first_stack_variables.PARAMETER_GITHUB_APP_ID_NAME, null),
      "unset",
    )
    private_key = coalesce(
      try(var.github_app.ssm.private_key_base64_parameter_name, null),
      try(local.first_stack_variables.PARAMETER_GITHUB_APP_KEY_BASE64_NAME, null),
      "unset",
    )
  }
  github_secret_arn = (
    var.github_app.source == "create_secret" ? aws_secretsmanager_secret.github_app[0].arn :
    var.github_app.source == "existing_secret" ? var.github_app.secret_arn : null
  )
  github_credentials = (
    local.github_secret_arn != null ? { type = "secret", secret_arn = local.github_secret_arn } :
    local.github_ssm_parameters != null ? {
      type                  = "ssm"
      app_id_parameter      = local.github_ssm_parameters.app_id
      private_key_parameter = local.github_ssm_parameters.private_key
    } : { type = "none" }
  )

  # ---------------------------------------------------------------------------------------------
  # Remote write
  # ---------------------------------------------------------------------------------------------

  sigv4 = var.remote_write.auth.sigv4
  remote_write_auth = (
    local.sigv4 != null ? {
      type        = "sigv4"
      region      = coalesce(local.sigv4.region, try(regex("\\.([a-z0-9-]+)\\.amazonaws\\.com", var.remote_write.url)[0], null))
      service     = local.sigv4.service
      role_arn    = local.sigv4.role_arn
      external_id = local.sigv4.external_id
    } :
    var.remote_write.auth.basic != null ? { type = "basic", secret_arn = var.remote_write.auth.basic.secret_arn } :
    var.remote_write.auth.bearer != null ? { type = "bearer", secret_arn = var.remote_write.auth.bearer.secret_arn } :
    { type = "none" }
  )
  remote_write_secret_arn = try(local.remote_write_auth.secret_arn, null)

  # ---------------------------------------------------------------------------------------------
  # The Lambda's configuration: one JSON document, read by src/config/parse.ts
  # ---------------------------------------------------------------------------------------------

  lambda_config = {
    version = 1
    runner_configs = [
      for name, c in local.runner_configs : {
        name               = name
        environment        = c.environment
        max_runners        = c.max_runners
        runner_name_prefix = c.runner_name_prefix
        github_api_url     = c.github_api_url
        queue_arns         = c.queue_arns
        labels             = c.labels
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
}
