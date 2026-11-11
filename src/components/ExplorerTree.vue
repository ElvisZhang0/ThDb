<script setup lang="ts">
import { computed, ref } from 'vue'
import { ElMessage } from 'element-plus'
import type { ConnectionConfig, DbKind } from '../../electron/types'
import { KIND_LABEL } from '../../electron/types'
import { useAppStore } from '../stores/app'
import DbIcon from './DbIcon.vue'

const emit = defineEmits<{
  run: [sql: string]
  edit: [cfg: ConnectionConfig]
}>()

const store = useAppStore()

interface TreeNode {
  id: string
  label: string
  type: 'group' | 'conn' | 'database' | 'schema' | 'table' | 'column' | 'info'
  connId?: string
  database?: string
  schema?: string
  table?: string
  /** 表节点的具体种类：table / view / matview … */
  relKind?: string
  dataType?: string
  primaryKey?: boolean
  isLeaf?: boolean
}

/* el-tree 的节点数据由懒加载回调自己产出，所以这里不预建整棵树 */

const treeRef = ref<any>(null)
const keyword = ref('')
/** 分组数 / 连接数变了要整体重建，否则新旧节点混在一棵树里 */
const treeKey = computed(() => `${store.config.groups.length}-${store.config.connections.length}`)
/** 手动刷新时用的覆盖 key：值一变 el-tree 就整个重挂 */
const forceKey = ref('')
const actualKey = computed(() => forceKey.value || treeKey.value)

/** 只有一个分组时不显示分组这一层 —— 多一次点击换不来任何信息 */
const showGroups = computed(() => store.config.groups.length > 1)

/* ---------------------------------------------------------------- 数据装配 */

function cfgOf(connId: string): ConnectionConfig | undefined {
  return store.config.connections.find((c) => c.id === connId)
}

function sessionOf(connId: string): string {
  return store.open[connId]?.info.sessionId ?? ''
}

function groupRoots(): TreeNode[] {
  if (!showGroups.value) return store.config.connections.map(connNode)
  return store.config.groups.map((g) => ({
    id: `grp:${g.id}`,
    label: g.name,
    type: 'group',
    connId: g.id
  }))
}

function connNode(cfg: ConnectionConfig): TreeNode {
  return {
    id: `conn:${cfg.id}`,
    label: cfg.name,
    type: 'conn',
    connId: cfg.id
  }
}

function errorNode(err: unknown): TreeNode {
  return {
    id: `err:${Math.random().toString(36).slice(2)}`,
    label: String((err as Error)?.message ?? err).replace(
      /^Error invoking remote method '[^']+': /,
      ''
    ),
    type: 'info',
    isLeaf: true
  }
}

/**
 * 树形层级因库而异：
 *   PG / 金仓：连接 → 库 → 模式 → 表 → 列
 *   MySQL     ：连接 → 库 → 表 → 列（库即模式，不摆一个恒等于库名的空层级）
 *   达梦       ：连接 → 模式 → 表 → 列（没有真实的"多库"概念）
 */
async function childrenOfConn(d: TreeNode): Promise<TreeNode[]> {
  const cfg = cfgOf(d.connId!)
  if (!cfg) return []
  // 展开就等于连接：让"点开看一眼"这个动作一步到位
  if (!store.open[cfg.id]) await store.connect(cfg)

  const sid = sessionOf(d.connId!)
  if (cfg.kind === 'dm') {
    const schemas = await window.api.db.schemas(sid)
    return schemas.map((s) => schemaNode(cfg.id, '', s))
  }
  const dbs = await window.api.db.databases(sid)
  return dbs.map((name) => ({
    id: `db:${cfg.id}:${name}`,
    label: name,
    type: 'database' as const,
    connId: cfg.id,
    database: name
  }))
}

async function childrenOfDatabase(d: TreeNode): Promise<TreeNode[]> {
  const cfg = cfgOf(d.connId!)!
  const sid = sessionOf(d.connId!)
  if (cfg.kind === 'mysql') {
    // MySQL 的库就是模式，直接出表
    return tablesOf(cfg.id, d.database!, d.database!)
  }
  const schemas = await window.api.db.schemas(sid, d.database)
  return schemas.map((s) => schemaNode(cfg.id, d.database!, s))
}

