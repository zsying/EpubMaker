import { useEffect, useState } from 'react';
import { api, type AIConfigView, type AIPreset } from '../api';
import { toast } from '../toast';

/**
 * The AI section of the settings page (0.4).
 *
 * BYOK by design: the reader brings a provider (any OpenAI-compatible
 * endpoint), the key is stored on the device in a 0600 sidecar, and it is
 * never sent back to this page — only whether one exists and its last four
 * characters. Everything the app does with it is an explicit reader action
 * inside the book; this page just holds the credentials and proves they
 * work with one tiny call.
 */
export default function AISettings() {
  const [view, setView] = useState<AIConfigView | null>(null);
  const [loadError, setLoadError] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);

  useEffect(() => {
    void load();
  }, []);

  async function load() {
    setLoadError('');
    try {
      const v = await api.aiConfig();
      setView(v);
      setBaseUrl(v.baseUrl);
      setModel(v.model);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  }

  function pickPreset(p: AIPreset) {
    setBaseUrl(p.baseUrl);
    setModel(p.model);
  }

  async function save() {
    setSaving(true);
    try {
      await api.saveAIConfig(baseUrl.trim(), apiKey.trim(), model.trim());
      setApiKey('');
      toast('AI 设置已保存', 'success');
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error', 5000);
    } finally {
      setSaving(false);
    }
  }

  async function testConnection() {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await api.aiTestConnection();
      if (res.ok) {
        setTestResult({ ok: true, msg: `连接成功${res.reply ? `：${res.reply}` : ''}` });
      } else {
        setTestResult({ ok: false, msg: res.error || '连接失败' });
      }
    } catch (e) {
      setTestResult({ ok: false, msg: e instanceof Error ? e.message : String(e) });
    } finally {
      setTesting(false);
    }
  }

  const presets = view?.presets ?? [];
  const matchedPreset = presets.find((p) => p.baseUrl === baseUrl && p.model === model);

  return (
    <div className="card ai-set">
      <div className="section-title">AI 能力</div>
      <p className="ai-set-desc">
        在阅读器里选中单词或句子，即可获得结合上下文的释义、句子拆解和章节导读。 接口兼容 OpenAI
        格式，密钥只保存在本机，每次调用由你主动触发。
      </p>

      {loadError && <div className="ai-set-error">设置读取失败：{loadError}</div>}

      <div className="field">
        <label>接口预设</label>
        <select
          className="select"
          value={matchedPreset ? matchedPreset.baseUrl + '|' + matchedPreset.model : 'custom'}
          onChange={(e) => {
            const p = presets.find((x) => x.baseUrl + '|' + x.model === e.target.value);
            if (p) pickPreset(p);
          }}
        >
          {!matchedPreset && <option value="custom">自定义（当前填写内容）</option>}
          {presets.map((p) => (
            <option key={p.baseUrl + p.model} value={p.baseUrl + '|' + p.model}>
              {p.name}
              {p.note ? ` · ${p.note}` : ''}
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label>接口地址</label>
        <input
          className="input"
          placeholder="https://api.openai.com/v1"
          value={baseUrl}
          autoComplete="off"
          onChange={(e) => setBaseUrl(e.target.value)}
        />
      </div>

      <div className="field">
        <label>模型名称</label>
        <input
          className="input"
          placeholder="gpt-4o-mini"
          value={model}
          autoComplete="off"
          onChange={(e) => setModel(e.target.value)}
        />
      </div>

      <div className="field">
        <label>
          API 密钥{view?.keySet ? `（已保存 ${view.keyHint}，留空则不修改）` : '（可选）'}
        </label>
        <div className="ai-key-wrap">
          <input
            className="input"
            type={showKey ? 'text' : 'password'}
            placeholder={view?.keySet ? '已保存，留空表示不修改' : '本地服务（如 Ollama）可留空'}
            value={apiKey}
            autoComplete="off"
            onChange={(e) => setApiKey(e.target.value)}
          />
          <button
            type="button"
            className="btn sm ghost ai-key-toggle"
            onClick={() => setShowKey((v) => !v)}
          >
            {showKey ? '隐藏' : '显示'}
          </button>
        </div>
      </div>

      <div className="ai-set-actions">
        <button className="btn primary" disabled={saving} onClick={() => void save()}>
          {saving ? '保存中…' : '保存'}
        </button>
        <button className="btn" disabled={testing} onClick={() => void testConnection()}>
          {testing ? '测试中…' : '测试连接'}
        </button>
      </div>

      {testResult && (
        <div className={`ai-set-test${testResult.ok ? ' ok' : ' fail'}`}>{testResult.msg}</div>
      )}

      <p className="ai-set-note">
        测试连接会向服务商发送一条「连接正常」的验证消息；阅读器内的每次 AI
        调用同样会把你选中的单词、句子或当前章节原文发送给服务商，这是使用该功能的必要前提。
      </p>
    </div>
  );
}
