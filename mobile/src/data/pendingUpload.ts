// Hands the picked page or file from Add music to Reading (route params can't carry a file).
export interface PendingUpload {
  kind: 'image' | 'musicxml';
  uri: string;
  name: string;
  mimeType: string;
  file?: File; // web build only: the browser's File object
}

let pending: PendingUpload | null = null;

export function setPendingUpload(upload: PendingUpload): void {
  pending = upload;
}

export function takePendingUpload(): PendingUpload | null {
  const value = pending;
  pending = null;
  return value;
}
