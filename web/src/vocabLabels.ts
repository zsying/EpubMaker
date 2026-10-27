import type { VocabEntry } from './api';

/**
 * How a notebook state is named on screen. One table, used by the notebook, the
 * lookup history and anything else that has to say "待学" — the same word must
 * never get two names in two places.
 */
export const STATUS_LABEL: Record<VocabEntry['status'], string> = {
  new: '待学',
  learning: '学习中',
  known: '已掌握',
  ignored: '已忽略',
};

/** What the state means, for the row's tooltip. */
export const STATUS_HINT: Record<VocabEntry['status'], string> = {
  new: '查词时自动收录，还没有复习过',
  learning: '复习间隔还短，会频繁回来',
  known: '连续答对，间隔已经拉长到三周以上',
  ignored: '不再提示',
};

/** 'When is this due again', said the way a person would say it. */
export function dueLabel(iso: string): string {
  if (!iso) return '待复习';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const ms = at.getTime() - Date.now();
  if (ms <= 0) return '今天到期';
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${Math.max(1, minutes)} 分钟后`;
  const days = Math.round(ms / 86400000);
  if (days <= 1) return '明天';
  // Beyond two months a countdown stops meaning anything; the date reads better.
  if (days < 60) return `${days} 天后`;
  return `${at.getMonth() + 1}月${at.getDate()}日`;
}

/** When the word is due, said the way a schedule would: a word that was never
 * scheduled has no date to show, and saying '今天到期' about it would be wrong. */
export function scheduleLine(dueAt: string): string {
  return dueAt ? `下次 ${dueLabel(dueAt)}` : '还没复习过';
}
