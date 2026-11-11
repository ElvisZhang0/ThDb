<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { ConnectionConfig } from '../electron/types'
import { KIND_LABEL } from '../electron/types'
import { useAppStore } from './stores/app'
import { formatCount, formatDuration } from './utils/format'
import ExplorerTree from './components/ExplorerTree.vue'
import SqlEditor from './components/SqlEditor.vue'
import ResultPanel from './components/ResultPanel.vue'
import ConnectionDialog from './components/ConnectionDialog.vue'
import DbIcon from './components/DbIcon.vue'

const store = useAppStore()

const editorRef = ref<InstanceType<typeof SqlEditor> | null>(null)
const connDialog = ref(false)
/** null = 新建（对话框自己生成空表单）；有值 = 编辑这一条 */
const dialogInitial = ref<ConnectionConfig | null>(null)
const settingsOpen = ref(false)
const aboutOpen = ref(false)

/** SQL 编辑区高度，可拖动分隔条调整 */
const editorH = ref(260)

const activeName = computed(() => store.activeConfig?.name ?? '')
const activeKind = computed(() => store.activeConfig?.kind ?? null)
const connected = computed(() => !!store.activeConn)

onMounted(async () => {
  try {
    await store.init()
  } catch (err) {
    ElMessage.error('读取配置失败：' + (err as Error).message)
  }
})

/* ------------------------------------------------------------------ 连接 */

function openEditConnection(cfg: ConnectionConfig): void {
  // 树上传进来的一定是已入库的连接；工具栏"新建"走 openNewConnection，不会到这儿
  dialogInitial.value = store.config.connections.some((c) => c.id === cfg.id) ? cfg : null
  connDialog.value = true
}

async function removeConnection(id: string): Promise<void> {
  const cfg = store.config.connections.find((c) => c.id === id)
  if (!cfg) return
  try {
    await ElMessageBox.confirm(`删除连接「${cfg.name}」？配置文件里的密码也会一起删掉。`, '确认', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消'
    })
  } catch {
    return
  }
  await store.removeConnection(id)
  ElMessage.success('已删除')
}

/* -------------------------------------------------------------------- 执行 */

async function doRun(sqlOverride?: string): Promise<void> {
  if (!connected.value) {
    ElMessage.warning('先双击左侧的连接，连上数据库')
    return
  }
  const text = sqlOverride ?? editorRef.value?.getText() ?? store.sql
  if (!text.trim()) {
    ElMessage.warning('编辑器里没有 SQL')
    return
  }
  // 从树上点表带过来的语句要回填到编辑器，用户才知道刚才跑了什么
  if (sqlOverride) store.sql = text
  await store.run(text)
}

async function doCancel(): Promise<void> {
  const ok = await store.cancel()
  if (!ok) {
    ElMessage.info('当前数据库不支持取消正在执行的语句（PostgreSQL / 金仓支持）')
  }
}

/* ------------------------------------------------------------ 分隔条拖拽 */

function startDrag(e: MouseEvent): void {
  e.preventDefault()
  const startY = e.clientY
  const startH = editorH.value
  const move = (ev: MouseEvent) => {
    const next = startH + (ev.clientY - startY)
    // 上下都留够：编辑区至少 3 行，结果区至少能看见表头 + 几行
    editorH.value = Math.max(110, Math.min(next, window.innerHeight - 260))
  }
  const up = () => {
    window.removeEventListener('mousemove', move)
    window.removeEventListener('mouseup', up)
    document.body.style.cursor = ''
  }
  document.body.style.cursor = 'row-resize'
  window.addEventListener('mousemove', move)
  window.addEventListener('mouseup', up)
}

/* ------------------------------------------------------------------ 设置 */

/**
 * 主题用 watch 而不是靠 radio 的 @change。
 *
 * @change 只在用户点选时触发，而主题还有别的入口（导入配置、以后可能加的快捷键），
 * 盯住"配置里的 theme 到底变没变"才是唯一可靠的口径。
 */
watch(
  () => store.config.settings.theme,
  (next) => {
    if (next !== store.theme) void store.setTheme(next)
  }
)

async function onSettingChange(): Promise<void> {
  await store.save()
}

async function doExport(): Promise<void> {
  const p = await window.api.config.exportConfig()
  if (p) ElMessage.success('已导出到 ' + p)
}

async function doImport(): Promise<void> {
  try {
    const next = await window.api.config.importConfig()
    if (!next) return
    store.config.connections = next.connections
    store.config.groups = next.groups
    ElMessage.success(`已导入 ${next.connections.length} 条连接`)
  } catch (err) {
    ElMessage.error('导入失败：' + (err as Error).message)
  }
}
</script>

