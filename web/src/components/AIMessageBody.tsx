import type { ReactNode } from 'react';

/**
 * A transcript bubble's content, rendered for reading rather than for storage.
 *
 * The grounded prompts ask the model for JSON, and the JSON is what the
 * provider actually returned — so it is what the transcript stores, verbatim.
 * Showing it raw is honest but unreadable: `{"meaning":"翻动书页",…}` in a chat
 * bubble is a wall of punctuation. This renders the same facts as labelled
 * rows (释义 / 翻译 / 提示 …), keeps lists as lists, and puts the untouched
 * JSON behind a `<details>` so nothing is lost.
 *
 * Anything that is not JSON — a manual chat's prose, a model that ignored the
 * instruction — renders as plain text, unchanged.
 */

type Block = { kind: 'text'; text: string } | { kind: 'json'; value: unknown };

/** Chinese labels for the keys the app's own prompts produce. */
const LABELS: Record<string, string> = {
  meaning: '释义',
  translation: '翻译',
  pos: '词性',
  note: '提示',
  notes: '注释',
  summary: '摘要',
  points: '要点',
  terms: '术语',
  term: '词',
  gloss: '释义',
  segments: '句子拆解',
  text: '原文',
  role: '成分',
  word: '单词',
  words: '单词',
  sentence: '句子',
  example: '例句',
  examples: '例句',
  explanation: '解释',
  answer: '回答',
  question: '问题',
  title: '标题',
  usage: '用法',
  tags: '标签',
  level: '难度',
  source: '出处',
};

const labelOf = (k: string): string => LABELS[k.toLowerCase()] ?? k;

function isMap(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Parses a whole string as JSON — only objects and arrays are worth a view. */
function tryJson(s: string): { ok: true; value: unknown } | { ok: false } {
  const t = s.trim();
  if (!t || (t[0] !== '{' && t[0] !== '[')) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(t) };
  } catch {
    return { ok: false };
  }
}

function pushPlain(out: Block[], s: string): void {
  const t = s.replace(/^\n+/, '').replace(/\n+$/, '');
  if (t.trim()) out.push({ kind: 'text', text: t });
}

function pushText(out: Block[], s: string): void {
  if (!s.trim()) return;
  const whole = tryJson(s);
  if (whole.ok) {
    out.push({ kind: 'json', value: whole.value });
    return;
  }
  // A model that wraps its JSON in one line of prose ("结果如下：{…}") still
  // gets the structured view; the prose stays where it was.
  const start = s.search(/[{[]/);
  const end = Math.max(s.lastIndexOf('}'), s.lastIndexOf(']'));
  if (start >= 0 && end > start) {
    const candidate = s.slice(start, end + 1);
    const part = tryJson(candidate);
    if (part.ok) {
      pushPlain(out, s.slice(0, start));
      out.push({ kind: 'json', value: part.value });
      pushPlain(out, s.slice(end + 1));
      return;
    }
  }
  pushPlain(out, s);
}

const FENCE = /```[a-zA-Z0-9]*\n([\s\S]*?)```/g;

function splitBlocks(src: string): Block[] {
  const out: Block[] = [];
  let last = 0;
  for (const m of src.matchAll(FENCE)) {
    const at = m.index ?? 0;
    pushText(out, src.slice(last, at));
    const body = m[1] ?? '';
    const json = tryJson(body);
    if (json.ok) out.push({ kind: 'json', value: json.value });
    else pushPlain(out, body);
    last = at + m[0].length;
  }
  pushText(out, src.slice(last));
  return out;
}

function JsonValue({ value }: { value: unknown }): ReactNode {
  if (typeof value === 'string') return <span className="ai-json-text">{value}</span>;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return <span className="ai-json-atom">{String(value)}</span>;
  }
  if (value === null) return <span className="ai-json-atom">—</span>;
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="ai-json-atom">（无）</span>;
    // A list of plain values is a list; a list of objects is a set of records
    // (句子拆解, 要点), and each record gets its own block so its keys read as
    // labels instead of as punctuation.
    if (value.some(isMap)) {
      return (
        <div className="ai-json-items">
          {value.map((v, i) => (
            <div className="ai-json-item" key={i}>
              <JsonValue value={v} />
            </div>
          ))}
        </div>
      );
    }
    return (
      <ul className="ai-json-list">
        {value.map((v, i) => (
          <li key={i}>{String(v)}</li>
        ))}
      </ul>
    );
  }
  if (isMap(value)) return <JsonRows value={value} />;
  return <span className="ai-json-atom">{String(value)}</span>;
}

function JsonRows({ value }: { value: Record<string, unknown> }): ReactNode {
  const rows = Object.entries(value);
  if (rows.length === 0) return <span className="ai-json-atom">（空）</span>;
  return (
    <div className="ai-json-rows">
      {rows.map(([k, v]) => (
        <div className="ai-json-row" key={k}>
          <span className="ai-json-key">{labelOf(k)}</span>
          <div className="ai-json-val">
            <JsonValue value={v} />
          </div>
        </div>
      ))}
    </div>
  );
}

export default function AIMessageBody({ text }: { text: string }) {
  return (
    <>
      {splitBlocks(text).map((b, i) =>
        b.kind === 'text' ? (
          <div className="ai-msg-text" key={i}>
            {b.text}
          </div>
        ) : (
          <div className="ai-json" key={i}>
            <JsonValue value={b.value} />
            <details className="ai-json-raw">
              <summary>原始 JSON</summary>
              <pre>{JSON.stringify(b.value, null, 2)}</pre>
            </details>
          </div>
        ),
      )}
    </>
  );
}
