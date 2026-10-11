// Hands what was picked in Add music / New score to Reading (route params can't carry files).

// One file the server reads: a photo of a page (JPEG, PNG, HEIC, DNG...) or a PDF of one or more
// pages. The server turns each into page images, reads them in order and joins them.
export interface UploadFile {
  kind: 'image' | 'pdf';
  uri: string;
  name: string;
  mimeType: string;
  width?: number;
  height?: number;
  file?: File; // web build only: the browser's File object
}

export type PendingUpload =
  // A MusicXML file, used as it is.
  | { kind: 'musicxml'; uri: string; name: string; mimeType: string; file?: File }
  // A new score: the name the player gave it, and its pages in order.
  | { kind: 'pages'; title: string; files: UploadFile[] };

let pending: PendingUpload | null = null;

export function setPendingUpload(upload: PendingUpload): void {
  pending = upload;
}

export function takePendingUpload(): PendingUpload | null {
  const value = pending;
  pending = null;
  return value;
}

// File kinds the server can read, by name or type. Pixel photos are JPEG ("Ultra HDR" JPEG
// keeps an ordinary JPEG up front), or DNG in RAW mode; iPhone photos are HEIC.
export function uploadKindOf(name: string, mimeType: string): UploadFile['kind'] | null {
  const lower = name.toLowerCase();
  if (mimeType === 'application/pdf' || lower.endsWith('.pdf')) return 'pdf';
  if (mimeType.startsWith('image/') || /\.(jpe?g|png|heic|heif|avif|webp|dng|tiff?|bmp)$/.test(lower)) return 'image';
  return null;
}
