# Revue du support iPhone (`part-000002`)

Analyse du parcours réel dans Harness : conception du support, ajout des fixations et nervures, puis des congés.

## Ce qui a été produit

- Support en U extrudé sur 75 mm de large, base 95 × 75 × 8 mm, dossier incliné à 15,7°, jupe avant de 16 mm, gorge de 43 mm.
- 2 nervures triangulaires de 6 mm et 4 trous Ø6,2.
- 18 features, dont 9 congés (R1 à R4) et un congé final `all` R1.
- Volume 115 192,9 mm³, masse 142,84 g en PLA.
- 248 arêtes, 112 faces, STEP validé, révisions 4 à 6.

Mesures vérifiées localement :

```
features     18
build        0,485 s (hors démarrage Python)
bbox OCC     [-0, -0,124, -0, 95, 75,124, 86]
maillage     [-0, -0,021, -0, 95, 75,021, 86]  (tolérance 0,05)
volume       115 192,9 mm3
masse        142,84 g (PLA)
```

## Ce qui fonctionne bien

1. **Le profil en U est le bon choix** : base, gorge, dossier incliné et jupe forment une seule pièce imprimable, sans assemblage.
2. **Les nervures sont bien placées** : la liaison dossier/base est la zone qui reprend tout le moment du téléphone. Deux goussets latéraux de 6 mm transforment la pliure en encastrement triangulé sans gêner l'insertion.
3. **La validation géométrique a fait son travail** : volume, masse, solide unique, 4/4 checks, export STEP.
4. **Le modèle s'est autocorrigé** sur l'orientation du polygone des nervures, et a su distinguer un vrai débordement d'une boîte englobante conservatrice.
5. **La traçabilité est bonne** : chaque étape a une révision et un message utile.

## Points de conception à valider

### 1. La gorge de 43 mm est l'hypothèse la plus risquée

Pour un téléphone de 12 mm avec coque, 43 mm laissent beaucoup de jeu. Le téléphone peut reposer contre le dossier, ou glisser vers la jupe, et l'angle réel dépend de ces contacts. Il faut un **modèle d'enveloppe du téléphone** et une vérification de contact/clearance, pas seulement une cote de gorge.

### 2. La jupe avant ne retient peut-être pas un téléphone fin

Si le téléphone est posé contre le dossier, son bord avant est à environ 12 mm du dossier, donc loin de la jupe située 43 mm plus loin. La jupe ne devient utile que si le téléphone glisse vers l'avant. C'est à vérifier avec l'enveloppe réelle : contacts dossier + fond + jupe.

### 3. Fixations sous la base, pas en façade

Les 4 trous sont traversants et accessibles par le dessous. Deux sont sous le dossier, deux sous le téléphone : un montage vis/écrou sous plateau est possible, un montage mural ne l'est pas. Pour un mur, il faut des trous ou des lumières dans le dossier, donc des perçages sur un plan incliné — ce que `cad_feature_hole` ne sait pas encore faire.

### 4. Le congé `all` R1 final est pratique mais coûteux

Il arrondit tout, y compris les arêtes de couture des cylindres et les rims de trous. Résultat : 74 arêtes B-spline, une boîte englobante OCC qui déborde (75,124 au lieu de 75), et un STEP plus lourd. Pour l'esthétique, des congés sélectifs par groupe donnent un meilleur rapport qualité/coût.

### 5. Stabilité et impression

- La stabilité annoncée est une estimation manuelle. Il manque un calcul du centre de gravité **pièce + téléphone** et du polygone de sustentation.
- Pour l'impression : 8 mm de paroi, 6 mm de nervure, dossier incliné à 15,7° — imprimable, mais il n'y a pas de contrôle d'overhang, d'épaisseur mini ni de surface d'adhérence.
- Un passage de câble ou une encoche de charge serait un plus fonctionnel.

## Ce que le transcript révèle sur la suite d'outils