function schemaNode(connId: string, database: string, schema: string): TreeNode {
  return {
    id: `sch:${connId}:${database}:${schema}`,
    label: schema,
    type: 'schema',
    connId,
    database,
    schema
  }
}

async function tablesOf(connId: string, database: string, schema: string): Promise<TreeNode[]> {
  const sid = sessionOf(connId)
  const list = await window.api.db.tables(sid, database || undefined, schema)
  return list.map((t) => ({
    id: `tbl:${connId}:${database}:${schema}:${t.name}`,
    label: t.name,
    type: 'table' as const,
    connId,
    database,
    schema,
    table: t.name,
    relKind: t.kind
  }))
}

async function columnsOf(d: TreeNode): Promise<TreeNode[]> {
  const sid = sessionOf(d.connId!)
  const cols = await window.api.db.columns(sid, d.database || undefined, d.schema!, d.table!)
  return cols.map((c) => ({
    id: `col:${d.connId}:${d.schema}:${d.table}:${c.name}`,
    label: c.name,
    type: 'column' as const,
    connId: d.connId,
    database: d.database,
    schema: d.schema,
    table: d.table,
    dataType: c.dataType,
    primaryKey: c.primaryKey,
    isLeaf: true
  }))
}

async function loadNode(node: any, resolve: (nodes: TreeNode[]) => void): Promise<void> {
  try {
    if (node.level === 0) {
      resolve(groupRoots())
      return
    }
    const d = node.data as TreeNode
    switch (d.type) {
      case 'group':
        resolve(
          store.config.connections.filter((c) => c.groupId === d.connId).map(connNode)
        )
        return
      case 'conn':
        resolve(await childrenOfConn(d))
        return
      case 'database':
        resolve(await childrenOfDatabase(d))
        return
      case 'schema':
        resolve(await tablesOf(d.connId!, d.database!, d.schema!))
        return
      case 'table':
        resolve(await columnsOf(d))
        return
      default:
        resolve([])
    }
  } catch (err) {
    // 加载失败也要给个能看见的节点，否则用户面对的是一个点了没反应的空节点
    resolve([errorNode(err)])
  }
}

/* ---------------------------------------------------------------- 交互 */

function quoteIdent(kind: DbKind, name: string): string {
  return kind === 'mysql' ? '`' + name.replace(/`/g, '``') + '`' : '"' + name.replace(/"/g, '""') + '"'
}

/** 双击表 → 直接查前 200 行。这是数据库工具里最高频的动作，值得给个快捷方式 */
async function runTable(d: TreeNode): Promise<void> {
  const cfg = cfgOf(d.connId!)
  if (!cfg) return
  const ident =
    cfg.kind === 'mysql' || !d.schema
      ? quoteIdent(cfg.kind, d.table!)
      : `${quoteIdent(cfg.kind, d.schema)}.${quoteIdent(cfg.kind, d.table!)}`
  emit('run', `select *\n  from ${ident}\n limit 200;`)
}

function onNodeClick(d: TreeNode): void {
  if (d.type === 'conn') {
    store.activate(d.connId!)
    return
  }
  if (d.type === 'info') return
  // 点任何子节点都顺手把对应连接激活 —— 用户点它就是想在这儿操作
  if (d.connId) store.activate(d.connId)
  if (d.type === 'database') void store.switchDatabase(d.database!)
}

