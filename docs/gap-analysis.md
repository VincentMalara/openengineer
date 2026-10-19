# De l'équerre au produit mécanique : analyse des manques

Objectif : depuis DeepSeek Harness, créer des pièces mécaniques paramétriques, exporter leurs STEP, produire une BOM, assembler plusieurs pièces, lancer des simulations et de l'optimisation topologique.

Le plugin actuel sait faire **une seule chose** : une équerre en L déterministe, avec deux trous, un STEP validé et un historique de révisions. Tout le reste est à construire. Le point important : le modèle DeepSeek n'est pas le goulot d'étranglement. Ce qui manque, c'est le **backend d'ingénierie** et la **surface d'outils typés** qu'on lui expose.

## État actuel vérifié

| Élément | Aujourd'hui |
|---|---|
| Pièces | Une recette codée en dur (`geometry.py`), 4 scalaires surchargeables |
| STEP | Export + réimport + validation, un solide |
| Historique | Révisions séquentielles par dossier de sortie |
| BOM | Aucune |
| Assemblage | Aucun |
| Simulation | Aucune |
| Optimisation topologique | Aucune |
| Visualisation | Texte uniquement, pas de viewer |
| Outils Harness | 3 : build, list, inspect |
| Runtime | Un processus local, pas de file de jobs |

Vérifications dans l'environnement actuel :

- `build123d 0.10.0` fournit `build123d.joints` (`RigidJoint`, `RevoluteJoint`, etc.) mais **pas de classe `Assembly` ni de solveur global de contraintes/DOF**.
- `numpy`, `scipy` et `vtk` sont présents.
- `gmsh`, `meshio`, `CalculiX`, `FEniCS`, `pyvista`, `torch` sont absents.
- Aucun maillage volumique, aucun solveur éléments finis, aucun outil de reconstruction CAO.

## Les huit couches manquantes

### 1. Modèle de projet et de données

Aujourd'hui, un dossier = une pièce = une suite de révisions. Il faut un modèle de projet :

- `project.json` : unités, tolérances par défaut, matériaux, standards.
- `parts/` : pièces paramétriques avec identifiant stable, numéro, révision, matériau, masse.
- `assemblies/` : graphe d'instances, transformations, contraintes, sous-assemblages.
- `bom/` : lignes dérivées de l'assemblage, quantités, make/buy, coûts.
- `studies/` : cas de charge, conditions aux limites, résultats, convergence.
- `revisions/` : versionnement par objet, pas seulement par dossier séquentiel.

Il faut aussi un **schéma de migration** : les projets vont évoluer, les vieux STEP et JSON doivent rester lisibles.

### 2. Modeleur paramétrique générique

La recette « deux boîtes moins deux cylindres » ne passe pas à l'échelle. Il manque :

- un **graphe de features** : esquisse → extrusion/révolution → perçage → congé → chanfrein → motif → coque → nervure ;
- des **contraintes d'esquisse** (coïncidence, distance, angle, tangence) ;
- des **références stables** (faces, arêtes, plans) entre features — le problème classique du *topological naming* ;
- des opérations booléennes robustes, du lissage, du *defeaturing* ;
- un **import STEP externe** avec réparation et simplification ;
- des unités et une gestion d'échelle explicites.

Deux stratégies :

- **A. Génération de code** : DeepSeek écrit du build123d Python. Démo rapide, mais non déterministe, difficile à valider, et le dépôt interdit aujourd'hui l'exécution de code généré sans isolation.
- **B. API de features typée** : le modèle émet des opérations JSON validées (`create_part`, `add_extrude`, `add_hole`, `add_fillet`…), le backend reconstruit de façon déterministe. C'est la voie recommandée, avec un sandbox seulement pour les géométries exotiques plus tard.

Le point dur est le **nommage topologique stable** : sans lui, modifier un congé après un perçage casse les références. Il faut soit des IDs persistants, soit une reconstruction complète à chaque fois à partir de la spec (plus simple, plus lent).

### 3. Assemblage

Il manque :

- des **instances** de pièces avec transformation (`Location`) et nomenclature ;
- un **solveur de contraintes** : coïncidence, distance, angle, pivot, glissière, rotule, engrenage ;
- le calcul des **degrés de liberté** et la détection de sur-contraintes ;
- la **détection d'interférences** et de collisions ;
- les **vues éclatées** et l'export STEP d'assemblage avec hiérarchie, noms et couleurs (AP242) ;
- la cinématique (positions, courses, trajectoires) pour vérifier un mécanisme.

`build123d.joints` aide à positionner deux pièces, mais ne fournit ni graphe d'assemblage, ni solveur global, ni BOM. C'est à construire ou à adosser à un moteur existant.

### 4. BOM

La BOM n'est pas un tableau annexe : c'est une **projection de l'assemblage**. Il manque :

- un schéma : numéro d'article, référence, révision, quantité, matériau, masse, finition, fournisseur, make/buy, coût, parent ;
- le **roll-up** multi-niveaux et la gestion des sous-assemblages ;
- les quantités calculées depuis les instances, pas saisies à la main ;
- l'export **CSV/XLSX/PDF** et l'intégration au rapport ;
- le lien **where-used** et l'impact d'un changement de pièce ;
- les propriétés de masse et de centre de masse issues du noyau, avec densité matériau.

