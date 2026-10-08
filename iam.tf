# What the role may read, generated from the inputs: a statement exists only when its feature is
# used, and names exactly the queues, secrets, parameters and keys in the configuration. None may
# be a wildcard: the secrets, keys and role are validated as variables, and the queues and
# parameters, which a runner stack can supply, by the preconditions on the policy document.
locals {
  secret_arns = compact([local.github_secret_arn, local.remote_write_secret_arn])
  ssm_parameter_arns = local.github_ssm_parameters == null ? [] : [
    for name in compact(values(local.github_ssm_parameters)) :
    "arn:${local.partition}:ssm:${local.region}:${local.account}:parameter/${trimprefix(name, "/")}"
  ]
  kms_key_arns = distinct(compact(concat([var.kms_key_arn], var.secrets_kms_key_arns)))
}

data "aws_iam_policy_document" "assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
    # No aws:SourceAccount / aws:SourceArn condition: Lambda does not document setting them when it
    # assumes an execution role, and a condition it does not satisfy leaves the function unable to
    # start. Giving a function this role needs iam:PassRole on it in this account.
  }
}

resource "aws_iam_role" "lambda" {
  name                 = "${var.name_prefix}-lambda"
  path                 = var.iam_role_path
  assume_role_policy   = data.aws_iam_policy_document.assume.json
  permissions_boundary = var.permissions_boundary_arn
  tags                 = var.tags
}

data "aws_iam_policy_document" "lambda" {
  lifecycle {
    precondition {
      condition     = length(local.rejected.queue_arns) == 0
      error_message = "Every runner config needs a main queue, and its queues must be SQS queue ARNs without wildcards (a derived main queue is <environment>-queued-builds, at most 80 characters): ${join(", ", local.rejected.queue_arns)}."
    }
    precondition {
      condition     = length(local.rejected.ssm_parameter_names) == 0
      error_message = "The GitHub App's SSM parameters must be parameter names, without wildcards: ${join(", ", local.rejected.ssm_parameter_names)}."
    }
  }

  statement {
    sid       = "AllowWriteLogs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.lambda.arn}:*"]
  }

  # An empty resource list is an invalid policy; a precondition on the function (main.tf) reports
  # the missing runner configs.
  dynamic "statement" {
    for_each = length(local.queue_arns) > 0 ? [1] : []
    content {
      sid       = "AllowReadQueueDepth"
      actions   = ["sqs:GetQueueAttributes"]
      resources = local.queue_arns
    }
  }

  statement {
    # GetMetricData and DescribeInstances support no resource-level permissions; the region they
    # are asked in can be limited, to the one this module samples.
    sid       = "AllowReadQueueAgeAndRunnerInstances"
    actions   = ["cloudwatch:GetMetricData", "ec2:DescribeInstances"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "aws:RequestedRegion"
      values   = [local.region]
    }
  }

  dynamic "statement" {
    for_each = length(local.secret_arns) > 0 ? [1] : []
    content {
      sid       = "AllowReadCredentials"
      actions   = ["secretsmanager:GetSecretValue"]
      resources = local.secret_arns
    }
  }

  dynamic "statement" {
    for_each = length(local.ssm_parameter_arns) > 0 ? [1] : []
    content {
      sid       = "AllowReadRunnerModuleGitHubApp"
      actions   = ["ssm:GetParameter"]
      resources = local.ssm_parameter_arns
    }
  }

  dynamic "statement" {
    for_each = length(local.kms_key_arns) > 0 ? [1] : []
    content {
      sid       = "AllowDecrypt"
      actions   = ["kms:Decrypt"]
      resources = local.kms_key_arns
      # Only through the services that hold this module's encrypted data (Secrets Manager, SSM, and
      # Lambda for its environment), not any ciphertext under a shared key.
      condition {
        test     = "StringEquals"
        variable = "kms:ViaService"
        values = [
          "lambda.${local.region}.${local.dns_suffix}",
          "secretsmanager.${local.region}.${local.dns_suffix}",
          "ssm.${local.region}.${local.dns_suffix}",
        ]
      }
    }
  }

  dynamic "statement" {
    for_each = try(local.sigv4.role_arn, null) != null ? [1] : []
    content {
      sid       = "AllowAssumePrometheusWriter"
      actions   = ["sts:AssumeRole"]
      resources = [local.sigv4.role_arn]
    }
  }
}

resource "aws_iam_role_policy" "lambda" {
  name   = "${var.name_prefix}-lambda"
  role   = aws_iam_role.lambda.id
  policy = data.aws_iam_policy_document.lambda.json
}

resource "aws_iam_role_policy" "additional" {
  count  = var.additional_policy_json == null ? 0 : 1
  name   = "${var.name_prefix}-additional"
  role   = aws_iam_role.lambda.id
  policy = var.additional_policy_json
}

resource "aws_iam_role_policy_attachment" "vpc" {
  count      = var.vpc_config == null ? 0 : 1
  role       = aws_iam_role.lambda.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

resource "aws_iam_role_policy_attachment" "xray" {
  count      = var.tracing_mode == null ? 0 : 1
  role       = aws_iam_role.lambda.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/AWSXRayDaemonWriteAccess"
}
