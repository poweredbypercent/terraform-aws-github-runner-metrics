# ---------------------------------------------------------------------------------------------
# What to sample
# ---------------------------------------------------------------------------------------------

variable "runner_stacks" {
  description = <<-EOT
    Runner stacks built with terraform-aws-github-runner, passed straight from their outputs so
    nothing has to be copied by hand:

      { multi_runner = module.runners.runners_map }                     # modules/multi-runner
      { runners = module.runner.runners, queues = module.runner.queues } # the root module

    Each runner config's environment, runner cap, runner name prefix, queues and GitHub Enterprise
    Server URL are read from its scale-up Lambda's configuration. `name` is the runner_config label
    for a root-module stack (multi-runner stacks use their map keys); `labels` are added to that
    stack's series.
  EOT
  type = list(object({
    name         = optional(string)
    multi_runner = optional(any)
    runners      = optional(any)
    queues       = optional(any)
    labels       = optional(map(string), {})
  }))
  default = []

  validation {
    condition     = alltrue([for s in var.runner_stacks : (s.multi_runner == null) != (s.runners == null)])
    error_message = "Each runner_stacks entry sets exactly one of multi_runner (module.<multi-runner>.runners_map) or runners (module.<runner>.runners)."
  }

  validation {
    condition     = alltrue([for s in var.runner_stacks : s.queues == null || s.runners != null])
    error_message = "runner_stacks[].queues goes with runners (the root module), not with multi_runner."
  }

  validation {
    condition     = alltrue([for s in var.runner_stacks : s.name == null || can(regex("^[A-Za-z0-9_.-]+$", s.name))])
    error_message = "runner_stacks[].name may contain only letters, digits, '.', '-' and '_'."
  }
}

variable "runner_configs" {
  description = <<-EOT
    Runner configs given explicitly, for stacks whose outputs are not to hand (another state, another
    tool). The key is the runner_config label. `environment` is the stack's ghr:environment tag
    value; the queues default to "<environment>-queued-builds" and its "_dead_letter" queue in this
    account and region.
  EOT
  type = map(object({
    environment        = string
    max_runners        = optional(number, -1)
    runner_name_prefix = optional(string, "")
    github_api_url     = optional(string)
    queue_arns         = optional(list(string))
    labels             = optional(map(string), {})
  }))
  default = {}

  validation {
    condition     = alltrue([for name in keys(var.runner_configs) : can(regex("^[A-Za-z0-9_.-]+$", name))])
    error_message = "runner_configs keys may contain only letters, digits, '.', '-' and '_'."
  }

  validation {
    condition     = alltrue([for c in values(var.runner_configs) : can(regex("^[A-Za-z0-9_-]+$", c.environment))])
    error_message = "runner_configs[].environment may contain only letters, digits, '-' and '_' (it names the queues)."
  }

  validation {
    # The App's tokens are sent there.
    condition = alltrue([
      for c in values(var.runner_configs) :
      c.github_api_url == null || can(regex("^https://[^\\s/@?#]+(/[^\\s?#]*)?$", c.github_api_url))
    ])
    error_message = "runner_configs[].github_api_url must be an https:// URL without credentials or a query string."
  }
}

variable "labels" {
  description = "Constant labels added to every series, for example { cluster = \"ci\" }."
  type        = map(string)
  default     = {}

  validation {
    condition = alltrue([
      for k in keys(var.labels) :
      can(regex("^[a-zA-Z_][a-zA-Z0-9_]*$", k)) && !startswith(k, "__") &&
      !contains(["environment", "runner_config", "queue", "visibility", "instance_type", "lifecycle", "state", "runner_type", "organization", "repository", "source"], k)
    ])
    error_message = "labels keys must be Prometheus label names, not start with \"__\", and not reuse a built-in label."
  }
}

# ---------------------------------------------------------------------------------------------
# GitHub
# ---------------------------------------------------------------------------------------------

