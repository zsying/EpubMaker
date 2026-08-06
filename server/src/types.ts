export interface BookRow {
  id: string;
  title: string;
  author: string;
  language: string;
  publisher: string;
  description: string;
  identifier: string;
  /** 封面在 content 目录中的相对路径 */
  cover_href: string | null;
  source_name: string | null;
  /** 软删除时间；非空表示书在回收站中 */
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ChapterRow {
  id: string;
  book_id: string;
  idx: number;
  title: string;
  /** 正文文件在 content 目录中的相对路径 */
  href: string;
  created_at: string;
  updated_at: string;
}

export interface AssetRow {
  id: string;
  book_id: string;
  href: string;
  media_type: string;
  size: number;
}

export interface BookDTO {
  id: string;
  title: string;
  author: string;
  language: string;
  publisher: string;
  description: string;
  identifier: string;
  coverHref: string | null;
  coverUrl: string | null;
  sourceName: string | null;
  chapterCount: number;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ChapterDTO {
  id: string;
  bookId: string;
  index: number;
  title: string;
  href: string;
  updatedAt: string;
}
