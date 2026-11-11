/**
 * 主进程与渲染进程共享的类型定义。
 * 只放纯类型 + 少量常量，不引入任何运行时依赖 —— preload 和渲染层都会 import 它，
 * 一旦带上 node 侧依赖，渲染层打包就会炸。
 */

/* ------------------------------------------------------------------ 数据库种类 */

export type DbKind = 'postgres' | 'mysql' | 'kingbase' | 'dm'

/** 各家的默认端口。人大金仓默认 54321，达梦默认 5236 —— 都不是"常识"，写死在这儿省得每次问 */
export const DEFAULT_PORT: Record<DbKind, number> = {
  postgres: 5432,
  mysql: 3306,
  kingbase: 54321,
  dm: 5236
}

export const KIND_LABEL: Record<DbKind, string> = {
  postgres: 'PostgreSQL',
  mysql: 'MySQL',
  kingbase: 'KingBase 人大金仓',
  dm: 'DM 达梦'
}

/** 连接树上的小标签色，用于区分环境 */
export interface ConnectionGroup {
  id: string
  name: string
}

export interface ConnectionConfig {
  id: string
  name: string
  kind: DbKind
  host: string
  port: number
  user: string
  /** 落盘时由 safeStorage 加密，读到内存才解密。渲染进程拿到的是明文 */
  password?: string
  /**
   * 初始库。
   * PG/金仓留空会连到与用户名同名的库上（没有就报错）；
   * MySQL 留空等于不选库，后续所有查询都得写 `库.表` 全名；
   * 达梦留空连默认库。
   */
  database?: string
  /** 是否走 TLS。内网自签证书也常见，所以驱动侧一律 rejectUnauthorized:false */
  ssl?: boolean
  /** 所属分组 id */
  groupId: string
  color?: string
  note?: string
  createdAt: number
  lastUsedAt?: number
}

export interface AppSettings {
  theme: 'dark' | 'light'
  /** SQL 编辑器字号 */
  fontSize: number
  /** 单次查询最多取多少行。防止 `select * from 日志表` 直接把内存打爆 */
  maxRows: number
  /** 回车执行还是 Ctrl+Enter 执行 */
  runOnEnter: boolean
}

export interface AppConfig {
  groups: ConnectionGroup[]
  connections: ConnectionConfig[]
  settings: AppSettings
}

/* -------------------------------------------------------------------- 会话 */

export interface SessionInfo {
  sessionId: string
  connectionId: string
  /** 服务端 version() 原串，状态栏显示 */
  serverVersion: string
  /** 连接建立时刻，用于状态栏"已连接 3 分钟" */
  connectedAt: number
}

/* ------------------------------------------------------------------ 查询结果 */

/**
 * 单元格的值。
 *
 * 主进程在把结果送过来之前统一"拍平"成这四种 —— 日期转 ISO 串、Buffer 转 0x 十六进制、
 * JSON 转字符串。原因有两个：
 * ① IPC 走 structured clone，Buffer / 自定义类过去会丢原型或直接报错；
 * ② 表格只需要"显示 + 复制"，不需要保留原始类型。
 *
 * 代价：将来要做"结果集行内编辑"时得回来改这里，让原始值另外带一份。
 */
export type Cell = string | number | boolean | null

export interface ColumnMeta {
  name: string
  /** 数据库里的原始类型名，如 int4 / varchar / NUMBER */
  dataType: string
  nullable?: boolean
  primaryKey?: boolean
}

export interface QueryResult {
  /** 这条语句本身，多语句结果页签要拿它当标题 */
  statement: string
  columns: ColumnMeta[]
  /**
   * **为什么用二维数组而不是对象数组**：
   * `select a.id, b.id from a join b` 这种会出来两列同名列，映射成对象时后面的把前面的覆盖掉，
   * 用户看到的列就莫名其妙少了一列。二维数组按位置对齐，天然没有这个问题。
   */
  rows: Cell[][]
  rowCount: number
  /** INSERT / UPDATE / DELETE / DDL 才有意义 */
  affectedRows?: number
  durationMs: number
  /** 这条语句失败时的错误文案。多语句执行时单条失败不中断后面的 */
  error?: string
  /** 是否因为 maxRows 被截断 */
  truncated?: boolean
}

export interface ExecuteResult {
  results: QueryResult[]
  durationMs: number
}

/* ---------------------------------------------------------------- 结构探索 */

export interface TableInfo {
  schema: string
  name: string
  /** table / view / matview / foreign table …，界面上给不同图标 */
  kind: string
  comment?: string
}

export interface ColumnInfo extends ColumnMeta {
  defaultValue?: string
  comment?: string
}

/* ------------------------------------------------------------------- 设置项 */

export interface AppInfo {
  version: string
  platform: string
  electron: string
  node: string
  chrome: string
  /** 各驱动的可用情况 —— dmdb 是可选依赖，没装上要能看出来 */
  drivers: { kind: DbKind; available: boolean; version?: string; reason?: string }[]
}

/* --------------------------------------------------------------- 对外 API */

export interface ThDbApi {
  config: {
    load: () => Promise<AppConfig>
    save: (config: AppConfig) => Promise<void>
    /** 导出不含密码的连接清单，方便团队内共享 */
    exportConfig: () => Promise<string | null>
    importConfig: () => Promise<AppConfig | null>
    path: () => Promise<string>
  }
  theme: {
    set: (theme: 'light' | 'dark') => Promise<void>
  }
  conn: {
    /** 只试连，不留会话。返回服务端版本串 */
    test: (config: ConnectionConfig) => Promise<string>
    open: (config: ConnectionConfig) => Promise<SessionInfo>
    close: (sessionId: string) => Promise<void>
  }
  db: {
    databases: (sessionId: string) => Promise<string[]>
    schemas: (sessionId: string, database?: string) => Promise<string[]>
    tables: (sessionId: string, database: string | undefined, schema: string) => Promise<TableInfo[]>
    columns: (
      sessionId: string,
      database: string | undefined,
      schema: string,
      table: string
    ) => Promise<ColumnInfo[]>
    /** 切换"接下来 SQL 跑在哪个库"，返回 false 表示该库种类不支持 */
    use: (sessionId: string, database: string) => Promise<boolean>
    current: (sessionId: string) => Promise<string>
  }
  sql: {
    execute: (sessionId: string, sql: string, maxRows?: number) => Promise<ExecuteResult>
    cancel: (sessionId: string) => Promise<boolean>
  }
  app: {
    info: () => Promise<AppInfo>
  }
  dialog: {
    /** 把结果集存成 CSV，返回落盘路径（用户取消返回 null） */
    saveCsv: (defaultName: string, content: string) => Promise<string | null>
  }
  clipboard: {
    write: (text: string) => Promise<void>
  }
}

declare global {
  interface Window {
    api: ThDbApi
  }
}
