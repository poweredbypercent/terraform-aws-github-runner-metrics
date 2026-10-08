/**
 * What CONFIG values must be: their patterns, as regular expression sources, their numeric limits
 * and the headers no one may set. The Terraform module refuses the same values before it deploys,
 * with these rules written out in its own files (variables.tf, validation.tf), and parity.test.ts
 * holds the two copies to each other: the module cannot accept a value the Lambda would reject on
 * every invocation. The patterns use only the syntax Terraform's RE2 and JavaScript share: no \d,
 * \w or \s, and no inline flags. Label names are the domain's (src/domain/labels.ts).
 */
export const PATTERNS = {
  /** A runner config's name: its runner_config label. */
  runnerConfigName: '^[A-Za-z0-9_.-]+$',
  /** A runner stack's ghr:environment, which also names its queues. */
  environment: '^[A-Za-z0-9_-]+$',
  /** Standard queues (up to 80 characters) or FIFO queues (the same, `.fifo` included). */
  sqsQueueArn:
    '^arn:aws[a-z-]*:sqs:[a-z0-9-]+:[0-9]{12}:([A-Za-z0-9_-]{1,80}|[A-Za-z0-9_-]{1,75}\\.fifo)$',
  /** One secret, never a wildcard: the role's grant is scoped to exactly what is named. */
  secretArn: '^arn:aws[a-z-]*:secretsmanager:[a-z0-9-]+:[0-9]{12}:secret:[A-Za-z0-9/_+=.@-]+$',
  roleArn: '^arn:aws[a-z-]*:iam::[0-9]{12}:role/[A-Za-z0-9/_+=,.@-]+$',
  /** No credentials, query string or fragment in it: those would end up in logs and errors. */
  endpointUrl: "^https?://[A-Za-z0-9_.-]+(:[0-9]{1,5})?(/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*)?$",
  /** An organisation, or "owner/repo", as GitHub names them. */
  owner: '^[A-Za-z0-9][A-Za-z0-9-]{0,38}(/[A-Za-z0-9._-]{1,100})?$',
  headerName: "^[!#$%&'*+.^_`|~0-9A-Za-z-]+$",
  /** Matched against the lower-cased name: a header named like a credential belongs in a secret. */
  credentialHeader: 'key|token|secret|passw|credential|auth|cookie|session',
  /** Visible ASCII and spaces: a control character would make every request fail. */
  headerValue: '^[ -~]+$',
  /** A SigV4 signing region or service. */
  awsName: '^[a-z0-9-]+$',
  /** The characters STS allows in an external id; its length is a limit below. */
  externalId: '^[A-Za-z0-9_+=,./:@-]+$',
} as const

/** Inclusive bounds. */
export const LIMITS = {
  /** A runner config's runner cap; -1, unlimited, is apart. */
  maxRunners: { min: 0, max: 100_000 },
  /** The push's budget, and each source's. */
  timeoutSeconds: { min: 1, max: 60 },
  bootGraceSeconds: { min: 0, max: 3600 },
  /** STS's bounds on an external id. */
  externalIdLength: { min: 2, max: 1224 },
} as const

/** Headers the remote-write client sets itself. */
export const RESERVED_HEADERS: readonly string[] = [
  'authorization',
  'content-encoding',
  'content-type',
  'content-length',
  'host',
  'user-agent',
  'x-prometheus-remote-write-version',
]
/** SigV4's own headers (x-amz-date, x-amz-security-token, ...) are the signer's to set. */
export const RESERVED_HEADER_PREFIX = 'x-amz-'
