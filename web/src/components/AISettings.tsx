import { useEffect, useState } from 'react';
import { api, type AIConfigView, type AIPreset, type AIProfileView } from '../api';
import { useBackClose } from '../backNav';
import { toast, toastError } from '../toast';

/**
 * The AI section of the settings page: the provider profiles and which one is
 * in force (ADR-50).
 *
 * BYOK by design: the reader brings a provider (any OpenAI-compatible
 * endpoint), the key is stored on the device in a 0600 sidecar, and it is
 * never sent back to this page — only whether one exists and its last four
 * characters. Everything the app does with it is an explicit reader action
 * inside the book; this page holds the credentials and proves they work with
 * one tiny call.
 *
 * A list rather than a form because a reader who has two providers was, until
 * now, re-typing three fields to move between them. Switching is the row tap
 * and nothing else: one call, no dialog, no save — the mark moves and the next
 * request uses the other provider. Editing is where a profile's four fields
 * live, so adding, renaming and deleting all happen in one place instead of
 * scattering verbs across the rows.
 */

type Draft = {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  /** Always starts blank: the stored key is never sent here. */
  apiKey: string;
  keyHint: string;
  keySet: boolean;
};

function draftOf(p: AIProfileView): Draft {
  return {
    id: p.id,
    name: p.name,
    baseUrl: p.baseUrl,
    model: p.model,
    apiKey: '',
    keyHint: p.keyHint,
    keySet: p.keySet,
  };
}

const BLANK: Draft = {
  id: '',
  name: '',
  baseUrl: '',
  model: '',
  apiKey: '',
  keyHint: '',
  keySet: false,
};

/** Just the host, for the second line of a row: the full URL does not fit a
 *  phone, and the path ("/v1", "/api/paas/v4") is the least identifying part.
 *  The port goes too — it says which instance on that host, not which provider,
 *  and it is the widest thing at the end of a line that is already 3px too long
 *  on the narrowest phone we ship on. The full address is one tap away in the
 *  form. */
