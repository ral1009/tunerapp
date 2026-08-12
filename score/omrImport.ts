import type { ScoreDocument } from "./schema";
import { OMR_SERVER_BASE_URL } from "./serverConfig";
import { importMusicXmlToScore } from "./musicxmlImport";

export interface OmrImportResult {
  score: ScoreDocument;
  transientBoundingBoxes: Array<{ noteId: string; x: number; y: number; width: number; height: number }>;
}

interface ParseSheetResponse {
  notes: string[];
  frequencies: number[];
  xmlData: string;
}

interface ParseSheetErrorResponse {
  error: string;
}

export async function importPhotoToScore(imageBytes: Uint8Array): Promise<OmrImportResult> {
  const buffer = imageBytes.buffer.slice(imageBytes.byteOffset, imageBytes.byteOffset + imageBytes.byteLength) as ArrayBuffer;
  const formData = new FormData();
  formData.append("file", new Blob([buffer]), "upload.png");

  let response: Response;
  try {
    response = await fetch(`${OMR_SERVER_BASE_URL}/api/parse-sheet`, {
      method: "POST",
      body: formData
    });
  } catch {
    throw new Error(`Could not reach the sheet parser server. Is it running on ${OMR_SERVER_BASE_URL}?`);
  }

  const body = (await response.json().catch(() => null)) as ParseSheetResponse | ParseSheetErrorResponse | null;

  if (!response.ok) {
    const message = body && "error" in body ? body.error : `Sheet parser request failed with status ${response.status}.`;
    throw new Error(message);
  }

  if (!body || !("xmlData" in body) || typeof body.xmlData !== "string") {
    throw new Error("Sheet parser returned an unexpected response.");
  }

  const score: ScoreDocument = { ...(await importMusicXmlToScore(body.xmlData)), sourceType: "photo" };

  return { score, transientBoundingBoxes: [] };
}