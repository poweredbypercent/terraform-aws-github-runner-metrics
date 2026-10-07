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
  nullable    = false
}

variable "repository" {
  description = "The GitHub repository releases are downloaded from."
  type        = string
  default     = "poweredbypercent/terraform-aws-github-runner-metrics"
  nullable    = false

  validation {
    condition     = can(regex("^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$", var.repository))
    error_message = "repository must be \"owner/name\"."
  }
}

variable "output_dir" {
  description = "Where to put the zip. Defaults to a directory beside this module (inside .terraform/modules when the module is fetched, so a fresh init downloads it again)."
  type        = string
  default     = null

  validation {
    # The path is printed back as JSON by the script; keep it plain.
    condition     = var.output_dir == null || can(regex("^[^\"\\\\[:cntrl:]]+$", var.output_dir))
    error_message = "output_dir must not contain quotes, backslashes or control characters."
  }
}
