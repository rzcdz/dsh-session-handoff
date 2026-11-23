/**
 * Host half checks for @rzcdz/dsh-session-handoff.
 *
 * Drives `apply()` with a stub context: the routes are captured and called
 * through their real HTTP handler signatures, and the session calls are
 * recorded so the handoff sequence can be asserted.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../index.js'

let pass = 0
let fail = 0
function check(label, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) { pass++; return }
  fail++
  console.log(`FAIL ${label}\n  actual:   ${a}\n  expected: ${e}`)
}

/** Build a stub Host context capturing routes, tools, and session calls. */
function makeCtx() {
  const routes = new Map()
  const tools = new Map()
  const effects = []
  const created = []
  const renamed = []
  const prompted = []
  const pinned = []
  const ctx = {
    logger: { info() {}, warn() {} },
    webServer: {
      register(route) {
        routes.set(route.path, route.handler)
        return () => routes.delete(route.path)
      },
    },
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    workspaceRegistry: {
      list: () => [
        { id: 'ws-a', title: 'project-a', path: 'D:\\project-a' },
        { id: 'ws-b', title: 'project-b', path: 'D:\\project-b' },
      ],
      pinSession: async (sessionId) => {
        if (pinned.refuse === true) throw new Error('pin refused')
        pinned.push(sessionId)
      },
    },
    sessionController: {
      list: async () => ({ items: [{ sessionId: 's-old', updatedAt: 5, cwd: 'D:\\project-b' }] }),
      create: async (request) => {
        created.push(request)
        return { sessionId: `s-new-${created.length}` }
      },
      rename: async (request) => {
        renamed.push(request)
        return { title: request.title, seq: 1 }
      },
      prompt: async (request) => {
        prompted.push(request)
        return { accepted: true }
      },
    },
    effect(fn) {
      const dispose = fn()
      effects.push(dispose)
      return dispose
    },
  }
  return { ctx, routes, tools, created, renamed, prompted, pinned, effects }
}

