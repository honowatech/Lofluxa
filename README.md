# Tournéo

Logiciel de planification des tournées de livraison carburant — prototype pour OLA Energy Cameroun,
réalisé par Honowa Technologies.

- Spécification : [docs/SPEC_MVP_Tourneo.md](docs/SPEC_MVP_Tourneo.md)
- Plan de réalisation, lots et vagues : [docs/PLAN.md](docs/PLAN.md)
- Contrats entre modules : [docs/CONTRATS.md](docs/CONTRATS.md)
- Questions ouvertes : [docs/QUESTIONS.md](docs/QUESTIONS.md)
- Conventions de développement : [CLAUDE.md](CLAUDE.md)

## Démarrage rapide (développement, sans Docker)

```bash
./scripts/dev_setup.sh
```

```bash
cd backend && uv run pytest
```

```bash
cd backend && uv run uvicorn app.main:app_instance --reload
```

Documentation interactive de l'API : http://localhost:8000/api/v1/docs
