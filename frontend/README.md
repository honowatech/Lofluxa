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

| Commande        | Rôle                                                                                                                                                                                                                                                                                                           |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm dev`      | serveur de développement                                                                                                                                                                                                                                                                                       |
| `pnpm build`    | contrôle des types + site statique dans `dist/` (servi par Caddy)                                                                                                                                                                                                                                              |
| `pnpm lint`     | ESLint (zéro avertissement) + Prettier                                                                                                                                                                                                                                                                         |
| `pnpm test`     | Vitest + Testing Library + MSW                                                                                                                                                                                                                                                                                 |
| `pnpm e2e`      | Playwright, **contre la vraie API, sans doublure** : connexion → coquille → rafraîchissement du jeton → déconnexion ; créer un dépôt et une station → carte ; importer `data/templates/stations.xlsx` → prévisualiser → appliquer ; paramètre modifié → audit. Rejouable (les données créées sont supprimées). |
| `pnpm captures` | régénère `docs/captures/*.png` (doublures complètes, aucun back-end requis)                                                                                                                                                                                                                                    |

### Variables d'environnement (`.env.example`)

| Variable                 | Effet                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VITE_MOCKS`             | `off` (défaut) : vraie API. `partial` : seules les routes non encore livrées sont simulées (liste `undelivered` de `src/mocks/handlers/index.ts`, vide aujourd'hui). `full` : tout est simulé, connexion comprise (démo et captures sans back-end ; comptes `…@ola.example` / `demo-dev-only` pour chaque rôle, voir `src/mocks/db.ts`). Un badge orange dans l'en-tête signale les données simulées. |
| `VITE_API_BASE_URL`      | Préfixe de l'API vu du navigateur (défaut `/api/v1`, fixé par l'image Docker `infra/frontend`).                                                                                                                                                                                                                                                                                                       |
| `VITE_TILES_URL`         | Gabarit des tuiles raster du fond de carte (`https://…/{z}/{x}/{y}.png`). Vide : carte sans fond, positions à l'échelle.                                                                                                                                                                                                                                                                              |
| `VITE_TILES_ATTRIBUTION` | Mention de source affichée sur la carte.                                                                                                                                                                                                                                                                                                                                                              |
| `VITE_API_PROXY`         | Cible du proxy de développement (défaut `http://localhost:8000`).                                                                                                                                                                                                                                                                                                                                     |

Les routes d'authentification, de référentiels, d'imports et d'administration sont **livrées** (lots L3 et
L8) : les écrans Référentiels et Administration parlent à la vraie API, et leurs doublures — alignées sur
l'OpenAPI réelle — ne servent plus qu'aux tests Vitest et au mode `full`. Un écran de vague 2 dont les routes
n'existent pas encore ajoute ses doublures à `undelivered`, puis les en retire. Les doublures ne sont pas
incluses dans le build quand `VITE_MOCKS` est absent ou `off`.

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
  `duplicate` → champs), `retryAfter` (429 `rate_limited`, secondes) ;
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

### Jour J — `@/lib/useDay`

`const { day, setDay, isToday, previous, next } = useDay();` — conservé dans l'URL (`?day=`), par défaut le
jour courant à Douala, transmis par les liens de navigation. `withDay(path, day)` pour un lien interne.

### Formatage — `@/lib/format`

| Fonction                                                                                             | Entrée → sortie                                                                                  |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `formatLiters(12000)`                                                                                | litres → `12 000 L`                                                                              |
| `formatKm(12400)`                                                                                    | **mètres** → `12,4 km`                                                                           |
| `formatDuration(7500)`                                                                               | **secondes** → `2 h 05`                                                                          |
| `formatLocalTime("2027-01-12T06:30:00Z")`                                                            | horodatage UTC → `07:30` (Africa/Douala, RM-20)                                                  |
| `formatDate("2027-01-12")`                                                                           | → `12/01/2027` ; `formatDateLong` → `mar. 12 janv. 2027` ; `formatDateTime` → `12/01/2027 07:30` |
| `formatNumber`, `formatPercent`                                                                      | nombres en notation française                                                                    |
| `todayLocal()`, `addDays`, `daysUntil`, `dayBoundsUtc`, `secondsToHM`, `hmToSeconds`, `parseDecimal` | aides de dates, d'heures et de saisie                                                            |

### Alertes de la coquille — `@/lib/alerts`

```tsx
usePublishAlerts("plan-violations", [
  { id: "v", severity: "blocking", title: "3 violations bloquantes", to: "/plan" },
]);
```

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

### `ViolationsPanel`

```tsx
<ViolationsPanel violations={plan.violations} onSelect={(v) => focusTrip(v.trip_id)} />
<ViolationsPanel violations={apiError.violations} />   {/* refus 409 d'une publication */}
```

Rouge = bloquant, orange = avertissement, code RM-xx en tête, bloquantes d'abord, compteurs dans l'en-tête.

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
  groupés), `TimeField` (`630` → `06:30`), `DateField`, `SelectField`, `SwitchField`, `ColorField`,
  `OpeningHoursField` (continu, ou plages par jour), `CoordinatesField` (latitude / longitude + mini-carte,
  clic pour placer, collage de « lat, lon ») ; saisies nues : `NumberInput`, `TimeInput`, `ChipsInput`,
  `OpeningHoursInput` ;
- zod : `zText`, `zCode`, `zOptionalText`, `zNumber`, `zOptionalNumber`, `zLiters`, `zTimeHM`, `zOptionalDay`, `zLat`,
  `zLon`, `zColor`, `zOptionalEmail`, `zOpeningHours` ; vide → `null` pour tout champ facultatif ;
- `EntityFormDialog` gère la validation, l'attente, les erreurs 422 / 409 reportées sur les champs
  (`applyApiErrors`) et la confirmation avant d'abandonner une saisie ; `useZodForm` pour un formulaire hors boîte.

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

### Statuts, états, notifications, PDF

```tsx
<StatusBadge kind="order" value={order.status} />      // truck · driver · order · plan · trip · stop · import · priority · active · severity · audit
<ExpiryBadge date={driver.license_expiry} />           // rouge si expiré, orange si proche
<EmptyState title="Aucune commande" action={<Button>Importer</Button>} />
<LoadingState /> · <ErrorState error={error} onRetry={refetch} /> · <Skeleton /> · <Spinner />
notify.success("Plan publié"); notify.apiError(error, fr.errors.saveFailed);   // message serveur + codes RM-xx
<PdfButton path={`/trips/${id}/route-sheet.pdf`} label="Feuille de route" />
<PageHeader title="…" subtitle="…" actions={…} /> · <Notice tone="warning">…</Notice>
```

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
