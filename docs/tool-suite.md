# Suite d'outils CAD pour DeepSeek Harness

Objectif : une suite d'outils typés, utilisables comme plugin Harness, qui permet à l'agent de concevoir des pièces mécaniques, de les assembler, d'en dériver une BOM, de simuler et d'optimiser — sans écrire de code CAO libre.

## Statut

**Slice 1 implémentée** (`cad_*`) : projet, pièces, extrude, perçage, congé, chanfrein, tube, reconstruction, validation, masse, matériaux, exports STEP/STL/glTF et révisions immuables. Les outils sont enregistrés par le plugin à côté des outils `openengineer_*` existants.

Le stockage réel est plus simple que le schéma cible ci-dessous : le projet vit directement dans la racine configurée (`project.json`, `parts/`, `artifacts/`, `revisions/`, `.lock`) et non dans un sous-dossier `project/`.

## Principes

1. **Déterministe d'abord.** L'agent émet une spec structurée ; le backend construit, valide et versionne. Pas de Python généré par le modèle.
2. **Un outil = une opération atomique validée.** Si l'opération échoue, le brouillon n'est pas modifié.
3. **IDs stables, features ordonnées.** Toute reconstruction est reproductible à partir du JSON.
4. **Brouillon puis commit.** Les outils modifient un brouillon ; `cad_project_commit` fige une révision immuable.
5. **Jobs asynchrones** pour tout ce qui dépasse quelques secondes (FEA, TO, exports lourds).
6. **Erreurs typées** avec code stable, message et suggestion quand c'est possible.
7. **Le contexte de l'agent reste léger.** Les outils renvoient des résumés et des chemins, jamais des B-rep.

## Namespace

Les nouveaux outils utilisent le préfixe `cad_`. Les outils `openengineer_*` existants restent comme démonstration et seront réimplémentés par-dessus l'API `cad_`.

## Catalogue

### Projet

| Outil | Rôle | Phase |
|---|---|---|
| `cad_project_create` | Créer le projet (nom, unités) | 1 |
| `cad_project_status` | État du brouillon, compteurs, dernière révision | 1 |
| `cad_project_commit` | Figer une révision immuable | 1 |
| `cad_project_history` | Lister les révisions | 1 |
| `cad_project_diff` | Diff brouillon / dernière révision | 2 |

### Pièces et features

| Outil | Rôle | Phase |
|---|---|---|
| `cad_part_create` | Créer une pièce | 1 |
| `cad_part_list` | Lister les pièces | 1 |
| `cad_part_get` | Spec, features, masse, bbox | 1 |
| `cad_part_update` | Nom, matériau, métadonnées | 1 |
| `cad_part_delete` | Supprimer du brouillon | 2 |
| `cad_part_rebuild` | Reconstruire et valider | 1 |
| `cad_feature_extrude` | Extruder un profil | 1 |
| `cad_feature_hole` | Perçage simple / traversant | 1 |
| `cad_feature_fillet` | Congé sur sélection d'arêtes | 1 |
| `cad_feature_chamfer` | Chanfrein, y compris arêtes de trous | 1 |
| `cad_feature_tube` | Tube : diamètre extérieur, longueur, épaisseur ou diamètre intérieur | 1 |
| `cad_feature_pattern` | Motif linéaire / circulaire | 2 |
| `cad_feature_revolve` | Révolution | 2 |
| `cad_feature_shell` | Coque | 3 |
| `cad_feature_update` | Modifier une feature | 2 |
| `cad_feature_delete` | Supprimer une feature | 2 |
| `cad_feature_reorder` | Réordonner | 2 |

### Assemblage et BOM

| Outil | Rôle | Phase |
|---|---|---|
| `cad_assembly_create` | Créer un assemblage | 2 |
| `cad_assembly_list` | Lister | 2 |
| `cad_assembly_add_instance` | Ajouter une pièce + transformation | 2 |
| `cad_assembly_remove_instance` | Retirer une instance | 2 |
| `cad_assembly_add_mate` | Contrainte (coïncidence, distance, angle, pivot, glissière) | 3 |
| `cad_assembly_solve` | Résoudre les DOF, détecter sur-contraintes | 3 |
| `cad_interference_check` | Détecter les collisions | 2 |
| `cad_assembly_export` | STEP d'assemblage avec hiérarchie | 2 |
| `cad_bom_generate` | BOM multi-niveaux | 2 |
| `cad_bom_export` | CSV / XLSX | 2 |
| `cad_bom_get` | Lire la BOM courante | 2 |

### Validation, matériaux, exports

