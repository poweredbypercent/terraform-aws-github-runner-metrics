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
  description = "Where the runner module's own Lambda zips (webhook, runners, runner-binaries-syncer) of release v6.5.9 were downloaded."
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

variable "github_app_metrics_secret_arn" {
  description = "A secret holding the read-only metrics App: {\"app_id\": \"...\", \"private_key\": \"<PEM>\"}."
  type        = string
}

variable "grafana_cloud_remote_write_url" {
  description = "From your Grafana Cloud stack's Prometheus details: https://prometheus-prod-<n>-prod-<region>.grafana.net/api/prom/push"
  type        = string
}

variable "grafana_cloud_credentials_secret_arn" {
  description = "A secret holding {\"username\": \"<instance id>\", \"password\": \"<access policy token with metrics:write>\"}."
  type        = string
}

variable "lambda_bucket" {
  description = "Bucket your pipeline copies the verified release zip to."
  type        = string
}

variable "lambda_object_version" {
  description = "The zip object's version, so a new upload is deployed."
  type        = string
}

variable "github_owners" {
  description = "The organisations (or \"owner/repo\") the runners register in."
  type        = list(string)
}
