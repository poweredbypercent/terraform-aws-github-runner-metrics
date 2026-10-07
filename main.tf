# The GitHub App's credentials, created empty: the private key never passes through Terraform or
# its state. Fill it once the App exists (see the README):
#   aws secretsmanager put-secret-value --secret-id <name> --secret-string file://github-app.json
# The Lambda reads it within ten minutes; until then it samples everything but GitHub.
resource "aws_secretsmanager_secret" "github_app" {
  count                   = var.github_app.source == "create_secret" ? 1 : 0
  name                    = "${var.name_prefix}/github-app"
  description             = "GitHub App for ${var.name_prefix}: JSON {\"app_id\": \"...\", \"private_key\": \"<PEM>\"}. Read-only App: organisation Self-hosted runners, repository Administration."
  kms_key_id              = var.kms_key_arn
  recovery_window_in_days = var.github_app.recovery_window_in_days
  tags                    = var.tags
}

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
