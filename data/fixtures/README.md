# Jeux de données fictifs du moteur (spec §7.5)

| Jeu | Contenu | Attendu |
|---|---|---|
| `demo_douala` | 1 dépôt, 12 stations, 4 camions (2 gabarits), 5 chauffeurs, 3 produits, 20 commandes dont 2 urgentes, 1 station à gabarit limité, 1 fenêtre étroite | tout servi, 0 violation, ≤ 10 s |
| `demo_shortage` | `demo_douala` avec 30 000 L de gasoil au dépôt pour 43 000 L demandés | non-servies avec `depot_stock` |
| `demo_scale` | 2 dépôts (SCDP Douala, SCDP Yaoundé), 70 stations dans 24 villes, 25 camions, 28 chauffeurs, 120 commandes | < 60 s, aucune violation bloquante |

Chaque jeu est un `problem.json` : sérialisation de `PlanningProblem` (`backend/app/planning/fixtures.py`,
`load_problem(nom)` / `dump_problem(problème, chemin)`). Données entièrement fictives ; coordonnées approximatives.

Ne pas modifier ces fichiers à la main : ils sont produits par le générateur à graine fixe.

```bash
cd backend && uv run python ../scripts/gen_fixtures.py           # régénérer
cd backend && uv run python ../scripts/gen_fixtures.py --check   # vérifier qu'ils sont à jour
```
