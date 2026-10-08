/**
 * What CONFIG values must look like, as regular expression sources. The Terraform module refuses
 * the same values before it deploys, with these patterns written out in its own files
 * (variables.tf, validation.tf), and parity.test.ts finds each one there: the module cannot accept
 * a value the Lambda would reject on every invocation. They use only the syntax Terraform's RE2 and
 * JavaScript share: no \d, \w or \s, and no inline flags.
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
  /** The characters STS allows in an external id; its length, 2-1224, is checked apart. */
  externalId: '^[A-Za-z0-9_+=,./:@-]+$',
} as const

/** Headers the remote-write client sets itself; SigV4's own (x-amz-*) are the signer's. */
export const RESERVED_HEADERS: readonly string[] = [
  'authorization',
  'content-encoding',
  'content-type',
  'content-length',
  'host',
  'user-agent',
  'x-prometheus-remote-write-version',
]
