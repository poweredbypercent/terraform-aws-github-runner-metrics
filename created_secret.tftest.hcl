# The App secret the module creates by default. Needs Terraform >= 1.11: the secret's ARN is only
# known after apply, so the plan is given one (override_during).

mock_provider "aws" {
  override_data {
    target = data.aws_caller_identity.current
    values = { account_id = "123456789012" }
  }
  override_data {
    target = data.aws_region.current
    values = { id = "eu-west-1" }
  }
  override_data {
    target = data.aws_partition.current
    values = { partition = "aws", dns_suffix = "amazonaws.com" }
  }
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }
}

variables {
  remote_write   = { url = "https://prometheus.example/api/v1/write" }
  lambda_zip     = { s3 = { bucket = "artifacts", key = "runner-metrics.zip", object_version = "v1" } }
  runner_configs = { ci = { environment = "ci" } }
  github_app     = { owners = ["acme"] }
}

run "creates_the_app_secret_by_default" {
  command = plan

  override_resource {
    target          = aws_secretsmanager_secret.github_app
    override_during = plan
    values          = { arn = "arn:aws:secretsmanager:eu-west-1:123456789012:secret:github-runner-metrics/github-app-AbCdEf" }
  }

  assert {
    condition     = length(aws_secretsmanager_secret.github_app) == 1
    error_message = "create_secret is the default"
  }
  assert {
    condition     = contains(flatten([for s in data.aws_iam_policy_document.lambda.statement : s.actions]), "secretsmanager:GetSecretValue")
    error_message = "the created secret can be read"
  }
}
