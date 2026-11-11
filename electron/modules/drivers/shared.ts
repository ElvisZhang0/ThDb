import type { Cell, DbKind, TableInfo, ColumnInfo, QueryResult } from '../../types'

/**
 * 各家驱动的统一契约。
 *
 * 为什么元数据不走"统一的 information_schema 查询"：
 * 四家的数据字典差得太远 —— MySQL 没有 schema 层（库即 schema）、
 * 达梦走 Oracle 那套 ALL_TABLES / ALL_TAB_COLUMNS、金仓和 PG 用 pg_catalog。
 * 硬套一层抽象出来全是特判，不如让每个驱动自己写自己的 SQL。
 */
export interface DbDriver {
  readonly kind: DbKind

  /** 建立连接，返回服务端版本串 */
  connect(): Promise<string>
  close(): Promise<void>

  /** 只能跑一条语句（由 db-manager 拆分后逐条调用） */
  query(sql: string, maxRows: number): Promise<QueryResult>

  /** 库列表。MySQL 的"库"就是它自己的 database */
  databases(): Promise<string[]>
  /** 模式列表。MySQL 没有这一层，返回当前库名本身 */
  schemas(database?: string): Promise<string[]>
  tables(database: string | undefined, schema: string): Promise<TableInfo[]>
  columns(
    database: string | undefined,
    schema: string,
    table: string
  ): Promise<ColumnInfo[]>

  /**
   * 把"接下来 SQL 该跑在哪个库"切过去。
   * PG 那种"一个连接只能绑一个库"的，切库靠预建的客户端池；
   * MySQL 靠 USE。返回 false = 这次切换没生效（告诉界面别改高亮）。
   */
  useDatabase(database: string): Promise<boolean>

  /**
   * 中止正在执行的那条语句。可选 —— 只有 PG / 金仓真正实现了
   * （靠另开一条连接发 pg_cancel_backend），其余返回 false，
   * 界面据此提示"这个库不支持取消"。之所以不做成必需方法：
   * MySQL 的 KILL QUERY 得从另一条连接发，而我们没有额外的连接可用。
   */
  cancel?(): Promise<boolean>
}

/* ------------------------------------------------------------------ 值拍平 */

/**
 * 把驱动吐出来的任意值变成能过 IPC 的四种基本类型。
 *
 * IPC 用的是 structured clone：Date 能过但渲染层拿到的是 Date 对象不好直接显示，
 * Buffer 能过但到了界面上是 `<Buffer 0a 1b>`，自定义类直接丢原型。
 * 统一在这儿拍平，界面层就不用再写一堆 instanceof 判断。
 */
export function toCell(v: unknown): Cell {
  if (v === null || v === undefined) return null
  const t = typeof v
  if (t === 'string' || t === 'number' || t === 'boolean') return v as Cell
  if (t === 'bigint') {
    const n = Number(v as bigint)
    // 超过 2^53 的整数转 Number 会悄悄丢精度 —— 宁可给字符串
    return Number.isSafeInteger(n) ? n : (v as bigint).toString()
  }
  if (v instanceof Date) return formatDateTime(v)
  if (Buffer.isBuffer(v)) return toHex(v)
  if (ArrayBuffer.isView(v)) {
    const view = v as ArrayBufferView
    return toHex(Buffer.from(view.buffer, view.byteOffset, view.byteLength))
  }
  if (t === 'object') {
    try {
      return JSON.stringify(v)
    } catch {
      return String(v)
    }
  }
  return String(v)
}

/** `2026-11-10 14:23:01`，有毫秒才带毫秒 —— 时间戳列全是 .000 看着很吵 */
function formatDateTime(d: Date): string {
  if (Number.isNaN(d.getTime())) return 'Invalid Date'
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  const base =
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  return d.getMilliseconds() ? `${base}.${p(d.getMilliseconds(), 3)}` : base
}

/** 二进制列只给前 64 字节，够了 —— 全量铺在表格里既看不清也拖慢渲染 */
function toHex(buf: Buffer): string {
  const head = buf.subarray(0, 64).toString('hex').replace(/(..)/g, '$1 ').trim()
  return buf.length > 64 ? `0x${head} …（共 ${buf.length} 字节）` : `0x${head}`
}

/* --------------------------------------------------------------- SQL 切分 */

type Token = { text: string; kind: 'code' | 'quoted' | 'comment' }

/**
 * 把 SQL 拆成"代码 / 引号内 / 注释"三类片段。
 *
 * 为什么不能直接 `sql.split(';')`：
 * 字符串字面量里、注释里、PG 的 `$$ ... $$` 函数体里都能出现分号。
 * 直接切会把一条好好的建函数语句切成七八片，逐片执行全报语法错。
 */
