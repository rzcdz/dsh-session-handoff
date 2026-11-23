/**
 * Minimal five-field cron parsing for the handoff scheduler.
 *
 * Supported syntax per field: `*`, `* / n`, `a-b`, `a-b/n`, `a,b,c`, and the
 * usual three-letter month and weekday names. Weekday `0` and `7` both mean
 * Sunday. There is no seconds field, no `?`, no `L`, no `#`.
 *
 * Day-of-month and day-of-week follow the classic cron rule: when both are
 * restricted, a day matches if either one does.
 */

const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

/** Inclusive bounds and display names for the five fields, in cron order. */
const FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12, names: MONTH_NAMES, nameBase: 1 },
  { name: 'day of week', min: 0, max: 6, names: DAY_NAMES, nameBase: 0, sundayAlias: true },
]

/**
 * Read one numeric token, accepting a three-letter name where the field allows one.
 * @param token - raw text from the expression.
 * @param field - the field descriptor being parsed.
 * @returns the number, or undefined when the token is not a valid value.
 */
function readValue(token, field) {
  const text = token.trim().toLowerCase()
  if (text.length === 0) return undefined
  if (/^\d+$/.test(text)) {
    const value = Number(text)
    if (value < field.min || value > field.max) {
      if (field.sundayAlias && value === 7) return 0
      return undefined
    }
    return value
  }
  if (field.names !== undefined) {
    const index = field.names.indexOf(text)
    if (index >= 0) return field.nameBase + index
  }
  return undefined
}

/**
 * Expand one comma-separated field into the set of values it selects.
 * @param source - the field text, already known to be non-empty.
 * @param field - the field descriptor being parsed.
 * @returns the selected values, or null when any part is invalid.
 */
function expandField(source, field) {
  const values = new Set()
  for (const part of source.split(',')) {
    const piece = part.trim()
    if (piece.length === 0) return null

    const slash = piece.split('/')
    if (slash.length > 2) return null
    const rangeText = slash[0].trim()
    let step = 1
    if (slash.length === 2) {
      if (!/^\d+$/.test(slash[1].trim())) return null
      step = Number(slash[1].trim())
      if (step < 1) return null
    }

    let start
    let end
    if (rangeText === '*') {
      start = field.min
      end = field.max
    } else if (rangeText.includes('-')) {
      const bounds = rangeText.split('-')
      if (bounds.length !== 2) return null
      start = readValue(bounds[0], field)
      end = readValue(bounds[1], field)
      if (start === undefined || end === undefined) return null
      if (start > end) return null
    } else {
      start = readValue(rangeText, field)
      if (start === undefined) return null
      // A bare value with a step means "from this value to the maximum".
      end = slash.length === 2 ? field.max : start
    }

    for (let value = start; value <= end; value += step) values.add(value)
  }
  return values.size === 0 ? null : values
}

/**
 * Parse a five-field cron expression.
 * @param expression - the user's expression text.
 * @returns the parsed spec, or null when the expression cannot be used.
 */
export function parseCron(expression) {
  if (typeof expression !== 'string') return null
  const fields = expression.trim().split(/\s+/)
  if (fields.length !== 5) return null
  const sets = []
  for (let index = 0; index < 5; index++) {
    const expanded = expandField(fields[index], FIELDS[index])
    if (expanded === null) return null
    sets.push(expanded)
  }
  return {
    expression: expression.trim(),
    minutes: sets[0],
    hours: sets[1],
    daysOfMonth: sets[2],
    months: sets[3],
    daysOfWeek: sets[4],
    dayOfMonthRestricted: fields[2].trim() !== '*',
    dayOfWeekRestricted: fields[4].trim() !== '*',
  }
}

/**
 * Whether one instant satisfies the parsed expression.
 * @param spec - a parsed cron spec.
 * @param date - the instant to test, in local time.
 * @returns whether the instant belongs to the schedule.
 */
export function matches(spec, date) {
  if (!spec.minutes.has(date.getMinutes())) return false
  if (!spec.hours.has(date.getHours())) return false
  if (!spec.months.has(date.getMonth() + 1)) return false
  const dayOfMonthHit = spec.daysOfMonth.has(date.getDate())
  const dayOfWeekHit = spec.daysOfWeek.has(date.getDay())
  if (spec.dayOfMonthRestricted && spec.dayOfWeekRestricted) return dayOfMonthHit || dayOfWeekHit
  if (spec.dayOfMonthRestricted) return dayOfMonthHit
  if (spec.dayOfWeekRestricted) return dayOfWeekHit
  return true
}

/**
 * List the next instants the expression selects.
 *
 * Scans forward one minute at a time because that is exactly what the timer
 * does, so a preview can never disagree with what will actually fire. The
 * scan stops after a year, which is far beyond any useful preview and keeps a
 * never-matching expression such as `0 0 30 2 *` cheap to reject.
 * @param spec - a parsed cron spec.
 * @param from - the instant to search forward from.
 * @param count - how many instants to collect.
 * @returns the next instants in ascending order, in local time.
 */
export function nextRuns(spec, from, count = 3) {
  const results = []
  const cursor = new Date(from.getTime())
  cursor.setSeconds(0, 0)
  cursor.setMinutes(cursor.getMinutes() + 1)
  const limit = cursor.getTime() + 366 * 24 * 60 * 60 * 1000
  while (results.length < count && cursor.getTime() <= limit) {
    if (matches(spec, cursor)) results.push(new Date(cursor.getTime()))
    cursor.setMinutes(cursor.getMinutes() + 1)
  }
  return results
}
