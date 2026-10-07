variable "aws_region" {
  description = "Region of the runner stack."
  type        = string
}

variable "vpc_id" {
  description = "VPC the runners run in."
  type        = string
}

variable "subnet_ids" {
  description = "Subnets the runners run in."
  type        = list(string)
}

variable "runner_lambda_zips_dir" {
  description = "Where the runner module's own Lambda zips (webhook, runners, runner-binaries-syncer) of release v7.11.0 were downloaded."
  type        = string
  default     = "lambdas"
}

variable "github_app" {
  description = "The runner module's GitHub App (it registers runners)."
  type = object({
    id         = string
    key_base64 = string
  })
  sensitive = true
}

variable "amp_remote_write_url" {
  description = "The AMP workspace's remote_write URL: https://aps-workspaces.<region>.amazonaws.com/workspaces/<id>/api/v1/remote_write"
  type        = string
}

variable "prometheus_writer_role_arn" {
  description = "A role in the workspace's account with aps:RemoteWrite, trusting module.runner_metrics.lambda_role_arn."
  type        = string
}

variable "metrics_release_sha256" {
  description = "SHA-256 of the release zip, from its release notes."
  type        = string
}

variable "github_owners" {
  description = "The organisations (or \"owner/repo\") the runners register in."
  type        = list(string)
}
