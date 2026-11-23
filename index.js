/**
 * Daily session handoff.
 *
 * Host half: keeps the handoff list, the single shared cron schedule, and the
 * scheduler that performs a handoff when its minute arrives. The browser half
 * (`client.js`) reads and writes everything through the routes below.
 *
 * Routes (all JSON, all under `/dsh-handoff/api`):
 *   GET  /state              -> full page snapshot
 *   POST /cron               -> save the shared expression or its enabled switch
 *   POST /entry              -> create, update, delete, enable/disable, or run now
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { parseCron, nextRuns, matches } from './lib/cron.js'

export const name = 'session-handoff'
export const inject = ['webServer', 'sessionController', 'workspaceRegistry', 'tools']

/** How often the clock is compared with the expression. */
const TICK_MS = 20_000
/** A repeated trigger for the same entry inside this window is ignored. */
const DEDUPE_MS = 5 * 60 * 1000
/** Pause between two entries handled by one trigger. */
const ENTRY_GAP_MS = 1000
/** Delay before the first post-start tick, so session services are settled. */
const STARTUP_DELAY_MS = 5_000

/** A single handoff definition. */
function blankEntry() {
  return {
    id: randomUUID(),
    title: '',
    command: '',
    prefix: '',
    workspaceId: '',
    workspacePath: '',
    enabled: true,
    lastRun: null,
  }
}

/**
 * Build the state used before the first save.
 * @returns a fresh state document.
 */
function defaultState() {
  return {
    version: 1,
    cron: '40 15 * * 1-5',
    cronEnabled: true,
    entries: [],
  }
}

/**
 * Normalize a stored document, dropping anything unusable.
 * @param raw - the parsed file contents.
 * @returns a state document rooted in the defaults.
 */
function normalize(raw) {
  const base = defaultState()
  if (raw === null || typeof raw !== 'object') return base
  const state = {
    version: 1,
    cron: typeof raw.cron === 'string' ? raw.cron : base.cron,
    cronEnabled: raw.cronEnabled !== false,
    entries: [],
  }
  if (!Array.isArray(raw.entries)) return state
  for (const item of raw.entries) {
    if (item === null || typeof item !== 'object') continue
    state.entries.push({
      id: typeof item.id === 'string' && item.id.length > 0 ? item.id : randomUUID(),
      title: typeof item.title === 'string' ? item.title : '',
      command: typeof item.command === 'string' ? item.command : '',
      prefix: typeof item.prefix === 'string' ? item.prefix : '',
      workspaceId: typeof item.workspaceId === 'string' ? item.workspaceId : '',
      workspacePath: typeof item.workspacePath === 'string' ? item.workspacePath : '',
      enabled: item.enabled !== false,
      lastRun: item.lastRun !== null && typeof item.lastRun === 'object' && typeof item.lastRun.at === 'string'
        ? {
          at: item.lastRun.at,
          sessionId: typeof item.lastRun.sessionId === 'string' ? item.lastRun.sessionId : null,
          title: typeof item.lastRun.title === 'string' ? item.lastRun.title : '',
          ok: item.lastRun.ok === true,
          error: typeof item.lastRun.error === 'string' ? item.lastRun.error : null,
        }
        : null,
    })
  }
  return state
}

