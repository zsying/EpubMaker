import type { TtsEngine } from '../readAloud';
import { LISTEN_RATES } from '../useListenSession';

// The 听书 settings sheet: which engine reads, which voice it uses, how fast.
//
// A component rather than sixty lines inside the reader, because all four
// controls write straight back into the session and none of them needs to know
// what a page is. The sheet is also the only place the online voice is named at
// full length — the bar has room for one word of it.
export type ListenSettingsProps = {
  engine: TtsEngine;
  voice: string;
  rate: number;
  /** Empty until the list arrives; a picker that cannot load is not an error. */
  voices: Array<{ name: string; label: string }>;
  onEngine: (engine: TtsEngine) => void;
  onVoice: (voice: string) => void;
  onRate: (rate: number) => void;
  onClose: () => void;
};

export default function ListenSettings({
  engine,
  voice,
  rate,
  voices,
  onEngine,
  onVoice,
  onRate,
  onClose,
}: ListenSettingsProps) {
  return (
    <div className="sheet-mask" onClick={onClose}>
      <div className="sheet rd-sheet" onClick={(e) => e.stopPropagation()}>
        {/* Two engines, one switch. 系统 is the phone's own TTS: free, offline,
            unlimited, and a bit robotic. 在线 is a neural voice that needs the
            network and is not an official API — the note under the switch says
            so rather than pretending otherwise. */}
        <div className="rd-set-row">
          <span className="rd-set-label">
            音色来源
            <small className="rd-set-desc">
              {engine === 'online'
                ? '在线音色需联网，音质接近真人'
                : '系统引擎：离线可用，不限量，声音偏机械'}
            </small>
          </span>
          <div className="rd-seg tight">
            <button className={engine === 'system' ? 'on' : ''} onClick={() => onEngine('system')}>
              系统
            </button>
            <button className={engine === 'online' ? 'on' : ''} onClick={() => onEngine('online')}>
              在线
            </button>
          </div>
        </div>
        {engine === 'online' && (
          <div className="rd-set-row rd-voice-row">
            <span className="rd-set-label">音色</span>
            <div className="rd-voices">
              {voices.map((v) => (
                <button
                  key={v.name}
                  className={`rd-voice${voice === v.name ? ' on' : ''}`}
                  onClick={() => onVoice(v.name)}
                >
                  {v.label}
                </button>
              ))}
              {!voices.length && <span className="rd-set-desc">载入中…</span>}
            </div>
          </div>
        )}
        <div className="rd-set-row last">
          <span className="rd-set-label">语速</span>
          <div className="rd-seg tight">
            {LISTEN_RATES.map((r) => (
              <button key={r} className={rate === r ? 'on' : ''} onClick={() => onRate(r)}>
                {r}×
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
