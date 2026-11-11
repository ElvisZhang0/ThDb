<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { Cell, QueryResult } from '../../electron/types'

const props = defineProps<{ result: QueryResult }>()

/** 固定行高是虚拟滚动的前提：高度不用问浏览器，滚动位置直接算术换算 */
const ROW_H = 26
const OVERSCAN = 6

const scroller = ref<HTMLDivElement | null>(null)
const scrollTop = ref(0)
const viewportH = ref(400)

/** 选中的格子：col = -1 表示选中了整行（点行号） */
const sel = ref<{ row: number; col: number } | null>(null)

/* ---------------------------------------------------------------- 列宽 */

/**
 * 列宽按内容估。
 *
 * 为什么不用 CSS 的自动表格布局：几百行 × 几十列时浏览器要为每个格子做一次
 * 文本测量，滚动会明显掉帧。这里只在结果变化时采样前 200 行估一次，
 * 之后宽度就是常量，滚动时零计算。
 *
 * 7.4px 是等宽字体 12px 下的平均字宽，中文按 2 个字宽算。
 */
const widths = computed(() => {
  const sample = Math.min(props.result.rows.length, 200)
  return props.result.columns.map((col, ci) => {
    let max = visualLen(col.name)
    for (let i = 0; i < sample; i += 1) {
      const v = props.result.rows[i]?.[ci]
      const len = v === null ? 4 : visualLen(String(v))
      if (len > max) max = len
      if (max > 60) break
    }
    return Math.min(420, Math.max(76, max * 7.4 + 22))
  })
})

function visualLen(s: string): number {
  let n = 0
  for (let i = 0; i < s.length && i < 120; i += 1) {
    n += s.charCodeAt(i) > 0x2e80 ? 2 : 1
  }
  return n
}

const totalWidth = computed(
  () => widths.value.reduce((a, b) => a + b, 0) + GUTTER
)

const GUTTER = 56

/* -------------------------------------------------------------- 虚拟滚动 */

const total = computed(() => props.result.rows.length)

const visible = computed(() => {
  const start = Math.max(0, Math.floor(scrollTop.value / ROW_H) - OVERSCAN)
  const count = Math.ceil(viewportH.value / ROW_H) + OVERSCAN * 2
  const end = Math.min(total.value, start + count)
  const out: { i: number; cells: Cell[] }[] = []
  for (let i = start; i < end; i += 1) {
    out.push({ i, cells: props.result.rows[i] ?? [] })
  }
  return out
})

function onScroll(): void {
  scrollTop.value = scroller.value?.scrollTop ?? 0
}

let ro: ResizeObserver | null = null

onMounted(() => {
  if (!scroller.value) return
  viewportH.value = scroller.value.clientHeight
  ro = new ResizeObserver(() => {
    viewportH.value = scroller.value?.clientHeight ?? 400
  })
  ro.observe(scroller.value)
})

onBeforeUnmount(() => {
  ro?.disconnect()
  ro = null
})

// 换了一条结果就把滚动和选中清零，否则会停在上一份结果的中间位置，看着莫名其妙
watch(
  () => props.result,
  () => {
    if (scroller.value) scroller.value.scrollTop = 0
    scrollTop.value = 0
    sel.value = null
  }
)

/* ------------------------------------------------------------------ 交互 */

function select(row: number, col: number): void {
  sel.value = { row, col }
}

function isSel(row: number, col: number): boolean {
  if (!sel.value) return false
  if (sel.value.row !== row) return false
  return sel.value.col === -1 || sel.value.col === col
}

function isRowSel(row: number): boolean {
  return sel.value?.row === row && sel.value.col === -1
}

/**
 * Ctrl/Cmd+C 复制。
 *
 * 走主进程的剪贴板而不是 navigator.clipboard：应用是 file:// 加载的，
 * 不属于安全上下文，Chromium 会直接拒绝 navigator.clipboard.writeText。
 */
async function onKeydown(e: KeyboardEvent): Promise<void> {
  if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'c') return
  if (!sel.value) return
  const row = props.result.rows[sel.value.row]
  if (!row) return
  e.preventDefault()
  const text =
    sel.value.col === -1
      ? row.map((v) => (v === null ? '' : String(v))).join('\t')
      : row[sel.value.col] === null
        ? ''
        : String(row[sel.value.col])
  await window.api.clipboard.write(text)
}

