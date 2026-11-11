import { app, BrowserWindow, dialog, ipcMain, nativeTheme, clipboard, shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { AppConfig, AppInfo, ConnectionConfig } from './types'
import { ConfigStore } from './modules/config-store'
import { driverReport } from './modules/drivers'
import {
  cancel,
  closeAll,
  closeSession,
  execute,
  openSession,
  sessionDatabase,
  sessionDriver,
  testConnection,
  useDatabase
} from './modules/db-manager'

/**
 * 渲染进程的刷新键在打包后是禁用的（没菜单），
 * 开发时留个 F5 —— 改样式不用重启 Electron。
 */
const isDev = !app.isPackaged

let mainWindow: BrowserWindow | null = null
let store: ConfigStore

/* -------------------------------------------------------------------- 窗口 */

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 880,
    minWidth: 980,
    minHeight: 600,
    // 界面自己画深色，窗口底色也跟上，不然启动瞬间会闪一下白
    backgroundColor: store.load().settings.theme === 'light' ? '#ffffff' : '#1b1d23',
    // 数据库工具用系统原生标题栏：窗口要能被拖到副屏、能双击最大化，
    // 自绘标题栏在这些系统行为上永远差一口气
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      // 三个安全开关，一个都不能松
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      // preload 里要用 electron 的 clipboard / ipcRenderer，
      // sandbox: true 会把可用的模块砍到只剩极少数，这里得关
      sandbox: false
    }
  })

  mainWindow.once('ready-to-show', () => mainWindow?.show())

  // 外链一律丢给系统浏览器，别在应用里开新窗口——那里没有地址栏，用户回不去
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (isDev) {
    mainWindow.webContents.on('before-input-event', (_e, input) => {
      if (input.type === 'keyDown' && input.key === 'F5') mainWindow?.webContents.reload()
    })
  }

  const devUrl = process.env.VITE_DEV_SERVER_URL
  if (devUrl) {
    void mainWindow.loadURL(devUrl)
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

/* -------------------------------------------------------------------- IPC */

/**
 * ipcMain.handle 的薄壳：把 (event, ...args) 摊平成正常的函数参数。
 *
 * 顺手统一收口错误 —— 每个 handler 自己 try/catch 会把代码刷成一堆 noise，
 * 而 Electron 本来就会把抛出的错误带回渲染层的 Promise reject 里，
 * 界面只需在调用处 catch 一次。
 */
function register<A extends unknown[], R>(
  channel: string,
  fn: (...args: A) => R | Promise<R>
): void {
  ipcMain.handle(channel, (_e, ...args) => fn(...(args as A)))
}

function registerIpc(): void {
  /* ---------------- 配置 ---------------- */

  register('config:load', () => store.load())
  register('config:save', (config: AppConfig) => {
    store.save(config)
    // 主题跟着配置走：存了就立刻应用，不用等下次启动
    nativeTheme.themeSource = config.settings.theme
    mainWindow?.setBackgroundColor(config.settings.theme === 'light' ? '#ffffff' : '#1b1d23')
  })
  register('config:path', () => store.path)
  register('config:export', async () => {
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow!, {
      title: '导出连接配置（不含密码）',
      defaultPath: 'thbd-connections.json',
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (canceled || !filePath) return null
    fs.writeFileSync(filePath, store.exportSanitized(), 'utf-8')
    return filePath
  })
  register('config:import', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow!, {
      title: '导入连接配置',
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (canceled || !filePaths[0]) return null
    const raw = JSON.parse(fs.readFileSync(filePaths[0], 'utf-8')) as AppConfig
    // 导入的东西不可信：补默认值、丢掉奇怪字段，别让它把现有配置带崩
    const current = store.load()
    const imported: AppConfig = {
      groups: Array.isArray(raw.groups) && raw.groups.length ? raw.groups : current.groups,
      connections: Array.isArray(raw.connections) ? raw.connections : [],
      settings: current.settings
    }
    store.save(imported)
    return store.load()
  })

  register('theme:set', (theme: 'light' | 'dark') => {
    nativeTheme.themeSource = theme
    mainWindow?.setBackgroundColor(theme === 'light' ? '#ffffff' : '#1b1d23')
  })

  /* ---------------- 连接与查询 ---------------- */

  register('conn:test', (cfg: ConnectionConfig) => testConnection(cfg))
  register('conn:open', (cfg: ConnectionConfig) => openSession(cfg))
  register('conn:close', (sessionId: string) => closeSession(sessionId))

  register('db:databases', (sessionId: string) => sessionDriver(sessionId).databases())
  register('db:schemas', (sessionId: string, database?: string) =>
    sessionDriver(sessionId).schemas(database)
  )
  register('db:tables', (sessionId: string, database: string | undefined, schema: string) =>
    sessionDriver(sessionId).tables(database, schema)
  )
  register('db:columns', (
    sessionId: string,
    database: string | undefined,
    schema: string,
    table: string
  ) => sessionDriver(sessionId).columns(database, schema, table))
  register('db:use', (sessionId: string, database: string) => useDatabase(sessionId, database))
  register('db:current', (sessionId: string) => sessionDatabase(sessionId) ?? '')

  register('sql:execute', (sessionId: string, sql: string, maxRows?: number) => {
    // 行数上限从配置里读，用户在设置里改过就按他的来
    const limit = maxRows ?? store.load().settings.maxRows
    return execute(sessionId, sql, limit)
  })
  register('sql:cancel', (sessionId: string) => cancel(sessionId))

  /* ---------------- 应用信息 ---------------- */

  register('app:info', (): AppInfo => ({
    version: app.getVersion(),
    platform: process.platform,
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome,
    drivers: driverReport()
  }))

  /* ---------------- 文件与剪贴板 ---------------- */

  register('dialog:saveCsv', async (defaultName: string, content: string) => {
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow!, {
      title: '导出结果集',
      defaultPath: defaultName,
      filters: [{ name: 'CSV', extensions: ['csv'] }]
    })
    if (canceled || !filePath) return null
    /**
     * 必须加 UTF-8 BOM。
     * 不加的话 Excel（尤其是中文 Windows 上的 Office 2016/2019）会按 GBK 解，
     * 中文列名全变成乱码 —— 这是导出 CSV 最高频的投诉，一个 BOM 就解决。
     */
    fs.writeFileSync(filePath, '\uFEFF' + content, 'utf-8')
    return filePath
  })

  // 复制走主进程：file:// 协议下 navigator.clipboard 会被 Chromium 以"非安全上下文"禁掉
  register('clipboard:write', (text: string) => {
    clipboard.writeText(text)
  })
}

/* ------------------------------------------------------------------ 生命周期 */

/**
 * 单实例锁只在打包后启用。
 *
 * 开发时锁上会很难受：`pnpm dev` 重启主进程那一刻，旧实例还没退干净，
 * 新实例一看锁被占就自己退出了 —— 结果改了 main.ts 反而什么窗口都不出现。
 */
const hasLock = app.isPackaged ? app.requestSingleInstanceLock() : true

if (!hasLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  app.whenReady().then(() => {
    // Windows 上不设这个，任务栏图标和通知会归到 electron.exe 名下
    app.setAppUserModelId('com.meng.thbd')

    store = new ConfigStore()
    nativeTheme.themeSource = store.load().settings.theme

    registerIpc()
    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  // 退出前把连接全关了，否则数据库那边会挂着一堆空闲会话直到超时
  app.on('before-quit', () => {
    void closeAll()
  })
}