async function toggleConnect(d: TreeNode): Promise<void> {
  const cfg = cfgOf(d.connId!)
  if (!cfg) return
  if (store.open[cfg.id]) {
    await store.disconnect(cfg.id)
    return
  }
  try {
    await store.connect(cfg)
  } catch (err) {
    ElMessage.error((err as Error).message.replace(/^Error invoking remote method '[^']+': /, ''))
  }
}

function refresh(): void {
  // 懒加载的 el-tree 没有"重载子树"的公开接口，最稳的办法是整棵树重建
  forceKey.value = `${treeKey.value}:${Date.now()}`
}

function filterNode(value: string, data: TreeNode): boolean {
  if (!value) return true
  return data.label.toLowerCase().includes(value.toLowerCase())
}

function onFilter(): void {
  treeRef.value?.filter(keyword.value)
}

function iconKind(d: TreeNode): 'postgres' | 'mysql' | 'kingbase' | 'dm' | 'database' | 'schema' | 'table' | 'view' | 'column' | 'key' {
  if (d.type === 'conn') return cfgOf(d.connId!)?.kind ?? 'postgres'
  if (d.type === 'database') return 'database'
  if (d.type === 'schema') return 'schema'
  if (d.type === 'table') return d.relKind === 'view' || d.relKind === 'matview' ? 'view' : 'table'
  if (d.type === 'column') return d.primaryKey ? 'key' : 'column'
  return 'schema'
}

defineExpose({ refresh })
</script>

<template>
  <div class="explorer">
    <div class="head">
      <span class="title">连接</span>
      <div class="acts">
        <button class="ico" title="新建连接" @click="emit('edit', store.blankConnection())">＋</button>
        <button class="ico" title="刷新" @click="refresh">⟳</button>
      </div>
    </div>

    <div class="search">
      <input v-model="keyword" placeholder="过滤表名…" spellcheck="false" @input="onFilter" />
    </div>

    <div class="tree-wrap">
      <!-- 没连接时整棵 el-tree 不渲染：它自带一个"暂无数据"占位，
           会和下面自己写的引导块叠在一起显示两遍 -->
      <el-tree
        v-if="store.config.connections.length"
        ref="treeRef"
        :key="actualKey"
        lazy
        :load="loadNode"
        :props="{ label: 'label', isLeaf: 'isLeaf' }"
        node-key="id"
        :expand-on-click-node="false"
        :highlight-current="true"
        :filter-node-method="filterNode"
        :indent="14"
        @node-click="(_d: unknown, node: any) => onNodeClick(node.data)"
      >
        <template #default="{ data }">
          <div class="node" :class="{ dim: data.type === 'info', err: data.type === 'info' }">
            <template v-if="data.type === 'info'">
              <span class="label err-text">{{ data.label }}</span>
            </template>
            <template v-else>
              <DbIcon :kind="iconKind(data)" />
              <span class="label" :class="{ mono: data.type === 'column' }">{{ data.label }}</span>
              <span v-if="data.type === 'column' && data.dataType" class="type">{{ data.dataType }}</span>
              <span v-if="data.type === 'table' && data.relKind === 'view'" class="tag">视图</span>
              <span v-if="data.type === 'database' && store.open[data.connId!]?.database === data.database" class="dot" title="当前库" />
              <span v-if="data.type === 'conn'" class="state" :class="{ on: !!store.open[data.connId!] }" :title="store.open[data.connId!] ? '已连接' : '未连接'" />
            </template>

            <span class="row-acts">
              <button
                v-if="data.type === 'table'"
                class="mini"
                title="查询前 200 行"
                @click.stop="runTable(data)"
              >▶</button>
              <button
                v-if="data.type === 'conn'"
                class="mini"
                :title="store.open[data.connId!] ? '断开连接' : '连接'"
                @click.stop="toggleConnect(data)"
              >{{ store.open[data.connId!] ? '⏻' : '⚡' }}</button>
              <button
                v-if="data.type === 'conn'"
                class="mini"
                title="编辑连接"
                @click.stop="emit('edit', cfgOf(data.connId!)!)"
              >✎</button>
            </span>
          </div>
        </template>
      </el-tree>

      <div v-if="!store.config.connections.length" class="empty">
        <p>还没有连接</p>
        <el-button size="small" @click="emit('edit', store.blankConnection())">新建第一条连接</el-button>
        <p class="hint">支持 PostgreSQL / MySQL / 人大金仓 / 达梦</p>
      </div>
    </div>

    <div class="legend">
      <span>{{ KIND_LABEL.postgres }}</span>
      <span>{{ KIND_LABEL.mysql }}</span>
      <span>{{ KIND_LABEL.kingbase.split(' ')[0] }}</span>
      <span>{{ KIND_LABEL.dm.split(' ')[0] }}</span>
    </div>
  </div>
</template>

<style scoped>
.explorer {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg-panel);
  border-right: 1px solid var(--border);
}

