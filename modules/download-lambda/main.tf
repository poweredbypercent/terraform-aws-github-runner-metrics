terraform {
  required_version = ">= 1.5"
  required_providers {
    local = {
      source  = "hashicorp/local"
      version = ">= 2.2"
    }
  }
}

variable "release_tag" {
  description = "The exact release to download, e.g. v1.2.3. Floating tags (v1) are refused: the bytes behind them change."
  type        = string

  validation {
    condition     = can(regex("^v[0-9]+\\.[0-9]+\\.[0-9]+(-[0-9A-Za-z.-]+)?$", var.release_tag))
    error_message = "release_tag must be an exact version such as v1.2.3."
  }
}

variable "sha256" {
  description = "The zip's expected SHA-256 (hex), from the release notes. Recommended: it is the trust anchor; without it the release's own checksum file is used, which catches corruption but not a tampered release."
  type        = string
  default     = null

  validation {
    condition     = var.sha256 == null || can(regex("^[a-f0-9]{64}$", var.sha256))
    error_message = "sha256 must be 64 lower-case hex characters."
  }
}

variable "verify_attestation" {
  description = "Also verify the release's build-provenance attestation with `gh attestation verify` (needs the gh CLI, authenticated)."
  type        = bool
  default     = false
}

variable "repository" {
  description = "The GitHub repository releases are downloaded from."
  type        = string
  default     = "poweredbypercent/terraform-aws-github-runner-metrics"
}

variable "output_dir" {
  description = "Where to put the zip. Defaults to a directory beside this module."
  type        = string
  default     = null
}

locals {
  output_dir = coalesce(var.output_dir, "${path.module}/.build")
  zip_path   = "${local.output_dir}/terraform-aws-github-runner-metrics-${var.release_tag}.zip"
}

resource "terraform_data" "download" {
  # fileexists: a fresh checkout (CI) has no zip even though state says it was downloaded.
  triggers_replace = [var.release_tag, var.sha256, var.verify_attestation, var.repository, fileexists(local.zip_path)]

  provisioner "local-exec" {
    interpreter = ["bash", "-c"]
    command     = file("${path.module}/download.sh")
    environment = {
      REPOSITORY      = var.repository
      TAG             = var.release_tag
      OUT             = local.zip_path
      EXPECTED_SHA256 = coalesce(var.sha256, "")
      VERIFY          = tostring(var.verify_attestation)
    }
  }
}

data "local_file" "zip" {
  filename   = local.zip_path
  depends_on = [terraform_data.download]
}

output "path" {
  description = "The verified zip, for lambda_zip.path."
  value       = data.local_file.zip.filename
}

output "source_code_hash" {
  description = "The zip's base64 SHA-256, for lambda_zip.source_code_hash."
  value       = data.local_file.zip.content_base64sha256
}
