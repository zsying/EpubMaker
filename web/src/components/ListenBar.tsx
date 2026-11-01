// 听书 controls — the bar that stays up while the book is being read aloud.
//
// Deliberately its own component and its own fixed layer: the reader's chrome
// bars slide away with the rest of the UI, but this one has to be reachable
// while the screen is otherwise a page of text (that is the whole point of
// listening). It sits above the bottom tab bar, thumb-height, and reports every
// action upward — all state lives in the reader.
import type { CSSProperties } from 'react';

export type ListenBarProps = {
  title: string;
  playing: boolean;
  rate: number;
  index: number;
  total: number;
  /** False once the reader turned a page by hand: the bar then offers the way
   * back to where the voice is, instead of silently chasing it. */
  following: boolean;
  /** Shown as a chip when the online voice is in use. */
  voiceLabel?: string;
  onToggle: () => void;
  onPrev: () => void;
  onNext: () => void;
  onFollow: () => void;
  onRate: () => void;
  onSettings: () => void;
  onClose: () => void;
  style?: CSSProperties;
};

function IconPlay() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
      <path d="M8 5.5v13l11-6.5z" fill="currentColor" />
    </svg>
  );
}

function IconPause() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
      <rect x="7" y="5" width="3.6" height="14" rx="1.2" fill="currentColor" />
      <rect x="13.4" y="5" width="3.6" height="14" rx="1.2" fill="currentColor" />
    </svg>
  );
}

function IconPrev() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path d="M7 5.5v13" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M18 6.5v11L9.6 12z" fill="currentColor" />
    </svg>
  );
}

function IconNext() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path d="M17 5.5v13" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M6 6.5v11L14.4 12z" fill="currentColor" />
    </svg>
  );
}

function IconSliders() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path
        d="M5 8h9M17 8h2M5 16h3M11 16h8"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
      />
      <circle cx="15.5" cy="8" r="2.2" fill="currentColor" />
      <circle cx="9.5" cy="16" r="2.2" fill="currentColor" />
    </svg>
  );
}

export default function ListenBar({
  title,
  playing,
  rate,
  index,
  total,
  following,
  voiceLabel,
  onToggle,
  onPrev,
  onNext,
  onFollow,
  onRate,
  onSettings,
  onClose,
  style,
}: ListenBarProps) {
  // "晓晓 · 女声，亲和" is a settings-sheet label; the bar has room for the name.
  const shortVoice = voiceLabel ? voiceLabel.split(' · ')[0] : '';
  return (
    <div className="listen-bar" style={style} role="group" aria-label="听书">
      <button className="lb-play" onClick={onToggle} aria-label={playing ? '暂停朗读' : '继续朗读'}>
        {playing ? <IconPause /> : <IconPlay />}
      </button>
      {/* The whole meta block is the way back while the reader is away from the
          voice: it is the widest target on the bar and it already names the
          sentence, so it reads as "tap here to return to it". */}
      <div
        className={`lb-meta${following ? '' : ' lb-away'}`}
        onClick={following ? undefined : onFollow}
        role={following ? undefined : 'button'}
        aria-label={following ? undefined : '回到正在朗读的句子'}
        title={following ? undefined : '回到正在朗读的句子'}
      >
        <div className="lb-title">{title}</div>
        {/* A 360px phone leaves this line about ninety pixels — six Han
            characters or so. That is why the counter lost its 第/句 wrapper, why
            the voice is named by its first word only, and why the way back says
            just "回到朗读": everything longer ends up as "回到朗读 · 34…", which
            reads like a bug. */}
        <div className="lb-sub">
          {following
            ? [total > 0 ? `${Math.min(index + 1, total)}/${total} 句` : '', shortVoice]
                .filter(Boolean)
                .join(' · ')
            : '回到朗读'}
        </div>
      </div>
      <button className="lb-btn" onClick={onPrev} aria-label="上一句">
        <IconPrev />
      </button>
      <button className="lb-btn" onClick={onNext} aria-label="下一句">
        <IconNext />
      </button>
      <button className="lb-rate" onClick={onRate} aria-label={`语速 ${rate} 倍`}>
        {rate.toFixed(2).replace(/0$/, '')}×
      </button>
      <button className="lb-btn" onClick={onSettings} aria-label="听书设置">
        <IconSliders />
      </button>
      <button className="lb-close" onClick={onClose} aria-label="退出听书">
        ×
      </button>
    </div>
  );
}
