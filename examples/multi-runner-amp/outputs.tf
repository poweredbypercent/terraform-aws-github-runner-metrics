output "lambda_role_arn" {
  description = "Add this to the trust policy of the Prometheus writer role."
  value       = module.runner_metrics.lambda_role_arn
}

output "github_app_secret_name" {
  description = "Put the read-only GitHub App's {\"app_id\", \"private_key\"} here."
  value       = module.runner_metrics.github_app_secret_name
}

output "runner_configs" {
  description = "What the module read from the runner stack."
  value       = module.runner_metrics.runner_configs
}
