import { Client } from 'pg'
import type { ConnectionConfig, DbKind, ColumnInfo, QueryResult, TableInfo } from '../../types'
import { explainError, nowMs, toCell, type DbDriver } from './shared'

/**
 * PostgreSQL 驱动，同时服务人大金仓 KingBase。
 *
 * 为什么金仓能复用：KingBase V8 的通信协议就是 PG 的 wire protocol，
 * pg_catalog 也基本对齐 PG 12。`pg` 驱动连上去直接能用，差别只在
 * ① 默认端口 54321（有的部署改成 5432/5433）
 * ② 默认模式名有可能是大写的 PUBLIC 而不是 public
 * ③ 部分版本不支持 SCRAM 认证，得用 md5 —— 这个由服务端决定，客户端不用管
 */
export class PostgresDriver implements DbDriver {
  readonly kind: DbKind

  /**
   * 一个 PG 连接只能看到**一个**库，跨库查不了。
   * 想做出"连接树上能点到别的库"的体验，只能给每个库各开一条连接，按需建、用完留着。
   * Navicat 也是这么干的。
   */
  private clients = new Map<string, Client>()
  private active = ''
  private closed = false
  /** 当前活跃连接在服务端的 backend pid，取消查询要用它 */
  private pid = 0

  constructor(private cfg: ConnectionConfig) {
    this.kind = cfg.kind
  }

  async connect(): Promise<string> {
    const client = await this.makeClient(this.cfg.database)
    const db = await client.query<{ db: string; pid: number }>(
      'select current_database() as db, pg_backend_pid() as pid'
    )
    this.active = db.rows[0]?.db ?? this.cfg.database ?? ''
    this.pid = Number(db.rows[0]?.pid ?? 0)
    this.clients.set(this.active, client)
    const v = await client.query<{ v: string }>('select version() as v')
    return v.rows[0]?.v ?? 'PostgreSQL'
  }

  private async makeClient(database?: string): Promise<Client> {
    const client = new Client({
      host: this.cfg.host,
      port: this.cfg.port,
      user: this.cfg.user,
      password: this.cfg.password,
      database: database || undefined,
      ssl: this.cfg.ssl ? { rejectUnauthorized: false } : undefined,
      application_name: 'ThBD',
      connectionTimeoutMillis: 15000
    })
    // 没有这个监听，服务端一断线（重启、被 DBA 杀掉会话）整个进程会因为
    // 未处理的 'error' 事件直接崩掉
    client.on('error', (err) => console.error('[pg] 连接异常', explainError(err)))
    await client.connect()
    return client
  }

  /** 取指定库的连接；不传就用当前活跃库 */
  private async get(database?: string): Promise<Client> {
    const name = database || this.active || this.cfg.database || ''
    const hit = name ? this.clients.get(name) : undefined
    if (hit) return hit
    const client = await this.makeClient(name || undefined)
    if (name) this.clients.set(name, client)
    return client
  }

  async close(): Promise<void> {
    this.closed = true
    const all = [...this.clients.values()]
    this.clients.clear()
    await Promise.all(all.map((c) => c.end().catch(() => undefined)))
  }

  async query(sql: string, maxRows: number): Promise<QueryResult> {
    if (this.closed) throw new Error('连接已关闭')
    const client = await this.get()
    const t0 = nowMs()
    // rowMode: 'array' —— 见 types.ts 里 QueryResult.rows 为什么要二维数组
    const res = await client.query({ text: sql, rowMode: 'array' })
    const durationMs = nowMs() - t0

    const fields = res.fields ?? []
    const rawRows = (res.rows ?? []) as unknown[][]
    const truncated = rawRows.length > maxRows
    const rows = (truncated ? rawRows.slice(0, maxRows) : rawRows).map((r) => r.map(toCell))

    return {
      statement: sql,
      columns: fields.map((f) => ({
        name: f.name,
        dataType: oidName(f.dataTypeID)
      })),
      rows,
      // SELECT 时 rowCount 是取到的行数；INSERT/UPDATE/DELETE 时是影响行数；
      // DDL 时是 null，这时候只说"执行成功"
      rowCount: rows.length,
      affectedRows: fields.length === 0 ? (res.rowCount ?? undefined) : undefined,
      durationMs,
      truncated
    }
  }

  async databases(): Promise<string[]> {
    const client = await this.get()
    const r = await client.query<{ n: string }>(
      'select datname as n from pg_database where not datistemplate order by 1'
    )
    return r.rows.map((x) => x.n)
  }

  async schemas(database?: string): Promise<string[]> {
    const client = await this.get(database)
    const r = await client.query<{ n: string }>(
      `select nspname as n from pg_namespace
        where nspname not in ('pg_catalog','information_schema','pg_toast')
          and nspname not like 'pg_temp%'
          and nspname not like 'pg_toast_temp%'
        order by 1`
    )
    return r.rows.map((x) => x.n)
  }

