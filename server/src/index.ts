import express from 'express';
import cors from 'cors';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config';
import { logger } from './logger';
import { db } from './db';
import { createRouter } from './routes';

function main() {
  const cfg = loadConfig();
  db(); // 初始化并建表

  const app = express();
  app.use(cors());
  app.use('/api', createRouter());

  // 生产模式：托管前端构建产物
  const webDist = path.resolve(__dirname, '../../web/dist');
  if (fs.existsSync(path.join(webDist, 'index.html'))) {
    app.use(express.static(webDist));
    app.use((req, res, next) => {
      if (req.method !== 'GET' || req.path.startsWith('/api')) return next();
      res.sendFile(path.join(webDist, 'index.html'));
    });
    logger.info(`前端静态资源: ${webDist}`);
  } else {
    app.get('/', (_req, res) => {
      res.type('html').send(
        '<h1>EpubMaker API</h1><p>前端尚未构建。开发模式请运行 <code>npm run dev</code>，或先执行 <code>npm run build</code>。</p>'
      );
    });
  }

  app.listen(cfg.port, cfg.host, () => {
    logger.info('──────────────────────────────────────────');
    logger.info(`EpubMaker 服务已启动: http://${cfg.host}:${cfg.port}`);
    logger.info(`应用目录: ${cfg.appHome}`);
    logger.info(`配置文件: ${cfg.configFile}`);
    logger.info(`数据目录: ${cfg.paths.data}`);
    logger.info(`导出目录: ${cfg.paths.exports}`);
    logger.info(`日志目录: ${cfg.paths.logs}`);
    logger.info('──────────────────────────────────────────');
  });
}

process.on('unhandledRejection', (err) => logger.error('未处理的 Promise 拒绝:', err as Error));
process.on('uncaughtException', (err) => logger.error('未捕获异常:', err));

main();
