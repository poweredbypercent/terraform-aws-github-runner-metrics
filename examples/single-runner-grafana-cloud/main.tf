# Metrics for a stack built with the root module (one runner config), on AWS provider 5.x,
# pushed to Grafana Cloud with basic auth. The GitHub App's credentials are a secret you manage;
# the Lambda zip is copied to your own S3 bucket by your pipeline.

provider "aws" {
  region = var.aws_region
}

resource "random_id" "webhook_secret" {
  byte_length = 20
}

module "runner" {
  source  = "github-aws-runners/github-runner/aws"
  version = "6.5.9"

  aws_region = var.aws_region
  vpc_id     = var.vpc_id
  subnet_ids = var.subnet_ids
  prefix     = "ci"

  github_app = {
    id             = var.github_app.id
    key_base64     = var.github_app.key_base64
    webhook_secret = random_id.webhook_secret.hex
  }

  enable_organization_runners = true
  runners_maximum_count       = 10
}

module "runner_metrics" {
  source = "../.."
  # source = "github.com/poweredbypercent/terraform-aws-github-runner-metrics?ref=v0.1.0"

  # The root module outputs its queues as well.
  runner_stacks = [{
    name    = "ci"
    runners = module.runner.runners
    queues  = module.runner.queues
  }]

  github_app = {
    source     = "existing_secret"
    secret_arn = var.github_app_metrics_secret_arn
    owners     = var.github_owners
  }

  remote_write = {
    url  = var.grafana_cloud_remote_write_url
    auth = { basic = { secret_arn = var.grafana_cloud_credentials_secret_arn } }
  }

  lambda_zip = {
    s3 = {
      bucket         = var.lambda_bucket
      key            = "terraform-aws-github-runner-metrics/v0.1.0.zip"
      object_version = var.lambda_object_version
    }
  }
}
