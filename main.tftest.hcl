# terraform test, against a mock AWS provider: how the module reads runner stacks, what it hands
# the Lambda, and which permissions it grants. Needs Terraform >= 1.11 (override_during).

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
  # Policy documents are rendered by the provider; IAM resources only need valid JSON here, and
  # the tests assert on the statements as configured.
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }
}

variables {
  remote_write = { url = "https://prometheus.example/api/v1/write" }
  lambda_zip   = { s3 = { bucket = "artifacts", key = "runner-metrics.zip" } }
  github_app   = { source = "disabled" }
}

# The shape of the runner module's outputs: each runner config's scale-up Lambda, whose
# environment variables carry its settings.
run "reads_a_multi_runner_stack" {
  command = plan

  variables {
    runner_stacks = [{
      multi_runner = {
        linux = { lambda_up = { environment = [{ variables = {
          ENVIRONMENT           = "ci-linux"
          RUNNERS_MAXIMUM_COUNT = "20"
          RUNNER_NAME_PREFIX    = "linux"
        } }] } }
        ghes = { lambda_up = { environment = [{ variables = {
          ENVIRONMENT           = "ci-ghes"
          RUNNERS_MAXIMUM_COUNT = "-1"
          GHES_URL              = "https://github.example.com/"
        } }] } }
      }
      labels = { team = "platform" }
    }]
  }

  assert {
    condition     = output.runner_configs.linux.environment == "ci-linux" && output.runner_configs.linux.max_runners == 20
    error_message = "environment and cap come from the scale-up Lambda"
  }
  assert {
    condition = jsonencode(output.runner_configs.linux.queue_arns) == jsonencode([
      "arn:aws:sqs:eu-west-1:123456789012:ci-linux-queued-builds",
      "arn:aws:sqs:eu-west-1:123456789012:ci-linux-queued-builds_dead_letter",
    ])
    error_message = "queues are derived from the environment in this account and region"
  }
  assert {
    condition     = output.runner_configs.linux.github_api_url == "https://api.github.com"
    error_message = "github.com by default"
  }
  assert {
    condition     = output.runner_configs.ghes.github_api_url == "https://github.example.com/api/v3"
    error_message = "GitHub Enterprise Server serves its API under /api/v3"
  }
  assert {
    condition     = output.runner_configs.linux.labels.team == "platform"
    error_message = "stack labels apply to its runner configs"
  }
}

run "reads_a_root_module_stack_with_its_queues" {
  command = plan

  variables {
    runner_stacks = [{
      name = "ci"
      runners = { lambda_up = { environment = [{ variables = {
        ENVIRONMENT = "ci"
        GHES_URL    = "https://acme.ghe.com"
      } }] } }
      queues = {
        build_queue_arn     = "arn:aws:sqs:eu-west-1:123456789012:ci-queued-builds"
        build_queue_dlq_arn = null
      }
    }]
  }

  assert {
    condition     = jsonencode(output.runner_configs.ci.queue_arns) == jsonencode(["arn:aws:sqs:eu-west-1:123456789012:ci-queued-builds"])
    error_message = "the root module's queue outputs are used as they are"
  }
  assert {
    condition     = output.runner_configs.ci.github_api_url == "https://api.acme.ghe.com"
    error_message = "GHE.com data residency serves its API on an api. subdomain"
  }
}

run "hands_the_lambda_its_configuration" {
  command = plan

  variables {
    runner_configs = {
      gpu = { environment = "ci-gpu", max_runners = 4 }
    }
    labels = { cluster = "ci" }
    remote_write = {
      url  = "https://aps-workspaces.eu-west-1.amazonaws.com/workspaces/ws-1/api/v1/remote_write"
      auth = { sigv4 = { role_arn = "arn:aws:iam::210987654321:role/prometheus-writer" } }
    }
  }

  assert {
    condition     = jsondecode(aws_lambda_function.this.environment[0].variables.CONFIG).version == 1
    error_message = "the configuration is versioned for the Lambda's parser"
  }
  assert {
    condition = jsondecode(aws_lambda_function.this.environment[0].variables.CONFIG).remote_write.auth == {
      type         = "sigv4"
      region       = "eu-west-1"
      service      = "aps"
      role_arn     = "arn:aws:iam::210987654321:role/prometheus-writer"
      external_id  = null
      session_name = "github-runner-metrics-123456789012"
    }
    error_message = "SigV4 takes its region from the AMP URL, and names the deployment in its session"
  }
  assert {
    condition     = jsondecode(aws_lambda_function.this.environment[0].variables.CONFIG).github.credentials == { type = "none" }
    error_message = "disabled GitHub means no credentials"
  }
  assert {
    condition     = aws_lambda_function_event_invoke_config.this.maximum_retry_attempts == 0
    error_message = "a failed sample is never retried out of order"
  }
}

