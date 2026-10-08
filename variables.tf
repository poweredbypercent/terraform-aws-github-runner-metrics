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
    of a root-module stack, and required for one (multi-runner stacks use their map keys); `labels`
    are added to that stack's series.
  EOT
  type = list(object({
    name         = optional(string)
    multi_runner = optional(any)
    runners      = optional(any)
    queues       = optional(any)
    labels       = optional(map(string), {})
  }))
  default  = []
  nullable = false

  validation {
    condition     = alltrue([for s in var.runner_stacks : (s.multi_runner == null) != (s.runners == null)])
    error_message = "Each runner_stacks entry sets exactly one of multi_runner (module.<multi-runner>.runners_map) or runners (module.<runner>.runners)."
  }

  validation {
    condition     = alltrue([for s in var.runner_stacks : s.queues == null || s.runners != null])
    error_message = "runner_stacks[].queues goes with runners (the root module), not with multi_runner."
  }

  validation {
    # A position-derived name would change, and rename every series, when the list is reordered.
    condition     = alltrue([for s in var.runner_stacks : s.runners == null || s.name != null])
    error_message = "runner_stacks[].name is required for a root-module stack (runners): it is the runner_config label of its series."
  }
}

variable "runner_configs" {
  description = <<-EOT
    Runner configs given explicitly, for stacks whose outputs are not to hand (another state, another
    tool). The key is the runner_config label (letters, digits, '.', '-' and '_'). `environment` is
    the stack's ghr:environment tag value (letters, digits, '-' and '_'). `queues` defaults to
    "<environment>-queued-builds" and its "_dead_letter" queue in this account and region; give
    them for queues named otherwise, as { main = "<ARN>", dead_letter = "<ARN>" } with dead_letter
    optional, never a wildcard. `max_runners` is -1 (unlimited) or 0-100000. `github_api_url` is
    an https URL. `labels` are added to this runner config's series (Prometheus label names, not a
    built-in label, non-empty values).

    These rules hold for runner configs read from runner_stacks too, so they are checked once, on
    both, at plan (or at apply, for values only known then).
  EOT
  type = map(object({
    environment        = string
    max_runners        = optional(number, -1)
    runner_name_prefix = optional(string, "")
    github_api_url     = optional(string)
    queues = optional(object({
      main        = string
      dead_letter = optional(string)
    }))
    labels = optional(map(string), {})
  }))
  default  = {}
  nullable = false
}

variable "labels" {
  description = "Constant labels added to every series, for example { cluster = \"ci\" }: Prometheus label names, not a built-in label, non-empty values."
  type        = map(string)
  default     = {}
  nullable    = false
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

    owners (required unless disabled): the organisations or "owner/repo" targets to query; matched
    without regard to case. The instances' ghr:Owner tags say where each runner registers, and a
    job that can tag its own instance could otherwise point the App at another organisation it is
    installed on.

    ssm (runner_ssm only): the runner module's parameter names, { app_id_parameter_name,
    private_key_base64_parameter_name }, when they cannot be read from the runner stacks. Never
    wildcards: the role is granted exactly those parameters.

    recovery_window_in_days (create_secret only): how long a destroyed secret can be restored, 0 or
    7-30. While it lasts, its name cannot be used again, so a destroy and re-apply of the same
    name_prefix fails; set 0 where that matters.

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
  default  = {}
  nullable = false

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
    # The instances' tags name the scopes to query, and a job may be able to set its own
    # instance's tags; the allowlist keeps the App to the organisations meant.
    condition     = var.github_app.source == "disabled" || length(var.github_app.owners) > 0
    error_message = "github_app.owners must list the organisations (or \"owner/repo\") your runners register in, unless GitHub is disabled."
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
  description = "GitHub Enterprise Server base URL (e.g. https://github.example.com) for every stack, overriding what the runner stacks say; the GitHub App's tokens are sent there, so set it to pin that when others maintain the stacks. null: from each stack, else github.com."
  type        = string
  default     = null

  validation {
    condition     = var.github_enterprise_server_url == null || can(regex("^https://[A-Za-z0-9_.-]+(:[0-9]{1,5})?/?$", var.github_enterprise_server_url))
    error_message = "github_enterprise_server_url must be an https:// base URL with no path."
  }
}

