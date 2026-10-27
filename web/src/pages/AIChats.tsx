import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, AIConversationDetail, AIConversationItem, AIMessage } from '../api';
import { toastError } from '../toast';
import SubHeader from '../components/SubHeader';

/**
 * The AI page: every grounded answer (查词 / 拆句 / 导读) is a conversation,
 * and this is where the transcripts live. A row opens the transcript; the
 * reader can keep talking in any of them, or start a fresh chat by hand.
 *
 * The system prompt is part of the transcript and shown as one: it is what
 * actually went to the provider, and hiding it would make the page a summary
 * of the conversation rather than the conversation.
 *
 * Routes: `/ai` is the list (a top-level tab); `/ai/:id` is one transcript,
 * with the reserved id `new` for a chat that starts from one message. `new`
 * replaces itself with the real conversation after the first answer, so a
 * back press from an established chat always lands on the list.
 */

const ORIGIN_LABEL: Record<string, string> = {
  lookup: '查词',
  parse: '拆句',
  summarize: '导读',
  manual: '对话',
};

function stamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/* --------------------------------- list ---------------------------------- */

function ChatList() {
  const nav = useNavigate();
  const [items, setItems] = useState<AIConversationItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    api
      .aiConversations()
      .then((list) => {
        if (alive) setItems(list ?? []);
      })
      .catch((e) => toastError(e))
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  async function remove(id: string) {
    try {
      await api.aiConversationDelete(id);
      setItems((prev) => prev.filter((c) => c.id !== id));
    } catch (e) {
      toastError(e);
    }
  }

  return (
    <div className="page">
      <SubHeader title="AI 对话" tag={`${items.length} 条`}>
        <button className="btn sm primary" onClick={() => nav('/ai/new')}>
          新对话
        </button>
      </SubHeader>

      {loading ? (
        <div className="loading">加载中…</div>
      ) : items.length === 0 ? (
        <div className="empty">
          还没有对话。阅读时点词卡或选区工具条上的 ✦ AI，或点右上角「新对话」直接提问。
        </div>
      ) : (
        <div className="note-list">
          {items.map((c) => (
            <div className="note-card" key={c.id}>
              <button className="note-card-main" onClick={() => nav(`/ai/${c.id}`)}>
                <div className="ai-row-head">
                  <span className={`ai-origin ai-origin-${c.origin}`}>
                    {ORIGIN_LABEL[c.origin] ?? '对话'}
                  </span>
                  <span className="note-card-title">{c.title}</span>
                </div>
                {c.preview && <div className="ai-row-preview">{c.preview}</div>}
                <div className="note-card-meta">
                  {stamp(c.updatedAt)} · {c.count} 条
                </div>
              </button>
              <button className="btn sm danger" onClick={() => void remove(c.id)}>
                删
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* -------------------------------- detail --------------------------------- */

function MessageBubble({ m }: { m: AIMessage }) {
  if (m.role === 'system') {
    // The prompt that shaped every answer. Collapsed by default — it is
    // boilerplate until you need to check it — but present in the transcript,
    // not behind a separate "detail mode".
    return (
      <details className="ai-msg-system">
        <summary>系统提示词</summary>
        <pre>{m.content}</pre>
      </details>
    );
  }
  return (
    <div className={`ai-msg ai-msg-${m.role}`}>
      <div className="ai-msg-body">{m.content}</div>
    </div>
  );
}

function ChatRoom({ id }: { id: string }) {
  const nav = useNavigate();
  const isNew = id === 'new';
  const [conv, setConv] = useState<AIConversationDetail | null>(null);
  const [loading, setLoading] = useState(!isNew);
  const [missing, setMissing] = useState(false);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const endRef = useRef<HTMLDivElement>(null);
  // The live conversation id: `new` until the first answer creates one.
  const liveId = conv?.id ?? (isNew ? '' : id);

  useEffect(() => {
    if (isNew) return;
    let alive = true;
    api
      .aiConversation(id)
      .then((c) => {
        if (!alive) return;
        if (!c) setMissing(true);
        else setConv(c);
      })
      .catch((e) => toastError(e))
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [id, isNew]);

  // Keep the latest turn on screen: a transcript grows from the bottom.
  const msgs = conv?.messages ?? [];
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [msgs.length, sending]);

  async function send() {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setError('');
    try {
      const turn = await api.aiChatSend(liveId, text);
      setDraft('');
      setConv((prev) => {
        const base: AIConversationDetail = prev ?? {
          id: turn.conversationId,
          title: text,
          origin: 'manual',
          createdAt: turn.user.createdAt,
          updatedAt: turn.assistant.createdAt,
          messages: [],
        };
        return { ...base, messages: [...base.messages, turn.user, turn.assistant] };
      });
      // A `new` chat that just became real: put the real id in the URL so
      // refreshes and back presses behave like any other conversation.
      if (isNew) nav(`/ai/${turn.conversationId}`, { replace: true });
    } catch (e) {
      // The user message was rolled back server-side, so "not sent" is the
      // truth; the draft stays in the box for a one-tap retry.
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  }

  if (missing) {
    return (
      <div className="page">
        <SubHeader title="AI 对话" backTo="/ai" />
        <div className="empty">这段对话已被删除。</div>
      </div>
    );
  }

  const title = isNew ? '新对话' : (conv?.title ?? 'AI 对话');
  return (
    <div className="page ai-room">
      <SubHeader title={title} backTo="/ai" />

      {loading ? (
        <div className="loading">加载中…</div>
      ) : (
        <div className="ai-transcript">
          {msgs.length === 0 && (
            <div className="empty">
              直接提问就好：词汇、语法、句子理解，或者任何和阅读有关的问题。
            </div>
          )}
          {msgs.map((m) => (
            <MessageBubble key={m.id} m={m} />
          ))}
          {sending && (
            <div className="ai-msg ai-msg-assistant">
              <div className="ai-msg-body ai-msg-pending">AI 思考中…</div>
            </div>
          )}
          {error && (
            <div className="ai-send-error">
              <p>{error}</p>
              <button className="btn sm" onClick={() => void send()}>
                重试
              </button>
            </div>
          )}
          <div ref={endRef} />
        </div>
      )}

      <div className="ai-composer">
        <textarea
          value={draft}
          rows={1}
          placeholder="问问词汇、语法、阅读理解…"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // Desktop habit: Enter sends, Shift+Enter breaks a line. On a
            // phone the keyboard's own send key and the button do the job.
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <button
          className="btn primary"
          disabled={sending || !draft.trim()}
          onClick={() => void send()}
        >
          发送
        </button>
      </div>
    </div>
  );
}

export default function AIChats() {
  const { id } = useParams<{ id?: string }>();
  return id ? <ChatRoom id={id} /> : <ChatList />;
}
