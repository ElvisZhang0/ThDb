<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import type { ConnectionConfig, DbKind } from '../../electron/types'
import { DEFAULT_PORT, KIND_LABEL } from '../../electron/types'
import { useAppStore } from '../stores/app'
import DbIcon from './DbIcon.vue'

const props = defineProps<{ modelValue: boolean; initial: ConnectionConfig | null }>()
const emit = defineEmits<{
  'update:modelValue': [v: boolean]
  saved: [cfg: ConnectionConfig]
}>()

const store = useAppStore()

const KINDS: DbKind[] = ['postgres', 'mysql', 'kingbase', 'dm']

const form = reactive<ConnectionConfig>(store.blankConnection())
const testing = ref(false)
const saving = ref(false)
const testOk = ref('')
const testFail = ref('')

const visible = computed({
  get: () => props.modelValue,
  set: (v: boolean) => emit('update:modelValue', v)
})

// 每次打开都重置表单：上一次的半成品输入不该带到下一次
watch(
  () => props.modelValue,
  (open) => {
    if (!open) return
    Object.assign(form, props.initial ? structuredClone(props.initial) : store.blankConnection())
    testOk.value = ''
    testFail.value = ''
  },
  { immediate: true }
)

/** 换数据库类型时把端口带过去 —— 5236/54321 这种没人记得住 */
function onKindChange(kind: DbKind): void {
  form.kind = kind
  form.port = DEFAULT_PORT[kind]
  testOk.value = ''
  testFail.value = ''
  // 用户名跟着换常见默认值，用户改了就不动
  if (!form.user || ['postgres', 'root', 'sysdba', 'SYSDBA'].includes(form.user)) {
    form.user = kind === 'mysql' ? 'root' : kind === 'dm' ? 'SYSDBA' : 'postgres'
  }
}

async function doTest(): Promise<void> {
  testing.value = true
  testOk.value = ''
  testFail.value = ''
  try {
    const version = await window.api.conn.test({ ...form })
    testOk.value = version || '连接成功'
  } catch (err) {
    testFail.value = (err as Error).message.replace(/^Error invoking remote method '[^']+': /, '')
  } finally {
    testing.value = false
  }
}

async function doSave(): Promise<void> {
  if (!form.name.trim()) {
    ElMessage.warning('给这条连接起个名字')
    return
  }
  if (!form.host.trim()) {
    ElMessage.warning('主机不能为空')
    return
  }
  saving.value = true
  try {
    const cfg = { ...form, name: form.name.trim(), host: form.host.trim() }
    await store.upsertConnection(cfg)
    emit('saved', cfg)
    visible.value = false
    ElMessage.success('已保存')
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <el-dialog v-model="visible" :title="initial ? '编辑连接' : '新建连接'" width="520px" :close-on-click-modal="false">
    <el-form label-width="86px" label-position="right" size="default">
      <el-form-item label="数据库">
        <div class="kind-row">
          <button
            v-for="k in KINDS"
            :key="k"
            type="button"
            class="kind"
            :class="{ on: form.kind === k }"
            :title="KIND_LABEL[k]"
            @click="onKindChange(k)"
          >
            <DbIcon :kind="k" :size="18" />
            <span>{{ KIND_LABEL[k].split(' ')[0] }}</span>
          </button>
        </div>
      </el-form-item>

      <el-form-item label="名称">
        <el-input v-model="form.name" placeholder="例如：生产库-订单" maxlength="40" />
      </el-form-item>

      <el-form-item label="主机">
        <div class="host-row">
          <el-input v-model="form.host" placeholder="127.0.0.1" />
          <el-input-number v-model="form.port" :min="1" :max="65535" controls-position="right" class="port" />
        </div>
      </el-form-item>

      <el-form-item label="用户">
        <el-input v-model="form.user" placeholder="数据库用户名" />
      </el-form-item>

      <el-form-item label="密码">
        <el-input v-model="form.password" type="password" show-password placeholder="留空表示用空密码" />
      </el-form-item>

      <el-form-item label="数据库名">
        <el-input v-model="form.database" placeholder="可留空（PG 会连到与用户名同名的库）" />
      </el-form-item>

      <el-form-item label="分组">
        <el-select v-model="form.groupId" style="width: 100%">
          <el-option v-for="g in store.config.groups" :key="g.id" :label="g.name" :value="g.id" />
        </el-select>
      </el-form-item>

      <el-form-item label="加密连接">
        <el-switch v-model="form.ssl" />
        <span class="hint">开启后走 TLS，自签证书也接受</span>
      </el-form-item>

      <el-form-item label="备注">
        <el-input v-model="form.note" type="textarea" :rows="2" maxlength="200" />
      </el-form-item>
    </el-form>

    <div v-if="testOk" class="test ok selectable">{{ testOk }}</div>
    <div v-if="testFail" class="test fail selectable">{{ testFail }}</div>

    <template #footer>
      <div class="footer">
        <el-button :loading="testing" @click="doTest">测试连接</el-button>
        <div class="right">
          <el-button @click="visible = false">取消</el-button>
          <el-button type="primary" :loading="saving" @click="doSave">保存</el-button>
        </div>
      </div>
    </template>
  </el-dialog>
</template>

<style scoped>
.kind-row {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.kind {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border-radius: var(--radius);
  border: 1px solid var(--border);
  background: var(--bg-elev);
  color: var(--text-dim);
  font-size: 12px;
  cursor: pointer;
  transition: all 0.12s;
  font-family: inherit;
}
.kind:hover {
  background: var(--bg-hover);
  color: var(--text);
}
.kind.on {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--text);
}
.host-row {
  display: flex;
  gap: 8px;
  width: 100%;
}
.port {
  width: 116px;
  flex: 0 0 auto;
}
.hint {
  margin-left: 10px;
  color: var(--text-faint);
  font-size: 12px;
}
.test {
  margin: 0 0 4px 86px;
  padding: 8px 10px;
  border-radius: var(--radius);
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 120px;
  overflow: auto;
}
.test.ok {
  background: var(--accent-soft);
  color: var(--accent);
}
.test.fail {
  background: rgba(224, 85, 95, 0.12);
  color: var(--danger);
}
.footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.right {
  display: flex;
  gap: 8px;
}
</style>
