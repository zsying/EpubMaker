import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 应用根目录（默认 ~/.epubmaker）。
 * 可通过环境变量 EPUBMAKER_HOME 覆盖。
 * 该目录下存放：config.json、data/(数据库 + 书籍资源)、exports/(生成的 epub)、logs/、tmp/
 */
export const APP_HOME = path.resolve(
  process.env.EPUBMAKER_HOME || path.join(os.homedir(), '.epubmaker')
);

export const CONFIG_FILE = path.join(APP_HOME, 'config.json');

export interface AppConfig {
  /** 服务监听端口 */
  port: number;
  /** 服务监听地址 */
  host: string;
  /** 数据目录（数据库 + 书籍解包资源）。相对路径基于 APP_HOME 解析 */
  dataDir: string;
  /** 导出的 epub 存放目录 */
  exportDir: string;
  /** 日志目录 */
  logDir: string;
  /** 临时上传目录 */
  tmpDir: string;
  /** 日志级别 */
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  /** 上传大小上限（MB） */
  maxUploadSizeMb: number;
  /** 导入时是否保留原始 epub 副本 */
  keepOriginalEpub: boolean;
}

const DEFAULT_CONFIG: AppConfig = {
  port: 7801,
  host: '127.0.0.1',
  dataDir: 'data',
  exportDir: 'exports',
  logDir: 'logs',
  tmpDir: 'tmp',
  logLevel: 'info',
  maxUploadSizeMb: 300,
  keepOriginalEpub: true
};

function resolveDir(value: string): string {
  return path.isAbsolute(value) ? value : path.join(APP_HOME, value);
}

export interface ResolvedConfig extends AppConfig {
  appHome: string;
  configFile: string;
  /** 绝对路径 */
  paths: {
    data: string;
    exports: string;
    logs: string;
    tmp: string;
    books: string;
    dbFile: string;
  };
}

let cached: ResolvedConfig | null = null;

/** 读取（必要时创建）配置文件，并保证所有目录存在 */
export function loadConfig(force = false): ResolvedConfig {
  if (cached && !force) return cached;

  fs.mkdirSync(APP_HOME, { recursive: true });

  let raw: Partial<AppConfig> = {};
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) as Partial<AppConfig>;
    } catch (err) {
      // 配置损坏时备份后重建，避免应用无法启动
      const backup = `${CONFIG_FILE}.broken-${Date.now()}`;
      fs.renameSync(CONFIG_FILE, backup);
      // eslint-disable-next-line no-console
      console.warn(`[epubmaker] config.json 解析失败，已备份到 ${backup}`);
    }
  }

  const merged: AppConfig = { ...DEFAULT_CONFIG, ...raw };
  if (process.env.EPUBMAKER_PORT) merged.port = Number(process.env.EPUBMAKER_PORT);
  if (process.env.EPUBMAKER_HOST) merged.host = process.env.EPUBMAKER_HOST;

  // 首次运行 / 有新增字段时写回，方便用户直接编辑
  const needWrite =
    !fs.existsSync(CONFIG_FILE) ||
    Object.keys(DEFAULT_CONFIG).some((k) => !(k in raw));
  if (needWrite) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2) + '\n', 'utf8');
  }

  const dataDir = resolveDir(merged.dataDir);
  const resolved: ResolvedConfig = {
    ...merged,
    appHome: APP_HOME,
    configFile: CONFIG_FILE,
    paths: {
      data: dataDir,
      exports: resolveDir(merged.exportDir),
      logs: resolveDir(merged.logDir),
      tmp: resolveDir(merged.tmpDir),
      books: path.join(dataDir, 'books'),
      dbFile: path.join(dataDir, 'epubmaker.db')
    }
  };

  for (const dir of Object.values(resolved.paths)) {
    if (dir.endsWith('.db')) continue;
    fs.mkdirSync(dir, { recursive: true });
  }

  cached = resolved;
  return resolved;
}

export function config(): ResolvedConfig {
  return cached ?? loadConfig();
}