### 5. Simulation

C'est la couche la plus lourde. Il manque :

- une **bibliothèque matériaux** : E, ν, limite élastique, densité, conductivité, dilatation, fatigue ;
- un **maillage volumique** (gmsh) avec contrôle de qualité et convergence ;
- un **solveur** : CalculiX ou Code_Aster en open source, ANSYS/COMSOL si budget et besoin de support ;
- un modèle de **charges et conditions aux limites** : appuis, forces, pressions, gravité, contacts, multi-cas ;
- une **chaîne de résultats** : contraintes, déplacements, facteur de sécurité, modes propres, températures ;
- des **vérifications** : équilibre, convergence de maillage, comparaison à des cas analytiques, reproductibilité ;
- des **rapports** avec hypothèses, limites et avertissements ;
- une **file de jobs** : une simulation dure des minutes à des heures, avec annulation, reprise et stockage de résultats.

Sans validation, une simulation est un joli dessin coloré. Il faut des cas de référence (poutre encastrée, plaque trouée, contact simple) et des tolérances de comparaison.

### 6. Optimisation topologique

Encore une couche au-dessus de la simulation :

- **espace de conception** : enveloppe, zones interdites, zones de fixation ;
- **cas de charge** multiples, matériau, fraction volumique cible ;
- **méthode** : SIMP à densité, level-set ou BESO ;
- **sensibilités** et solveur itératif (scipy suffit pour de petits cas, pas pour du 3D fin) ;
- **contraintes de fabrication** : surplomb pour l'impression 3D, épaisseur minimale, symétrie, démoulage ;
- **reconstruction CAO** : marching cubes → lissage → reconstruction NURBS → STEP. C'est le point le plus difficile : une pièce optimisée est un champ de densité, pas un solide paramétrique ;
- **re-analyse** du solide reconstruit, pas du voxel model ;
- **comparaison** avant/après : masse, raideur, contrainte max, gain.

Options open source à évaluer : ToPy (SIMP), DL4TO (PyTorch), topopt, ou une implémentation SIMP maison avec scipy. Les outils commerciaux (nTop, OptiStruct, ANSYS) règlent la reconstruction et les contraintes de fabrication, à un coût de licence.

Pour un premier jalon réaliste : **TO 2D/2.5D sur une pièce, volume fraction 30 %, reconstruction par extrusion de contours, re-analyse statique, export STEP**. Le TO 3D avec reconstruction NURBS est un projet en soi.

### 7. Visualisation et livrables

Aujourd'hui l'agent ne « voit » rien. Il manque :

- un **viewer 3D** (three.js ou vtk.js) : orbite, coupes, arêtes, couleurs par pièce ;
- des **rendus PNG** pour le chat et les rapports ;
- des **plans cotés** : SVG/PDF, cotes, tolérances, GD&T ;
- des **exports fabrication** : STEP AP242, STL, 3MF, DXF ;
- des **vues éclatées** et des **résultats de simulation** (contraintes, déplacements) ;
- une **visionneuse de BOM** et de l'arbre d'assemblage.

`build123d` sait déjà exporter SVG/DXF/STL/glTF et `vtk_tools` peut convertir un shape en `vtkPolyData`. Le viewer et les plans restent à câbler.

### 8. Orchestration agent et runtime

DeepSeek est bon pour planifier, poser des questions et appeler des outils. Il lui manque une surface adaptée :

- des outils **typés** : `create_part`, `add_feature`, `set_material`, `assemble`, `add_mate`, `check_interference`, `generate_bom`, `run_study`, `optimize_topology`, `inspect_results` ;
- des **sorties structurées** et des **codes d'erreur stables** (déjà commencé) ;
- un **état de projet interrogeable** : résumés, pas des B-rep dans le contexte ;
- une **boucle de clarification** : dimensions manquantes, matériau, cas de charge ;
- des **jobs longs** avec progression, annulation, reprise ;
- un **sandbox** pour tout code généré (conteneur, réseau coupé, limites CPU/mémoire) ;
- un **jeu d'évaluation** : 20 à 50 tâches avec artefacts attendus, pour mesurer le taux de réussite réel du couple DeepSeek + outils.

## Architecture recommandée

```
DeepSeek Harness
   │  outils typés, JSON schemas, codes d'erreur
   ▼
OpenEngineer service
   ├── project store (parts, assemblies, BOM, studies, revisions)
   ├── feature engine (build123d / OpenCascade)
   ├── assembly solver + interference
   ├── BOM projector
   ├── simulation workers (gmsh + CalculiX/Code_Aster)
   ├── topology optimization worker (SIMP + reconstruction)
   └── artifacts (STEP, STL, glTF, SVG/PDF, CSV/XLSX, rapports)
   │
   ▼
Viewer (three.js/vtk.js) + chat
```

Principes :

