# claude-code-cache-fix

[![npm](https://img.shields.io/npm/v/claude-code-cache-fix?color=blue)](https://www.npmjs.com/package/claude-code-cache-fix) [![Node.js](https://img.shields.io/badge/Node.js-18%2B-green)](https://nodejs.org/) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow)](https://opensource.org/licenses/MIT) [![GitHub stars](https://img.shields.io/github/stars/cnighswonger/claude-code-cache-fix)](https://github.com/cnighswonger/claude-code-cache-fix/stargazers)

[English](./README.md) | [中文](./README.zh.md) | [한국어](./README.ko.md) | [Português](./docs/guia-pt-br.md) | Français

Proxy d'optimisation du cache pour [Claude Code](https://github.com/anthropics/claude-code). Corrige les bugs du cache de prompt qui entraînent une consommation excessive du quota, stabilise le préfixe de requête et surveille les régressions silencieuses. Fonctionne avec toutes les versions de CC, y compris la version binaire Bun v2.1.113+.

> **v4.0.0** — Proxy HTTP local avec une chaîne de modules d'impact coût et de supervision. Deux paramètres par défaut anciens ont été inversés : `thinking-block-sanitize` v1 est activé par défaut (atténue le blocage `400` lié à la désynchronisation de la pensée — [#63147](https://github.com/anthropics/claude-code/issues/63147)) et le rechargement dynamique des extensions en processus est optionnel (`CACHE_FIX_HOT_RELOAD=on`). Base A/B (v3.0.0 sur v2.1.117) : **taux de réussite du cache de 95,5 % via le proxy contre 82,3 % direct** lors du premier tour de réchauffage. [Notes de version complètes →](https://github.com/cnighswonger/claude-code-cache-fix/releases/tag/v4.0.0)

> **Avis Opus 4.7 :** Les données mesurées montrent que 4.7 consomme le quota Q5h à un taux d'environ **2,4 fois supérieur à celui de 4.6** pour un nombre équivalent de jetons visibles ([confirmé indépendamment par @ArkNill](https://github.com/ArkNill/claude-code-hidden-problem-analysis/blob/main/16_OPUS-47-ADVISORY.md)). Deux facteurs : un nouveau tokeniseur (jusqu'à 35 % de jetons supplémentaires, [documenté](https://platform.claude.com/docs/en/about-claude/models/whats-new-claude-4-7)) et une surcharge de pensée adaptative (~105 %, non documentée dans la réponse d'utilisation). L'impact sur Q5h s'accumule jusqu'à **Q7d** — le plafond hebdomadaire du quota que la plupart des utilisateurs intensifs atteindront en premier. Solution de contournement : `CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING=1` réduit la consommation d'environ **3,3 fois**, mais peut réduire la qualité sur les tâches complexes. Voir [Discussion #25](https://github.com/cnighswonger/claude-code-cache-fix/discussions/25) (observation initiale) et [Discussion #42](https://github.com/cnighswonger/claude-code-cache-fix/discussions/42) (données A/B contrôlées + analyse Q7d).

## Démarrage rapide : proxy (recommandé)

Le proxy fonctionne avec n'importe quelle version CC — Node.js ou binaire Bun. Il s'insère entre Claude Code et l'API Anthropic, appliquant des correctifs de cache sous forme d'extensions composable.

```bash
# Installer
npm install -g claude-code-cache-fix

# Démarrer le proxy (écoute sur localhost:9801)
node "$(npm root -g)/claude-code-cache-fix/proxy/server.mjs" &

# Lancer Claude Code à travers lui
ANTHROPIC_BASE_URL=http://127.0.0.1:9801 claude
```

C'est tout. Le proxy applique automatiquement sa chaîne d'extensions par défaut. Aucun script d'enveloppe, aucune variable `NODE_OPTIONS`, aucun préchargement.

### Mode proxy inverse (garde Remote Control fonctionnel)

Le démarrage rapide ci-dessus utilise le **mode proxy inverse** : vous pointez `ANTHROPIC_BASE_URL` vers le proxy. C'est simple, mais sur Claude Code **>= 2.1.196**, une URL de base personnalisée (`ANTHROPIC_BASE_URL` non-Anthropic) **désactive Remote Control** (`/remote-control`), `/schedule` et les connecteurs MCP de claude.ai (CC traite toute URL de base personnalisée comme une passerelle Bedrock/Vertex). Si vous dépendez de ces fonctionnalités, utilisez plutôt le mode proxy avant.

En **mode proxy avant**, le proxy s'insère devant le *vrai* `api.anthropic.com` comme `HTTPS_PROXY`. L'URL de base de Claude Code reste `api.anthropic.com`, donc Remote Control continue de fonctionner, tandis que le proxy voit encore et transforme `/v1/messages`.

```bash
# Démarrer le proxy en mode proxy avant
CACHE_FIX_FORWARD_PROXY=on node "$(npm root -g)/claude-code-cache-fix/proxy/server.mjs" &
# Il affiche les deux variables d'environnement à configurer sur le client, par exemple :
#   export HTTPS_PROXY=http://127.0.0.1:9801
#   export NODE_EXTRA_CA_CERTS=~/.claude/cache-fix-ca/ca.pem

# Lancer Claude Code à travers lui (laisser ANTHROPIC_BASE_URL non défini)
HTTPS_PROXY=http://127.0.0.1:9801 \
NODE_EXTRA_CA_CERTS=~/.claude/cache-fix-ca/ca.pem \
  claude
```

Ou laissez le lanceur faire les deux étapes pour vous avec `--remote-control` :

```bash
# Lance le proxy avec CACHE_FIX_FORWARD_PROXY=on et configure le client
# (HTTPS_PROXY + le certificat CA MITM, ANTHROPIC_BASE_URL laissé non défini).
cache-fix-proxy --remote-control
```

L'option `--remote-control` est l'équivalent d'une seule commande de la configuration manuelle ci-dessus : elle démarre le proxy en mode proxy avant, attend la CA, puis lance `claude` en pointant vers `HTTPS_PROXY` avec `NODE_EXTRA_CA_CERTS` définie. Sans l'option, le lanceur reste en mode proxy inverse (définit `ANTHROPIC_BASE_URL`), inchangé. Deux points à retenir : Remote Control effectue un enregistrement de périphérique de confiance à la première connexion, ce qui peut nécessiter plusieurs tentatives `/remote-control` (une étape de Claude Code qui s'exécute en amont, pas une erreur du proxy) ; et activer RC sur une session déjà chaude entraîne une **reconstruction unique** du cache (RC ajoute un `anthropic-beta` aux clés de cache), donc si vous voulez RC, lancer avec `--remote-control` dès le départ évite ce changement ponctuel. `cache-fix-proxy --help` documente les deux.

Fonctionnement : le proxy gère aussi les requêtes HTTP `CONNECT`. Il effectue un MITM **uniquement** sur l'hôte en amont (`api.anthropic.com`), terminant le TLS avec une CA générée localement afin de pouvoir exécuter la même chaîne d'extensions, et **tunnelise aveuglément** toutes les autres `CONNECT` (mcp-proxy, télémétrie, npm, ...) sans les modifier. À son premier démarrage, il génère une CA sous `$CLAUDE_CONFIG_DIR/cache-fix-ca/` (par défaut `~/.claude/cache-fix-ca/` ; remplacer avec `CACHE_FIX_CA_DIR`) ; le client doit la faire confiance via `NODE_EXTRA_CA_CERTS`. Une connexion WebSocket/Upgrade vers l'hôte en amont (par exemple `/voice`) est relayée vers l'amont sans modification. Comme l'URL de base reste `api.anthropic.com`, toutes les routes comme `/api/oauth/*`, `/v1/agents`, les récupérations d'identifiants Remote Control, etc., passent sans modification, et RC reste activé.

La chaîne de proxy d'entreprise fonctionne comme en mode inverse : définissez `HTTPS_PROXY`/`HTTP_PROXY` pour l'**égress** du proxy lui-même (le proxy se connecte à `api.anthropic.com` via celui-ci). L'`HTTPS_PROXY` du client pointe vers le proxy de cache-fix ; l'`HTTPS_PROXY` du proxy de cache-fix (dans son propre environnement) pointe vers le proxy d'entreprise.

**Sémantique des crashs sur un proxy partagé.** En mode proxy avant, le proxy effectue un MITM sur tout l'hôte en amont, donc une session Claude Code en cours est liée à *cette* port et ne peut pas basculer. Pour éviter qu'une requête défaillante ne fasse planter le processus, une connexion réussie en mode proxy avant installe des gestionnaires `uncaughtException`/`unhandledRejection` au niveau du processus qui loguent et continuent à servir au lieu de planter. Ces gestionnaires sont limités au mode proxy avant (un proxy uniquement en mode inverse conserve le comportement par défaut de Node, qui plante et laisse son superviseur le redémarrer) et sont supprimés quand la dernière instance en mode proxy avant se ferme. Le compromis : sur un proxy **partagé / multi-locataire**, activer le mode proxy avant change le comportement des crashs pour tous les clients sur cette instance pendant que le mode est actif — une erreur fatale est absorbée au lieu d'être signalée à un superviseur. Si vous exécutez un seul proxy pour plusieurs sessions, pesez ce risque contre un modèle supervisé par session.

**Exécution persistante.** La commande `... node .../proxy/server.mjs &` ci-dessus convient pour une tentative rapide, mais un processus en arrière-plan n'est pas supervisé : il ne redémarre pas si il plante ou si la machine redémarre. Pour exécuter le mode proxy avant comme un service géré (redémarrage automatique, démarrage au login), utilisez le même chemin `install-service` décrit sous [Exécution en tant que service](#running-as-a-service) — simplement définissez l'option au moment de l'installation pour qu'elle soit intégrée dans l'unité :

```bash
CACHE_FIX_FORWARD_PROXY=on cache-fix-proxy install-service
```

L'unité systemd / agent launchd générée inclut `CACHE_FIX_FORWARD_PROXY=on`, donc le service démarre le proxy en mode proxy avant et le maintient actif (redémarrage `Restart=on-failure` plus minuteur de santé ; `KeepAlive` pour launchd).

**Le service ne gère que le bout du proxy.** Il ne — et ne peut pas — modifier quoi que ce soit sur votre client `claude`, qui est un processus séparé. Vous devez toujours configurer le client vous-même dans le shell qui lance `claude`, en utilisant les deux valeurs du démarrage rapide en mode proxy avant :

- `HTTPS_PROXY` — l'adresse d'écoute du proxy : `http://127.0.0.1:<port>` (port par défaut `9801`, ou votre `CACHE_FIX_PROXY_PORT`).
- `NODE_EXTRA_CA_CERTS` — la CA générée par le proxy à son premier démarrage : `~/.claude/cache-fix-ca/ca.pem` (ou `$CACHE_FIX_CA_DIR/ca.pem`).

Trois façons de configurer cela, selon la portée souhaitée :

```bash
# a) par invocation — limité à cette exécution de claude
HTTPS_PROXY=http://127.0.0.1:9801 \
NODE_EXTRA_CA_CERTS=~/.claude/cache-fix-ca/ca.pem \
  claude

# b) pour toute la session — ajouter à ~/.zshrc / ~/.bashrc (tous les HTTPS de cette session passent par le proxy ; inoffensif car les hôtes non-Anthropic sont tunnelisés aveuglément, mais les HTTPS de cette session échouent si le proxy est hors ligne)
export HTTPS_PROXY=http://127.0.0.1:9801
export NODE_EXTRA_CA_CERTS=~/.claude/cache-fix-ca/ca.pem

# c) limité à claude seulement — une fonction shell (recommandé ; évite la portée excessive du b)
claude() {
  HTTPS_PROXY=http://127.0.0.1:9801 \
  NODE_EXTRA_CA_CERTS=~/.claude/cache-fix-ca/ca.pem \
    command claude "$@"
}
```

### Ce que fait le proxy

À chaque requête `/v1/messages`, la chaîne d'extensions exécute une chaîne ordonnée d'extensions couvrant la stabilité du cache, l'observabilité, la mitigation du désynchronisme de pensée, les images, microcompact, point de rupture, canal de démarrage, et d'autres surfaces. Plusieurs sont conditionnelles à des variables d'environnement documentées dans leurs sections respectives ; la gestion du canal de démarrage est par défaut en mode `audit`. Les points forts :

| Extension | Ce qu'elle corrige |
|-----------|--------------------|
| `fingerprint-strip` | Supprime l'empreinte instable `cc_version` du prompt système |
| `sort-stabilization` | Ordonnancement déterministe des définitions d'outil et de MCP |
| `ttl-management` | Détecte le niveau TTL serveur, injecte les marqueurs `cache_control` corrects |
| `identity-normalization` | Normalise les champs d'identité des messages pour une stabilité du préfixe |
| `fresh-session-sort` | Corrige l'ordonnancement non déterministe au premier tour |
| `cache-control-normalize` | Normalise les marqueurs `cache_control` entre les messages |
| `cache-telemetry` | Extrait les statistiques du cache des en-têtes de réponse → `~/.claude/quota-status/{account.json,sessions/<id>.json}` |
| `session-health` | Surveille le risque de désynchronisme de pensée par session (taille du contexte + nombre de blocs de pensée) et avertit avant qu'une session n'atteigne la zone de danger. Lecture seule |
| `thinking-block-sanitize` | Supprime les blocs de pensée omis (texte vide) pour éviter le `400` de désynchronisme de pensée de CC (#63147). **Activé par défaut depuis la v4.0.0** (mode v1). Définissez `CACHE_FIX_THINKING_SANITIZE=off` pour désactiver, `=v2` pour supprimer en plus les incohérences d'outil-hash (optionnel). |
| `workflow-agent-id-synthesis` | Déduit un ID d'agent stable par étape pour les sous-agents des outils Workflow dont l'en-tête canonique `x-claude-code-agent-id` n'est pas défini ([CC#66761](https://github.com/anthropics/claude-code/issues/66761)). Activé par défaut ; la mémoire vive est stockée dans `ctx.meta._workflowAgentId` et ne quitte jamais le proxy. `usage-log` émet les champs `agent_id` + `agent_id_source` quand `CACHE_FIX_USAGE_LOG_AGENT_ID=on` ET que la version v0.8.0+ de meter est installée. Interrupteur principal : `CACHE_FIX_WORKFLOW_AGENT_DERIVATION=off`. |

Les extensions sont des fichiers `.mjs` dans `proxy/extensions/` avec leur configuration dans `proxy/extensions.json`. Depuis la v4.0.0, le proxy les charge une seule fois au démarrage ; ajouter, supprimer ou modifier une extension nécessite un redémarrage du proxy au niveau du superviseur (voir [Mise à jour depuis v3.x](#upgrading-from-v3x)). Le rechargement dynamique est disponible en option via `CACHE_FIX_HOT_RELOAD=on` pour les utilisateurs qui souhaitent retrouver le comportement de la v3.x ; ce chemin est sujet à la course de chargement d'importation ESM documentée dans [#196](https://github.com/cnighswonger/claude-code-cache-fix/issues/196).

**Développer une nouvelle extension ?** Consultez [docs/parallel-proxy-test-harness.md](docs/parallel-proxy-test-harness.md) pour le modèle que nous utilisons pour tester les extensions bout à bout contre un trafic réel `claude -p` sans perturber le proxy de production.

### Exécution en tant que service

**Recommandé (Linux/macOS) — sous-commande `install-service` :**

```bash
cache-fix-proxy install-service
```

Détecte votre plateforme et écrit la configuration appropriée :

- **Linux** → `~/.config/systemd/user/cache-fix-proxy.service` (unité utilisateur systemd)
- **macOS** → `~/Library/LaunchAgents/com.cnighswonger.cache-fix-proxy.plist` (agent launchd)

La sortie affiche les commandes pour activer et démarrer le service. Sous Linux :

```bash
systemctl --user daemon-reload
systemctl --user enable --now cache-fix-proxy
systemctl --user enable --now cache-fix-proxy-healthcheck.timer   # récupération automatique — voir ci-dessous
sudo loginctl enable-linger $USER   # optionnel : démarrage au démarrage, pas seulement au login
```

**Récupération automatique (Linux)** : `install-service` dépose aussi un complément de vérification de santé (`cache-fix-proxy-healthcheck.service` + `.timer`). Le minuteur s'active toutes les 2 minutes ; le service à une seule exécution exécute `curl -fs http://127.0.0.1:<port>/health` et `systemctl --user start cache-fix-proxy.service` si la vérification échoue. Cela récupère le proxy de toute interruption — propre ou non, prévue ou non — en moins de 2 minutes. Contexte : `Restart=on-failure` ne s'active pas en cas d'arrêt propre, donc avant l'existence de ce complément, une commande `systemctl stop` de n'importe quelle source (y compris des sources non identifiées pendant une panne d'Anthropic le 2026-04-25) laissait le proxy inactif indéfiniment. macOS n'a pas besoin du complément — `KeepAlive` de launchd redémarre automatiquement à tout arrêt.

Sous macOS :

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.cnighswonger.cache-fix-proxy.plist
launchctl enable gui/$(id -u)/com.cnighswonger.cache-fix-proxy
launchctl kickstart gui/$(id -u)/com.cnighswonger.cache-fix-proxy
```

La configuration installée récupère `CACHE_FIX_PROXY_PORT`, `CACHE_FIX_PROXY_UPSTREAM` et `CACHE_FIX_DEBUG` de l'environnement au moment de l'installation. Réexécutez `install-service --force` pour régénérer après des changements d'environnement, ou éditez directement le fichier de service. Associez-le à `cache-fix-proxy uninstall-service` pour une désinstallation propre (arrête, désactive, supprime).

Le service exécute `cache-fix-proxy server` en premier plan, qui est simplement le proxy sans le lanceur d'envoi de mode `claude`.

**Manuel (toutes plateformes) :**

```bash
nohup cache-fix-proxy server > /tmp/cache-fix-proxy.log 2>&1 &
echo 'export ANTHROPIC_BASE_URL=http://127.0.0.1:9801' >> ~/.bashrc
```

### Docker

Une image conteneur multi-architecture (amd64, arm64) est publiée sur GitHub Container Registry à chaque balise de version.

```bash
docker run -d --name cache-fix-proxy \
  --restart=always \
  -p 9801:9801 \
  ghcr.io/cnighswonger/claude-code-cache-fix:latest

# Ensuite dans votre shell :
export ANTHROPIC_BASE_URL=http://127.0.0.1:9801
```

Utilisez `--restart=always` au lieu du complément de vérification de santé systemd — Docker gère nativement la récupération automatique. Ne montez rien ; le conteneur est sans état. Remplacez le port par défaut avec `-e CACHE_FIX_PROXY_PORT=...`. Remplacez l'hôte en amont (par exemple pour chaîner via llm-relay) avec `-e CACHE_FIX_PROXY_UPSTREAM=http://host.docker.internal:8080`. L'image s'exécute en tant qu'utilisateur non privilégié `node` (uid 1000) et expose un `HEALTHCHECK` que Docker peut utiliser pour la vivacité.

Pour les environnements d'entreprise derrière un proxy inspectant le SSL, montez votre bundle CA et définissez les variables d'environnement :

```bash
docker run -d --name cache-fix-proxy --restart=always -p 9801:9801 \
  -e HTTPS_PROXY=http://proxy.corp.example:8080 \
  -e CACHE_FIX_PROXY_CA_FILE=/etc/ssl/corp-ca.pem \
  -v /path/to/zscaler-root.pem:/etc/ssl/corp-ca.pem:ro \
  ghcr.io/cnighswonger/claude-code-cache-fix:latest
```

Balises d'image : `latest`, `4`, `4.0`, `4.0.0` (échelle sémantique, donc `4` pointe toujours vers la dernière version 4.x). `latest` suit toujours la dernière version balisée.

**Note Linux** : l'exemple de chaînage via `host.docker.internal` ci-dessous est automatique sur Docker Desktop (macOS / Windows). Sur Docker Engine Linux pur, vous devez généralement ajouter `--add-host=host.docker.internal:host-gateway` pour que le nom soit résolu vers le pont hôte. Sinon, la recherche de nom du conteneur échoue et le proxy ne peut pas atteindre le service en amont en cours d'exécution sur l'hôte. Exemple de chaînage du proxy de cache-fix via `llm-relay` en cours d'exécution sur l'hôte :

```bash
docker run -d --name cache-fix-proxy --restart=always -p 9801:9801 \
  --add-host=host.docker.internal:host-gateway \
  -e CACHE_FIX_PROXY_UPSTREAM=http://host.docker.internal:8080 \
  ghcr.io/cnighswonger/claude-code-cache-fix:latest
```

**Mode proxy avant sous Docker** (garde Remote Control fonctionnel ; voir [Mode proxy avant](#forward-proxy-mode-keeps-remote-control-working)). Ajoutez `-e CACHE_FIX_FORWARD_PROXY=on` et pointez `CACHE_FIX_CA_DIR` vers un chemin accessible en écriture. L'image s'exécute en tant qu'utilisateur non privilégié `node` (uid 1000), et un volume nommé Docker frais est monté en tant que `root`, donc utilisez un bind mount que vous `chown` vers uid 1000 (cela persiste aussi les CA entre les redémarrages et permet à l'hôte de la lire) :

```bash
mkdir -p ./cache-fix-ca && sudo chown 1000:1000 ./cache-fix-ca
docker run -d --name cache-fix-proxy --restart=always -p 9801:9801 \
  -e CACHE_FIX_FORWARD_PROXY=on \
  -e CACHE_FIX_CA_DIR=/ca -v "$PWD/cache-fix-ca:/ca" \
  ghcr.io/cnighswonger/claude-code-cache-fix:latest

# La CA est maintenant à ./cache-fix-ca/ca.pem sur l'hôte. Pointez le client vers le proxy
# (laissez ANTHROPIC_BASE_URL non défini pour garder Remote Control activé) :
HTTPS_PROXY=http://127.0.0.1:9801 NODE_EXTRA_CA_CERTS=$PWD/cache-fix-ca/ca.pem claude
```

Si vous n'avez pas besoin que la CA persiste sur l'hôte, supprimez le volume et laissez-la vivre dans la couche écrivable du conteneur : `-e CACHE_FIX_CA_DIR=/tmp/cache-fix-ca` (puis `docker cp cache-fix-proxy:/tmp/cache-fix-ca/ca.pem ./ca.pem` pour la récupérer). Vérifiez que ça fonctionne : `curl -s localhost:9801/health` doit indiquer `"forward_proxy":true` ; un `false` signifie que le proxy est revenu en mode proxy inverse (par exemple, un répertoire CA non accessible en écriture).

### Vérification de santé

```bash
curl http://127.0.0.1:9801/health
# {"status":"ok"}
```

### Configuration du proxy

Toutes les options du proxy sont contrôlées via des variables d'environnement. Définissez-les avant de démarrer le serveur du proxy.

| Variable | Valeur par défaut | Description |
|----------|-------------------|-------------|
| `CACHE_FIX_PROXY_PORT` | `9801` | Port d'écoute |
| `CACHE_FIX_PROXY_BIND` | `127.0.0.1` | Adresse de liaison |
| `CACHE_FIX_PROXY_UPSTREAM` | `https://api.anthropic.com` | URL de l'hôte en amont. Modifiez pour chaîner un autre proxy (par exemple `http://localhost:8080`) |
| `CACHE_FIX_FORWARD_PROXY` | non définie | Définissez sur `on` pour le mode proxy avant (HTTP CONNECT + MITM sélectif de l'hôte en amont) afin que le client pointe `HTTPS_PROXY` vers le proxy au lieu de `ANTHROPIC_BASE_URL`, gardant Remote Control activé. Voir [Mode proxy avant](#forward-proxy-mode-keeps-remote-control-working). |
| `CACHE_FIX_CA_DIR` | `~/.claude/cache-fix-ca` | Répertoire pour la CA/feuille du proxy avant (générée une seule fois au premier démarrage). Le client fait confiance à `ca.pem` via `NODE_EXTRA_CA_CERTS`. |
| `CACHE_FIX_PROXY_TIMEOUT` | `600000` | Délai d'attente des requêtes en millisecondes |
| `CACHE_FIX_EXTENSIONS_DIR` | `proxy/extensions/` | Répertoire pour les fichiers d'extension `.mjs` |
| `CACHE_FIX_EXTENSIONS_CONFIG` | `proxy/extensions.json` | Fichier de configuration des extensions |
| `CACHE_FIX_DEBUG` | `0` | Activer la journalisation détaillée |
| `CACHE_FIX_HOT_RELOAD` | non définie | Définissez sur `on` pour activer le rechargement dynamique des extensions en processus. Désactivé par défaut depuis la v4.0.0 — voir [Mise à jour depuis v3.x](#upgrading-from-v3x) pour les détails et le flux de redémarrage du superviseur. |
| `CACHE_FIX_READ_DEDUPE` | non définie | Définissez sur `1` pour supprimer les doublons des résultats de l'outil `Read` qui réapparaissent inchangés à plusieurs tours. Garde la première occurrence intacte ; remplace les occurrences ultérieures identiques (indexées sur `file_path` + contenu + `offset` + `limit`) par une référence stable. Désactivé par défaut ; activez par session pour valider avant un déploiement plus large. Voir [guide d'impact des extensions](docs/extension-impact-guide.md). |

### Environnements d'entreprise (proxies, CAs personnalisées)

Le proxy respecte les variables d'environnement suivantes lors du transfert vers `api.anthropic.com`. Derrière Zscaler / Netskope / Forcepoint / Bluecoat / squid d'entreprise, définissez-les dans l'environnement du proxy.

| Variable | Effet |
|----------|--------|
| `HTTPS_PROXY` / `HTTP_PROXY` (et variantes en minuscule) | Redirige les requêtes en amont via le proxy HTTP d'entreprise. |
| `NO_PROXY` | Liste séparée par des virgules des hôtes à contourner le proxy. Prend en charge `*` et `.suffix.example.com`. |
| `CACHE_FIX_PROXY_CA_FILE` | Chemin vers un fichier PEM contenant un ou plusieurs certificats CA supplémentaires (pour les proxies inspectant le SSL). |
| `NODE_EXTRA_CA_CERTS` | Mécanisme standard de Node — également respecté. |
| `CACHE_FIX_PROXY_REJECT_UNAUTHORIZED=0` | **Échappatoire insecurisée.** Désactive la vérification TLS. Utilisez uniquement comme dernier recours pendant que vous attendez que l'IT vous fournisse le bundle CA d'entreprise. |

Exemple (PowerShell Windows) :

```powershell
$env:HTTPS_PROXY = 'http://proxy.corp.example:8080'
$env:NO_PROXY    = 'localhost,127.0.0.1,.corp.example'
$env:CACHE_FIX_PROXY_CA_FILE = 'C:\corp\zscaler-root.pem'
node "$(npm root -g)\claude-code-cache-fix\proxy\server.mjs"
```

La sortie d'erreur standard affichera `[upstream] using proxy http://proxy.corp.example:8080 ...` à la première requête lorsque l'agent est correctement configuré. Sans variables d'environnement proxy/CA définies, le comportement reste inchangé par rapport aux versions précédentes (agent par défaut de Node, magasin de confiance système).

### Intégration du proxy dans votre propre processus

Si vous distribuez un binaire Node ou Bun qui souhaite intégrer le proxy de correction de cache en processus (par exemple, un agent compilé avec Bun évitant de lancer un processus enfant Node), importez la fabrique depuis `claude-code-cache-fix/proxy/server` :

```js
import { startProxy } from "claude-code-cache-fix/proxy/server";

const handle = await startProxy({
  port: 0,        // port éphémère attribué par le système ; passez un nombre pour le figer
  bind: "127.0.0.1",
  watch: false,   // sauter `fs.watch` — recommandé pour les binaires compilés
});

console.log(`proxy en écoute sur ${handle.address}:${handle.port}`);

// ...plus tard...
await handle.close();
```

**`createProxyServer()` → `http.Server`** construit le gestionnaire de requêtes connecté à un `http.Server`. Le serveur retourné *n'est pas* en écoute et la chaîne d'extensions n'a pas été chargée — utilisez cela lorsque vous souhaitez gérer le cycle de vie vous-même.

**`startProxy(options?)` → `Promise<{ server, port, address, close }>`** charge la chaîne d'extensions, démarre éventuellement l'observateur de fichiers, et démarre l'écoute. Retourne un handle avec le port attribué (résolu quand `port: 0` est demandé) et une fonction `close()` qui libère le serveur et l'observateur.

Options (toutes optionnelles ; toutes retournent aux mêmes variables d'environnement utilisées par la CLI) :

| Option | Valeur par défaut | Effet |
|--------|-------------------|--------|
| `port` | `CACHE_FIX_PROXY_PORT` si définie, sinon `9801` | Port d'écoute. Passez `0` pour un port éphémère attribué par le système. |
| `bind` | `CACHE_FIX_PROXY_BIND` si définie, sinon `127.0.0.1` | Adresse de liaison. |
| `extensionsDir` | `proxy/extensions/` du paquet | Répertoire pour charger les extensions `.mjs`. |
| `extensionsConfig` | `proxy/extensions.json` du paquet | Chemin vers la configuration des extensions. |
| `watch` | `true` | Si l'observateur `fs.watch` doit être démarré sur la configuration des extensions. Définissez `false` pour une utilisation embarquée / binaire compilé. |

**Un registre d'extensions par processus.** La chaîne maintient un registre d'extensions partagé unique au niveau du module. Héberger deux instances `startProxy()` dans le même processus est supporté (ports différents, adresses de liaison différentes), mais elles partagent ce registre — un appel ultérieur à `loadExtensions` le remplace pour les deux. Si vous avez besoin de configurations d'extensions divergentes par instance, exécutez-les dans des processus séparés.

**L'appel CLI reste inchangé.** `node proxy/server.mjs`, `cache-fix-proxy server`, et le chemin de l'enveloppe via `child-fork` démarrent automatiquement l'écoute et installent les gestionnaires SIGTERM/SIGINT comme avant. Les imports de bibliothèque n'activent jamais ce comportement — l'écoute automatique est conditionnée par un contrôle du module principal.

*La fabrique intégrable a été contribuée par [@bilby91](https://github.com/bilby91) chez [Crunchloop DAP](https://dap.crunchloop.ai) — voir [PR #123](https://github.com/cnighswonger/claude-code-cache-fix/pull/123).*

## Ce que ce proxy protège contre

**Régressions liées à l'économie du cache.** L'objectif initial de cache-fix est d'absorber les comportements de gestion du cache dans Claude Code qui coûtent de l'argent réel et de la quota à l'utilisateur — les baisses de TTL, les changements fréquents des en-têtes de rupture de cache, les problèmes d'ancrage d'identité, et le reste du catalogue de régressions documenté dans notre historique des problèmes. Le proxy s'interpose entre CC et l'API Anthropic, normalise le flux de requêtes et de réponses, et fournit une observabilité suffisante (via l'intégration avec statusline et les fichiers quota-status) pour que les utilisateurs puissent voir ce que leur session fait réellement. Il s'agit de la fonctionnalité essentielle pour presque tous les utilisateurs actuels.

**Observabilité du canal de démarrage.** Claude Code v2.1.150 a introduit un consommateur de section de prompt qui récupère une chaîne fournie par le serveur depuis `/api/claude_cli/bootstrap` et l'intègre au chemin des instructions comportementales de l'agent. Nous avons signalé ce comportement à l'équipe sécurité d'Anthropic en mai 2026 ; Anthropic a classé le rapport comme *Informative*, considérant le TLS comme la limite d'intégrité du transport, et a refusé d'ajouter des vérifications d'authenticité au niveau applicatif. cache-fix a introduit un traitement explicite pour cette route dans la version v3.7.0, et l'a étendu dans v3.7.1 pour couvrir également la surface d'injection de prompt sélectionnée par variable d'environnement qui est apparue dans CC v2.1.152 (mode de contrôle à distance : `CLAUDE_CODE_SYSTEM_PROMPT_GB_FEATURE` désigne une clé de drapeau dont la valeur mise en cache est utilisée comme corps de l'instruction système). Stable dans la branche actuelle v4.x.

L'extension `bootstrap-defense` de cache-fix propose trois modes, sélectionnés via `CACHE_FIX_BOOTSTRAP_MODE` :

| Mode | Par défaut ? | Comportement |
|---|---|---|
| `audit` | oui | Les réponses bootstrap passent par le proxy vers CC. Chaque réponse est journalisée dans `~/.claude/cache-fix-bootstrap-log.jsonl` avec des métadonnées de surface : les sources de prompt qui ont été activées (`tengu_heron_brook` hérité et/ou sélectionnée par variable d'environnement), le hachage SHA-256 de la valeur (les 16 premiers caractères hexadécimaux — jamais la valeur elle-même), et le drapeau `CLAUDE_CODE_REMOTE`. Les réponses multi-surfaces émettent une entrée par surface, corrélées par `request_id` + fenêtre horaire. |
| `block` | optionnel | `onRequest` renvoie un 200 avec un corps JSON vide. L'upstream n'est jamais appelé, aucune carte de drapeaux n'atteint jamais le cache GrowthBook sur disque. Neutralise à la fois les surfaces d'injection héritées et sélectionnées par variable d'environnement. |
| `allowlist` | optionnel (expérimental) | Les réponses bootstrap passent par le proxy, mais les clés sources de prompt appartenant à des surfaces autorisées (clé héritée `tengu_heron_brook` + clé sélectionnée par variable d'environnement) non présentes dans la liste autorisée sont supprimées du corps de la réponse avant qu'elle n'atteigne CC. La liste autorisée par défaut est `tengu_heron_brook` (la seule clé historique légitime connue) ; configurez-la via `CACHE_FIX_BOOTSTRAP_ALLOWED_KEYS=clé1,clé2`. Passez `CACHE_FIX_BOOTSTRAP_ALLOWED_KEYS=` (vide explicitement) pour une interdiction totale. Les autres clés de drapeaux GrowthBook passent sans modification. Peut nécessiter des mises à jour si Anthropic ajoute des clés de source de prompt légitimes dans des versions futures de CC. |

Remarque : les versions de cache-fix antérieures à v3.6.2 renvoyaient un 404 pour le chemin bootstrap car le routeur du proxy ne l'incluait pas — l'effet pratique était que le contenu de démarrage n'atteignait pas CC pour les utilisateurs de cache-fix. La version par défaut `audit` de v3.7.0 change ce comportement ; une configuration explicite `CACHE_FIX_BOOTSTRAP_MODE=block` le préserve. Le registre complet de divulgation, y compris le texte verbatim de la fermeture d'Anthropic, se trouve dans [`docs/disclosure/heron-brook-2026-05.md`](docs/disclosure/heron-brook-2026-05.md).

**Matériel de référence :**
- [`docs/disclosure/heron-brook-2026-05.md`](docs/disclosure/heron-brook-2026-05.md) — registre complet de divulgation
- [`CHANGELOG.md`](CHANGELOG.md#371---2026-05-27) — entrée de version v3.7.1 (couverture étendue des surfaces + mode liste autorisée) ; [entrée v3.7.0](CHANGELOG.md#370---2026-05-26) couvre la note sur le changement de comportement précédent
- [`cnighswonger/heron-brook-poc`](https://github.com/cnighswonger/heron-brook-poc) — reproducteur du comportement du canal de démarrage

**Protection contre les dépassements de contexte 1M.** À partir de CC v2.1.161 (notamment la surface de l'extension VS Code), le contexte 1M peut être sélectionné automatiquement sur le plan Pro sans demande utilisateur, consommant immédiatement des crédits en excédent. L'extension `auto-1m-guard` du proxy détecte le jeton `context-1m-2025-08-07` dans l'en-tête sortant `anthropic-beta` et émet un avertissement ou le supprime, selon le mode choisi via `CACHE_FIX_AUTO_1M_GUARD` :

| Mode | Par défaut ? | Comportement |
|---|---|---|
| `off` | non | L'extension est inactive. |
| `warn` | oui | Détecte le jeton. Stocke une annotation dans le JSON de session (`auto_1m_detected`, `auto_1m_action: "warn"`, `auto_1m_advice`) et émet une ligne de journalisation sur stderr. Ne modifie pas la requête. |
| `strip` | optionnel | Détecte ET supprime le jeton de l'en-tête `anthropic-beta` avant acheminement. Annotation : `auto_1m_action: "stripped"`. |

L'interrupteur de fin côté CC est `CLAUDE_CODE_DISABLE_1M_CONTEXT=1` (variable d'environnement), qui est la solution correcte lorsqu'elle atteint effectivement le processus CC. Sur la surface de l'extension VS Code, cette variable d'environnement est rapportée comme peu fiable ; le proxy intercepte cette faille car il agit sur le fil indépendamment du lanceur CC qui a produit la requête. Suivi de [CC#64919](https://github.com/anthropics/claude-code/issues/64919) ; voir [`docs/directives/proxy-auto-1m-guard.md`](docs/directives/proxy-auto-1m-guard.md) pour la marche binaire qui confirme que le signal visible par le proxy est l'en-tête beta (CC supprime le suffixe `[1m]` de `req.body.model` côté client avant l'envoi).

## Configuration opérationnelle recommandée pour CC

Le proxy corrige ce qu'il peut corriger au niveau de la requête. Quelques variables d'environnement côté client CC et des paramètres dans `~/.claude/settings.json` résolvent des problèmes adjacents que le proxy ne peut pas atteindre — changements silencieux de modèle lors des mises à jour de CC, choix ambigu de modèle de secours, effets secondaires liés au retrait du schéma. Ces éléments sont exposés ici à titre de recommandation ; chaque utilisateur décide de sa propre configuration.

Ces observations proviennent de l'analyse binaire de CC v2.1.91 par [@fgrosswig](https://github.com/fgrosswig). La méthodologie est publique (PowerShell + extraction de chaînes ASCII) ; il a partagé la liste résultante en privé en guise de courtoisie.

### Bloc d'environnement suggéré dans `~/.claude/settings.json`

Les identifiants de modèle ci-dessous sont donnés à titre d'exemple — remplacez-les par vos modèles principaux et rapides préférés. L'objectif est de fixer *quelque chose* de explicite plutôt que de dépendre des valeurs par défaut de CC.

```json
{
  "env": {
    "CLAUDE_CODE_DISABLE_LEGACY_MODEL_REMAP": "1",
    "ANTHROPIC_MODEL": "claude-opus-4-7",
    "ANTHROPIC_SMALL_FAST_MODEL": "claude-haiku-4-5-20251001"
  }
}
```

**`CLAUDE_CODE_DISABLE_LEGACY_MODEL_REMAP=1`** — le drapeau le plus impactant. CC dispose d'un chemin de code hérité qui remplace silencieusement votre modèle fixé par un autre après certaines mises à jour de version. Définir cette variable à `1` désactive ce remappage ; le modèle que vous fixez est bien celui que vous obtenez. (Si vous ne fixez pas de modèle, les valeurs par défaut de CC s'appliquent comme d'habitude.)

**`ANTHROPIC_MODEL`** — fixe le modèle principal. Garder cette valeur explicite garantit que le hachage du préfixe du cache reste stable lors des mises à jour de CC qui pourraient autrement changer votre modèle par défaut. Ajustez-la selon le modèle que vous souhaitez réellement utiliser.

**`ANTHROPIC_SMALL_FAST_MODEL`** — fixe le modèle "rapide" utilisé par CC pour les appels auxiliaires courts (par exemple, génération de titre, classification). Sans une fixation explicite, ce modèle peut basculer silencieusement vers une autre famille lors d'une mise à jour.

### Avertissement concernant `autoCompactWindow=1000000`

Si vous avez vu la recommandation `autoCompactWindow: 1000000` ailleurs : elle n'est effective que lorsque le modèle actif est compatible avec un contexte de 1M (actuellement `claude-sonnet-4-6` ou `claude-opus-4-6` avec l'en-tête bêta approprié). Sans ces conditions préalables, elle est limitée à 200K, quelle que soit la valeur que vous définissez.

### Effet secondaire de `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` sur le schéma

Si vous activez ce drapeau, CC supprime tout champ d'outil en dehors de `["name", "description", "input_schema", "cache_control"]` des requêtes sortantes. Les outils personnalisés qui dépendent de `defer_loading` ou `eager_input_streaming` perdent silencieusement ces champs et se comportent différemment. À connaître avant d'activer ce drapeau.

## Comportements connus de CC qui affectent le coût du cache

Ce ne sont pas des bogues corrigés par les correctifs cache-fix — ce sont des comportements amont de CC auxquels les utilisateurs doivent prêter attention lors de la estimation du coût de leur session.

### Les commandes slash de diagnostic augmentent l'historique de conversation ([#49335](https://github.com/anthropics/claude-code/issues/49335))

Exécuter `/context`, `/release-notes` (et probablement d'autres commandes d'inspection d'état) ajoute la sortie de diagnostic à l'historique de conversation au lieu de la rendre uniquement dans le terminal. Les tours suivants rejouent cette charge augmentée via le prompt cache, amplifiant ainsi le coût en jetons pour une action d'inspection d'état qui devrait être gratuite. Mesuré empiriquement à +3 480 `cache_creation_input_tokens` pour une seule invocation de `/context` sur v2.1.148 ; un autre utilisateur signale ~5 000 dans une session distincte. `/release-notes` est pire — il démarre par défaut par le déploiement de la liste des modifications complète.

Pire encore pour le diagnostic : la charge augmentée qui facture votre cache n'est pas écrite dans le transcript JSONL local, vous ne pouvez donc pas auditer la source du coût localement — vous ne pouvez que l'inférer à partir des sauts dans `cache_creation_input_tokens` dans les métadonnées d'utilisation des réponses. (Les utilisateurs en mode proxy peuvent inspecter les écarts dans les fichiers `~/.claude/quota-status/`, que le proxy écrit directement à partir des en-têtes de réponse.)

**Solution provisoire jusqu'à la correction amont :** utilisez ces commandes avec parcimonie dans les sessions longues. Si vous en avez besoin fréquemment dans une session, envisagez d'utiliser `/compact` après une exécution de diagnostic pour réinitialiser le débordement.

## Modèle de sécurité

> **Le proxy et l'intercepteur ont un accès complet en lecture et écriture aux requêtes et réponses API.** Cela découle de la nature de cette approche — tout intercepteur de requêtes, proxy ou passerelle dispose de cette position.

**Ce qu’il fait :** Modifie la structure des requêtes sortantes (ordre des blocs, empreinte, TTL, statut git) pour corriger les bugs du cache. Lit les en-têtes de réponse et les données d'utilisation SSE pour la surveillance.

**Ce qu’il ne fait PAS :** Aucun appel réseau depuis le proxy ou l'intercepteur. Toute la télémétrie est écrite dans des fichiers locaux sous `~/.claude/`. Aucune donnée ne quitte votre machine.

**Chaîne d’approvisionnement :** Mode proxy : petits modules d’extension ciblés dans `proxy/extensions/` (la plupart sous quelques centaines de lignes ; le pipeline est composable, vous pouvez lire n’importe lequel isolément). Mode préchargement : fichier unique non minifié (`preload.mjs`). Une seule dépendance de développement (`zod` pour la validation de schéma, uniquement dans les tests). Vérifiez avant d’installer. Les builds publiés portent les signatures par défaut du registre npm ; l’attestation de provenance sigstore n’est pas actuellement publiée — suivie comme une action ultérieure.

**Audit indépendant :** [Évalué comme "OUTIL LÉGITIME"](https://github.com/anthropics/claude-code/issues/38335#issuecomment-4244413605) par @TheAuditorTool (2026-04-14).

## Le problème

Lorsque vous utilisez `--resume` ou `/resume` dans Claude Code, le cache de prompt se brise silencieusement. Au lieu de lire les jetons mis en cache (économiques), l'API les reconstruit depuis le début à chaque tour (coûteux). Une session qui devrait coûter environ 0,50 $/heure peut rapidement atteindre 5 à 10 $/heure sans aucun signe visible qu'il y a un problème.

Trois bogues causent cela :

1. **Éparpillement partiel des blocs** — Les blocs de pièce jointe (liste des compétences, serveurs MCP, outils différés, hooks) doivent se trouver dans `messages[0]`. Lors d'une reprise, certains ou tous dérivent vers des messages ultérieurs, modifiant ainsi le préfixe du cache.

2. **Instabilité de l'empreinte** — L'empreinte `cc_version` (par exemple `2.1.92.a3f`) est calculée à partir du contenu de `messages[0]`, y compris les blocs métadonnées et pièces jointes. Lorsque ces blocs se déplacent, l'empreinte change, le système prompt change, et le cache est invalidé.

3. **Ordre non déterministe des outils** — Les définitions d'outils peuvent arriver dans un ordre différent entre les tours, modifiant les octets de la requête et invalidant ainsi la clé du cache.

En outre, les images lues via l'outil Read persistent sous forme de base64 dans l'historique de conversation et sont envoyées à chaque appel API ultérieur, augmentant silencieusement le coût en jetons.

## Fonctionnement

**Mode proxy** (v3.0.0+) : un serveur HTTP sur `localhost:9801` intercepte les requêtes `POST /v1/messages`. Une chaîne de modules d'extension traite chaque requête — normalisation de l'ordre des blocs, suppression des empreintes, stabilisation du tri des outils, gestion des marqueurs TTL, nettoyage des blocs de pensée, enregistrement de la télémétrie, etc. Les modules d'extension sont des fichiers `.mjs` configurés dans `proxy/extensions.json` et sont chargés une seule fois au démarrage du proxy (rechargement dynamique activé à la demande depuis la v4.0.0 — voir [Mise à jour depuis la v3.x](#upgrading-from-v3x)). Tout le reste du trafic passe sans modification.

**Mode préchargement** (v2.x) : un module Node.js `--import` qui patche `globalThis.fetch` avant que Claude Code effectue des appels API. Applique les mêmes corrections en ligne — analyse des messages utilisateur pour détecter les blocs déplacés, tri des outils, recalcul des empreintes, injection des marqueurs TTL.

Les deux modes sont idempotents — si rien n'a besoin d'être corrigé, la requête passe sans modification. Aucun des deux modes ne modifie votre conversation ; ils ne normalisent que la structure de la requête avant qu'elle n'atteigne l'API.

## Passage des corrections

Le paquet sert à trois fins ayant des cycles de vie différents :

| Objectif | Exemples | Quand désactiver |
|---------|----------|-----------------|
| **Corrections de bogues** | Déplacement de bloc, empreinte, tri des outils, TTL | Lorsque CC corrige le bogue sous-jacent — vérifiez la ligne d'état |
| **Surveillance** | Suivi de la quota, détection de microcompact, indicateurs GrowthBook | À conserver en permanence — ces éléments détectent les régressions futures |
| **Optimisations** | Suppression d'images, réécriture de l'efficacité de la sortie | À conserver tant qu'elles améliorent votre flux de travail |

### État de santé (mode préchargement)

À la première appel API, l'intercepteur enregistre une ligne d'état de santé (nécessite `CACHE_FIX_DEBUG=1`) :

```
cache-fix health: relocate=active(2h ago) fingerprint=dormant(5 sessions propres) tool_sort=active ttl=active identity=waiting
```

- **active(Xh ago)** — la correction a été appliquée récemment
- **dormant(N sessions propres)** — le bogue n'a pas été détecté lors de N sessions ; CC l'a peut-être corrigé
- **safety-blocked(Nx)** — la vérification en aller-retour a échoué ; la correction est désactivée automatiquement
- **waiting** — la correction n'a pas encore été déclenchée

### Détection de régression

Si le taux de `cache_read` chute en dessous de 50 % sur 5 appels ou plus après la désactivation des corrections :
```
AVERTISSEMENT DE RÉGRESSION : le taux de cache_read a été de 12 % en moyenne sur les 5 derniers appels.
Les corrections sont désactivées — envisagez de les réactiver pour retrouver les performances du cache.
```

## Sécurité

### Vérification du cycle de vérification de l'empreinte

Avant de réécrire l'empreinte `cc_version`, l'intercepteur vérifie que son sel prédéfini et ses indices de caractères reproduisent l'empreinte envoyée par Claude Code. Si la vérification échoue (CC a changé son algorithme), la réécriture est automatiquement ignorée. Cela garantit que l'intercepteur ne peut jamais dégrader les performances du cache par rapport à la version d'origine de CC.

### Conception avec sécurité

Chaque correction est conçue pour échouer de manière inoffensive :
- Si les expressions régulières de détection de bloc ne correspondent pas → les blocs ne sont pas déplacés (comportement de CC)
- Si le format de l'empreinte change → l'empreinte n'est pas réécrite (comportement de CC)
- Si le tri des outils ne produit aucune modification → le payload passe sans être modifié
- Si la structure cible de l'injection de TTL change → le TTL n'est pas injecté (comportement de CC)

L'intercepteur ne peut que *aider* ou *ne rien faire*. Il ne peut jamais aggraver la situation.

## Ligne d'état — avertissements de quota en temps réel

Les deux modes écrivent l'état du quota à chaque appel API. Le mode proxy (v3.5.0+) sépare les données en `~/.claude/quota-status/account.json` (champs globaux au compte : Q5h/Q7d, statut, dépassement) et `~/.claude/quota-status/sessions/<id>.json` (champs du cache par session : niveau TTL, taux de succès). Le mode préchargé conserve le fichier hérité `~/.claude/quota-status.json` (une seule session par construction). Le script inclus `tools/quota-statusline.sh` affiche une ligne d'état en temps réel indiquant :

- **Q5h** barre de quota `[███░┃░░░░░]` + pourcentage + `(épuisement X, réinitialisation Y)`. Les cellules remplies représentent le quota consommé ; la barre verticale épaisse indique la position dans le temps réel au sein de la fenêtre. Une barre à droite de la remplissage = consommation en dessous du rythme ; une barre à l'intérieur du remplissage = consommation plus rapide que le temps (rythme excessif). `épuisement` est le temps projeté jusqu'à 100 % au rythme actuel ; `réinitialisation` est le temps réel jusqu'à la rotation de la fenêtre. Quand `épuisement < réinitialisation`, vous atteindrez 100 % avant la réinitialisation — réduisez votre rythme.
- **Q7d** même forme avec des durées à l'échelle journalière (ex. `(épuisement 3j13h, réinitialisation 3j0h)`). En dessous d'une journée, le suffixe bascule automatiquement vers le format `h/m` (ex. `(épuisement 1h41m, réinitialisation 0h30m)`).
- **TTL** — `TTL:1h` quand sain, **`TTL:5m` en rouge quand le serveur vous a dégradé** (généralement quand Q5h ≥ 100 %)
- **PEAK** en jaune pendant les heures de pointe en semaine (13:00–19:00 UTC)
- **Taux de succès du cache %**
- **DEPASSEMENT** en surbrillance quand actif
- **Indicateur de divergence du modèle servi** — quand le modèle servi diffère du modèle demandé (le schéma de changement piloté par le classificateur dans [CC#66728](https://github.com/anthropics/claude-code/issues/66728)), la barre affiche un segment rouge `demandé → servi`, ou un `demandé → servi` noir sur jaune pour un état figé une fois que l'heuristique familiale a pris effet. Aucun segment n'apparaît sur le chemin par défaut sans divergence. Le suffixe `[1m]` apparaît uniquement du côté demandé quand `auto_1m_detected` est activé.

Ligne d'exemple (au milieu de la fenêtre, état sain) :

```
Q5h [███░┃░░░░░] 30% (épuisement 4h40m, réinitialisation 3h00m) | Q7d [█████┃░░░░] 53% (épuisement 3d13h, réinitialisation 3d0h) | TTL:1h 98.3%
```

Le suffixe `(épuisement …, réinitialisation …)` est supprimé progressivement quand la projection n’a plus de sens : à 0 % (fenêtre fraîche) et à 100 % (déjà épuisée), seul `réinitialisation` est affiché ; dans les 5 premières minutes après le début de la fenêtre, le taux de consommation n’est pas suffisamment stable pour projeter (un appel initial unique domine le taux), donc `épuisement` est retardé jusqu’à ce que cette période soit passée, sur Q5h et Q7d ; une valeur `resets_at` périmée (valeur rapportée par le serveur dans le passé, avant la prochaine actualisation par appel API) fait disparaître les deux.

La barre utilise des caractères Unicode (`█┃░`) — la plupart des terminaux modernes les affichent correctement. Si votre terminal remplace ces caractères par des cases ou des glyphes de remplacement, configurez une police capable de gérer Unicode (toute police DejaVu, Fira, Iosevka, JetBrains Mono, etc.).

### Configuration

```bash
mkdir -p ~/.claude/hooks
cp "$(npm root -g)/claude-code-cache-fix/tools/quota-statusline.sh" ~/.claude/hooks/
chmod +x ~/.claude/hooks/quota-statusline.sh
```

Ajoutez à `~/.claude/settings.json` :

```json
{
  "statusLine": {
    "type": "command",
    "command": "~/.claude/hooks/quota-statusline.sh"
  }
}
```

### Pourquoi la ligne d'état est importante

Quand le serveur réduit votre TTL à 5 minutes (dégradation consciente du quota à Q5h ≥ 100 %), **chaque inactivité supérieure à 5 minutes provoque une reconstruction complète du contexte**. Sans la ligne d'état, cela passe inaperçu. Avec elle, l'avertissement rouge `TTL:5m` vous indique : **arrêtez de travailler, attendez que la fenêtre Q5h se réinitialise, puis reprenez**. Continuer malgré le dépassement aggrave la consommation ; s'arrêter brise le cycle.

### Recommandé : désactiver l'injection git-status

Claude Code injecte en temps réel l’état `git status` dans l’invite système à chaque appel. Toute modification de fichier change l’état git, ce qui invalide entièrement le cache de préfixe. Désactiver cela économise environ 1 800 tokens par appel :

```bash
export CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS=1
```

Ou ajoutez `"includeGitInstructions": false` à `~/.claude/settings.json`. Claude Code peut toujours exécuter `git status` via l’outil Bash quand il en a besoin. Validé par la communauté par [@wadabum](https://github.com/cnighswonger/claude-code-cache-fix/issues/11) : création de cache de 18 tokens malgré les changements d’état git (contre des milliers sans ce drapeau).

**Pourquoi nous n’expédions pas une extension proxy pour cela** : le proxy intercepte les requêtes après que Claude Code a déjà composé l’invite système — à ce stade, le texte volatile `git status` fait déjà partie du préfixe sur lequel le modèle s’est basé lors du tour précédent, et le supprimer après coup invaliderait à nouveau le cache. La correction doit intervenir à la source. `CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS=1` empêche l’injection avant que l’invite ne soit composée, c’est pourquoi le drapeau natif est l’outil approprié. Supprimer après coup supprimerait aussi du contexte visible par le modèle que l’appel explicite Bash peut récupérer, et risquerait des correspondances erronées contre du texte rédigé par l’assistant.
