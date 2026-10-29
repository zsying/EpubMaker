import { useEffect, useState } from 'react';
import SubHeader from '../components/SubHeader';
import AISettings from '../components/AISettings';
import { useBackClose } from '../backNav';
import { api, type AIPrompt } from '../api';
import { toast, toastError } from '../toast';

/**
 * The LLM page (0.4): everything about the provider and the prompts, pulled
 * out of the settings page where it had outgrown one card.
 *
 * Two cards: the endpoint (address / model / key — BYOK, the key never leaves
 * the device), and the prompt library. The library absorbed the old
 * 对话提示词 card: the seeded 对话 row IS the standing prompt now, alongside
 * the other built-in prompts (查词 / 拆句 / 导读) that the app's own features
 * read. System rows are part of the app — they cannot be deleted, and what
 * they can be is restored: 恢复默认 puts the built-in text back in one tap.
 *
 * The library is a library, not a source of truth: a conversation copies its
 * prompt when it starts, so editing or deleting here never rewrites an
 * existing transcript — it only changes what future chats are offered.
 */

/* ------------------------------ the library ------------------------------- */

// `default` carries the built-in text of a system row from the list answer,
// so the dialog can offer 恢复默认内容 without a second round trip.
type Draft = {
  id: string;
  name: string;
  content: string;
  system: boolean;
  default?: string;
};

const EMPTY_DRAFT: Draft = { id: '', name: '', content: '', system: false };

function PromptLibraryCard() {
  const [items, setItems] = useState<AIPrompt[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // The edit form is a dialog: while it is open, one hardware back closes it
  // instead of leaving the page.
  useBackClose(!!draft, () => setDraft(null));

  useEffect(() => {
    api
      .aiPromptList()
      .then((ps) => setItems(ps ?? []))
      .catch((e) => toastError(e));
  }, []);

  async function save() {
    if (!draft) return;
    setSaving(true);
    try {
      const p = await api.aiPromptSave(draft.id, draft.name, draft.content);
      setItems((prev) => {
        const rest = prev.filter((x) => x.id !== p.id);
        return [p, ...rest];
      });
      setDraft(null);
      toast('提示词已保存', 'success');
    } catch (e) {
      toastError(e);
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: string) {
    try {
      await api.aiPromptDelete(id);
      setItems((prev) => prev.filter((x) => x.id !== id));
      setConfirming(null);
    } catch (e) {
      toastError(e);
    }
  }

  async function reset(id: string) {
    try {
      const p = await api.aiPromptReset(id);
      setItems((prev) => {
        const rest = prev.filter((x) => x.id !== p.id);
        return [p, ...rest];
      });
      setDraft((d) => (d && d.id === id ? { ...d, name: p.name, content: p.content } : d));
      toast('已恢复默认', 'success');
    } catch (e) {
      toastError(e);
    }
  }

  return (
    <div className="card ai-set">
      <div className="section-title">提示词库</div>
      <p className="ai-set-desc">
        开新对话时在这里挑一段开场。标「系统」的是应用内置的提示词——其中「对话」是每个新对话的默认开场，
        「查词 / 拆句 /
        导读」是阅读器里对应功能实际使用的提示词：它们不能删除，可以修改但不建议（改动直接生效），
        改坏了随时恢复默认。对话开始后用的是当时那份拷贝，这里的修改不影响已开始的对话。
      </p>

      {items.length === 0 && !draft && <div className="empty">还没有保存的提示词。</div>}

      {items.map((p) => {
        const drifted = !!p.system && !!p.default && p.content !== p.default;
        return (
          <div className="llm-prompt-row" key={p.id}>
            <div className="llm-prompt-main">
              <b>
                {p.name}
                {p.system && <span className="llm-badge">系统</span>}
              </b>
              <small>{p.content}</small>
            </div>
            <button
              className="btn sm"
              onClick={() =>
                setDraft({
                  id: p.id,
                  name: p.name,
                  content: p.content,
                  system: p.system,
                  default: p.default,
                })
              }
            >
              编辑
            </button>
            {p.system ? (
              <button
                className="btn sm"
                disabled={!drifted}
                title={drifted ? '恢复为应用内置文本' : '未修改过，无需恢复'}
                onClick={() => void reset(p.id)}
              >
                恢复默认
              </button>
            ) : confirming === p.id ? (
              <button className="btn sm danger" onClick={() => void remove(p.id)}>
                确认删除
              </button>
            ) : (
              <button className="btn sm" onClick={() => setConfirming(p.id)}>
                删除
              </button>
            )}
          </div>
        );
      })}

      <div className="ai-set-actions">
        <button className="btn primary" onClick={() => setDraft({ ...EMPTY_DRAFT })}>
          ＋ 新增提示词
        </button>
      </div>

      {draft && (
        <div className="llm-dialog-mask" onClick={() => setDraft(null)}>
          <div className="llm-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="llm-dialog-title">
              {draft.id ? '编辑提示词' : '新增提示词'}
              {draft.system && <span className="llm-badge">系统</span>}
            </div>
            <div className="field">
              <label>名称</label>
              <input
                className="input"
                value={draft.name}
                placeholder="例如：苏格拉底式提问"
                maxLength={40}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </div>
            <div className="field">
              <label>提示词内容</label>
              <textarea
                className="input llm-prompt"
                rows={7}
                value={draft.content}
                onChange={(e) => setDraft({ ...draft, content: e.target.value })}
              />
            </div>
            {draft.system && draft.default != null && draft.content !== draft.default && (
              <button
                className="btn sm llm-dialog-reset"
                onClick={() =>
                  setDraft({ ...draft, name: draft.name, content: draft.default ?? '' })
                }
              >
                恢复默认内容
              </button>
            )}
            <div className="ai-set-actions">
              <button
                className="btn primary"
                disabled={saving || !draft.name.trim() || !draft.content.trim()}
                onClick={() => void save()}
              >
                {saving ? '保存中…' : draft.id ? '保存修改' : '保存'}
              </button>
              <button className="btn" disabled={saving} onClick={() => setDraft(null)}>
                取消
              </button>
            </div>
            {draft.system && (
              <p className="ai-set-note">
                这是系统提示词：改坏了可以随时「恢复默认」；查词 / 拆句 /
                导读的改动会直接进入对应功能。
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default function LLM() {
  return (
    <div className="page llm-page">
      <SubHeader title="LLM 配置" backTo="/settings" />
      <AISettings />
      <PromptLibraryCard />
    </div>
  );
}
