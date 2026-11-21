/** Téléchargement de fichiers (PDF, modèles d'import) et envoi multipart. */
import { api, apiFetch, type ApiOptions, type Query } from "./client";

export interface DownloadedFile {
  blob: Blob;
  filename: string;
}

/** Nom de fichier de l'en-tête `Content-Disposition` (formes `filename=` et `filename*=UTF-8''…`). */
export function filenameFromDisposition(header: string | null): string | null {
  if (!header) return null;
  const star = /filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i.exec(header);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ""));
    } catch {
      // nom mal encodé : on tente la forme simple
    }
  }
  const plain = /filename\s*=\s*("?)([^";]+)\1/i.exec(header);
  return plain ? plain[2].trim() : null;
}

export async function apiDownload(
  path: string,
  options: { query?: Query; signal?: AbortSignal; fallbackName?: string } = {},
): Promise<DownloadedFile> {
  const response = await apiFetch(path, {
    query: options.query,
    signal: options.signal,
    headers: { Accept: "*/*" },
  });
  const blob = await response.blob();
  const filename =
    filenameFromDisposition(response.headers.get("content-disposition")) ??
    options.fallbackName ??
    path.split("/").pop() ??
    "fichier";
  return { blob, filename };
}

/** Propose l'enregistrement d'un fichier déjà en mémoire. */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Télécharge puis enregistre (usage : `PdfButton`, modèle d'import). */
export async function downloadFile(
  path: string,
  options: { query?: Query; fallbackName?: string } = {},
): Promise<string> {
  const file = await apiDownload(path, options);
  saveBlob(file.blob, file.filename);
  return file.filename;
}

/** Ouvre un PDF dans un nouvel onglet (aperçu avant impression). */
export async function openFile(path: string, options: { query?: Query } = {}): Promise<void> {
  const file = await apiDownload(path, options);
  const url = URL.createObjectURL(file.blob);
  window.open(url, "_blank", "noopener");
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * Envoi multipart. Le fichier part dans le champ `file` ; `fields` ajoute des champs simples.
 *   const batch = await apiUpload<ImportBatch>("/imports/stations/preview", file);
 */
export function apiUpload<T>(
  path: string,
  file: File | Blob,
  options: { fields?: Record<string, string | number | boolean>; fieldName?: string } & Pick<
    ApiOptions,
    "query" | "signal" | "method"
  > = {},
): Promise<T> {
  const form = new FormData();
  const name = file instanceof File ? file.name : "fichier";
  form.append(options.fieldName ?? "file", file, name);
  for (const [key, value] of Object.entries(options.fields ?? {})) form.append(key, String(value));
  return api<T>(path, {
    method: options.method ?? "POST",
    body: form,
    query: options.query,
    signal: options.signal,
  });
}