variable "github_app" {
  description = <<-EOT
    Where the GitHub App credentials that read registered runners (busy, idle, offline, booting)
    come from:

      create_secret     (default) the module creates an empty Secrets Manager secret; put
                        {"app_id": "...", "private_key": "<PEM>"} in it. Until then GitHub is skipped.
      existing_secret   a secret you manage, same JSON, in secret_arn.
      runner_ssm        the runner module's own App, from its SSM parameters. Works, but that App
                        can register runners: more access than reading them needs.
      disabled          no GitHub: queue, instance and capacity metrics only.

    The recommended App is dedicated and read-only: organisation "Self-hosted runners: Read", plus
    repository "Administration: Read" for repository-level runners.

    owners: the organisations or "owner/repo" targets to query. Set it: by default every one the
    runner instances' ghr:Owner tags name is queried, and a job that can tag its own instance can
    then point the App at another organisation it is installed on.

    A customer-managed key on an existing secret goes in secrets_kms_key_arns.
  EOT
  type = object({
    source                  = optional(string, "create_secret")
    secret_arn              = optional(string)
    recovery_window_in_days = optional(number, 30)
    ssm = optional(object({
      app_id_parameter_name             = string
      private_key_base64_parameter_name = string
    }))
    owners = optional(list(string), [])
  })
  default = {}

  validation {
    condition     = contains(["create_secret", "existing_secret", "runner_ssm", "disabled"], var.github_app.source)
    error_message = "github_app.source must be one of create_secret, existing_secret, runner_ssm, disabled."
  }

  validation {
    condition     = (var.github_app.source == "existing_secret") == (var.github_app.secret_arn != null)
    error_message = "github_app.secret_arn is required for, and only for, source = \"existing_secret\"."
  }

  validation {
    # It goes into the role's policy: a wildcard would grant every secret it matches.
    condition     = var.github_app.secret_arn == null || can(regex("^arn:aws[a-z-]*:secretsmanager:[a-z0-9-]+:[0-9]{12}:secret:[A-Za-z0-9/_+=.@-]+$", var.github_app.secret_arn))
    error_message = "github_app.secret_arn must be one secret's full ARN, without wildcards."
  }

  validation {
    condition     = alltrue([for o in var.github_app.owners : can(regex("^[A-Za-z0-9][A-Za-z0-9-]{0,38}(/[A-Za-z0-9._-]{1,100})?$", o))])
    error_message = "github_app.owners entries must be an organisation or \"owner/repo\"."
  }

  validation {
    condition     = var.github_app.ssm == null || var.github_app.source == "runner_ssm"
    error_message = "github_app.ssm only applies to source = \"runner_ssm\"."
  }

  validation {
    condition     = var.github_app.recovery_window_in_days == 0 || (var.github_app.recovery_window_in_days >= 7 && var.github_app.recovery_window_in_days <= 30)
    error_message = "github_app.recovery_window_in_days must be 0 or from 7 to 30."
  }
}

variable "github_enterprise_server_url" {
  description = "GitHub Enterprise Server base URL (e.g. https://github.example.com) for every stack, overriding what the runner stacks say. null: from each stack, else github.com."
  type        = string
  default     = null

  validation {
    condition     = var.github_enterprise_server_url == null || can(regex("^https://[^/]+/?$", var.github_enterprise_server_url))
    error_message = "github_enterprise_server_url must be an https:// base URL with no path."
  }
}

# ---------------------------------------------------------------------------------------------
# Where the metrics go
# ---------------------------------------------------------------------------------------------

