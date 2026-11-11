import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type {
  AppConfig,
  AppInfo,
  ConnectionConfig,
  ExecuteResult,
  SessionInfo
} from '../../electron/types'
import { DEFAULT_PORT } from '../../electron/types'

interface OpenConn {
  info: SessionInfo
  /** 当前活跃库，状态栏显示 */
  database: string
}

const EMPTY_CONFIG: AppConfig = {
  groups: [{ id: 'default', name: '默认分组' }],
  connections: [],
  settings: { theme: 'dark', fontSize: 13, maxRows: 1000, runOnEnter: false }
}

export const useAppStore = defineStore('app', () => {
  const config = ref<AppConfig>(structuredClone(EMPTY_CONFIG))
  const info = ref<AppInfo | null>(null)
  const theme = ref<'dark' | 'light'>('dark')

  /** connectionId → 会话。允许多条连接同时开着，一次只"激活"一条 */
  const open = ref<Record<string, OpenConn>>({})
  const activeId = ref('')

  /** connectionId → 编辑器里的 SQL 草稿。切连接不丢内容 */
  const drafts = ref<Record<string, string>>({})
  const result = ref<ExecuteResult | null>(null)
  const running = ref(false)
  const lastError = ref('')

  const activeConn = computed(() => (activeId.value ? open.value[activeId.value] : undefined))
  const activeConfig = computed(() =>
    config.value.connections.find((c) => c.id === activeId.value)
  )
  const sql = computed({
    get: () => drafts.value[activeId.value] ?? '',
    set: (v: string) => {
      if (activeId.value) drafts.value[activeId.value] = v
    }
  })

  /* ------------------------------------------------------------------ 初始化 */

  async function init(): Promise<void> {
    const [cfg, appInfo] = await Promise.all([window.api.config.load(), window.api.app.info()])
    config.value = cfg
    info.value = appInfo
    applyTheme(cfg.settings.theme)
  }

  function applyTheme(next: 'dark' | 'light'): void {
    theme.value = next
    document.documentElement.dataset.theme = next
    void window.api.theme.set(next)
  }

  async function setTheme(next: 'dark' | 'light'): Promise<void> {
    config.value.settings.theme = next
    applyTheme(next)
    await save()
  }

  async function save(): Promise<void> {
    await window.api.config.save(config.value)
  }

  /* -------------------------------------------------------------------- 连接 */

  function newConnectionId(): string {
    return `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
  }

  function blankConnection(): ConnectionConfig {
    return {
      id: newConnectionId(),
      name: '新建连接',
      kind: 'postgres',
      host: '127.0.0.1',
      port: DEFAULT_PORT.postgres,
      user: 'postgres',
      password: '',
      database: '',
      ssl: false,
      groupId: config.value.groups[0]?.id ?? 'default',
      createdAt: Date.now()
    }
  }

  async function upsertConnection(cfg: ConnectionConfig): Promise<void> {
    const idx = config.value.connections.findIndex((c) => c.id === cfg.id)
    if (idx >= 0) config.value.connections[idx] = cfg
    else config.value.connections.push(cfg)
    await save()
  }

  async function removeConnection(id: string): Promise<void> {
    await disconnect(id)
    config.value.connections = config.value.connections.filter((c) => c.id !== id)
    await save()
  }

  /** 连上一条连接（已经连过就直接激活，不重连） */
  async function connect(cfg: ConnectionConfig): Promise<void> {
    if (open.value[cfg.id]) {
      activeId.value = cfg.id
      return
    }
    const session = await window.api.conn.open(cfg)
    open.value[cfg.id] = { info: session, database: cfg.database ?? '' }
    activeId.value = cfg.id
    cfg.lastUsedAt = Date.now()
    await save()
  }

  async function disconnect(id: string): Promise<void> {
    const conn = open.value[id]
    if (!conn) return
    delete open.value[id]
    if (activeId.value === id) {
      activeId.value = Object.keys(open.value)[0] ?? ''
      // 换了连接，上一个连接的结果集就不该再显示着 —— 容易误读成"这是新库的数据"
      result.value = null
    }
    await window.api.conn.close(conn.info.sessionId).catch(() => undefined)
  }

  function activate(id: string): void {
    if (activeId.value === id) return
    activeId.value = id
    result.value = null
    lastError.value = ''
  }

  async function switchDatabase(database: string): Promise<boolean> {
    const conn = activeConn.value
    if (!conn) return false
    const ok = await window.api.db.use(conn.info.sessionId, database)
    if (ok) conn.database = database
    return ok
  }

  /* -------------------------------------------------------------------- 执行 */

  async function run(text: string): Promise<void> {
    const conn = activeConn.value
    if (!conn) return
    const body = text.trim()
    if (!body) return

    running.value = true
    lastError.value = ''
    try {
      result.value = await window.api.sql.execute(
        conn.info.sessionId,
        body,
        config.value.settings.maxRows
      )
      const failed = result.value.results.find((r) => r.error)
      if (failed?.error) lastError.value = failed.error
    } catch (err) {
      // 会话断了、参数不合法这类"没进到语句执行"的错误
      lastError.value = (err as Error).message.replace(/^Error invoking remote method '[^']+': /, '')
      result.value = null
    } finally {
      running.value = false
    }
  }

  async function cancel(): Promise<boolean> {
    const conn = activeConn.value
    if (!conn) return false
    return window.api.sql.cancel(conn.info.sessionId)
  }

  return {
    config,
    info,
    theme,
    open,
    activeId,
    activeConn,
    activeConfig,
    drafts,
    sql,
    result,
    running,
    lastError,
    init,
    setTheme,
    save,
    blankConnection,
    upsertConnection,
    removeConnection,
    connect,
    disconnect,
    activate,
    switchDatabase,
    run,
    cancel
  }
})