<template>
  <div class="app">
    <div class="body">
      <aside class="side">
        <ExplorerTree @run="doRun" @edit="openEditConnection" />
      </aside>

      <main class="main">
        <!-- 工具条 -->
        <div class="toolbar">
          <button
            class="run"
            :disabled="!connected || store.running"
            title="执行（Ctrl / ⌘ + Enter）"
            @click="doRun()"
          >
            <span class="tri">▶</span>
            {{ store.running ? '执行中' : '执行' }}
          </button>
          <button v-if="store.running" class="stop" title="取消执行" @click="doCancel">■ 取消</button>

          <div class="sep" />

          <div v-if="activeKind" class="conn-chip" :title="KIND_LABEL[activeKind]">
            <DbIcon :kind="activeKind" :size="15" />
            <span class="cname">{{ activeName }}</span>
            <span v-if="store.activeConn?.database" class="cdb">{{ store.activeConn.database }}</span>
            <span class="state" :class="{ on: connected }" />
          </div>
          <span v-else class="no-conn">未连接 — 双击左侧连接建立会话</span>

          <div class="spacer" />

          <button v-if="activeName" class="tbtn" title="删除这条连接" @click="removeConnection(store.activeId)">
            删除连接
          </button>
          <button class="tbtn" title="设置" @click="settingsOpen = true">设置</button>
          <button class="tbtn" title="关于" @click="aboutOpen = true">关于</button>
        </div>

        <!-- SQL 编辑区 -->
        <div class="editor-area" :style="{ height: editorH + 'px' }">
          <SqlEditor
            ref="editorRef"
            :model-value="store.sql"
            :kind="activeKind ?? 'postgres'"
            :dark="store.theme === 'dark'"
            :font-size="store.config.settings.fontSize"
            :run-on-enter="store.config.settings.runOnEnter"
            @update:model-value="store.sql = $event"
            @run="doRun"
          />
        </div>

        <div class="splitter" @mousedown="startDrag" />

        <!-- 结果区 -->
        <div class="results">
          <ResultPanel :result="store.result" :running="store.running" :error="store.lastError" />
        </div>
      </main>
    </div>

    <!-- 状态栏 -->
    <footer class="status">
      <span v-if="connected" class="s-item">
        <span class="dot" />
        {{ activeName }}
        <template v-if="store.activeConn?.database"> · {{ store.activeConn.database }}</template>
      </span>
      <span v-else class="s-item dim">未连接</span>

      <span v-if="store.activeConn" class="s-item dim ellipsis" :title="store.activeConn.info.serverVersion">
        {{ store.activeConn.info.serverVersion }}
      </span>

      <div class="spacer" />

      <template v-if="store.result">
        <span class="s-item dim">
          {{ formatCount(store.result.results.reduce((a, r) => a + r.rowCount, 0)) }} 行
        </span>
        <span class="s-item dim">{{ formatDuration(store.result.durationMs) }}</span>
        <span class="s-item dim">{{ store.result.results.length }} 条语句</span>
      </template>
      <span class="s-item dim">v{{ store.info?.version ?? '0.1.0' }}</span>
    </footer>

    <ConnectionDialog
      v-model="connDialog"
      :initial="dialogInitial"
    />

    <!-- ------------------------------------------------ 设置 -->
    <el-dialog v-model="settingsOpen" title="设置" width="460px">
      <el-form label-width="128px">
        <el-form-item label="主题">
          <el-radio-group v-model="store.config.settings.theme">
            <el-radio-button value="dark">深色</el-radio-button>
            <el-radio-button value="light">浅色</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="编辑器字号">
          <el-input-number
            v-model="store.config.settings.fontSize"
            :min="10"
            :max="22"
            @change="onSettingChange"
          />
          <span class="hint">px</span>
        </el-form-item>
        <el-form-item label="单次查询最大行数">
          <el-input-number
            v-model="store.config.settings.maxRows"
            :min="10"
            :max="200000"
            :step="500"
            @change="onSettingChange"
          />
          <span class="hint">超出的部分会标记「已截断」</span>
        </el-form-item>
        <el-form-item label="回车执行">
          <el-switch v-model="store.config.settings.runOnEnter" @change="onSettingChange" />
          <span class="hint">开启后换行用 Shift + 回车</span>
        </el-form-item>
        <el-form-item label="配置文件">
          <div class="cfg-actions">
            <el-button size="small" @click="doExport">导出（不含密码）</el-button>
            <el-button size="small" @click="doImport">导入</el-button>
          </div>
        </el-form-item>
      </el-form>
      <p class="tip">密码用系统凭据加密后存在本机配置里，导出时会被剥掉。</p>
    </el-dialog>

    <!-- ------------------------------------------------ 关于 -->
    <el-dialog v-model="aboutOpen" title="关于 ThBD" width="480px">
      <div class="about">
        <div class="logo">ThBD</div>
        <p class="ver">版本 {{ store.info?.version ?? '0.1.0' }}</p>
        <p class="desc">数据库管理工具：连接树、SQL 编辑器、结果表格。<br />支持 PostgreSQL / MySQL / 人大金仓 KingBase / 达梦 DM。</p>
        <div class="drivers">
          <div v-for="d in store.info?.drivers ?? []" :key="d.kind" class="drv">
            <DbIcon :kind="d.kind" />
            <span class="dname">{{ KIND_LABEL[d.kind] }}</span>
            <span class="dstate" :class="{ bad: !d.available }">
              {{ d.available ? (d.version ? 'v' + d.version : '可用') : '未安装' }}
            </span>
            <span v-if="!d.available" class="dwhy">{{ d.reason }}</span>
          </div>
        </div>
        <p class="meta">
          Electron {{ store.info?.electron }} · Node {{ store.info?.node }} · Chromium
          {{ store.info?.chrome }}
        </p>
      </div>
    </el-dialog>
  </div>
