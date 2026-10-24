import { useEffect, useState } from 'react';
import { api, AppPaths } from '../api';
import SubHeader from '../components/SubHeader';

/**
 * 关于 page: app identity + the system paths block that used to sit at the
 * bottom of the shelf. The shelf stays clean; everything low-frequency that
 * describes the install itself lives here, reachable from the「我的」tab.
 */
export default function About() {
  const [version, setVersion] = useState<string | null>(null);
  const [buildTime, setBuildTime] = useState('');
  const [paths, setPaths] = useState<AppPaths | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .appVersion()
      .then((v) => {
        if (alive) setVersion(v);
      })
      .catch(() => undefined);
    api
      .buildTime()
      .then((sec) => {
        // The backend hands over raw unix seconds (Go's time.Local is
        // unreliable inside the Android c-shared runtime), so the device's
        // timezone does the formatting here.
        const n = Number(sec);
        if (alive && n > 0) {
          setBuildTime(
            new Date(n * 1000).toLocaleString('zh-CN', {
              year: 'numeric',
              month: '2-digit',
              day: '2-digit',
              hour: '2-digit',
              minute: '2-digit',
              hour12: false,
            }),
          );
        }
      })
      .catch(() => undefined);
    api
      .paths()
      .then((p) => {
        if (alive) setPaths(p);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="page about-page">
      <SubHeader title="关于" />

      <div className="about-hero">
        <span className="about-mark" aria-hidden="true">
          E
        </span>
        <div className="about-name">EpubMaker</div>
        <div className="about-version">
          {version ? `版本 ${version}` : ''}
          {buildTime ? ` · 编译于 ${buildTime}` : ''}
        </div>
        <p className="about-desc">本地 EPUB 阅读与整理工具</p>
      </div>

      {paths && (
        <div className="about-card">
          <div className="about-card-title">系统信息</div>
          <div className="about-row">
            <span className="about-key">配置文件</span>
            <span className="about-val">{paths.configFile}</span>
          </div>
          <div className="about-row">
            <span className="about-key">数据目录</span>
            <span className="about-val">{paths.dataDir}</span>
          </div>
          <div className="about-row">
            <span className="about-key">导出目录</span>
            <span className="about-val">{paths.exportDir}</span>
          </div>
          <div className="about-row">
            <span className="about-key">日志目录</span>
            <span className="about-val">{paths.logDir}</span>
          </div>
          <div className="about-hint">桌面版可在 config.json 中修改存储位置。</div>
        </div>
      )}

      <div className="about-foot">
        开源地址：
        <a href="https://github.com/zsying/EpubMaker" target="_blank" rel="noreferrer">
          github.com/zsying/EpubMaker
        </a>
      </div>
    </div>
  );
}