export function apply(ctx, config = {}) {
  const storeDir = config.storeDir ?? path.join(
    process.env.LOCALAPPDATA || os.tmpdir(), 'dsh-session-handoff',
  )
  const storeFile = path.join(storeDir, 'state.json')

  const log = (message) => ctx.logger?.info?.(`handoff: ${message}`)
  const warn = (message) => ctx.logger?.warn?.(`handoff: ${message}`)

  let state = defaultState()
  /** Minute key -> true, so one minute can only fire once. */
  let firedMinute = ''
  /** Entry id -> last trigger instant, for the dedupe window. */
  const lastTrigger = new Map()
  let running = false

  /** Read the state document from disk. */
  const load = () => {
    try {
      if (!fs.existsSync(storeFile)) return defaultState()
      return normalize(JSON.parse(fs.readFileSync(storeFile, 'utf8')))
    } catch (error) {
      warn(`could not read ${storeFile}: ${error?.message ?? error}`)
      return defaultState()
    }
  }

  /** Write the state document, replacing it atomically. */
  const save = () => {
    try {
      fs.mkdirSync(storeDir, { recursive: true })
      const temp = `${storeFile}.${process.pid}.tmp`
      fs.writeFileSync(temp, JSON.stringify(state, null, 2), 'utf8')
      fs.renameSync(temp, storeFile)
    } catch (error) {
      warn(`could not save ${storeFile}: ${error?.message ?? error}`)
      throw new Error(`保存失败：${error?.message ?? error}`)
    }
  }

  state = load()

  /** The parsed shared schedule, or null when the stored text is unusable. */
  const spec = () => parseCron(state.cron)

  /**
   * Build the next session title from a prefix.
   *
   * A handoff prepares the *next* trading day, so the date appended is
   * tomorrow's, not today's.
   * @param prefix - the user's text.
   * @param from - the trigger instant.
   * @returns the title to give the new session.
   */
  const titleFor = (prefix, from) => {
    const tomorrow = new Date(from.getTime())
    tomorrow.setDate(tomorrow.getDate() + 1)
    const month = String(tomorrow.getMonth() + 1).padStart(2, '0')
    const day = String(tomorrow.getDate()).padStart(2, '0')
    return `${prefix}${month}${day}`
  }

  /** Every workspace the registry knows, in sidebar order. */
  const workspaces = () => ctx.workspaceRegistry.list().map((workspace) => ({
    id: workspace.id,
    title: workspace.title,
    path: workspace.path,
  }))

  /**
   * Resolve the workspace one entry hands off into.
   *
   * The entry's own choice wins. Entries saved before the picker existed fall
   * back to the most recently active session's directory, then to the default
   * workspace, so an old entry still lands where the user was working.
   * @param entry - the handoff definition.
   * @returns the workspace id and its directory.
   */
  const resolveTarget = async (entry) => {
    const all = ctx.workspaceRegistry.list()
    if (entry.workspaceId !== '') {
      const chosen = all.find((workspace) => workspace.id === entry.workspaceId)
      if (chosen !== undefined) return { workspaceId: chosen.id, path: chosen.path }
    }
    try {
      const listed = await ctx.sessionController.list({}, new AbortController().signal)
      const sorted = [...listed.items].sort((a, b) => b.updatedAt - a.updatedAt)
      for (const item of sorted) {
        const cwd = item.cwd
        if (typeof cwd !== 'string' || cwd.length === 0) continue
        const owner = all.find((workspace) => workspace.path === cwd)
        if (owner !== undefined) return { workspaceId: owner.id, path: owner.path }
        return { workspaceId: '', path: cwd }
      }
    } catch (error) {
      warn(`could not read session list: ${error?.message ?? error}`)
    }
    for (const workspace of all) return { workspaceId: workspace.id, path: workspace.path }
    return { workspaceId: '', path: process.cwd() }
  }

  /**
   * Perform one handoff: create the session, pin it to the top, name it, then
   * send the command.
   * @param entry - the handoff definition.
   * @param now - the instant this handoff is attributed to.
   * @returns the created session and its title.
   */
  const performHandoff = async (entry, now) => {
    const target = await resolveTarget(entry)
    const created = await ctx.sessionController.create(
      target.workspaceId === '' ? { cwd: target.path } : { workspaceId: target.workspaceId },
    )
    // Pinning is what puts the new session at the top of the sidebar. It is a
    // convenience, so a refusal must not lose the handoff that already started.
    try {
      await ctx.workspaceRegistry.pinSession(created.sessionId)
    } catch (error) {
      warn(`could not pin ${created.sessionId}: ${error?.message ?? error}`)
    }
    const title = titleFor(entry.prefix === '' ? entry.title : entry.prefix, now)
    let accepted = title
    try {
      const renamed = await ctx.sessionController.rename({ sessionId: created.sessionId, title })
      accepted = renamed.title
    } catch (error) {
      warn(`could not rename ${created.sessionId}: ${error?.message ?? error}`)
    }
    await ctx.sessionController.prompt(
      {
        requestId: randomUUID(),
        sessionId: created.sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: entry.command }],
      },
      new AbortController().signal,
    )
    return { sessionId: created.sessionId, title: accepted }
  }

  /**
   * Run one entry and record the outcome on it.
   * @param entry - the handoff definition to run.
   * @param now - the attribution instant.
   * @returns whether the run succeeded.
   */
  const runEntry = async (entry, now) => {
    lastTrigger.set(entry.id, Date.now())
    try {
      const done = await performHandoff(entry, now)
      entry.lastRun = { at: now.toISOString(), sessionId: done.sessionId, title: done.title, ok: true, error: null }
      log(`handed off "${done.title}" (${done.sessionId})`)
      return true
    } catch (error) {
      const message = error?.message ?? String(error)
      entry.lastRun = { at: now.toISOString(), sessionId: null, title: '', ok: false, error: message }
      warn(`handoff of "${entry.title}" failed: ${message}`)
      return false
    } finally {
      save()
    }
  }

  /**
   * Handle one scheduled trigger: every enabled entry, in list order.
   *
   * Entries are spaced a second apart rather than awaited in full, because a
   * handoff's first turn takes tens of minutes and a shared trigger must not
   * make later entries wait for it.
   * @param now - the trigger instant.
   */
  const fire = async (now) => {
    if (running) return
    running = true
    try {
      const due = state.entries.filter((entry) => entry.enabled && entry.command.trim() !== '')
      for (const entry of due) {
        await runEntry(entry, now)
        if (entry !== due[due.length - 1]) await new Promise((resolve) => setTimeout(resolve, ENTRY_GAP_MS))
      }
    } finally {
      running = false
    }
  }

  /** Compare the clock with the expression and fire at most once per minute. */
  const tick = () => {
    if (!state.cronEnabled) return
    const current = spec()
    if (current === null) return
    const now = new Date()
    const key = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`
    if (key === firedMinute) return
    if (!matches(current, now)) {
      // A start outside the due minute must not replay a missed one.
      return
    }
    firedMinute = key
    void fire(now)
  }

  ctx.effect(() => {
    let timeout = null
    let interval = null
    const stop = () => {
      if (timeout !== null) {
        clearTimeout(timeout)
        timeout = null
      }
      if (interval !== null) {
        clearInterval(interval)
        interval = null
      }
    }
    timeout = setTimeout(() => {
      timeout = null
      tick()
      interval = setInterval(tick, TICK_MS)
    }, STARTUP_DELAY_MS)
    return () => {
      stop()
    }
  }, 'session-handoff: ticker')

  /** The page snapshot. */
  const snapshot = () => {
    const current = spec()
    return {
      cron: state.cron,
      cronEnabled: state.cronEnabled,
      cronValid: current !== null,
      nextRuns: current === null ? [] : nextRuns(current, new Date(), 3).map((date) => date.toISOString()),
      entries: state.entries.map((entry) => ({
        id: entry.id,
        title: entry.title,
        command: entry.command,
        prefix: entry.prefix,
        workspaceId: entry.workspaceId,
        workspacePath: entry.workspacePath,
        enabled: entry.enabled,
        lastRun: entry.lastRun,
        previewTitle: titleFor(entry.prefix === '' ? entry.title : entry.prefix, new Date()),
      })),
      workspaces: workspaces(),
      defaultWorkspaceId: state.entries.length === 0 ? '' : state.entries[0].workspaceId,
    }
  }

  const sendJson = (res, code, body) => {
    try {
      res.writeHead(code, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      })
      res.end(JSON.stringify(body))
    } catch {
      // Response already closed.
    }
  }

  /** Read a JSON request body with a hard size cap. */
  const readBody = (req) => new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 64 * 1024) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })

  const handleCron = async (req, res) => {
    const body = await readBody(req)
    if (typeof body.enabled === 'boolean' && body.cron === undefined) {
      state.cronEnabled = body.enabled
      save()
      sendJson(res, 200, { ok: true, ...snapshot() })
      return
    }
    if (typeof body.cron !== 'string') {
      sendJson(res, 400, { ok: false, error: '缺少 cron 表达式' })
      return
    }
    const candidate = parseCron(body.cron)
    if (candidate === null) {
      sendJson(res, 400, { ok: false, error: 'cron 表达式无效：需要 5 段（分 时 日 月 周）' })
      return
    }
    if (nextRuns(candidate, new Date(), 1).length === 0) {
      sendJson(res, 400, { ok: false, error: 'cron 表达式永远不会触发' })
      return
    }
    state.cron = body.cron.trim()
    if (typeof body.enabled === 'boolean') state.cronEnabled = body.enabled
    firedMinute = ''
    save()
    sendJson(res, 200, { ok: true, ...snapshot() })
  }

  const handleEntry = async (req, res) => {
    const body = await readBody(req)
    const action = body.action
    const index = state.entries.findIndex((entry) => entry.id === body.id)

    if (action === 'create') {
      const entry = blankEntry()
      entry.command = typeof body.command === 'string' ? body.command : ''
      entry.prefix = typeof body.prefix === 'string' ? body.prefix : ''
      entry.workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId : ''
      const workspace = workspaces().find((item) => item.id === entry.workspaceId)
      entry.workspacePath = workspace === undefined ? '' : workspace.path
      entry.title = titleFor(entry.prefix, new Date())
      if (entry.command.trim() === '') {
        sendJson(res, 400, { ok: false, error: '交接指令不能为空' })
        return
      }
      if (entry.workspaceId === '') {
        const target = await resolveTarget(entry)
        entry.workspaceId = target.workspaceId
        entry.workspacePath = target.path
      }
      state.entries.push(entry)
      save()
      sendJson(res, 200, { ok: true, ...snapshot() })
      return
    }

    if (action === 'update') {
      if (index < 0) {
        sendJson(res, 404, { ok: false, error: '条目不存在' })
        return
      }
      const entry = state.entries[index]
      if (typeof body.command === 'string' && body.command.trim() === '') {
        sendJson(res, 400, { ok: false, error: '交接指令不能为空' })
        return
      }
      if (typeof body.command === 'string') entry.command = body.command
      if (typeof body.prefix === 'string') {
        entry.prefix = body.prefix
        entry.title = titleFor(body.prefix, new Date())
      }
      if (typeof body.workspaceId === 'string') {
        entry.workspaceId = body.workspaceId
        const workspace = workspaces().find((item) => item.id === body.workspaceId)
        entry.workspacePath = workspace === undefined ? entry.workspacePath : workspace.path
      }
      save()
      sendJson(res, 200, { ok: true, ...snapshot() })
      return
    }

    if (action === 'delete') {
      if (index < 0) {
        sendJson(res, 404, { ok: false, error: '条目不存在' })
        return
      }
      state.entries.splice(index, 1)
      save()
      sendJson(res, 200, { ok: true, ...snapshot() })
      return
    }

    if (action === 'toggle') {
      if (index < 0) {
        sendJson(res, 404, { ok: false, error: '条目不存在' })
        return
      }
      state.entries[index].enabled = body.enabled === true
      save()
      sendJson(res, 200, { ok: true, ...snapshot() })
      return
    }

    if (action === 'run') {
      if (index < 0) {
        sendJson(res, 404, { ok: false, error: '条目不存在' })
        return
      }
      const entry = state.entries[index]
      const since = lastTrigger.get(entry.id)
      if (since !== undefined && Date.now() - since < DEDUPE_MS) {
        sendJson(res, 200, { ok: true, deduped: true, ...snapshot() })
        return
      }
      const now = new Date()
      const succeeded = await runEntry(entry, now)
      sendJson(res, 200, { ok: true, succeeded, ...snapshot() })
      return
    }

    sendJson(res, 400, { ok: false, error: `未知操作：${String(action)}` })
  }

  ctx.effect(() => {
    const disposers = []

    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-handoff/api/state',
      handler: (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          sendJson(res, 405, { ok: false, error: 'use GET' })
          return
        }
        try {
          sendJson(res, 200, { ok: true, ...snapshot() })
        } catch (error) {
          sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
        }
      },
    }))

    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-handoff/api/cron',
      handler: (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'use POST' })
          return
        }
        handleCron(req, res).catch((error) => {
          sendJson(res, 400, { ok: false, error: String(error?.message ?? error) })
        })
      },
    }))

    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-handoff/api/entry',
      handler: (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'use POST' })
          return
        }
        handleEntry(req, res).catch((error) => {
          sendJson(res, 400, { ok: false, error: String(error?.message ?? error) })
        })
      },
    }))

    return () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          // Already disposed.
        }
      }
    }
  }, 'session-handoff: routes')

  // Agent-facing control over the same list the page edits.
  ctx.effect(() => ctx.tools.register({
    name: 'handoff',
    description: 'Manage the daily session handoff list: list entries and the shared cron schedule, create or update an entry (command text, title prefix, target workspace), enable or disable it, delete it, or run one now. A handoff creates a new session in the chosen workspace, names it "<prefix><tomorrow MMDD>", and sends the command as its first message.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['list', 'create', 'update', 'delete', 'toggle', 'run'],
        description: 'Operation to perform.',
      },
      id: { type: 'string', description: 'Entry id. Required for update, delete, toggle, and run.' },
      command: { type: 'string', description: 'First message the new session receives, such as "@docs/HANDOFF.md run the handoff section".' },
      prefix: { type: 'string', description: 'Title prefix; the tomorrow date is appended automatically.' },
      workspaceId: { type: 'string', description: 'Target workspace id from the workspaces list. Omit to use the most recently active session workspace.' },
      enabled: { type: 'boolean', description: 'For toggle: whether the entry takes part in scheduled runs.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args) {
      const snapshotOf = () => snapshot()
      switch (args.action) {
        case 'list':
          return snapshotOf()
        case 'create': {
          if (typeof args.command !== 'string' || args.command.trim() === '') throw new Error('command is required')
          const entry = blankEntry()
          entry.command = args.command
          entry.prefix = typeof args.prefix === 'string' ? args.prefix : ''
          entry.title = titleFor(entry.prefix, new Date())
          let workspaceId = typeof args.workspaceId === 'string' ? args.workspaceId : ''
          let workspacePath = ''
          if (workspaceId === '') {
            const target = await resolveTarget(entry)
            workspaceId = target.workspaceId
            workspacePath = target.path
          } else {
            const chosen = workspaces().find((item) => item.id === workspaceId)
            workspacePath = chosen === undefined ? '' : chosen.path
          }
          entry.workspaceId = workspaceId
          entry.workspacePath = workspacePath
          state.entries.push(entry)
          save()
          return snapshotOf()
        }
        case 'update': {
          const entry = state.entries.find((item) => item.id === args.id)
          if (entry === undefined) throw new Error(`no entry with id ${String(args.id)}`)
          if (typeof args.command === 'string') entry.command = args.command
          if (typeof args.prefix === 'string') {
            entry.prefix = args.prefix
            entry.title = titleFor(args.prefix, new Date())
          }
          if (typeof args.workspaceId === 'string') {
            entry.workspaceId = args.workspaceId
            const chosen = workspaces().find((item) => item.id === args.workspaceId)
            entry.workspacePath = chosen === undefined ? '' : chosen.path
          }
          save()
          return snapshotOf()
        }
        case 'delete': {
          const index = state.entries.findIndex((item) => item.id === args.id)
          if (index < 0) throw new Error(`no entry with id ${String(args.id)}`)
          state.entries.splice(index, 1)
          save()
          return snapshotOf()
        }
        case 'toggle': {
          const entry = state.entries.find((item) => item.id === args.id)
          if (entry === undefined) throw new Error(`no entry with id ${String(args.id)}`)
          entry.enabled = args.enabled === true
          save()
          return snapshotOf()
        }
        case 'run': {
          const entry = state.entries.find((item) => item.id === args.id)
          if (entry === undefined) throw new Error(`no entry with id ${String(args.id)}`)
          const succeeded = await runEntry(entry, new Date())
          return { succeeded, ...snapshotOf() }
        }
        default:
          throw new Error(`unknown action ${String(args.action)}`)
      }
    },
  }), 'session-handoff: tool')
}
