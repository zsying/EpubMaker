import {
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
} from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, AIConversationDetail, AIConversationItem, AIMessage, AIPrompt } from '../api';
import { toastError } from '../toast';
import SubHeader from '../components/SubHeader';
import AIMessageBody from '../components/AIMessageBody';

/**
 * The AI page: every grounded answer (查词 / 拆句 / 导读) is a conversation,
 * and this is where the transcripts live. A row opens the transcript; the
 * reader can keep talking in any of them, or start a fresh chat by hand.
 *
 * The system prompt is part of the transcript and shown as one: it is what
 * actually went to the provider, and hiding it would make the page a summary
 * of the conversation rather than the conversation.
 *
 * Routes: `/ai` is the list (a top-level tab — no back chevron, its siblings
 * are the other tabs); `/ai/:id` is one transcript, with the reserved id `new`
 * for a chat that starts from one message. `new` replaces itself with the real
 * conversation after the first answer, so a back press from an established
 * chat always lands on the list.
 */

const ORIGIN_LABEL: Record<string, string> = {
  lookup: '查词',
  parse: '拆句',
  summarize: '导读',
  manual: '对话',
};

/** Rows per request. The list grows on scroll; it never asks for everything. */
const PAGE = 30;

/** How far a row slides to expose its delete action. */
const REMOVE_W = 76;

function stamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/* --------------------------------- list ---------------------------------- */

/**
 * A row that slides left to reveal 删除.
 *
 * The button is not in the row any more: one red button per conversation made
 * a reading list look like a database admin screen, and on a phone it sat
 * exactly where the thumb lands. A horizontal drag is the standard gesture for
 * this, and it is the only one that costs nothing when you are just scrolling —
 * so the gesture decides its own axis first (6px), and a vertical swipe is
 * handed straight back to the list.
 */
function SwipeRow({
  open,
  onOpen,
  onDelete,
  children,
}: {
  open: boolean;
  onOpen: (open: boolean) => void;
  onDelete: () => void;
  children: ReactNode;
}) {
  const [drag, setDrag] = useState<number | null>(null);
  const from = useRef<{ x: number; y: number; base: number } | null>(null);
  const axis = useRef<'' | 'x' | 'y'>('');
  // When the last horizontal drag ended. A mouse drag is followed by a click
  // on whatever was under it; a finger's is not. A short window covers both
  // without eating the reader's next deliberate tap (which is what a plain
  // "ignore the next click" flag did on a phone).
  const draggedAt = useRef(0);
  const shiftRef = useRef(0);
  const base = open ? -REMOVE_W : 0;
  const shift = drag ?? base;

  function down(e: PointerEvent<HTMLDivElement>) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    from.current = { x: e.clientX, y: e.clientY, base };
    axis.current = '';
    shiftRef.current = base;
  }

  function move(e: PointerEvent<HTMLDivElement>) {
    const f = from.current;
    if (!f) return;
    const dx = e.clientX - f.x;
    const dy = e.clientY - f.y;
    if (!axis.current) {
      if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
      axis.current = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
      if (axis.current === 'y') {
        from.current = null;
        return;
      }
      e.currentTarget.setPointerCapture?.(e.pointerId);
    }
    if (axis.current !== 'x') return;
    const next = Math.max(-REMOVE_W - 16, Math.min(0, f.base + dx));
    shiftRef.current = next;
    setDrag(next);
  }

  function up() {
    from.current = null;
    if (axis.current === 'x') {
      draggedAt.current = Date.now();
      onOpen(shiftRef.current < -REMOVE_W / 2);
    }
    axis.current = '';
    setDrag(null);
  }

  function guardClick(e: MouseEvent<HTMLDivElement>) {
    // A drag ends with a click on whatever was under the finger; opening a
    // conversation there would be the opposite of what was asked. And while
    // the row is open, a tap on it means "put it back".
    if (Date.now() - draggedAt.current < 300) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (open) {
      e.preventDefault();
      e.stopPropagation();
      onOpen(false);
    }
  }

  return (
    <div className={`ai-swipe${open || drag !== null ? ' open' : ''}`}>
      <button className="ai-swipe-del" onClick={onDelete} aria-label="删除对话">
        删除
      </button>
      <div
        className="ai-swipe-body"
        style={{
          transform: `translateX(${shift}px)`,
          transition: drag === null ? 'transform .18s ease' : 'none',
        }}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        onClickCapture={guardClick}
      >
        {children}
      </div>
    </div>
  );
}