variable "remote_write" {
  description = <<-EOT
    The Prometheus remote_write endpoint, and how to authenticate to it. At most one of:

      sigv4    Amazon Managed Service for Prometheus. role_arn: a writer role to assume (for a
               workspace in another account); without it the Lambda's own role signs, and needs
               aps:RemoteWrite (see additional_policy_json).
      basic    a Secrets Manager secret with {"username": "...", "password": "..."} (Grafana Cloud).
      bearer   a Secrets Manager secret with {"token": "..."} or the bare token.

    headers: plain, non-secret extras such as X-Scope-OrgID for Mimir; they are visible in the
    function's configuration, so never put credentials there.
  EOT
  type = object({
    url = string
    auth = optional(object({
      sigv4 = optional(object({
        region      = optional(string)
        service     = optional(string, "aps")
        role_arn    = optional(string)
        external_id = optional(string)
      }))
      basic  = optional(object({ secret_arn = string }))
      bearer = optional(object({ secret_arn = string }))
    }), {})
    headers         = optional(map(string), {})
    timeout_seconds = optional(number, 10)
  })

  validation {
    # Credentials or a token in the URL would end up in the function's configuration and logs.
    condition     = can(regex("^https?://[^\\s/@?#]+(/[^\\s?#]*)?$", var.remote_write.url))
    error_message = "remote_write.url must be an http(s) URL without credentials, a query string or a fragment."
  }

  validation {
    condition     = startswith(var.remote_write.url, "https://") || alltrue([for a in [var.remote_write.auth.sigv4, var.remote_write.auth.basic, var.remote_write.auth.bearer] : a == null])
    error_message = "remote_write.url must use https when remote_write.auth is set: plain http would send the credentials in the clear."
  }

  validation {
    condition = alltrue([
      for arn in [try(var.remote_write.auth.basic.secret_arn, null), try(var.remote_write.auth.bearer.secret_arn, null)] :
      arn == null || can(regex("^arn:aws[a-z-]*:secretsmanager:[a-z0-9-]+:[0-9]{12}:secret:[A-Za-z0-9/_+=.@-]+$", arn))
    ])
    error_message = "remote_write.auth basic/bearer secret_arn must be one secret's full ARN, without wildcards."
  }

  validation {
    condition     = length([for a in [var.remote_write.auth.sigv4, var.remote_write.auth.basic, var.remote_write.auth.bearer] : a if a != null]) <= 1
    error_message = "remote_write.auth sets at most one of sigv4, basic, bearer."
  }

  validation {
    condition = (
      var.remote_write.auth.sigv4 == null ||
      try(var.remote_write.auth.sigv4.region, null) != null ||
      can(regex("\\.([a-z0-9-]+)\\.amazonaws\\.com", var.remote_write.url))
    )
    error_message = "remote_write.auth.sigv4.region is required unless the URL names an AWS region."
  }

  validation {
    condition = (
      try(var.remote_write.auth.sigv4.role_arn, null) == null ||
      can(regex("^arn:aws[a-z-]*:iam::[0-9]{12}:role/.+", var.remote_write.auth.sigv4.role_arn))
    )
    error_message = "remote_write.auth.sigv4.role_arn must be an IAM role ARN."
  }

  validation {
    condition     = try(var.remote_write.auth.sigv4.external_id, null) == null || try(var.remote_write.auth.sigv4.role_arn, null) != null
    error_message = "remote_write.auth.sigv4.external_id needs role_arn."
  }

  validation {
    condition = alltrue([
      for name in keys(var.remote_write.headers) :
      can(regex("^[!#$%&'*+.^_`|~0-9A-Za-z-]+$", name)) &&
      !contains(["authorization", "content-encoding", "content-type", "content-length", "host", "user-agent", "x-prometheus-remote-write-version"], lower(name))
    ])
    error_message = "remote_write.headers must be valid header names and cannot override Authorization or the remote-write protocol headers."
  }

  validation {
    condition     = var.remote_write.timeout_seconds >= 1 && var.remote_write.timeout_seconds <= 60
    error_message = "remote_write.timeout_seconds must be from 1 to 60."
  }
}

# ---------------------------------------------------------------------------------------------
# The Lambda
# ---------------------------------------------------------------------------------------------

variable "lambda_zip" {
  description = <<-EOT
    The function code: a release zip of this module's version. Either a local file (path; use
    modules/download-lambda to fetch and verify one) or an object in S3. Pin the S3 object_version,
    or a changed object is not deployed.
  EOT
  type = object({
    path             = optional(string)
    source_code_hash = optional(string)
    s3 = optional(object({
      bucket         = string
      key            = string
      object_version = optional(string)
    }))
  })

  validation {
    condition     = (var.lambda_zip.path == null) != (var.lambda_zip.s3 == null)
    error_message = "lambda_zip sets exactly one of path or s3."
  }
}

variable "name_prefix" {
  description = "Names the function, role, schedule, log group and secret."
  type        = string
  default     = "github-runner-metrics"

  validation {
    condition     = can(regex("^[A-Za-z0-9_-]{1,40}$", var.name_prefix))
    error_message = "name_prefix must be 1-40 letters, digits, '-' or '_' (role names are limited to 64 characters)."
  }
}

variable "schedule_expression" {
  description = "How often to sample. One minute is the finest EventBridge allows and the recommended rate."
  type        = string
  default     = "rate(1 minute)"

  validation {
    condition     = can(regex("^(rate\\([1-9][0-9]* (minute|minutes|hour|hours)\\)|cron\\(.+\\))$", var.schedule_expression))
    error_message = "schedule_expression must be a rate(...) in minutes or hours, or a cron(...)."
  }
}

variable "schedule_enabled" {
  description = "Set false to pause sampling without destroying anything."
  type        = bool
  default     = true
}

variable "lambda_runtime" {
  description = "nodejs22.x works with every supported AWS provider; nodejs24.x needs one that knows it."
  type        = string
  default     = "nodejs22.x"

  validation {
    condition     = contains(["nodejs22.x", "nodejs24.x"], var.lambda_runtime)
    error_message = "lambda_runtime must be nodejs22.x or nodejs24.x, the runtimes the release is tested on."
  }
}

