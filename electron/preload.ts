import { contextBridge, ipcRenderer } from 'electron'
import type { AppConfig, ConnectionConfig, ThDbApi } from './types'

/**
 * 渲染进程唯一的对外通道。
 *
 * 白名单式暴露：只把下面这些方法挂到 window.api 上，渲染层拿不到 ipcRenderer 本身，
 * 也就没法自己拼任意 channel 去调主进程。contextIsolation: true 保证
 * 这个对象和页面脚本在同一个世界里也不会互相篡改。
 */
const api: ThDbApi = {
  config: {
    load: () => ipcRenderer.invoke('config:load'),
    save: (config: AppConfig) => ipcRenderer.invoke('config:save', config),
    exportConfig: () => ipcRenderer.invoke('config:export'),
    importConfig: () => ipcRenderer.invoke('config:import'),
    path: () => ipcRenderer.invoke('config:path')
  },
  theme: {
    set: (theme: 'light' | 'dark') => ipcRenderer.invoke('theme:set', theme)
  },
  conn: {
    test: (config: ConnectionConfig) => ipcRenderer.invoke('conn:test', config),
    open: (config: ConnectionConfig) => ipcRenderer.invoke('conn:open', config),
    close: (sessionId: string) => ipcRenderer.invoke('conn:close', sessionId)
  },
  db: {
    databases: (sessionId: string) => ipcRenderer.invoke('db:databases', sessionId),
    schemas: (sessionId: string, database?: string) =>
      ipcRenderer.invoke('db:schemas', sessionId, database),
    tables: (sessionId: string, database: string | undefined, schema: string) =>
      ipcRenderer.invoke('db:tables', sessionId, database, schema),
    columns: (sessionId: string, database: string | undefined, schema: string, table: string) =>
      ipcRenderer.invoke('db:columns', sessionId, database, schema, table),
    use: (sessionId: string, database: string) =>
      ipcRenderer.invoke('db:use', sessionId, database),
    current: (sessionId: string) => ipcRenderer.invoke('db:current', sessionId)
  },
  sql: {
    execute: (sessionId: string, sql: string, maxRows?: number) =>
      ipcRenderer.invoke('sql:execute', sessionId, sql, maxRows),
    cancel: (sessionId: string) => ipcRenderer.invoke('sql:cancel', sessionId)
  },
  app: {
    info: () => ipcRenderer.invoke('app:info')
  },
  dialog: {
    saveCsv: (defaultName: string, content: string) =>
      ipcRenderer.invoke('dialog:saveCsv', defaultName, content)
  },
  clipboard: {
    write: (text: string) => ipcRenderer.invoke('clipboard:write', text)
  }
}

contextBridge.exposeInMainWorld('api', api)
