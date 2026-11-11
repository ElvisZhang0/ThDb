#!/usr/bin/env node
/**
 * 编译：类型检查（vue-tsc）→ 打包渲染进程与主进程（vite build）。
 *
 * 为什么不写成 `"build": "npm run typecheck && vite build"`：
 * 那句话会刷 8 行警告 ——
 *
 *   npm warn Unknown env config "electron-mirror". This will stop working in the next major version of npm.
 *   npm warn Unknown project config "electron_mirror". …
 *
 * 根因是包管理器混用：用 pnpm 启动时，pnpm 会把 .npmrc 里的**每一个键**导出成
 * `npm_config_*` 环境变量喂给子进程；子进程里的 npm 一看这些键自己不认识，就挨个 warn。
 * 而 electron_mirror / electron_builder_binaries_mirror 本来就是 pnpm 和 electron 的键，
 * npm 天生不认识 —— 这些警告不是配置错，只是"npm 不是这个项目的包管理器"。
 *
 * 与其跟 npm 的 config 白名单较劲，不如让链路里根本没有 npm：
 * 直接把 node_modules/.bin 挂到 PATH 上调用 vite / vue-tsc。
 */
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** npm 跑脚本时会自动把 node_modules/.bin 塞进 PATH；我们自己跑就得手动补上 */
const binDir = path.join(root, 'node_modules', '.bin')

/** 只加 bin 目录，其余环境变量原样传下去 —— ELECTRON_MIRROR 之类的镜像配置不能丢 */
const env = { ...process.env, PATH: binDir + path.delimiter + (process.env.PATH ?? '') }

function run(bin, args, label) {
  console.log(`▶ ${label}`)
  const r = spawnSync(bin, args, {
    cwd: root,
    stdio: 'inherit',
    env,
    // Windows 上 .bin 里放的是 .cmd 批处理，不经 shell 直接 exec 会 ENOENT
    shell: process.platform === 'win32'
  })
  if (r.error) {
    console.error(`✗ ${label} 起不来：${r.error.message}`)
    process.exit(1)
  }
  if (r.status !== 0) {
    console.error(`✗ ${label} 失败（退出码 ${r.status}）`)
    process.exit(r.status || 1)
  }
}

run('vue-tsc', ['--noEmit', '-p', 'tsconfig.web.json'], '类型检查（vue-tsc）')

// 一次 vite build 会顺带出 dist-electron/main.js 与 preload.js：
// 那是 vite-plugin-electron 在配置里挂的子构建，不用单独再跑。
run('vite', ['build'], '打包渲染进程 / 主进程')

console.log('✓ 编译完成')
