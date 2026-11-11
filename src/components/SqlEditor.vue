<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Compartment, EditorState } from '@codemirror/state'
import {
  EditorView,
  crosshairCursor,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  placeholder as placeholderExt,
  rectangularSelection
} from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { MySQL, PostgreSQL, StandardSQL, sql } from '@codemirror/lang-sql'
import {
  bracketMatching,
  defaultHighlightStyle,
  foldGutter,
  foldKeymap,
  indentOnInput,
  syntaxHighlighting
} from '@codemirror/language'
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap
} from '@codemirror/autocomplete'
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search'
import { oneDark } from '@codemirror/theme-one-dark'
import type { DbKind } from '../../electron/types'

const props = defineProps<{
  modelValue: string
  kind: DbKind
  dark: boolean
  fontSize: number
  runOnEnter: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [v: string]
  run: [text: string]
}>()

const host = ref<HTMLDivElement | null>(null)
let view: EditorView | null = null

// 四处需要热更新的配置，各留一个 Compartment 门位。
// 直接销毁重建编辑器会丢掉光标位置和撤销历史，改一行字号就全清空，体验很差。
const themeSlot = new Compartment()
const fontSlot = new Compartment()
const dialectSlot = new Compartment()
const keySlot = new Compartment()

/** 各家用 CodeMirror 自带的哪套方言词法。达梦没有对应的，用标准 SQL */
function dialectOf(kind: DbKind) {
  if (kind === 'mysql') return MySQL
  if (kind === 'postgres' || kind === 'kingbase') return PostgreSQL
  return StandardSQL
}

function themeOf(dark: boolean) {
  return dark ? [oneDark, neutralTheme] : [neutralTheme]
}

/** 两种主题共用的中性部分：底色透明、字体统一、去掉焦点外框 */
const neutralTheme = EditorView.theme({
  '&': { backgroundColor: 'transparent', height: '100%' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.65' },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    border: 'none',
    color: 'var(--text-faint)',
    paddingRight: '4px'
  },
  '.cm-activeLine': { backgroundColor: 'rgba(127,127,127,0.07)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--text-dim)' },
  '.cm-content': { padding: '8px 0' },
  '.cm-line': { padding: '0 12px' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
    backgroundColor: 'rgba(63,185,160,0.22) !important'
  }
})

const fontTheme = (px: number) => EditorView.theme({ '&': { fontSize: `${px}px` } })

function runKeymap(onEnter: boolean) {
  const fire = () => {
    emit('run', currentText())
    return true
  }
  const bindings = [{ key: 'Mod-Enter', run: fire }]
  if (onEnter) {
    // 回车直接执行时，换行得让给 Shift-Enter，否则没法写多行 SQL
    bindings.push({ key: 'Enter', run: fire }, { key: 'Shift-Enter', run: () => false })
  }
  return keymap.of(bindings)
}

/**
 * 执行的是"选中的部分；没选中就是全文"。
 * 鼠标框一段再按 Ctrl+Enter 是最常用的用法之一，没必要再点一次"执行选中"。
 */
function currentText(): string {
  if (!view) return ''
  const sel = view.state.selection.main
  if (!sel.empty) return view.state.sliceDoc(sel.from, sel.to)
  return view.state.doc.toString()
}

function buildState(doc: string): EditorState {
  return EditorState.create({
    doc,
    extensions: [
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightSpecialChars(),
      history(),
      foldGutter({ openText: '▾', closedText: '▸' }),
      drawSelection(),
      dropCursor(),
      EditorState.allowMultipleSelections.of(true),
      indentOnInput(),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      bracketMatching(),
      closeBrackets(),
      autocompletion(),
      rectangularSelection(),
      crosshairCursor(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      placeholderExt('在这里写 SQL。Ctrl / ⌘ + Enter 执行；选中一段则只执行选中的部分。'),
      keymap.of([
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...searchKeymap,
        ...historyKeymap,
        ...foldKeymap,
        ...completionKeymap,
        indentWithTab
      ]),
      themeSlot.of(themeOf(props.dark)),
      fontSlot.of(fontTheme(props.fontSize)),
      dialectSlot.of(sql({ dialect: dialectOf(props.kind) })),
      keySlot.of(runKeymap(props.runOnEnter)),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) emit('update:modelValue', u.state.doc.toString())
      })
    ]
  })
}

onMounted(() => {
  if (!host.value) return
  view = new EditorView({ state: buildState(props.modelValue), parent: host.value })
})

onBeforeUnmount(() => {
  view?.destroy()
  view = null
})

// 外部改了内容（比如从树上点表自动填入 SQL）要同步进来；
// 但用户自己敲字时 doc 和 prop 已经一致，这时再 replace 会把光标弹到开头
watch(
  () => props.modelValue,
  (next) => {
    if (!view) return
    const cur = view.state.doc.toString()
    if (cur === next) return
    view.dispatch({ changes: { from: 0, to: cur.length, insert: next } })
  }
)

watch(
  () => props.dark,
  (dark) => view?.dispatch({ effects: themeSlot.reconfigure(themeOf(dark)) })
)
watch(
  () => props.fontSize,
  (px) => view?.dispatch({ effects: fontSlot.reconfigure(fontTheme(px)) })
)
watch(
  () => props.kind,
  (kind) => view?.dispatch({ effects: dialectSlot.reconfigure(sql({ dialect: dialectOf(kind) }) ) })
)
watch(
  () => props.runOnEnter,
  (on) => view?.dispatch({ effects: keySlot.reconfigure(runKeymap(on)) })
)

defineExpose({ focus: () => view?.focus(), getText: currentText })
</script>

<template>
  <div ref="host" class="editor" />
</template>

<style scoped>
.editor {
  height: 100%;
  overflow: hidden;
  background: var(--bg);
}
.editor :deep(.cm-editor) {
  height: 100%;
}
.editor :deep(.cm-scroller) {
  overflow: auto;
}
</style>