function cellTitle(v: Cell): string | undefined {
  if (v === null) return 'NULL'
  const s = String(v)
  return s.length > 24 ? s : undefined
}
</script>

<template>
  <div
    ref="scroller"
    class="grid"
    tabindex="0"
    @scroll="onScroll"
    @keydown="onKeydown"
  >
    <div class="inner" :style="{ width: totalWidth + 'px' }">
      <!-- 表头 sticky：横向滚动时跟着走，纵向滚动时钉在顶部 -->
      <div class="hrow" :style="{ height: ROW_H + 'px' }">
        <div class="hcell gutter" :style="{ width: GUTTER + 'px' }">#</div>
        <div
          v-for="(col, ci) in result.columns"
          :key="ci"
          class="hcell"
          :style="{ width: widths[ci] + 'px' }"
          :title="col.name + ' · ' + col.dataType"
        >
          <span class="hname">{{ col.name }}</span>
          <span class="htype">{{ col.dataType }}</span>
        </div>
      </div>

      <div class="body" :style="{ height: total * ROW_H + 'px' }">
        <div
          v-for="r in visible"
          :key="r.i"
          class="row"
          :class="{ odd: r.i % 2 === 1 }"
          :style="{ transform: `translateY(${r.i * ROW_H}px)`, height: ROW_H + 'px' }"
        >
          <div
            class="cell gutter"
            :class="{ on: isRowSel(r.i) }"
            :style="{ width: GUTTER + 'px' }"
            @click="select(r.i, -1)"
          >{{ r.i + 1 }}</div>
          <div
            v-for="(v, ci) in r.cells"
            :key="ci"
            class="cell"
            :class="{ null: v === null, num: typeof v === 'number', on: isSel(r.i, ci) }"
            :style="{ width: widths[ci] + 'px' }"
            :title="cellTitle(v)"
            @click="select(r.i, ci)"
          >{{ v === null ? 'NULL' : v }}</div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.grid {
  height: 100%;
  overflow: auto;
  outline: none;
  font-size: 12px;
  /* 表格里必须能选文字（复制值出去），但整块不放开，否则拖动滚动条会选中一片 */
  -webkit-user-select: none;
  user-select: none;
}
.inner {
  position: relative;
  min-width: 100%;
}

.hrow {
  position: sticky;
  top: 0;
  z-index: 3;
  display: flex;
  background: var(--bg-elev);
  border-bottom: 1px solid var(--border);
}
.hcell {
  display: flex;
  align-items: baseline;
  gap: 6px;
  padding: 0 8px;
  line-height: 26px;
  border-right: 1px solid var(--border-soft);
  flex: 0 0 auto;
  overflow: hidden;
  white-space: nowrap;
}
.hname {
  color: var(--text);
  font-weight: 600;
  font-size: 11.5px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.htype {
  margin-left: auto;
  color: var(--text-faint);
  font-size: 10px;
  font-family: var(--font-mono);
  flex: 0 0 auto;
}

.body {
  position: relative;
}
.row {
  position: absolute;
  top: 0;
  left: 0;
  display: flex;
  will-change: transform;
}
.row.odd {
  background: rgba(127, 127, 127, 0.035);
}
.row:hover {
  background: var(--bg-hover);
}

.cell {
  padding: 0 8px;
  line-height: 26px;
  border-right: 1px solid var(--border-soft);
  border-bottom: 1px solid var(--border-soft);
  flex: 0 0 auto;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  color: var(--text);
  font-family: var(--font-mono);
  font-size: 11.5px;
  cursor: default;
}
.cell.num {
  text-align: right;
}
.cell.null {
  color: var(--null);
  font-style: italic;
  font-family: var(--font-ui);
}
.cell.gutter {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  padding-right: 10px;
  color: var(--text-faint);
  background: var(--bg-panel);
  font-size: 10.5px;
  border-right: 1px solid var(--border);
}
.cell.on {
  background: var(--accent-soft);
  box-shadow: inset 0 0 0 1px var(--accent);
  color: var(--text);
}
.hcell.gutter {
  justify-content: flex-end;
  padding-right: 10px;
  color: var(--text-faint);
  font-size: 10.5px;
}
</style>