function ChatList() {
  const nav = useNavigate();
  const [items, setItems] = useState<AIConversationItem[]>([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const sentinel = useRef<HTMLDivElement | null>(null);
  // The page cursor is "how many rows I already hold", read inside the scroll
  // observer — which is created once, so it cannot close over the latest state.
  const held = useRef(0);
  held.current = items.length;
  const busy = useRef(false);
  const more = useRef<() => void>(() => {});

  useEffect(() => {
    let alive = true;
    api
      .aiConversations(0, PAGE)
      .then((p) => {
        if (!alive) return;
        setItems(p.items);
        setTotal(p.total);
        setHasMore(p.hasMore);
      })
      .catch((e) => toastError(e))
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  async function loadMore() {
    if (busy.current || !hasMore) return;
    busy.current = true;
    setLoadingMore(true);
    try {
      const page = await api.aiConversations(held.current, PAGE);
      // A page boundary moves when a new lookup lands while the list is open,
      // so the offset alone is not a promise: dedupe by id.
      setItems((prev) => {
        const seen = new Set(prev.map((c) => c.id));
        return [...prev, ...page.items.filter((c) => !seen.has(c.id))];
      });
      setTotal(page.total);
      setHasMore(page.hasMore);
    } catch (e) {
      toastError(e);
    } finally {
      busy.current = false;
      setLoadingMore(false);
    }
  }
  more.current = () => void loadMore();

  // Grow on scroll. The button below is the same action for a browser without
  // IntersectionObserver — an old WebView, or a keyboard user tabbing through.
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasMore || loading || typeof IntersectionObserver !== 'function') return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) more.current();
      },
      { rootMargin: '240px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, loading, items.length]);

  async function remove(id: string) {
    setOpenId(null);
    try {
      await api.aiConversationDelete(id);
      setItems((prev) => prev.filter((c) => c.id !== id));
      setTotal((t) => Math.max(0, t - 1));
    } catch (e) {
      toastError(e);
    }
  }

  return (
    <div className="page">
      <SubHeader title="AI 对话" tag={total > 0 ? `${total} 条` : undefined} back={false}>
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
        <>
          <div className="note-list">
            {items.map((c) => (
              <SwipeRow
                key={c.id}
                open={openId === c.id}
                onOpen={(open) => setOpenId(open ? c.id : null)}
                onDelete={() => void remove(c.id)}
              >
                <div className="note-card">
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
                </div>
              </SwipeRow>
            ))}
          </div>
          <div className="ai-more" ref={sentinel}>
            {hasMore ? (
              <button className="btn sm" disabled={loadingMore} onClick={() => void loadMore()}>
                {loadingMore ? '加载中…' : '加载更多'}
              </button>
            ) : (
              <span className="ai-more-end">共 {total} 条</span>
            )}
          </div>
        </>
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
      <div className="ai-msg-body">
        <AIMessageBody text={m.content} />
      </div>
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
  // The prompt a brand-new conversation opens with, picked before the first
  // message. The seeded 对话 row (sys-chat) is the standing prompt the LLM
  // page maintains; '' falls back to it server-side. The choice only matters
  // while the conversation is still unnamed: once the first answer lands, the
  // transcript stores the prompt it was born with, and choosing is over.
  const [prompts, setPrompts] = useState<AIPrompt[]>([]);
  const [promptId, setPromptId] = useState('');
  // Step 1 of a new chat is the prompt chooser: a list of titles with the
  // selected prompt's text shown underneath, and 开始对话 to confirm. Only a
  // chat that has not started can choose — after that the transcript owns
  // its prompt.
  const [choosing, setChoosing] = useState(isNew);
  const transcript = useRef<HTMLDivElement | null>(null);
  // The live conversation id: `new` until the first answer creates one.
  const liveId = conv?.id ?? (isNew ? '' : id);

  useEffect(() => {
    if (!isNew) return;
    api
      .aiPromptList()
      .then((ps) => {
        const rows = ps ?? [];
        setPrompts(rows);
        // Preselect the standing prompt (the seeded 对话 row) so 开始对话 is
        // always one tap away; '' covers a list that came back empty.
        const standing = rows.find((p) => p.id === 'sys-chat') ?? rows[0];
        if (standing) setPromptId(standing.id);
      })
      .catch(() => setPrompts([]));
  }, [isNew]);

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

  // Keep the latest turn on screen: a transcript grows from the bottom. The
  // scroll box is the transcript itself (the composer is pinned), so scrolling
  // it directly beats scrollIntoView, which also drags the page container.
  const msgs = conv?.messages ?? [];
  useEffect(() => {
    const el = transcript.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [msgs.length, sending]);

  async function send() {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setError('');
    try {
      const turn = await api.aiChatSend(liveId, text, promptId);
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
        const msgs = [...base.messages];
        // A conversation this send created carries its opening prompt back —
        // the one the picker chose — so the room shows what the answers are
        // shaped by instead of keeping it for the next visit.
        if (turn.system) msgs.push(turn.system);
        msgs.push(turn.user, turn.assistant);
        return { ...base, messages: msgs };
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
  const picked = prompts.find((p) => p.id === promptId) ?? null;
  return (
    <div className="page ai-room">
      <SubHeader title={title} backTo="/ai" />

      {choosing && isNew ? (
        /* Step 1 of a new chat: choose the opening prompt. Titles on top,
           the selected prompt's full text underneath, 开始对话 to commit.
           The old dropdown mixed the choice into the composer and hid the
           text entirely — a prompt is the whole point, so it gets shown. */
        <div className="ai-choose">
          <p className="ai-choose-hint">选一个提示词开场；进入对话后随时可以直接提问。</p>
          <div className="ai-choose-list" role="radiogroup" aria-label="提示词">
            {prompts.map((p) => (
              <button
                key={p.id}
                type="button"
                role="radio"
                aria-checked={promptId === p.id}
                className={`ai-choose-row${promptId === p.id ? ' on' : ''}`}
                onClick={() => setPromptId(p.id)}
              >
                <span className="ai-choose-name">{p.name}</span>
                {p.system && <span className="ai-choose-badge">系统</span>}
              </button>
            ))}
            {prompts.length === 0 && <div className="empty">提示词库是空的，直接开始就好。</div>}
          </div>
          <div className="ai-choose-preview" aria-live="polite">
            {picked ? picked.content : '未选择提示词：将跟随 LLM 配置的默认开场。'}
          </div>
          <div className="ai-choose-actions">
            <button className="btn primary" onClick={() => setChoosing(false)}>
              开始对话
            </button>
          </div>
        </div>
      ) : (
        <>
          {loading ? (
            <div className="loading">加载中…</div>
          ) : (
            <div className="ai-transcript" ref={transcript}>
              {msgs.length === 0 && (
                <div className="empty">
                  直接提问就好：词汇、语法、句子理解，或者任何和阅读有关的问题。
                  {isNew && (
                    <div className="ai-open-prompt">
                      开场提示词：{picked ? picked.name : '默认'}
                      <button className="btn sm" onClick={() => setChoosing(true)}>
                        更换
                      </button>
                    </div>
                  )}
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
        </>
      )}
    </div>
  );
}

export default function AIChats() {
  const { id } = useParams<{ id?: string }>();
  return id ? <ChatRoom id={id} /> : <ChatList />;
}
