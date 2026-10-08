# terraform test, against a mock AWS provider: how the module reads runner stacks, what it hands
# the Lambda, which permissions it grants, and what it refuses. Needs Terraform >= 1.7 (mocks);
# the one run that needs 1.11 is in created_secret.tftest.hcl.
#
# A refusal names the rules that refused it: local.refused holds each rule that did, with its
# offenders (validation.tf), and Terraform evaluates a run's assertions even when its expected
# failures occur. A variable's own validations can only be named by their variable, so each of
# those runs breaks one of them alone.

mock_provider "aws" {
  override_data {
    target = data.aws_caller_identity.current
    values = { account_id = "123456789012" }
  }
  override_data {
    target = data.aws_region.current
    values = { endpoint = "ec2.eu-west-1.amazonaws.com" }
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
  lambda_zip   = { s3 = { bucket = "artifacts", key = "runner-metrics.zip", object_version = "v1" } }
  github_app   = { source = "disabled" }
}

# The CONFIG contract: exactly what src/config/contract.test.ts shows the Lambda reads, for each
# way of reading GitHub and of authenticating to remote write.

run "renders_the_configuration_the_lambda_reads" {
  command = plan

  variables {
    runner_stacks = [{
      multi_runner = {
        linux = { lambda_up = { environment = [{ variables = {
          ENVIRONMENT           = "ci-linux"
          RUNNERS_MAXIMUM_COUNT = "20"
          RUNNER_NAME_PREFIX    = "linux"
        } }] } }
      }
      labels = { team = "platform" }
    }]
    runner_configs = {
      fifo = {
        environment    = "ci-fifo"
        github_api_url = "https://ghes.example/api/v3"
        queues         = { main = "arn:aws:sqs:eu-west-1:123456789012:ci-fifo-queued-builds.fifo" }
      }
    }
    labels = { cluster = "ci" }
    github_app = {
      source     = "existing_secret"
      secret_arn = "arn:aws:secretsmanager:eu-west-1:123456789012:secret:github-app-AbCdEf"
      owners     = ["acme"]
    }
    remote_write = {
      url     = "https://aps-workspaces.eu-west-1.amazonaws.com/workspaces/ws-1/api/v1/remote_write"
      auth    = { sigv4 = { role_arn = "arn:aws:iam::210987654321:role/prometheus-writer", external_id = "metrics" } }
      headers = { "X-Scope-OrgID" = "ci" }
    }
  }

  assert {
    condition     = jsondecode(aws_lambda_function.this.environment[0].variables.CONFIG) == jsondecode(file("src/test/config.v1.secret-sigv4.json"))
    error_message = "CONFIG differs from src/test/config.v1.secret-sigv4.json, which the Lambda's contract test parses. It is now: ${aws_lambda_function.this.environment[0].variables.CONFIG}"
  }
}

run "renders_runner_ssm_credentials_and_basic_auth" {
  command = plan

  variables {
    runner_configs = {
      ci = { environment = "ci", queues = { main = "arn:aws:sqs:eu-west-1:123456789012:ci-builds" } }
    }
    github_app = {
      source = "runner_ssm"
      owners = ["acme/infra"]
      ssm    = { app_id_parameter_name = "/gh/app-id", private_key_base64_parameter_name = "/gh/app-key" }
    }
    remote_write = {
      url  = "https://prometheus-prod-01-eu-west-0.grafana.net/api/prom/push"
      auth = { basic = { secret_arn = "arn:aws:secretsmanager:eu-west-1:123456789012:secret:grafana-AbCdEf" } }
    }
  }

  assert {
    condition     = jsondecode(aws_lambda_function.this.environment[0].variables.CONFIG) == jsondecode(file("src/test/config.v1.ssm-basic.json"))
    error_message = "CONFIG differs from src/test/config.v1.ssm-basic.json, which the Lambda's contract test parses. It is now: ${aws_lambda_function.this.environment[0].variables.CONFIG}"
  }
  assert {
    condition = jsonencode(flatten([
      for s in data.aws_iam_policy_document.lambda.statement : s.resources if contains(s.actions, "secretsmanager:GetSecretValue")
    ])) == jsonencode(["arn:aws:secretsmanager:eu-west-1:123456789012:secret:grafana-AbCdEf"])
    error_message = "the role can read the remote-write secret, and no other"
  }
  assert {
    condition = jsonencode(flatten([
      for s in data.aws_iam_policy_document.lambda.statement : s.resources if contains(s.actions, "ssm:GetParameter")
    ])) == jsonencode(["arn:aws:ssm:eu-west-1:123456789012:parameter/gh/app-id", "arn:aws:ssm:eu-west-1:123456789012:parameter/gh/app-key"])
    error_message = "the role can read the App's two parameters, and no others"
  }
}

run "renders_a_root_module_stack_and_bearer_auth" {
  command = plan

  variables {
    runner_stacks = [{
      name = "ci"
      runners = { lambda_up = { environment = [{ variables = {
        ENVIRONMENT           = "ci"
        RUNNERS_MAXIMUM_COUNT = "0"
        RUNNER_NAME_PREFIX    = "ci-"
      } }] } }
      queues = {
        build_queue_arn     = "arn:aws:sqs:eu-west-1:123456789012:ci-queued-builds"
        build_queue_dlq_arn = "arn:aws:sqs:eu-west-1:123456789012:ci-queued-builds_dead_letter"
      }
    }]
    remote_write = {
      url             = "https://mimir.example:8443/api/v1/push"
      auth            = { bearer = { secret_arn = "arn:aws:secretsmanager:eu-west-1:123456789012:secret:mimir-AbCdEf" } }
      timeout_seconds = 20
    }
    boot_grace_seconds     = 60
    source_timeout_seconds = 15
    lambda_timeout         = 55
  }

  assert {
    condition     = jsondecode(aws_lambda_function.this.environment[0].variables.CONFIG) == jsondecode(file("src/test/config.v1.disabled-bearer.json"))
    error_message = "CONFIG differs from src/test/config.v1.disabled-bearer.json, which the Lambda's contract test parses. It is now: ${aws_lambda_function.this.environment[0].variables.CONFIG}"
  }
  assert {
    condition = jsonencode(flatten([
      for s in data.aws_iam_policy_document.lambda.statement : s.resources if contains(s.actions, "secretsmanager:GetSecretValue")
    ])) == jsonencode(["arn:aws:secretsmanager:eu-west-1:123456789012:secret:mimir-AbCdEf"])
    error_message = "the role can read the remote-write token, and no other secret"
  }
}

run "renders_an_unauthenticated_receiver" {
  command = plan

  variables {
    runner_configs = { ci = { environment = "ci", max_runners = 5, labels = { pool = "general" } } }
    remote_write   = { url = "http://mimir.monitoring.svc:9009/api/v1/push", headers = { "X-Scope-OrgID" = "ci" } }
  }

  assert {
    condition     = jsondecode(aws_lambda_function.this.environment[0].variables.CONFIG) == jsondecode(file("src/test/config.v1.unauthenticated.json"))
    error_message = "CONFIG differs from src/test/config.v1.unauthenticated.json, which the Lambda's contract test parses. It is now: ${aws_lambda_function.this.environment[0].variables.CONFIG}"
  }
  assert {
    condition     = !contains(flatten([for s in data.aws_iam_policy_document.lambda.statement : s.actions]), "secretsmanager:GetSecretValue")
    error_message = "nothing to authenticate with, so no secret to read"
  }
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
          RUNNER_NAME_PREFIX    = ""
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
    condition = output.runner_configs.linux.queues == {
      main        = "arn:aws:sqs:eu-west-1:123456789012:ci-linux-queued-builds"
      dead_letter = "arn:aws:sqs:eu-west-1:123456789012:ci-linux-queued-builds_dead_letter"
    }
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
        ENVIRONMENT           = "ci"
        RUNNERS_MAXIMUM_COUNT = "8"
        RUNNER_NAME_PREFIX    = ""
        GHES_URL              = "https://acme.ghe.com"
      } }] } }
      queues = {
        build_queue_arn     = "arn:aws:sqs:eu-west-1:123456789012:ci-queued-builds"
        build_queue_dlq_arn = null
      }
    }]
  }

  assert {
    condition     = output.runner_configs.ci.queues.main == "arn:aws:sqs:eu-west-1:123456789012:ci-queued-builds" && output.runner_configs.ci.queues.dead_letter == null
    error_message = "the root module's queue outputs are used as they are"
  }
  assert {
    condition     = jsondecode(aws_lambda_function.this.environment[0].variables.CONFIG).runner_configs[0].queues.dead_letter == null
    error_message = "no dead-letter queue is handed to the Lambda when the stack has none"
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
    condition     = jsondecode(aws_lambda_function.this.environment[0].variables.CONFIG).github.credentials == { type = "none" }
    error_message = "disabled GitHub means no credentials"
  }
  assert {
    condition     = aws_lambda_function_event_invoke_config.this.maximum_retry_attempts == 0
    error_message = "a failed sample is never retried out of order"
  }
  assert {
    condition     = aws_lambda_function.this.s3_object_version == "v1"
    error_message = "an S3 zip is deployed by its pinned version"
  }
}

