import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import electron from 'vite-plugin-electron/simple'
import { rmSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * 用 .mts 后缀是为了让 Vite 以 ESM 方式加载配置。
 *
 * package.json 不能加 "type": "module" —— 主进程产物 main.js 必须是 CommonJS，
 * 一旦整个包声明成 ESM，Electron 会用 ESM 解析主进程入口直接崩。
 * 所以只能靠扩展名单独把配置文件标成 ESM。
 */
const projectRoot = import.meta.dirname

/**
 * 数据库驱动全是原生/半原生模块，必须保持 require，不能被 rollup 打进 bundle。
 *
 * 注意这里必须是**函数**而不是数组：`external: ['mysql2']` 只匹配字面量 'mysql2'，
 * 匹配不到 'mysql2/promise' —— 用数组的写法会让 mysql2 整个被内联进 main.js（多出 1MB）。
 * 正则按"包名 + 可选子路径"匹配，一次覆盖干净。
 */
const NATIVE_DEPS = /^(pg|pg-native|pg-pool|pg-protocol|mysql2|dmdb|@dmdb|electron)(\/.*)?$/

// 每次启动清掉上一次的主进程产物，避免旧代码残留
try {
  rmSync(resolve(projectRoot, 'dist-electron'), { recursive: true, force: true })
} catch {
  /* 首次运行目录不存在，忽略 */
}

export default defineConfig({
  plugins: [
    vue(),
    electron({
      main: {
        entry: 'electron/main.ts',
        onstart(args) {
          // 部分 IDE / 终端工具链会在父进程注入 ELECTRON_RUN_AS_NODE=1。
          // Electron 读到它会退化成纯 Node 进程：窗口不出现，而且一条日志都不打。
          if (process.env.ELECTRON_RUN_AS_NODE) {
            delete process.env.ELECTRON_RUN_AS_NODE
            console.log('\n[electron] 已清除继承来的 ELECTRON_RUN_AS_NODE（否则窗口不会出现）')
          }
          console.log('[electron] 启动主进程…')
          // 排查界面问题时可以用 THBD_CDP=1 启动，开一个调试端口给外部工具连
          if (process.env.THBD_CDP) {
            args.startup(['.', '--remote-debugging-port=9222'])
          } else {
            args.startup()
          }
        },
        vite: {
          build: {
            outDir: 'dist-electron',
            minify: false,
            rollupOptions: {
              external: NATIVE_DEPS,
              output: {
                format: 'cjs',
                entryFileNames: 'main.js',
                inlineDynamicImports: true
              }
            }
          }
        }
      },
      preload: {
        input: 'electron/preload.ts',
        vite: {
          build: {
            outDir: 'dist-electron',
            minify: false,
            rollupOptions: {
              external: ['electron'],
              // 强制 cjs：Electron 的 sandbox preload 只认 CommonJS
              output: {
                format: 'cjs',
                entryFileNames: 'preload.js',
                inlineDynamicImports: true
              }
            }
          }
        }
      }
    })
  ],
  resolve: {
    alias: {
      '@': resolve(projectRoot, 'src')
    }
  },
  server: {
    port: 5190,
    strictPort: false
  },
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 2000
  }
})
