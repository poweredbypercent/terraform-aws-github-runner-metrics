terraform {
  required_version = ">= 1.5"
  required_providers {
    external = {
      source  = "hashicorp/external"
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
  description = "The zip's expected SHA-256 (hex), from the release notes: the trust anchor. Set this, verify_attestation, or both."
  type        = string
  default     = null

  validation {
    condition     = var.sha256 == null || can(regex("^[a-f0-9]{64}$", var.sha256))
    error_message = "sha256 must be 64 lower-case hex characters."
  }
}

variable "verify_attestation" {
  description = "Verify the release's build-provenance attestation with `gh attestation verify`: signed by the repository's release workflow, for this tag, on a GitHub-hosted runner. Needs the gh CLI, authenticated, wherever Terraform plans."
  type        = bool
  default     = false
}

variable "repository" {
  description = "The GitHub repository releases are downloaded from."
  type        = string
  default     = "poweredbypercent/terraform-aws-github-runner-metrics"

  validation {
    condition     = can(regex("^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$", var.repository))
    error_message = "repository must be \"owner/name\"."
  }
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

# A data source rather than a resource: it runs on every plan, so the zip on disk is verified each
# time (not trusted because state says it was downloaded once), and the script only downloads when
# that zip is missing or does not verify.
data "external" "zip" {
  program = [
    "bash", "${path.module}/download.sh",
    var.repository, var.release_tag, local.zip_path, var.sha256 == null ? "" : var.sha256, tostring(var.verify_attestation),
  ]

  lifecycle {
    precondition {
      condition     = var.sha256 != null || var.verify_attestation
      error_message = "Set sha256 (from the release notes) or verify_attestation: without one, nothing anchors trust in the release."
    }
  }
}

output "path" {
  description = "The verified zip, for lambda_zip.path."
  value       = data.external.zip.result.path
}

output "source_code_hash" {
  description = "The zip's base64 SHA-256, for lambda_zip.source_code_hash."
  value       = filebase64sha256(data.external.zip.result.path)
}
