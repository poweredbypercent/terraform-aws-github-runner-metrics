/** Prometheus label names: letters, digits and underscores, not starting with a digit. */
export const LABEL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/

/** Labels the metrics set themselves; constant labels may not reuse them. */
export const BUILT_IN_LABELS: readonly string[] = [
  'environment',
  'runner_config',
  'queue',
  'visibility',
  'instance_type',
  'lifecycle',
  'state',
  'runner_type',
  'organization',
  'repository',
  'source',
]

/** Why a constant label name is not acceptable, or undefined when it is. */
export function invalidLabelName(name: string): string | undefined {
  if (!LABEL_NAME.test(name)) return 'is not a valid Prometheus label name'
  if (name.startsWith('__')) return 'starts with "__", which Prometheus reserves'
  if (BUILT_IN_LABELS.includes(name)) return 'is a built-in label'
  return undefined
}
