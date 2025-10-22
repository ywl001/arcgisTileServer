/**
 * ------------------------------------------------------------
 * ArcGIS Cache Tile Server (TypeScript 版本)
 * ------------------------------------------------------------
 * 
 * 功能说明：
 * 本服务用于读取 ArcGIS Server 导出的本地切片缓存（Bundle 格式或 Compact 格式），
 * 并通过 HTTP 接口提供给前端地图（如 ArcGIS JS API、OpenLayers、Leaflet）访问。
 * 
 * 示例请求：
 *   http://localhost:3060/image_tiles/mengjin/MapServer/tile/12/629/3329?blankTile=false
 * 
 * 路由说明：
 *   /<cache_root_dir_name>/:mapName/MapServer/tile/:level/:row/:col
 *   - cache_root_dir_name：RASTER_TILE_ROOT_DIR 的最后一级目录名（如 image_tiles）
 *   - mapName：缓存地图名称（子目录）
 *   - level、row、col：切片坐标索引
 * 
 * 主要职责：
 *   - 动态解析缓存路径；
 *   - 自动识别切片版本（v1/v2）；
 *   - 读取并返回切片二进制数据；
 *   - 对异常请求进行错误处理和日志记录。
 * 
 * 启动方式：
 *   1. 安装依赖：npm install
 *   2. 启动服务：npm run start
 *   3. 访问测试：在浏览器或地图应用中访问示例 URL
 * 
 * 依赖说明：
 *   - express：Web 服务框架
 *   - path：用于路径拼接和解析
 *   - fs：用于文件读取（在 readTileV1/V2 模块中使用）
 * 
 * 作者：Y Wl
 * 创建时间：2025-10
 * ------------------------------------------------------------
 */


//定义一些数据类型
/**
 * conf.xml中的tileinfo
 */
interface TileInfo {
    spatialReference: { wkid: number; latestWkid: number; wkt?: string };
    rows: number;
    cols: number;
    dpi: number;
    origin: { x: number; y: number };
    lods: { level: number; resolution: number; scale: number }[];
}

/**
 * 整个conf.xml
 */
type ConfXmlInfo = {
    tileInfo: TileInfo;       // TileInfo 对象
    imageFormat: 'jpg' | 'png';
    tileType: "v1" | "v2" | "loose" | "unknown";//缓存种类松散，紧凑，紧凑2
    packetSize: number //紧凑型包大小
};