variable "lambda_architecture" {
  description = "arm64 or x86_64; the code is plain JavaScript and runs on either."
  type        = string
  default     = "arm64"

  validation {
    condition     = contains(["arm64", "x86_64"], var.lambda_architecture)
    error_message = "lambda_architecture must be arm64 or x86_64."
  }
}

variable "lambda_memory_size" {
  description = "Memory in MB. The bundled AWS SDK starts faster with a little more than the minimum."
  type        = number
  default     = 256

  validation {
    condition     = var.lambda_memory_size >= 128 && var.lambda_memory_size <= 10240
    error_message = "lambda_memory_size must be from 128 to 10240."
  }
}

variable "lambda_timeout" {
  description = "Seconds. Keep it under the schedule interval so samples never overlap, and long enough for a slow sample: 2 x source_timeout_seconds + remote_write.timeout_seconds + 5 (checks.tf)."
  type        = number
  default     = 45

  validation {
    condition     = var.lambda_timeout >= 10 && var.lambda_timeout <= 59
    error_message = "lambda_timeout must be from 10 to 59 seconds."
  }
}

variable "reserved_concurrent_executions" {
  description = "1 keeps samples from overlapping (remote write rejects out-of-order samples) and keeps the caches in one warm container. -1 removes the reservation, for accounts with no concurrency to spare."
  type        = number
  default     = 1

  validation {
    condition     = var.reserved_concurrent_executions == -1 || var.reserved_concurrent_executions >= 1
    error_message = "reserved_concurrent_executions must be -1 or at least 1."
  }
}

variable "source_timeout_seconds" {
  description = "Budget for each source (SQS, CloudWatch, EC2, GitHub) in each sample."
  type        = number
  default     = 10

  validation {
    condition     = var.source_timeout_seconds >= 1 && var.source_timeout_seconds <= 60
    error_message = "source_timeout_seconds must be from 1 to 60."
  }
}

variable "boot_grace_seconds" {
  description = "Instances younger than this are not counted as booting: they are always unregistered."
  type        = number
  default     = 30

  validation {
    condition     = var.boot_grace_seconds >= 0 && var.boot_grace_seconds <= 3600
    error_message = "boot_grace_seconds must be from 0 to 3600."
  }
}

variable "log_retention_in_days" {
  description = "CloudWatch Logs retention for the function's log group."
  type        = number
  default     = 30

  validation {
    condition     = contains([0, 1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653], var.log_retention_in_days)
    error_message = "log_retention_in_days must be a value CloudWatch Logs accepts (0 keeps logs forever)."
  }
}

variable "kms_key_arn" {
  description = "Customer-managed KMS key for the log group, the function's environment and the created secret. The key policy must allow logs.<region>.amazonaws.com. null: AWS-managed keys."
  type        = string
  default     = null
}

variable "secrets_kms_key_arns" {
  description = "Other customer-managed keys that encrypt secrets or parameters this module reads (an existing GitHub App secret, a remote-write credential, the runner module's SSM parameters)."
  type        = list(string)
  default     = []
}

variable "vpc_config" {
  description = "Run the function in a VPC. It needs outbound access to GitHub, the remote-write endpoint and the AWS APIs it calls (SQS, CloudWatch, EC2, Secrets Manager, SSM, STS)."
  type = object({
    subnet_ids         = list(string)
    security_group_ids = list(string)
  })
  default = null
}

variable "tracing_mode" {
  description = "X-Ray tracing: null (off), PassThrough or Active."
  type        = string
  default     = null

  validation {
    condition     = var.tracing_mode == null || contains(["PassThrough", "Active"], coalesce(var.tracing_mode, "Active"))
    error_message = "tracing_mode must be null, PassThrough or Active."
  }
}

variable "permissions_boundary_arn" {
  description = "Permissions boundary for the function's role."
  type        = string
  default     = null
}

variable "iam_role_path" {
  description = "Path for the function's role."
  type        = string
  default     = "/"

  validation {
    condition     = can(regex("^/([^/]+/)*$", var.iam_role_path))
    error_message = "iam_role_path must start and end with /."
  }
}

variable "additional_policy_json" {
  description = "Extra IAM policy for the function's role, for example aps:RemoteWrite on a same-account workspace when no sigv4.role_arn is used."
  type        = string
  default     = null
}

variable "tags" {
  description = "Tags for every resource."
  type        = map(string)
  default     = {}
}
