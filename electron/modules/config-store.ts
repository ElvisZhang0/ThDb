import { app, safeStorage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { AppConfig, ConnectionConfig } from '../types'

const DEFAULT_CONFIG: AppConfig = {
  groups: [{ id: 'default', name: '默认分组' }],
  connections: [],
  settings: {
    theme: 'dark',
    fontSize: 13,
    // 1000 行足够看，又不至于把 200MB 的结果塞进 IPC 卡死渲染进程
    maxRows: 1000,
    runOnEnter: false
  }
}

/**
 * 配置文件落在 userData 目录，不跟随安装目录，卸载重装不丢。
 *
 * 密码用 Electron safeStorage 加密（Windows 走 DPAPI，macOS 走 Keychain，Linux 走
 * libsecret/kwallet）后 base64 存盘，磁盘上看不到明文。safeStorage 不可用时
 * （Linux 无 keyring 是常见情况）退化成 `raw:` 前缀的明文 —— 并在日志里留痕，
 * 界面上不提示，因为绝大多数用户也没别的选择。
 */
export class ConfigStore {
  private filePath: string
  private cache: AppConfig | null = null

  constructor() {
    this.filePath = path.join(app.getPath('userData'), 'thbd-config.json')
  }

  get path(): string {
    return this.filePath
  }

  private encrypt(plain?: string): string | undefined {
    if (!plain) return undefined
    try {
      if (safeStorage.isEncryptionAvailable()) {
        return 'enc:' + safeStorage.encryptString(plain).toString('base64')
      }
    } catch {
      /* Linux 无 keyring：降级 */
    }
    console.warn('[config] safeStorage 不可用，密码将以明文保存')
    return 'raw:' + plain
  }

  private decrypt(stored?: string): string | undefined {
    if (!stored) return undefined
    if (stored.startsWith('enc:')) {
      try {
        return safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64'))
      } catch {
        // 换了机器 / 换了用户账户，DPAPI 解不开旧密文 —— 当没存过密码处理，
        // 让用户重新输一次，比抛错好
        console.warn('[config] 密码解密失败，需要重新输入')
        return undefined
      }
    }
    if (stored.startsWith('raw:')) return stored.slice(4)
    return stored
  }

  load(): AppConfig {
    if (this.cache) return this.cache
    let config: AppConfig = structuredClone(DEFAULT_CONFIG)
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf-8')) as AppConfig
        config = {
          groups: raw.groups?.length ? raw.groups : DEFAULT_CONFIG.groups,
          connections: Array.isArray(raw.connections) ? raw.connections : [],
          settings: { ...DEFAULT_CONFIG.settings, ...(raw.settings ?? {}) }
        }
      }
    } catch (err) {
      console.error('[config] 读取失败，回退默认配置', err)
      // 坏文件备份一份，别直接覆盖掉用户数据
      try {
        fs.copyFileSync(this.filePath, this.filePath + '.broken')
      } catch {
        /* ignore */
      }
    }
    config.connections = config.connections.map((c) => ({
      ...c,
      password: this.decrypt(c.password)
    }))
    this.cache = config
    return config
  }

  save(config: AppConfig): void {
    const toDisk: AppConfig = {
      groups: config.groups,
      connections: config.connections.map((c: ConnectionConfig) => ({
        ...c,
        password: this.encrypt(c.password)
      })),
      settings: config.settings
    }
    // 先写临时文件再 rename：写一半断电的话，配置文件不会变成半截 JSON
    const tmp = this.filePath + '.tmp'
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
    fs.writeFileSync(tmp, JSON.stringify(toDisk, null, 2), 'utf-8')
    fs.renameSync(tmp, this.filePath)
    this.cache = config
  }

  /** 导出为不含密码的明文 JSON，方便在团队内共享连接信息 */
  exportSanitized(): string {
    const config = this.load()
    return JSON.stringify(
      {
        ...config,
        connections: config.connections.map((c) => ({ ...c, password: undefined }))
      },
      null,
      2
    )
  }
}
