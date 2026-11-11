import { createRequire } from 'node:module'
import type { ConnectionConfig, DbKind, ColumnInfo, QueryResult, TableInfo } from '../../types'
import { explainError, nowMs, quoteLiteral, toCell, type DbDriver } from './shared'

/**
 * 达梦 DM 驱动。
 *
 * `dmdb` 是达梦官方随数据库安装包一起发的 Node 驱动（npm 上有发布，版本号形如 1.0.52452），
 * 放在 optionalDependencies 里 —— 它带原生 .node，在某些平台/Node ABI 上装不上，
 * 那种情况下其他三种库照用，只有达梦连不了。
 *
 * 它的 API 是照着 oracledb 做的，但有个麻烦：不同小版本的 execute() 既支持
 * "最后一个参数是回调"，也支持"直接返回 Promise"，而且没有文档写清楚哪个版本是哪种。
 * 所以下面统一用 invoke() 两种都接住 —— 这比死记某个版本的签名可靠得多。
 */
export class DmDriver implements DbDriver {
  readonly kind: DbKind = 'dm'
  private mod: any = null
  private conn: any = null

  constructor(private cfg: ConnectionConfig) {}

  /**
   * 用 createRequire 而不是 `import('dmdb')`：
   * 主进程产物是 CJS，rollup 处理动态 import 外部依赖时会包一层 interop，
   * 对原生模块容易出岔子。直接 require 最省事，而且失败能精确捕获。
   */
  private load(): any {
    if (this.mod) return this.mod
    const req = createRequire(__filename)
    this.mod = req('dmdb')
    return this.mod
  }

  async connect(): Promise<string> {
    const dmdb = this.load()
    const opts = {
      host: this.cfg.host,
      port: this.cfg.port,
      user: this.cfg.user,
      password: this.cfg.password,
      // dmdb 认 database / dbName 两种写法，都带上
      database: this.cfg.database || undefined,
      dbName: this.cfg.database || undefined,
      connectTimeout: 15000
    }
    const factory = typeof dmdb.getConnection === 'function' ? 'getConnection' : 'createConnection'
    this.conn = await invoke<any>(dmdb, factory, opts)

    // 版本串拿不到不影响用，失败就算了
    try {
      const r = await this.executeRaw('select banner as v from v$version')
      const first = r?.rows?.[0]
      const v = Array.isArray(first) ? first[0] : first?.V
      if (v) return String(v)
    } catch {
      /* v$version 在部分版本里没有，忽略 */
    }
    return 'DM 达梦'
  }

  async close(): Promise<void> {
    if (!this.conn) return
    const c = this.conn
    this.conn = null
    await invoke(c, 'close').catch(() => undefined)
  }

  private need(): any {
    if (!this.conn) throw new Error('连接已关闭')
    return this.conn
  }

  /**
   * 达梦的 execute 有两种调用形态：
   *   execute(sql, cb)
   *   execute(sql, binds, options, cb)
   * 这里永远走两参形式 —— 我们的 SQL 里不传绑定变量（元数据查询里的名字直接内联转义）。
   */
  private executeRaw(sql: string): Promise<any> {
    return invoke<any>(this.need(), 'execute', sql)
  }

  async query(sql: string, maxRows: number): Promise<QueryResult> {
    const t0 = nowMs()
    const res = await this.executeRaw(sql)
    const durationMs = nowMs() - t0
    const { columns, rows } = normalize(res)

    if (!columns.length) {
      return {
        statement: sql,
        columns: [],
        rows: [],
        rowCount: 0,
        affectedRows: res?.rowsAffected ?? res?.rowsAffectedTotal ?? undefined,
        durationMs
      }
    }

    const truncated = rows.length > maxRows
    const kept = (truncated ? rows.slice(0, maxRows) : rows).map((r) => r.map(toCell))
    return {
      statement: sql,
      columns,
      rows: kept,
      rowCount: kept.length,
      durationMs,
      truncated
    }
  }

  /**
   * 达梦是"一个实例一套数据"，不像 PG 那样一个连接能挂多个库。
   * 所以这一层其实没有真实的"库"可枚举 —— 返回配置里那个名字只是为了树结构统一。
   */
  async databases(): Promise<string[]> {
    return [this.cfg.database || 'DAMENG']
  }

  async schemas(): Promise<string[]> {
    // 先试 ALL_USERS（Oracle 风格，达梦完整兼容）；不行再退到 SYSOBJECTS
    try {
      const r = await this.executeRaw('select username as n from all_users order by 1')
      const list = normalize(r).rows.map((row) => String(row[0])).filter(Boolean)
      if (list.length) return list
    } catch {
      /* 落到下面的兜底 */
    }
    const r = await this.executeRaw(
      "select name as n from sysobjects where type$ = 'SCH' order by 1"
    )
    return normalize(r).rows.map((row) => String(row[0])).filter(Boolean)
  }

