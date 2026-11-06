/**
 * cc-dsh client half: one Settings section that shows how the phone connects.
 *
 * The gateway port is injected into index.html by the host half
 * (`window.__CCDSH__`), so this panel always talks to the right port, and the
 * request is loopback-owned, which the gateway treats as the PC owner.
 */
window.__ModuleLoader__.load({
  id: 'cc-dsh',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const styles = {
      wrap: { display: 'flex', flexDirection: 'column', gap: 14, padding: '4px 0' },
      card: {
        border: '1px solid var(--dsh-border, #2a3550)',
        borderRadius: 12,
        padding: 14,
        background: 'var(--dsh-surface, transparent)',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      },
      label: { fontSize: 12, opacity: 0.6, letterSpacing: '0.02em' },
      code: {
        fontSize: 30,
        letterSpacing: '0.18em',
        fontWeight: 600,
        fontFamily: 'ui-monospace, Consolas, monospace',
      },
      row: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
      mono: { fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 12, opacity: 0.85, wordBreak: 'break-all' },
      button: {
        border: '1px solid var(--dsh-border, #2a3550)',
        background: 'transparent',
        color: 'inherit',
        borderRadius: 8,
        padding: '6px 12px',
        cursor: 'pointer',
        fontSize: 12,
      },
      dim: { fontSize: 12, opacity: 0.6 },
    }

    function useStatus() {
      const [status, setStatus] = React.useState(null)
      const [error, setError] = React.useState('')
      const load = React.useCallback(async () => {
        try {
          const base = window.__CCDSH__ && window.__CCDSH__.origin ? window.__CCDSH__.origin : 'http://127.0.0.1:7317'
          const response = await fetch(`${base}/api/server`, { credentials: 'omit' })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          setStatus(await response.json())
          setError('')
        } catch (cause) {
          setError(String(cause && cause.message ? cause.message : cause))
        }
      }, [])
      React.useEffect(() => {
        load()
        const timer = setInterval(load, 15000)
        return () => clearInterval(timer)
      }, [load])
      return { status, error, reload: load }
    }

    function copy(text) {
      try {
        navigator.clipboard?.writeText(text)
      } catch {}
    }

    function Panel() {
      const { status, error, reload } = useStatus()
      if (error) {
        return h('div', { style: styles.wrap }, [
          h('div', { style: styles.card }, [
            h('div', { style: styles.label }, '手机网关'),
            h('div', { style: styles.dim }, `没有连上网关（${error}）。`),
            h('button', { style: styles.button, onClick: reload }, '重试'),
          ]),
        ])
      }
      if (!status) return h('div', { style: styles.dim }, '正在读取网关状态…')

      const urls = status.urls || []
      const lan = urls.find((entry) => entry.kind === 'lan' && !entry.url.includes('127.0.0.1'))
      const tail = urls.find((entry) => entry.kind === 'tailscale')
      const code = status.pairing ? status.pairing.value : ''

      return h('div', { style: styles.wrap }, [
        h('div', { style: styles.card }, [
          h('div', { style: styles.label }, '手机配对码'),
          h('div', { style: styles.code }, code || '—'),
          h('div', { style: styles.dim }, '在手机 cc-dsh App 里输入这 6 位数字。码每 10 分钟自动更换，用过一次即失效。'),
        ]),
        h('div', { style: styles.card }, [
          h('div', { style: styles.label }, '连接地址'),
          lan ? h('div', { style: styles.mono }, `局域网：${lan.url}`) : null,
          tail ? h('div', { style: styles.mono }, `异地（Tailscale）：${tail.url}`) : null,
          h('div', { style: styles.row, marginTop: 6 }, [
            h('button', {
              style: styles.button,
              onClick: () => copy(lan ? lan.url : urls[0] ? urls[0].url : ''),
            }, '复制地址'),
            h('button', {
              style: styles.button,
              onClick: async () => {
                await fetch(`${(window.__CCDSH__ && window.__CCDSH__.origin) || 'http://127.0.0.1:7317'}/api/pairing/rotate`, { method: 'POST' })
                reload()
              },
            }, '换一个配对码'),
          ]),
          h('div', { style: styles.dim }, '手机和电脑在同一个 Wi-Fi 时用局域网地址；在外面先连上电脑的 Tailscale，再用异地地址。'),
        ]),
        h('div', { style: styles.card }, [
          h('div', { style: styles.label }, `已配对的手机（${(status.devices || []).length}）`),
          (status.devices || []).length === 0
            ? h('div', { style: styles.dim }, '还没有手机配对。')
            : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
                (status.devices || []).map((device) => h(DeviceRow, { key: device.id, device, reload }))),
        ]),
      ])
    }

    /** One paired phone: rename inline, remove, and show when it was added. */
    function DeviceRow({ device, reload }) {
      const [editing, setEditing] = React.useState(false)
      const [draft, setDraft] = React.useState(device.name || '')

      const save = async () => {
        const name = draft.trim()
        setEditing(false)
        if (!name || name === device.name) return
        await fetch(`${origin()}/api/devices/rename`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: device.id, name }),
        })
        reload()
      }

      const remove = async () => {
        await fetch(`${origin()}/api/devices/revoke`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: device.id }),
        })
        reload()
      }

      const meta = [device.platform, device.createdAt ? `配对于 ${new Date(device.createdAt).toLocaleString()}` : '']
        .filter(Boolean)
        .join(' · ')

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } }, [
        h('div', { style: styles.row }, [
          editing
            ? h('input', {
                autoFocus: true,
                value: draft,
                onChange: (event) => setDraft(event.target.value),
                onBlur: save,
                onKeyDown: (event) => {
                  if (event.key === 'Enter') save()
                  if (event.key === 'Escape') {
                    setDraft(device.name || '')
                    setEditing(false)
                  }
                },
                style: {
                  flex: 1,
                  background: 'transparent',
                  border: '1px solid var(--dsh-border, #2a3550)',
                  borderRadius: 8,
                  padding: '6px 8px',
                  color: 'inherit',
                  fontSize: 13,
                },
              })
            : h('div', { style: { flex: 1 } }, device.name || '手机'),
          h('button', { style: styles.button, onClick: () => (editing ? save() : setEditing(true)) }, editing ? '保存' : '重命名'),
          h('button', { style: styles.button, onClick: remove }, '移除'),
        ]),
        meta ? h('div', { style: styles.dim }, meta) : null,
      ])
    }

    const origin = () => (window.__CCDSH__ && window.__CCDSH__.origin) || 'http://127.0.0.1:7317'

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            { name: 'settings.section', id: 'cc-dsh-phone', order: 92, label: '手机连接' },
            Panel,
          ),
        )
      },
    }
  },
})
