'use strict';
/**
 * 纯 JS 生成应用图标 / 托盘图标，避免携带二进制资源。
 * 用 zlib 手写最小 PNG 编码器，绘制一个番茄钟风格的圆角方块 + 表盘。
 */
const zlib = require('node:zlib');

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/** RGBA 像素数组 -> PNG Buffer */
function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function mix(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
    Math.round(a[3] + (b[3] - a[3]) * t),
  ];
}

/**
 * 画一个图标：
 * - 底：圆角方块，橙色渐变
 * - 中：白色圆环（表盘）
 * - 上：两片叶子
 */
function drawIcon(size) {
  const px = Buffer.alloc(size * size * 4);
  const put = (x, y, color) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    const a = color[3] / 255;
    const inv = 1 - a;
    px[i] = Math.round(color[0] * a + px[i] * inv);
    px[i + 1] = Math.round(color[1] * a + px[i + 1] * inv);
    px[i + 2] = Math.round(color[2] * a + px[i + 2] * inv);
    px[i + 3] = Math.max(px[i + 3], Math.round(color[3]));
  };

  const s = size;
  const radius = s * 0.24;
  const top = [0xf6, 0x8b, 0x3a, 255];
  const bottom = [0xe0, 0x4f, 0x3d, 255];

  // 圆角方块 + 抗锯齿（按到圆角中心的距离做覆盖率近似）
  for (let y = 0; y < s; y += 1) {
    for (let x = 0; x < s; x += 1) {
      const cx = Math.min(Math.max(x + 0.5, radius), s - radius);
      const cy = Math.min(Math.max(y + 0.5, radius), s - radius);
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      const cover = Math.max(0, Math.min(1, radius - d + 0.5));
      if (cover <= 0) continue;
      const color = mix(top, bottom, y / s);
      put(x, y, [color[0], color[1], color[2], Math.round(255 * cover)]);
    }
  }

  // 表盘：白色圆环
  const c = s / 2;
  const rOuter = s * 0.33;
  const rInner = s * 0.25;
  for (let y = 0; y < s; y += 1) {
    for (let x = 0; x < s; x += 1) {
      const d = Math.hypot(x + 0.5 - c, y + 0.5 - c);
      let cover = 0;
      if (d <= rInner) cover = 0;
      else if (d >= rOuter) cover = 0;
      else {
        cover = 1;
        if (d > rOuter - 1) cover = Math.max(0, rOuter - d);
        if (d < rInner + 1) cover = Math.min(cover, Math.max(0, d - rInner));
      }
      if (cover <= 0) continue;
      put(x, y, [255, 255, 255, Math.round(255 * cover)]);
    }
  }

  // 指针：从圆心指向右上
  const handLen = s * 0.2;
  const steps = Math.ceil(handLen * 3);
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const x = Math.round(c + Math.cos(-Math.PI / 3) * handLen * t - 0.5);
    const y = Math.round(c + Math.sin(-Math.PI / 3) * handLen * t - 0.5);
    for (let dx = 0; dx <= Math.max(1, Math.round(s * 0.035)); dx += 1) put(x + dx, y, [255, 255, 255, 255]);
  }

  // 叶子
  const leafY = Math.round(s * 0.13);
  for (let i = 0; i < Math.round(s * 0.14); i += 1) {
    const dx = Math.round(i * 0.6);
    put(Math.round(c - s * 0.02) + dx, leafY + i, [0x4c, 0xaf, 0x50, 255]);
    put(Math.round(c + s * 0.02) - dx, leafY + i, [0x66, 0xbb, 0x6a, 255]);
  }

  return encodePng(size, size, px);
}

let cache = null;
/** @returns {Buffer} 128x128 PNG */
function appIconPng() {
  if (!cache) cache = drawIcon(128);
  return cache;
}

/** 托盘用小尺寸（Windows 上 16/32 均可，交给 Electron 缩放） */
function trayIconPng() {
  return drawIcon(32);
}

/** 生成 data URL，可直接给 <img src> 或 nativeImage.createFromDataURL */
function pngDataUrl(buf) {
  return 'data:image/png;base64,' + buf.toString('base64');
}

module.exports = { appIconPng, trayIconPng, pngDataUrl, encodePng, drawIcon };
