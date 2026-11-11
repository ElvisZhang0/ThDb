import { randomUUID } from 'node:crypto'
import type { ConnectionConfig, ExecuteResult, QueryResult, SessionInfo } from '../types'
import { createDriver, type DbDriver } from './drivers'
import { explainError, nowMs, splitStatements } from './drivers/shared'

interface Session {
  driver: DbDriver
  info: SessionInfo
  /** 当前活跃库，界面标题栏显示用 */
  database?: string
}

const sessions = new Map<string, Session>()

/** 未抛错的连接过程：连上就返回版本串，连不上把错误翻译成人话再抛 */
export async function testConnection(cfg: ConnectionConfig): Promise<string> {
  const driver = createDriver(cfg)
  try {
    return await driver.connect()
  } catch (err) {
    throw new Error(explainError(err))
  } finally {
    await driver.close().catch(() => undefined)
  }
}

export async function openSession(cfg: ConnectionConfig): Promise<SessionInfo> {
  const driver = createDriver(cfg)
  let version: string
  try {
    version = await driver.connect()
  } catch (err) {
    // 连接失败时 driver 内部可能已经建了半个连接池，关一次不亏
    await driver.close().catch(() => undefined)
    throw new Error(explainError(err))
  }

  const info: SessionInfo = {
    sessionId: randomUUID(),
    connectionId: cfg.id,
    serverVersion: version,
    connectedAt: Date.now()
  }
  sessions.set(info.sessionId, { driver, info, database: cfg.database })
  return info
}

export async function closeSession(sessionId: string): Promise<void> {
  const s = sessions.get(sessionId)
  if (!s) return
  sessions.delete(sessionId)
  await s.driver.close().catch(() => undefined)
}

export async function closeAll(): Promise<void> {
  const all = [...sessions.values()]
  sessions.clear()
  await Promise.all(all.map((s) => s.driver.close().catch(() => undefined)))
}

function need(sessionId: string): Session {
  const s = sessions.get(sessionId)
  if (!s) throw new Error('会话已断开，请重新连接')
  return s
}

export function sessionDriver(sessionId: string): DbDriver {
  return need(sessionId).driver
}

export function sessionDatabase(sessionId: string): string | undefined {
  return sessions.get(sessionId)?.database
}

export async function useDatabase(sessionId: string, database: string): Promise<boolean> {
  const s = need(sessionId)
  const ok = await s.driver.useDatabase(database)
  if (ok) s.database = database
  return ok
}

/**
 * 执行编辑器里的 SQL —— 可能是好几条。
 *
 * 三条规则：
 * ① **按分号拆开逐条跑**，不是整段丢给驱动。原因：MySQL 的多语句要求
 *    multipleStatements: true，那是 SQL 注入的经典入口；PG 虽然原生支持整段，
 *    但一次返回多个 ResultSet 时处理起来更乱。拆开跑，结果与错误都能精确到某一条。
 * ② **碰到第一条错误就停**。继续跑下去的话，用户会看到后面一堆"表不存在"的连带错误，
 *    分不清哪个才是真原因。
 * ③ 已经成功的那几条的结果**照样返回**，界面能显示"前两条成功，第 3 条失败"。
 */
export async function execute(
  sessionId: string,
  sql: string,
  maxRows: number
): Promise<ExecuteResult> {
  const s = need(sessionId)
  const statements = splitStatements(sql)
  if (!statements.length) return { results: [], durationMs: 0 }

  const t0 = nowMs()
  const results: QueryResult[] = []

  for (const st of statements) {
    const st0 = nowMs()
    try {
      results.push(await s.driver.query(st, maxRows))
    } catch (err) {
      results.push({
        statement: st,
        columns: [],
        rows: [],
        rowCount: 0,
        durationMs: nowMs() - st0,
        error: explainError(err)
      })
      break
    }
  }

  return { results, durationMs: nowMs() - t0 }
}

export async function cancel(sessionId: string): Promise<boolean> {
  const s = sessions.get(sessionId)
  if (!s?.driver.cancel) return false
  return s.driver.cancel().catch(() => false)
}
