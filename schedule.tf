# How the function runs: once per tick of the schedule, never retried.

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

# A failed sample is not retried: a retry would push that minute's samples after the next
# minute's, and remote-write receivers reject samples older than a series' latest. The next
# scheduled sample is the retry.
resource "aws_lambda_function_event_invoke_config" "this" {
  function_name                = aws_lambda_function.this.function_name
  maximum_retry_attempts       = 0
  maximum_event_age_in_seconds = 60
}