run "takes_the_region_from_an_amp_vpc_endpoint" {
  command = plan

  variables {
    runner_configs = { ci = { environment = "ci" } }
    remote_write = {
      url  = "https://vpce-0abc-xyz.aps-workspaces.us-east-1.vpce.amazonaws.com/workspaces/ws-1/api/v1/remote_write"
      auth = { sigv4 = {} }
    }
  }

  assert {
    condition     = jsondecode(aws_lambda_function.this.environment[0].variables.CONFIG).remote_write.auth.region == "us-east-1"
    error_message = "the region is read from the endpoint's hostname, not the vpce label"
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
  assert {
    condition = jsonencode(flatten([
      for s in data.aws_iam_policy_document.lambda.statement : [for c in s.condition : c.values if c.variable == "aws:RequestedRegion"]
      if contains(s.actions, "ec2:DescribeInstances")
    ])) == jsonencode(["eu-west-1"])
    error_message = "the unscoped reads are limited to the module's region"
  }
}

run "reads_the_runner_module_app_from_ssm" {
  command = plan

  variables {
    github_app = { source = "runner_ssm", owners = ["acme"] }
    runner_stacks = [{
      multi_runner = {
        linux = { lambda_up = { environment = [{ variables = {
          ENVIRONMENT           = "ci-linux"
          RUNNERS_MAXIMUM_COUNT = "20"
          RUNNER_NAME_PREFIX    = ""
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

# Degradations: they warn.

run "warns_about_a_queue_in_another_region" {
  command = plan
  variables {
    runner_configs = {
      ci = { environment = "ci", queues = { main = "arn:aws:sqs:us-east-1:123456789012:ci-queued-builds" } }
    }
  }
  expect_failures = [check.queue_region]
}

run "warns_about_a_runner_module_it_does_not_know" {
  command = plan
  variables {
    runner_stacks = [{ multi_runner = { linux = { lambda_up = { environment = [{ variables = { ENVIRONMENT = "ci-linux" } }] } } } }]
  }
  expect_failures = [check.runner_module]
}

# What the Lambda would reject on every invocation, or the role would grant too widely: refused
# before it is deployed, by exactly the rule named.

run "rejects_no_runner_configs" {
  command         = plan
  expect_failures = [aws_lambda_function.this]

  assert {
    condition     = length(local.runner_configs) == 0 && length(local.refused) == 0
    error_message = "only the missing runner configs are refused: ${jsonencode(local.refused)}"
  }
}

run "rejects_a_runner_config_name_in_two_stacks" {
  command = plan
  variables {
    runner_stacks = [
      { multi_runner = { linux = { lambda_up = { environment = [{ variables = { ENVIRONMENT = "a-linux", RUNNERS_MAXIMUM_COUNT = "1", RUNNER_NAME_PREFIX = "" } }] } } } },
      { multi_runner = { linux = { lambda_up = { environment = [{ variables = { ENVIRONMENT = "b-linux", RUNNERS_MAXIMUM_COUNT = "1", RUNNER_NAME_PREFIX = "" } }] } } } },
    ]
  }
  expect_failures = [aws_lambda_function.this]

  assert {
    condition     = jsonencode(local.refused) == jsonencode({ duplicate_names = ["linux"] })
    error_message = "refused by: ${jsonencode(local.refused)}"
  }
}

run "rejects_a_multi_runner_key_that_cannot_be_a_label" {
  command = plan
  variables {
    runner_stacks = [{ multi_runner = { "linux arm" = { lambda_up = { environment = [{ variables = { ENVIRONMENT = "ci-linux-arm", RUNNERS_MAXIMUM_COUNT = "1", RUNNER_NAME_PREFIX = "" } }] } } } }]
  }
  expect_failures = [aws_lambda_function.this]

  assert {
    condition     = jsonencode(local.refused) == jsonencode({ names = ["linux arm"] })
    error_message = "refused by: ${jsonencode(local.refused)}"
  }
}

run "rejects_one_environment_sampled_twice" {
  command = plan
  variables {
    runner_stacks  = [{ multi_runner = { linux = { lambda_up = { environment = [{ variables = { ENVIRONMENT = "ci-linux", RUNNERS_MAXIMUM_COUNT = "1", RUNNER_NAME_PREFIX = "" } }] } } } }]
    runner_configs = { linux-fifo = { environment = "ci-linux" } }
  }
  expect_failures = [aws_lambda_function.this]

  assert {
    condition     = jsonencode(local.refused) == jsonencode({ duplicate_environments = ["ci-linux"] })
    error_message = "refused by: ${jsonencode(local.refused)}"
  }
}

run "rejects_a_stack_without_an_environment" {
  command = plan
  variables {
    runner_stacks = [{ multi_runner = { linux = { lambda_up = { environment = [{ variables = { RUNNERS_MAXIMUM_COUNT = "1", RUNNER_NAME_PREFIX = "" } }] } } } }]
  }
  expect_failures = [aws_lambda_function.this]

  assert {
    condition     = jsonencode(local.refused) == jsonencode({ environments = ["linux"] })
    error_message = "refused by: ${jsonencode(local.refused)}"
  }
}

run "rejects_a_plain_http_github_from_a_stack" {
  command = plan
  variables {
    runner_stacks = [{ multi_runner = { linux = { lambda_up = { environment = [{ variables = {
      ENVIRONMENT = "ci-linux", RUNNERS_MAXIMUM_COUNT = "1", RUNNER_NAME_PREFIX = "", GHES_URL = "http://ghes.example"
    } }] } } } }]
  }
  expect_failures = [aws_lambda_function.this]

  assert {
    condition     = jsonencode(local.refused) == jsonencode({ github_api_urls = ["linux"] })
    error_message = "refused by: ${jsonencode(local.refused)}"
  }
}

run "rejects_a_runner_cap_out_of_range" {
  command = plan
  variables {
    runner_configs = { ci = { environment = "ci", max_runners = -2 } }
  }
  expect_failures = [aws_lambda_function.this]

  assert {
    condition     = jsonencode(local.refused) == jsonencode({ runner_caps = ["ci"] })
    error_message = "refused by: ${jsonencode(local.refused)}"
  }
}

run "rejects_a_runner_cap_out_of_range_from_a_stack" {
  command = plan
  variables {
    runner_stacks = [{ multi_runner = { linux = { lambda_up = { environment = [{ variables = { ENVIRONMENT = "ci-linux", RUNNERS_MAXIMUM_COUNT = "200000", RUNNER_NAME_PREFIX = "" } }] } } } }]
  }
  expect_failures = [aws_lambda_function.this]

  assert {
    condition     = jsonencode(local.refused) == jsonencode({ runner_caps = ["linux"] })
    error_message = "refused by: ${jsonencode(local.refused)}"
  }
}

run "rejects_a_built_in_label_on_a_runner_config" {
  command = plan
  variables {
    runner_configs = { ci = { environment = "ci", labels = { environment = "prod" } } }
  }
  expect_failures = [aws_lambda_function.this]

  assert {
    condition     = jsonencode(local.refused) == jsonencode({ labels = ["environment"] })
    error_message = "refused by: ${jsonencode(local.refused)}"
  }
}

run "rejects_an_empty_label_value" {
  command = plan
  variables {
    runner_configs = { ci = { environment = "ci" } }
    labels         = { team = "" }
  }
  expect_failures = [aws_lambda_function.this]

  assert {
    condition     = jsonencode(local.refused) == jsonencode({ labels = ["team"] })
    error_message = "refused by: ${jsonencode(local.refused)}"
  }
}

run "rejects_a_null_label_value" {
  command = plan
  variables {
    runner_configs = { ci = { environment = "ci", labels = { team = null } } }
  }
  expect_failures = [aws_lambda_function.this]

  assert {
    condition     = jsonencode(local.refused) == jsonencode({ labels = ["team"] })
    error_message = "refused by: ${jsonencode(local.refused)}"
  }
}

run "rejects_when_the_runner_module_app_cannot_be_found" {
  command = plan
  variables {
    github_app     = { source = "runner_ssm", owners = ["acme"] }
    runner_configs = { ci = { environment = "ci" } }
  }
  expect_failures = [aws_lambda_function.this]

  assert {
    condition     = jsonencode(local.refused) == jsonencode({ missing_ssm_parameters = ["app_id", "private_key"] })
    error_message = "refused by: ${jsonencode(local.refused)}"
  }
}

run "rejects_a_timeout_that_cannot_fit_a_slow_sample" {
  command = plan
  variables {
    runner_configs = { ci = { environment = "ci" } }
    lambda_timeout = 20
  }
  expect_failures = [aws_lambda_function.this]

  assert {
    condition     = length(local.refused) == 0
    error_message = "only the timeout is refused: ${jsonencode(local.refused)}"
  }
}

run "rejects_a_wildcard_queue" {
  command = plan
  variables {
    runner_configs = { ci = { environment = "ci", queues = { main = "arn:aws:sqs:eu-west-1:123456789012:*" } } }
  }
  expect_failures = [data.aws_iam_policy_document.lambda]

  assert {
    condition     = jsonencode(local.refused) == jsonencode({ queue_arns = ["ci main: arn:aws:sqs:eu-west-1:123456789012:*"] })
    error_message = "refused by: ${jsonencode(local.refused)}"
  }
}

run "rejects_a_missing_main_queue" {
  command = plan
  variables {
    runner_configs = { ci = { environment = "ci", queues = { main = "" } } }
  }
  expect_failures = [data.aws_iam_policy_document.lambda]

  assert {
    condition     = jsonencode(local.refused) == jsonencode({ queue_arns = ["ci main: none"] })
    error_message = "refused by: ${jsonencode(local.refused)}"
  }
}

run "reads_an_empty_dead_letter_queue_as_none" {
  command = plan
  variables {
    runner_configs = { ci = { environment = "ci", queues = { main = "arn:aws:sqs:eu-west-1:123456789012:ci-builds", dead_letter = "" } } }
  }

  assert {
    condition     = jsondecode(aws_lambda_function.this.environment[0].variables.CONFIG).runner_configs[0].queues.dead_letter == null
    error_message = "an empty dead_letter is no dead-letter queue, not one the Lambda cannot read"
  }
}

run "leaves_out_a_dead_letter_queue_whose_name_could_not_exist" {
  command = plan
  variables {
    # 60 characters: the main queue's name is 74, a dead-letter queue's would be 86 (SQS allows 80).
    runner_configs = { ci = { environment = "e77777777777777777777777777777777777777777777777777777777777" } }
  }

  assert {
    condition     = output.runner_configs.ci.queues.dead_letter == null
    error_message = "no dead-letter queue the runner module could not have created"
  }
}

run "rejects_an_environment_too_long_for_its_queue_name" {
  command = plan
  variables {
    # 67 characters: its main queue's name would be 81, and SQS allows 80.
    runner_configs = { ci = { environment = "e777777777777777777777777777777777777777777777777777777777777777777" } }
  }
  expect_failures = [data.aws_iam_policy_document.lambda]

  assert {
    condition     = jsonencode(local.refused) == jsonencode({ queue_arns = ["ci main: arn:aws:sqs:eu-west-1:123456789012:e777777777777777777777777777777777777777777777777777777777777777777-queued-builds"] })
    error_message = "refused by: ${jsonencode(local.refused)}"
  }
}

run "rejects_a_wildcard_ssm_parameter_from_a_stack" {
  command = plan
  variables {
    github_app = { source = "runner_ssm", owners = ["acme"] }
    runner_stacks = [{ multi_runner = { linux = { lambda_up = { environment = [{ variables = {
      ENVIRONMENT                  = "ci-linux", RUNNERS_MAXIMUM_COUNT = "1", RUNNER_NAME_PREFIX = ""
      PARAMETER_GITHUB_APP_ID_NAME = "/gh/*", PARAMETER_GITHUB_APP_KEY_BASE64_NAME = "/gh/app-key"
    } }] } } } }]
  }
  expect_failures = [data.aws_iam_policy_document.lambda]

  assert {
    condition     = jsonencode(local.refused) == jsonencode({ ssm_parameter_names = ["/gh/*"] })
    error_message = "refused by: ${jsonencode(local.refused)}"
  }
}

# Inputs that are wrong whatever else is set: a variable's own validation. Each input breaks one.

run "rejects_a_stack_given_both_ways" {
  command = plan
  variables {
    runner_stacks = [{ multi_runner = {}, runners = {} }]
  }
  expect_failures = [var.runner_stacks]
}

run "rejects_an_unnamed_root_module_stack" {
  command = plan
  variables {
    runner_stacks = [{ runners = { lambda_up = { environment = [{ variables = { ENVIRONMENT = "ci" } }] } } }]
  }
  expect_failures = [var.runner_stacks]
}

run "rejects_two_remote_write_auths" {
  command = plan
  variables {
    runner_configs = { ci = { environment = "ci" } }
    remote_write = {
      url = "https://prometheus.example/api/v1/write"
      auth = {
        basic  = { secret_arn = "arn:aws:secretsmanager:eu-west-1:123456789012:secret:basic-AbCdEf" }
        bearer = { secret_arn = "arn:aws:secretsmanager:eu-west-1:123456789012:secret:bearer-AbCdEf" }
      }
    }
  }
  expect_failures = [var.remote_write]
}

run "rejects_a_wildcard_writer_role" {
  command = plan
  variables {
    runner_configs = { ci = { environment = "ci" } }
    remote_write = {
      url  = "https://aps-workspaces.eu-west-1.amazonaws.com/workspaces/ws-1/api/v1/remote_write"
      auth = { sigv4 = { role_arn = "arn:aws:iam::210987654321:role/*" } }
    }
  }
  expect_failures = [var.remote_write]
}

run "rejects_a_sigv4_region_that_is_not_one" {
  command = plan
  variables {
    runner_configs = { ci = { environment = "ci" } }
    remote_write = {
      url  = "https://aps-workspaces.eu-west-1.amazonaws.com/workspaces/ws-1/api/v1/remote_write"
      auth = { sigv4 = { region = "" } }
    }
  }
  expect_failures = [var.remote_write]
}

run "rejects_an_empty_sigv4_service" {
  command = plan
  variables {
    runner_configs = { ci = { environment = "ci" } }
    remote_write = {
      url  = "https://aps-workspaces.eu-west-1.amazonaws.com/workspaces/ws-1/api/v1/remote_write"
      auth = { sigv4 = { service = "" } }
    }
  }
  expect_failures = [var.remote_write]
}

run "rejects_an_external_id_sts_would_refuse" {
  command = plan
  variables {
    runner_configs = { ci = { environment = "ci" } }
    remote_write = {
      url  = "https://aps-workspaces.eu-west-1.amazonaws.com/workspaces/ws-1/api/v1/remote_write"
      auth = { sigv4 = { role_arn = "arn:aws:iam::210987654321:role/prometheus-writer", external_id = "x" } }
    }
  }
  expect_failures = [var.remote_write]
}

run "rejects_a_remote_write_header_the_client_sets" {
  command = plan
  variables {
    runner_configs = { ci = { environment = "ci" } }
    remote_write   = { url = "https://prometheus.example/api/v1/write", headers = { Host = "prometheus.internal" } }
  }
  expect_failures = [var.remote_write]
}

run "rejects_a_credential_in_a_plain_header" {
  command = plan
  variables {
    runner_configs = { ci = { environment = "ci" } }
    remote_write   = { url = "https://prometheus.example/api/v1/write", headers = { "X-Api-Key" = "s3cr3t" } }
  }
  expect_failures = [var.remote_write]
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

run "rejects_a_zip_given_both_ways" {
  command = plan
  variables {
    runner_configs = { ci = { environment = "ci" } }
    lambda_zip     = { path = "lambda.zip", s3 = { bucket = "b", key = "k", object_version = "v1" } }
  }
  expect_failures = [var.lambda_zip]
}

run "rejects_an_s3_zip_without_its_version" {
  command = plan
  variables {
    runner_configs = { ci = { environment = "ci" } }
    lambda_zip     = { s3 = { bucket = "b", key = "k", object_version = "" } }
  }
  expect_failures = [var.lambda_zip]
}

run "rejects_a_rate_eventbridge_rejects" {
  command = plan
  variables {
    runner_configs      = { ci = { environment = "ci" } }
    schedule_expression = "rate(1 minutes)"
  }
  expect_failures = [var.schedule_expression]
}

run "rejects_a_wildcard_secret_arn" {
  command = plan
  variables {
    runner_configs = { ci = { environment = "ci" } }
    github_app     = { source = "existing_secret", secret_arn = "arn:aws:secretsmanager:eu-west-1:123456789012:secret:*", owners = ["acme"] }
  }
  expect_failures = [var.github_app]
}

run "rejects_a_wildcard_kms_key" {
  command = plan
  variables {
    runner_configs       = { ci = { environment = "ci" } }
    secrets_kms_key_arns = ["arn:aws:kms:eu-west-1:123456789012:key/*"]
  }
  expect_failures = [var.secrets_kms_key_arns]
}

run "rejects_a_wildcard_log_and_environment_key" {
  command = plan
  variables {
    runner_configs = { ci = { environment = "ci" } }
    kms_key_arn    = "arn:aws:kms:eu-west-1:123456789012:key/*"
  }
  expect_failures = [var.kms_key_arn]
}

run "rejects_a_wildcard_remote_write_secret" {
  command = plan
  variables {
    runner_configs = { ci = { environment = "ci" } }
    remote_write = {
      url  = "https://prometheus.example/api/v1/write"
      auth = { basic = { secret_arn = "arn:aws:secretsmanager:eu-west-1:123456789012:secret:*" } }
    }
  }
  expect_failures = [var.remote_write]
}

run "requires_a_sigv4_region_off_aws_hostnames" {
  command = plan
  variables {
    runner_configs = { ci = { environment = "ci" } }
    remote_write   = { url = "https://prometheus.example/api/v1/write", auth = { sigv4 = {} } }
  }
  expect_failures = [var.remote_write]
}

run "rejects_an_external_id_without_a_role" {
  command = plan
  variables {
    runner_configs = { ci = { environment = "ci" } }
    remote_write = {
      url  = "https://aps-workspaces.eu-west-1.amazonaws.com/workspaces/ws-1/api/v1/remote_write"
      auth = { sigv4 = { external_id = "metrics" } }
    }
  }
  expect_failures = [var.remote_write]
}

run "rejects_a_control_character_in_a_header_value" {
  command = plan
  variables {
    runner_configs = { ci = { environment = "ci" } }
    remote_write   = { url = "https://prometheus.example/api/v1/write", headers = { "X-Scope-OrgID" = "ci\r\nX-Injected: 1" } }
  }
  expect_failures = [var.remote_write]
}

run "rejects_a_push_budget_out_of_range" {
  command = plan
  variables {
    runner_configs = { ci = { environment = "ci" } }
    remote_write   = { url = "https://prometheus.example/api/v1/write", timeout_seconds = 61 }
  }
  expect_failures = [var.remote_write]
}

run "rejects_a_source_budget_out_of_range" {
  command = plan
  variables {
    runner_configs         = { ci = { environment = "ci" } }
    source_timeout_seconds = 0
  }
  expect_failures = [var.source_timeout_seconds]
}

run "rejects_a_boot_grace_out_of_range" {
  command = plan
  variables {
    runner_configs     = { ci = { environment = "ci" } }
    boot_grace_seconds = 3601
  }
  expect_failures = [var.boot_grace_seconds]
}

run "rejects_a_github_server_url_with_a_path" {
  command = plan
  variables {
    runner_configs               = { ci = { environment = "ci" } }
    github_enterprise_server_url = "https://github.example.com/api/v3"
  }
  expect_failures = [var.github_enterprise_server_url]
}

run "rejects_an_owner_github_would_not_name" {
  command = plan
  variables {
    runner_configs = { ci = { environment = "ci" } }
    github_app     = { source = "existing_secret", secret_arn = "arn:aws:secretsmanager:eu-west-1:123456789012:secret:github-app-AbCdEf", owners = ["acme/*"] }
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
