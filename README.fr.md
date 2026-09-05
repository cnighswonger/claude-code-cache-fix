# claude-code-cache-fix

[![npm](https://img.shields.io/npm/v/claude-code-cache-fix?color=blue)](https://www.npmjs.com/package/claude-code-cache-fix) [![Node.js](https://img.shields.io/badge/Node.js-18%2B-green)](https://nodejs.org/) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow)](https://opensource.org/licenses/MIT) [![GitHub stars](https://img.shields.io/github/stars/cnighswonger/claude-code-cache-fix)](https://github.com/cnighswonger/claude-code-cache-fix/stargazers)

[English](./README.md) | [中文](./README.zh.md) | [한국어](./README.ko.md) | Français | [Português](./docs/guia-pt-br.md)

> **Remarque :** Cette traduction est assistée par machine et peut être en retard par rapport au README anglais. Pour toute information faisant autorité, consultez [README.md](./README.md). Les corrections sont les bienvenues — veuillez ouvrir un PR.
>
> **Note:** This translation is machine-assisted and may lag the English README. For anything authoritative, see [README.md](./README.md). Corrections are very welcome — please open a PR.

Proxy d'optimisation du cache pour [Claude Code](https://github.com/anthropics/claude-code). Corrige les bogues du prompt cache qui entraînent une consommation excessive du quota, stabilise le préfixe de requête et surveille les régressions silencieuses. Fonctionne avec toutes les versions de CC, y compris le binaire Bun v2.1.113+.

*Ce README documente la branche `main` actuelle ; la disponibilité des versions est notée par fonctionnalité.*

## Ce qu'il fait à votre trafic

Un proxy local se place entre Claude Code et Anthropic. Avant de continuer la lecture, voici exactement ce que cela signifie — le traitement complet se trouve dans [Modèle de sécurité](#modèle-de-sécurité).

- **Se lie à `127.0.0.1`** par défaut.
- **Transmet le trafic de Claude Code à Anthropic. Sur le chemin par défaut, il n'effectue aucun autre appel sortant** — la télémétrie est écrite dans des fichiers locaux sous `~/.claude/`, jamais envoyée nulle part. Deux fonctionnalités optionnelles effectuent leurs propres appels sortants, toutes deux désactivées sauf si vous les activez : le rafraîchissement OAuth (`CACHE_FIX_OAUTH_REFRESH=on`) envoie vers le endpoint de tokens d'Anthropic, et l'accélération de téléchargement via le forward proxy réémet les téléchargements de versions vers `downloads.claude.ai` / `storage.googleapis.com`.
- **Peut lire et réécrire `POST /v1/messages`.** Cette capacité *est* la réparation du cache — il n'existe aucune version de ceci qui fonctionne sans elle.
- **La transformation est idempotente : si aucune correction n'est nécessaire, la requête est transmise sans modification.** Elle normalise la structure de la requête (ordre des blocs, empreinte, TTL) ; elle ne modifie pas votre conversation.
- **Chaque transformation est un fichier** dans `proxy/extensions/`, lisible de manière isolée.
- [Évalué indépendamment comme un outil légitime](https://github.com/anthropics/claude-code/issues/38335#issuecomment-4244413605) par @TheAuditorTool (2026-04-14).

Le mode forward proxy (`--remote-control`) termine en plus le TLS pour `api.anthropic.com` à l'aide d'une autorité de certification (CA) générée localement, à laquelle votre client doit faire confiance. Tout le reste transite sans être inspecté. Ce mode est optionnel et désactivé par défaut.

## En avez-vous besoin ?

**Installez ou testez-le si :** les sessions reprises ou de longue durée montrent des pics répétés de `cache_creation_input_tokens` ; votre ratio de lecture du cache est faible ou instable ; vous voyez des passages inattendus à un TTL de 5 min, des erreurs `400` de désynchronisation des blocs Thinking ou des boucles de nouvelles tentatives liées aux images ; ou si l'une des fonctionnalités sans rapport avec le cache décrites ci-dessous vous concerne.

**Vous pouvez l'ignorer si :** vos sessions maintiennent déjà un ratio de lecture du cache stable et élevé ; vous reprenez rarement des sessions longues ; vous n'êtes pas sous pression de quota ; ou vous préférez ne pas placer un proxy local dans le chemin API. **Les quatre sont de bonnes raisons de ne pas installer ceci.**

Si vous ne savez pas dans quel cas vous vous trouvez, mesurez-le — vous n'avez pas besoin de ce projet installé pour le découvrir.

## Vérifier si vous avez ce problème

Claude Code enregistre déjà la comptabilité du cache par requête dans ses propres transcriptions de session, vous pouvez donc mesurer la santé de votre cache maintenant, avant d'installer quoi que ce soit.

```bash
# Replace <session-uuid>, or use a glob to pick your most recent session.
jq -r 'select(.message.usage.cache_read_input_tokens != null) |
  "\(.requestId)\t\(.message.usage.cache_read_input_tokens) \(.message.usage.cache_creation_input_tokens)"' \
  ~/.claude/projects/*/<session-uuid>.jsonl |
  sort -u -k1,1 | cut -f2 |
  awk '{n++; r+=$1; c+=$2}
       END {if (n==0) print "no usage rows found — check the session path";
            else printf "requests=%d cache_read=%d creation=%d read-ratio=%.0f%%\n", n, r, c, 100*r/(r+c)}'
```

`sort -u -k1,1` compte chaque appel API une seule fois — Claude Code écrit plusieurs lignes de transcription par requête, et **pas toujours le même nombre de fois par requête** ([analyse d'ArkNill](https://github.com/ArkNill/claude-code-hidden-problem-analysis)). La somme des lignes brutes pondère chaque appel par son propre nombre de duplicatas. Deux balayages indépendants des transcriptions locales sur une machine (2026-08-02) ont confirmé la tendance : **les courtes sessions sont celles qui posent problème** — plus de la moitié des sessions de moins de 20 requêtes ont décalé d'un point ou plus sans déduplication, pire cas **41 points**, tandis que les longues sessions étaient presque toutes inférieures à un point (3 sur ~37).

Lecture du résultat :

- **Moins de ~20 requêtes : le chiffre est sans signification.** Un démarrage froid n'a rien à lire, donc la création domine et chaque session saine semble cassée. Utilisez une session longue ou reprise.
- **Ratio faible et soutenu sur une longue session, ou `creation` qui explose à chaque `--resume`** — c'est le problème que ce projet existe pour résoudre.
- **Ratio élevé sur une longue session** — vous n'en avez pas besoin. Voir *En avez-vous besoin ?* ci-dessus.

## Avis actuels

> **v4.0.0** — Proxy HTTP local avec un pipeline d'extensions dédiées à l'optimisation des coûts et à l'observabilité. Deux paramètres par défaut de longue date ont été inversés : `thinking-block-sanitize` v1 est activé par défaut (atténue le blocage `400` de désynchronisation des blocs Thinking — [#63147](https://github.com/anthropics/claude-code/issues/63147)) et le rechargement à chaud des extensions dans le processus est optionnel (`CACHE_FIX_HOT_RELOAD=on`). Mesure de référence A/B (v3.0.0 sur v2.1.117) : **95,5 % de cache hits via le proxy, contre 82,3 % en accès direct** au premier tour après warm-up. [Notes de version complètes →](https://github.com/cnighswonger/claude-code-cache-fix/releases/tag/v4.0.0)

> **Avis Opus 4.7 :** Les données mesurées montrent que 4.7 consomme le quota Q5h à un rythme **environ 2,4 fois supérieur à celui de 4.6** à nombre de tokens visibles équivalent ([confirmé indépendamment par @ArkNill](https://github.com/ArkNill/claude-code-hidden-problem-analysis/blob/main/16_OPUS-47-ADVISORY.md)). Deux facteurs : un nouveau tokenizer (jusqu'à 35 % de tokens en plus, [documenté](https://platform.claude.com/docs/en/about-claude/models/whats-new-claude-4-7)) et le surcoût de l'adaptive thinking (~105 %, non documenté dans la réponse d'utilisation). L'impact Q5h se cumule dans le **Q7d** — le plafond hebdomadaire que la plupart des utilisateurs intensifs atteindront en premier. Solution de contournement : `CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING=1` réduit la consommation d'environ 3,3× mais peut réduire la qualité sur les tâches complexes. Voir [Discussion #25](https://github.com/cnighswonger/claude-code-cache-fix/discussions/25) (observation initiale) et [Discussion #42](https://github.com/cnighswonger/claude-code-cache-fix/discussions/42) (données A/B contrôlées + analyse Q7d).

## Démarrage rapide : Proxy (recommandé)

Le proxy fonctionne avec toute version de CC — Node.js ou binaire Bun. Il se place entre Claude Code et l'API Anthropic, appliquant les corrections du cache sous forme d'extensions composables.

```bash
# Install
npm install -g claude-code-cache-fix

# Start the proxy (runs on localhost:9801)
node "$(npm root -g)/claude-code-cache-fix/proxy/server.mjs" &

# Launch Claude Code through it
ANTHROPIC_BASE_URL=http://127.0.0.1:9801 claude
```

C'est tout. Le proxy applique son pipeline d'extensions par défaut automatiquement. Pas de scripts d'encapsulation, pas de `NODE_OPTIONS`, pas de préchargement.

### Mode forward proxy (conserve le fonctionnement de Remote Control)

Le démarrage rapide ci-dessus utilise le **mode reverse proxy** : vous pointez `ANTHROPIC_BASE_URL` vers le proxy. C'est simple, mais sur Claude Code **>= 2.1.196**, un `ANTHROPIC_BASE_URL` non-Anthropic **désactive Remote Control** (`/remote-control`), `/schedule` et les connecteurs MCP de claude.ai (CC traite toute URL de base personnalisée comme une passerelle Bedrock/Vertex). Si vous dépendez de ces fonctionnalités, utilisez le mode forward proxy.

En **mode forward proxy**, le proxy se place devant le *vrai* `api.anthropic.com` en tant que `HTTPS_PROXY`. L'URL de base de Claude Code reste `api.anthropic.com`, donc Remote Control continue de fonctionner, tandis que le proxy voit et transforme toujours `/v1/messages`.

```bash
# Start the proxy in forward-proxy mode
CACHE_FIX_FORWARD_PROXY=on node "$(npm root -g)/claude-code-cache-fix/proxy/server.mjs" &
# It prints the two env vars to wire the client, e.g.:
#   export HTTPS_PROXY=http://127.0.0.1:9801
#   export NODE_EXTRA_CA_CERTS=~/.claude/cache-fix-ca/ca.pem

# Launch Claude Code through it (leave ANTHROPIC_BASE_URL UNSET)
HTTPS_PROXY=http://127.0.0.1:9801 \
NODE_EXTRA_CA_CERTS=~/.claude/cache-fix-ca/ca.pem \
  claude
```

Ou laissez le lanceur faire les deux étapes pour vous avec `--remote-control` :

```bash
# Spawns the proxy with CACHE_FIX_FORWARD_PROXY=on and wires the client
# (HTTPS_PROXY + the MITM CA, ANTHROPIC_BASE_URL left unset) automatically.
cache-fix-proxy --remote-control
```

L'option `--remote-control` est l'équivalent en une commande du câblage manuel ci-dessus : il démarre le proxy en mode forward, attend la CA, et lance `claude` pointé sur `HTTPS_PROXY` avec `NODE_EXTRA_CA_CERTS` défini (et ajoute `127.0.0.1,localhost,::1` à `NO_PROXY` pour que les services locaux — par ex. les serveurs MCP HTTP/SSE-transport sur localhost — contournent le proxy au lieu d'être routés vers lui ; tout `NO_PROXY` existant est préservé). Sans cette option, le lanceur reste en mode reverse proxy (définit `ANTHROPIC_BASE_URL`), inchangé.

> Si vous câblez le mode forward proxy manuellement (en définissant `HTTPS_PROXY` vous-même au lieu d'utiliser `--remote-control`), définissez aussi `NO_PROXY=127.0.0.1,localhost,::1`, sinon les serveurs MCP HTTP-transport locaux et autres services localhost seront routés vers le proxy cache-fix et échoueront.

Fonctionnement : le proxy gère aussi le HTTP `CONNECT`. Il MITM **uniquement** l'hôte amont (`api.anthropic.com`), terminant le TLS avec une CA générée localement pour pouvoir exécuter le même pipeline d'extensions, et **fait transiter tous les autres tunnels `CONNECT` sans les inspecter** (mcp-proxy, télémétrie, npm, ...). Au premier démarrage, il génère une CA sous `$CLAUDE_CONFIG_DIR/cache-fix-ca/` (par défaut `~/.claude/cache-fix-ca/` ; surchargeable via `CACHE_FIX_CA_DIR`) ; le client doit lui faire confiance via `NODE_EXTRA_CA_CERTS`. Un WebSocket/Upgrade vers l'hôte amont (par ex. `/voice`) est relayé tel quel. Parce que l'URL de base reste `api.anthropic.com`, tout `/api/oauth/*`, `/v1/agents`, les récupérations d'identifiants Remote Control, etc. passent sans être touchés et RC reste activé.

Le chaînage avec un proxy d'entreprise fonctionne de la même manière qu'en mode reverse : définissez `HTTPS_PROXY`/`HTTP_PROXY` pour les connexions sortantes du proxy lui-même (le proxy compose `api.anthropic.com` à travers lui). Le `HTTPS_PROXY` du client pointe vers le proxy cache-fix ; le `HTTPS_PROXY` du proxy cache-fix (dans son propre env) pointe vers le proxy d'entreprise.

**Sémantique de crash sur un proxy partagé.** En mode forward proxy, le proxy MITM tout l'hôte amont, donc une session Claude Code en vol est câblée à *ce* port et ne peut pas basculer. Pour éviter qu'une mauvaise requête n'abatte le processus, une attache forward réussie installe des gestionnaires `uncaughtException`/`unhandledRejection` au niveau du processus qui journalisent et continuent de servir au lieu de crasher. Ceux-ci sont limités au mode forward (un proxy reverse seul garde la sémantique de crash par défaut de Node) et sont retirés quand la dernière instance forward se ferme. Le compromis : sur un proxy **partagé / multi-tenant**, activer le mode forward change le comportement de crash pour chaque client de cette instance tant que le mode est actif — une erreur fatale est avalée plutôt que remontée au superviseur.

**Exécution persistante.** Le `... node .../proxy/server.mjs &` ci-dessus convient pour un essai rapide, mais un processus en arrière-plan n'est pas supervisé : il ne redémarre pas s'il crash ou si la machine redémarre. Pour exécuter le mode forward proxy en tant que service géré (redémarrage auto, démarrage à la connexion), utilisez le même chemin `install-service` décrit sous [Exécution en tant que service](#exécution-en-tant-que-service) — définissez simplement le flag à l'installation pour qu'il soit intégré dans l'unité :

```bash
CACHE_FIX_FORWARD_PROXY=on cache-fix-proxy install-service
```

L'unité systemd générée / agent launchd porte `CACHE_FIX_FORWARD_PROXY=on`, donc le service démarre le proxy en mode forward et le maintient (systemd `Restart=on-failure` plus le timer de healthcheck ; launchd `KeepAlive`).

**Le service ne gère que l'extrémité proxy.** Il ne — et ne peut pas — définir quoi que ce soit sur votre client `claude`, qui est un processus séparé. Vous câblez toujours le client vous-même dans le shell qui lance `claude`, en utilisant les deux valeurs du quick-start forward-proxy ci-dessus :

- `HTTPS_PROXY` — où le proxy écoute : `http://127.0.0.1:<port>` (port par défaut `9801`, ou votre `CACHE_FIX_PROXY_PORT`).
- `NODE_EXTRA_CA_CERTS` — la CA que le proxy a générée au premier démarrage : `~/.claude/cache-fix-ca/ca.pem` (ou `$CACHE_FIX_CA_DIR/ca.pem`).

> **Si autre chose sur cet hôte MITM aussi `api.anthropic.com`** — un agent d'inspection TLS d'entreprise, un proxy pin de changement de compte — n'utilisez pas ces recettes. `NODE_EXTRA_CA_CERTS` ne prend qu'un fichier, donc l'épingler à notre seule CA désapprouve silencieusement tous les autres composants. Utilisez `--remote-control`, qui publie dans `ca-trust.d/` et consomme le bundle fusionné à la place. Voir [Coexistence avec un autre MITM](#coexistence-avec-un-autre-mitm-sur-la-même-machine-ca-trustd).

```bash
# a) per-invocation — scoped to just this claude run
HTTPS_PROXY=http://127.0.0.1:9801 \
NODE_EXTRA_CA_CERTS=~/.claude/cache-fix-ca/ca.pem \
  claude

# b) whole shell — add to ~/.zshrc / ~/.bashrc (every HTTPS in that shell goes
#    through the proxy; harmless since non-anthropic hosts are blind-tunneled,
#    but that shell's HTTPS breaks if the proxy is ever down)
export HTTPS_PROXY=http://127.0.0.1:9801
export NODE_EXTRA_CA_CERTS=~/.claude/cache-fix-ca/ca.pem

# c) scoped to claude only — a shell function (recommended; avoids b's blast radius)
claude() {
  HTTPS_PROXY=http://127.0.0.1:9801 \
  NODE_EXTRA_CA_CERTS=~/.claude/cache-fix-ca/ca.pem \
    command claude "$@"
}
```

#### Coexistence avec un autre MITM sur la même machine (`ca-trust.d`)

`NODE_EXTRA_CA_CERTS` ne prend exactement **qu'un** fichier. Si autre chose sur l'hôte MITM aussi `api.anthropic.com` et définit aussi cette variable — un agent corporate, un proxy pin de changement de compte — le dernier écrivain gagne et chaque autre CA est silencieusement non approuvée. Mesuré le 2026-07-30 : deux composants de ce type sur une machine ont tour à tour cassé le TLS de l'autre.

Donc `--remote-control` n'assigne pas simplement la variable. Il :

1. **Publie** notre CA dans `<config>/ca-trust.d/ccf.pem` — uniquement notre propre nom de fichier, jamais celui d'un sibling, réécrit à chaque lancement.
2. **Lit** `<config>/ca-trust.pem` — un bundle fusionné construit par exactement un écrivain externe à partir des racines ambiantes/corporate plus chaque `ca-trust.d/*.pem` publié — et pointe `NODE_EXTRA_CA_CERTS` dessus.

`<config>` est `CLAUDE_CONFIG_DIR` ou `~/.claude`. **Nous n'écrivons jamais le bundle fusionné** : fusionner nécessite de trouver les racines corporate ambiantes, ce qui est spécifique à l'environnement.

**Il s'agit d'une convention coopérative entre processus du même utilisateur, pas d'une frontière de confiance.** La vérification prouve *parse, et porte nous* — jamais *ne contient que des écrivains approuvés*.

#### `CACHE_FIX_DOWNLOAD_REWRITE` casse `claude update` — laissez-le désactivé

`CACHE_FIX_DOWNLOAD_REWRITE=on` semble être un simple bouton de performance. Ce n'en est pas un : l'activer **désactive entièrement `claude update`** sur cet hôte. Réécrire une URL de téléchargement signifie la lire, ce qui signifie MITM `downloads.claude.ai` — et le client du canal release épingle **uniquement les racines publiques** et rejette toute CA privée, donc la vérification de version meurt avant qu'un octet ne soit téléchargé :

```
Failed to fetch version from .../claude-code-releases/latest after 3 attempt(s):
  unable to verify the first certificate
```

Mesuré avec `openssl s_client -proxy 127.0.0.1:9901 -connect downloads.claude.ai:443 -servername downloads.claude.ai` :

| `CACHE_FIX_DOWNLOAD_REWRITE` | leaf CN | verify |
|---|---|---|
| `on` | `api.anthropic.com` | code 21 |
| `off` | `downloads.claude.ai` (WR3 / GTS Root R1) | code 0 |

- **Il ne peut pas être restreint au seul téléchargement binaire.** Le MITM est décidé par hôte au moment du `CONNECT`, et la vérification de version partage `downloads.claude.ai` avec le téléchargement lui-même.
- **Aucun override côté client n'atteint ce client.** `HTTPS_PROXY` / `ALL_PROXY`, `/etc/hosts`, `/etc/resolv.conf`, et `NODE_EXTRA_CA_CERTS` ont chacun été réfutés.

Les autres hôtes ne sont pas affectés : `github.com` à travers le même proxy retourne son vrai certificat et vérifie. Le flag est désactivé par défaut ; laissez-le ainsi.

### Ce que fait le proxy

À chaque requête `/v1/messages`, le pipeline exécute une chaîne ordonnée d'extensions couvrant la stabilité du cache, l'observabilité, l'atténuation thinking-desync, image, microcompact, breakpoint, canal bootstrap, et d'autres surfaces.

| Extension | Ce qu'elle corrige |
|-----------|--------------|
| `fingerprint-strip` | Supprime l'empreinte cc_version instable du prompt système |
| `sort-stabilization` | Ordre déterministe des définitions d'outils et MCP |
| `ttl-management` | Détecte le niveau TTL serveur, injecte les marqueurs cache_control corrects |
| `identity-normalization` | Normalise les champs d'identité des messages pour la stabilité du préfixe |
| `fresh-session-sort` | Corrige l'ordre non déterministe au premier tour |
| `cache-control-normalize` | Normalise les marqueurs cache_control entre messages |
| `cache-telemetry` | Extrait les stats de cache des en-têtes de réponse → `~/.claude/quota-status/{account.json,sessions/<id>.json}` |
| `session-health` | Observe le risque thinking-desync par session et avertit avant la zone de danger. Lecture seule |
| `thinking-block-sanitize` | Supprime les blocs thinking omis (texte vide) pour éviter le `400` thinking-desync (#63147). **Activé par défaut depuis v4.0.0** |
| `workflow-agent-id-synthesis` | Dérive un id d'agent stable par leg pour les sous-agents Workflow |
| `session-budget-breaker` | Plafond de dépenses dur par session opt-in — voir ci-dessous |

Les extensions vivent en fichiers `.mjs` dans `proxy/extensions/` avec config dans `proxy/extensions.json`. Depuis v4.0.0 le proxy les charge une fois au démarrage.

### Exécution en tant que service

**Recommandé (Linux/macOS) — sous-commande `install-service` :**

```bash
cache-fix-proxy install-service
```

Détecte votre plateforme et écrit la configuration appropriée :

- **Linux** → `~/.config/systemd/user/cache-fix-proxy.service` (unité utilisateur systemd)
- **macOS** → `~/Library/LaunchAgents/com.cnighswonger.cache-fix-proxy.plist` (agent launchd)

Sur Linux :

```bash
systemctl --user daemon-reload
systemctl --user enable --now cache-fix-proxy
systemctl --user enable --now cache-fix-proxy-healthcheck.timer   # auto-recovery — see below
sudo loginctl enable-linger $USER   # optional: start on boot, not just on login
```

Sur macOS :

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.cnighswonger.cache-fix-proxy.plist
launchctl enable gui/$(id -u)/com.cnighswonger.cache-fix-proxy
launchctl kickstart gui/$(id -u)/com.cnighswonger.cache-fix-proxy
```

**Manuel (toute plateforme) :**

```bash
nohup cache-fix-proxy server > /tmp/cache-fix-proxy.log 2>&1 &
echo 'export ANTHROPIC_BASE_URL=http://127.0.0.1:9801' >> ~/.bashrc
```

### Docker

Une image conteneur multi-arch (amd64, arm64) est publiée sur GitHub Container Registry à chaque tag de version.

```bash
docker run -d --name cache-fix-proxy \
  --restart=always \
  -p 9801:9801 \
  ghcr.io/cnighswonger/claude-code-cache-fix:latest

# Puis dans votre shell :
export ANTHROPIC_BASE_URL=http://127.0.0.1:9801
```

Utilisez `--restart=always` au lieu du compagnon de vérification de santé systemd — Docker gère l'auto-récupération nativement.

Pour les environnements d'entreprise derrière un proxy inspectant SSL, montez votre bundle CA :

```bash
docker run -d --name cache-fix-proxy --restart=always -p 9801:9801 \
  -e HTTPS_PROXY=http://proxy.corp.example:8080 \
  -e CACHE_FIX_PROXY_CA_FILE=/etc/ssl/corp-ca.pem \
  -v /path/to/zscaler-root.pem:/etc/ssl/corp-ca.pem:ro \
  ghcr.io/cnighswonger/claude-code-cache-fix:latest
```

Tags d'image : `latest`, `4`, `4.0`, `4.0.0`.

**Note Linux :** l'exemple `host.docker.internal` chaîné ci-dessous est automatique sur Docker Desktop (macOS/Windows). Sur Docker Engine Linux nu vous avez généralement besoin de `--add-host=host.docker.internal:host-gateway` :

```bash
docker run -d --name cache-fix-proxy --restart=always -p 9801:9801 \
  --add-host=host.docker.internal:host-gateway \
  -e CACHE_FIX_PROXY_UPSTREAM=http://host.docker.internal:8080 \
  ghcr.io/cnighswonger/claude-code-cache-fix:latest
```

**Mode forward proxy dans Docker** (garde Remote Control). Ajoutez `-e CACHE_FIX_FORWARD_PROXY=on` et pointez `CACHE_FIX_CA_DIR` vers un chemin inscriptible :

```bash
mkdir -p ./cache-fix-ca && sudo chown 1000:1000 ./cache-fix-ca
docker run -d --name cache-fix-proxy --restart=always -p 9801:9801 \
  -e CACHE_FIX_FORWARD_PROXY=on \
  -e CACHE_FIX_CA_DIR=/ca -v "$PWD/cache-fix-ca:/ca" \
  ghcr.io/cnighswonger/claude-code-cache-fix:latest

# La CA est maintenant à ./cache-fix-ca/ca.pem sur l'hôte. Pointez le client vers le
# proxy (laissez ANTHROPIC_BASE_URL non défini pour garder Remote Control actif) :
HTTPS_PROXY=http://127.0.0.1:9801 NODE_EXTRA_CA_CERTS=$PWD/cache-fix-ca/ca.pem claude
```

### Vérification de santé

```bash
curl http://127.0.0.1:9801/health
# {"status":"ok"}
```

### Configuration du proxy

Tous les paramètres du proxy sont contrôlés via des variables d'environnement.

| Variable | Défaut | Description |
|----------|--------|-------------|
| `CACHE_FIX_PROXY_PORT` | `9801` | Port d'écoute |
| `CACHE_FIX_PROXY_BIND` | `127.0.0.1` | Adresse de liaison |
| `CACHE_FIX_PROXY_UPSTREAM` | `https://api.anthropic.com` | URL amont |
| `CACHE_FIX_FORWARD_PROXY` | non défini | Mettre à `on` pour le mode forward proxy |
| `CACHE_FIX_CA_DIR` | `~/.claude/cache-fix-ca` | Répertoire pour la CA |
| `CACHE_FIX_PROXY_TIMEOUT` | `600000` | Délai d'expiration en ms |
| `CACHE_FIX_EXTENSIONS_DIR` | `proxy/extensions/` | Répertoire des extensions `.mjs` |
| `CACHE_FIX_EXTENSIONS_CONFIG` | `proxy/extensions.json` | Fichier de config des extensions |
| `CACHE_FIX_DEBUG` | `0` | Activer le log de débogage |
| `CACHE_FIX_GATEWAY_ERROR_LOG` | `on` | Journalise une ligne stderr `[cache-fix] upstream error -> 502: ...` (erreur, méthode, route ; identifiants de session masqués) chaque fois que le proxy renvoie un 502 au client suite à un échec de connexion en amont. Mettre à `off` pour désactiver. |
| `CACHE_FIX_HOT_RELOAD` | non défini | Mettre à `on` pour le hot-reload in-process |

### Environnements d'entreprise (proxys, CA personnalisées)

Le proxy respecte les variables suivantes lors du forwarding vers `api.anthropic.com`.

| Variable | Effet |
|----------|--------|
| `HTTPS_PROXY` / `HTTP_PROXY` | Route les requêtes amont via le proxy HTTP CONNECT corporate |
| `NO_PROXY` | Liste d'hôtes à contourner |
| `CACHE_FIX_PROXY_CA_FILE` | Chemin vers un PEM avec CA supplémentaires |
| `NODE_EXTRA_CA_CERTS` | Mécanisme Node standard — aussi respecté |
| `CACHE_FIX_PROXY_REJECT_UNAUTHORIZED=0` | **Échappatoire non sécurisée.** Désactive la vérification TLS |

Exemple (Windows PowerShell) :

```powershell
$env:HTTPS_PROXY = 'http://proxy.corp.example:8080'
$env:NO_PROXY    = 'localhost,127.0.0.1,.corp.example'
$env:CACHE_FIX_PROXY_CA_FILE = 'C:\corp\zscaler-root.pem'
node "$(npm root -g)\claude-code-cache-fix\proxy\server.mjs"
```

### Intégration du proxy dans votre propre processus

Si vous livrez un binaire Node ou Bun qui veut le proxy cache-fix in-process, importez la factory depuis `claude-code-cache-fix/proxy/server` :

```js
import { startProxy } from "claude-code-cache-fix/proxy/server";

const handle = await startProxy({
  port: 0,        // port éphémère assigné par l'OS ; passez un nombre pour l'épingler
  bind: "127.0.0.1",
  watch: false,   // saute fs.watch — recommandé pour binaires compilés
});

console.log(`proxy en écoute sur ${handle.address}:${handle.port}`);

// ...plus tard...
await handle.close();
```

**`createProxyServer()` → `http.Server`** construit le handler de requête câblé dans un `http.Server`. Le serveur retourné n'écoute pas et le pipeline d'extensions n'a pas été chargé.

**`startProxy(options?)` → `Promise<{ server, port, address, close }>`** charge le pipeline d'extensions, démarre optionnellement le watcher, et commence à écouter.

*La factory embarquable a été contribuée par [@bilby91](https://github.com/bilby91) chez [Crunchloop DAP](https://dap.crunchloop.ai) — voir [PR #123](https://github.com/cnighswonger/claude-code-cache-fix/pull/123).*

## Mise à niveau depuis v3.x

**Changements de comportement en v4.0.0 :**

- **`thinking-block-sanitize` v1 est maintenant activé par défaut.** Était opt-in via `CACHE_FIX_THINKING_SANITIZE=on` en v3.8.0–v3.9.x. Après sept jours de prod dogfood sur 37 sessions (zéro `cannot be modified` 400s, hit-rate agrégé 94,66% vs 92,44% baseline), la v1 est le nouveau défaut.
- **Le hot-reload d'extensions in-process est maintenant désactivé par défaut.** Était activé en v3.x. Mettez `CACHE_FIX_HOT_RELOAD=on` pour restaurer le comportement précédent.

### Note pour les intégrateurs (hôtes Bun, intégrations DAP utilisant `createProxyServer()` / `startProxy()`)

v4.0.0 bascule `CACHE_FIX_THINKING_SANITIZE` de default-off à default-on. La v1 droppera chaque body de requête passant par le proxy embarqué. Si votre hôte dépend du comportement sans sanitization, préservez-le en mettant `CACHE_FIX_THINKING_SANITIZE=off`.

### Flux 1 — mise à jour npm code seul (recommandé par défaut)

Votre unité systemd existante / plist launchd est inchangée ; seul le code proxy sur disque est mis à jour par npm. Redémarrez le processus en cours pour prendre le nouveau code.

**Linux (systemd user unit) :**

```bash
npm install -g claude-code-cache-fix@4
systemctl --user restart cache-fix-proxy
```

**macOS (launchd user agent) :**

```bash
npm install -g claude-code-cache-fix@4
launchctl kickstart gui/$(id -u)/com.cnighswonger.cache-fix-proxy
```

### Flux 2 — réactivation du hot-reload au niveau superviseur

**Linux :**

```bash
CACHE_FIX_HOT_RELOAD=on cache-fix-proxy install-service
systemctl --user daemon-reload
systemctl --user restart cache-fix-proxy
```

**macOS :**

```bash
CACHE_FIX_HOT_RELOAD=on cache-fix-proxy install-service
launchctl bootout gui/$(id -u)/com.cnighswonger.cache-fix-proxy
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.cnighswonger.cache-fix-proxy.plist
launchctl kickstart gui/$(id -u)/com.cnighswonger.cache-fix-proxy
```

## Ce que ce proxy défend contre

**Régressions économiques du cache.** Le but original de cache-fix est d'absorber les comportements de gestion du cache dans Claude Code qui coûtent de l'argent réel et du quota — rétrogradations TTL, churn d'en-têtes cassant le cache, problèmes de verrouillage d'identité, et le reste du catalogue documenté dans l'historique d'issues.

**Observabilité du canal bootstrap.** Claude Code v2.1.150 a introduit un consommateur de section prompt qui récupère une chaîne fournie serveur depuis `/api/claude_cli/bootstrap` et la fusionne dans le chemin prompt d'instructions comportementales de l'agent. Nous avons signalé ce comportement à l'équipe sécurité d'Anthropic en mai 2026 ; Anthropic a clos le rapport comme *Informatif*. Cache-fix a livré une gestion explicite pour ce chemin en v3.7.0 et l'a étendue en v3.7.1.

L'extension `bootstrap-defense` de cache-fix ship trois modes, sélectionnés via `CACHE_FIX_BOOTSTRAP_MODE` :

| Mode | Défaut ? | Comportement |
|---|---|---|
| `audit` | oui | Les réponses bootstrap passent vers CC. Chaque réponse est logguée dans `~/.claude/cache-fix-bootstrap-log.jsonl` |
| `block` | opt-in | `onRequest` retourne 200 avec body JSON vide. Upstream jamais appelé |
| `allowlist` | opt-in (expérimental) | La réponse bootstrap passe, mais les clés éligibles prompt-source non dans allowlist sont strippées |

## Hooks côté client

Certains comportements de Claude Code vivent sous la couche requête — ils se produisent côté client, dans le chemin dispatch des outils, avant que le proxy ne voie le trafic. cache-fix livre des scripts de hooks autonomes sous [`hooks/examples/`](hooks/README.md).

| Script | Ce qu'il fait |
|---|---|
| [`worktree-edit-guard.py`](docs/hooks/worktree-edit-guard.md) | Bloque les appels d'outils `Edit`/`Write`/`MultiEdit`/`NotebookEdit` dont le chemin cible sort du worktree git actif |

## Outils contribués

Scripts autonomes qui ne sont pas des extensions proxy ni des hooks CC — installables séparément.

| Outil | Ce qu'il fait |
|---|---|
| [`tools/gh-auth-status-shim/`](tools/gh-auth-status-shim/README.md) | Wrapper `gh` PATH-résolu qui supprime le faux toast "GitHub CLI authentication expired" de CC Desktop |

## Configuration opérationnelle CC recommandée

Le proxy corrige ce qu'il peut au niveau requête. Quelques vars d'environnement côté client CC et knobs `~/.claude/settings.json` résolvent des problèmes adjacents que le proxy ne peut pas atteindre.

### Bloc env suggéré pour `~/.claude/settings.json`

```json
{
  "env": {
    "CLAUDE_CODE_DISABLE_LEGACY_MODEL_REMAP": "1",
    "ANTHROPIC_MODEL": "claude-opus-4-7",
    "ANTHROPIC_SMALL_FAST_MODEL": "claude-haiku-4-5-20251001"
  }
}
```

**`CLAUDE_CODE_DISABLE_LEGACY_MODEL_REMAP=1`** — flag le plus impactant. CC a un chemin legacy qui remap silencieusement votre modèle épinglé vers un autre après certaines mises à jour. Mettre à `1` désactive le remap.

**`ANTHROPIC_MODEL`** — épingle le modèle principal.

**`ANTHROPIC_SMALL_FAST_MODEL`** — épingle le modèle "rapide" secondaire.

### Avertissement `autoCompactWindow=1000000`

Ce réglage ne prend effet que lorsque le modèle actif qualifie pour contexte 1M. Sans ces prérequis il plafonne à 200K codé en dur.

### Effet secondaire de suppression de schéma `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1`

Si vous définissez ce flag, CC strippe tout champ d'outil hors de `["name", "description", "input_schema", "cache_control"]` des requêtes sortantes. Les outils custom s'appuyant sur `defer_loading` ou `eager_input_streaming` perdront silencieusement ces champs.

## Comportements CC connus qui affectent les coûts du cache

### Les commandes slash de diagnostic gonflent l'historique de conversation ([#49335](https://github.com/anthropics/claude-code/issues/49335))

Exécuter `/context`, `/release-notes` ajoute la sortie diagnostic à l'historique de conversation plutôt que de rendre terminal-only. Les tours suivants rejouent le payload gonflé via prompt cache, composant le coût token. Mesuré empiriquement à +3 480 `cache_creation_input_tokens` pour une seule invocation `/context` sur v2.1.148.

## Démarrage rapide : Préchargement (CC v2.1.112 et antérieur)

Si vous êtes sur une version CC basée Node.js (v2.1.112 ou antérieure), l'intercepteur preload fonctionne sans proxy :

```bash
npm install -g claude-code-cache-fix
NODE_OPTIONS="--import claude-code-cache-fix" claude
```

Voir [docs/preload-setup.md](docs/preload-setup.md) pour les scripts wrapper, alias shell, instructions Windows et intégration VS Code mode preload.

## Extension VS Code

L'[extension VS Code](https://github.com/cnighswonger/claude-code-cache-fix-vscode) (v0.5.0) supporte les deux modes proxy et preload :

**Mode proxy (recommandé) :**
1. Démarrez le proxy (voir ci-dessus)
2. Dans la palette de commandes VS Code : **Claude Code Cache Fix: Enable Proxy Mode**
3. Redémarrez toute session Claude Code active

## Modèle de sécurité

> **Le proxy et l'intercepteur ont un accès complet en lecture/écriture aux requêtes et réponses API.** Ceci est inhérent à l'approche.

**Ce qu'il fait :** Modifie la structure des requêtes sortantes (ordre des blocs, empreinte, TTL, git-status) pour corriger les bogues de cache. Lit les en-têtes de réponse et données d'utilisation SSE pour la surveillance.

**Ce qu'il ne fait PAS :** Aucun appel réseau depuis le proxy ou intercepteur. Toute télémétrie est écrite dans des fichiers locaux sous `~/.claude/`. Aucune donnée ne quitte votre machine.

**Audit indépendant :** [Évalué comme "OUTIL LÉGITIME"](https://github.com/anthropics/claude-code/issues/38335#issuecomment-4244413605) par @TheAuditorTool (2026-04-14).

## Le problème

Quand vous utilisez `--resume` ou `/resume` dans Claude Code, le prompt cache casse silencieusement. Au lieu de lire les tokens mis en cache (pas cher), l'API les reconstruit depuis zéro à chaque tour (cher). Une session qui devrait coûter ~$0.50/heure peut brûler $5–10/heure sans indication visible.

Trois bogues causent ceci :

1. **Dispersion partielle des blocs** — Les blocs d'attachement sont censés vivre dans `messages[0]`. À la reprise, certains ou tous dérivent vers des messages ultérieurs, changeant le préfixe de cache.
2. **Instabilité d'empreinte** — L'empreinte `cc_version` est calculée à partir du contenu `messages[0]`. Quand ces blocs bougent, l'empreinte change.
3. **Ordre non déterministe des outils** — Les définitions d'outils peuvent arriver dans des ordres différents entre tours.

## Comment ça fonctionne

**Mode proxy** (v3.0.0+) : Un serveur HTTP sur `localhost:9801` intercepte les requêtes `POST /v1/messages`. Un pipeline de modules d'extension traite chaque requête.

**Mode preload** (v2.x) : Un module Node.js `--import` qui patch `globalThis.fetch` avant que Claude Code ne fasse des appels API.

Les deux modes sont idempotents.

## Sortir des corrections

Le paquet sert trois objectifs avec des cycles de vie différents :

| Objectif | Exemples | Quand désactiver |
|---------|----------|-----------------|
| **Corrections de bogues** | Relocalisation de blocs, empreinte, tri d'outils, TTL | Quand CC corrige le bogue sous-jacent |
| **Surveillance** | Suivi quota, détection microcompact, flags GrowthBook | Garder indéfiniment |
| **Optimisations** | Stripping d'images, réécriture d'efficacité de sortie | Tant qu'elles aident votre flux |

### État de santé (mode préchargement)

Au premier appel API, l'intercepteur journalise une ligne d'état de santé (nécessite `CACHE_FIX_DEBUG=1`) :

```
cache-fix health: relocate=active(2h ago) fingerprint=dormant(5 clean sessions) tool_sort=active ttl=active identity=waiting
```

### Détection de régression

Si le ratio cache_read tombe sous 50% sur 5+ appels après désactivation des corrections :

```
REGRESSION WARNING: cache_read ratio averaged 12% across last 5 calls.
Fixes are disabled — consider re-enabling to recover cache performance.
```

## Sécurité

### Vérification aller-retour de l'empreinte

Avant de réécrire l'empreinte `cc_version`, l'intercepteur vérifie que son sel codé en dur et ses indices de caractères reproduisent l'empreinte envoyée par Claude Code. Si la vérification échoue, la réécriture est automatiquement ignorée.

### Conception à sécurité intégrée

Chaque correction est conçue pour échouer vers une non-action :
- Si les regex de détection des blocs ne correspondent pas → les blocs ne sont pas relocalisés
- Si le format de l'empreinte change → l'empreinte n'est pas réécrite
- Si le tri des outils ne produit aucun changement → la charge passe non modifiée

## Ligne de statut — avertissements de quota en temps réel

Les deux modes écrivent l'état du quota à chaque appel API. Le mode proxy (v3.5.0+) se divise en `~/.claude/quota-status/account.json` plus `~/.claude/quota-status/sessions/<id>.json`. Le script `tools/quota-statusline.sh` inclus affiche une ligne de statut en direct montrant :

- **Q5h** barre de quota `[███░┃░░░░░]` + pourcentage + `(exhaust X, reset Y)`
- **Q7d** même forme avec durées à l'échelle du jour
- **Niveau TTL** — `TTL:1h` quand sain, **`TTL:5m` en rouge quand le serveur vous a rétrogradé**
- **PEAK** en jaune pendant les heures de pointe semaine

Exemple de ligne (milieu de fenêtre, état sain) :

```
Q5h [███░┃░░░░░] 30% (exhaust 4h40m, reset 3h00m) | Q7d [█████┃░░░░] 53% (exhaust 3d13h, reset 3d0h) | TTL:1h 98.3%
```

### Installation

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

### Pourquoi la ligne de statut est importante

Quand le serveur rétrograde votre TTL à 5m (rétrogradation quota-aware à Q5h ≥ 100%), **chaque idle plus long que 5 minutes cause une reconstruction complète du contexte**. Sans la ligne de statut, ceci est invisible. Avec, l'avertissement rouge `TTL:5m` vous dit : **arrêtez de travailler, attendez que la fenêtre Q5h se réinitialise, puis reprenez**.

### Recommandé : désactiver l'injection git-status

Claude Code injecte le `git status` live dans le prompt système à chaque appel. Toute édition de fichier change le git status, ce qui bust tout le cache préfixe. Désactiver ceci économise ~1 800 tokens par appel :

```bash
export CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS=1
```

## Migration : v3.4.x → v3.5.0+

Si vous avez écrit une statusline custom, script de monitoring, ou autre chose qui lit `~/.claude/quota-status.json` directement, cette section est pour vous. v3.5.0 a divisé ce fichier en mode proxy ; mode preload inchangé.

### Qu'est-ce qui a changé

| | v3.4.x et antérieur | v3.5.0+ mode proxy | v3.5.0+ mode preload |
|---|---|---|---|
| Champs quota | `~/.claude/quota-status.json` | `~/.claude/quota-status/account.json` | `~/.claude/quota-status.json` |
| Champs cache | même fichier | `~/.claude/quota-status/sessions/<filename>.json` | même fichier |
| Attribution multi-session | aucune — dernier écrivain gagne | fichiers par session | mono-session |

`<filename>` est dérivé de l'en-tête `x-claude-code-session-id` via règle safe-name déterministe.

Le `~/.claude/quota-status.json` legacy est auto-supprimé à la première écriture mode proxy après mise à niveau.

### Modèle de migration côté consommateur

Votre script doit essayer les chemins v3.5.0+ proxy d'abord et retomber sur le chemin legacy si non présent.

**Bash (style statusline) :**

```bash
QS_DIR="$HOME/.claude/quota-status"
ACCOUNT="$QS_DIR/account.json"
LEGACY="$HOME/.claude/quota-status.json"

# Règle de nom de fichier canonique — doit refléter proxy/extensions/cache-telemetry.mjs
# sessionFilename() : trim, puis "" → unknown, passe-plat regex sûr, sinon
# inv-<sha256-prefix>. Sans ceci, les ids malformés ou avec whitespace ratent
# le fichier per-session même si l'écrivain l'a créé sous le nom canonique.
session_filename() {
  local trimmed
  trimmed="$(printf '%s' "$1" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
  if [ -z "$trimmed" ]; then echo unknown; return; fi
  if printf '%s' "$trimmed" | grep -qE '^[A-Za-z0-9_-]{1,128}$'; then
    printf '%s' "$trimmed"
  else
    # sha256sum sur Linux ; shasum -a 256 sur macOS. Les deux émettent "<hex>  -".
    local hash
    if command -v sha256sum >/dev/null 2>&1; then
      hash="$(printf '%s' "$trimmed" | sha256sum)"
    else
      hash="$(printf '%s' "$trimmed" | shasum -a 256)"
    fi
    printf 'inv-%s' "$(printf '%s' "$hash" | cut -c1-16)"
  fi
}

# session id : préfère stdin CC, retombe sur le jsonl le plus récent
sid="$(jq -r '.session_id // empty' 2>/dev/null < /dev/stdin || true)"
if [ -z "$sid" ]; then
  sid="$(ls -t "$HOME"/.claude/projects/*/*.jsonl 2>/dev/null | head -1 | xargs -I{} basename {} .jsonl)"
fi
filename="$(session_filename "$sid")"

# quota : account.json (v3.5.0+) → retombe sur legacy
if [ -f "$ACCOUNT" ]; then
  quota_json="$(cat "$ACCOUNT")"
elif [ -f "$LEGACY" ]; then
  quota_json="$(cat "$LEGACY")"
fi

# cache : sessions/<filename>.json (v3.5.0+) → retombe sur legacy
if [ -f "$QS_DIR/sessions/$filename.json" ]; then
  cache_json="$(cat "$QS_DIR/sessions/$filename.json")"
elif [ -f "$LEGACY" ]; then
  cache_json="$(cat "$LEGACY")"
fi
```

**Node :**

```js
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const home = homedir();
const accountPath = join(home, ".claude", "quota-status", "account.json");
const legacyPath = join(home, ".claude", "quota-status.json");

const SAFE_NAME_RE = /^[A-Za-z0-9_-]{1,128}$/;

// Miroir de sessionFilename() de cache-telemetry.mjs. La règle côté lecteur doit
// correspondre à la règle côté écrivain ; sinon les ids malformés/avec whitespace
// ratent leur fichier per-session.
function sessionFilename(rawId) {
  if (rawId === null || rawId === undefined) return "unknown";
  const s = String(rawId).trim();
  if (s.length === 0) return "unknown";
  if (SAFE_NAME_RE.test(s)) return s;
  return "inv-" + createHash("sha256").update(s).digest("hex").slice(0, 16);
}

function readQuotaJson() {
  if (existsSync(accountPath)) return JSON.parse(readFileSync(accountPath, "utf8"));
  if (existsSync(legacyPath)) return JSON.parse(readFileSync(legacyPath, "utf8"));
  return null;
}

function readCacheJson(sessionId) {
  const filename = sessionFilename(sessionId);
  const p = join(home, ".claude", "quota-status", "sessions", `${filename}.json`);
  if (existsSync(p)) return JSON.parse(readFileSync(p, "utf8"));
  if (existsSync(legacyPath)) return JSON.parse(readFileSync(legacyPath, "utf8"));
  return null;
}
```

### Pourquoi par session

Sur les hôtes multi-agent, le fichier global unique pré-v3.5.0 faisait que chaque session écrasait les stats cache des autres à chaque réponse.

### `CLAUDE_CONFIG_DIR`

Claude Code lit `CLAUDE_CONFIG_DIR` pour relocaliser sa racine config loin du défaut `~/.claude`. Le proxy honore maintenant la même variable pour **tout** son état on-disk.

## Suppression d'images (mode préchargement)

Les images lues via l'outil Read persistent en base64 dans l'historique de conversation. Une seule image 500 Ko coûte ~62 500 tokens par tour sur Opus 4.6, et **~85 000+ sur Opus 4.7**.

```bash
export CACHE_FIX_IMAGE_KEEP_LAST=3
```

### Garde d'images surdimensionnées (legacy, v3.2.1)

```bash
export CACHE_FIX_IMAGE_MAX_DIM=2000
```

| Pression | Variable | Ce qu'elle fait |
|---|---|---|
| **Trop d'images en conversation** | `CACHE_FIX_IMAGE_KEEP_LAST=N` | Strippe les images des vieux messages utilisateur |
| **Une seule image trop grande** | `CACHE_FIX_IMAGE_MAX_DIM=2000` | Remplace les images dépassant la limite par placeholder |

### Pipeline de garde d'images (v3.3.0)

Pipeline conditionnel qui reflète les vraies règles d'Anthropic. Strictement opt-in via une seule env var :

```bash
export CACHE_FIX_IMAGE_GUARD=1
```

| Pass | Déclencheur | Action |
|------|---------|--------|
| **Pass 0** (legacy) | `CACHE_FIX_IMAGE_KEEP_LAST=N` défini | Strippe les images tool_result des messages utilisateur plus vieux que N |
| **Pass 3** | `CACHE_FIX_IMAGE_PRESERVE_DETAIL=1` ET long edge image > cap natif | Resize Lanczos via `sharp` |
| **Pass 1** | long edge image > cap de rejet actif | Strippe et remplace |
| **Pass 2** | body requête dépasse `CACHE_FIX_IMAGE_REQUEST_SIZE_MAX` | Droppe les plus vieilles |
| **Count cap** | count images survivantes > cap | Droppe les plus vieilles |

#### Dépendance optionnelle `sharp`

Le Pass 3 nécessite [sharp](https://www.npmjs.com/package/sharp) pour resize Lanczos.

```bash
npm install sharp
```

#### Matrice de précédence

| Combinaison Env var | Comportement |
|---|---|
| Rien défini | Pas de traitement image |
| `KEEP_LAST=N` seul | Comportement v3.2.1 count cap |
| `MAX_DIM=N` seul | Comportement v3.2.1 hard size cap |
| `KEEP_LAST=N` + `MAX_DIM=N` | Composition v3.2.1 |
| `IMAGE_GUARD=1` | Nouveau pipeline |
| `IMAGE_GUARD=1` + `MAX_DIM=N` | `MAX_DIM` override Pass 1 |
| `IMAGE_GUARD=1` + `PRESERVE_DETAIL=1` | Ajoute Pass 3 |
| `IMAGE_GUARD=1` + `KEEP_LAST=N` | `KEEP_LAST` d'abord |
| `PRESERVE_DETAIL=1` sans `IMAGE_GUARD=1` | Log warning, no-op |

#### Paramètres réglables

| Env var | Défaut | But |
|---------|---------|---------|
| `CACHE_FIX_IMAGE_GUARD` | non défini | Gate pipeline top-level |
| `CACHE_FIX_IMAGE_PRESERVE_DETAIL` | non défini | Active Pass 3 resize |
| `CACHE_FIX_IMAGE_REQUEST_SIZE_MAX` | 31457280 (30 MB) | Budget octets Pass 2 |
| `CACHE_FIX_IMAGE_COUNT_MAX` | 100 | Cap dur count images |

## Disjoncteur de nouvelles tentatives d'images (mode proxy, opt-in)

Quand CC rencontre une erreur permanente "image could not be processed", le harness la traite actuellement comme transitoire et retente — avec contexte conversation complet et même payload image 34 Mo — jusqu'à ~19 fois par [anthropics/claude-code#66815](https://github.com/anthropics/claude-code/issues/66815). Une seule mauvaise image peut consommer ~60% de l'enveloppe quota 5-heure.

Le disjoncteur surveille chaque réponse route messages. Quand upstream retourne une erreur permanente de traitement d'image, il enregistre la failure.

Opt-in via env var ; default-off :

```bash
export CACHE_FIX_IMAGE_RETRY_BREAKER=on
```

| Mode | Comportement |
|------|----------|
| `on` | Détecte + enregistre + court-circuite |
| `off` (défaut) | Pass-through |
| `dry-run` | Détecte + enregistre + log, mais ne court-circuite pas |

## Disjoncteur de budget de session (mode proxy, opt-in)

Un **plafond de dépenses dur par session** opt-in. Une fois que la consommation token cumulative d'une session CC dépasse une limite que vous définissez, les futurs `/v1/messages` pour cette session sont court-circuités localement — ils n'atteignent jamais Anthropic.

Opt-in via la gate ; **default-off** :

```bash
export CACHE_FIX_SESSION_BUDGET=on
export CACHE_FIX_SESSION_BUDGET_COST_USD=25      # p.ex. stop la session à ~$25
```

| Mode | Comportement |
|------|----------|
| `on` | Tally par session ; court-circuite la prochaine requête une fois au-dessus d'un plafond |
| `off` (défaut) | Pass-through |
| `dry-run` | Tally + log `would_block` |

### Les trois leviers de blocage (définissez au moins un)

| Env var | Défaut | But |
|---------|---------|---------|
| `CACHE_FIX_SESSION_BUDGET` | `off` | Gate — `on` / `off` / `dry-run` |
| `CACHE_FIX_SESSION_BUDGET_TOKENS` | non défini | Stop dur quand tokens cumulatifs traversent cet entier |
| `CACHE_FIX_SESSION_BUDGET_COST_USD` | non défini | Stop dur quand coût estimé traverse ce float |
| `CACHE_FIX_SESSION_BUDGET_RATE_TPM` | non défini | Stop dur quand tokens/min traversent cet entier |
| `CACHE_FIX_SESSION_BUDGET_RATE_WINDOW_MS` | 60000 | Fenêtre glissante pour levier rate |
| `CACHE_FIX_SESSION_BUDGET_MAX_ENTRIES` | 4096 | Cap LRU |
| `CACHE_FIX_SESSION_BUDGET_EVENT_LOG` | `~/.claude/session-budget-events.jsonl` | Chemin log |

### Quel levier pour quel modèle de facturation

- **Abonnement (OAuth, ex. Max) — cas #68285.** Utilisez `_TOKENS` ou `_RATE_TPM`.
- **Clé API directe (pay-as-you-go) — cas plus sévère.** Il n'y a pas de buffer quota. Ici `_COST_USD` est un **plafond dollar littéral**.

**Le coût est une estimation — pairez-le avec un cap token pour une borne dollar garantie.**

### Toujours en fail-open

Si la comptabilité est incertaine — gate off, pas de plafond défini, `usage` manquant, pas de clé session, modèle inconnu à `rates.json`, première requête après restart, ou quoi que ce soit throw — la requête **forward.**

### Surface d'observabilité (contournement du compteur)

Une requête court-circuitée retourne avant tout appel upstream, donc elle ne produit **aucune ligne `usage.jsonl`**. Le seul signal fire est le log JSONL.

### Limitations connues

- **Dépassement concurrence.** Un large fan-out tire quasi-simultanément, donc un plafond cumulatif pur dépasse d'environ ce batch. `_RATE_TPM` atténue.
- **Coût sortie est post-hoc** — le tally gate la *prochaine* requête.
- **Restart remet le tally à zéro** — in-memory.
- **Par session, pas par compte**.

## Normalisation `cc_version` (mode proxy, opt-in)

Certains canaux de distribution Claude Code — notamment l'extension VS Code sous auto-update — émettent une valeur `cc_version` dans le `x-anthropic-billing-header` qui inclut un hash per-build au-dessus de `MAJOR.MINOR.PATCH`.

L'existant `fingerprint-strip` ne couvre PAS ce cas.

Opt-in via env var ; default-off :

```bash
export CACHE_FIX_NORMALIZE_CC_VERSION=strip          # collapse X.Y.Z.<suffix> → X.Y.Z
# ou
export CACHE_FIX_NORMALIZE_CC_VERSION=pin:2.1.185    # littéral fourni par l'opérateur
```

## Sauvegarde de session (mode proxy, opt-in)

Un backup ceinture-et-bretelles contre les régressions transcript CC par [anthropics/claude-code#66734] et [anthropics/claude-code#66486]. Quand le proxy est dans le chemin, chaque message assistant + tool result observé / input utilisateur est miroiré dans un fichier JSONL par session sous contrôle utilisateur.

Opt-in via env var ; default-off :

```bash
export CACHE_FIX_SESSION_MIRROR=on
```

## Points d'arrêt de cache (mode proxy, opt-in)

Le prompt cache d'Anthropic supporte jusqu'à **quatre** marqueurs `cache_control` par requête. Claude Code utilise actuellement trois sur quatre ; le troisième (entre contenu auto-injecté `messages[0]` et le premier vrai contenu utilisateur) manque entièrement.

Le proxy peut injecter le marqueur manquant en opt-in.

```bash
export CACHE_FIX_INJECT_MESSAGES_BREAKPOINT=1
```

L'injection est conservatrice : elle ne tire que quand la requête porte déjà 1–3 marqueurs.

Une env var diagnostic-only dump la forme structurelle de `messages[0]` :

```bash
export CACHE_FIX_DUMP_MESSAGES_HEAD=/tmp/messages-head.jsonl
```

## Stabilité microcompact (mode proxy, opt-in)

Après ~90 minutes idle, le `time_based_microcompact` de Claude Code remplace l'ancien contenu `tool_result` par une chaîne sentinelle. Le contenu original est perdu ; cette partie est irrécupérable depuis le proxy. Mais la sentinelle elle-même peut porter un timestamp embarqué, ce qui signifie qu'un second passage microcompact écrit des octets différents.

Cette extension adresse la moitié récupérable : normaliser la sentinelle vers une forme canonique stable.

```bash
# Étape 1 (diagnostic) : dump les sentinelles détectées vers un JSONL pour observation.
export CACHE_FIX_DUMP_MICROCOMPACT=/tmp/microcompact-dump.jsonl

# Étape 2 (normalisation) : une fois le format de sentinelle confirmé, opt-in.
export CACHE_FIX_NORMALIZE_MICROCOMPACT=1
```

## Résumés du Thinking (mode proxy, optionnel, Opus 4.7+)

Sur Opus 4.7, Anthropic a inversé la valeur par défaut API pour `thinking.display` de `"summarized"` à `"omitted"`. Cette extension est le complément côté proxy : quand une requête vers un endpoint Opus 4.7 a thinking activé mais `display` non défini, injecte le mode configuré à la frontière API.

```bash
# Restaure les résumés (le défaut intégré — surfaces non-interactives obtiennent le contenu du raisonnement)
export CACHE_FIX_THINKING_DISPLAY=summarized

# Suppression forcée (runtimes d'agent qui ne veulent pas de blocs thinking du tout)
export CACHE_FIX_THINKING_DISPLAY=omitted

# No-op explicite (l'extension passe-through inchangée)
export CACHE_FIX_THINKING_DISPLAY=disabled
```

L'extension est **activée par défaut** depuis v3.6.1. Le test cache-prefix a mesuré 0% de baisse absolue du ratio `cache_read` en état stable quand l'injection est active sur Opus 4.7.

## Alerte précoce de santé de session (mode proxy, risque de désynchronisation Thinking)

Les sessions Opus 4.7 `[1m]` de longue durée accumulent des blocs thinking entrelacés et font croître leur contexte live jusqu'à ce que la reconstruction d'historique propre de Claude Code désynchronise une signature de bloc thinking, produisant un `400 … thinking blocks … cannot be modified` permanent à chaque tour suivant.

L'extension `session-health` observe les conditions qui corrèlent avec le trip et avertit **avant** qu'une session n'atteigne la zone de danger.

| Env var | Défaut | But |
|---------|---------|---------|
| `CACHE_FIX_THINKING_RISK_WARN_TOKENS` | `250000` | Niveau token contexte auquel risque devient `warn` |
| `CACHE_FIX_THINKING_RISK_HIGH_TOKENS` | `340000` | Niveau auquel risque devient `high` |
| `CACHE_FIX_THINKING_RISK` | non défini (on) | Mettre à `off` pour supprimer le signal warning |

## Nettoyage des blocs Thinking (mode proxy, activé par défaut, atténuation de la désynchronisation)

Sur les chemins rejeu d'historique (resume / `--continue` / auto-compaction / annulation outil parallèle), Claude Code renvoie les tours assistant antérieurs en forme **omise** `{ "type":"thinking", "thinking":"", "signature":"<intact>" }`. L'API rejette le thinking modifié dans le dernier message assistant avec un `400` permanent, ce qui coince la session à chaque tour suivant.

L'extension `thinking-block-sanitize` droppe ces blocs omis.

**Activé par défaut depuis v4.0.0.**

| Env var | Défaut | But |
|---------|---------|---------|
| `CACHE_FIX_THINKING_SANITIZE` | non défini (= v1) | v4.0.0+ : drop bloc omis v1 est le défaut. Mettre à `off` pour désactiver. Mettre à `v2` pour drop tools-hash-mismatch |

## Réécriture du prompt système (mode préchargement, optionnel)

L'intercepteur peut réécrire la section `# Output efficiency` du prompt système de Claude Code. Désactivé par défaut. Activez avec `CACHE_FIX_OUTPUT_EFFICIENCY_REPLACEMENT`.

## Surveillance et diagnostics

L'intercepteur de préchargement inclut la surveillance de la dégradation microcompact, des faux limiteurs de débit, de l'état des feature flags GrowthBook, de la télémétrie d'usage et des rapports de coûts.

### Extension `usage-log` et format fil `MeterRowSchema v:1`

L'extension `usage-log` (opt-in via `proxy/extensions.json`) ajoute une ligne JSON par réponse API à `~/.claude/usage.jsonl`. La forme de ligne est `MeterRowSchema v:1`.

| Champ | Type | Source |
|---|---|---|
| `v` | littéral `1` | constante |
| `ts` | datetime ISO-8601 | heure serveur |
| `sid` | hex 8-char | id session proxy |
| `model` | string ≤64 | `message_start.message.model` |
| `request_id` | string ≤64 (optionnel) | en-tête réponse upstream `request-id`. **Default-on depuis v4.2.0** |

**Pourquoi `request_id` compte opérationnellement.** Le champ `sid` est généré une fois au démarrage du proxy et partagé entre chaque session CC servie par ce proxy. Sur les hôtes qui font tourner plusieurs sessions CC concurrentes via un seul proxy, toutes les lignes s'effondrent sur le même `sid`. Les transcripts CC par session à `~/.claude/projects/<project>/<session-uuid>.jsonl` portent déjà `requestId` pour chaque appel API. Capturer la même valeur dans la ligne meter rend la jointure post-hoc triviale :

```bash
# Trouve à quelle session CC appartient chaque ligne usage.jsonl :
for row in $(jq -c . < ~/.claude/usage.jsonl); do
  req=$(jq -r '.request_id // empty' <<< "$row")
  [ -z "$req" ] && continue
  grep -l "\"requestId\":\"$req\"" ~/.claude/projects/*/*.jsonl
done
```

Le nom de fichier du transcript correspondant est l'UUID de la session CC, récupérant l'attribution par session pour chaque ligne meter émise avec le champ activé.

### Extension `upstream-error-log` (capture des réponses non-200)

L'extension `usage-log` ci-dessus n'enregistre que les réponses réussies (200). Les non-200 (429 throttling capacité, erreurs 5xx) ne laissent qu'une ligne non structurée.

`upstream-error-log` (opt-in, nouveau en v4.2.0) émet un record structuré pour chaque `status >= 400` vers `~/.claude/usage-log/upstream-errors.jsonl`.

Opt-in via env var ; default-off :

```bash
export CACHE_FIX_UPSTREAM_ERROR_LOG=on
```

### Rafraîchissement OAuth appartenant au proxy (opt-in)

Sous-système default-off qui fait du proxy cache-fix le seul, proactif, lock-coopératif, rafraîchisseur du credential OAuth à `~/.claude/.credentials.json`. Ferme la race rotation refresh-token qui peut révoquer toute la famille token et 401 chaque client Claude Code concurrent.

Opt-in via env var ; default-off :

```bash
export CACHE_FIX_OAUTH_REFRESH=on
```

| Env var | Défaut | But |
|---------|---------|---------|
| `CACHE_FIX_OAUTH_REFRESH` | `off` | Gate maître |
| `CACHE_FIX_OAUTH_CRED_PATH` | `~/.claude/.credentials.json` | Chemin fichier credential |
| `CACHE_FIX_OAUTH_TOKEN_URL` | `https://platform.claude.com/v1/oauth/token` | Endpoint token |
| `CACHE_FIX_OAUTH_REFRESH_MARGIN_MS` | 7200000 (2h) | Rafraîchit quand expiry est dans cette fenêtre |
| `CACHE_FIX_OAUTH_TICK_MS` | 300000 (5min) | Intervalle vérification |
| `CACHE_FIX_OAUTH_POST_TIMEOUT_MS` | 8000 | Deadline POST refresh hard |

## Limitations

### Quand NE PAS exécuter ceci

- **Vous opérez déjà une gateway ou proxy de cache dans le chemin de requête.**
- **Vous avez besoin de sémantique crash-to-supervisor.** En mode forward-proxy, le proxy installe des handlers `uncaughtException` / `unhandledRejection` process-wide.
- **Vos sessions sont courtes et froides.** La valeur du proxy se concentre sur les sessions reprises et longue durée.

### Après adoption

- **Le proxy nécessite un processus en cours d'exécution** — Le proxy doit être démarré avant Claude Code.
- **Rétrogradation TTL overage** — Dépasser 100% du quota 5-heure déclenche une rétrogradation TTL imposée serveur de 1h à 5m.
- **Microcompact n'est pas évitable** — Les fonctionnalités de surveillance détectent la dégradation contexte mais ne peuvent pas la prévenir.
- **La réécriture du prompt système est expérimentale** — Preload-only, opt-in.
- **Couplage de version** — Le sel d'empreinte et les heuristiques de détection de blocs sont dérivés des internals Claude Code.

## Recherches connexes

- **[@ArkNill/claude-code-hidden-problem-analysis](https://github.com/ArkNill/claude-code-hidden-problem-analysis)** — Analyse basée sur 38 996 requêtes via proxy : 7 bogues, test causal feature flag GrowthBook, advisory taux consommation Opus 4.7.
- **[@Renvect/X-Ray-Claude-Code-Interceptor](https://github.com/Renvect/X-Ray-Claude-Code-Interceptor)** — Proxy HTTPS de diagnostic avec tableau de bord temps réel.
- **[@fgrosswig/claude-usage-dashboard](https://github.com/fgrosswig/claude-usage-dashboard)** — Tableau de bord forensique auto-hébergé.

## Utilisé en production

- **[Crunchloop DAP](https://dap.crunchloop.ai)** — Environnement de développement Agent SDK / DAP. Première équipe de production à merger l'intercepteur sur trunk.
- **[VM Farms](https://vmfarms.com)** ([@vmfarms](https://github.com/vmfarms)) — Environnement développement agents exécutant workloads multi-runners concurrents.

## Contributeurs

- **[@VictorSun92](https://github.com/VictorSun92)** — Fix monkey-patch original pour v2.1.88
- **[@bilby91](https://github.com/bilby91)** ([Crunchloop DAP](https://dap.crunchloop.ai)) — Validation environnement production Agent SDK / DAP, factory proxy embarquable
- **[@jmarianski](https://github.com/jmarianski)** — Analyse cause racine via capture proxy MITM et rétro-ingénierie Ghidra
- **[@cnighswonger](https://github.com/cnighswonger)** — Stabilisation empreinte, correction tri outils, stripping images, fonctionnalités surveillance, architecture proxy, mainteneur paquet
- **[@ArkNill](https://github.com/ArkNill)** — Analyse mécanisme microcompact, documentation feature flags GrowthBook, README coréen
- **[@Renvect](https://github.com/Renvect)** — Découverte duplication images
- **[@fgrosswig](https://github.com/fgrosswig)** — Méthodologie tableau de bord usage Claude
- **[@TomTheMenace](https://github.com/TomTheMenace)** — Wrapper `.bat` Windows
- **[@deafsquad](https://github.com/deafsquad)** — Fix universel smoosh_split un-smoosh, architecture proxy
- **[@codeslake](https://github.com/codeslake)** — Mode forward proxy opt-in, respect de `CLAUDE_CONFIG_DIR`, rendez-vous `ca-trust.d`
- **[@Gunther-Schulz](https://github.com/Gunther-Schulz)** — Série attribution : `capture`, `prefix-diff`, `insertion-normalization`, `deferred-tool-rewrite`, `output-guard`
- **[@thepiper18](https://github.com/thepiper18)** — Traduction originale en portugais brésilien

Si vous avez contribué à l'effort communautaire sur ces problèmes et n'êtes pas listé ici, veuillez ouvrir une issue ou PR.

## Soutien

Si cet outil vous a fait économiser de l'argent, envisagez de m'offrir un café :

<a href="https://buymeacoffee.com/vsits" target="_blank"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me A Coffee" style="height: 60px !important;width: 217px !important;" ></a>

## Licence

[MIT](LICENSE)
