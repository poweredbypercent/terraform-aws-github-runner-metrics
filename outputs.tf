output "lambda_role_arn" {
  description = "The function's role. Trust it from a remote-write writer role in another account (remote_write.auth.sigv4.role_arn); see the README."
  value       = aws_iam_role.lambda.arn
}

output "lambda_role_name" {
  description = "The function's role name, for attaching more permissions."
  value       = aws_iam_role.lambda.name
}

output "lambda_function_name" {
  description = "The sampler function."
  value       = aws_lambda_function.this.function_name
}

output "lambda_function_arn" {
  description = "The sampler function's ARN."
  value       = aws_lambda_function.this.arn
}

output "log_group_name" {
  description = "Where the function logs: one JSON line per sample, plus a line per failed source."
  value       = aws_cloudwatch_log_group.lambda.name
}

output "github_app_secret_arn" {
  description = "The secret to put the GitHub App's credentials in, when this module created it."
  value       = try(aws_secretsmanager_secret.github_app[0].arn, null)
}

output "github_app_secret_name" {
  description = "The created secret's name, for aws secretsmanager put-secret-value --secret-id."
  value       = try(aws_secretsmanager_secret.github_app[0].name, null)
}

output "runner_configs" {
  description = "The runner configs as the module derived them (environment, cap, main and dead-letter queue, GitHub API). Check this first when a series looks wrong."
  value       = local.runner_configs
}
