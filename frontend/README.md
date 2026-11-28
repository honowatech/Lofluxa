# Tournéo — interface (lot L9, socle)

React 18 + TypeScript + Vite · React Router · TanStack Query / Table · Zustand · MapLibre GL JS · dnd-kit ·
react-hook-form + zod · date-fns-tz · Tailwind CSS + composants de style shadcn/ui (Radix).
Français en dur : **tous les textes sont dans `src/i18n/fr.ts`**.

Captures des écrans livrés : [`docs/captures/`](docs/captures/).

## Lancer

```bash
pnpm install
pnpm dev            # http://localhost:5173 — proxy /api → http://localhost:8000
```

L'API : `./scripts/dev_setup.sh` puis `cd backend && uv run uvicorn app.main:app_instance --port 8000`
(compte du seed : `admin@honowa.tech` / `admin-dev-only`).

| Commande        | Rôle                                                                                               |
| --------------- | -------------------------------------------------------------------------------------------------- |
| `pnpm dev`      | serveur de développement                                                                           |
| `pnpm build`    | contrôle des types + site statique dans `dist/` (servi par Caddy)                                  |
| `pnpm lint`     | ESLint (zéro avertissement) + Prettier                                                             |
| `pnpm test`     | Vitest + Testing Library + MSW                                                                     |
| `pnpm e2e`      | Playwright, **contre la vraie API, sans doublure** — voir « Parcours de bout en bout » ci-dessous. |
| `pnpm captures` | régénère `docs/captures/*.png` (doublures complètes, aucun back-end requis)                        |

### Parcours de bout en bout (`pnpm e2e`)

Trois processus, sur une base préparée par `./scripts/dev_setup.sh` :

```bash
# 1. API SANS limitation de débit : la suite se connecte bien plus de 10 fois par minute depuis une seule adresse
cd backend && TOURNEO_RATE_LIMIT_ENABLED=false uv run uvicorn app.main:app_instance --port 8000
# 2. worker Celery : calcul de plan, recalcul et rejeu sont des tâches de fond
cd backend && uv run celery -A app.worker.celery_app worker --loglevel=warning
# 3. les parcours
cd frontend && pnpm e2e
```

- Si aucune API ne tourne, Playwright la lance lui-même avec cette variable ; **une API déjà lancée garde son
  propre réglage**. Le worker n'est jamais lancé par Playwright.
- **Contrôle préalable** (`e2e/prerequis.setup.ts`) : avant le premier parcours, la suite vérifie que l'API
  répond (base et Redis compris), que la limitation de débit est bien désactivée et qu'un worker Celery
  répond. S'il manque quelque chose, aucun parcours n'est lancé et le message donne la commande à exécuter.
- `pnpm e2e` sans argument (`e2e/run.mjs`) enchaîne les parcours groupe par groupe, dans un ordre compatible
  avec leurs jeux d'essai (Comparaison, Journée / Commandes, Plan, Chargement / Suivi / Journal, puis socle).
  Avec des arguments (`pnpm e2e e2e/login.e2e.ts`, `-g "…"`, `--headed`), ils sont transmis à Playwright.
- **Connexion dans un parcours** : `e2e/auth.ts`, commun à tous les lots.

  ```ts
  import { ADMIN, fetchTokens, openSession } from "./auth";

  await openSession(page); // session admin ouverte par jeton, avant `page.goto(...)`
  await openSession(page, { email: "dispatcher@…", password: "…" });
  const { access_token } = await fetchTokens(); // préparer des données par l'API
  ```

  Seul `login.e2e.ts` passe par le formulaire (`submitLogin`). La limitation de débit reste vérifiée : côté
  serveur par les tests du back-end, côté écran par une réponse 429 simulée (`login.e2e.ts`, `app.test.tsx`).

### Variables d'environnement (`.env.example`)

