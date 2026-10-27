import { useEffect, useState } from 'react';
import SubHeader from '../components/SubHeader';
import AISettings from '../components/AISettings';
import { api, type AIConfigView, type AIPrompt } from '../api';
import { toast, toastError } from '../toast';

/**
 * The LLM page (0.4): everything about the provider and the prompts, pulled
 * out of the settings page where it had outgrown one card.
 *
 * Three cards, top to bottom in the order a first-time reader needs them:
 * the endpoint (address / model / key — BYOK, the key never leaves the
 * device), the standing prompt every hand-made conversation opens with
 * (configurable, restorable to the built-in default), and the prompt library
 * the new-chat picker draws from.
 *
 * The library is a library, not a source of truth: a conversation copies its
 * prompt when it starts, so editing or deleting here never rewrites an
 * existing transcript — it only changes what future chats are offered.
 */

/* ------------------------- the standing chat prompt ------------------------ */

function ChatPromptCard() {
  const [view, setView] = useState<AIConfigView | null>(null);
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api
      .aiConfig()
      .then((v) => {
        setView(v);
        // Older stored files (and older mocks) have no chatSystem at all;
        // the field must stay a string or the .trim()s below crash.
        setText(v.chatSystem ?? '');
      })
      .catch((e) => toastError(e));
  }, []);

  async function save(next: string) {
    setSaving(true);
    try {
      await api.aiSaveChatSystem(next);
      setText(next);
      toast(next.trim() ? '对话提示词已保存' : '已恢复默认提示词', 'success');
    } catch (e) {
      toastError(e);
    } finally {
      setSaving(false);
    }
  }

  const customized = text.trim() !== '';
  const disabled = !!view && !view.configured;

  return (
    <div className="card ai-set">
      <div className="section-title">对话提示词</div>
      <p className="ai-set-desc">
        自建的新对话都以这段提示词开场（可在发消息前从提示词库里临时换用别的）。已有的对话不受影响——它们保存的是开场时的那份。
      </p>
      {disabled && <div className="ai-set-note">先在上方填好接口地址和模型，才能保存提示词。</div>}
      <textarea
        className="input llm-prompt"
        rows={5}
        value={text}
        placeholder={view ? `${view.chatSystemDefault}\n（留空即使用默认提示词）` : ''}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="ai-set-actions">
        <button
          className="btn primary"
          disabled={saving || disabled || text === (view?.chatSystem ?? '')}
          onClick={() => void save(text)}
        >
          {saving ? '保存中…' : '保存'}
        </button>
        <button
          className="btn"
          disabled={saving || disabled || !customized}
          onClick={() => void save('')}
        >
          恢复默认
        </button>
        <span className="llm-prompt-state">
          {customized ? `自定义 · ${text.trim().length} 字` : '使用默认提示词'}
        </span>
      </div>
    </div>
  );
}

/* ------------------------------ the library ------------------------------- */

type Draft = { id: string; name: string; content: string };

const EMPTY_DRAFT: Draft = { id: '', name: '', content: '' };

function PromptLibraryCard() {
  const [items, setItems] = useState<AIPrompt[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

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

  return (
    <div className="card ai-set">
      <div className="section-title">提示词库</div>
      <p className="ai-set-desc">
        按用途保存几段提示词，开新对话时挑一个用。对话开始后用的是当时那份拷贝，这里的修改不影响已开始的对话。
      </p>

      {items.length === 0 && !draft && <div className="empty">还没有保存的提示词。</div>}

      {items.map((p) => (
        <div className="llm-prompt-row" key={p.id}>
          <div className="llm-prompt-main">
            <b>{p.name}</b>
            <small>{p.content}</small>
          </div>
          <button
            className="btn sm"
            onClick={() => setDraft({ id: p.id, name: p.name, content: p.content })}
          >
            编辑
          </button>
          {confirming === p.id ? (
            <button className="btn sm danger" onClick={() => void remove(p.id)}>
              确认删除
            </button>
          ) : (
            <button className="btn sm" onClick={() => setConfirming(p.id)}>
              删除
            </button>
          )}
        </div>
      ))}

      {draft ? (
        <div className="llm-prompt-form">
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
              rows={5}
              value={draft.content}
              onChange={(e) => setDraft({ ...draft, content: e.target.value })}
            />
          </div>
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
        </div>
      ) : (
        <div className="ai-set-actions">
          <button className="btn primary" onClick={() => setDraft({ ...EMPTY_DRAFT })}>
            ＋ 新增提示词
          </button>
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
      <ChatPromptCard />
      <PromptLibraryCard />
    </div>
  );
}