| Outil | Rôle | Phase |
|---|---|---|
| `cad_check_geometry` | Intégré à `cad_part_get` / `cad_part_rebuild` : solide valide, unique, volume fini | 1 |
| `cad_mass_properties` | Intégré aux résumés de pièce : volume, masse, centre de masse, bbox | 1 |
| `cad_material_list` | Bibliothèque matériaux | 1 |
| `cad_part_set_material` | Assigner un matériau | 1 |
| `cad_material_create` | Matériau personnalisé | 2 |
| `cad_part_export` | STEP, STL, glTF (3MF, DXF, SVG, PDF plus tard) | 1 |
| `cad_render` | Rendu PNG (iso, face, dessus, coupe) | 2 |
| `cad_drawing_create` | Plan coté | 4 |

### Simulation

| Outil | Rôle | Phase |
|---|---|---|
| `cad_study_create` | Étude statique, modale ou thermique | 3 |
| `cad_study_set_mesh` | Taille, ordre, convergence | 3 |
| `cad_study_add_boundary` | Appui, encastrement, déplacement | 3 |
| `cad_study_add_load` | Force, pression, gravité | 3 |
| `cad_study_run` | Lancer le job | 3 |
| `cad_job_status` | État, progression, logs | 3 |
| `cad_job_cancel` | Annuler | 3 |
| `cad_job_result` | Résultats, contraintes, déplacements, convergence | 3 |
| `cad_study_report` | Rapport markdown | 3 |

### Optimisation topologique

| Outil | Rôle | Phase |
|---|---|---|
| `cad_topopt_create` | Espace de conception, charges, fraction volumique | 4 |
| `cad_topopt_run` | Lancer le job SIMP | 4 |
| `cad_topopt_reconstruct` | Champ de densité → STEP | 4 |
| `cad_topopt_compare` | Masse / contrainte avant-après | 4 |

## Modèle de données

```
project/
  project.json                 # schéma, nom, unités, matériaux par défaut
  parts/<part-id>.json         # spec + features ordonnées
  assemblies/<assembly-id>.json
  materials.json               # matériaux personnalisés
  studies/<study-id>.json
  artifacts/<object>/<hash>/   # STEP, STL, glTF, PNG, CSV, XLSX
  revisions/<revision-id>/     # snapshot JSON + manifest de hashes
  .jobs/<job-id>/              # status.json, log.txt, results/
  .lock
```

### Pièce

```json
{
  "schema": 1,
  "id": "part-0001",
  "name": "support-moteur",
  "material": "alu-6061",
  "features": [
    { "id": "feature-001", "type": "extrude",
      "profile": { "shape": "rectangle", "width": 80, "height": 40 },
      "plane": "XY", "distance": 6, "operation": "add" },
    { "id": "feature-002", "type": "hole",
      "x": 20, "y": 20, "diameter": 6, "through": true },
    { "id": "feature-003", "type": "fillet",
      "selector": { "kind": "parallel", "axis": "z" }, "radius": 3 }
  ]
}
```

### Assemblage

```json
{
  "schema": 1,
  "id": "assembly-0001",
  "name": "support-complet",
  "instances": [
    { "id": "inst-001", "part": "part-0001",
      "transform": { "translation": [0, 0, 0], "rotation": [0, 0, 0] } },
    { "id": "inst-002", "part": "part-0002",
      "transform": { "translation": [0, 0, 12], "rotation": [0, 0, 90] } }
  ],
  "mates": []
}
```

La BOM n'est pas stockée à la main : elle est projetée depuis les instances, avec quantités, matériaux, masses et numéros.

## Contrat des features

- **Profils** : rectangle, cercle, polygone, slot. Plan `XY`, `XZ`, `YZ` avec offset optionnel.
- **Opérations** : `add`, `cut`, `intersect`.
- **Perçage** : position, diamètre, profondeur ou traversant, direction, fraisure/lamage plus tard.
- **Sélecteurs d'arêtes** :
  - `{ "kind": "all" }`
  - `{ "kind": "parallel", "axis": "x" | "y" | "z" }`
  - `{ "kind": "box", "min": [x,y,z], "max": [x,y,z] }`
  - `{ "kind": "circular", "diameter": 6, "center": [20,20], "z": "top" }` (filtres optionnels)
  - `{ "kind": "holes", "z": "top" | "bottom" | "both" }` (toutes les arêtes des perçages)
- **Pas de références topologiques persistantes en v1.** La pièce est reconstruite intégralement à chaque modification, dans l'ordre des features. C'est plus lent mais déterministe.

### Primitives de haut niveau