| Variable                 | Effet                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VITE_MOCKS`             | `off` (défaut) : vraie API. `partial` : seules les routes non encore livrées sont simulées (liste `undelivered` de `src/mocks/handlers/index.ts`, vide aujourd'hui). `full` : tout est simulé, connexion comprise (démo et captures sans back-end ; comptes `…@ola.example` / `demo-dev-only` pour chaque rôle, voir `src/mocks/db.ts`). Un badge orange dans l'en-tête signale les données simulées. |
| `VITE_API_BASE_URL`      | Préfixe de l'API vu du navigateur (défaut `/api/v1`, fixé par l'image Docker `infra/frontend`).                                                                                                                                                                                                                                                                                                       |
| `VITE_TILES_URL`         | Gabarit des tuiles raster du fond de carte (`https://…/{z}/{x}/{y}.png`). Vide : carte sans fond, positions à l'échelle.                                                                                                                                                                                                                                                                              |
| `VITE_TILES_ATTRIBUTION` | Mention de source affichée sur la carte.                                                                                                                                                                                                                                                                                                                                                              |
| `VITE_API_PROXY`         | Cible du proxy de développement (défaut `http://localhost:8000`).                                                                                                                                                                                                                                                                                                                                     |

Toutes les routes des écrans livrés existent dans l'API réelle : `pnpm dev` parle à la vraie API. Les
doublures ne servent plus qu'aux tests Vitest et au mode `full` (démonstration et captures sans back-end), où
elles sont assemblées par `src/mocks/handlers/index.ts` : routes du socle (`auth`, `referentials`, `imports`,
`admin`), puis doublures fournies par chaque écran dans son dossier (`src/mocks/handlers/screens.ts` :
Plan, Journée, Comparaison, Commandes, Disponibilité — le premier gestionnaire qui répond l'emporte). Un écran
dont les routes n'existent pas encore ajoute ses doublures à `undelivered`, puis les en retire. Les doublures
ne sont pas incluses dans le build quand `VITE_MOCKS` est absent ou `off`.

## Organisation

```
src/
  app/          routeur, gardes, fournisseurs, registre des écrans, coquille (shell/)
  lib/          api/ (client, erreurs, pagination, ressources CRUD, fichiers, imports, paramètres)
                auth/ (jetons, session, rôles) · types/ · format.ts · useDay.ts · alerts.ts · config.ts
  components/   composants partagés (catalogue ci-dessous) · ui/ (primitives de style shadcn) · forms/ · map/
  features/     un dossier par écran : login, day, orders, availability, plan, events, loading,
                deliveries, comparison, referentials, administration
  i18n/fr.ts    tous les textes
  mocks/        doublures MSW : db.ts (jeu fictif), handlers/ (une doublure par lot), browser.ts, server.ts
  test/         setup.ts, utils.tsx (renderApp, renderWithProviders, loginAs)
e2e/            login.e2e.ts (vraie API), captures.ts
```

Règles (vérifiées par ESLint quand c'est possible) :

- un écran n'écrit que dans son dossier `features/<écran>/` et n'importe jamais l'intérieur d'un autre écran ;
- les types de ressources s'importent depuis `@/lib/types` (point d'entrée unique : ils seront remplacés par
  les types générés depuis l'OpenAPI) ;
- aucun texte en dur dans un composant ; aucune mise en forme de litres / km / durées / heures hors de `lib/format.ts` ;
- pas de `fetch` direct : `api()` ou une ressource.

## Types de l'API

`src/lib/types/api.gen.ts` est **généré** depuis l'OpenAPI réelle du back-end ; ne pas le modifier à la main.
Après toute évolution des schémas de l'API, depuis la racine du dépôt :

```bash
./scripts/gen_api_types.sh        # openapi-typescript → frontend/src/lib/types/api.gen.ts
cd frontend && pnpm build         # une incompatibilité avec le code apparaît à la compilation
```

`@/lib/types` expose des **alias** de ces schémas (`Station`, `Truck`, `User`, `ImportBatch`, `Setting`…),
précisés là où l'OpenAPI est trop vague (horaires d'ouverture, valeur et type d'un paramètre, action d'audit).
Les listes d'énumérations (`TRUCK_STATUSES`, `ROLES`…) sont contrôlées contre les types générés : une valeur
ajoutée ou retirée côté serveur fait échouer la compilation. Pour un schéma sans alias :

```ts
import type { Schema } from "@/lib/types";
type Order = Schema<"OrderOut">;
```

Les textes des écrans de vague 2 vivent dans `src/i18n/screens/<écran>.ts` (un fichier par écran, exposé sous
`fr.screens.<écran>`) ; les textes du socle restent dans `src/i18n/fr.ts`.

## Ajouter (ou remplir) un écran

Les huit écrans de vague 2 existent déjà comme pages d'attente routées : il suffit de remplacer
`src/features/<écran>/index.tsx`. Pour un écran entièrement nouveau :

1. `src/features/<écran>/index.tsx` : export par défaut de la page.
2. `src/app/screens.ts` : une entrée (chemin, icône, groupe, `lazy(() => import(...))`).
3. `src/lib/auth/roles.ts` : identifiant dans `SCREEN_IDS`, rôles dans `SCREEN_ROLES`, droits dans `CAPABILITIES`.
4. `src/i18n/fr.ts` : `nav.screens.<écran>` et une section de textes pour l'écran.

Squelette type d'un écran de données :

```tsx
// src/features/orders/index.tsx
import { DataTable, PageHeader, StatusBadge, useDataTableState } from "@/components";
import { fr } from "@/i18n/fr";
import { createResource, toListQuery } from "@/lib/api";
import { useCan } from "@/lib/auth";
import { formatLiters } from "@/lib/format";
import { useDay } from "@/lib/useDay";

const orders = createResource<Order, OrderInput>("/orders");

export default function OrdersPage() {
  const { day } = useDay(); // jour J global (?day=YYYY-MM-DD)
  const canWrite = useCan("orders.write");
  const [state, setState] = useDataTableState();
  const list = orders.useList({ ...toListQuery(state), day }); // ou orders.useAll({ day }) + tri local
  return (
    <div className="flex h-full flex-col gap-3 p-4">
      <PageHeader title={fr.nav.screens.orders} />
      <DataTable
        caption={fr.nav.screens.orders}
        columns={columns}
        data={list.data?.items ?? []}
        total={list.data?.total}
        state={state}
        onStateChange={setState}
        getRowId={(row) => row.id}
        loading={list.isLoading}
        fetching={list.isFetching}
        error={list.error}
        onRetry={() => list.refetch()}
        searchable
        selectable={canWrite}
        className="min-h-0 flex-1"
      />
    </div>
  );
}
```

Tester un écran : `loginAs("dispatcher"); const { user } = renderApp("/commandes?day=2027-01-12");`
puis des requêtes Testing Library ; les doublures de l'écran vont dans `src/mocks/handlers/<lot>.ts`
(ou `server.use(...)` dans le test).

## Socle

### Client API — `@/lib/api`

```ts
const page = await api<Page<Station>>("/stations", {
  query: { limit: 50, offset: 0, q: "akwa", active: true },
});
await api("/plans/compute", { method: "POST", body: { day } });
```

- préfixe `/api/v1`, jeton joint ; **401 → rafraîchissement transparent** puis nouvel essai ; échec → session
  fermée, retour à la connexion. Le serveur fait tourner le jeton de rafraîchissement (l'ancien est révoqué) :
  les rafraîchissements sont **sérialisés**, dans l'onglet (une promesse partagée) et entre onglets
  (`navigator.locks` + relecture du stockage) ;
- toute erreur est une `ApiError` : `status`, `code`, `message` (français, affichable), `details`,
  `rule_code` / `ruleCodes` (RM-xx), `violations` (prêtes pour `ViolationsPanel`), `fieldErrors` (422 et 409
  `duplicate` → champs), `retryAfter` (429 `rate_limited`, secondes), `body` (corps brut de la réponse, pour les
  champs hors enveloppe : `(error.body as { warnings?: … })?.warnings`) ;
- `createResource<T, TInput>(path)` → `useList(query)`, `useAll()`, `useOne(id)`, `useCreate()`, `useUpdate()`,
  `useRemove()`, `useRemoveMany()` (les écritures invalident les listes). `PUT` = mise à jour **partielle** ;
  les sous-listes (cuves, compartiments) partent avec leur parent ;
- `toListQuery(state)` (état de tableau → `limit/offset/q/filtres`), `fetchAll`, `pageBounds`, `pageCount`.
  **L'API n'a pas de tri** : un tableau triable charge tout (`useAll`) et trie localement ;
- `downloadFile(path)`, `openFile(path)`, `apiDownload`, `apiUpload(path, file, { fields })` ;
- `previewImport`, `applyImport`, `downloadImportTemplate`, `importReportRows` ; `useSettings`, `useUpdateSettings`.

### Authentification — `@/lib/auth`

`useSession()` (statut, utilisateur, `login`, `logout`), `useCurrentUser()`, `useRole()`,
`useCan("plan.write")`, `useCanSee("comparison")`. Jetons en `localStorage` (`tourneo.tokens`), déconnexion
propagée entre onglets. Gardes de routes : `RequireAuth`, `RequireScreen` (`src/app/guards.tsx`).

Droits (`roles.ts`, alignés sur les `require_roles` du back-end) : `orders.write`, `plan.write`,
`comparison.write`, `events.write`, `availability.resources.write` → dispatcher ; `availability.stocks.write`,
`events.shortage.write` → supply ; `loading.write`, `deliveries.write` → fleet et dispatcher ;
`referentials.write`, `administration.write` → admin seul ; `audit.read` → manager. `admin` passe partout.

Démarrage : la session stockée n'est effacée que sur un refus d'authentification (401 / 403). Si `/me` est
interrompu (rechargement pendant le chargement), si le réseau est coupé ou si le serveur est en erreur, les
jetons sont conservés : `useSession().bootstrapError` porte le message et la garde propose « Réessayer ».

### Jour J — `@/lib/useDay`

`const { day, setDay, isToday, previous, next } = useDay();` — conservé dans l'URL (`?day=`), par défaut le
jour courant à Douala, transmis par les liens de navigation. `withDay(path, day)` pour un lien interne.

### Formatage — `@/lib/format`

| Fonction                                                                                             | Entrée → sortie                                                                                                                                         |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `formatLiters(12000)`                                                                                | litres → `12 000 L`                                                                                                                                     |
| `formatKm(12400)`                                                                                    | **mètres** → `12,4 km`                                                                                                                                  |
| `formatDuration(7500)`                                                                               | **secondes** → `2 h 05` ; `formatDuration(42, { seconds: true })` → `42 s` (sous la minute) ; `formatSeconds(5.34)` → `5,3 s` (durée courte, décimales) |
| `formatLocalTime("2027-01-12T06:30:00Z")`                                                            | horodatage UTC → `07:30` (Africa/Douala, RM-20)                                                                                                         |
| `formatDate("2027-01-12")`                                                                           | → `12/01/2027` ; `formatDateLong` → `mar. 12 janv. 2027` ; `formatDateTime` → `12/01/2027 07:30`                                                        |
| `formatNumber`, `formatPercent`                                                                      | nombres en notation française                                                                                                                           |
| `formatSigned(-120, 0, "L")`, `formatSignedPercent(1.84, 2)`                                         | écarts **signés** → `−120 L`, `+1,84 %` (vrai signe moins, pas de « −0 »)                                                                               |
| `todayLocal()`, `addDays`, `daysUntil`, `dayBoundsUtc`, `secondsToHM`, `hmToSeconds`, `parseDecimal` | aides de dates, d'heures et de saisie                                                                                                                   |

### Alertes de la coquille — `@/lib/alerts`

```tsx
usePublishAlerts("plan-violations", [
  { id: "v", severity: "blocking", title: "3 violations bloquantes", to: "/plan" },
]);
```

La coquille publie elle-même deux alertes, quel que soit l'écran : permis / habilitations expirés ou proches,
et **version du plan restée en brouillon** après un événement (`GET /dashboard` → `pending_draft`), avec un lien
vers `/plan?plan=<id>&day=<jour>`, pour tous les rôles qui voient l'écran Plan (`src/app/shell/pendingDraft.ts`).

## Composants partagés — `@/components`

Principes : densité élevée, tout faisable au clavier dans les tableaux, aucune action destructive sans
confirmation, violations toujours sous la même forme, heures en `HH:mm` de Douala.

### `DataTable` (+ `useDataTableState`, `RowActions`)

Tri, recherche, filtres, pagination, sélection multiple, actions en masse, édition en ligne. Deux modes :
**local** (sans `total` : le tableau trie, filtre et pagine les lignes reçues — à retenir dès qu'il faut un
tri, l'API n'en offrant pas) ou **serveur** (`total` fourni : recherche, filtres et pagination délégués ;
en-têtes triables seulement avec `serverSort`). `onRowsChange` donne les lignes retenues (ex. pour la carte).

```tsx
const columns = useMemo<ColumnDef<Truck>[]>(
  () => [
    { accessorKey: "plate", header: "Immatriculation" },
    {
      accessorKey: "total_capacity_l",
      header: "Capacité",
      meta: { align: "right" },
      cell: ({ row }) => formatLiters(row.original.total_capacity_l),
    },
    {
      accessorKey: "status",
      header: "Statut",
      cell: ({ row }) => <StatusBadge kind="truck" value={row.original.status} />,
      meta: {
        edit: {
          type: "select",
          options,
          onCommit: (row, value) => update.mutateAsync({ id: row.id, input: { status: value } }),
        },
      },
    },
    {
      id: "actions",
      enableSorting: false,
      cell: ({ row }) => <RowActions items={[{ label: "Modifier", onSelect: () => edit(row.original) }]} />,
    },
  ],
  [],
);

<DataTable
  caption="Camions"
  columns={columns}
  data={trucks.useAll().data ?? []} // toutes les lignes : tri, recherche et filtres locaux
  state={state}
  onStateChange={setState}
  getRowId={(r) => r.id}
  searchable
  filters={[{ id: "status", label: "Statut", options }]}
  selectable
  bulkActions={[{ label: "Supprimer", destructive: true, onClick: removeRows }]}
  onRowActivate={edit}
  highlightedRowId={selectedId}
  onRowFocus={(r) => setSelectedId(r?.id ?? null)}
/>;
```

Clavier : flèches · Début / Fin · Ctrl+Début / Ctrl+Fin · Page préc. / suiv. (page) · Entrée ou F2 (modifier la
cellule, ouvrir le menu d'actions, sinon ouvrir la ligne) · saisie directe (remplace la valeur) · Entrée / Tab
(valider) · Échap (annuler / désélectionner) · Espace (sélectionner) · Ctrl+A (toute la page).
**Mémoriser `columns`** (`useMemo`) : une nouvelle définition à chaque rendu remonte toutes les cellules.

Options ajoutées pour les écrans de vague 2 (facultatives, défauts inchangés) :

```tsx
<DataTable …
  footer={(rows) => <Totals orders={rows} />}                 // ligne de totaux : lignes retenues, toutes pages
  selectedRowIds={ids} onSelectionChange={(next) => setIds(next)}   // sélection pilotée ; setIds([]) la vide
  onCellError={(error, row) => showViolations(error)}         // échec d'édition : remplace la notification
/>
// colonne : choix dépendant de la ligne, traitement d'erreur propre à la colonne
meta: { edit: { type: "select", options: (row) => allowedStatuses(row), onCommit, onError } }
```

### `MapView` (+ `routeColor`, types `MapPoint`, `MapRoute`)

Marqueurs dépôts (carrés) et stations (ronds), tracés de tournées colorés, arrêts numérotés, détail au survol,
cadrage automatique, sélection, clic sur le fond (`onMapClick`).

```tsx
<MapView className="h-96" legend selectedId={stopId} onSelect={(id, kind) => …}
  points={depots.map((d) => ({ id: d.id, kind: "depot", lat: d.lat, lon: d.lon, label: d.name, detail: [d.code] }))}
  routes={trips.map((t, i) => ({ id: t.id, color: routeColor(i), dimmed: t.id !== current,
    path: [depot, ...t.stops, depot],
    stops: t.stops.map((s) => ({ id: s.id, seq: s.seq, lat: s.lat, lon: s.lon, label: s.station_name,
                                 detail: [`${formatLocalTime(s.planned_arrival_at)} — ${formatLiters(s.volume_l)}`] })) }))} />
```

Repli : sans `VITE_TILES_URL` ou si les tuiles ne répondent pas, fond uni et mention discrète ; sans WebGL
(ou `renderer="schematic"`), vue schématique SVG avec les mêmes données. Aucun test ne dépend du réseau.
`path` accepte une géométrie routière (liste de points) quand le serveur en fournit une.

Ajouts pour les écrans Plan et Comparaison (tous facultatifs, comportement par défaut inchangé) :

```tsx
const bounds = boundsOf([...pointsA, ...pointsB], [...routesA, ...routesB]);   // même cadrage, même échelle
<MapView bounds={bounds} points={pointsA} routes={routesA} />
<MapView bounds={bounds} points={pointsB} routes={routesB} />

<MapView routes={routes} focusRouteId={selectedTripId}                // recadre sur la tournée ; null = tout
  onRouteClick={(id) => selectTrip(id)} onRouteHover={(id) => setHoveredTrip(id)}   // clic / survol du TRACÉ
  points={[{ id, kind: "station", variant: "unserved", lat, lon, label }]} />        // losange pointillé « non servie »
```

`dimmed` sur une tournée atténue aussi ses arrêts. `routeColor(i)` ne boucle qu'après 30 tournées ; les
10 premières couleurs sont figées (le PDF de comparaison les reprend). `routeBounds(route)` donne l'emprise
d'une tournée.

La bulle de détail au survol reste toujours dans le cadre de la carte (elle bascule sous le marqueur ou se
décale près d'un bord, y compris pour un marqueur hors champ après un recadrage) — `placeTooltip` dans
`map/geometry.ts`.

### `ViolationsPanel`

```tsx
<ViolationsPanel violations={plan.violations} onSelect={(v) => focusTrip(v.trip_id)} />
<ViolationsPanel violations={apiError.violations} />   {/* refus 409 d'une publication */}
```

Rouge = bloquant, orange = avertissement, code RM-xx en tête, bloquantes d'abord, compteurs dans l'en-tête.

`maxListHeight` (`"40vh"`, `240`, `"none"`) règle la hauteur de la liste avant défilement (défaut : 16 rem).
Une violation peut porter un `id` (clé stable de la ligne).

### `ConfirmDialog` / `useConfirm`

```tsx
const confirm = useConfirm();
if (await confirm({ title: fr.confirm.deleteTitle, description: fr.confirm.deleteOne(name), destructive: true })) …
```

Action destructive : bouton rouge, focus initial sur « Annuler » (Entrée ne confirme pas par réflexe).

### `ImportDialog`

```tsx
<ImportDialog
  kind="orders"
  fields={{ day }}
  open={open}
  onOpenChange={setOpen}
  onApplied={() => list.refetch()}
/>
```

Fichier (.xlsx / .csv, glisser-déposer) → prévisualisation → rapport ligne par ligne (création, mise à jour
avec les champs « avant → après », inchangée, anomalies avec colonne et valeur fautive) → appliquer. Rien
n'est écrit avant « Appliquer » ; `can_apply` du serveur fait foi. Téléchargement du fichier modèle.

`fields` (ex. `{ day }` pour les commandes) est transmis en **paramètres de requête** de la prévisualisation
(`POST /imports/orders/preview?day=AAAA-MM-JJ`) : c'est là que l'API lit les options d'un import.

### Formulaires — `EntityFormDialog`, champs, briques zod

```tsx
const schema = z.object({
  code: zText(32),
  volume_l: zLiters(),
  window_start: zTimeHM,
  opening_hours: zOpeningHours,
  lat: zLat,
  lon: zLon,
});

<EntityFormDialog
  open={open}
  onOpenChange={setOpen}
  title="Nouvelle station"
  schema={schema}
  defaultValues={defaults}
  onSubmit={(values) => create.mutateAsync(values)}
>
  <FormSection title="Identité">
    <FieldRow cols={3}>
      <TextField name="code" label="Code" required mono uppercase />
      <LitersField name="volume_l" label="Volume" required />
      <TimeField name="window_start" label="Début de fenêtre" />
    </FieldRow>
  </FormSection>
  <CoordinatesField latName="lat" lonName="lon" kind="station" />
  <OpeningHoursField name="opening_hours" />
</EntityFormDialog>;
```

- champs : `TextField`, `TextAreaField`, `NumberField` (unité, virgule ou point), `LitersField` (milliers
  groupés), `TimeField` (`630` → `06:30`), `DateField` (affiché et saisi en `jj/mm/aaaa`), `SelectField`, `SwitchField`, `ColorField`,
  `OpeningHoursField` (continu, ou plages par jour), `CoordinatesField` (latitude / longitude + mini-carte,
  clic pour placer, collage de « lat, lon ») ; saisies nues : `NumberInput`, `TimeInput`, `DateInput`, `ChipsInput`,
  `OpeningHoursInput` ;
- zod : `zText`, `zCode`, `zOptionalText`, `zNumber`, `zOptionalNumber`, `zLiters`, `zTimeHM`, `zOptionalDay`, `zLat`,
  `zLon`, `zColor`, `zOptionalEmail`, `zOpeningHours` ; vide → `null` pour tout champ facultatif ;
- `EntityFormDialog` gère la validation, l'attente, les erreurs 422 / 409 reportées sur les champs
  (`applyApiErrors`) et la confirmation avant d'abandonner une saisie ; `useZodForm` pour un formulaire hors boîte.

`DateInput` remplace le champ natif `type="date"`, dont le format suit la langue du navigateur : affichage
`jj/mm/aaaa` partout, saisie libre (`12/01/2027`, `12012027`, `12/1/27`, `2027-01-12`), flèches haut / bas
= jour suivant / précédent, bouton calendrier ouvrant le sélecteur natif. Valeur : `YYYY-MM-DD` ou `null`.

```tsx
<DateInput aria-label="Du" value={from} onChange={setFrom} />
```

### `SortableList` (dnd-kit)

```tsx
<SortableList
  items={stops}
  getId={(s) => s.id}
  onReorder={(next, { from, to }) => reorder(next)}
  renderItem={(stop, handle) => (
    <div className="flex items-center">
      {handle}
      {stop.station_name}
    </div>
  )}
/>
```

Glisser-déposer à la souris, et au clavier (Espace pour saisir, flèches, Espace pour poser).

Entre deux listes : `context="parent"` inscrit la liste dans le `<DndContext>` du parent, qui traite alors
`onDragEnd` (`onReorder` n'est pas appelé).

```tsx
const sensors = useSortableSensors(); // mêmes capteurs que la liste autonome
<DndContext sensors={sensors} onDragEnd={moveStop}>
  {trips.map((trip) => (
    <SortableList
      key={trip.id}
      context="parent"
      id={trip.id}
      items={trip.stops}
      getId={(s) => s.id}
      onReorder={() => {}}
      renderItem={(stop, handle) => <StopRow stop={stop} handle={handle} />}
    />
  ))}
</DndContext>;
```

Compléments (tous facultatifs) : `as="tbody"` rend `<tbody>` / `<tr>` (lignes de tableau, `renderItem` renvoie
les `<td>`) ; `isDisabled={(item) => …}` fige un élément seul (arrêt livré ou sauté) ; `rowClassName` et
`rowProps` habillent la ligne ; le 4ᵉ argument de `renderItem` (`SortableRowState` : `isDragging`, `isOver`,
`isSorting`, `activeId`, `insert: "before" | "after" | null`, `disabled`) sert au repère d'insertion.

### Statuts, états, notifications, PDF

```tsx
<StatusBadge kind="order" value={order.status} />      // truck · driver · order · plan · trip · stop · import · priority · active · severity · audit · event
<ExpiryBadge date={driver.license_expiry} />           // rouge si expiré, orange si proche
<EmptyState title="Aucune commande" action={<Button>Importer</Button>} />
<LoadingState /> · <ErrorState error={error} onRetry={refetch} /> · <Skeleton /> · <Spinner />
notify.success("Plan publié"); notify.apiError(error, fr.errors.saveFailed);   // message serveur + codes RM-xx
<PdfButton path={`/trips/${id}/route-sheet.pdf`} label="Feuille de route" />
<PageHeader title="…" subtitle="…" actions={…} /> · <Notice tone="warning">…</Notice>   // info · success · warning · blocking · neutral
```

Avancement et filtres :

```tsx
// Frise d'étapes : passées cochées, courante annoncée (aria-current="step")
<Steps label="Avancement de la tournée" current={trip.status}
       steps={TRIP_STATUSES.map((s) => ({ id: s, label: fr.status.trip[s] }))} />
// Barre segmentée : un segment par élément ; `segments` pour colorer chacun (livré, sauté, en attente)
<SegmentedProgress done={3} total={5} label="3 arrêts livrés sur 5" />
<SegmentedProgress segments={["success", "warning", "pending"]} label="…" />
// Puces de filtre à compteur (boutons à bascule)
<FilterChipGroup label="Filtrer par type">
  <FilterChip label="Tous" count={12} pressed={type === null} onClick={() => setType(null)} />
</FilterChipGroup>
```

`NumberInput` / `NumberField` avec `unit` : une largeur passée par `className` (`w-24`) dimensionne l'ensemble
champ + unité (l'unité reste collée au champ) ; `wrapperClassName` pour styler l'enveloppe.

Primitives (`components/ui/`) : `Button`, `Input`, `Textarea`, `NativeSelect`, `Label`, `Checkbox`, `Switch`,
`Dialog` (centré ou panneau latéral), `AlertDialog`, `DropdownMenu`, `Popover`, `Tabs`, `Tip`, `Badge`.
Couleurs et typographie : variables CSS de `src/styles/index.css` (pétrole pour la structure, ambre pour le
repère de navigation, rouge / orange réservés aux violations et alertes).

## Écrans livrés

- **Connexion** (1) : erreurs en français, retour à la page demandée, message après expiration.
- **Référentiels** (10) : stations (cuves, carte), dépôts (carte), camions (compartiments réordonnables,
  statut modifiable en ligne et en masse), chauffeurs (alertes permis / habilitation), produits, transporteurs ;
  import pour stations, dépôts, camions, chauffeurs ; lecture seule hors `admin`.
- **Administration** (11) : utilisateurs (création, rôle, activation, réinitialisation du mot de passe),
  paramètres (toutes les clés de `settings_store.DEFAULTS`, validation, récapitulatif avant enregistrement),
  journal d'audit (filtres table / ligne / acteur / période, diff avant → après).
- **Écrans 2 à 9** : pages d'attente routées, dans leur dossier.