.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 10px 8px 14px;
}
.title {
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.08em;
  color: var(--text-faint);
  text-transform: uppercase;
}
.acts {
  display: flex;
  gap: 2px;
}
.ico {
  width: 22px;
  height: 22px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-dim);
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
}
.ico:hover {
  background: var(--bg-hover);
  color: var(--text);
}

.search {
  padding: 0 10px 8px;
}
.search input {
  width: 100%;
  height: 26px;
  padding: 0 8px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
  background: var(--bg-elev);
  color: var(--text);
  font-size: 12px;
  font-family: inherit;
  outline: none;
}
.search input:focus {
  border-color: var(--accent);
}

.tree-wrap {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding-bottom: 8px;
}

.node {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  min-width: 0;
  font-size: 12.5px;
  color: var(--text);
}
.label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.label.mono {
  font-family: var(--font-mono);
  font-size: 12px;
}
.type {
  flex: 0 0 auto;
  color: var(--text-faint);
  font-size: 11px;
  font-family: var(--font-mono);
  opacity: 0.8;
}
.tag {
  flex: 0 0 auto;
  padding: 0 4px;
  border-radius: 3px;
  background: var(--bg-active);
  color: var(--text-dim);
  font-size: 10px;
  line-height: 14px;
}
.dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--accent);
  flex: 0 0 auto;
}
.state {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--text-faint);
  opacity: 0.5;
  flex: 0 0 auto;
}
.state.on {
  background: var(--accent);
  opacity: 1;
  box-shadow: 0 0 0 2px var(--accent-soft);
}

.row-acts {
  margin-left: auto;
  display: flex;
  gap: 1px;
  opacity: 0;
  transition: opacity 0.1s;
}
.node:hover .row-acts {
  opacity: 1;
}
.mini {
  width: 18px;
  height: 18px;
  border: none;
  border-radius: 3px;
  background: transparent;
  color: var(--text-dim);
  font-size: 10px;
  cursor: pointer;
  line-height: 1;
}
.mini:hover {
  background: var(--bg-active);
  color: var(--accent);
}

.err-text {
  color: var(--danger);
  white-space: normal;
  word-break: break-all;
  font-size: 11.5px;
  line-height: 1.4;
  padding: 2px 0;
}

.empty {
  padding: 26px 18px;
  text-align: center;
  color: var(--text-faint);
  font-size: 12px;
}
.empty p {
  margin: 0 0 10px;
}
.empty .hint {
  margin-top: 12px;
  font-size: 11px;
  opacity: 0.7;
}

.legend {
  flex: 0 0 auto;
  display: flex;
  gap: 10px;
  padding: 6px 12px;
  border-top: 1px solid var(--border-soft);
  color: var(--text-faint);
  font-size: 10.5px;
}

/* el-tree 默认节点的行高和 hover 背景跟这套主题不搭，覆盖掉 */
:deep(.el-tree) {
  background: transparent;
  --el-tree-node-hover-bg-color: var(--bg-hover);
  --el-tree-text-color: var(--text);
  color: var(--text);
}
:deep(.el-tree-node__content) {
  height: 26px;
  border-radius: var(--radius-sm);
  margin: 0 6px;
  padding-right: 6px;
}
:deep(.el-tree-node.is-current > .el-tree-node__content) {
  background: var(--bg-active);
}
:deep(.el-tree-node__expand-icon) {
  color: var(--text-faint);
  font-size: 12px;
  padding: 4px 2px 4px 4px;
}
:deep(.el-tree-node__expand-icon.is-leaf) {
  color: transparent;
}
</style>