La généralisation ne passe pas par une recette par pièce, mais par un jeu de primitives et de modificateurs ordonnés. `cad_feature_tube` en est l'exemple : un seul appel `outer_diameter=100, wall_thickness=2, length=80` construit le cylindre extérieur, le alésage intérieur et la soustraction, au lieu de demander au modèle d'enchaîner deux extrusions. Le catalogue s'étend par primitives (tube, boîte, plaque, révolution) et par modificateurs (perçage, congé, chanfrein, motif, coque), jamais par un outil dédié à un client.

## Reconstruction et validation

Chaque mutation :

1. écrit la spec dans un fichier temporaire ;
2. reconstruit la pièce ;
3. valide : solide unique, valide, watertight, volume positif ;
4. calcule masse, centre de masse, bbox ;
5. seulement alors, remplace le brouillon.

`cad_part_rebuild` force la reconstruction et renvoie les checks. Le commit fige la spec et les hashes d'artefacts.

## Assemblage

- **Phase 2** : transformations fixes, détection d'interférences, BOM, export STEP. Pas encore de solveur de contraintes.
- **Phase 3** : mates et solveur DOF. Les pièces restent des solides ; les contraintes référencent des plans/axes/points nommés par l'instance.

## Simulation

- Matériaux : `E`, `ν`, limite élastique, densité, conductivité, dilatation.
- Maillage : gmsh, taille globale + raffinement local, contrôle de qualité.
- Solveur : CalculiX (`ccx`) pour la statique linéaire et le modal.
- Résultats : contraintes de von Mises, déplacements, facteur de sécurité, convergence, énergie.
- Job : sous-processus avec `status.json`, logs, annulation, timeout.
- Validation : cas analytiques (poutre encastrée, plaque trouée) avec tolérances.

## Optimisation topologique

- **v1 réaliste** : SIMP 2.5D, domaine 2D extrudé, un ou deux cas de charge, fraction volumique, filtre de densité.
- Reconstruction : seuil → contours → lissage → extrusion → STEP.
- Re-analyse du STEP reconstruit, pas du champ de densité.
- Contraintes : épaisseur mini, symétrie ; surplomb plus tard.

## Mapping Harness

- Un seul plugin Cordis, `inject: ['tools']`, config `root`, `python`, `artifactsDir`.
- Chaque outil : schéma d'entrée strict, schéma de sortie structuré, `render` lisible.
- Erreurs : `VALIDATION`, `NOT_FOUND`, `CONFLICT`, `PATH`, `LOCK`, `GEOMETRY`, `EXPORT`, `IO`, `TIMEOUT`, `ABORTED`, `JOB`, `ENGINE`.
- Lecture seule : `isConcurrencySafe: true`.
- Mutations : verrou projet, jamais parallèles.
- Jobs : `cad_study_run` et `cad_topopt_run` rendent la main immédiatement avec un `job_id`.
- Images : les rendus PNG sont des fichiers ; le modèle ne les voit pas, l'utilisateur si.

## Découpage proposé

### Slice 1 — Pièce paramétrique (fait)

Outils : projet, pièce, extrude, hole, fillet, chamfer, tube, rebuild, check, export, matériaux.

**Critère** : créer trois pièces différentes sans toucher au code, les modifier, les valider et exporter leurs STEP/STL. Vérifié avec une plaque percée/chanfreinée et un tube Ø100 × 80, épaisseur 2 mm.

### Slice 2 — Assemblage et BOM

Outils : assemblage, instances, interférences, export STEP, BOM, export XLSX, rendu.

**Critère** : assembler cinq pièces, détecter un chevauchement de 0,1 mm, produire une BOM juste.

### Slice 3 — Simulation statique

Outils : étude, matériaux, maillage, appuis, charges, job, résultats, rapport.

**Critère** : poutre encastrée à moins de 5 % de la solution analytique, maillage convergé.

### Slice 4 — Optimisation topologique

Outils : topopt create/run/reconstruct/compare.

**Critère** : −30 % de masse à contrainte admissible, STEP watertight, re-analyse conforme.

### Slice 5 — Plans, features avancées, cinématique

Coque, motif, révolution, plans cotés, mates, modal, thermique.

## Décisions ouvertes

1. **Familles de pièces prioritaires** : plaques/équerres, arbres, carters, profilés ?
2. **Procédé** : impression 3D, usinage, tôle, injection ?
3. **Fidélité simulation** : prototype ou pièce critique ?
4. **Assemblage** : transformations fixes suffisent pour la v1, ou mates dès la phase 2 ?
5. **Viewer** : rendu PNG suffit, ou viewer 3D interactif dans la GUI ?
6. **Calcul** : local ou worker dédié pour gmsh/CalculiX ?

## Hors périmètre v1

- Génération de code Python par le modèle.
- Reconstruction NURBS après TO.
- CFD.
- Certification, tolérances GD&T complètes, fatigue.
- Import STEP client avec réparation avancée.
