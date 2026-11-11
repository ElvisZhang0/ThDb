#!/usr/bin/env node
/**
 * 生成应用图标。
 *
 * 为什么不引 sharp / pngjs：只需要画一个几何图形，多装一个带原生依赖的包不划算。
 * 这里用一个几十行的软件光栅器 —— 每个像素做 3×3 超采样求覆盖率，
 * 再用 Node 自带的 zlib 编成 PNG，ICO 直接把 PNG 塞进去（Vista 之后都支持）。
 *
 * 产物：
 *   build/icon.png          512×512，mac / 通用
 *   build/icon.ico          内嵌 256×256 PNG，Windows 安装包与任务栏
 *   build/icons/NxN.png     16~512，Linux 需要一整套
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/* -------------------------------------------------------------- PNG 编码 */

const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

/** rgba: Uint8Array，长度 w*h*4 */
function encodePng(rgba, w, h) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type: RGBA
  // 10/11/12 = compression / filter / interlace，全 0

  // 每行前面加一个 filter 字节（0 = None）。图很小，不做行过滤也够。
  const raw = Buffer.alloc((w * 4 + 1) * h)
  for (let y = 0; y < h; y += 1) {
    const rowStart = y * (w * 4 + 1)
    raw[rowStart] = 0
    Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, rowStart + 1)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/* ---------------------------------------------------------------- 光栅器 */

const SS = 3 // 每轴 3 个采样点

/** 平滑过渡：把距离映射成 0~1 的覆盖率 */
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v)

function insideRoundRect(x, y, x0, y0, x1, y1, r) {
  const cx = Math.min(Math.max(x, x0 + r), x1 - r)
  const cy = Math.min(Math.max(y, y0 + r), y1 - r)
  const dx = x - cx
  const dy = y - cy
  return dx * dx + dy * dy <= r * r
}

function insideEllipse(x, y, cx, cy, rx, ry) {
  const dx = (x - cx) / rx
  const dy = (y - cy) / ry
  return dx * dx + dy * dy <= 1
}

function mix(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t)
  ]
}

/**
 * 画图标：圆角底 + 数据库圆柱 + 一道表示"查询"的横线。
 * 圆柱用三条弧定出体积感 —— 顶部椭圆、两道腰线、底部收口。
 */
function render(size) {
  const out = new Uint8Array(size * size * 4)
  const S = size

  // 配色跟界面里的深色主题一致，任务栏里一眼能认出来
  const BG1 = [36, 46, 56]
  const BG2 = [20, 24, 30]
  const TEAL = [63, 185, 160]
  const TEAL_DIM = [42, 132, 114]
  const WHITE = [232, 246, 242]

  const pad = S * 0.055
  const radius = S * 0.225

  // 圆柱在图标里的位置
  const cx = S * 0.5
  const topY = S * 0.285
  const bottomY = S * 0.735
  const rx = S * 0.225
  const ry = S * 0.075
  const lineW = Math.max(1.15, S * 0.028)

  for (let y = 0; y < S; y += 1) {
    for (let x = 0; x < S; x += 1) {
      let bgCov = 0
      let bodyCov = 0
      let topCov = 0
      let waist1 = 0
      let waist2 = 0
      let accent = 0

      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const px = x + (sx + 0.5) / SS
          const py = y + (sy + 0.5) / SS

          if (insideRoundRect(px, py, pad, pad, S - pad, S - pad, radius)) bgCov += 1

          // 圆柱体：底部椭圆以下不给，顶面椭圆以上不给，中间矩形填充
          const inBody =
            insideEllipse(px, py, cx, bottomY, rx, ry) ||
            (py <= bottomY && py >= topY && Math.abs(px - cx) <= rx)
          if (inBody) bodyCov += 1

          if (insideEllipse(px, py, cx, topY, rx, ry)) topCov += 1

          // 两道腰线：只在圆柱外壁上，做成"环"而不是实心椭圆
          for (const [target, wy] of [
            [0, topY + (bottomY - topY) * 0.42],
            [1, topY + (bottomY - topY) * 0.78]
          ]) {
            const onRing =
              insideEllipse(px, py, cx, wy, rx, ry) &&
              !insideEllipse(px, py, cx, wy, rx - lineW, Math.max(0.5, ry - lineW * 0.62))
            if (onRing && py >= wy) {
              if (target === 0) waist1 += 1
              else waist2 += 1
            }
          }

          // 右下角一个小圆点，给静态图标一点"活动"的暗示
          if (insideEllipse(px, py, S * 0.745, S * 0.755, S * 0.072, S * 0.072)) accent += 1
        }
      }

      const n = SS * SS
      const covBg = bgCov / n
      if (covBg === 0) continue

      // 背景：左上到右下的线性渐变
      const t = clamp01((x / S) * 0.55 + (y / S) * 0.45 + 0.15)
      let rgb = mix(BG1, BG2, t)

      // 圆柱主体（深青）
      rgb = mix(rgb, TEAL_DIM, clamp01((bodyCov / n) * 1.35))
      // 顶面椭圆（亮青）—— 数据库图标的标志性特征
      rgb = mix(rgb, TEAL, clamp01(topCov / n))
      // 腰线用浅色压一道，体现分层
      const waists = clamp01((waist1 + waist2) / n)
      rgb = mix(rgb, WHITE, waists * 0.9)
      // 右下角点缀
      rgb = mix(rgb, TEAL, clamp01(accent / n))

      const i = (y * S + x) * 4
      out[i] = rgb[0]
      out[i + 1] = rgb[1]
      out[i + 2] = rgb[2]
      out[i + 3] = Math.round(clamp01(covBg) * 255)
    }
  }
  return out
}

/* ------------------------------------------------------------------ ICO */

/** 单张 256×256 PNG 的 ICO。Vista 之后的 Windows 都认这种格式 */
function encodeIco(png, size) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type = icon
  header.writeUInt16LE(1, 4) // count

  const entry = Buffer.alloc(16)
  entry[0] = size >= 256 ? 0 : size // 宽，0 表示 256
  entry[1] = size >= 256 ? 0 : size
  entry[2] = 0 // 调色板数
  entry[3] = 0 // reserved
  entry.writeUInt16LE(1, 4) // color planes
  entry.writeUInt16LE(32, 6) // bits per pixel
  entry.writeUInt32LE(png.length, 8)
  entry.writeUInt32LE(6 + 16, 12) // 数据偏移

  return Buffer.concat([header, entry, png])
}

/* --------------------------------------------------------------- 主流程 */

const buildDir = path.join(root, 'build')
const iconsDir = path.join(buildDir, 'icons')
fs.mkdirSync(iconsDir, { recursive: true })

const SIZES = [16, 32, 48, 64, 128, 256, 512]

for (const size of SIZES) {
  const px = render(size)
  const png = encodePng(px, size, size)
  if (size === 512) fs.writeFileSync(path.join(buildDir, 'icon.png'), png)
  if (size === 256) fs.writeFileSync(path.join(buildDir, 'icon.ico'), encodeIco(png, 256))
  fs.writeFileSync(path.join(iconsDir, `${size}x${size}.png`), png)
  console.log(`  ✓ ${size}×${size}`)
}

console.log('✓ 图标已生成到 build/')
