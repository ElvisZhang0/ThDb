# ThBD

一个跨平台的**数据库管理工具**（Electron + Vue 3），用来连接、浏览和查询四类数据库：

| 数据库 | 驱动 | 默认端口 | 说明 |
| --- | --- | --- | --- |
| PostgreSQL | `pg` | 5432 | |
| MySQL | `mysql2` | 3306 | |
| KingBase 人大金仓 | `pg` | 54321 | 协议与 PG 兼容，复用 PG 驱动，元数据走 `pg_catalog` |
| DM 达梦 | `dmdb` | 5236 | 官方 Node 驱动，走 Oracle 风格的数据字典 |

## 功能

- **连接树**：连接 → 库 → 模式 → 表/视图 → 列，逐级懒加载；双击表直接查前 200 行
- **SQL 编辑器**：CodeMirror 6，按方言高亮；`Ctrl/⌘ + Enter` 执行，**选中一段就只执行那段**
- **多语句**：按分号拆分逐条执行，每条结果独立页签，失败即停并保留已成功的部分
- **结果表格**：虚拟滚动（几万行不掉帧）、列宽按内容自适应、`NULL` 单独着色、点格子 `Ctrl+C` 复制
- **导出**：结果集可复制为制表符分隔（粘进表格软件自动分列），或导出 CSV（带 UTF-8 BOM，Excel 不乱码）
- **多库浏览**：PG / 金仓按库各开一条连接，切库不重连
- **取消长查询**：PG / 金仓通过另一条连接发 `pg_cancel_backend`，只杀语句不杀会话
- **密码加密**：`safeStorage`（Windows DPAPI / macOS Keychain / Linux libsecret），配置文件里看不到明文
- **深浅色主题**、可拖动分隔条、搜索结果过滤

## 开发

```bash
pnpm install
pnpm dev          # 启动开发环境（Vite + Electron）
pnpm test         # SQL 切分 / 值拍平的单元测试
pnpm build        # 类型检查 + 打包（产物在 dist/ 与 dist-electron/）
```

> `dmdb` 放在 `optionalDependencies` 里：它带原生 `.node`，个别平台装不上。
> 装不上时其余三种库照常可用，界面的「关于」里会标明哪个驱动没就绪。

## 打包

```bash
pnpm dist:win     # Windows：nsis 安装包 + 免安装单文件
pnpm dist:mac     # macOS：dmg（x64 / arm64）
pnpm dist:linux   # Linux：AppImage + deb
pnpm icons        # 重新生成图标（纯 Node 实现，不依赖 sharp）
```

打包脚本 `scripts/dist.mjs` 顺手处理两件麻烦事：

1. **npm warn 刷屏** —— 用 pnpm 启动时它会把 `.npmrc` 的每个键导出成 `npm_config_*`，子进程里的 npm 不认识就挨个告警。现在整条链路直接调 `node_modules/.bin` 里的程序，没有 npm 参与。
2. **`app.asar` 被占用导致打包中止** —— 先 `taskkill` 掉上次跑着的实例，删不掉旧 `win-unpacked` 时改到临时目录打包、打完把安装包拷回 `release/`，并点名是哪个文件卡着。

## 结构

```
electron/
  main.ts                  窗口、IPC 注册、生命周期
  preload.ts               contextBridge 白名单（渲染层拿不到 ipcRenderer）
  types.ts                 主进程 / 渲染层共享的类型与常量
  modules/
    config-store.ts        userData 下的配置读写 + safeStorage 加解密
    db-manager.ts          会话表、多语句执行、取消
    drivers/
      shared.ts            DbDriver 接口、值拍平、SQL 切分、错误翻译
      postgres.ts          pg（同时服务金仓），按库维护客户端池
      mysql.ts             mysql2，库即模式
      dm.ts                dmdb，回调/Promise 双兼容
src/
  App.vue                  外壳：工具条 + 编辑器 + 结果区 + 状态栏
  components/
    ExplorerTree.vue       延迟加载的连接树
    SqlEditor.vue          CodeMirror 封装（方言 / 字号 / 主题可热切换）
    ResultGrid.vue         虚拟滚动结果表
    ResultPanel.vue        多结果页签、错误块、复制与导出
    ConnectionDialog.vue   连接配置 + 测试连接
    DbIcon.vue             10 个手绘的小图标
  stores/app.ts            Pinia：配置、会话、草稿、结果
scripts/
  build.mjs / dist.mjs     构建与打包（绕开 npm）
  make-icons.mjs           图标生成（自带 PNG / ICO 编码器）
  test-sql.mjs             SQL 切分与值拍平的测试
```

## 几个实现上的取舍

- **结果行为什么是二维数组而不是对象数组**：`select a.id, b.id from a join b` 会出来两列同名列，映射成对象时后者把前者覆盖掉，用户会莫名少一列。
- **为什么不用 `fastGet` 那一类整包 API**：那些调用中途无法干预；这里的执行路径每一步都自己控制，才能做到"取消某一条语句"。
- **MySQL 的 `dateStrings: true`**：不然 `2026-11-10 00:00:00` 会按本机时区变成 `2026-11-09 16:00:00`，在数据库工具里这是最招骂的 bug。
- **不在 SQL 外面套 `select * from (...) limit n`**：看起来能省内存，但内层有重名列时 MySQL 会直接报错，把一条本来能跑的语句改坏。当前策略是整取后截断，并在界面上标「已截断」。
- **多语句碰到第一条错误就停**：继续跑下去会刷出一堆"表不存在"的连带错误，反而看不出真正的原因。

## 已知限制（v0.1）

- 结果集只读，不支持行内编辑 / 新增 / 删除行
- 不生成建表 DDL，没有 ER 图、没有导入导出整库
- 达梦的「库」层是占位（DM 一个实例一套数据），实际浏览按模式展开
- 达梦驱动 `dmdb` 的 API 在不同小版本间有出入，`execute` 的回调与 Promise 两种形态都做了兼容，但未在真实达梦实例上验证过
- 长查询取消只支持 PostgreSQL / 金仓（MySQL 需要额外连接发 `KILL QUERY`，暂未做）

## 许可

内部工具，未开源授权。
