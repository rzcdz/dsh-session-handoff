import { parseCron, nextRuns, matches } from './lib/cron.js'

let pass = 0
let fail = 0
function check(label, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) { pass++; return }
  fail++
  console.log(`FAIL ${label}\n  actual:   ${a}\n  expected: ${e}`)
}

// --- acceptance ---
check('plain five fields', parseCron('40 15 * * 1-5') !== null, true)
check('four fields rejected', parseCron('40 15 * *'), null)
check('six fields rejected', parseCron('0 40 15 * * 1-5'), null)
check('step on star', parseCron('*/15 * * * *') !== null, true)
check('range with step', parseCron('10-30/5 9-17 * * *') !== null, true)
check('list', parseCron('0 8,12,18 * * *') !== null, true)
check('names', parseCron('0 9 * jan-mar mon-fri') !== null, true)
check('bad minute', parseCron('60 * * * *'), null)
check('bad hour', parseCron('* 24 * * *'), null)
check('bad dow', parseCron('* * * * 8'), null)
check('zero step', parseCron('*/0 * * * *'), null)
check('reversed range', parseCron('30-10 * * * *'), null)
check('garbage', parseCron('abc * * * *'), null)
check('empty', parseCron('   '), null)
check('sunday alias 7', parseCron('0 3 * * 7') !== null, true)

// --- matches / next ---
const spec = parseCron('40 15 * * 1-5')
const base = new Date(2026, 10, 23, 18, 49, 0) // Mon 2026-11-23 18:49 local
const runs = nextRuns(spec, base, 3)
check('three runs', runs.map(d => d.toISOString().slice(0, 10)), ['2026-11-24', '2026-11-25', '2026-11-26'])
check('three runs time', runs.map(d => `${d.getHours()}:${d.getMinutes()}`), ['15:40', '15:40', '15:40'])

// Friday 15:40 -> next is Monday
const fri = new Date(2026, 10, 27, 15, 41, 0)
const afterFri = nextRuns(spec, fri, 1)
check('friday rolls to monday', afterFri[0].getDay(), 1)

// Sunday excluded by 1-5
const sat = new Date(2026, 10, 28, 20, 0, 0)
check('sunday skipped', nextRuns(spec, sat, 1)[0].getDay(), 1)

// never-matching expression terminates
const never = parseCron('0 0 30 2 *')
check('feb 30 never runs', nextRuns(never, base, 1).length, 0)

// dom OR dow rule: "0 9 1 * 1" fires on the 1st or any Monday
const orSpec = parseCron('0 9 1 * 1')
check('dom-or-dow on 1st', matches(orSpec, new Date(2026, 11, 1, 9, 0, 0)), true) // Tue Dec 1
check('dom-or-dow on monday', matches(orSpec, new Date(2026, 11, 7, 9, 0, 0)), true)
check('dom-or-dow neither', matches(orSpec, new Date(2026, 11, 2, 9, 0, 0)), false)

// date rollover across a month boundary
const eom = parseCron('0 0 1 * *')
const eomRuns = nextRuns(eom, new Date(2026, 11, 31, 12, 0, 0), 1)
check('month rollover', eomRuns[0].getMonth(), 0)

console.log(`\n${pass} passed, ${fail} failed`)
process.exitCode = fail === 0 ? 0 : 1
