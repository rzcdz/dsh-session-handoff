/**
 * Browser half of the daily handoff bundle.
 *
 * One sidebar page holds the shared cron schedule and the list of handoffs.
 * Everything is read and written through the Host routes in `index.js`; this
 * module owns only presentation and form state.
 */

window.__ModuleLoader__.load({
  id: '@rzcdz/dsh-session-handoff',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const PANEL_ID = 'session-handoff'
    const API = '/dsh-handoff/api'

    /**
     * Call one Host route.
     * @param name - route name under the API prefix.
     * @param body - JSON payload for POST requests.
     * @returns the parsed response.
     */
    async function call(name, body) {
      const res = await fetch(`${API}/${name}`, body === undefined
        ? { method: 'GET' }
        : {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
      let payload
      try {
        payload = await res.json()
      } catch {
        throw new Error(`HTTP ${res.status}`)
      }
      if (payload.error !== undefined) throw new Error(payload.error)
      if (!res.ok && payload.ok !== true) throw new Error(payload.error ?? `HTTP ${res.status}`)
      return payload
    }

    /**
     * Format an ISO instant as a short local date and time.
     * @param iso - the instant, or null.
     * @returns the display text.
     */
    function stamp(iso) {
      if (typeof iso !== 'string' || iso === '') return ''
      const date = new Date(iso)
      if (Number.isNaN(date.getTime())) return ''
      const month = String(date.getMonth() + 1).padStart(2, '0')
      const day = String(date.getDate()).padStart(2, '0')
      const hour = String(date.getHours()).padStart(2, '0')
      const minute = String(date.getMinutes()).padStart(2, '0')
      return `${month}-${day} ${hour}:${minute}`
    }

    /**
     * Format an instant as a full local timestamp.
     * @param iso - the instant, or null.
     * @returns the display text.
     */
    function fullStamp(iso) {
      if (typeof iso !== 'string' || iso === '') return ''
      const date = new Date(iso)
      if (Number.isNaN(date.getTime())) return ''
      const month = String(date.getMonth() + 1).padStart(2, '0')
      const day = String(date.getDate()).padStart(2, '0')
      const hour = String(date.getHours()).padStart(2, '0')
      const minute = String(date.getMinutes()).padStart(2, '0')
      return `${date.getFullYear()}-${month}-${day} ${hour}:${minute}`
    }

    /**
     * Compute the title an entry would get if it ran right now.
     * @param prefix - the entry's prefix.
     * @returns prefix plus tomorrow's month and day.
     */
    function previewTitle(prefix) {
      const tomorrow = new Date()
      tomorrow.setDate(tomorrow.getDate() + 1)
      const month = String(tomorrow.getMonth() + 1).padStart(2, '0')
      const day = String(tomorrow.getDate()).padStart(2, '0')
      return `${prefix}${month}${day}`
    }

    const CSS = `
      .hf-page {
        display: flex; flex-direction: column;
        width: 100%; height: 100%; min-height: 0;
        overflow: auto; box-sizing: border-box;
        padding: 22px 24px 32px;
        color: var(--dsw-alias-text-primary, #1f2328);
        font: 13px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif;
      }
      .hf-head { display: flex; align-items: center; gap: 10px; }
      .hf-h1 { font-size: 17px; font-weight: 650; }
      .hf-sub {
        font-size: 12.5px; margin: 4px 0 18px;
        color: var(--dsw-alias-text-secondary, #6b7280);
      }
      .hf-block {
        max-width: 1000px;
        padding: 14px 16px; border-radius: 12px;
        background: var(--dsw-alias-bg-subtle, #f7f8fa);
        border: 1px solid var(--dsw-alias-border-default, #e6e9ee);
        margin-bottom: 18px;
      }
      .hf-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
      .hf-label {
        font-weight: 600; font-size: 13px; min-width: 42px;
      }
      .hf-input {
        flex: 1; min-width: 220px; box-sizing: border-box;
        padding: 7px 10px; border-radius: 8px;
        border: 1px solid var(--dsw-alias-border-default, #dfe3e9);
        background: var(--dsw-alias-bg-base, #fff);
        color: var(--dsw-alias-text-primary, #1f2328);
        font: inherit;
      }
      .hf-input:focus {
        outline: none;
        border-color: var(--dsw-alias-border-strong, #9aa1ab);
      }
      .hf-mono { font-family: ui-monospace, Menlo, Consolas, monospace; }
      .hf-btn {
        padding: 6px 14px; border-radius: 8px; cursor: pointer;
        border: 1px solid var(--dsw-alias-border-default, #dfe3e9);
        background: var(--dsw-alias-bg-base, #fff);
        color: var(--dsw-alias-text-primary, #1f2328);
        font: inherit; white-space: nowrap;
      }
      .hf-btn:hover:not(:disabled) { background: var(--dsw-alias-bg-subtle, #f1f3f6); }
      .hf-btn:disabled { opacity: .55; cursor: progress; }
      .hf-btn.primary {
        background: var(--dsw-alias-accent, #2f6fed);
        border-color: var(--dsw-alias-accent, #2f6fed);
        color: #fff;
      }
      .hf-btn.primary:hover:not(:disabled) { filter: brightness(.94); }
      .hf-btn.danger { color: #d84a3a; }
      .hf-active {
        display: inline-flex; align-items: center; gap: 7px;
        font-size: 12.5px; cursor: pointer; user-select: none;
        color: var(--dsw-alias-text-secondary, #55606e);
      }
      .hf-switch {
        position: relative; width: 38px; height: 22px; flex: none;
        border-radius: 999px; border: 0; cursor: pointer; padding: 0;
        background: var(--dsw-alias-border-strong, #c9ced6);
        transition: background .16s ease;
      }
      .hf-switch[aria-checked="true"] { background: #2f6fed; }
      .hf-switch::after {
        content: ""; position: absolute; top: 3px; left: 3px;
        width: 16px; height: 16px; border-radius: 50%;
        background: #fff; transition: transform .16s ease;
        box-shadow: 0 1px 3px rgba(0,0,0,.24);
      }
      .hf-switch[aria-checked="true"]::after { transform: translateX(16px); }
      .hf-switch:disabled { opacity: .55; cursor: progress; }
      .hf-next {
        margin-top: 9px; font-size: 12.5px;
        color: var(--dsw-alias-text-secondary, #6b7280);
      }
      .hf-next code {
        font-family: ui-monospace, Menlo, Consolas, monospace;
        background: var(--dsw-alias-bg-base, #fff);
        border: 1px solid var(--dsw-alias-border-default, #e6e9ee);
        padding: 1px 6px; border-radius: 5px; margin-right: 6px;
        display: inline-block; margin-bottom: 3px;
      }
      .hf-listhead {
        display: flex; align-items: center; justify-content: space-between;
        gap: 12px; margin-bottom: 10px;
      }
      .hf-count { font-size: 12.5px; color: var(--dsw-alias-text-secondary, #6b7280); }
      .hf-card {
        max-width: 1000px;
        padding: 13px 15px; border-radius: 12px; margin-bottom: 10px;
        background: var(--dsw-alias-bg-base, #fff);
        border: 1px solid var(--dsw-alias-border-default, #e6e9ee);
      }
      .hf-card.off { opacity: .66; }
      .hf-cardtop { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; }
      .hf-dot {
        width: 9px; height: 9px; border-radius: 50%; flex: none;
        background: var(--dsw-alias-border-strong, #c9ced6);
      }
      .hf-dot.on { background: #22c55e; }
      .hf-title { font-weight: 620; font-size: 13.5px; }
      .hf-tag {
        font-size: 11.5px; padding: 1px 7px; border-radius: 5px;
        background: var(--dsw-alias-bg-subtle, #f1f3f6);
        color: var(--dsw-alias-text-secondary, #6b7280);
      }
      .hf-spacer { flex: 1; }
      .hf-cmd {
        margin-top: 7px; font-size: 12.5px;
        font-family: ui-monospace, Menlo, Consolas, monospace;
        color: var(--dsw-alias-text-secondary, #55606e);
        white-space: pre-wrap; word-break: break-all;
      }
      .hf-meta {
        margin-top: 7px; font-size: 12px;
        color: var(--dsw-alias-text-tertiary, #9aa1ab);
        display: flex; gap: 14px; flex-wrap: wrap; align-items: center;
      }
      .hf-err {
        margin-top: 10px; font-size: 12.5px; color: #d84a3a;
        white-space: pre-wrap;
      }
      .hf-empty {
        max-width: 1000px; padding: 26px 16px; text-align: center;
        border-radius: 12px; font-size: 13px;
        border: 1px dashed var(--dsw-alias-border-default, #dfe3e9);
        color: var(--dsw-alias-text-secondary, #6b7280);
      }
      .hf-form {
        max-width: 1000px; padding: 16px; border-radius: 12px;
        border: 1px solid var(--dsw-alias-accent, #2f6fed);
        background: var(--dsw-alias-bg-subtle, #f7f8fa);
      }
      .hf-field { margin-bottom: 12px; }
      .hf-fieldlabel {
        font-size: 12.5px; font-weight: 600; margin-bottom: 5px;
      }
      .hf-hint {
        font-size: 12px; margin-top: 5px;
        color: var(--dsw-alias-text-tertiary, #9aa1ab);
      }
      .hf-actions { display: flex; gap: 9px; justify-content: flex-end; margin-top: 4px; }
      .hf-open {
        border: 0; background: none; padding: 0; cursor: pointer;
        font: inherit; font-size: 12px; text-decoration: underline;
        color: var(--dsw-alias-accent, #2f6fed);
      }
      select.hf-input { cursor: pointer; }
    `

    function Styles() {
      return h('style', null, CSS)
    }

    function Mark({ size }) {
      const s = size || 16
      return h('svg', {
        width: s, height: s, viewBox: '0 0 24 24',
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.9,
        strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true, style: { display: 'block' },
      },
        h('path', { d: 'M4 7h9a4 4 0 0 1 0 8H8' }),
        h('path', { d: 'M10 12l-3 3 3 3' }),
        h('path', { d: 'M17 4v4M20 6h-4' }),
      )
    }

    function SidebarIcon(props) {
      return h(Mark, { size: (props && props.size) || 16 })
    }

    /** One editable handoff, in the create/edit form. */
    function EntryForm({ initial, workspaces, onCancel, onSave, busy }) {
      const [command, setCommand] = React.useState(initial.command)
      const [prefix, setPrefix] = React.useState(initial.prefix)
      const [workspaceId, setWorkspaceId] = React.useState(initial.workspaceId)
      const [error, setError] = React.useState('')

      const submit = async () => {
        if (command.trim() === '') {
          setError('交接指令不能为空')
          return
        }
        setError('')
        try {
          await onSave({ command, prefix, workspaceId })
        } catch (e) {
          setError(String((e && e.message) || e))
        }
      }

      return h('div', { className: 'hf-form' },
        h('div', { className: 'hf-field' },
          h('div', { className: 'hf-fieldlabel' }, '交接指令'),
          h('textarea', {
            className: 'hf-input hf-mono',
            rows: 3,
            value: command,
            placeholder: '@docs/HANDOFF.md run the handoff section',
            onChange: (event) => setCommand(event.target.value),
          }),
          h('div', { className: 'hf-hint' }, '新会话收到的第一条消息，发出后立即开始执行。'),
        ),

        h('div', { className: 'hf-field' },
          h('div', { className: 'hf-fieldlabel' }, '名字前缀'),
          h('input', {
            className: 'hf-input',
            value: prefix,
            placeholder: '任务',
            onChange: (event) => setPrefix(event.target.value),
          }),
          h('div', { className: 'hf-hint' },
            '新会话名 = 前缀 + 明天的月日，例如 ',
            h('code', { className: 'hf-mono' }, previewTitle(prefix || '任务')),
            '。',
          ),
        ),

        h('div', { className: 'hf-field' },
          h('div', { className: 'hf-fieldlabel' }, '工作区'),
          h('select', {
            className: 'hf-input',
            value: workspaceId,
            onChange: (event) => setWorkspaceId(event.target.value),
          },
            h('option', { value: '' }, '跟随最近活跃会话'),
            workspaces.map((workspace) => h('option', { key: workspace.id, value: workspace.id },
              `${workspace.title} — ${workspace.path}`,
            )),
          ),
          h('div', { className: 'hf-hint' }, '新会话建在所选工作区，和原会话保持同一个目录。'),
        ),

        error ? h('div', { className: 'hf-err' }, error) : null,

        h('div', { className: 'hf-actions' },
          h('button', { className: 'hf-btn', onClick: onCancel, disabled: busy }, '取消'),
          h('button', { className: 'hf-btn primary', onClick: submit, disabled: busy }, '保存'),
        ),
      )
    }

    function HandoffPage() {
      const [state, setState] = React.useState(null)
      const [error, setError] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [cronText, setCronText] = React.useState('')
      const [cronError, setCronError] = React.useState('')
      const [editing, setEditing] = React.useState(null)

      const apply = React.useCallback((payload) => {
        setState(payload)
        setError('')
      }, [])

      const load = React.useCallback(async () => {
        try {
          const payload = await call('state')
          setState(payload)
          setCronText((current) => (current === '' ? payload.cron : current))
          setError('')
        } catch (e) {
          setError(String((e && e.message) || e))
        }
      }, [])

      React.useEffect(() => {
        load()
        const timer = setInterval(load, 15000)
        return () => clearInterval(timer)
      }, [load])

      React.useEffect(() => {
        if (state !== null && cronText === '') setCronText(state.cron)
      }, [state, cronText])

      const act = async (body) => {
        setBusy(true)
        try {
          const payload = await call('entry', body)
          apply(payload)
          return payload
        } catch (e) {
          setError(String((e && e.message) || e))
          throw e
        } finally {
          setBusy(false)
        }
      }

      const saveCron = async () => {
        setBusy(true)
        setCronError('')
        try {
          const payload = await call('cron', { cron: cronText })
          apply(payload)
        } catch (e) {
          setCronError(String((e && e.message) || e))
        } finally {
          setBusy(false)
        }
      }

      const toggleCron = async () => {
        setBusy(true)
        try {
          const payload = await call('cron', { enabled: !state.cronEnabled })
          apply(payload)
        } catch (e) {
          setError(String((e && e.message) || e))
        } finally {
          setBusy(false)
        }
      }

      const runOne = async (entry) => {
        setBusy(true)
        try {
          await act({ action: 'run', id: entry.id })
        } catch {
          // `act` already surfaced the failure.
        } finally {
          setBusy(false)
        }
      }

      const entries = state === null ? [] : state.entries
      const enabledCount = entries.filter((entry) => entry.enabled).length

      return h('div', { className: 'hf-page' },
        h(Styles),
        h('div', { className: 'hf-head' },
          h(Mark, { size: 20 }),
          h('span', { className: 'hf-h1' }, '每日交接'),
        ),
        h('div', { className: 'hf-sub' },
          '到点自动新建会话、命名并发送交接指令。错过的触发不补跑。',
        ),

        h('div', { className: 'hf-block' },
          h('div', { className: 'hf-row' },
            h('span', { className: 'hf-label' }, '定时'),
            h('input', {
              className: 'hf-input hf-mono',
              value: cronText,
              placeholder: '40 15 * * 1-5',
              spellCheck: false,
              onChange: (event) => {
                setCronText(event.target.value)
                setCronError('')
              },
            }),
            h('button', { className: 'hf-btn primary', onClick: saveCron, disabled: busy }, '保存'),
            h('button', {
              className: 'hf-switch',
              role: 'switch',
              'aria-checked': state !== null && state.cronEnabled ? 'true' : 'false',
              'aria-label': '定时启用',
              title: state !== null && state.cronEnabled ? '定时已启用' : '定时已停用',
              disabled: busy || state === null,
              onClick: toggleCron,
            }),
          ),
          cronError !== '' ? h('div', { className: 'hf-err' }, cronError) : null,
          state !== null && state.cronValid
            ? h('div', { className: 'hf-next' },
              state.cronEnabled ? '下次：' : '已停用，重新启用后：',
              state.nextRuns.map((iso, index) => h('code', { key: `${iso}-${index}` }, stamp(iso))),
            )
            : (state !== null
              ? h('div', { className: 'hf-err' }, `当前保存的表达式无法解析：${state.cron}`)
              : null),
          h('div', { className: 'hf-hint' },
            '5 段格式：分 时 日 月 周。例如 ',
            h('code', { className: 'hf-mono' }, '40 15 * * 1-5'),
            ' = 周一到周五 15:40。',
          ),
        ),

        h('div', { className: 'hf-listhead' },
          h('div', { className: 'hf-count' },
            `交接列表（启用 ${enabledCount} / 共 ${entries.length}）`,
          ),
          h('button', {
            className: 'hf-btn primary',
            disabled: busy || editing !== null || state === null,
            onClick: () => setEditing({ mode: 'create', command: '', prefix: '任务', workspaceId: '' }),
          }, '+ 新建'),
        ),

        editing !== null
          ? h(EntryForm, {
            key: editing.id || 'new',
            initial: editing,
            workspaces: state === null ? [] : state.workspaces,
            busy,
            onCancel: () => setEditing(null),
            onSave: async (values) => {
              if (editing.mode === 'create') await act({ action: 'create', ...values })
              else await act({ action: 'update', id: editing.id, ...values })
              setEditing(null)
            },
          })
          : null,

        entries.length === 0 && editing === null
          ? h('div', { className: 'hf-empty' }, '还没有交接条目，点右上角「+ 新建」添加第一条。')
          : entries.map((entry) => h('div', {
            key: entry.id,
            className: entry.enabled ? 'hf-card' : 'hf-card off',
          },
            h('div', { className: 'hf-cardtop' },
              h('span', { className: `hf-dot${entry.enabled ? ' on' : ''}` }),
              h('span', { className: 'hf-title' }, entry.previewTitle || entry.title || '(未命名)'),
              entry.enabled ? null : h('span', { className: 'hf-tag' }, '已停用'),
              h('span', { className: 'hf-spacer' }),
              h('button', {
                className: 'hf-btn',
                disabled: busy,
                onClick: () => runOne(entry),
              }, '立即交接'),
              h('button', {
                className: 'hf-btn',
                disabled: busy,
                onClick: () => act({ action: 'toggle', id: entry.id, enabled: !entry.enabled }),
              }, entry.enabled ? '停用' : '启用'),
              h('button', {
                className: 'hf-btn',
                disabled: busy,
                onClick: () => setEditing(entry),
              }, '编辑'),
              h('button', {
                className: 'hf-btn danger',
                disabled: busy,
                onClick: () => act({ action: 'delete', id: entry.id }),
              }, '删除'),
            ),
            h('div', { className: 'hf-cmd' }, entry.command),
            h('div', { className: 'hf-meta' },
              h('span', null, entry.workspacePath || '跟随最近活跃会话'),
              entry.lastRun === null
                ? h('span', null, '尚未交接')
                : h('span', null,
                  entry.lastRun.ok ? '上次 ' : '上次失败 ',
                  fullStamp(entry.lastRun.at),
                  entry.lastRun.ok ? ` → ${entry.lastRun.title}` : '',
                  entry.lastRun.ok ? null : ` · ${entry.lastRun.error}`,
                ),
            ),
          )),

        error !== '' ? h('div', { className: 'hf-err' }, error) : null,
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const t = (key) => (key === 'nav' ? '每日交接' : key)

        ctx.slots.inject('main', () =>
          ctx.slots.register({
            name: 'main',
            key: PANEL_ID,
          }, HandoffPage))

        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register({
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: 30,
            label: () => t('nav'),
          }, SidebarIcon))
      },
    }
  },
})
