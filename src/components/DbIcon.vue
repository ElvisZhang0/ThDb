<script setup lang="ts">
/**
 * 连接树上的小图标。
 *
 * 为什么自己画 SVG 而不用图标库：图标库里没有"数据库圆柱/表/视图/主键"这一组
 * 语义刚好对上的图标，强行凑会用出一堆似是而非的形状。这里总共 10 个 14×14 的
 * 图形，手写反而更整齐，也不用多引一个依赖。
 */
type IconKind =
  | 'postgres'
  | 'mysql'
  | 'kingbase'
  | 'dm'
  | 'database'
  | 'schema'
  | 'table'
  | 'view'
  | 'column'
  | 'key'

const props = withDefaults(defineProps<{ kind: IconKind; size?: number }>(), { size: 14 })

/** 四种库各给一个色，扫一眼就能分清连的是哪家 */
const COLORS: Record<string, string> = {
  postgres: '#4a90d9',
  mysql: '#e08b3c',
  kingbase: '#c9564b',
  dm: '#7c74d6'
}

const color = () => COLORS[props.kind] ?? 'var(--text-dim)'
</script>

<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 16 16"
    fill="none"
    class="db-icon"
    aria-hidden="true"
  >
    <!-- 数据库圆柱：顶面椭圆 + 两条侧边 -->
    <g v-if="kind === 'database' || kind === 'postgres' || kind === 'mysql' || kind === 'kingbase' || kind === 'dm'">
      <ellipse cx="8" cy="3.6" rx="5.2" ry="2.1" :stroke="color()" stroke-width="1.2" />
      <path
        d="M2.8 3.6v8.8c0 1.16 2.33 2.1 5.2 2.1s5.2-.94 5.2-2.1V3.6"
        :stroke="color()"
        stroke-width="1.2"
        stroke-linecap="round"
      />
      <path d="M2.8 8c0 1.16 2.33 2.1 5.2 2.1s5.2-.94 5.2-2.1" :stroke="color()" stroke-width="1.1" />
    </g>

    <!-- 模式：三层叠放的平面 -->
    <g v-else-if="kind === 'schema'">
      <path d="M8 1.8 14 4.9 8 8 2 4.9z" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round" />
      <path d="M2 8.2 8 11.3l6-3.1" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round" opacity=".55" />
      <path d="M2 11.3 8 14.4l6-3.1" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round" opacity=".3" />
    </g>

    <!-- 表：带表头分隔线和竖向分隔的矩形 -->
    <g v-else-if="kind === 'table'">
      <rect x="2.2" y="2.6" width="11.6" height="10.8" rx="1.4" stroke="currentColor" stroke-width="1.2" />
      <path d="M2.2 5.8h11.6" stroke="currentColor" stroke-width="1.2" />
      <path d="M6.4 5.8v7.6" stroke="currentColor" stroke-width="1" opacity=".5" />
    </g>

    <!-- 视图：虚线框 + 眼睛，跟表一眼区分开 -->
    <g v-else-if="kind === 'view'">
      <rect
        x="2.2"
        y="2.6"
        width="11.6"
        height="10.8"
        rx="1.4"
        stroke="currentColor"
        stroke-width="1.2"
        stroke-dasharray="2.4 1.6"
      />
      <circle cx="8" cy="8" r="2" stroke="currentColor" stroke-width="1.1" />
    </g>

    <!-- 列：一根竖线带个小横杠，像字段标签 -->
    <g v-else-if="kind === 'column'">
      <path d="M3.2 3.4h9.6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
      <path d="M8 3.4v9.2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
    </g>

    <!-- 主键：钥匙 -->
    <g v-else>
      <circle cx="5.4" cy="10.6" r="2.6" stroke="currentColor" stroke-width="1.2" />
      <path d="M7.3 8.7 13 3M11 3h2v2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" />
    </g>
  </svg>
</template>

<style scoped>
.db-icon {
  flex: 0 0 auto;
  color: var(--text-dim);
}
</style>
