# Feuille de route — ce qu'il reste à faire

État vérifié le 19/10/2026 : 12 tests pytest et 3 tests Vitest passent, le plugin s'enregistre via le vrai registre Cordis, et aucune régression n'est connue. Le dépôt Git n'a en revanche **aucun commit**, la CI n'a jamais tourné et aucune licence n'est choisie.

## Déjà en place (à préserver)

- Chaîne YAML structuré → Pydantic → build123d/OpenCascade → STEP → révision immuable.
- Validation du BREP natif **et** du STEP réimporté (solide, encombrement, volume, trous).
- Provenance obligatoire (`measured` / `estimated` / `assumed`) et refus des données manquantes.
- Un outil Harness (`openengineer_build_bracket`) avec test d'intégration de bout en bout.
- Verrou POSIX, chemins confinés à la racine, sortie subprocess bornée, staging atomique.
- `part.step`, `parameters.yaml`, `record.json`, `report.md` par révision.

Le contrat à ne pas casser : **aucune donnée inventée silencieusement, aucune révision partielle, aucun code généré exécuté sans isolation revue.**

## Vue d'ensemble

| Priorité | Chantier | Effort | Dépend de |
|---|---|---|---|
| P0 | Dépôt partageable : commit, licence, CI verte | S | — |
| P1 | Contrat du plugin : sortie lisible, erreurs typées, outils de lecture | M | P0 |
| P2 | Acceptance réelle avec un provider LLM | S | P1 |
| P3 | Robustesse et portabilité (Windows, reprise après crash, intégrité) | M | P1 |
| P4 | Deuxième pièce, schéma enrichi, aperçu, exports fabrication | L | P2 |
| P5 | Photos, dialogue de mesures, isolation du code généré | L | P4 |
| P6 | Distribution npm/CLI et documentation utilisateur | M | P2 |

Effort indicatif : S < 1 jour, M = 1 à 3 jours, L = 1 à 2 semaines.

---

## P0 — Rendre le dépôt partageable (fait)

- [x] Faire le premier commit (commit initial).
- [x] Ajouter `.DS_Store` au `.gitignore` et supprimer le fichier présent.
- [x] Vérifier qu'aucun `.venv`, `node_modules`, `dist`, `artifacts`, `harness.local.yaml` ni secret n'entre dans le commit.
- [x] Choisir la licence : MIT, avec `LICENSE` et les champs de licence dans `pyproject.toml` / `package.json`.
- [x] Pousser le dépôt et faire tourner `.github/workflows/test.yml` sur Ubuntu ; la CI est verte en 33 s.
- [x] Ajouter un badge CI dans le README.

**Critère d'acceptation** : un clone neuf passe `uv sync --locked`, `pnpm install --frozen-lockfile`, `pnpm build`, 12 tests pytest et 3 tests Vitest, sur macOS et Ubuntu.

## P1 — Fermer le contrat du plugin

- [x] Remplacer le retour `string` (JSON brut) par un objet structuré avec un `render` lisible : révision, dimensions mesurées, checks, chemins.
- [x] Introduire des erreurs typées exploitables par l'agent : `VALIDATION`, `PATH`, `TIMEOUT`, `ABORTED`, `LOCK`, `EXPORT`, `GEOMETRY`, `IO`, `NOT_FOUND`, `ENGINE`, re-levées en `HarnessError`.
- [x] Compléter les tests de robustesse :
  - [x] timeout et annulation (`AbortSignal`) : le processus Python est bien terminé ;
  - [x] entrée > 1 Mo et `reason` vide ;
  - [x] champ JSON inconnu dans le protocole `--json` ;
  - [x] mode CLI classique (`--input/--output/--reason/--set`) ;
  - [x] verrou relâché après échec ;
  - [x] aucune révision publiée si l'import STEP échoue.
- [x] Rendre le dossier de sortie configurable (`artifactsDir`), avec confinement à la racine.
- [x] Ajouter des outils de lecture sans rebuild : `openengineer_list_revisions` et `openengineer_inspect_revision` (record, rapport, paramètres).
- [ ] Permettre l'édition des trous : soit un override `holes`, soit un outil dédié. Aujourd'hui seuls les 4 paramètres scalaires sont modifiables, les trous exigent une édition manuelle du YAML.
- [ ] Documenter le schéma YAML comme contrat public (version de schéma, champs, invariants).

**Critère d'acceptation** : depuis le chat, l'agent peut construire, modifier, lister et inspecter une révision sans parser de JSON brut, et chaque échec produit un code d'erreur stable.