1. **Déterministe d'abord** : le modèle produit une spec, le backend la reconstruit et la valide. Pas de Python généré au départ.
2. **Un seul modèle de données** pour pièces, assemblages, BOM et études ; la BOM et les vues sont des projections.
3. **Validation à chaque étage** : géométrie, interférences, masse, convergence, re-analyse.
4. **Jobs asynchrones** dès la simulation : l'agent ne bloque pas sur un calcul de 20 minutes.
5. **Traçabilité** : chaque révision référence les entrées, les hashes et les résultats.

## Choix techniques à trancher

| Sujet | Options | Recommandation |
|---|---|---|
| Noyau CAO | OpenCascade/build123d, Parasolid, ACIS | Garder OCC/build123d |
| Features | code généré, DSL typée, les deux | DSL typée d'abord |
| Maillage | gmsh, Netgen, maillage OCC | gmsh |
| Solveur | CalculiX, Code_Aster, ANSYS, COMSOL | CalculiX pour démarrer |
| TO | ToPy, DL4TO, SIMP maison, nTop/OptiStruct | SIMP + reconstruction simple d'abord |
| Viewer | three.js, vtk.js, OCCT WASM | three.js + glTF |
| BOM | schéma maison + XLSX | schéma maison |
| Stockage | fichiers + Git, base, objet store | fichiers + manifest, LFS pour les binaires |
| Exécution | local, conteneur, cloud | conteneur par job |

## Feuille de route réaliste

### Étape A — Projet et pièce générique (2 à 4 semaines)

- Schéma projet/pièce/matériau.
- API de features v1 : esquisse, extrusion, révolution, perçage, congé, chanfrein, motif.
- Export STEP/STL/glTF, propriétés de masse.
- Viewer minimal et rendu PNG.

**Critère** : créer 3 pièces différentes sans toucher au code, les modifier, les exporter et les recharger.

### Étape B — Assemblage et BOM (2 à 3 semaines)

- Instances, transformations, contraintes de base, détection d'interférences.
- Export STEP d'assemblage.
- BOM multi-niveaux, quantités, masse, export XLSX.
- Arbre d'assemblage et vue éclatée.

**Critère** : assembler 5 pièces, détecter un chevauchement de 0,1 mm, produire une BOM juste.

### Étape C — Plans et vérifications (2 semaines)

- Plans SVG/PDF cotés, tolérances de base.
- Contrôles DFM : épaisseur mini, rayon de pli, profondeur de trou.
- Import STEP externe et réparation.

### Étape D — Simulation statique (3 à 5 semaines)

- Matériaux, maillage gmsh, CalculiX, charges/appuis.
- Résultats, rapports, convergence, cas de référence.
- File de jobs, annulation, stockage.

**Critère** : poutre encastrée à moins de 5 % de la solution analytique, maillage convergé, rapport reproductible.

### Étape E — Optimisation topologique (3 à 5 semaines)

- Espace de conception, cas de charge, fraction volumique.
- SIMP 2D/2.5D, reconstruction, re-analyse, export STEP.
- Contraintes de fabrication de base.

**Critère** : réduire la masse de 30 % à contrainte admissible, STEP watertight, re-analyse conforme.

### Étape F — Extension (ensuite)

- Modal, thermique, fatigue, cinématique.
- TO 3D avec reconstruction NURBS.
- CFD : hors périmètre initial, très coûteux.

## Ce qui est vraiment difficile

1. **Nommage topologique stable** : le piège classique de tous les modeleurs paramétriques.
2. **Reconstruction CAO après TO** : passer d'un champ de densité à un STEP propre et fabricable.
3. **Solveur d'assemblage** : contraintes, DOF, sur-contraintes, cinématique.
4. **Crédibilité de la simulation** : maillage, convergence, validation, limites claires.
5. **Fiabilité de l'agent** : DeepSeek planifie bien, mais doit être contraint par des outils et une validation déterministe.
6. **Performance** : maillage et calcul sont lourds ; il faut des workers et du stockage.

## Décisions à prendre

1. **Fidélité cible** : prototype visuel, pièce imprimée en 3D, ou pièce critique certifiable ? Cela change le solveur et le niveau de validation.
2. **Procédé** : FDM/SLA, usinage, tôle, injection ? Les contraintes DFM et TO en dépendent.
3. **Budget simulation** : CalculiX gratuit vs ANSYS/COMSOL avec support.
4. **Historique de features** : édition paramétrique complète, ou STEP + paramètres suffisent ?
5. **Calcul** : local, serveur dédié, cloud ?
6. **Ouverture** : importer des STEP clients ? Si oui, prévoir réparation et *defeaturing*.

## Risques

- Promettre la simulation avant de l'avoir validée : danger industriels et réputationnels.
- Sous-estimer la reconstruction TO : c'est souvent 50 % du travail.
- La génération de code CAD par LLM sans sandbox : risque de sécurité et de non-déterminisme.
- Les licences des solveurs et des bibliothèques (CalculiX, gmsh, Code_Aster) doivent être vérifiées avant distribution.
- Le stockage des STEP/STL et des résultats de simulation : Git seul ne suffit pas.
