// Word pronunciation.
//
// Android's WebView ships the SpeechSynthesis API surface but no voices, so
// "works offline" via the built-in TTS is silent on exactly the device this
// app targets. The primary path is therefore a small online dictionary voice
// endpoint (Youdao's dictvoice, reachable from China without a proxy): an
// <audio> element can play it with no CORS involved, and the browser HTTP
// cache makes repeat plays of the same word free. Systems that do have TTS
// voices — the desktop — get them as the fallback when there is no network.
import { toast } from './toast';

let current: HTMLAudioElement | null = null;

function speakSystem(text: string): boolean {
  try {
    const synth = window.speechSynthesis;
    if (!synth) return false;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'en-US';
    u.rate = 0.9;
    synth.cancel();
    synth.speak(u);
    return true;
  } catch {
    return false;
  }
}

/** Speaks an English word aloud. Called from click handlers, so the user
 * activation the WebView requires for media playback is already there. */
export function speakWord(word: string) {
  const w = (word || '').trim();
  if (!w) return;
  if (current) {
    try {
      current.pause();
    } catch {
      /* already gone */
    }
    current = null;
  }
  const audio = new Audio(
    `https://dict.youdao.com/dictvoice?audio=${encodeURIComponent(w.toLowerCase())}&type=2`,
  );
  current = audio;
  let done = false;
  const fail = () => {
    if (done) return;
    done = true;
    if (!speakSystem(w)) toast('发音需要联网，请检查网络后重试', 'info');
  };
  audio.addEventListener('error', fail, { once: true });
  audio
    .play()
    .then(() => {
      done = true;
    })
    .catch(fail);
}
