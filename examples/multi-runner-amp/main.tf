# Metrics for a multi-runner stack, pushed to Amazon Managed Service for Prometheus in another
# account through a writer role. See README.md for the writer role's trust and the GitHub App.

provider "aws" {
  region = var.aws_region
}

resource "random_id" "webhook_secret" {
  byte_length = 20
}

# A runner stack as terraform-aws-github-runner documents it (lambda zips and AMIs omitted: see
# that module's examples).
module "runners" {
  source  = "github-aws-runners/github-runner/aws//modules/multi-runner"
  version = "7.11.0"

  aws_region = var.aws_region
  vpc_id     = var.vpc_id
  subnet_ids = var.subnet_ids
  prefix     = "ci"

  github_app = {
    id             = var.github_app.id
    key_base64     = var.github_app.key_base64
    webhook_secret = random_id.webhook_secret.hex
  }

  multi_runner_config = {
    linux = {
      matcherConfig = {
        labelMatchers = [["self-hosted", "linux", "x64"]]
        exactMatch    = true
      }
      redrive_build_queue = { enabled = true, maxReceiveCount = 5 }
      runner_config = {
        runner_os                = "linux"
        runner_architecture      = "x64"
        runner_name_prefix       = "linux"
        instance_types           = ["m7i.large", "m6i.large"]
        runners_maximum_count    = 20
        enable_ephemeral_runners = true
      }
    }
  }
}

# The sampler's code: an exact release, verified against the checksum in its release notes.
module "metrics_lambda" {
  source = "../../modules/download-lambda"
  # source = "github.com/poweredbypercent/terraform-aws-github-runner-metrics//modules/download-lambda?ref=v0.1.0"

  release_tag = "v0.1.0"
  sha256      = var.metrics_release_sha256
}

module "runner_metrics" {
  source = "../.."
  # source = "github.com/poweredbypercent/terraform-aws-github-runner-metrics?ref=v0.1.0"

  # Everything about the runner configs is read from the stack's own outputs.
  runner_stacks = [{ multi_runner = module.runners.runners_map }]

  # A dedicated read-only App, in the secret the module creates; only these targets are queried.
  github_app = { owners = var.github_owners }

  remote_write = {
    url = var.amp_remote_write_url
    auth = {
      sigv4 = { role_arn = var.prometheus_writer_role_arn }
    }
  }

  lambda_zip = {
    path             = module.metrics_lambda.path
    source_code_hash = module.metrics_lambda.source_code_hash
  }

  labels = { cluster = "ci" }
}