function hostOf(baseUrl: string): string {
  return baseUrl.replace(/^https?:\/\//, '').replace(/[:/].*$/, '') || baseUrl;
}

export default function AISettings() {
  const [view, setView] = useState<AIConfigView | null>(null);
  const [loadError, setLoadError] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [formError, setFormError] = useState('');
  const [confirming, setConfirming] = useState(false);

  // The edit form is a dialog: while it is open, one hardware back closes it
  // instead of leaving the page.
  useBackClose(!!draft, () => close());

  useEffect(() => {
    void load();
  }, []);

  async function load() {
    setLoadError('');
    try {
      setView(await api.aiConfig());
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  }

  function openEdit(p?: AIProfileView) {
    setDraft(p ? draftOf(p) : { ...BLANK });
    setShowKey(false);
    setTestResult(null);
    setFormError('');
    setConfirming(false);
  }

  function close() {
    setDraft(null);
    setTestResult(null);
    setFormError('');
    setConfirming(false);
  }

  const profiles = view?.profiles ?? [];

  async function switchTo(p: AIProfileView) {
    if (p.id === view?.activeId) return;
    try {
      await api.aiActivateProfile(p.id);
      await load();
      toast(`已切换到「${p.name}」`, 'success');
    } catch (e) {
      toastError(e);
    }
  }

  function pickPreset(preset: AIPreset | undefined) {
    if (!draft || !preset) return;
    setDraft({ ...draft, baseUrl: preset.baseUrl, model: preset.model });
    setTestResult(null);
  }

  async function test() {
    if (!draft) return;
    setTesting(true);
    setTestResult(null);
    try {
      const res = await api.aiTestProfile(
        draft.id,
        draft.baseUrl.trim(),
        draft.apiKey.trim(),
        draft.model.trim(),
      );
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

  async function save() {
    if (!draft) return;
    setSaving(true);
    setFormError('');
    try {
      await api.aiSaveProfile(
        draft.id,
        draft.name.trim(),
        draft.baseUrl.trim(),
        draft.apiKey.trim(),
        draft.model.trim(),
      );
      await load();
      close();
      toast(draft.id ? '已保存' : '已添加配置', 'success');
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!draft) return;
    setSaving(true);
    try {
      await api.aiDeleteProfile(draft.id);
      await load();
      close();
      toast('已删除', 'success');
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  const ready =
    !!draft &&
    /^https?:\/\//.test(draft.baseUrl.trim()) &&
    draft.model.trim().length > 0 &&
    !saving;

  const presets = view?.presets ?? [];
  const matchedPreset = draft
    ? presets.find((p) => p.baseUrl === draft.baseUrl && p.model === draft.model)
    : undefined;

  return (
    <div className="card ai-set">
      <div className="section-title">接口</div>
      <p className="ai-set-desc">
        在阅读器里选中单词或句子，即可获得结合上下文的释义、句子拆解和章节导读。 接口兼容 OpenAI
        格式，可以存多组配置——查词用便宜快的那家，导读换更准的那家——点一下就能换。
        密钥只保存在本机，每次调用由你主动触发。
      </p>

      {loadError && <div className="ai-set-error">设置读取失败：{loadError}</div>}

      {profiles.length === 0 && !loadError && (
        <div className="empty">还没有接口配置。添加一组之后，阅读器里的 AI 功能才能用。</div>
      )}

      {profiles.map((p) => {
        const on = p.id === view?.activeId;
        return (
          <div className={`ai-prof-row${on ? ' on' : ''}`} key={p.id}>
            <button
              className="ai-prof-pick"
              aria-pressed={on}
              aria-label={on ? `当前使用 ${p.name}` : `切换到 ${p.name}`}
              onClick={() => void switchTo(p)}
            >
              <span className="ai-prof-dot" aria-hidden="true" />
              <span className="ai-prof-main">
                <b>
                  {p.name}
                  {on && <span className="ai-prof-on">使用中</span>}
                </b>
                <small>
                  {p.model}
                  {p.keySet ? '' : ' · 无密钥'}
                  {` · ${hostOf(p.baseUrl)}`}
                </small>
              </span>
            </button>
            <button className="btn sm" aria-label={`编辑 ${p.name}`} onClick={() => openEdit(p)}>
              编辑
            </button>
          </div>
        );
      })}

      <div className="ai-set-actions">
        <button className="btn primary" onClick={() => openEdit()}>
          ＋ 新增配置
        </button>
      </div>

      <p className="ai-set-note">
        测试连接会向服务商发送一条「连接正常」的验证消息；阅读器内的每次 AI
        调用同样会把你选中的单词、句子或当前章节原文发送给服务商，这是使用该功能的必要前提。
      </p>

      {draft && (
        <div className="llm-dialog-mask" onClick={close}>
          <div
            className="llm-dialog"
            role="dialog"
            aria-label={draft.id ? '编辑接口' : '新增接口'}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="llm-dialog-title">{draft.id ? '编辑接口' : '新增接口'}</div>

            <div className="field">
              <label>接口预设</label>
              <select
                className="select"
                value={matchedPreset ? matchedPreset.baseUrl + '|' + matchedPreset.model : 'custom'}
                onChange={(e) =>
                  pickPreset(presets.find((x) => x.baseUrl + '|' + x.model === e.target.value))
                }
              >
                {!matchedPreset && <option value="custom">自定义（按下填写）</option>}
                {presets.map((p) => (
                  <option key={p.baseUrl + p.model} value={p.baseUrl + '|' + p.model}>
                    {p.name}
                    {p.note ? ` · ${p.note}` : ''}
                  </option>
                ))}
              </select>
            </div>

            <div className="field">
              <label>名称</label>
              <input
                className="input"
                value={draft.name}
                maxLength={24}
                placeholder="留空则用服务商名称"
                autoComplete="off"
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </div>

            <div className="field">
              <label>接口地址</label>
              <input
                className="input"
                placeholder="https://api.openai.com/v1"
                value={draft.baseUrl}
                autoComplete="off"
                onChange={(e) => {
                  setDraft({ ...draft, baseUrl: e.target.value });
                  setTestResult(null);
                }}
              />
            </div>

            <div className="field">
              <label>模型名称</label>
              <input
                className="input"
                placeholder="gpt-4o-mini"
                value={draft.model}
                autoComplete="off"
                onChange={(e) => {
                  setDraft({ ...draft, model: e.target.value });
                  setTestResult(null);
                }}
              />
            </div>

            <div className="field">
              <label>
                API 密钥
                {draft.keySet ? `（已保存 ${draft.keyHint}，留空则不修改）` : '（可选）'}
              </label>
              <div className="ai-key-wrap">
                <input
                  className="input"
                  type={showKey ? 'text' : 'password'}
                  placeholder={
                    draft.keySet ? '已保存，留空表示不修改' : '本地服务（如 Ollama）可留空'
                  }
                  value={draft.apiKey}
                  autoComplete="off"
                  onChange={(e) => {
                    setDraft({ ...draft, apiKey: e.target.value });
                    setTestResult(null);
                  }}
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

            <button className="btn sm ai-prof-test" disabled={testing} onClick={() => void test()}>
              {testing ? '测试中…' : '测试连接'}
            </button>

            {testResult && (
              <div className={`ai-set-test${testResult.ok ? ' ok' : ' fail'}`}>
                {testResult.msg}
              </div>
            )}
            {formError && <div className="ai-set-error">{formError}</div>}

            <div className="ai-set-actions">
              <button className="btn primary" disabled={!ready} onClick={() => void save()}>
                {saving ? '保存中…' : draft.id ? '保存修改' : '保存'}
              </button>
              <button className="btn" disabled={saving} onClick={close}>
                取消
              </button>
            </div>

            {draft.id &&
              (confirming ? (
                <div className="ai-set-actions">
                  <button className="btn danger" disabled={saving} onClick={() => void remove()}>
                    确认删除
                  </button>
                  <button className="btn" disabled={saving} onClick={() => setConfirming(false)}>
                    算了
                  </button>
                </div>
              ) : (
                <button className="btn sm ghost ai-prof-del" onClick={() => setConfirming(true)}>
                  删除这组配置
                </button>
              ))}
          </div>
        </div>
      )}
    </div>
  );
}
