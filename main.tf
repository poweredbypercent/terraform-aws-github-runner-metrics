resource "aws_cloudwatch_log_group" "lambda" {
  name              = "/aws/lambda/${var.name_prefix}"
  retention_in_days = var.log_retention_in_days
  kms_key_id        = var.kms_key_arn
  tags              = var.tags
}

resource "aws_lambda_function" "this" {
  function_name = var.name_prefix
  description   = "Samples GitHub Actions runner stacks and pushes Prometheus metrics (terraform-aws-github-runner-metrics)"
  role          = aws_iam_role.lambda.arn
  handler       = "index.handler"
  runtime       = var.lambda_runtime
  architectures = [var.lambda_architecture]
  memory_size   = var.lambda_memory_size
  timeout       = var.lambda_timeout
  kms_key_arn   = var.kms_key_arn

  filename = var.lambda_zip.path
  # A conditional, not coalesce(): coalesce reads the file even when a hash is given, and the zip
  # may not exist until a later step.
  source_code_hash = (
    var.lambda_zip.path == null ? null :
    var.lambda_zip.source_code_hash != null ? var.lambda_zip.source_code_hash :
    filebase64sha256(var.lambda_zip.path)
  )
  s3_bucket         = try(var.lambda_zip.s3.bucket, null)
  s3_key            = try(var.lambda_zip.s3.key, null)
  s3_object_version = try(var.lambda_zip.s3.object_version, null)

  reserved_concurrent_executions = var.reserved_concurrent_executions

  environment {
    variables = {
      CONFIG       = jsonencode(local.lambda_config)
      NODE_OPTIONS = "--enable-source-maps"
    }
  }

  dynamic "vpc_config" {
    for_each = var.vpc_config == null ? [] : [var.vpc_config]
    content {
      subnet_ids         = vpc_config.value.subnet_ids
      security_group_ids = vpc_config.value.security_group_ids
    }
  }

  dynamic "tracing_config" {
    for_each = var.tracing_mode == null ? [] : [var.tracing_mode]
    content {
      mode = tracing_config.value
    }
  }

  tags = var.tags

  depends_on = [aws_cloudwatch_log_group.lambda, aws_iam_role_policy.lambda]

  # Configuration the Lambda would reject on every invocation (config.tf). A value read from a
  # runner stack may be unknown until it is applied; the check then waits for the apply.
  lifecycle {
    precondition {
      condition     = length(local.runner_configs) > 0
      error_message = "No runner configs: set runner_stacks (from the runner module's outputs) or runner_configs."
    }
    precondition {
      condition     = length(local.duplicate_runner_config_names) == 0
      error_message = "Runner config names appear more than once (in two runner_stacks, or in runner_stacks and runner_configs); every runner_config label must be unique: ${join(", ", local.duplicate_runner_config_names)}."
    }
    precondition {
      condition     = length(local.invalid_runner_config_names) == 0
      error_message = "Runner config names (multi-runner keys, runner_stacks[].name, runner_configs keys) may contain only letters, digits, '.', '-' and '_': ${join(", ", local.invalid_runner_config_names)}."
    }
    precondition {
      condition     = length(local.runner_configs_without_environment) == 0
      error_message = "Runner configs without a usable ENVIRONMENT (letters, digits, '-' and '_') in their scale-up Lambda: ${join(", ", local.runner_configs_without_environment)}. Pass the runner module's outputs unchanged, or describe the stack in runner_configs."
    }
    precondition {
      condition     = length(local.duplicate_environments) == 0
      error_message = "Environments sampled by more than one runner config (a stack given in both runner_stacks and runner_configs?): ${join(", ", local.duplicate_environments)}."
    }
    precondition {
      condition     = length(local.insecure_github_api_urls) == 0
      error_message = "Runner configs whose GitHub URL is not https (the App's tokens are sent there): ${join(", ", local.insecure_github_api_urls)}. Set github_enterprise_server_url, or the runner config's github_api_url."
    }
    precondition {
      condition     = length(local.runner_configs_out_of_range) == 0
      error_message = "Runner configs whose runner cap is not -1 or 0-100000: ${join(", ", local.runner_configs_out_of_range)}."
    }
    precondition {
      condition     = length(local.invalid_labels) == 0
      error_message = "Constant labels (labels, runner_stacks[].labels, runner_configs[].labels) must be Prometheus label names, not start with \"__\", not reuse a built-in label, and have a value: ${join(", ", local.invalid_labels)}."
    }
    precondition {
      # A conditional, not ||: Terraform before 1.12 evaluates both sides of ||, and values(null) fails.
      condition     = local.github_ssm_parameters == null ? true : length(compact(values(local.github_ssm_parameters))) == 2
      error_message = "github_app.source = \"runner_ssm\" but the runner module's GitHub App parameter names were not found; set github_app.ssm."
    }
    precondition {
      # GitHub waits for EC2, so two source budgets run back to back, then the push.
      condition     = var.lambda_timeout >= 2 * var.source_timeout_seconds + var.remote_write.timeout_seconds + 5
      error_message = "lambda_timeout is too short to finish a slow sample: it needs 2 x source_timeout_seconds + remote_write.timeout_seconds + 5 seconds."
    }
  }
}

# A failed sample is not retried: a retry would push that minute's samples after the next
# minute's, and remote-write receivers reject samples older than a series' latest. The next
# scheduled sample is the retry.
resource "aws_lambda_function_event_invoke_config" "this" {
  function_name                = aws_lambda_function.this.function_name
  maximum_retry_attempts       = 0
  maximum_event_age_in_seconds = 60
}

resource "aws_cloudwatch_event_rule" "schedule" {
  name                = var.name_prefix
  description         = "Sample the GitHub Actions runner stacks"
  schedule_expression = var.schedule_expression
  state               = var.schedule_enabled ? "ENABLED" : "DISABLED"
  tags                = var.tags
}

resource "aws_cloudwatch_event_target" "schedule" {
  rule      = aws_cloudwatch_event_rule.schedule.name
  target_id = var.name_prefix
  arn       = aws_lambda_function.this.arn
}

resource "aws_lambda_permission" "schedule" {
  statement_id  = "AllowExecutionFromEventBridge"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.this.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.schedule.arn
}
