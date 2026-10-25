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