## P2 — Acceptance réelle

- [ ] Session scriptée dans la Web UI avec un provider configuré :
  1. construction initiale ;
  2. changement de hauteur depuis la révision précédente ;
  3. entrée invalide (hauteur négative) ;
  4. tentative de lecture hors racine ;
  5. reprise d'une révision et vérification de l'historique.
- [ ] Capturer transcript, captures d'écran et latence par appel.
- [ ] Mettre à jour le README avec les résultats réels et les limites observées.

**Critère d'acceptation** : les 5 scénarios passent avec un LLM réel, et l'agent cite correctement les dimensions mesurées et le dossier d'artefacts.

## P3 — Robustesse et portabilité

- [ ] Windows : adapter le verrou (`msvcrt`/`portalocker`) et ajouter une matrice CI, **ou** assumer explicitement « POSIX uniquement » dans la doc et le message d'erreur.
- [ ] Reprise après crash : commande `openengineer doctor` qui signale les `.building-*` orphelins, le `.lock` et les révisions incohérentes, sans suppression automatique.
- [ ] Intégrité de l'historique : chaîne de hachage (`parent_hash` / `record_hash`) pour détecter une altération d'un `record.json`.
- [ ] Limites de ressources : mémoire du child, taille de sortie, groupe de processus tué en entier, permissions du staging.
- [ ] Rétention : option `--keep N` et politique de nettoyage des vieilles révisions.
- [ ] Revoir le risque TOCTOU sur les chemins (`realpath` puis spawn) et le documenter.

## P4 — Passer d'une pièce à un outil CAO

- [ ] Implémenter une deuxième recette (plaque, équerre renforcée ou profil en U) pour justifier une vraie interface de backend, sans casser le contrat spec/validation.
- [ ] Enrichir le schéma : rayon de pli, congés, motifs de trous, fraisures, tolérances, matériau ; ajouter les contrôles de fabricabilité correspondants.
- [ ] Persister la recette de construction (historique de features) : le STEP n'est pas un fichier d'historique.
- [ ] Produire un aperçu visuel : rendu PNG/SVG isométrique coté, intégré au rapport et exploitable dans la GUI.
- [ ] Exports fabrication : STL/3MF/DXF, plan coté, masse, centre de masse.
- [ ] Traçabilité des exigences : chaque `requirements` devient un check « vérifié / non vérifié / hors périmètre ».

## P5 — Mesure et génération (recherche)

- [ ] Ingestion de photos : proposer des dimensions candidates avec un niveau de confiance, **confirmation humaine obligatoire**, provenance `estimated`.
- [ ] Dialogue de mesures manquantes : demander à l'utilisateur au lieu d'inférer.
- [ ] Isolation pour tout code généré : conteneur ou WASM, réseau coupé, FS read-only, limites CPU/mémoire, threat model revu. **Prérequis absolu avant d'activer la génération de code.**

## P6 — Distribution

- [ ] Publier le bundle npm du plugin et documenter l'installation (le chemin actuel est un checkout local).
- [ ] Packaging CLI (`uvx`/`pipx`), suppression du venv codé en dur, génération automatique du patch Harness.
- [ ] Matrice de compatibilité Harness/Cordis/Schemastery et politique de mise à jour.
- [ ] Guide utilisateur, troubleshooting, galerie d'exemples.

---

## Décisions à prendre

1. **Licence** : MIT (choisi).
2. **Périmètre** : outil local personnel, ou produit publiable avec support Windows.
3. **Photos et code généré** : fonctionnalités du produit, ou restent hors périmètre après la V1 ?
4. **Distribution** : plugin npm versionné, ou installation depuis un checkout.

## Ordre recommandé pour les 3 prochaines actions

1. Acceptance réelle dans la Web UI.
2. Édition des trous, puis documentation du schéma YAML.
3. Deuxième recette **ou** aperçu visuel (selon la démo visée).

## Risques principaux

- Wheels OpenCascade sur Windows : à valider lors de P3 (Ubuntu est validé par la CI).
- `execFile` + `timeout` envoie SIGTERM : un build123d bloqué peut survivre, d'où le test et le kill du groupe de processus.
- La promesse « Cursor for CAD » attire vers photos et génération de code, qui sont les deux plus gros chantiers et les plus risqués : ne pas les annoncer avant P5.
- Un historique local n'est pas infalsifiable : le documenter plutôt que le surpromettre.