/** Invoke a captured route with a synthetic request and response. */
async function hit(handler, body, method = 'POST') {
  const req = {
    method,
    on(event, listener) {
      if (event === 'data' && body !== undefined) listener(Buffer.from(JSON.stringify(body)))
      if (event === 'end') listener()
    },
    destroy() {},
  }
  const chunks = []
  const res = {
    writeHead() {},
    end(text) { chunks.push(text) },
  }
  handler(req, res)
  for (let i = 0; i < 200 && chunks.length === 0; i++) await new Promise(r => setTimeout(r, 5))
  return chunks.length === 0 ? null : JSON.parse(chunks[0])
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-test-'))
const { ctx, routes, tools, created, renamed, prompted, pinned, effects } = makeCtx()
apply(ctx, { storeDir: dir })

// --- initial state ---
let state = await hit(routes.get('/dsh-handoff/api/state'), undefined, 'GET')
check('default cron', state.cron, '40 15 * * 1-5')
check('default enabled', state.cronEnabled, true)
check('no entries', state.entries.length, 0)
check('workspaces listed', state.workspaces.map(w => w.id), ['ws-a', 'ws-b'])
check('three next runs', state.nextRuns.length, 3)

// --- invalid cron is rejected and does not overwrite ---
let bad = await hit(routes.get('/dsh-handoff/api/cron'), { cron: '99 * * * *' })
check('invalid cron rejected', bad.ok, false)
check('invalid cron keeps text', (await hit(routes.get('/dsh-handoff/api/state'), undefined, 'GET')).cron, '40 15 * * 1-5')

// --- never-firing cron is rejected ---
let never = await hit(routes.get('/dsh-handoff/api/cron'), { cron: '0 0 30 2 *' })
check('never-firing rejected', never.ok, false)

// --- valid cron saves ---
let good = await hit(routes.get('/dsh-handoff/api/cron'), { cron: '30 9 * * 1-5' })
check('valid cron accepted', good.ok, true)
check('valid cron stored', good.cron, '30 9 * * 1-5')

// --- cron switch ---
let off = await hit(routes.get('/dsh-handoff/api/cron'), { enabled: false })
check('cron disabled', off.cronEnabled, false)
check('cron text untouched', off.cron, '30 9 * * 1-5')
await hit(routes.get('/dsh-handoff/api/cron'), { enabled: true })

// --- create an entry in an explicit workspace ---
let made = await hit(routes.get('/dsh-handoff/api/entry'), {
  action: 'create',
  command: '@docs/HANDOFF.md run the handoff section',
  prefix: '任务',
  workspaceId: 'ws-b',
})
check('entry created', made.entries.length, 1)
check('entry workspace path', made.entries[0].workspacePath, 'D:\\project-b')
check('entry enabled by default', made.entries[0].enabled, true)
const firstId = made.entries[0].id

// --- empty command rejected ---
let empty = await hit(routes.get('/dsh-handoff/api/entry'), { action: 'create', command: '   ', prefix: 'x' })
check('empty command rejected', empty.ok, false)
check('still one entry', (await hit(routes.get('/dsh-handoff/api/state'), undefined, 'GET')).entries.length, 1)

// --- run now: create -> rename -> prompt, with tomorrow's date ---
let ran = await hit(routes.get('/dsh-handoff/api/entry'), { action: 'run', id: firstId })
check('run reported success', ran.succeeded, true)
check('created with workspace', created[0].workspaceId, 'ws-b')
check('created without cwd', created[0].cwd, undefined)
const tomorrow = new Date()
tomorrow.setDate(tomorrow.getDate() + 1)
const wantTitle = `任务${String(tomorrow.getMonth() + 1).padStart(2, '0')}${String(tomorrow.getDate()).padStart(2, '0')}`
check('renamed to prefix + tomorrow', renamed[0].title, wantTitle)
check('prompt sent after rename', prompted.length, 1)
check('prompt carries command', prompted[0].content[0].text, '@docs/HANDOFF.md run the handoff section')
check('prompt targets new session', prompted[0].sessionId, 's-new-1')
check('lastRun recorded', ran.entries[0].lastRun.ok, true)
check('lastRun title', ran.entries[0].lastRun.title, wantTitle)
// Pinning is what lifts the new session to the top of the sidebar.
check('new session pinned', pinned, ['s-new-1'])

// --- dedupe inside five minutes ---
let again = await hit(routes.get('/dsh-handoff/api/entry'), { action: 'run', id: firstId })
check('second run deduped', again.deduped, true)
check('no second session', created.length, 1)

// --- a refused pin must not fail the handoff it came with ---
pinned.refuse = true
await hit(routes.get('/dsh-handoff/api/entry'), { action: 'toggle', id: firstId, enabled: true })
const pinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-pin-'))
const pinCtx = makeCtx()
pinCtx.pinned.refuse = true
apply(pinCtx.ctx, { storeDir: pinDir })
const pinMade = await hit(pinCtx.routes.get('/dsh-handoff/api/entry'), {
  action: 'create', command: 'cmd', prefix: 'p', workspaceId: 'ws-a',
})
const pinRan = await hit(pinCtx.routes.get('/dsh-handoff/api/entry'), { action: 'run', id: pinMade.entries[0].id })
check('handoff survives a refused pin', pinRan.succeeded, true)
check('session still created', pinCtx.created.length, 1)
check('prompt still sent', pinCtx.prompted.length, 1)
for (const dispose of pinCtx.effects) dispose()
fs.rmSync(pinDir, { recursive: true, force: true })
pinned.refuse = false

// --- toggle off ---
let toggled = await hit(routes.get('/dsh-handoff/api/entry'), { action: 'toggle', id: firstId, enabled: false })
check('entry disabled', toggled.entries[0].enabled, false)

// --- update changes prefix and workspace ---
let updated = await hit(routes.get('/dsh-handoff/api/entry'), {
  action: 'update', id: firstId, prefix: '交接', workspaceId: 'ws-a',
})
check('prefix updated', updated.entries[0].prefix, '交接')
check('workspace path updated', updated.entries[0].workspacePath, 'D:\\project-a')

// --- second entry falls back to most recently active session workspace ---
let second = await hit(routes.get('/dsh-handoff/api/entry'), { action: 'create', command: 'x', prefix: 'a' })
check('fallback workspace id', second.entries[1].workspaceId, 'ws-b')
check('fallback workspace path', second.entries[1].workspacePath, 'D:\\project-b')

// --- delete ---
let deleted = await hit(routes.get('/dsh-handoff/api/entry'), { action: 'delete', id: second.entries[1].id })
check('entry deleted', deleted.entries.length, 1)

// --- persistence across a fresh apply ---
const second1 = makeCtx()
apply(second1.ctx, { storeDir: dir })
const reread = await hit(second1.routes.get('/dsh-handoff/api/state'), undefined, 'GET')
check('cron persisted', reread.cron, '30 9 * * 1-5')
check('entry persisted', reread.entries.length, 1)
check('prefix persisted', reread.entries[0].prefix, '交接')
check('disabled state persisted', reread.entries[0].enabled, false)

// --- corrupt file falls back to defaults ---
const corruptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-corrupt-'))
fs.writeFileSync(path.join(corruptDir, 'state.json'), '{not json', 'utf8')
const third = makeCtx()
apply(third.ctx, { storeDir: corruptDir })
const recovered = await hit(third.routes.get('/dsh-handoff/api/state'), undefined, 'GET')
check('corrupt file recovered', recovered.cron, '40 15 * * 1-5')
check('corrupt file empty list', recovered.entries.length, 0)

// --- tool surface ---
const tool = tools.get('handoff')
check('tool registered', tool !== undefined, true)
check('tool has output', typeof tool.output.render, 'function')
const toolResult = await tool.execute({ action: 'list' }, {})
check('tool list works', toolResult.cron, '30 9 * * 1-5')

// --- GET on a POST route is refused ---
const wrongMethod = await hit(routes.get('/dsh-handoff/api/cron'), undefined, 'GET')
check('GET refused on cron', wrongMethod.ok, false)

fs.rmSync(dir, { recursive: true, force: true })
fs.rmSync(corruptDir, { recursive: true, force: true })

// Every ticker and route registration must be released by the plugin disposers.
for (const dispose of effects) {
  try {
    dispose()
  } catch {
    // Already released.
  }
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
