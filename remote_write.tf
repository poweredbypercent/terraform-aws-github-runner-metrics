# Where the metrics go, and how the Lambda authenticates there.

locals {
  sigv4 = var.remote_write.auth.sigv4
  # The region in an AWS hostname: an AMP workspace URL, or an interface VPC endpoint for it. The
  # same pattern as the remote_write validation, which requires a region when this finds none.
  url_region = try(regex("^https://[^/]*\\.([a-z]{2}(?:-[a-z]+)+-[0-9]+)\\.(?:[a-z0-9-]+\\.)*amazonaws\\.com(?:\\.cn)?(?:[:/]|$)", var.remote_write.url)[0], null)

  remote_write_auth = (
    local.sigv4 != null ? {
      type        = "sigv4"
      region      = coalesce(local.sigv4.region, local.url_region)
      service     = local.sigv4.service
      role_arn    = local.sigv4.role_arn
      external_id = local.sigv4.external_id
      # Names this deployment in the writer account's CloudTrail.
      session_name = "${var.name_prefix}-${local.account}"
    } :
    var.remote_write.auth.basic != null ? { type = "basic", secret_arn = var.remote_write.auth.basic.secret_arn } :
    var.remote_write.auth.bearer != null ? { type = "bearer", secret_arn = var.remote_write.auth.bearer.secret_arn } :
    { type = "none" }
  )
  remote_write_secret_arn = try(local.remote_write_auth.secret_arn, null)
}
