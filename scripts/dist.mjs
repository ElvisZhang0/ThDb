#!/usr/bin/env node
/**
 * 打桌面端安装包。
 *
 * 用法：
 *   pnpm run dist:win     Windows：nsis 安装包 + 免安装单文件
 *   pnpm run dist:mac     macOS：dmg + zip（x64 / arm64）
 *   pnpm run dist:linux   Linux：AppImage / deb
 *   pnpm run dist         当前平台，electron-builder 默认目标
 *
 * 这一层壳解决两件真事：
 *
 * ① **npm warn 刷屏**：原来 scripts 里是 `npm run build && electron-builder`，
 *    用 pnpm 启动时 pnpm 会把 .npmrc 的每个键导出成 npm_config_*，
 *    子进程 npm 不认识就挨个告警。现在全程直接调 bin，链路里没有 npm。
 *
 * ② **app.asar 被占用，整次打包失败**：
 *      ⨯ remove release\win-unpacked\resources\app.asar:
 *        The process cannot access the file because it is being used by another process
 *    electron-builder 打包前会清空 `<output>/win-unpacked`；只要里面有**一个**文件
 *    还被别的进程打开着，删除就失败、构建直接中止。处理顺序：
 *      a. 先 taskkill /F /IM ThBD.exe —— 没有这个进程就静默跳过
 *      b. 带重试地删旧目录（Windows 上进程没了，句柄也可能晚几百毫秒才释放）
 *      c. 还是删不掉 → 把输出目录改到临时目录，打完把顶层产物拷回 release/，
 *         并且**点名是哪个文件卡着** —— 比甩一句 EPERM 有用得多
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(root, 'release')
const binDir = path.join(root, 'node_modules', '.bin')

/**
 * 把 .npmrc 里的镜像配置翻译成 electron-builder / @electron/get 认的环境变量。
 *
 * 平时这活是包管理器干的：pnpm 会把 .npmrc 的每个键导出成 `npm_config_*`，
 * 子进程里的 electron-builder 再从那儿取（见 app-builder-lib/out/binDownload.js）。
 * 我们绕过包管理器直接调 bin，就得自己补上 —— 不然 electron-builder 会跑去
 * github.com 拉 nsis / winCodeSign，国内基本卡死。
 */
function loadNpmrcMirrors() {
  const file = path.join(root, '.npmrc')
  if (!fs.existsSync(file)) return
  const MAP = {
    electron_mirror: 'ELECTRON_MIRROR',
    electron_builder_binaries_mirror: 'ELECTRON_BUILDER_BINARIES_MIRROR'
  }
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([\w.-]+)\s*=\s*(.+?)\s*$/)
    if (!m) continue
    const name = MAP[m[1]]
    if (name && !process.env[name]) process.env[name] = m[2]
  }
}
loadNpmrcMirrors()

const env = { ...process.env, PATH: binDir + path.delimiter + (process.env.PATH ?? '') }

/** 收尾时用来判断"哪些包是这次打的" */
const startedAt = Date.now()

const TARGETS = {
  '': { args: [], unpacked: ['win-unpacked', 'mac', 'mac-arm64', 'linux-unpacked'], label: '当前平台' },
  win: { args: ['--win', '--x64'], unpacked: ['win-unpacked'], label: 'Windows x64' },
  mac: { args: ['--mac', '--x64', '--arm64'], unpacked: ['mac', 'mac-arm64'], label: 'macOS x64 + arm64' },
  linux: { args: ['--linux'], unpacked: ['linux-unpacked'], label: 'Linux' }
}

/** 同步 sleep —— 这里的等待点都在"等句柄释放"，异步反而把流程写乱 */
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

function say(msg) {
  console.log(`[dist] ${msg}`)
}

function run(cmd, args, label, opts = {}) {
  if (label) console.log(`▶ ${label}`)
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', env, ...opts })
  if (r.error) {
    console.error(`✗ ${label ?? cmd} 起不来：${r.error.message}`)
    process.exit(1)
  }
  if (r.status !== 0) {
    console.error(`✗ ${label ?? cmd} 失败（退出码 ${r.status}）`)
    process.exit(r.status || 1)
  }
}

/* ------------------------------------------------------------------ 清理 */

/** 上一次打包出来的程序还活着的话，它的 app.asar 一定是被锁着的 */
function killRunningApp() {
  if (process.platform !== 'win32') return
  const r = spawnSync('taskkill', ['/F', '/IM', 'ThBD.exe'], { stdio: 'ignore' })
  // 退出码 128 = 没找到这个进程，属于正常情况（本来就没开）
  if (r.status === 0) say('已结束正在运行的 ThBD —— 它占着 app.asar，不关掉打不了包')
}

/** 这几个错误码都是"现在删不动，但过一会儿可能就行"，值得重试 */
const TRANSIENT = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY', 'ENOTDIR'])

function clearDir(dir) {
  let last = null
  for (let i = 0; i < 10; i += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 })
      return { ok: true }
    } catch (err) {
      last = err
      // 只有"等一会儿可能就好了"的错误才值得重试（句柄晚释放）；
      // 其他原因（目录只读、被安全软件拦下）重试也没用，直接交给临时目录方案。
      if (!TRANSIENT.has(err.code)) break
      sleep(300)
    }
  }
  return { ok: false, err: last }
}