  async tables(_database: string | undefined, schema: string): Promise<TableInfo[]> {
    // 表和视图分在两套字典里，UNION 起来一次拿完
    const sql = `
      select owner as schema_name, table_name as table_name, 'table' as kind
        from all_tables where owner = ${quoteLiteral(schema)}
      union all
      select owner as schema_name, view_name as table_name, 'view' as kind
        from all_views where owner = ${quoteLiteral(schema)}
      order by 2`
    const r = await this.executeRaw(sql)
    return normalize(r).rows.map((row) => ({
      schema: String(row[0]),
      name: String(row[1]),
      kind: String(row[2]) === 'view' ? 'view' : 'table'
    }))
  }

  async columns(
    _database: string | undefined,
    schema: string,
    table: string
  ): Promise<ColumnInfo[]> {
    const owner = quoteLiteral(schema)
    const name = quoteLiteral(table)
    const r = await this.executeRaw(`
      select column_name, data_type, nullable, data_default
        from all_tab_columns
       where owner = ${owner} and table_name = ${name}
       order by column_id`)
    const { rows } = normalize(r)

    // 主键单独查一次：ALL_TAB_COLUMNS 里没有这个信息
    let pks = new Set<string>()
    try {
      const pk = await this.executeRaw(`
        select cc.column_name
          from all_cons_columns cc
          join all_constraints c
            on c.owner = cc.owner and c.constraint_name = cc.constraint_name
         where c.constraint_type = 'P' and c.owner = ${owner} and c.table_name = ${name}`)
      pks = new Set(normalize(pk).rows.map((row) => String(row[0]).toUpperCase()))
    } catch {
      /* 字典视图权限不足时拿不到主键，不影响列表 */
    }

    return rows.map((row) => {
      const colName = String(row[0] ?? '')
      return {
        name: colName,
        dataType: String(row[1] ?? ''),
        // Oracle 风格：nullable 是 'Y'/'N' 而不是布尔
        nullable: String(row[2] ?? 'Y').toUpperCase() === 'Y',
        defaultValue: row[3] == null ? undefined : String(row[3]),
        primaryKey: pks.has(colName.toUpperCase())
      }
    })
  }

  /**
   * 达梦没有"切库"这回事，只有切模式（SET SCHEMA）。
   * 这层抽象的含义是"换库"，所以诚实地返回 false，让界面别改高亮。
   */
  async useDatabase(): Promise<boolean> {
    return false
  }
}

/* ------------------------------------------------------------------ 工具 */

/**
 * 把"回调风格 / Promise 风格"两种驱动 API 统一成 Promise。
 *
 * 两种都接的原因见类注释。注意必须先置 done 标志：
 * 有些实现回了回调又返回 Promise，不挡住就会二次 settle。
 */
function invoke<T>(target: any, method: string, ...args: unknown[]): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false
    const settle = (err: unknown, res?: T) => {
      if (done) return
      done = true
      if (err) reject(err instanceof Error ? err : new Error(explainError(err)))
      else resolve(res as T)
    }

    if (typeof target?.[method] !== 'function') {
      reject(new Error(`dmdb 驱动没有 ${method} 方法，可能是版本不匹配`))
      return
    }

    let ret: any
    try {
      ret = target[method](...args, (err: unknown, res: T) => settle(err, res))
    } catch (err) {
      settle(err)
      return
    }
    if (ret && typeof ret.then === 'function') {
      ret.then((v: T) => settle(null, v), (e: unknown) => settle(e))
    }
  })
}

/**
 * 达梦的 execute 结果形状不稳定：
 * - metaData 可能在 result.metaData / result.columns，字段叫 name 或 NAME
 * - rows 可能是二维数组（默认），也可能被配置成对象数组
 * 统一成 { columns, rows } 二维形式。
 */
function normalize(result: any): {
  columns: { name: string; dataType: string }[]
  rows: unknown[][]
} {
  const meta: any[] = result?.metaData ?? result?.columns ?? result?.columnMeta ?? []
  const columns = meta.map((m) => ({
    name: String(m?.name ?? m?.NAME ?? ''),
    dataType: String(m?.dbTypeName ?? m?.typeName ?? m?.dataType ?? m?.type?.name ?? '')
  }))
  const raw: any[] = result?.rows ?? []
  const rows = raw.map((r) => {
    if (Array.isArray(r)) return r
    // 对象数组：按列序取，大小写两种键都试
    return columns.map((c) => r?.[c.name] ?? r?.[c.name.toUpperCase()] ?? null)
  })
  return { columns, rows }
}

/** 给 app.info 用：dmdb 到底装上了没有 */
export function dmdbAvailability(): { available: boolean; version?: string; reason?: string } {
  try {
    const req = createRequire(__filename)
    const mod = req('dmdb')
    return { available: true, version: mod?.version ?? mod?.VERSION }
  } catch (err) {
    return {
      available: false,
      reason: (err as Error).message.includes('Cannot find module')
        ? '未安装 dmdb（可选依赖，安装时可能被跳过）'
        : explainError(err)
    }
  }
}
