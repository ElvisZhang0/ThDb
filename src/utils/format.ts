import type { Cell, QueryResult } from '../../electron/types'

/** NULL 在表格里单独上色，但复制出去必须是空 —— 别把字面量 'NULL' 复制进下游系统 */
export function displayCell(v: Cell): string {
  if (v === null) return 'NULL'
  return String(v)
}

/** 结果页签的标题：取语句第一个有意义的部分，太长就截断 */
export function shortStatement(sql: string, max = 28): string {
  const one = sql.replace(/\s+/g, ' ').trim()
  return one.length > max ? one.slice(0, max) + '…' : one
}

/** 999.9ms → "1.00 s"；小于 1 秒给两位小数毫秒 */
export function formatDuration(ms: number): string {
  if (ms < 1) return '<1 ms'
  if (ms < 1000) return `${ms.toFixed(ms < 10 ? 2 : 0)} ms`
  return `${(ms / 1000).toFixed(2)} s`
}

export function formatCount(n: number): string {
  return n.toLocaleString('zh-CN')
}

/**
 * CSV 转义。
 *
 * 三个坑：
 * ① 值里有逗号、引号、换行 → 整体加双引号，内部引号翻倍
 * ② 值以 = + - @ 开头 → 前面加个单引号。这是 Excel 的公式注入（CSV Injection）面门，
 *    一条 `=cmd|'/c calc'!A0` 就能在打开表格的人机器上执行命令
 * ③ 空字符串和 NULL 要能区分开：NULL 输出空，空字符串输出 ""（带引号）
 */
export function csvCell(v: Cell): string {
  if (v === null) return ''
  const s = String(v)
  if (/^[=+\-@\t\r]/.test(s)) return `"'${s.replace(/"/g, '""')}"`
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

export function toCsv(result: QueryResult): string {
  const head = result.columns.map((c) => csvCell(c.name)).join(',')
  const body = result.rows.map((r) => r.map(csvCell).join(','))
  return [head, ...body].join('\r\n')
}

/** 制表符分隔，粘进 Excel / 飞书表格是分列好的 */
export function toTsv(result: QueryResult): string {
  const clean = (v: Cell) => (v === null ? '' : String(v).replace(/[\t\r\n]/g, ' '))
  const head = result.columns.map((c) => clean(c.name)).join('\t')
  const body = result.rows.map((r) => r.map(clean).join('\t'))
  return [head, ...body].join('\n')
}

/** 复制单行（表头 + 该行），粘到聊天窗口里能看懂 */
export function rowAsText(result: QueryResult, rowIndex: number): string {
  const row = result.rows[rowIndex] ?? []
  return result.columns
    .map((c, i) => `${c.name}: ${row[i] === null ? 'NULL' : String(row[i])}`)
    .join('\n')
}
