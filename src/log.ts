import type { Logger } from './ports.ts'

/** One JSON line per event, so CloudWatch Logs Insights can query the fields. */
export const jsonLogger: Logger = (level, message, fields = {}) => {
  const line = JSON.stringify({ level, message, ...fields })
  if (level === 'info') console.log(line)
  else console.error(line)
}
