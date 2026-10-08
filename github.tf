# The GitHub App that reads registered runners: where its credentials come from.

# Created empty: the private key never passes through Terraform or its state. Fill it once the App
# exists (see the README):
#   aws secretsmanager put-secret-value --secret-id <name> --secret-string file://github-app.json
# The Lambda reads it at the next sample; until then it samples everything but GitHub.
resource "aws_secretsmanager_secret" "github_app" {
  count                   = var.github_app.source == "create_secret" ? 1 : 0
  name                    = "${var.name_prefix}/github-app"
  description             = "GitHub App for ${var.name_prefix}: JSON {\"app_id\": \"...\", \"private_key\": \"<PEM>\"}. Read-only App: organisation Self-hosted runners, repository Administration."
  kms_key_id              = var.kms_key_arn
  recovery_window_in_days = var.github_app.recovery_window_in_days
  tags                    = var.tags
}

locals {
  # The runner module's App, from its SSM parameters. v7.11 can rotate across several Apps and
  # joins their parameter names with ":"; the first App is used. Every stack is expected to use
  # the same App (checks.tf).
  stack_ssm_parameters = distinct([
    for variables in local.stack_lambda_variables : {
      app_id      = try(split(":", variables.PARAMETER_GITHUB_APP_ID_NAME)[0], null)
      private_key = try(split(":", variables.PARAMETER_GITHUB_APP_KEY_BASE64_NAME)[0], null)
    }
  ])
  github_ssm_parameters = var.github_app.source != "runner_ssm" ? null : {
    app_id = try(coalesce(
      try(var.github_app.ssm.app_id_parameter_name, null),
      try(local.stack_ssm_parameters[0].app_id, null),
    ), null)
    private_key = try(coalesce(
      try(var.github_app.ssm.private_key_base64_parameter_name, null),
      try(local.stack_ssm_parameters[0].private_key, null),
    ), null)
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
}