| Friction observée | Conséquence | Amélioration |
|---|---|---|
| Édition directe de `parts/part-000002.json` | Pas de verrou, pas d'atomicité, pas d'ID auto | Garde-fou de hash + `cad_part_import` explicite |
| Scripts Bash pour lister les arêtes | Coût en tokens, non reproductible | `cad_part_edges` avec filtres et IDs |
| Essais de chaînes de congés par rebuild | Lenteur, essais/erreurs | `cad_features_apply` dry-run + `fillet_group` atomique |
| Boîte englobante OCC conservatrice | Plusieurs tours pour prouver l'absence de débordement | `bounds_tight_mm` par tessellation |
| Pas d'outil de rendu | matplotlib improvisé via Bash | `cad_render` PNG |
| Congé `all` inclut les coutures | Artefacts, B-splines | Exclure les coutures par défaut, sélecteurs convex/concave |
| Aucun outil de modification de feature | Édition JSON obligatoire | `cad_feature_update/delete/reorder` |
| Polygone orienté dans le mauvais sens | Nervure à l'envers | `direction: normal/reverse/both` sur extrude |
| Perçage uniquement −Z | Pas de montage mural | `axis`/`plane` sur hole |

## Améliorations prioritaires

### P0 — Rendre l'exploration déterministe

1. **`cad_part_edges`** : liste structurée des arêtes avec type, longueur, centre, direction, rayon, convexité, couture, face adjacente, ID stable. Filtres par axe, boîte, type, longueur mini.
2. **`cad_features_apply`** : accepte une liste de features, construit une fois, renvoie checks/volume/bbox ou l'index de l'échec, avec `dry_run` et `write`. Remplace les scripts Bash.
3. **`cad_feature_update/delete/reorder`** : plus besoin d'éditer le JSON.
4. **Garde-fou de hash** : `cad_part_rebuild`/`commit` refusent un `parts/*.json` modifié hors outils ; `cad_part_import` permet l'import explicite.

### P1 — Qualité géométrique

5. **`cad_feature_fillet_group` / `chamfer_group`** : plusieurs `{selector, radius}` dans une feature atomique, avec l'opération fautive en cas d'échec.
6. **`bounds_tight_mm`** : bounding box par maillage, à côté de `bounds_occ_mm`.
7. **Sélecteurs** : `convex`, `concave`, `min_length`, `include_seams` ; `all` exclut les coutures par défaut.
8. **Extrude `direction`** : `normal`, `reverse`, `both`.
9. **Hole `axis`** : X/Y/Z ou normale de plan, avec position 3D, pour les perçages sur dossier incliné.

### P2 — Validation produit

10. **`cad_render`** : PNG isométrique avec arêtes, sections et matériau.
11. **`cad_check_clearance`** : enveloppe téléphone (boîte) vs pièce, contacts et jeu.
12. **`cad_check_stability`** : centre de gravité combiné, polygone de sustentation, angle de basculement.
13. **`cad_check_printability`** : overhang, épaisseur mini, surface au sol.

### P3 — Performance

14. Worker Python persistant : supprimer le coût d'import build123d à chaque appel.
15. Cache des reconstructions par préfixe de features.

## Conclusion

Le résultat est déjà bon : la pièce est valide, imprimable, correctement nervurée, et le raisonnement mécanique du modèle est solide. Les améliorations les plus rentables ne sont pas dans la géométrie, mais dans **l'outillage qui a servi à y arriver** : lister les arêtes, tester une chaîne de congés en une fois, obtenir des bornes justes, rendre l'image, et empêcher l'édition directe du JSON. C'est ce qui fera passer un prototype de 929K tokens à un flux court et reproductible.

## Mise à jour — améliorations implémentées

Les P0/P1 de cette revue sont maintenant dans la suite :

- `cad_part_edges` pour inspecter les arêtes sans script Bash.
- `cad_features_apply` avec `dry_run` pour tester une chaîne atomiquement.
- `cad_feature_update` / `cad_feature_delete` pour éditer sans toucher au JSON.
- `cad_feature_fillet_group` / `chamfer_group` pour les congés étagés.
- `bounds_tight_mm` (maillage) à côté de `bounds_mm` (OCC).
- `cad_render` PNG iso/face/dessus/droite.
- `extrude.direction` (normal/reverse/both) et `hole.axis` (X/Y/Z avec `at`).
- Garde-fou de hash : un `parts/*.json` modifié hors outils renvoie `CONFLICT` ; `cad_part_import` est l'entrée explicite.

Reste pour la suite : assemblage/BOM, simulation, topologie, et un `cad_check_stability`/`cad_check_clearance` pour valider le couple téléphone-support.
