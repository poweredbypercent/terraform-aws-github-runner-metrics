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