  async tables(database: string | undefined, schema: string): Promise<TableInfo[]> {
    const client = await this.get(database)
    const r = await client.query<{
      schema: string
      name: string
      kind: string
      comment: string | null
    }>(
      `select n.nspname as schema,
              c.relname as name,
              case c.relkind
                when 'r' then 'table'
                when 'v' then 'view'
                when 'm' then 'matview'
                when 'p' then 'partitioned'
                when 'f' then 'foreign'
              end as kind,
              obj_description(c.oid, 'pg_class') as comment
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = $1
          and c.relkind in ('r','v','m','p','f')
        order by 1, 2`,
      [schema]
    )
    return r.rows.map((x) => ({
      schema: x.schema,
      name: x.name,
      kind: x.kind ?? 'table',
      comment: x.comment ?? undefined
    }))
  }

  async columns(
    database: string | undefined,
    schema: string,
    table: string
  ): Promise<ColumnInfo[]> {
    const client = await this.get(database)
    const r = await client.query<{
      name: string
      data_type: string
      nullable: boolean
      default_value: string | null
      comment: string | null
      pk: boolean
    }>(
      `select a.attname as name,
              format_type(a.atttypid, a.atttypmod) as data_type,
              not a.attnotnull as nullable,
              pg_get_expr(d.adbin, d.adrelid) as default_value,
              col_description(a.attrelid, a.attnum) as comment,
              exists (
                select 1 from pg_index i
                 where i.indrelid = a.attrelid
                   and a.attnum = any(i.indkey)
                   and i.indisprimary
              ) as pk
         from pg_attribute a
         join pg_class c on c.oid = a.attrelid
         join pg_namespace n on n.oid = c.relnamespace
         left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
        where n.nspname = $1 and c.relname = $2 and a.attnum > 0 and not a.attisdropped
        order by a.attnum`,
      [schema, table]
    )
    return r.rows.map((x) => ({
      name: x.name,
      dataType: x.data_type,
      nullable: x.nullable,
      primaryKey: x.pk,
      defaultValue: x.default_value ?? undefined,
      comment: x.comment ?? undefined
    }))
  }

  async useDatabase(database: string): Promise<boolean> {
    // 先保证连接建起来了；建不起来就抛给上层，别让界面以为切换成功
    await this.get(database)
    this.active = database
    const client = this.clients.get(database)
    if (client) {
      // 切库之后 pid 也变了，取消功能得跟着换
      client
        .query<{ pid: number }>('select pg_backend_pid() as pid')
        .then((r) => {
          if (this.active === database) this.pid = Number(r.rows[0]?.pid ?? 0)
        })
        .catch(() => undefined)
    }
    return true
  }

  /**
   * 取消正在跑的语句。
   *
   * 为什么不直接 destroy 客户端：那会把整条连接连同会话状态（临时表、SET 过的参数、
   * 事务）一起炸掉，用户只是想让一条慢查询停下来。
   * pg_cancel_backend 是官方支持的"只停这条语句"手段 —— 但它得**从另一条连接发**，
   * 因为我们自己的连接此刻正忙在查询里，再往上排任务只会排在后面等。
   */
  async cancel(): Promise<boolean> {
    if (!this.pid) return false
    const tmp = new Client({
      host: this.cfg.host,
      port: this.cfg.port,
      user: this.cfg.user,
      password: this.cfg.password,
      database: this.active || this.cfg.database || undefined,
      ssl: this.cfg.ssl ? { rejectUnauthorized: false } : undefined,
      application_name: 'ThBD-cancel',
      connectionTimeoutMillis: 5000
    })
    try {
      await tmp.connect()
      const r = await tmp.query<{ ok: boolean }>('select pg_cancel_backend($1) as ok', [this.pid])
      return r.rows[0]?.ok === true
    } catch (err) {
      console.error('[pg] 取消查询失败', explainError(err))
      return false
    } finally {
      await tmp.end().catch(() => undefined)
    }
  }
}

/**
 * OID → 类型名。
 *
 * pg 的结果集只给 dataTypeID，不给类型名（省一次系统表查询）。
 * 这里列的是内置类型的全集里最常用的那批；查不到的显示 `oid:1234`，
 * 不影响使用，只是看着朴素一点。
 */
const OID: Record<number, string> = {
  16: 'bool',
  17: 'bytea',
  18: 'char',
  19: 'name',
  20: 'int8',
  21: 'int2',
  23: 'int4',
  25: 'text',
  26: 'oid',
  114: 'json',
  142: 'xml',
  194: 'pg_node_tree',
  600: 'point',
  601: 'lseg',
  602: 'path',
  603: 'box',
  604: 'polygon',
  628: 'line',
  650: 'cidr',
  700: 'float4',
  701: 'float8',
  705: 'unknown',
  790: 'money',
  829: 'macaddr',
  869: 'inet',
  1042: 'bpchar',
  1043: 'varchar',
  1082: 'date',
  1083: 'time',
  1114: 'timestamp',
  1184: 'timestamptz',
  1186: 'interval',
  1266: 'timetz',
  1560: 'bit',
  1562: 'varbit',
  1700: 'numeric',
  2950: 'uuid',
  3802: 'jsonb',
  3904: 'int4range',
  3906: 'numrange',
  3908: 'tsrange',
  3910: 'tstzrange',
  3912: 'daterange'
}

function oidName(oid: number): string {
  return OID[oid] ?? `oid:${oid}`
}