</template>

<style scoped>
.app {
  display: flex;
  flex-direction: column;
  height: 100%;
}
.body {
  flex: 1;
  min-height: 0;
  display: flex;
}
.side {
  width: var(--sidebar-w);
  flex: 0 0 auto;
  min-height: 0;
}
.main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg);
}

/* ------------------------------------------------------------- 工具条 */
.toolbar {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 8px;
  height: 40px;
  padding: 0 12px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-panel);
}
.run {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 12px;
  border: none;
  border-radius: var(--radius-sm);
  background: var(--accent);
  color: #06231f;
  font-size: 12px;
  font-weight: 600;
  font-family: inherit;
  cursor: pointer;
}
.run:hover:not(:disabled) {
  background: var(--accent-hover);
}
.run:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.tri {
  font-size: 9px;
}
.stop {
  height: 26px;
  padding: 0 10px;
  border: 1px solid var(--danger);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--danger);
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
}
.stop:hover {
  background: rgba(224, 85, 95, 0.12);
}
.sep {
  width: 1px;
  height: 18px;
  background: var(--border);
}
.conn-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 24px;
  padding: 0 10px;
  border-radius: 12px;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  font-size: 12px;
}
.cname {
  color: var(--text);
}
.cdb {
  color: var(--text-faint);
  font-size: 11px;
}
.state {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--text-faint);
}
.state.on {
  background: var(--accent);
  box-shadow: 0 0 0 2px var(--accent-soft);
}
.no-conn {
  color: var(--text-faint);
  font-size: 12px;
}
.spacer {
  flex: 1;
}
.tbtn {
  height: 24px;
  padding: 0 9px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-dim);
  font-size: 11.5px;
  font-family: inherit;
  cursor: pointer;
}
.tbtn:hover {
  background: var(--bg-hover);
  border-color: var(--border);
  color: var(--text);
}

/* -------------------------------------------------------- 编辑区与结果 */
.editor-area {
  flex: 0 0 auto;
  min-height: 0;
  overflow: hidden;
  background: var(--bg);
}
.splitter {
  flex: 0 0 auto;
  height: 5px;
  cursor: row-resize;
  background: var(--bg-panel);
  border-top: 1px solid var(--border);
  border-bottom: 1px solid var(--border);
  position: relative;
}
.splitter::after {
  content: '';
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  width: 34px;
  height: 1px;
  background: var(--border);
}
.splitter:hover::after {
  background: var(--accent);
}
.results {
  flex: 1;
  min-height: 0;
}

/* ------------------------------------------------------------- 状态栏 */
.status {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 14px;
  height: 24px;
  padding: 0 12px;
  border-top: 1px solid var(--border);
  background: var(--bg-panel);
  font-size: 11px;
  color: var(--text-dim);
}
.s-item {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  white-space: nowrap;
}
.s-item.dim {
  color: var(--text-faint);
}
.s-item.ellipsis {
  max-width: 46%;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
}

/* -------------------------------------------------------------- 对话框 */
.hint {
  margin-left: 10px;
  color: var(--text-faint);
  font-size: 11.5px;
}
.cfg-actions {
  display: flex;
  gap: 8px;
}
.tip {
  margin: 0;
  color: var(--text-faint);
  font-size: 11.5px;
  line-height: 1.6;
}

.about {
  text-align: center;
}
.logo {
  font-size: 26px;
  font-weight: 700;
  letter-spacing: 0.04em;
  color: var(--accent);
}
.ver {
  margin: 2px 0 12px;
  color: var(--text-faint);
  font-size: 12px;
}
.desc {
  margin: 0 0 14px;
  color: var(--text-dim);
  font-size: 12.5px;
  line-height: 1.7;
}
.drivers {
  text-align: left;
  border-top: 1px solid var(--border-soft);
  padding-top: 8px;
}
.drv {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 0;
  font-size: 12px;
}
.dname {
  color: var(--text);
}
.dstate {
  margin-left: auto;
  color: var(--accent);
  font-size: 11px;
}
.dstate.bad {
  color: var(--warn);
}
.dwhy {
  width: 100%;
  color: var(--text-faint);
  font-size: 10.5px;
  padding-left: 22px;
  word-break: break-all;
}
.meta {
  margin: 14px 0 0;
  color: var(--text-faint);
  font-size: 10.5px;
}
</style>
