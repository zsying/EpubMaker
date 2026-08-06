const MAP: Record<string, string> = {
  '.xhtml': 'application/xhtml+xml',
  '.html': 'application/xhtml+xml',
  '.htm': 'application/xhtml+xml',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.xml': 'application/xml',
  '.ncx': 'application/x-dtbncx+xml',
  '.opf': 'application/oebps-package+xml',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.eot': 'application/vnd.ms-fontobject',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.m4a': 'audio/mp4',
  '.txt': 'text/plain',
  '.json': 'application/json',
  '.pls': 'application/pls+xml',
  '.smil': 'application/smil+xml'
};

export function guessMediaType(href: string): string {
  const i = href.lastIndexOf('.');
  if (i < 0) return 'application/octet-stream';
  return MAP[href.slice(i).toLowerCase()] ?? 'application/octet-stream';
}

export function isDocument(mediaType: string): boolean {
  return mediaType === 'application/xhtml+xml' || mediaType === 'text/html';
}

export function isImage(mediaType: string): boolean {
  return mediaType.startsWith('image/');
}
