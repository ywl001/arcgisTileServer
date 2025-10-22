import fs from 'fs/promises';
import path from 'path';

// 常量定义
// const PACK_SIZE = 128;
const HEADER_SIZE = 64;
const RECORD_SIZE = 8;

// -----------------------------------------------------------------------------
// CompactCache V1
// -----------------------------------------------------------------------------

export async function readTileV1(
  allLayersDir: string,
  z: number,
  x: number,
  y: number,
  packetSize:number = 128
): Promise<Buffer | null> {
  const { L, R, C, rGroup, cGroup } = getBundleInfo(x, y, z);
  const bundlePath = path.join(allLayersDir, L, `${R}${C}.bundle`);
  const bundlxPath = path.join(allLayersDir, L, `${R}${C}.bundlx`);

  const fdIndex = await fs.open(bundlxPath, 'r');
  const buffer = Buffer.alloc(5);
  const index = packetSize * (x - cGroup) + (y - rGroup);
  await fdIndex.read(buffer, 0, 5, 16 + 5 * index);
  const offset = buffer.readUIntLE(0, 5);
  await fdIndex.close();

  if (offset === 0) {
    console.warn(`⚠️ 瓦片 [${z}/${x}/${y}] 在 bundle 中不存在`);
    return null;
  }

  const fdBundle = await fs.open(bundlePath, 'r');
  const lenBuf = Buffer.alloc(4);
  await fdBundle.read(lenBuf, 0, 4, offset);
  const length = lenBuf.readInt32LE();

  if (length <= 0 || length > 1_000_000) {
    console.warn(`⚠️ 无效的瓦片长度: ${length}`);
    await fdBundle.close();
    return null;
  }

  const data = Buffer.alloc(length);
  await fdBundle.read(data, 0, length, offset + 4);
  await fdBundle.close();

  return data;
}

// -----------------------------------------------------------------------------
// Bundle 辅助函数
// -----------------------------------------------------------------------------

function getBundleInfo(col: number, row: number, level: number,packetSize = 128) {
  const rGroup = Math.floor(row / packetSize) * packetSize;
  const cGroup = Math.floor(col / packetSize) * packetSize;

  const L = 'L' + level.toString().padStart(2, '0');
  const R = 'R' + rGroup.toString(16).padStart(4, '0');
  const C = 'C' + cGroup.toString(16).padStart(4, '0');

  return { L, R, C, rGroup, cGroup };
}

// -----------------------------------------------------------------------------
// CompactCache V2
// -----------------------------------------------------------------------------

/**
 * 读取 CompactCache V2 瓦片
 * @param allLayersDir _alllayers 文件夹路径
 * @param col 列索引 (X)
 * @param row 行索引 (Y)
 * @param level 层级 (Z)
 * @param packetSize packetSize, 默认 128
 */
export async function readTileV2(
  allLayersDir: string,
  col: number,
  row: number,
  level: number,
  packetSize: number = 128
): Promise<Buffer | null> {
  const { L, R, C, rGroup, cGroup } = getBundleInfo(col, row, level, packetSize);
  const bundlePath = path.join(allLayersDir, L, `${R}${C}.bundle`);

  console.log('readTileV2:', { col, row, level, L, R, C, bundlePath });

  let fd;
  try {
    fd = await fs.open(bundlePath, 'r');
  } catch (err) {
    console.warn(`Bundle file not found: ${bundlePath}`);
    return null;
  }

  try {
    // 读取 header
    const headerBuf = Buffer.alloc(HEADER_SIZE);
    await fd.read(headerBuf, 0, HEADER_SIZE, 0);

    const version = headerBuf.readUInt32LE(0);
    if (version !== 3) {
      console.warn(`Unsupported bundle version: ${version} at ${bundlePath}`);
      return null;
    }

    // 计算 tile index 和 record 偏移
    const tileIndex = packetSize * (row - rGroup) + (col - cGroup);
    const recordOffset = HEADER_SIZE + RECORD_SIZE * tileIndex;

    const recordBuf = Buffer.alloc(4);
    await fd.read(recordBuf, 0, 4, recordOffset);
    const dataOffset = recordBuf.readInt32LE(0);

    if (dataOffset === 0) {
      console.warn(`Tile not found in bundle: (${col}, ${row})`);
      return null;
    }

    // 读取 tile 长度
    const lengthBuf = Buffer.alloc(4);
    await fd.read(lengthBuf, 0, 4, dataOffset - 4);
    const tileSize = lengthBuf.readInt32LE(0);

    if (tileSize <= 0) {
      console.warn(`Invalid tile size at (${col}, ${row}): ${tileSize}`);
      return null;
    }

    const tileBuf = Buffer.alloc(tileSize);
    await fd.read(tileBuf, 0, tileSize, dataOffset);

    return tileBuf;
  } finally {
    await fd.close();
  }
}