/**
 * 整个目录一次删不掉时，退化成"逐个文件删"，把删不掉的那几个揪出来。
 *
 * Windows 上的句柄可以只允许读/写、不允许删（FILE_SHARE_DELETE 没给），
 * 这时文件能正常读、只有删除和改名会失败 —— 所以"试着打开一下"探不出占用，
 * 必须真的去删才知道。反正这些文件本来就要删，顺手就能定位到具体路径。
 */
function sweep(dir) {
  const stuck = []

  const remove = (p) => {
    for (let i = 0; i < 3; i += 1) {
      try {
        fs.rmSync(p, { recursive: true, force: true, maxRetries: 2, retryDelay: 120 })
        return true
      } catch (err) {
        if (!TRANSIENT.has(err.code)) return false
        sleep(200)
      }
    }
    return false
  }

  const walk = (d, depth) => {
    let entries
    try {
      entries = fs.readdirSync(d, { withFileTypes: true })
    } catch {
      stuck.push(d)
      return
    }
    for (const e of entries) {
      const p = path.join(d, e.name)
      if (remove(p)) continue
      // 目录删不掉通常是里面还有文件被占着，往下钻一层；文件删不掉就直接记下
      if (e.isDirectory() && depth < 8) walk(p, depth + 1)
      else stuck.push(p)
    }
  }

  walk(dir, 0)
  return stuck
}

/* -------------------------------------------------------------- 主流程 */

const key = (process.argv[2] ?? '').toLowerCase()
const target = TARGETS[key]
if (!target) {
  console.error(`[dist] 不认识的目标：${key || '(空)'}`)
  console.error('[dist] 可选：win / mac / linux，或者不带参数 = 当前平台')
  process.exit(1)
}

say(`1/3 编译（目标：${target.label}）…`)
run(process.execPath, ['scripts/build.mjs'])

say('2/3 清理旧产物…')
killRunningApp()

let outDir = OUT
const blocked = []
for (const name of target.unpacked) {
  const dir = path.join(OUT, name)
  if (!fs.existsSync(dir)) continue
  const r = clearDir(dir)
  if (!r.ok) {
    blocked.push({
      dir,
      stuck: sweep(dir),
      why: r.err?.code ?? String(r.err?.message ?? '未知原因').slice(0, 80)
    })
  }
}

if (blocked.length) {
  outDir = path.join(os.tmpdir(), 'thbd-release')
  try {
    fs.rmSync(outDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 })
  } catch {
    /* 清不掉也无所谓，electron-builder 自己会覆盖 */
  }
  console.warn('')
  for (const b of blocked) {
    console.warn(`[dist] ⚠ 删不掉 ${path.relative(root, b.dir)}（${b.why}）`)
    // 只列前三个：卡住的几乎总是同一个文件，列一长串反而看不清
    for (const p of b.stuck.slice(0, 3)) {
      console.warn(`[dist]   被占用的是：${path.relative(root, p)}`)
    }
    if (b.stuck.length > 3) console.warn(`[dist]   ……还有 ${b.stuck.length - 3} 个`)
  }
  console.warn('[dist]   多半是上一次打出来的程序还开着，或者杀毒软件正在扫这个文件。')
  console.warn(`[dist]   这次先打到临时目录：${outDir}`)
  console.warn('[dist]   打完会把安装包拷回 release/；那个 unpacked 目录保持原样（动不了）。')
  console.warn('')
}

say(`3/3 打包（${target.label}）…`)
const args = [...target.args]
if (outDir !== OUT) {
  // electron-builder 认 --config.<路径>=<值>；反斜杠在 windows 上会被当成转义，统一用 /
  args.push(`--config.directories.output=${outDir.replace(/\\/g, '/')}`)
}
run('electron-builder', args, null, { shell: process.platform === 'win32' })

/* ------------------------------------------------------- 临时目录 → release */

if (outDir !== OUT) {
  say('把产物拷回 release/…')
  let failed = 0
  for (const e of fs.readdirSync(outDir, { withFileTypes: true })) {
    // 只搬文件：*-unpacked 是解包目录，目标位置正被占用，搬不了也用不着
    if (!e.isFile()) continue
    const from = path.join(outDir, e.name)
    // 临时目录跨次复用，里面可能还躺着上一版留下的包 —— 只搬这次新写出来的
    if (fs.statSync(from).mtimeMs < startedAt - 2000) continue
    try {
      fs.copyFileSync(from, path.join(OUT, e.name))
    } catch (err) {
      failed += 1
      console.warn(`[dist] ⚠ ${e.name} 拷不回去：${err.code ?? err.message}`)
    }
  }
  if (failed) console.warn(`[dist] 有 ${failed} 个文件没拷回来，原件在 ${outDir}`)
}

/* ------------------------------------------------------------------ 收尾 */

// 只看**这次**产出的文件：release/ 里通常还躺着上一版留下的同名旧包
const ARTIFACT = /\.(exe|dmg|zip|AppImage|deb|rpm|tar\.gz|msi|snap)$/i
const made = fs
  .readdirSync(OUT, { withFileTypes: true })
  .filter((e) => e.isFile() && ARTIFACT.test(e.name))
  .map((e) => ({ name: e.name, stat: fs.statSync(path.join(OUT, e.name)) }))
  .filter((f) => f.stat.mtimeMs >= startedAt - 2000)
  .map((f) => `  ${f.name}  ${(f.stat.size / 1024 / 1024).toFixed(1)} MB`)

say('完成。产物在 release/：')
console.log(made.length ? made.join('\n') : '  （没有产出，看上面的报错）')
