# The Lambda's configuration: one JSON document in its CONFIG environment variable, read by
# src/config/parse.ts. src/test/config.v1.*.json pin its shape from both sides: main.tftest.hcl
# renders them, and src/config/contract.test.ts parses them.

locals {
  lambda_config = {
    version = 1
    runner_configs = [
      for name, c in local.runner_configs : {
        name               = name
        environment        = c.environment
        max_runners        = c.max_runners
        runner_name_prefix = c.runner_name_prefix
        github_api_url     = c.github_api_url
        queues             = c.queues
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
