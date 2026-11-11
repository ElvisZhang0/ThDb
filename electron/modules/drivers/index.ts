import { createRequire } from 'node:module'
import type { ConnectionConfig, DbKind } from '../../types'
import type { DbDriver } from './shared'
import { PostgresDriver } from './postgres'
import { MysqlDriver } from './mysql'
import { DmDriver, dmdbAvailability } from './dm'

export type { DbDriver } from './shared'

export function createDriver(cfg: ConnectionConfig): DbDriver {
  switch (cfg.kind) {
    case 'postgres':
    // 金仓走 PG 协议，复用同一个实现，差别只在默认端口和个别字典视图
    case 'kingbase':
      return new PostgresDriver(cfg)
    case 'mysql':
      return new MysqlDriver(cfg)
    case 'dm':
      return new DmDriver(cfg)
    default:
      throw new Error(`不支持的数据库类型：${String((cfg as ConnectionConfig).kind)}`)
  }
}

/** app.info 里展示"哪个驱动能用、哪个没装上"，装不上的要能自证清白 */
export function driverReport(): { kind: DbKind; available: boolean; version?: string; reason?: string }[] {
  const req = createRequire(__filename)
  const report: { kind: DbKind; available: boolean; version?: string; reason?: string }[] = []

  try {
    report.push({ kind: 'postgres', available: true, version: req('pg/package.json').version })
  } catch (err) {
    report.push({ kind: 'postgres', available: false, reason: (err as Error).message })
  }

  // 金仓和 PG 共用驱动，可用性跟着 pg 走
  report.push({ ...report[0], kind: 'kingbase' })

  try {
    report.push({ kind: 'mysql', available: true, version: req('mysql2/package.json').version })
  } catch (err) {
    report.push({ kind: 'mysql', available: false, reason: (err as Error).message })
  }

  report.push({ kind: 'dm', ...dmdbAvailability() })
  return report
}
