import fs from 'node:fs';
import path from 'node:path';
import { config } from './config';

type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let stream: fs.WriteStream | null = null;
let streamDay = '';

function today(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function getStream(): fs.WriteStream {
  const day = today();
  if (!stream || streamDay !== day) {
    stream?.end();
    const file = path.join(config().paths.logs, `epubmaker-${day}.log`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    stream = fs.createWriteStream(file, { flags: 'a' });
    streamDay = day;
  }
  return stream;
}

function write(level: Level, args: unknown[]) {
  if (ORDER[level] < ORDER[config().logLevel]) return;
  const msg = args
    .map((a) => {
      if (typeof a === 'string') return a;
      if (a instanceof Error) return `${a.message}\n${a.stack ?? ''}`;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(' ');
  const line = `${new Date().toISOString()} [${level.toUpperCase()}] ${msg}`;
  const consoleFn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  consoleFn(line);
  try {
    getStream().write(line + '\n');
  } catch {
    /* 日志写盘失败不影响主流程 */
  }
}

export const logger = {
  debug: (...a: unknown[]) => write('debug', a),
  info: (...a: unknown[]) => write('info', a),
  warn: (...a: unknown[]) => write('warn', a),
  error: (...a: unknown[]) => write('error', a)
};
