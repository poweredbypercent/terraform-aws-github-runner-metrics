data "aws_iam_policy_document" "assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
    # Only Lambda acting for this account may assume the role.
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account]
    }
  }
}

resource "aws_iam_role" "lambda" {
  name                 = "${var.name_prefix}-lambda"
  path                 = var.iam_role_path
  assume_role_policy   = data.aws_iam_policy_document.assume.json
  permissions_boundary = var.permissions_boundary_arn
  tags                 = var.tags
}

locals {
  secret_arns = compact([local.github_secret_arn, local.remote_write_secret_arn])
  ssm_parameter_arns = local.github_ssm_parameters == null ? [] : [
    for name in values(local.github_ssm_parameters) :
    "arn:${local.partition}:ssm:${local.region}:${local.account}:parameter/${trimprefix(name, "/")}"
  ]
  kms_key_arns = distinct(compact(concat([var.kms_key_arn, var.github_app.kms_key_arn], var.secrets_kms_key_arns)))
}

# Least privilege, generated from the inputs: a statement exists only when its feature is used.
data "aws_iam_policy_document" "lambda" {
  statement {
    sid       = "AllowWriteLogs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.lambda.arn}:*"]
  }

  statement {
    sid       = "AllowReadQueueDepth"
    actions   = ["sqs:GetQueueAttributes"]
    resources = local.queue_arns
  }

  statement {
    # GetMetricData and DescribeInstances support no resource-level permissions.
    sid       = "AllowReadQueueAgeAndRunnerInstances"
    actions   = ["cloudwatch:GetMetricData", "ec2:DescribeInstances"]
    resources = ["*"]
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