# ---------------------------------------------------------------------------------------------
# Where the metrics go
# ---------------------------------------------------------------------------------------------

variable "remote_write" {
  description = <<-EOT
    The Prometheus remote_write endpoint, and how to authenticate to it.

    url: the endpoint itself (a redirect is not followed), http or https, without credentials, a
    query string or a fragment. https whenever auth is set. The host is a name or an IPv4 address
    (a non-ASCII name in its xn-- form); IPv6 literals are not accepted.

    auth, at most one of:

      sigv4    Amazon Managed Service for Prometheus. region: read from an AWS hostname (an AMP or
               VPC endpoint URL) when not given. service: "aps" by default. role_arn: a writer role
               to assume (for a workspace in another account), with external_id if its trust
               policy requires one; without a role the Lambda's own role signs, and needs
               aps:RemoteWrite (see additional_policy_json).
      basic    a Secrets Manager secret with {"username": "...", "password": "..."} (Grafana Cloud).
      bearer   a Secrets Manager secret with {"token": "..."} or the bare token.

    headers: plain, non-secret extras such as X-Scope-OrgID for Mimir. They are visible in the
    function's configuration, so a header named like a credential (key, token, secret, auth...)
    is refused, as are the headers the client sets itself.

    timeout_seconds: how long a push may take, its one retry included (1-60, default 10). It has to
    fit in lambda_timeout with the sources' budgets (see lambda_timeout).
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
    condition     = can(regex("^https?://[A-Za-z0-9_.-]+(:[0-9]{1,5})?(/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*)?$", var.remote_write.url))
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
    # The same pattern as local.url_region (remote_write.tf), which reads the region.
    condition = (
      var.remote_write.auth.sigv4 == null ||
      try(var.remote_write.auth.sigv4.region, null) != null ||
      can(regex("^https://[^/]*\\.([a-z]{2}(?:-[a-z]+)+-[0-9]+)\\.(?:[a-z0-9-]+\\.)*amazonaws\\.com(?:\\.cn)?(?:[:/]|$)", var.remote_write.url))
    )
    error_message = "remote_write.auth.sigv4.region is required unless the URL is an AWS hostname naming a region."
  }

  validation {
    condition = (
      try(var.remote_write.auth.sigv4.region, null) == null ||
      can(regex("^[a-z0-9-]+$", var.remote_write.auth.sigv4.region))
    )
    error_message = "remote_write.auth.sigv4.region must be an AWS region name, such as eu-west-1."
  }

  validation {
    condition     = var.remote_write.auth.sigv4 == null || can(regex("^[a-z0-9-]+$", var.remote_write.auth.sigv4.service))
    error_message = "remote_write.auth.sigv4.service must be the signing name of an AWS service, such as aps."
  }

  validation {
    # It goes into the role's policy: a wildcard would let it assume every role it matches.
    condition = (
      try(var.remote_write.auth.sigv4.role_arn, null) == null ||
      can(regex("^arn:aws[a-z-]*:iam::[0-9]{12}:role/[A-Za-z0-9/_+=,.@-]+$", var.remote_write.auth.sigv4.role_arn))
    )
    error_message = "remote_write.auth.sigv4.role_arn must be one IAM role's ARN, without wildcards."
  }

  validation {
    condition     = try(var.remote_write.auth.sigv4.external_id, null) == null || try(var.remote_write.auth.sigv4.role_arn, null) != null
    error_message = "remote_write.auth.sigv4.external_id needs role_arn."
  }

  validation {
    # What STS accepts. A conditional, not ||: length(null) fails, and Terraform before 1.12
    # evaluates both sides of ||.
    condition = try(var.remote_write.auth.sigv4.external_id, null) == null ? true : (
      can(regex("^[A-Za-z0-9_+=,./:@-]+$", var.remote_write.auth.sigv4.external_id)) &&
      length(var.remote_write.auth.sigv4.external_id) >= 2 && length(var.remote_write.auth.sigv4.external_id) <= 1224
    )
    error_message = "remote_write.auth.sigv4.external_id must be 2-1224 letters, digits or _+=,./:@-."
  }

  validation {
    condition = alltrue([
      for name in keys(var.remote_write.headers) :
      can(regex("^[!#$%&'*+.^_`|~0-9A-Za-z-]+$", name)) &&
      !contains(["authorization", "content-encoding", "content-type", "content-length", "host", "user-agent", "x-prometheus-remote-write-version"], lower(name)) &&
      !startswith(lower(name), "x-amz-")
    ])
    error_message = "remote_write.headers must be valid header names and cannot override Authorization, the remote-write protocol headers or SigV4's x-amz-* headers."
  }

  validation {
    # They are visible in the function's configuration: credentials belong in basic or bearer auth.
    condition     = alltrue([for name in keys(var.remote_write.headers) : !can(regex("key|token|secret|passw|credential|auth|cookie|session", lower(name)))])
    error_message = "remote_write.headers looks like it carries a credential: use remote_write.auth basic or bearer, which keep it in a secret."
  }

  validation {
    condition     = alltrue([for value in values(var.remote_write.headers) : can(regex("^[ -~]+$", value))])
    error_message = "remote_write.headers values must be non-empty, printable and on one line."
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
    modules/download-lambda to fetch and verify one) or an object in S3, pinned by its
    object_version: the function runs with access to the GitHub App's key, so it deploys exactly the
    object you verified, and a new version is deployed by changing it.

    source_code_hash (path only): the zip's base64 SHA-256, for a zip that does not exist yet at
    plan (modules/download-lambda outputs it). Without it the file is hashed at plan.
  EOT
  type = object({
    path             = optional(string)
    source_code_hash = optional(string)
    s3 = optional(object({
      bucket         = string
      key            = string
      object_version = string
    }))
  })
  nullable = false

  validation {
    condition     = (var.lambda_zip.path == null) != (var.lambda_zip.s3 == null)
    error_message = "lambda_zip sets exactly one of path or s3."
  }

  validation {
    # An empty version is no version: the provider would deploy whatever object is latest.
    condition     = var.lambda_zip.s3 == null || can(regex("^\\S+$", var.lambda_zip.s3.object_version))
    error_message = "lambda_zip.s3.object_version must be the object's version id."
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
    # EventBridge wants the singular for 1 and the plural above it.
    condition     = can(regex("^(rate\\(1 (minute|hour)\\)|rate\\(([2-9]|[1-9][0-9]+) (minutes|hours)\\)|cron\\(.+\\))$", var.schedule_expression))
    error_message = "schedule_expression must be rate(1 minute), rate(N minutes), rate(1 hour), rate(N hours) or a cron(...)."
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
  description = "Seconds, 10-59. Keep it under the schedule interval so samples never overlap, and long enough for a slow sample: at least 2 x source_timeout_seconds + remote_write.timeout_seconds + 5, which the module enforces. That bounds the other two: a source budget of 26 seconds at most, a push budget of 52."
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
  description = "Budget for each source (SQS, CloudWatch, EC2, GitHub) in each sample, 1-60; it has to fit in lambda_timeout with the push (see lambda_timeout)."
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
  description = "Customer-managed KMS key ARN for the log group, the function's environment and the created secret. The key policy must allow logs.<region>.amazonaws.com. null: AWS-managed keys."
  type        = string
  default     = null

  validation {
    # It goes into the role's policy: a wildcard would let it decrypt with every key it matches.
    condition     = var.kms_key_arn == null || can(regex("^arn:aws[a-z-]*:kms:[a-z0-9-]+:[0-9]{12}:key/[A-Za-z0-9-]+$", var.kms_key_arn))
    error_message = "kms_key_arn must be one key's ARN (arn:...:key/<id>), without wildcards."
  }
}

variable "secrets_kms_key_arns" {
  description = "Other customer-managed key ARNs that encrypt secrets or parameters this module reads (an existing GitHub App secret, a remote-write credential, the runner module's SSM parameters)."
  type        = list(string)
  default     = []
  nullable    = false

  validation {
    condition     = alltrue([for arn in var.secrets_kms_key_arns : can(regex("^arn:aws[a-z-]*:kms:[a-z0-9-]+:[0-9]{12}:key/[A-Za-z0-9-]+$", arn))])
    error_message = "secrets_kms_key_arns must be keys' ARNs (arn:...:key/<id>), without wildcards."
  }
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
  nullable    = false
}