run "grants_only_what_the_features_need" {
  command = plan

  variables {
    runner_configs = { ci = { environment = "ci" } }
    remote_write = {
      url  = "https://aps-workspaces.eu-west-1.amazonaws.com/workspaces/ws-1/api/v1/remote_write"
      auth = { sigv4 = { role_arn = "arn:aws:iam::210987654321:role/prometheus-writer" } }
    }
  }

  assert {
    condition     = contains(flatten([for s in data.aws_iam_policy_document.lambda.statement : s.actions]), "sts:AssumeRole")
    error_message = "a SigV4 writer role can be assumed"
  }
  assert {
    condition     = !contains(flatten([for s in data.aws_iam_policy_document.lambda.statement : s.actions]), "secretsmanager:GetSecretValue")
    error_message = "no secret access without a secret to read"
  }
  assert {
    condition     = length(aws_secretsmanager_secret.github_app) == 0
    error_message = "no App secret when GitHub is disabled"
  }
}

run "creates_the_app_secret_by_default" {
  command = plan

  variables {
    runner_configs = { ci = { environment = "ci" } }
    github_app     = { owners = ["acme"] }
  }

  # The created secret's ARN is only known after apply; give the plan one.
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

run "rejects_a_stack_given_both_ways" {
  command = plan
  variables {
    runner_stacks = [{ multi_runner = {}, runners = {} }]
  }
  expect_failures = [var.runner_stacks]
}

run "rejects_two_remote_write_auths" {
  command = plan
  variables {
    runner_configs = { ci = { environment = "ci" } }
    remote_write = {
      url  = "https://prometheus.example/api/v1/write"
      auth = { basic = { secret_arn = "a" }, bearer = { secret_arn = "b" } }
    }
  }
  expect_failures = [var.remote_write]
}

run "rejects_a_remote_write_header_that_would_override_auth" {
  command = plan
  variables {
    runner_configs = { ci = { environment = "ci" } }
    remote_write   = { url = "https://prometheus.example/api/v1/write", headers = { Authorization = "Bearer x" } }
  }
  expect_failures = [var.remote_write]
}

run "rejects_a_zip_given_both_ways" {
  command = plan
  variables {
    runner_configs = { ci = { environment = "ci" } }
    lambda_zip     = { path = "lambda.zip", s3 = { bucket = "b", key = "k" } }
  }
  expect_failures = [var.lambda_zip]
}

run "explicit_runner_configs_find_the_github_api_the_same_way" {
  command = plan

  variables {
    github_enterprise_server_url = "https://acme.ghe.com"
    runner_configs = {
      data_residency = { environment = "ci" }
      own_api        = { environment = "ci-own", github_api_url = "https://ghes.example/api/v3/" }
    }
  }

  assert {
    condition     = output.runner_configs.data_residency.github_api_url == "https://api.acme.ghe.com"
    error_message = "GHE.com is an api. subdomain whichever way the runner config was given"
  }
  assert {
    condition     = output.runner_configs.own_api.github_api_url == "https://ghes.example/api/v3"
    error_message = "an explicit API URL is used as given, without its trailing slash"
  }
}

run "reads_the_runner_module_app_from_ssm" {
  command = plan

  variables {
    github_app = { source = "runner_ssm", owners = ["acme"] }
    runner_stacks = [{
      multi_runner = {
        linux = { lambda_up = { environment = [{ variables = {
          ENVIRONMENT = "ci-linux"
          # v7.11 joins the parameters of several Apps with ":".
          PARAMETER_GITHUB_APP_ID_NAME         = "/gh/app-id:/gh/second-app-id"
          PARAMETER_GITHUB_APP_KEY_BASE64_NAME = "/gh/app-key:/gh/second-app-key"
        } }] } }
      }
    }]
  }

  assert {
    condition = jsondecode(aws_lambda_function.this.environment[0].variables.CONFIG).github.credentials == {
      type                  = "ssm"
      app_id_parameter      = "/gh/app-id"
      private_key_parameter = "/gh/app-key"
    }
    error_message = "the first App's parameters are read"
  }
  assert {
    condition = contains(
      flatten([for s in data.aws_iam_policy_document.lambda.statement : s.resources if contains(s.actions, "ssm:GetParameter")]),
      "arn:aws:ssm:eu-west-1:123456789012:parameter/gh/app-key",
    )
    error_message = "the role can read exactly those parameters"
  }
}

run "warns_when_the_runner_module_app_cannot_be_found" {
  command = plan
  variables {
    github_app     = { source = "runner_ssm", owners = ["acme"] }
    runner_configs = { ci = { environment = "ci" } }
  }
  expect_failures = [check.github_app]
}

run "reads_an_existing_secret_through_its_key_only" {
  command = plan

  variables {
    runner_configs = { ci = { environment = "ci" } }
    github_app = {
      source     = "existing_secret"
      secret_arn = "arn:aws:secretsmanager:eu-west-1:123456789012:secret:github-app-AbCdEf"
      owners     = ["acme"]
    }
    secrets_kms_key_arns = ["arn:aws:kms:eu-west-1:123456789012:key/1111-2222"]
  }

  assert {
    condition = contains(
      flatten([for s in data.aws_iam_policy_document.lambda.statement : s.resources if contains(s.actions, "secretsmanager:GetSecretValue")]),
      "arn:aws:secretsmanager:eu-west-1:123456789012:secret:github-app-AbCdEf",
    )
    error_message = "the existing secret can be read"
  }
  assert {
    condition = jsonencode(flatten([
      for s in data.aws_iam_policy_document.lambda.statement : [for c in s.condition : c.values if c.variable == "kms:ViaService"]
      if contains(s.actions, "kms:Decrypt")
    ])) == jsonencode(["lambda.eu-west-1.amazonaws.com", "secretsmanager.eu-west-1.amazonaws.com", "ssm.eu-west-1.amazonaws.com"])
    error_message = "the key decrypts only through the services holding the module's data"
  }
}

run "takes_a_hash_without_reading_the_zip" {
  command = plan

  variables {
    runner_configs = { ci = { environment = "ci" } }
    lambda_zip     = { path = "built-later.zip", source_code_hash = "c29tZS1oYXNo" }
  }

  assert {
    condition     = aws_lambda_function.this.source_code_hash == "c29tZS1oYXNo"
    error_message = "a given hash is used, and the zip need not exist yet"
  }
}

run "warns_about_a_queue_in_another_region" {
  command = plan
  variables {
    runner_configs = {
      ci = { environment = "ci", queue_arns = ["arn:aws:sqs:us-east-1:123456789012:ci-queued-builds"] }
    }
  }
  expect_failures = [check.runner_configs]
}

run "warns_when_the_timeout_cannot_fit_a_slow_sample" {
  command = plan
  variables {
    runner_configs = { ci = { environment = "ci" } }
    lambda_timeout = 20
  }
  expect_failures = [check.timeout_budget]
}

run "rejects_a_wildcard_secret_arn" {
  command = plan
  variables {
    runner_configs = { ci = { environment = "ci" } }
    github_app     = { source = "existing_secret", secret_arn = "arn:aws:secretsmanager:eu-west-1:123456789012:secret:*", owners = ["acme"] }
  }
  expect_failures = [var.github_app]
}

run "requires_an_owners_allowlist_with_github" {
  command = plan
  variables {
    runner_configs = { ci = { environment = "ci" } }
    github_app     = {}
  }
  expect_failures = [var.github_app]
}

run "warns_about_a_runner_config_name_in_two_stacks" {
  command = plan
  variables {
    runner_stacks = [
      { multi_runner = { linux = { lambda_up = { environment = [{ variables = { ENVIRONMENT = "a-linux" } }] } } } },
      { multi_runner = { linux = { lambda_up = { environment = [{ variables = { ENVIRONMENT = "b-linux" } }] } } } },
    ]
  }
  expect_failures = [check.runner_configs]
}

run "rejects_credentials_over_plain_http" {
  command = plan
  variables {
    runner_configs = { ci = { environment = "ci" } }
    remote_write = {
      url  = "http://prometheus.example/api/v1/write"
      auth = { bearer = { secret_arn = "arn:aws:secretsmanager:eu-west-1:123456789012:secret:token-AbCdEf" } }
    }
  }
  expect_failures = [var.remote_write]
}

run "rejects_credentials_in_the_url" {
  command = plan
  variables {
    runner_configs = { ci = { environment = "ci" } }
    remote_write   = { url = "https://user:pass@prometheus.example/api/v1/write" }
  }
  expect_failures = [var.remote_write]
}