// =========================================================================================
//                                统一服务器配置 (Express + TypeScript)
// =========================================================================================
import express, { Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import cors from 'cors';
import xml2js from 'xml2js';
import { readTileV1, readTileV2 } from './tileReader';

const app = express();
const PORT = 3060;

// 根目录：tileServer
const TILE_SERVER_ROOT = path.resolve(__dirname, '..');

// 1. 栅格切片服务的根目录
const RASTER_TILE_ROOT_DIR = path.join(TILE_SERVER_ROOT, 'image_tiles');

// 2. 矢量切片服务的根目录
const VECTOR_TILE_ROOT_DIR_NAME = 'vector_tiles';
const VECTOR_TILE_ROOT_PATH = path.join(TILE_SERVER_ROOT, VECTOR_TILE_ROOT_DIR_NAME);

const parser = new xml2js.Parser({ explicitArray: false, attrkey: 'attr' });

// 缓存 mapName -> TileType
const mapInfoCache = new Map<string, ConfXmlInfo>();

// =========================================================================================
//                                   CORS 配置 (统一)
// =========================================================================================
app.use(cors());

// =========================================================================================
//                           1. ArcGIS 栅格切片服务 (路由: /image_tile/...)
// =========================================================================================


/** 从 conf.xml 读取并解析 TileInfo */
async function getConfXml(mapName: string): Promise<ConfXmlInfo> {
    if (mapInfoCache.has(mapName)) {
        return mapInfoCache.get(mapName)!;
    }

    const confPath = path.join(RASTER_TILE_ROOT_DIR, mapName, 'conf.xml');

    if (!fs.existsSync(confPath)) {
        throw new Error(`conf.xml not found for map: ${mapName} at ${confPath}`);
    }

    const xml = fs.readFileSync(confPath, 'utf8');
    const result = await parser.parseStringPromise(xml);

    const tileCacheInfo = result.CacheInfo.TileCacheInfo;
    const tileImageInfo = result.CacheInfo.TileImageInfo;
    const tileStorageInfo = result.CacheInfo.CacheStorageInfo;

    const lods = tileCacheInfo.LODInfos.LODInfo.map((lod: any) => ({
        level: parseInt(lod.LevelID),
        resolution: parseFloat(lod.Resolution),
        scale: parseFloat(lod.Scale),
    }));

    const tileInfo: TileInfo = {
        spatialReference: {
            wkid: parseInt(tileCacheInfo.SpatialReference.WKID),
            latestWkid: parseInt(tileCacheInfo.SpatialReference.LatestWKID),
            wkt: tileCacheInfo.SpatialReference.WKT,
        },
        rows: parseInt(tileCacheInfo.TileRows),
        cols: parseInt(tileCacheInfo.TileCols),
        dpi: parseInt(tileCacheInfo.DPI),
        origin: {
            x: parseFloat(tileCacheInfo.TileOrigin.X),
            y: parseFloat(tileCacheInfo.TileOrigin.Y),
        },
        lods,
    };

    const imageFormat = tileImageInfo.CacheTileFormat;

    const storageFormat = tileStorageInfo.StorageFormat;
    const packetSize = parseInt(tileStorageInfo.PacketSize)
    let tileType: "v1" | "v2" | "loose" | "unknown" = 'unknown'
    if (storageFormat === 'esriMapCacheStorageModeCompactV2') tileType = "v2";
    if (storageFormat === 'esriMapCacheStorageModeCompact') tileType = "v1";
    if (storageFormat === 'esriMapCacheStorageModeExploded') tileType = "loose";

    const cached: ConfXmlInfo = { tileInfo, imageFormat, tileType, packetSize };
    mapInfoCache.set(mapName, cached);
    return cached;
}

/** 构建 ArcGIS Server 风格服务描述 */
function buildServiceDescription(mapName: string, tileInfo: TileInfo, tileFormat: string) {
    const imageFormat = tileFormat === 'png' ? 'PNG24' : 'JPEG';
    const supportedFormats = tileFormat === 'png' ? 'PNG24,PNG,GIF' : 'JPG,PNG24,PNG,GIF';
    const tileUrlTemplate = `${mapName}/MapServer/tile/{level}/{row}/{col}`;

    return {
        currentVersion: 11.4,
        serviceDescription: `Dynamically loaded image tile cache: ${mapName}`,
        mapName: 'Layers',
        capabilities: 'Map,Tiles',
        supportedImageFormatTypes: supportedFormats,
        tileInfo,
        exportTilesAllowed: false,
        maxExportTilesCount: 100000,
        singleFusedMapCache: true,
        tileFormat: imageFormat,
        fullExtent: { xmin: -180, ymin: -90, xmax: 180, ymax: 90, spatialReference: { wkid: 4326 } },
        tileUrlTemplates: [tileUrlTemplate],
    };
}

function getAllLayersDir(mapName: string) {
    return path.join(RASTER_TILE_ROOT_DIR, mapName, '_alllayers');
}
// REST 服务描述
app.get(`/${path.basename(RASTER_TILE_ROOT_DIR)}/:mapName/MapServer`, async (req: Request, res: Response) => {
    const { mapName } = req.params;
    if (mapName) {
        try {
            let cached = await getConfXml(mapName)
            const { tileInfo, imageFormat: tileFormat } = cached;
            const serviceDescription = buildServiceDescription(mapName, tileInfo, tileFormat);
            res.json(serviceDescription);
        } catch (error: any) {
            console.error(`Error processing MapServer request for ${mapName}:`, error.message);
            res.status(404).json({ error: 'Service configuration not found or invalid.' });
        }
    }
});

// 实际切片请求
app.get(`/${path.basename(RASTER_TILE_ROOT_DIR)}/:mapName/MapServer/tile/:level/:row/:col`, async (req: Request, res: Response) => {
    const { mapName } = req.params;
    const level = parseInt(req.params.level!);
    const row = parseInt(req.params.row!);
    const col = parseInt(req.params.col!);
    if (!mapName || !level || !row || !col) return res.status(400).send('Missing parameters');


    let conf = await getConfXml(mapName!)

    // const tileType = conf.tileType;
    const { tileType, imageFormat, packetSize } = conf;

    if (tileType === 'loose') {
        console.log('loose')
        const L_dir = 'L' + level.toString().padStart(2, '0');
        const R_dir = 'R' + row.toString(16).toLowerCase().padStart(8, '0');
        const C_file = 'C' + col.toString(16).toLowerCase().padStart(8, '0');

        const extensions = ['.jpg', '.jpeg', '.png'];
        for (const ext of extensions) {
            const tilePath = path.join(RASTER_TILE_ROOT_DIR, mapName, '_alllayers', L_dir, R_dir, `${C_file}${ext}`);
            if (fs.existsSync(tilePath)) {
                return res.sendFile(tilePath);
            }
        }
        return res.status(404).send('Raster Tile not found');
    }
    try {
        let tileBuffer: Buffer | null = null;
        if (tileType === 'v1') {
            tileBuffer = await readTileV1(getAllLayersDir(mapName), level, col, row);
        } else if (tileType === 'v2') {
            tileBuffer = await readTileV2(getAllLayersDir(mapName), col, row, level, packetSize);
        }

        if (!tileBuffer) return res.status(404).send('Tile not found or empty.');

        res.setHeader('Content-Type', `image/${imageFormat}`);
        res.send(tileBuffer);
    } catch (error: any) {
        console.error(`Error sending tile ${mapName} [${level}/${row}/${col}]:`, error.message);
        res.status(500).send('Internal server error.');
    }
});

///////////////////////////////////////////////////////////////////////////////////////////////////
// =========================================================================================
//                           2. 矢量切片服务 (路由: /vector_tile/...)
// =========================================================================================
//////////////////////////////////////////////////////////////////////////////////////////////////

function sendJsonFile(res: Response, filePath: string) {
    if (fs.existsSync(filePath)) {
        res.setHeader('Content-Type', 'application/json');
        return res.sendFile(filePath);
    }
    res.status(404).send(`Not found: ${filePath}`);
}

// 根目录请求
app.get(`/${VECTOR_TILE_ROOT_DIR_NAME}/:package/p12`, (req: Request, res: Response) => {
    if (req.query && req.query.f === 'json') {
        const rootJson = path.join(VECTOR_TILE_ROOT_PATH, req.params.package as string, 'p12', 'root.json');
        return sendJsonFile(res, rootJson);
    }

    if (!req.path.endsWith('/')) {
        const q = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
        return res.redirect(301, req.originalUrl.replace(/\/?$/, '/') + q);
    }

    res.status(204).end();
});

// tilemap 请求
app.get(`/${VECTOR_TILE_ROOT_DIR_NAME}/:package/p12/tilemap`, (req: Request, res: Response) => {
    const tilemapJson = path.join(VECTOR_TILE_ROOT_PATH, req.params.package as string, 'p12', 'tilemap', 'root.json');
    return sendJsonFile(res, tilemapJson);
});

// 静态托管 .pbf
app.use(
    `/${VECTOR_TILE_ROOT_DIR_NAME}`,
    express.static(VECTOR_TILE_ROOT_PATH, {
        setHeaders: (res, filePath) => {
            if (filePath.endsWith('.pbf')) res.setHeader('Content-Type', 'application/x-protobuf');
        },
    })
);

// =========================================================================================
//                                     启动服务器
// =========================================================================================
app.listen(PORT, () => {
    console.log(`统一切片服务已启动在端口: ${PORT}`);
    console.log(`栅格切片: http://localhost:${PORT}/${path.basename(RASTER_TILE_ROOT_DIR)}/{mapName}/MapServer`);
    console.log(`矢量切片: http://localhost:${PORT}/${VECTOR_TILE_ROOT_DIR_NAME}/{package}/p12/`);
});
