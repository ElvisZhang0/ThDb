#!/usr/bin/env node
/**
 * SQL 切分与值拍平的单元测试。
 *
 * 为什么单独测这两个函数：它们是整个工具里唯一"纯逻辑但不显眼"的地方 ——
 * 切错一句 SQL，用户会看到一堆莫名其妙的语法错，而且很难联想到是分号解析的锅。
 * 用 esbuild 现场把 TS 编成 ESM 再 import，不引测试框架（vitest 要再装一堆东西）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * esbuild 是 vite 的依赖，pnpm 不会把它提升到顶层，直接 `import('esbuild')` 找不到。
 * 从 vite 自己的解析上下文里要绝对路径。
 */
const { createRequire } = await import('node:module')
const esbuildPath = createRequire(import.meta.resolve('vite')).resolve('esbuild')
const { build } = await import(pathToFileURL(esbuildPath).href)

const entry = path.join(root, 'electron/modules/drivers/shared.ts')
const outFile = path.join(os.tmpdir(), `thbd-shared-${Date.now()}.mjs`)
await build({
  entryPoints: [entry],
  outfile: outFile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  logLevel: 'silent'
})

const { splitStatements, toCell, statementVerb, explainError } = await import(
  pathToFileURL(outFile).href
)

let pass = 0
let fail = 0

function eq(label, actual, expected) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a === b) {
    pass += 1
    console.log(`  ✓ ${label}`)
  } else {
    fail += 1
    console.log(`  ✗ ${label}\n      实际: ${a}\n      期望: ${b}`)
  }
}

console.log('splitStatements')

eq('两条简单语句', splitStatements('select 1; select 2;'), ['select 1', 'select 2'])
eq('末尾没有分号也算一条', splitStatements('select 1'), ['select 1'])
eq('字符串里的分号不切', splitStatements("select ';' as x"), ["select ';' as x"])
eq('双引号标识符里的分号不切', splitStatements('select "a;b" from t'), ['select "a;b" from t'])
eq('反引号标识符里的分号不切', splitStatements('select `a;b` from t'), ['select `a;b` from t'])
eq('单引号转义（两个单引号）', splitStatements("select 'it''s; ok'"), ["select 'it''s; ok'"])
eq('反斜杠转义（MySQL）', splitStatements("select 'a\\';b'"), ["select 'a\\';b'"])
eq('行注释里的分号不切', splitStatements('-- a;b\nselect 1'), ['-- a;b\nselect 1'])
eq('# 注释里的分号不切', splitStatements('# a;b\nselect 1'), ['# a;b\nselect 1'])
eq('块注释里的分号不切', splitStatements('/* a;b */ select 1'), ['/* a;b */ select 1'])
eq('PG 美元引用里的分号不切', splitStatements('create function f() as $$ begin a; b; end $$ language plpgsql'), [
  'create function f() as $$ begin a; b; end $$ language plpgsql'
])
eq('带标签的美元引用', splitStatements('do $body$ begin x; end $body$'), ['do $body$ begin x; end $body$'])
eq('只有空语句', splitStatements(';;;'), [])
eq('只有注释', splitStatements('-- nothing here'), [])
eq('空串', splitStatements('   '), [])
eq(
  'DDL 后的 DML 不被吞',
  splitStatements('create table t(a int); insert into t values (1);'),
  ['create table t(a int)', 'insert into t values (1)']
)
eq(
  '注释紧贴语句不切碎',
  splitStatements('select 1; -- 结尾注释\n'),
  ['select 1']
)

console.log('toCell')

eq('null 保持 null', toCell(null), null)
eq('undefined 当 null', toCell(undefined), null)
eq('字符串原样', toCell('abc'), 'abc')
eq('数字原样', toCell(42.5), 42.5)
eq('布尔原样', toCell(false), false)
eq('大整数转字符串保精度', toCell(9007199254740993n), '9007199254740993')
eq('安全整数仍是数字', toCell(7n), 7)
eq('日期带毫秒才显示毫秒', toCell(new Date(2026, 10, 10, 14, 23, 1)), '2026-11-10 14:23:01')
eq('对象转 JSON', toCell({ a: 1 }), '{"a":1}')
eq('短 Buffer 转 0x', toCell(Buffer.from([0x0a, 0x1b])), '0x0a 1b')

console.log('statementVerb')
eq('取首词并大写', statementVerb('  select * from t'), 'SELECT')
eq('insert', statementVerb('insert into t values(1)'), 'INSERT')

console.log('explainError')
eq(
  'ECONNREFUSED 有中文解释',
  explainError({ code: 'ECONNREFUSED', message: 'connect ECONNREFUSED' }).includes('连接被拒绝'),
  true
)
eq(
  'pg 的 detail 会带上',
  explainError({ message: 'duplicate key', detail: 'Key (id)=(1) already exists.' }).includes('Key (id)'),
  true
)

fs.rmSync(outFile, { force: true })

console.log('')
console.log(fail === 0 ? `✓ 全部通过（${pass} 项）` : `✗ ${fail} 项失败 / 共 ${pass + fail} 项`)
process.exit(fail === 0 ? 0 : 1)
