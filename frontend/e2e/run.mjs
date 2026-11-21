/**
 * `pnpm e2e` : parcours Playwright contre la vraie API.
 *
 *   pnpm e2e                    tous les parcours, groupe par groupe, dans un ordre qui convient à leurs jeux d'essai
 *   pnpm e2e e2e/login.e2e.ts   arguments transmis tels quels à Playwright (un fichier, `-g`, `--headed`…)
 *
 * Pourquoi un ordre : chaque lot prépare ses données dans la même base de développement, et certains jeux
 * d'essai se gênent (ex. le modèle de chauffeurs importé par les parcours Journée / Commandes ajoute un
 * homonyme attendu unique par le parcours Comparaison ; le jeu de l'écran Plan crée des stations sans cuve que
 * celui des Commandes ne recrée pas). L'ordre ci-dessous passe sur une base vierge (`./scripts/dev_setup.sh`
 * après avoir supprimé la base `tourneo`). Un nouveau lot s'ajoute en fin de liste, ou tombe dans « le reste ».
 */
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";

const ORDER = ["l14-", "l11-", "l12-", "l13-"]; // puis tous les autres fichiers, par ordre alphabétique
const playwright = (args) =>
  spawnSync("pnpm", ["exec", "playwright", "test", "--trace", "off", ...args], { stdio: "inherit" }).status ??
  1;
const run = (args) => playwright(["--project=e2e", ...args]);

// Arguments transmis tels quels : le contrôle préalable s'exécute alors comme dépendance du projet `e2e`.
const passthrough = process.argv.slice(2);
if (passthrough.length > 0) process.exit(run(passthrough));

// Suite complète : contrôle préalable une seule fois (API, limitation de débit désactivée, worker Celery),
// puis les groupes sans le rejouer. S'il échoue, aucun parcours n'est lancé.
if (playwright(["--project=prerequis"]) !== 0) {
  console.error(
    "\nContrôle préalable en échec : aucun parcours lancé (voir le message ci-dessus et le README).",
  );
  process.exit(1);
}

const files = readdirSync(new URL(".", import.meta.url))
  .filter((name) => name.endsWith(".e2e.ts"))
  .sort();
const groups = [
  ...ORDER.map((prefix) => files.filter((name) => name.startsWith(prefix))),
  files.filter((name) => !ORDER.some((prefix) => name.startsWith(prefix))),
].filter((group) => group.length > 0);

let failed = 0;
for (const group of groups) {
  console.log(`\n— ${group.join(", ")}`);
  if (run(["--no-deps", ...group.map((name) => `e2e/${name}`)]) !== 0) failed += 1;
}
if (failed > 0) console.error(`\n${failed} groupe(s) de parcours en échec.`);
process.exit(failed > 0 ? 1 : 0);
