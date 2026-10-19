# Intégrer le MCP Fusion dans DeepSeek Harness

Objectif : donner à l'agent l'accès à une session Fusion ouverte (Autodesk Fusion, ex-Fusion 360), en plus — ou à la place — du moteur `cad_*` basé sur build123d.

Deux intégrations différentes :

1. **Côte à côte** : `cad_*` reste la source de vérité pour les pièces, Fusion sert à visualiser, importer le STEP, assembler, simuler, cam. C'est la voie recommandée pour démarrer.
2. **Fusion comme backend** : les mêmes features sont exécutées dans Fusion. Plus intégré, mais il faut un serveur MCP typé, pas `execute_python`.

## Ce qui existe

- Autodesk a annoncé un **Fusion MCP** et un **Fusion Compute MCP** en beta publique ([blog Autodesk](https://www.autodesk.com/products/fusion-360/blog/introducing-the-fusion-mcp-opening-fusion-to-ai-powered-workflows/)).
- Un **add-in MCP local** open source (MIT) expose une session Fusion sur `http://127.0.0.1:8765/mcp` en Streamable HTTP, avec 14 outils dont `execute_python`, `call_autodesk_api`, `capture_viewport`, `get_active_selection` : [frankhommers/autodesk-fusion-mcp](https://github.com/frankhommers/autodesk-fusion-mcp).
- Le **sample officiel Autodesk** expose surtout `execute_api_script`, `get_screenshot` et `get_api_documentation` : [AutodeskFusion360/FusionMCPSample](https://github.com/AutodeskFusion360/FusionMCPSample).

DeepSeek Harness possède déjà un **client MCP natif** : `@deepseek-ai/dsh-mcp-client`. Il enregistre les outils du serveur sous la forme `mcp__<serverName>__<tool>`.

## Prérequis

- Fusion installé et **ouvert** (l'add-in tourne dans le processus Fusion).
- macOS ou Windows.
- L'add-in MCP lancé dans Fusion, pas seulement installé.
- Le port `8765` libre et accessible en local uniquement.

## 1. Installer l'add-in Fusion MCP

Télécharge la dernière release de [frankhommers/autodesk-fusion-mcp](https://github.com/frankhommers/autodesk-fusion-mcp/releases), puis extrais-la dans le dossier des add-ins :

```text
macOS   : ~/Library/Application Support/Autodesk/Autodesk Fusion 360/API/AddIns/AutodeskFusionMCP
Windows : %APPDATA%\Autodesk\Autodesk Fusion 360\API\AddIns\AutodeskFusionMCP
```

Le dossier doit s'appeler exactement `AutodeskFusionMCP`.

Dans Fusion : **Shift+S** → onglet **Add-Ins** → sélectionner `AutodeskFusionMCP` → **Run**.

Vérification :

```sh
curl http://127.0.0.1:8765/health
```

Puis, si tu as Node :

```sh
npx @modelcontextprotocol/inspector --cli http://127.0.0.1:8765/mcp --transport http --method tools/list
```

Tu dois voir les outils Fusion. Si le port ne répond pas, l'add-in n'est pas lancé ou a échoué au démarrage.

## 2. Configurer le client MCP de Harness

### Option A — profil de l'app

Ajoute une entrée à la fin de `~/.dsh/profiles/web/cordis.patch.yml` :

```yaml
- insert:
    - id: mcp-fusion
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: fusion
        transport: streamable-http
        url: http://127.0.0.1:8765/mcp
        toolCallTimeoutMs: 120000
        failOnStartupError: false
```

Redémarre DeepSeek Harness, puis ouvre une **nouvelle conversation**.

### Option B — patch CLI local

Le script de génération sait ajouter l'entrée MCP Fusion :

```sh
FUSION_MCP=1 node scripts/harness-config.mjs
pnpm build
npx @deepseek-ai/dsh@0.2.1-rc.2 web \
  --patch "$PWD/harness.local.yaml" \
  --port 61118
```

`FUSION_MCP_URL` permet de changer l'URL (par défaut `http://127.0.0.1:8765/mcp`). Le patch généré contient alors les deux plugins :

```yaml
- insert:
    - id: openengineer
      name: /Users/melissamalara/Developer/cursor_for_cad/dist/harness-plugin/src/index.js
      config:
        root: /Users/melissamalara/Developer/cursor_for_cad/
        python: /Users/melissamalara/Developer/cursor_for_cad/.venv/bin/python
        timeoutMs: 120000
    - id: mcp-fusion
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: fusion
        transport: streamable-http
        url: http://127.0.0.1:8765/mcp
        toolCallTimeoutMs: 120000
        failOnStartupError: false
```

### Champs utiles

| Champ | Rôle |
|---|---|
| `serverName` | Préfixe des outils : `fusion` donne `mcp__fusion__execute_python` |
| `transport` | `streamable-http` pour cet add-in |
| `url` | `http://127.0.0.1:8765/mcp` |
| `toolCallTimeoutMs` | 60 s par défaut ; augmente pour les opérations lourdes |
| `failOnStartupError` | `true` pour refuser le démarrage si Fusion n'est pas joignable |
| `reconnect` | Reconnexion automatique après une coupure |

## 3. Vérifier dans le chat

Demande par exemple :

> Liste les outils MCP Fusion disponibles et appelle `get_viewport`.

ou :

> Capture le viewport Fusion courant et dis-moi ce qu'il contient.

Les outils apparaissent sous :

```text
mcp__fusion__get_viewport
mcp__fusion__set_viewport
mcp__fusion__capture_viewport
mcp__fusion__get_active_selection
mcp__fusion__execute_python
mcp__fusion__call_autodesk_api
mcp__fusion__fetch_api_documentation
...
```

## 4. Faire dialoguer Fusion avec la suite `cad_*`

Le flux le plus sûr aujourd'hui :

```text
cad_part_export(step)
        │
        ▼
mcp__fusion__execute_python ou un outil d'import dédié
        │
        ▼
Fusion : visualisation, assemblage, simulation, CAM
```

Exemple de demande :

> Exporte la pièce `part-000001` en STEP, puis importe ce STEP dans un nouveau document Fusion et capture le viewport.

Le modèle appellera `cad_part_export`, récupérera le chemin, puis un outil Fusion. La géométrie reste validée par notre moteur ; Fusion ne fait que consommer le STEP.

### Ce qu'il ne faut pas faire

Laisser l'agent appeler `mcp__fusion__execute_python` pour **modifier** la même pièce en parallèle de `cad_*` crée deux sources de vérité :

- pas d'historique de features partagé ;
- pas de vérification `cad_*` ;
- risque de divergence entre le STEP et le projet.

Si Fusion doit devenir le backend, il faut un **serveur MCP typé** qui expose les mêmes opérations que `cad_*` (`create_part`, `extrude`, `hole`, `fillet`, `chamfer`, `tube`, `export`) et exécute du code Fusion déterministe. C'est un développement séparé, pas une simple configuration.

## 5. Sécurité et limites

- `execute_python` exécute du **code arbitraire dans ta session Fusion**, avec tes droits. Une injection de prompt peut modifier ou supprimer des conceptions. Travaille sur une copie, jamais sur tes fichiers de production.
- L'add-in écoute en local, sans authentification par défaut. Ne l'expose pas sur le réseau.
- Les outils Fusion sont **hors** du modèle transactionnel de `cad_*` : pas de verrou, pas de rollback, pas de validation géométrique.
- `capture_viewport` renvoie une image ; le client MCP de Harness la transmet si le modèle accepte les images, sinon l'agent voit un diagnostic texte.
- Fusion doit rester ouvert ; si l'add-in s'arrête, les outils MCP échouent et le client tente de se reconnecter.
- Les versions MCP négociées doivent être compatibles ; le client Harness gère les révisions récentes, l'add-in supporte plusieurs versions 2025/2026.
- L'add-in communautaire est sous licence MIT, non supporté par Autodesk. Le sample officiel sert de référence si tu veux construire ton propre serveur.

## 6. Recommandation

Pour ton usage :

1. **Court terme** : ajoute le MCP Fusion comme second fournisseur d'outils, garde `cad_*` comme source de vérité, et utilise Fusion pour le viewport, l'import STEP, les assemblages et les simulations.
2. **Moyen terme** : ajoute un outil `import_step` dans l'add-in Fusion (ou un petit serveur MCP maison) pour éviter `execute_python`.
3. **Long terme** : si Fusion devient le noyau, expose les features `cad_*` via un serveur MCP typé et garde la même validation qu'aujourd'hui.

Le point clé : **MCP est un transport d'outils, pas un modèle de données**. Brancher Fusion ne remplace pas le contrat features/validation/révisions ; il faut décider qui est la source de vérité.