function tokenize(sql: string): Token[] {
  const out: Token[] = []
  let code = ''
  const flush = () => {
    if (code) {
      out.push({ text: code, kind: 'code' })
      code = ''
    }
  }

  let i = 0
  while (i < sql.length) {
    const ch = sql[i]
    const next = sql[i + 1]

    // -- 行注释 / # 行注释（MySQL）
    if ((ch === '-' && next === '-') || ch === '#') {
      flush()
      let j = i
      while (j < sql.length && sql[j] !== '\n') j += 1
      out.push({ text: sql.slice(i, j), kind: 'comment' })
      i = j
      continue
    }

    // /* 块注释 */
    if (ch === '/' && next === '*') {
      flush()
      const end = sql.indexOf('*/', i + 2)
      const j = end < 0 ? sql.length : end + 2
      out.push({ text: sql.slice(i, j), kind: 'comment' })
      i = j
      continue
    }

    // '字符串' / "标识符" / `标识符`；'' 和 \' 都是转义
    if (ch === "'" || ch === '"' || ch === '`') {
      flush()
      let j = i + 1
      while (j < sql.length) {
        if (sql[j] === '\\' && ch !== '`') {
          j += 2 // MySQL 的反斜杠转义；PG 的 standard_conforming_strings 下也只是多跳一格
          continue
        }
        if (sql[j] === ch) {
          if (sql[j + 1] === ch) {
            j += 2 // '' 转义成一个引号
            continue
          }
          j += 1
          break
        }
        j += 1
      }
      out.push({ text: sql.slice(i, j), kind: 'quoted' })
      i = j
      continue
    }

    // PG 的美元引用 $tag$ ... $tag$
    if (ch === '$') {
      const m = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(sql.slice(i))
      if (m) {
        flush()
        const tag = m[0]
        const end = sql.indexOf(tag, i + tag.length)
        const j = end < 0 ? sql.length : end + tag.length
        out.push({ text: sql.slice(i, j), kind: 'quoted' })
        i = j
        continue
      }
    }

    code += ch
    i += 1
  }
  flush()
  return out
}

/** 拆成一条条可独立执行的语句；纯注释和空语句会被丢掉 */
export function splitStatements(sql: string): string[] {
  const parts: string[] = []
  let cur = ''

  for (const t of tokenize(sql)) {
    if (t.kind !== 'code') {
      cur += t.text
      continue
    }
    let rest = t.text
    let idx = rest.indexOf(';')
    while (idx >= 0) {
      cur += rest.slice(0, idx)
      const s = cur.trim()
      // 只由注释组成的片段没有执行价值，跳过
      if (s && !/^(\s*(--[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/)\s*)+$/.test(s)) parts.push(s)
      cur = ''
      rest = rest.slice(idx + 1)
      idx = rest.indexOf(';')
    }
    cur += rest
  }

  const tail = cur.trim()
  if (tail && !/^(\s*(--[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/)\s*)+$/.test(tail)) parts.push(tail)
  return parts
}

/** 语句开头的动词，用来决定结果区怎么显示（"影响 3 行" vs 表格） */
export function statementVerb(sql: string): string {
  const m = /^\s*(\w+)/.exec(sql)
  return (m?.[1] ?? '').toUpperCase()
}

/* ------------------------------------------------------------------ 错误 */

/**
 * 把驱动的原始报错翻译成人能看懂的一句话。
 *
 * 驱动抛出来的东西五花八门：Node 的网络错误只有 code，pg 的错误带 detail/hint，
 * MySQL 的错误文案是英文的。界面只有一个红色提示条，所以必须在这儿收口。
 */
export function explainError(err: unknown): string {
  const e = err as { code?: string; message?: string; detail?: string; hint?: string; errno?: number }
  const msg = e?.message ?? String(err)

  switch (e?.code) {
    case 'ECONNREFUSED':
      return `连接被拒绝：目标端口没有服务在监听（${msg}）`
    case 'ENOTFOUND':
      return `域名解析失败：检查主机名是否写错（${msg}）`
    case 'ETIMEDOUT':
    case 'ETIMEOUT':
      return `连接超时：网络不通、防火墙拦截，或者对方没开这个端口`
    case 'ECONNRESET':
      return `连接被对方重置：可能是 SSL 配置不匹配，或者服务端主动断开了空闲连接`
    case 'EHOSTUNREACH':
      return `主机不可达（${msg}）`
    case '28P01':
    case '28000':
      return `认证失败：用户名或密码不对（${msg}）`
    case '3D000':
      return `目标数据库不存在：${msg}`
    case 'ER_ACCESS_DENIED_ERROR':
      return `认证失败：用户名或密码不对（${msg}）`
    case 'ER_BAD_DB_ERROR':
      return `目标数据库不存在：${msg}`
    case 'ER_NO_SUCH_TABLE':
      return `表不存在：${msg}`
    case '42P01':
      return `表不存在：${msg}`
    default:
      break
  }

  // pg 的 detail/hint 里经常藏着真正的原因（比如违反约束时到底哪一列冲突）
  const extra = [e?.detail, e?.hint].filter(Boolean).join(' —— ')
  return extra ? `${msg}\n${extra}` : msg
}

/** 给标识符加引号。各家的引号不一样，且标识符里可能有空格/保留字 */
export function quoteIdent(kind: DbKind, name: string): string {
  if (kind === 'mysql') return '`' + name.replace(/`/g, '``') + '`'
  return '"' + name.replace(/"/g, '""') + '"'
}

/** 把标识符塞进字符串字面量（元数据查询里当条件用） */
export function quoteLiteral(name: string): string {
  return "'" + name.replace(/'/g, "''") + "'"
}

/** 计时用的，精度比 Date.now() 高得多 */
export function nowMs(): number {
  return Number(process.hrtime.bigint() / 1000n) / 1000
}
