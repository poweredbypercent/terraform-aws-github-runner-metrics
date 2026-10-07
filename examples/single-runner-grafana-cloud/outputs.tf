output "lambda_role_arn" {
  description = "The sampler's role, for any policy that has to name it."
  value       = module.runner_metrics.lambda_role_arn
}

output "runner_configs" {
  description = "What the module read from the runner stack."
  value       = module.runner_metrics.runner_configs
}
