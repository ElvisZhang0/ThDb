import { createConnection, type Connection, type FieldPacket } from 'mysql2/promise'
import type { ConnectionConfig, DbKind, ColumnInfo, QueryResult, TableInfo } from '../../types'
import { explainError, nowMs, toCell, type DbDriver } from './shared'

/** 连接树里不想看的系统库。`mysql` 库留着 —— 用户查权限表是常事 */
const HIDDEN_SCHEMAS = new Set(['information_schema', 'performance_schema', 'sys'])

export class MysqlDriver implements DbDriver {
  readonly kind: DbKind = 'mysql'
  private conn: Connection | null = null
  private current = ''

  constructor(private cfg: ConnectionConfig) {}

  async connect(): Promise<string> {
    const conn = await createConnection({
      host: this.cfg.host,
      port: this.cfg.port,
      user: this.cfg.user,
      password: this.cfg.password,
      database: this.cfg.database || undefined,
      ssl: this.cfg.ssl ? { rejectUnauthorized: false } : undefined,
      connectTimeout: 15000,
      charset: 'utf8mb4',
      /**
       * 三个都要开：
       * - dateStrings：DATETIME 直接给字符串。否则 mysql2 会按**本机时区**造 Date 对象，
       *   一个 `2026-11-10 00:00:00` 到了界面上可能变成 `2026-11-09 16:00:00`（差 8 小时），
       *   在数据库工具里这是最招骂的 bug。
       * - supportBigNumbers + bigNumberStrings:false：BIGINT 在安全范围内还是 number，
       *   超了就自动转字符串，不会悄悄丢精度。
       */
      dateStrings: true,
      supportBigNumbers: true,
      bigNumberStrings: false,
      // 我们自己按分号拆语句，绝不交给驱动做多语句 —— 那是 SQL 注入的经典温床
      multipleStatements: false,
      // 让服务端把 GROUP BY / ORDER BY 的结果原样返回，别做隐式补全
      rowsAsArray: false
    })
    // 没有这个监听，连接被服务端掐掉时会抛未处理的 'error' 事件，进程直接崩
    conn.on('error', (err: Error) => console.error('[mysql] 连接异常', explainError(err)))
    this.conn = conn

    const [rows] = await conn.query('select version() as v, database() as db')
    const row = (rows as Array<{ v: string; db: string | null }>)[0]
    this.current = row?.db ?? this.cfg.database ?? ''
    return `MySQL ${row?.v ?? ''}`.trim()
  }

  private need(): Connection {
    if (!this.conn) throw new Error('连接已关闭')
    return this.conn
  }

  async close(): Promise<void> {
    if (!this.conn) return
    const c = this.conn
    this.conn = null
    await c.end().catch(() => undefined)
  }

  async query(sql: string, maxRows: number): Promise<QueryResult> {
    const conn = this.need()
    const t0 = nowMs()
    // rowsAsArray 让结果按列序返回，跟 pg 那边保持一致（同名列不会被覆盖）
    const [raw, fields] = await conn.query({ sql, rowsAsArray: true })
    const durationMs = nowMs() - t0
    const fps = (fields ?? []) as FieldPacket[]

    if (fps.length === 0) {
      // INSERT/UPDATE/DELETE/DDL：raw 是 ResultSetHeader
      const head = raw as unknown as { affectedRows?: number; info?: string }
      return {
        statement: sql,
        columns: [],
        rows: [],
        rowCount: 0,
        affectedRows: head?.affectedRows,
        durationMs
      }
    }

    const all = raw as unknown[][]
    const truncated = all.length > maxRows
    const rows = (truncated ? all.slice(0, maxRows) : all).map((r) => r.map(toCell))
    return {
      statement: sql,
      columns: fps.map((f) => ({
        name: f.name,
        dataType: mysqlTypeName(f.type),
        // flags & 1 = NOT_NULL_FLAG
        nullable: ((f.flags ?? 0) & 1) === 0
      })),
      rows,
      rowCount: rows.length,
      durationMs,
      truncated
    }
  }

  async databases(): Promise<string[]> {
    const conn = this.need()
    const [rows] = await conn.query(
      'select schema_name as n from information_schema.schemata order by 1'
    )
    return (rows as Array<{ n: string }>).map((r) => r.n).filter((n) => !HIDDEN_SCHEMAS.has(n))
  }

  /**
   * MySQL 没有 schema 这一层 —— 库即 schema。
   * 为了让上层的"库 → 模式 → 表"三级树对四种库都成立，这里把库名当成唯一模式返回。
   */
  async schemas(database?: string): Promise<string[]> {
    const name = database || this.current
    return name ? [name] : []
  }

  async tables(database: string | undefined, schema: string): Promise<TableInfo[]> {
    const conn = this.need()
    const [rows] = await conn.query(
      `select table_schema as \`schema\`, table_name as name,
              table_type as type, table_comment as comment
         from information_schema.tables
        where table_schema = ?
        order by table_name`,
      [database || schema]
    )
    return (rows as Array<Record<string, string>>).map((r) => ({
      schema: r.schema,
      name: r.name,
      // information_schema 给的是 'BASE TABLE' / 'VIEW'
      kind: /view/i.test(r.type) ? 'view' : 'table',
      comment: r.comment || undefined
    }))
  }

  async columns(
    database: string | undefined,
    schema: string,
    table: string
  ): Promise<ColumnInfo[]> {
    const conn = this.need()
    const [rows] = await conn.query(
      `select column_name as name, column_type as data_type,
              is_nullable as nullable, column_default as default_value,
              column_key as key_col, column_comment as comment
         from information_schema.columns
        where table_schema = ? and table_name = ?
        order by ordinal_position`,
      [database || schema, table]
    )
    return (rows as Array<Record<string, string | null>>).map((r) => ({
      name: String(r.name),
      dataType: String(r.data_type ?? ''),
      nullable: r.nullable === 'YES',
      primaryKey: r.key_col === 'PRI',
      defaultValue: r.default_value ?? undefined,
      comment: r.comment || undefined
    }))
  }

  async useDatabase(database: string): Promise<boolean> {
    const conn = this.need()
    // 库名是用户配置里来的，可能带反引号，先转义再拼 —— 反引号没法用占位符传
    await conn.query('use ' + '`' + database.replace(/`/g, '``') + '`')
    this.current = database
    return true
  }
}

/**
 * MySQL 协议里的类型码 → 类型名。
 * mysql2 只给数字，官方的常量表在 mysql2/lib/constants/types.js，不在公开导出里，
 * 所以这儿手抄一份常用的。
 */
const MY_TYPE: Record<number, string> = {
  0: 'decimal',
  1: 'tinyint',
  2: 'smallint',
  3: 'int',
  4: 'float',
  5: 'double',
  6: 'null',
  7: 'timestamp',
  8: 'bigint',
  9: 'mediumint',
  10: 'date',
  11: 'time',
  12: 'datetime',
  13: 'year',
  14: 'date',
  15: 'varchar',
  16: 'bit',
  245: 'json',
  246: 'decimal',
  247: 'enum',
  248: 'set',
  249: 'tinyblob',
  250: 'mediumblob',
  251: 'longblob',
  252: 'blob',
  253: 'varchar',
  254: 'char',
  255: 'geometry'
}

function mysqlTypeName(code: number): string {
  return MY_TYPE[code] ?? `type:${code}`
}
