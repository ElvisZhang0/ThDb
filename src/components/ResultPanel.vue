<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import type { ExecuteResult, QueryResult } from '../../electron/types'
import { formatCount, formatDuration, shortStatement, toCsv, toTsv } from '../utils/format'
import ResultGrid from './ResultGrid.vue'

const props = defineProps<{
  result: ExecuteResult | null
  running: boolean
  error: string
}>()

const tab = ref(0)

// 换了一批结果就回到第一个页签 —— 停在上一次的索引上很容易让人看错语句
watch(
  () => props.result,
  () => {
    tab.value = 0
  }
)

const results = computed<QueryResult[]>(() => props.result?.results ?? [])

function label(r: QueryResult, i: number): string {
  const verb = (/^\s*(\w+)/.exec(r.statement)?.[1] ?? 'SQL').toUpperCase()
  return `${i + 1} · ${verb}`
}

function subLabel(r: QueryResult): string {
  if (r.error) return '失败'
  if (r.columns.length) return `${formatCount(r.rowCount)} 行`
  return r.affectedRows === undefined ? '完成' : `${formatCount(r.affectedRows)} 行受影响`
}

async function copyAll(r: QueryResult): Promise<void> {
  if (!r.columns.length) return
  await window.api.clipboard.write(toTsv(r))
  ElMessage.success(`已复制 ${formatCount(r.rowCount)} 行`)
}

async function exportCsv(r: QueryResult): Promise<void> {
  if (!r.columns.length) return
  const name = `result-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.csv`
  const saved = await window.api.dialog.saveCsv(name, toCsv(r))
  if (saved) ElMessage.success('已保存到 ' + saved)
}
</script>

<template>
  <div class="panel">
    <!-- 没有结果的时候给个安静的占位，别摆空表格 -->
    <div v-if="!result" class="placeholder">
      <template v-if="running">
        <span class="spinner" />
        <p>查询执行中…</p>
      </template>
      <template v-else>
        <p class="dim">执行一条 SQL 看结果</p>
        <p class="tiny">Ctrl / ⌘ + Enter 执行 · 选中一段则只执行选中的部分</p>
      </template>
    </div>

    <template v-else>
      <div v-if="results.length > 1" class="tabs">
        <button
          v-for="(r, i) in results"
          :key="i"
          class="tab"
          :class="{ on: tab === i, bad: !!r.error }"
          :title="shortStatement(r.statement, 120)"
          @click="tab = i"
        >
          <span class="tlabel">{{ label(r, i) }}</span>
          <span class="tsub">{{ subLabel(r) }}</span>
        </button>
        <div class="total">共 {{ result.durationMs.toFixed(0) }} ms</div>
      </div>

      <template v-for="(r, i) in results" :key="i">
        <div v-if="tab === i" class="pane">
          <div class="bar">
            <template v-if="r.error">
              <span class="badge bad">第 {{ i + 1 }} 条失败</span>
            </template>
            <template v-else>
              <span v-if="r.columns.length" class="metric">
                {{ formatCount(r.rowCount) }} 行
              </span>
              <span v-else class="metric">
                {{ r.affectedRows === undefined ? '执行成功' : `影响 ${formatCount(r.affectedRows)} 行` }}
              </span>
              <span class="metric dim">{{ formatDuration(r.durationMs) }}</span>
              <span v-if="r.truncated" class="badge warn" title="受「单次查询最大行数」限制，结果被截断。去设置里调大，或在 SQL 里加 LIMIT">
                已截断
              </span>
            </template>

            <div class="bar-right">
              <button
                v-if="r.columns.length"
                class="abtn"
                title="复制为制表符分隔，粘进表格软件直接分列"
                @click="copyAll(r)"
              >复制</button>
              <button v-if="r.columns.length" class="abtn" title="导出为 CSV" @click="exportCsv(r)">
                导出 CSV
              </button>
            </div>
          </div>

          <div v-if="r.error" class="err selectable">{{ r.error }}</div>
          <div v-else-if="r.columns.length" class="grid-wrap">
            <ResultGrid :result="r" />
          </div>
          <div v-else class="done">
            <span class="ok">✓</span>
            <span>语句执行成功{{ r.affectedRows !== undefined ? `，影响 ${formatCount(r.affectedRows)} 行` : '' }}</span>
          </div>
        </div>
      </template>
    </template>
  </div>
</template>

<style scoped>
.panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--bg);
}

.placeholder {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  color: var(--text-faint);
  font-size: 13px;
}
.placeholder p {
  margin: 0;
}
.placeholder .dim {
  color: var(--text-dim);
}
.placeholder .tiny {
  font-size: 11.5px;
  opacity: 0.75;
}

/* 纯 CSS 转圈，省一个图标依赖 */
.spinner {
  width: 18px;
  height: 18px;
  border: 2px solid var(--border);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.tabs {
  display: flex;
  align-items: stretch;
  gap: 2px;
  padding: 4px 8px 0;
  border-bottom: 1px solid var(--border);
  background: var(--bg-panel);
  flex: 0 0 auto;
  overflow-x: auto;
}
.tab {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border: 1px solid transparent;
  border-bottom: none;
  border-radius: var(--radius-sm) var(--radius-sm) 0 0;
  background: transparent;
  color: var(--text-dim);
  font-size: 11.5px;
  font-family: inherit;
  cursor: pointer;
  white-space: nowrap;
}
.tab:hover {
  background: var(--bg-hover);
  color: var(--text);
}
.tab.on {
  background: var(--bg);
  border-color: var(--border);
  color: var(--text);
}
.tab.bad .tlabel {
  color: var(--danger);
}
.tsub {
  color: var(--text-faint);
  font-size: 10.5px;
}
.total {
  margin-left: auto;
  align-self: center;
  padding: 0 8px;
  color: var(--text-faint);
  font-size: 11px;
}

.pane {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.bar {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 12px;
  height: 30px;
  padding: 0 10px;
  border-bottom: 1px solid var(--border-soft);
  background: var(--bg-panel);
  font-size: 11.5px;
  color: var(--text-dim);
}
.metric.dim {
  color: var(--text-faint);
}
.bar-right {
  margin-left: auto;
  display: flex;
  gap: 4px;
}
.abtn {
  padding: 2px 8px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
  background: var(--bg-elev);
  color: var(--text-dim);
  font-size: 11px;
  font-family: inherit;
  cursor: pointer;
}
.abtn:hover {
  color: var(--accent);
  border-color: var(--accent);
}

.badge {
  padding: 0 6px;
  border-radius: 3px;
  font-size: 10.5px;
  line-height: 16px;
}
.badge.warn {
  background: rgba(217, 163, 74, 0.16);
  color: var(--warn);
}
.badge.bad {
  background: rgba(224, 85, 95, 0.14);
  color: var(--danger);
}

.grid-wrap {
  flex: 1;
  min-height: 0;
}

.err {
  margin: 10px;
  padding: 10px 12px;
  border-radius: var(--radius);
  background: rgba(224, 85, 95, 0.1);
  border: 1px solid rgba(224, 85, 95, 0.28);
  color: var(--danger);
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
  overflow: auto;
  max-height: 60%;
}

.done {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--text-dim);
  font-size: 12.5px;
}
.done .ok {
  color: var(--accent);
  font-size: 15px;
}
</style>
