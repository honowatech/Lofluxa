/**
 * Données communes à tous les parcours, mises en place une fois avant le premier fichier (`prerequis.setup.ts`).
 *
 * Les dépôts du fichier modèle (`data/templates/depots.xlsx` : SCDP-DLA, SCDP-YDE) sont importés d'office.
 * Raison : certains jeux d'essai n'importent les fichiers modèles que sur une base sans station ; lancés après
 * un autre lot, ils n'avaient plus le second dépôt dont dépend le parcours « pénurie → changer de dépôt ».
 * L'import est celui du produit (prévisualiser puis appliquer) et ne fait rien si les dépôts existent déjà.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { API, fetchTokens } from "./auth";

const TEMPLATES = fileURLToPath(new URL("../../data/templates/", import.meta.url));

interface Batch {
  id: string;
  can_apply?: boolean;
  report?: { summary?: Record<string, number> };
}

async function importTemplate(token: string, kind: string): Promise<string> {
  const form = new FormData();
  form.append(
    "file",
    new Blob([await readFile(`${TEMPLATES}${kind}.xlsx`)], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }),
    `${kind}.xlsx`,
  );
  const headers = { Authorization: `Bearer ${token}` };
  const preview = await fetch(`${API}/imports/${kind}/preview`, { method: "POST", headers, body: form });
  if (!preview.ok) throw new Error(`Prévisualisation de ${kind}.xlsx refusée : ${await preview.text()}`);
  const batch = (await preview.json()) as Batch;
  const summary = batch.report?.summary ?? {};
  const toWrite = (summary.created ?? 0) + (summary.updated ?? 0) + (summary.reactivated ?? 0);
  if (!batch.can_apply || toWrite === 0) return "déjà en place";
  const applied = await fetch(`${API}/imports/${batch.id}/apply`, { method: "POST", headers });
  if (!applied.ok) throw new Error(`Import de ${kind}.xlsx refusé : ${await applied.text()}`);
  return `${toWrite} ligne(s) écrite(s)`;
}

/** Renvoie un compte rendu lisible de ce qui a été mis en place. */
export async function seedCommon(): Promise<string> {
  const { access_token } = await fetchTokens();
  return `dépôts du fichier modèle : ${await importTemplate(access_token, "depots")}`;
}
