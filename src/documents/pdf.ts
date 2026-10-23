export const MAX_PDF_BYTES = 10 * 1024 * 1024;

export interface SelectedPdf {
  file: File;
  digest: string;
}

export class DocumentError extends Error {
  constructor(public readonly code: 'INVALID_PDF' | 'UNAVAILABLE' | 'QUOTA' | 'STALE' | 'STORAGE') {
    super({
      INVALID_PDF: 'Choose one nonempty PDF, up to 10 MiB, with a .pdf filename, PDF MIME type (if supplied) and a PDF header.',
      UNAVAILABLE: 'Resume bytes are unavailable or changed. Select the PDF again; no other document will be substituted.',
      QUOTA: 'Browser storage is full. Free local storage or remove an unused saved resume, then retry. Your selection stays in this view.',
      STALE: 'Document or session state changed or expired. Reload document state and review your selection.',
      STORAGE: 'Local document storage is unavailable. Your selection stays in this view; reload storage state before retrying.',
    }[code]);
  }
}

export async function pdfDigest(bytes: ArrayBuffer): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) => b.toString(16).padStart(2, '0')).join('');
}

// Basic identification only. Never parse, render, rewrite or infer candidate facts.
export async function selectPdf(files: readonly File[]): Promise<SelectedPdf> {
  const file = files[0];
  if (files.length !== 1 || !file || file.size === 0 || file.size > MAX_PDF_BYTES || !/\.pdf$/i.test(file.name) || (file.type !== '' && file.type.toLowerCase() !== 'application/pdf')) throw new DocumentError('INVALID_PDF');
  try {
    const header = new Uint8Array(await file.slice(0, 5).arrayBuffer());
    if (![37, 80, 68, 70, 45].every((b, i) => header[i] === b)) throw new DocumentError('INVALID_PDF');
    return { file, digest: await pdfDigest(await file.arrayBuffer()) };
  } catch (error) {
    if (error instanceof DocumentError) throw error;
    throw new DocumentError('UNAVAILABLE');
  }
}
