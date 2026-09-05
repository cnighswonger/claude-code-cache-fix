# claude-code-cache-fix

[![npm](https://img.shields.io/npm/v/claude-code-cache-fix?color=blue)](https://www.npmjs.com/package/claude-code-cache-fix) [![Node.js](https://img.shields.io/badge/Node.js-18%2B-green)](https://nodejs.org/) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow)](https://opensource.org/licenses/MIT) [![GitHub stars](https://img.shields.io/github/stars/cnighswonger/claude-code-cache-fix)](https://github.com/cnighswonger/claude-code-cache-fix/stargazers)

[English](./README.md) | [中文](./README.zh.md) | 한국어 | [Français](./README.fr.md) | [Português](./docs/guia-pt-br.md)

> **참고:** 본 번역은 기계 지원으로 작성되었으며 영문 README보다 뒤처질 수 있습니다. 권위 있는 내용은 [README.md](./README.md)를 참조하세요. 수정 사항은 언제든 환영합니다 — PR을 열어 주세요.
>
> **Note:** This translation is machine-assisted and may lag the English README. For anything authoritative, see [README.md](./README.md). Corrections are very welcome — please open a PR.

Claude Code용 캐시 최적화 프록시. 과도한 할당량 소모를 초래하는 프롬프트 캐시 버그를 수정하고 요청 접두사를 안정화하며 조용한 회귀를 모니터링합니다. v2.1.113 이상의 Bun 바이너리 포함 모든 CC 버전에서 작동합니다.

*이 README는 현재 `main`을 문서화합니다; 릴리스 가능 여부는 기능별로 표시됩니다.*

## 트래픽에 대한 작업 내용

Claude Code와 Anthropic 사이에 로컬 프록시가 위치합니다. 더 읽기 전에 이것이 정확히 무엇을 의미하는지 확인하세요 — 전체 설명은 [보안 모델](#security-model)에서 확인할 수 있습니다.

- **기본적으로 `127.0.0.1`에 바인딩됩니다.**
- **Claude Code 트래픽을 Anthropic으로 전달합니다. 기본 경로에서는 다른 외부 호출을 하지 않습니다** — 원격 측정은 `~/.claude/` 아래 로컬 파일에 기록되며, 어디로도 전송되지 않습니다. 두 가지 선택적 기능은 자체 외부 호출을 수행하며, 활성화하지 않으면 작동하지 않습니다: OAuth 새로 고침 (`CACHE_FIX_OAUTH_REFRESH=on`)은 Anthropic의 토큰 엔드포인트에 게시하고, 전방 프록시 다운로드 가속은 `downloads.claude.ai` / `storage.googleapis.com`에 다시 다운로드를 재발행합니다.
- **`POST /v1/messages`를 읽고 수정할 수 있습니다.** 이 기능이 *캐시 복구*입니다 — 없이는 작동하지 않습니다.
- **멱등성입니다: 복구가 필요하지 않으면 요청은 수정되지 않고 통과됩니다.** 요청 구조(블록 순서, 지문, TTL)를 정규화합니다; 대화 내용을 수정하지는 않습니다.
- **각 변환은 `proxy/extensions/`에 있는 하나의 파일입니다** — 개별적으로 읽을 수 있습니다.
- [@TheAuditorTool](https://github.com/anthropics/claude-code/issues/38335#issuecomment-4244413605)에 의해 [독립적으로 합법적인 도구로 평가됨](https://github.com/anthropics/claude-code/issues/38335#issuecomment-4244413605) (2026-04-14).

전방 프록시 모드(`--remote-control`)는 `api.anthropic.com`에 대해 로컬 생성된 CA를 사용하여 TLS를 종료하며, 클라이언트가 이를 신뢰해야 합니다. 다른 모든 것은 블라인드 터널입니다. 이 모드는 선택적이며 기본적으로 꺼져 있습니다.

## 필요할까요?

**설치하거나 테스트하는 경우:** 재개 또는 장시간 실행 세션에서 반복적인 `cache_creation_input_tokens` 스파이크가 발생하거나 캐시 읽기 비율이 낮거나 불안정하며 예상치 못한 TTL 5m 다운그레이드, thinking-desync `400`, 또는 이미지 재시도 폭풍을 확인할 때 사용합니다. 또는 아래 문서화된 캐시가 아닌 표면에 해당하는 경우.

**건너뛸 수 있습니다:** 세션이 안정적인 높은 캐시 읽기 비율을 유지하고 있거나, 장시간 세션을 자주 재개하지 않으며, 할당량 부담이 없거나 API 경로에 로컬 프록시를 배치하고 싶지 않은 경우. **이 네 가지 모두 이 프로젝트를 설치하지 않는 좋은 이유입니다.**

확실하지 않다면 측정해 보세요 — 이 프로젝트를 설치하지 않고도 답을 찾을 수 있습니다.

## 문제가 있는지 확인하세요

Claude Code는 자체 세션 트랜스크립트에 요청별 캐시 회계를 기록하므로, 설치하기 전에 캐시 상태를 측정할 수 있습니다.

```bash
# <session-uuid>를 바꾸거나 최근 세션을 선택하는 글로브를 사용합니다.
jq -r 'select(.message.usage.cache_read_input_tokens != null) |
  "\(.requestId)\t\(.message.usage.cache_read_input_tokens) \(.message.usage.cache_creation_input_tokens)"' \
  ~/.claude/projects/*/<session-uuid>.jsonl |
  sort -u -k1,1 | cut -f2 |
  awk '{n++; r+=$1; c+=$2}
       END {if (n==0) print "no usage rows found — check the session path";
            else printf "requests=%d cache_read=%d creation=%d read-ratio=%.0f%%\n", n, r, c, 100*r/(r+c)}'
```

`sort -u -k1,1`은 각 API 호출을 한 번만 계산합니다 — Claude Code는 요청당 여러 트랜스크립트 행을 작성하며 **요청당 항상 동일한 횟수는 아닙니다** ([ArkNill의 분석](https://github.com/ArkNill/claude-code-hidden-problem-analysis)). 원시 행을 합산하면 중복 횟수에 따라 각 호출이 가중됩니다. 한 머신에서 로컬 트랜스크립트를 두 번 독립적으로 스캔한 결과(2026-08-02)는 다음과 같습니다: **짧은 세션이 문제가 됩니다** — 20 요청 미만의 세션 중 절반 이상이 중복 없이 1포인트 이상 이동했으며, 최악의 경우 **41포인트**, 장시간 세션은 거의 모든 포인트 미만(3/37)입니다. 짧은 세션은 처음 사용자가 이 문제를 테스트하는 데 정확히 해당합니다.

결과 읽기:

- **20 요청 미만: 숫자는 의미가 없습니다.** 냉 시작 시 읽을 것이 없으므로 생성이 우세하고 모든 건강한 세션이 깨진 것처럼 보입니다. 장시간 또는 재개된 세션을 사용하세요.
- **장시간 세션에서 지속적인 낮은 비율 또는 매번 `--resume` 시 `creation` 스파이크** — 이 프로젝트가 존재하는 문제입니다.
- **장시간 세션에서 높은 비율** — 필요하지 않습니다. 위의 *필요할까요?*를 참조하세요.

## 현재 권고 사항

> **v4.0.0** — 비용 영향 및 관측성 확장을 포함한 로컬 HTTP 프록시 파이프라인. 두 가지 오래된 기본값이 반전되었습니다: `thinking-block-sanitize` v1은 기본적으로 켜져 있습니다 (thinking-desync `400` 슬릿을 완화 — [#63147](https://github.com/anthropics/claude-code/issues/63147)) 및 프로세스 내 확장 핫리로드는 선택적입니다 (`CACHE_FIX_HOT_RELOAD=on`). A/B 베이스라인 (v3.0.0 on v2.1.117): **프록시를 통한 캐시 히트율 95.5% vs 직접 82.3%** 첫 번째 웜 턴에서. [전체 릴리스 노트 →](https://github.com/cnighswonger/claude-code-cache-fix/releases/tag/v4.0.0)

> **Opus 4.7 권고:** 측정된 데이터에 따르면, 동일한 가시 토큰 수치에 대해 4.7은 4.6의 **약 2.4배** 속도로 Q5h 할당량을 소모합니다 ([@ArkNill에 의해 독립적으로 확인됨](https://github.com/ArkNill/claude-code-hidden-problem-analysis/blob/main/16_OPUS-47-ADVISORY.md)). 두 가지 요인: 새로운 토크나이저 (최대 35% 더 많은 토큰, [문서화됨](https://platform.claude.com/docs/en/about-claude/models/whats-new-claude-4-7)) 및 적응형 생각 오버헤드 (~105%, 사용량 응답에 문서화되지 않음). Q5h 영향은 **Q7d**로 증폭됩니다 — 대부분의 무거운 사용자가 먼저 도달하는 주간 할당량 상한선입니다. 대안: `CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING=1`은 소모를 약 3.3배 줄이지만 복잡한 작업에서는 품질을 저하시킬 수 있습니다. [논의 #25](https://github.com/cnighswonger/claude-code-cache-fix/discussions/25) (초기 관찰) 및 [논의 #42](https://github.com/cnighswonger/claude-code-cache-fix/discussions/42) (통제된 A/B 데이터 + Q7d 분석) 참조.

## 빠른 시작: 프록시 (권장)

프록시는 모든 CC 버전에서 작동합니다 — Node.js 또는 Bun 바이너리. Claude Code와 Anthropic API 사이에 위치하며 캐시 수정을 구성 가능한 확장으로 적용합니다.

```bash
# 설치
npm install -g claude-code-cache-fix

# 프록시 시작 (localhost:9801에서 실행)
node "$(npm root -g)/claude-code-cache-fix/proxy/server.mjs" &

# 프록시를 통해 Claude Code 시작
ANTHROPIC_BASE_URL=http://127.0.0.1:9801 claude
```

이것이 전부입니다. 프록시는 기본 확장 파이프라인을 자동으로 적용합니다. 래퍼 스크립트, `NODE_OPTIONS`, 사전 로드가 필요하지 않습니다.

### 전방 프록시 모드 (원격 제어 작동 유지)

위의 빠른 시작은 **역방향 프록시 모드**입니다: `ANTHROPIC_BASE_URL`를 프록시로 지정합니다. 간단하지만 Claude Code **>= 2.1.196**에서는 Anthropic이 아닌 `ANTHROPIC_BASE_URL`가 **원격 제어를 비활성화**합니다 (`/remote-control`, `/schedule`, claude.ai MCP 커넥터). 이러한 기능에 의존하는 경우 전방 프록시 모드를 사용하세요.

**전방 프록시 모드**에서 프록시는 *실제* `api.anthropic.com` 앞에 위치하며 `HTTPS_PROXY`로 작동합니다. Claude Code의 기본 URL은 `api.anthropic.com`으로 유지되므로 원격 제어가 계속 작동하고, 프록시는 여전히 `/v1/messages`를 보고 변환합니다.

```bash
# 전방 프록시 모드에서 프록시 시작
CACHE_FIX_FORWARD_PROXY=on node "$(npm root -g)/claude-code-cache-fix/proxy/server.mjs" &
# 클라이언트를 연결하는 두 개의 환경 변수를 출력합니다. 예:
#   export HTTPS_PROXY=http://127.0.0.1:9801
#   export NODE_EXTRA_CA_CERTS=~/.claude/cache-fix-ca/ca.pem

# 프록시를 통해 Claude Code 시작 (ANTHROPIC_BASE_URL는 설정하지 않음)
HTTPS_PROXY=http://127.0.0.1:9801 \
NODE_EXTRA_CA_CERTS=~/.claude/cache-fix-ca/ca.pem \
  claude
```

또는 `--remote-control`으로 두 단계를 자동으로 처리할 수 있습니다:

```bash
# CACHE_FIX_FORWARD_PROXY=on으로 프록시를 시작하고 클라이언트를 자동으로 연결합니다.
# (HTTPS_PROXY + MITM CA, ANTHROPIC_BASE_URL는 비워둠)
cache-fix-proxy --remote-control
```

`--remote-control` 플래그는 위의 수동 연결과 동일한 명령어입니다: 프록시를 전방 프록시 모드로 시작하고 CA를 기다린 후 `HTTPS_PROXY`에 설정된 `NODE_EXTRA_CA_CERTS`로 `claude`를 시작합니다 (그리고 `127.0.0.1,localhost,::1`을 `NO_PROXY`에 추가하여 로컬 서비스 — 예: localhost의 HTTP/SSE-transport MCP 서버 — 프록시를 통과하지 않고 라우팅되도록 합니다; 기존 `NO_PROXY`는 유지됩니다). 플래그 없이 실행하면 래퍼는 역방향 프록시 모드로 유지됩니다 (`ANTHROPIC_BASE_URL` 설정), 변경되지 않습니다. 두 가지 알아야 할 점: 원격 제어는 첫 연결 시 신뢰된 장치 등록을 수행하며 몇 번의 `/remote-control` 재시도가 필요할 수 있습니다 (Claude Code 단계로, 프록시 실패가 아님); 그리고 이미 웜 세션에서 RC를 활성화하면 **단일** 프롬프트 캐시 재구성이 필요합니다 (RC는 `anthropic-beta` 캐시 키를 추가함), 따라서 원격 제어가 필요한 경우 처음부터 `--remote-control`로 시작하면 한 번의 전환을 피할 수 있습니다. `cache-fix-proxy --help`는 둘 다 문서화되어 있습니다.

> 수동으로 전방 프록시 모드를 연결하는 경우 (`--remote-control` 대신 `HTTPS_PROXY`를 직접 설정하는 경우) `NO_PROXY=127.0.0.1,localhost,::1`도 설정해야 하며, 그렇지 않으면 로컬 HTTP-transport MCP 서버 및 다른 localhost 서비스가 cache-fix 프록시로 라우팅되어 실패합니다. stdio-transport MCP 서버는 영향을 받지 않습니다 (네트워크가 아닌 파이프를 사용함).

작동 방식: 프록시는 HTTP `CONNECT`도 처리합니다. 프록시는 **오직** 상류 호스트(`api.anthropic.com`)만 MITM하며, 로컬 생성된 CA로 TLS를 종료하여 동일한 확장 파이프라인을 실행하고 **다른 모든 CONNECT는 블라인드 터널링**됩니다 (mcp-proxy, 원격 측정, npm 등). 첫 시작 시 `$CLAUDE_CONFIG_DIR/cache-fix-ca/`에 CA를 생성합니다 (기본 `~/.claude/cache-fix-ca/`; `CACHE_FIX_CA_DIR`로 재정의); 클라이언트는 `NODE_EXTRA_CA_CERTS`를 통해 신뢰해야 합니다. 상류 호스트(예: `/voice`)로의 WebSocket/Upgrade는 그대로 상류로 전달됩니다. 기본 URL이 `api.anthropic.com`이므로 `/api/oauth/*`, `/v1/agents`, 원격 제어 자격 증명 가져오기 등은 모두 통과하여 RC가 계속 활성화됩니다.

기업 프록시 체인은 역방향 모드와 동일하게 작동합니다: 상류 업스트림에 대한 `HTTPS_PROXY`/`HTTP_PROXY`를 설정합니다 (프록시는 `api.anthropic.com`을 통해 연결). 클라이언트의 `HTTPS_PROXY`는 cache-fix 프록시를 가리키고, cache-fix 프록시의 `HTTPS_PROXY`(자신의 환경)는 기업 프록시를 가리킵니다.

**공유 프록시에서의 충돌 의미.** 전방 프록시 모드에서는 프록시가 전체 상류 호스트를 MITM하므로 진행 중인 Claude Code 세션은 *이* 포트에 연결되어 실패할 수 없습니다. 하나의 나쁜 요청이 프로세스를 다운시키지 않도록 성공적인 전방 프록시 연결은 `uncaughtException`/`unhandledRejection` 핸들러를 설치하여 충돌 대신 로그하고 계속 서비스합니다. 이는 전방 모드에 한정됩니다 (역방향 전용 프록시는 Node의 기본 충돌 동작을 유지하여 감독자가 재시작하도록 합니다) 그리고 마지막 전방 인스턴스가 닫힐 때 제거됩니다. 트레이드오프: **공유 / 다중 테넌트** 프록시에서 전방 모드를 활성화하면 해당 인스턴스의 모든 클라이언트에 대한 충돌 동작이 변경됩니다 — 치명적인 버그는 감독자에게 노출되지 않고 숨겨집니다. 여러 세션을 위해 하나의 프록시를 실행하는 경우, 감독된 세션 모델과의 균형을 고려하세요.

**지속적으로 실행하기.** 위의 `... node .../proxy/server.mjs &`는 빠른 시도에는 적합하지만 백그라운드 프로세스는 감시되지 않습니다: 충돌하거나 머신 재부팅 시 자동으로 재시작하지 않습니다. 전방 프록시 모드를 관리 서비스로 실행하려면 [서비스로 실행](#running-as-a-service)에서 설명한 동일한 `install-service` 경로를 사용하세요 — 설치 시 플래그를 설정하여 유닛에 포함시키세요:

```bash
CACHE_FIX_FORWARD_PROXY=on cache-fix-proxy install-service
```

생성된 systemd 유닛 / launchd 에이전트는 `CACHE_FIX_FORWARD_PROXY=on`을 포함하므로 서비스가 전방 프록시 모드로 프록시를 시작하고 계속 실행합니다 (systemd `Restart=on-failure` + 건강검사 타이머; launchd `KeepAlive`).

**서비스는 프록시 끝만 관리합니다.** 이는 **아니요** — 그리고 할 수 없습니다 — `claude` 클라이언트에 대해 아무것도 설정하지 않으며 별도의 프로세스입니다. 여전히 `claude`를 시작하는 모든 셸에서 수동으로 클라이언트를 연결해야 하며, 위의 전방 프록시 빠른 시작에서 두 값을 사용합니다:

- `HTTPS_PROXY` — 프록시가 듣는 위치: `http://127.0.0.1:<port>` (기본 포트 `9801`, 또는 `CACHE_FIX_PROXY_PORT`).
- `NODE_EXTRA_CA_CERTS` — 프록시가 첫 시작 시 생성한 CA: `~/.claude/cache-fix-ca/ca.pem` (`$CACHE_FIX_CA_DIR/ca.pem`).

변수 적용 범위에 따라 세 가지 방법으로 연결할 수 있습니다.

> **이 호스트의 다른 항목도 `api.anthropic.com`을 MITM하는 경우** — 기업 TLS 검사 에이전트, 계정 전환 핀 프록시 — 이 레시피를 사용하지 마세요. `NODE_EXTRA_CA_CERTS`는 하나의 파일만 허용하므로 우리의 CA에 연결하면 다른 모든 구성 요소가 조용히 신뢰되지 않습니다. `--remote-control`을 사용하세요, 이는 `ca-trust.d/`에 게시하고 병합된 번들을 소비합니다. [다른 MITM과 공존](#coexisting-with-another-mitm-on-the-same-machine-ca-trustd) 참조.

```bash
# a) 호출당 — 단지 이 claude 실행만 범위로
HTTPS_PROXY=http://127.0.0.1:9801 \
NODE_EXTRA_CA_CERTS=~/.claude/cache-fix-ca/ca.pem \
  claude

# b) 전체 셸 — ~/.zshrc / ~/.bashrc에 추가 (해당 셸의 모든 HTTPS가 프록시를 통과함; 무해하지만 비-anthropic 호스트는 블라인드 터널링이므로 프록시가 다운되면 해당 셸의 HTTPS가 중단됨)
export HTTPS_PROXY=http://127.0.0.1:9801
export NODE_EXTRA_CA_CERTS=~/.claude/cache-fix-ca/ca.pem

# c) claude만 범위 — 셸 함수 (권장; b의 영향 범위를 피함)
claude() {
  HTTPS_PROXY=http://127.0.0.1:9801 \
  NODE_EXTRA_CA_CERTS=~/.claude/cache-fix-ca/ca.pem \
    command claude "$@"
}
```

#### 동일한 머신에서 다른 MITM과 공존 (`ca-trust.d`)

`NODE_EXTRA_CA_CERTS`는 정확히 **하나의** 파일만 허용합니다. 호스트의 다른 항목도 `api.anthropic.com`을 MITM하고 해당 변수를 설정하는 경우 — 기업 에이전트, 계정 전환 핀 프록시 — 마지막 작성자가 승리하고 다른 모든 CA는 조용히 신뢰되지 않습니다. 2026-07-30 측정: 한 머신에서 두 가지 구성 요소가 서로 TLS를 파괴하며 오류가 어느 쪽에도 속하지 않았습니다.

따라서 `--remote-control`은 변수를 단순히 할당하는 것이 아닙니다. 다음과 같습니다:

1. **게시** 우리의 CA를 `<config>/ca-trust.d/ccf.pem`에 — 우리 고유한 파일명으로, 형제 파일과 충돌하지 않으며 매번 시작 시 재작성됩니다 (프록시는 CA 디렉토리가 지워질 때마다 CA를 재생성하고, 오래된 pem은 서명 키가 없는 내용을 광고함), 바이트가 이미 일치하면 건너뛰고 임시 + `rename`으로 쓰여서 읽는 사람이 절반 작성 파일을 볼 수 없습니다.
2. **읽기** `<config>/ca-trust.pem` — 외부 작성자가 환경/기업 루트와 모든 게시된 `ca-trust.d/*.pem`으로 구성된 병합 번들을 읽고 `NODE_EXTRA_CA_CERTS`를 가리킵니다.

`<config>`는 `CLAUDE_CONFIG_DIR` 또는 `~/.claude`입니다. **우리는 병합 번들을 절대 작성하지 않습니다**: 병합은 환경별 기업 루트를 찾는 것이 필요하며, 이는 환경에 따라 다릅니다 (Linux 호스트는 번들 밖에 보관할 수 있고 Mac은 키체인에 보관함), 두 구성 요소가 동시에 재구성하면 출력을 경쟁합니다.

번들은 노드가 해당 파일을 받았을 때 실제로 우리의 프록시 리프를 검증하는 경우에만 사용됩니다. 래퍼는 예측하지 않습니다 — 요청: 출생 시 `NODE_EXTRA_CA_CERTS` 설정된 자식 프로세스가 우리 리프를 포함한 TLS 서버를 세우고 연결합니다. 로더가 실제로 우리의 CA를 로드한 번들만 해당 핸드셰이크를 완료할 수 있습니다.

번들이 실패하는 것은 번들이 없을 때보다 나쁩니다 — 클라이언트가 라우팅되는 프록시를 신뢰하지 않게 되어 모든 요청이 TLS 실패로 인해 실패합니다.

**파싱 대신 질문하는 이유.** 이전 버전은 노드 로더의 정규식을 모델링했습니다: base64 양자, 패딩 위치, 마커에서 대시 런, openssl이 허용하는 10가지 공백 문자. 다섯 번 검토했지만 실제 번들에서는 여전히 방향이 잘못되었습니다 — 노드가 로드하지 않는 것을 받아들이고 노드가 정상적으로 로드하는 것을 거부했습니다. 도달하려는 규칙은 외부에서 표현할 수 없습니다: 동일한 티어는 복구 또는 치명적이지만 그 트리uncated 본문이 완전한 DER인지에 따라 달라지며, 이는 바이트 질문이며 파서가 답할 수 없습니다. 로더는 하나의 생성에서 할 수 있습니다 (~25ms bare `node -e ''` — 측정, 40개의 교차 쌍: 17.3ms bare, 42.4ms probe). 이 25ms가 무엇인가요: `--remote-control` 시작은 약 520ms 종단간이며, 그 중 약 493ms는 프록시를 포크하고 듣기를 기다리는 시간입니다. 따라서 프로브는 시작의 약 8%이며 거의 모든 CA 작업입니다.

**세 가지 결과, 두 가지가 아닙니다.** `ok`, `not ok`, 그리고 `unknown` — 마지막은 프로브를 실행할 수 없음을 의미합니다. 질문할 수 없는 경우 "사용 불가능"으로 응답하는 보호는 머신의 모든 기업 루트를 삭제합니다.

**손상된 병합은 다른 게시자에게 CA를 잃지 않습니다.** 손상은 병합에 있고, 그것이 공급한 파일에 있지 않으므로 래퍼는 여전히 작동하는 `ca-trust.d/` 게시자로부터 재구성하고 기본 CA로 되돌아가지 않습니다. 절약은 살아남은 게시자당 하나의 인증서입니다: 이 박스에서 측정 (우리와 하나의 피어), 하나의 인증서는 오래된 대체에 대해, 두 개는 재구성에 대해; 세 가지 게시자 호스트에서는 하나 대 세 개입니다.

두 경로는 `<config>` 하위 고정 이름이며, 자체 환경 변수 재정의는 의도적으로 없습니다. 이들은 하나의 레이스의 두 절반입니다: 한쪽 절반만 조절하면 구성 요소가 빌더가 보지 않는 위치에 게시하거나 빌더가 쓰지 않는 파일을 읽을 수 있으며, 여전히 계약을 구현하는 것처럼 보입니다. `CLAUDE_CONFIG_DIR`는 이미 이 쌍을 재배치하며 두 절반을 함께 이동합니다.

소비자가 확인하는 한계에 대해 주의하세요: 완전하고 우리 CA를 포함합니다. 번들이 *완전한지* — 기업 루트가 누락되지 않았는지 —는 빌더의 보장이며, 소비자는 그것에 따라 행동해서는 안 됩니다.

이는 누락된 능력이 아니라 디자인 선택이며 구분이 중요합니다. 다른 해석은 초대입니다: 누군가 이전 번들을 상태로 추가하고 제한이 해제되었다고 믿고 바닥을 추가합니다. 여전히 잘못되었습니다. 루트가 퇴출되거나 구성 요소가 제거될 때 수축은 *합법적*이며, 오직 빌더만 어떤 일이 일어났는지 알고 있습니다 — 따라서 두 번들 모두를 유지하는 읽기는 회귀와 사실을 구별할 수 없습니다. 측정: 이 머신에서 합법적인 번들은 5개 인증서이고 다른 머신에서는 168개이므로, 한 호스트에서 축소된 바닥은 다음 호스트의 건강한 번들을 거부합니다.

**이는 동일한 사용자 프로세스 간 협력 규약이며 신뢰 경계가 아닙니다.** 확인은 *파싱하고 우리를 포함*하는 것을 증명합니다 — 절대 *승인된 작성자만 포함*하지 않습니다. `<config>`를 쓸 수 있는 누구나 우리 CA와 그들의 CA를 포함한 잘 구성된 번들을 제공할 수 있으며, 그것이 받아들여질 것입니다. 정확히 그들이 `ca-trust.d/ccf.pem`, CA 디렉토리 또는 이 파일을 대체했을 수 있습니다. 계약은 구성 요소가 서로 신뢰를 해제하는 실패를 방지하며, 실제로 발생하는 실패입니다; 로컬 공격자에 대한 방어는 아닙니다.

#### `CACHE_FIX_DOWNLOAD_REWRITE`는 `claude update`를 망가뜨립니다 — 끄세요

`CACHE_FIX_DOWNLOAD_REWRITE=on`은 순수 성능 노브처럼 보입니다. 그렇지 않습니다: 켜면 **해당 호스트에서 `claude update`가 완전히 비활성화**됩니다. 다운로드 URL을 재작성한다는 것은 그것을 읽는다는 것이며, 이는 `downloads.claude.ai`를 MITM한다는 의미입니다 — 그리고 릴리스 채널 클라이언트는 **공개 루트만** 고정되어 있고 모든 사설 CA를 거부하므로 버전 확인은 바이트가 다운로드되기 전에 실패합니다:

```
Failed to fetch version from .../claude-code-releases/latest after 3 attempt(s):
  unable to verify the first certificate
```

`openssl s_client -proxy 127.0.0.1:9901 -connect downloads.claude.ai:443 -servername downloads.claude.ai`로 측정:

| `CACHE_FIX_DOWNLOAD_REWRITE` | 리프 CN | 검증 |
|---|---|---|
| `on` | `api.anthropic.com` | 코드 21 |
| `off` | `downloads.claude.ai` (WR3 / GTS Root R1) | 코드 0 |

두 가지가 이보다 더 나쁘게 보입니다:

- **바이너리 다운로드로 축소할 수 없습니다.** MITM은 `CONNECT` 시간에 호스트별로 결정되며, 버전 확인은 다운로드와 동일한 `downloads.claude.ai`를 공유합니다. 호스트당 전부 또는 없음입니다.
- **클라이언트 측 재정의는 해당 클라이언트에 도달하지 않습니다.** `HTTPS_PROXY` / `ALL_PROXY`, `/etc/hosts`, `/etc/resolv.conf`, `NODE_EXTRA_CA_CERTS`는 모두 동일한 경로에서 제어가 불가능했으며, 로컬 리졸버는 0개의 쿼리를 기록하고 TCP 포워더는 0개의 연결을 기록했습니다. 그러나 같은 포워더를 통한 일반 `node https.get`은 200을 반환했습니다. 따라서 CA 주입으로는 재작동이 작동하지 않습니다. MITM하지 않는 경우에만 작동합니다.

다른 호스트는 영향을 받지 않습니다: 동일한 프록시를 통해 `github.com`은 실제 인증서를 반환하고 검증됩니다. 플래그는 기본적으로 꺼져 있으며, 다른 방식으로 Claude Code를 업데이트할 준비가 되지 않은 경우 유지하세요.

### 프록시가 하는 일

모든 `/v1/messages` 요청에서 파이프라인은 캐시 안정성, 관측성, thinking-desync 완화, 이미지, 마이크로 컴팩트, 브레이크포인트, 부트스트랩 채널 및 기타 표면을 다루는 순서가 정해진 확장 체인을 실행합니다. 몇 가지는 환경 변수에 의해 제어되며 아래 섹션에서 설명됩니다; 부트스트랩 채널 처리는 기본적으로 `audit` 모드입니다. 주요 기능:

| 확장 | 수정 내용 |
|---|---|
| `fingerprint-strip` | 시스템 프롬프트에서 불안정한 cc_version 지문 제거 |
| `sort-stabilization` | 도구 및 MCP 정의의 결정론적 정렬 |
| `ttl-management` | 서버 TTL 레벨 감지, 올바른 cache_control 마커 주입 |
| `identity-normalization` | 접두사 안정성을 위한 메시지 ID 필드 정규화 |
| `fresh-session-sort` | 첫 번째 턴에서 비결정론적 정렬 수정 |
| `cache-control-normalize` | 메시지 간 cache_control 마커 정규화 |
| `cache-telemetry` | 응답 헤더에서 캐시 통계 추출 → `~/.claude/quota-status/{account.json,sessions/<id>.json}` |
| `session-health` | 세션당 thinking-desync 위험 관찰 (컨텍스트 크기 + thinking-블록 수), 위험 구역에 도달하기 전 경고. 읽기 전용 |
| `thinking-block-sanitize` | CC thinking-desync `400` 오류를 미리 방지하기 위해 생략된(빈 텍스트) thinking 블록 제거 (#63147). **v4.0.0부터 기본적으로 켜짐** (v1 모드). `CACHE_FIX_THINKING_SANITIZE=off`로 비활성화, `=v2`로 추가 도구 해시 불일치 제거(선택적) |
| `workflow-agent-id-synthesis` | Workflow-tool 하위 에이전트의 안정적인 각 레그 에이전트 ID를 파생합니다. CC는 해당 `x-claude-code-agent-id` 헤더를 설정하지 않습니다 ([CC#66761](https://github.com/anthropics/claude-code/issues/66761)). 기본적으로 켜져 있으며, `ctx.meta._workflowAgentId`에 저장되며 프록시에서 나가지 않습니다. `CACHE_FIX_USAGE_LOG_AGENT_ID=on` 및 meter v0.8.0+ 설치 시 `usage-log`는 `agent_id` + `agent_id_source` 필드를 출력합니다. 마스터 스위치: `CACHE_FIX_WORKFLOW_AGENT_DERIVATION=off`. |
| `session-budget-breaker` | 선택적 하드 **세션당 지출 한도** — 설정한 한도를 초과하면 세션의 요청을 로컬에서 단절하여, 런어우드 팬아웃이 크레딧이나 자동 구매를 유발하지 않도록 합니다 ([CC#68285](https://github.com/anthropics/claude-code/issues/68285)). 기본적으로 꺼져 있으며, 실패 시 열림. 게이트 `CACHE_FIX_SESSION_BUDGET=on` + 한도. [세션 예산 서킷 브레이커](#session-budget-circuit-breaker-proxy-mode-opt-in) 참조. |

확장은 `proxy/extensions/`에 `.mjs` 파일로 존재하며, 구성은 `proxy/extensions.json`에 있습니다. v4.0.0부터 프록시는 시작 시 한 번만 로드됩니다; 확장을 추가, 제거 또는 수정하려면 관리자 수준의 프록시 재시작이 필요합니다 (v3.x 업그레이드 참조). 핫리로드는 선택적으로 `CACHE_FIX_HOT_RELOAD=on`을 통해 제공되며, v3.x 동작을 원하는 사용자를 위해 제공됩니다; 이 경로는 [#196](https://github.com/cnighswonger/claude-code-cache-fix/issues/196)에 문서화된 Node ESM 스테일 임포트 경쟁에 영향을 받습니다.

**새 확장을 개발 중인가요?** 실제 `claude -p` 트래픽에 대해 프로덕션 프록시를 방해하지 않고 종단 간 테스트하는 패턴은 [docs/parallel-proxy-test-harness.md](docs/parallel-proxy-test-harness.md)를 참조하세요.

### 서비스로 실행

**권장 (Linux/macOS) — `install-service` 하위 명령어:**

```bash
cache-fix-proxy install-service
```

플랫폼을 감지하고 적절한 구성을 작성합니다:

- **Linux** → `~/.config/systemd/user/cache-fix-proxy.service` (systemd 사용자 유닛)
- **macOS** → `~/Library/LaunchAgents/com.cnighswonger.cache-fix-proxy.plist` (launchd 에이전트)

출력은 서비스를 활성화하고 시작하는 다음 단계 명령어를 출력합니다. Linux에서:

```bash
systemctl --user daemon-reload
systemctl --user enable --now cache-fix-proxy
systemctl --user enable --now cache-fix-proxy-healthcheck.timer   # 자동 복구 — 아래 참조
sudo loginctl enable-linger $USER   # 선택: 로그인 시가 아닌 부팅 시 시작
```

**자동 복구 (Linux):** `install-service`는 건강 검사 동반자(`cache-fix-proxy-healthcheck.service` + `.timer`)를 추가합니다. 타이머는 2분마다 작동하며, 단일 실행 서비스는 `curl -fs http://127.0.0.1:<port>/health`를 실행하고 프로브가 실패하면 `systemctl --user start cache-fix-proxy.service`를 실행합니다. 이는 2분 내에 모든 중단(정상 또는 비정상, 예상 또는 예상치 못한)에서 프록시를 복구합니다. 배경: `Restart=on-failure`는 정상 종료 시 작동하지 않으므로 이 동반자가 없었을 때 어떤 출처의 `systemctl stop` (2026-04-25 Anthropic 다운 중에도 불명확한 출처)은 프록시를 무기한 다운시켰습니다. macOS는 동반자가 필요하지 않습니다 — launchd의 `KeepAlive`가 모든 종료 시 자동 재시작합니다.

macOS에서:

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.cnighswonger.cache-fix-proxy.plist
launchctl enable gui/$(id -u)/com.cnighswonger.cache-fix-proxy
launchctl kickstart gui/$(id -u)/com.cnighswonger.cache-fix-proxy
```

설치된 구성은 설치 시 환경 변수에서 `CACHE_FIX_PROXY_PORT`, `CACHE_FIX_PROXY_UPSTREAM`, `CACHE_FIX_DEBUG`를 읽습니다. 환경 변수 변경 후 `install-service --force`를 재실행하여 재생성하거나 직접 서비스 파일을 편집합니다. `cache-fix-proxy uninstall-service`와 함께 사용하여 깨끗하게 제거(중지, 비활성화, 삭제)할 수 있습니다.

서비스는 `cache-fix-proxy server`를 포그라운드에서 실행하며, 이는 래퍼 모드의 claude 래퍼가 아닌 프록시 자체입니다.

**수동 (모든 플랫폼):**

```bash
nohup cache-fix-proxy server > /tmp/cache-fix-proxy.log 2>&1 &
echo 'export ANTHROPIC_BASE_URL=http://127.0.0.1:9801' >> ~/.bashrc
```

### Docker

모든 릴리스 태그에서 다중 아키텍처(amd64, arm64) 컨테이너 이미지가 GitHub Container Registry에 게시됩니다.

```bash
docker run -d --name cache-fix-proxy \
  --restart=always \
  -p 9801:9801 \
  ghcr.io/cnighswonger/claude-code-cache-fix:latest

# 그런 다음 셸에서:
export ANTHROPIC_BASE_URL=http://127.0.0.1:9801
```

systemd 건강 검사 동반자 대신 `--restart=always`를 사용합니다 — Docker는 자동 복구를 내장합니다. 아무것도 마운트하지 않으며, 컨테이너는 상태가 없습니다. 기본 포트는 `-e CACHE_FIX_PROXY_PORT=...`로 재정의할 수 있습니다. 상류(예: llm-relay를 통한 체인)는 `-e CACHE_FIX_PROXY_UPSTREAM=http://host.docker.internal:8080`으로 재정의합니다. 이미지는 비권한 `node` 사용자(uid 1000)로 실행되며, Docker가 라이브니스를 위해 노출하는 `HEALTHCHECK`를 제공합니다.

SSL 검사 프록시 뒤의 기업 환경을 위해 CA 번들을 마운트하고 환경 변수를 설정하세요:

```bash
docker run -d --name cache-fix-proxy --restart=always -p 9801:9801 \
  -e HTTPS_PROXY=http://proxy.corp.example:8080 \
  -e CACHE_FIX_PROXY_CA_FILE=/etc/ssl/corp-ca.pem \
  -v /path/to/zscaler-root.pem:/etc/ssl/corp-ca.pem:ro \
  ghcr.io/cnighswonger/claude-code-cache-fix:latest
```

이미지 태그: `latest`, `4`, `4.0`, `4.0.0` (시맨틱 버전 래더, 따라서 `4`는 항상 최신 4.x를 가리킵니다). `latest`는 항상 최신 태그된 릴리스를 추적합니다.

**Linux 참고:** 아래 체인 상류 `host.docker.internal` 예제는 Docker Desktop (macOS / Windows)에서 자동으로 사용 가능합니다. 순수 Linux Docker Engine에서는 일반적으로 `--add-host=host.docker.internal:host-gateway`가 필요하여 이름이 호스트 브리지로 확인됩니다. 그렇지 않으면 컨테이너의 이름 조회가 실패하고 프록시는 호스트에서 실행 중인 상류 서비스에 접근할 수 없습니다. cache-fix 프록시를 호스트에서 실행 중인 `llm-relay`를 통해 체인하는 예제:

```bash
docker run -d --name cache-fix-proxy --restart=always -p 9801:9801 \
  --add-host=host.docker.internal:host-gateway \
  -e CACHE_FIX_PROXY_UPSTREAM=http://host.docker.internal:8080 \
  ghcr.io/cnighswonger/claude-code-cache-fix:latest
```

**Docker에서 전방 프록시 모드** (원격 제어 유지; [전방 프록시 모드](#forward-proxy-mode-keeps-remote-control-working) 참조). `-e CACHE_FIX_FORWARD_PROXY=on`을 추가하고 `CACHE_FIX_CA_DIR`를 쓸 수 있는 경로로 지정합니다. 이미지는 비권한 `node` 사용자(uid 1000)로 실행되며, 새로운 Docker 이름 볼륨은 **루트 소유**이므로 `chown`으로 바인드 마운트를 사용하세요 (이렇게 하면 재시작 시 CA가 영구적으로 유지되고 호스트에서 읽을 수 있습니다):

```bash
mkdir -p ./cache-fix-ca && sudo chown 1000:1000 ./cache-fix-ca
docker run -d --name cache-fix-proxy --restart=always -p 9801:9801 \
  -e CACHE_FIX_FORWARD_PROXY=on \
  -e CACHE_FIX_CA_DIR=/ca -v "$PWD/cache-fix-ca:/ca" \
  ghcr.io/cnighswonger/claude-code-cache-fix:latest

# 이제 CA는 호스트의 ./cache-fix-ca/ca.pem에 있습니다. 프록시를 가리키는 클라이언트 (원격 제어가 활성화되도록 ANTHROPIC_BASE_URL는 설정하지 않음):
HTTPS_PROXY=http://127.0.0.1:9801 NODE_EXTRA_CA_CERTS=$PWD/cache-fix-ca/ca.pem claude
```

호스트에서 CA를 영구적으로 유지할 필요가 없다면 볼륨을 제거하고 컨테이너의 쓰기 가능한 레이어에 남겨두세요: `-e CACHE_FIX_CA_DIR=/tmp/cache-fix-ca` (그런 다음 `docker cp cache-fix-proxy:/tmp/cache-fix-ca/ca.pem ./ca.pem`로 가져옵니다). 성공했는지 확인하세요: `curl -s localhost:9801/health`는 `"forward_proxy":true`를 보고해야 합니다; `false`이면 프록시가 역방향 프록시로 폴백되었습니다 (예: 쓰기 불가능한 CA 디렉토리).

### 건강 검사

```bash
curl http://127.0.0.1:9801/health
# {"status":"ok"}
```

### 프록시 구성

모든 프록시 설정은 환경 변수를 통해 제어됩니다. 프록시 서버를 시작하기 전에 설정하세요.

| 변수 | 기본값 | 설명 |
|---|---|---|
| `CACHE_FIX_PROXY_PORT` | `9801` | 수신 포트 |
| `CACHE_FIX_PROXY_BIND` | `127.0.0.1` | 바인딩 주소 |
| `CACHE_FIX_PROXY_UPSTREAM` | `https://api.anthropic.com` | 상류 URL. 다른 프록시를 체인하려면 변경 (예: `http://localhost:8080`) |
| `CACHE_FIX_FORWARD_PROXY` | 설정되지 않음 | 전방 프록시 모드(HTTPS CONNECT + 상류 호스트 선택적 MITM)를 활성화하려면 `on`으로 설정하여 클라이언트가 `ANTHROPIC_BASE_URL` 대신 `HTTPS_PROXY`를 가리키게 하여 원격 제어를 유지합니다. [전방 프록시 모드](#forward-proxy-mode-keeps-remote-control-working) 참조. |
| `CACHE_FIX_CA_DIR` | `~/.claude/cache-fix-ca` | 전방 프록시 CA/리프 인증서 디렉토리 (첫 시작 시 한 번 생성). 클라이언트는 `NODE_EXTRA_CA_CERTS`를 통해 `ca.pem`을 신뢰합니다. |
| `CACHE_FIX_PROXY_TIMEOUT` | `600000` | 요청 시간 초과(밀리초) |
| `CACHE_FIX_EXTENSIONS_DIR` | `proxy/extensions/` | 확장 `.mjs` 파일 디렉토리 |
| `CACHE_FIX_EXTENSIONS_CONFIG` | `proxy/extensions.json` | 확장 구성 파일 |
| `CACHE_FIX_DEBUG` | `0` | 디버그 로깅 활성화 |
| `CACHE_FIX_HOT_RELOAD` | 설정되지 않음 | 프로세스 내 확장 핫리로드를 활성화하려면 `on`으로 설정. v4.0.0부터 기본적으로 꺼져 있습니다 — 자세한 내용과 관리자 재시작 흐름은 [v3.x 업그레이드](#upgrading-from-v3x) 참조. |
| `CACHE_FIX_READ_DEDUPE` | 설정되지 않음 | 반복되는 `Read` 도구 결과를 중복 제거하려면 `1`로 설정합니다. 이는 턴 간에 변경되지 않은 재등장한 결과입니다. 첫 번째 발생은 유지하고, 이후 동일한 바이트(키: `file_path` + 내용 + `offset` + `limit`)를 안정적인 포인터 라인으로 대체합니다. 기본적으로 꺼져 있으며, 보다 넓게 확산하기 전에 세션별로 선택적으로 활성화합니다. [확장 영향 가이드](docs/extension-impact-guide.md) 참조. |
| `CACHE_FIX_ADVISOR_PLAN` | 설정되지 않음 | `tools/tier-advisor.mjs`의 계획 재정의 — `max-5x`, `max-20x`, `pro` 중 하나. 휴리스틱 계획 감지를 우회합니다. [계층 어드바이저](docs/tier-advisor.md) 참조. |
| `CACHE_FIX_ADVISOR_UPGRADE_THRESHOLD` | `80` | 계층 어드바이저가 업그레이드 권고를 트리거하는 예상 Q7d 백분율입니다. |
| `CACHE_FIX_ADVISOR_DOWNGRADE_THRESHOLD` | `20` | 계층 어드바이저가 다운그레이드 권고를 트리거하는 예상 Q7d 백분율 (연속 주 수준과 함께 사용). |
| `CACHE_FIX_ADVISOR_DOWNGRADE_WEEKS` | `2` | 계층 어드바이저가 다운그레이드 권고를 하기 전에 연속적으로 낮은 임계값 아래의 주 수입니다. 단일 주 감소는 트리거되지 않으며, 단일 주 피크는 업그레이드를 트리거합니다 (비용 비대칭성). |

### 기업 환경 (프록시, 사용자 CA)

프록시는 `api.anthropic.com`으로 전달할 때 다음 환경 변수를 존중합니다. Zscaler / Netskope / Forcepoint / Bluecoat / 기업 squid 뒤에서는 프록시의 환경에서 이 변수들을 설정하세요.

| 변수 | 효과 |
|---|---|
| `HTTPS_PROXY` / `HTTP_PROXY` (소문자 버전 포함) | 기업 HTTP CONNECT 프록시를 통해 상류 요청을 라우팅합니다. |
| `NO_PROXY` | 프록시를 우회할 호스트 목록(쉼표로 구분). `*` 및 `.suffix.example.com` 지원. |
| `CACHE_FIX_PROXY_CA_FILE` | 하나 이상의 추가 CA 인증서가 포함된 PEM 파일 경로 (SSL 검사 프록시용). |
| `NODE_EXTRA_CA_CERTS` | 표준 Node 메커니즘 — 동일하게 존중됩니다. |
| `CACHE_FIX_PROXY_REJECT_UNAUTHORIZED=0` | **불안전한 도망구.** TLS 검증을 비활성화합니다. IT가 기업 CA 번들을 제공할 때까지 마지막 수단으로 사용하세요. |

예제 (Windows PowerShell):

```powershell
$env:HTTPS_PROXY = 'http://proxy.corp.example:8080'
$env:NO_PROXY    = 'localhost,127.0.0.1,.corp.example'
$env:CACHE_FIX_PROXY_CA_FILE = 'C:\corp\zscaler-root.pem'
node "$(npm root -g)\claude-code-cache-fix\proxy\server.mjs"
```

첫 요청 시 stderr는 `[upstream] using proxy http://proxy.corp.example:8080 ...`를 출력합니다. 프록시/CA 환경 변수가 설정되지 않으면 이전 버전과 동일한 동작(기본 Node 에이전트, 시스템 신뢰 저장소)입니다.

### 자신의 프로세스에 프록시 통합

Node 또는 Bun 바이너리를 배포하여 캐시-픽스 프록시를 프로세스 내에서 실행하려는 경우 (예: Node 자식 프로세스를 포크하지 않는 Bun 컴파일된 에이전트), `claude-code-cache-fix/proxy/server`에서 팩토리를 가져오세요:

```js
import { startProxy } from "claude-code-cache-fix/proxy/server";

const handle = await startProxy({
  port: 0,        // OS 할당 임시 포트; 숫자를 전달하여 포트 고정
  bind: "127.0.0.1",
  watch: false,   // fs.watch 건너뛰기 — 컴파일된 바이너리에 권장됨
});

console.log(`proxy listening on ${handle.address}:${handle.port}`);

// ...나중에...
await handle.close();
```

**`createProxyServer()` → `http.Server`**는 `http.Server`에 연결된 요청 처리기를 빌드합니다. 반환된 서버는 *리스닝되지 않으며* 확장 파이프라인도 로드되지 않았습니다 — 생명주기를 직접 관리하려는 경우 사용하세요.

**`startProxy(options?)` → `Promise<{ server, port, address, close }>`**는 확장 파이프라인을 로드하고 선택적으로 파일 감시자를 시작하며 리스닝을 시작합니다. 바인딩된 포트(요청 시 `port: 0`로 해결됨)와 서버 및 감시자 해제를 위한 `close()` 메서드를 포함한 핸들을 반환합니다.

옵션 (모두 선택적; CLI에서 사용되는 동일한 환경 변수로 폴백):

| 옵션 | 기본값 | 효과 |
|---|---|---|
| `port` | `CACHE_FIX_PROXY_PORT` 환경 변수, 그렇지 않으면 `9801` | 수신 포트. OS가 할당한 임시 포트를 사용하려면 `0`을 전달합니다. |
| `bind` | `CACHE_FIX_PROXY_BIND` 환경 변수, 그렇지 않으면 `127.0.0.1` | 바인딩 주소. |
| `extensionsDir` | 패키지의 `proxy/extensions/` | `.mjs` 확장을 로드할 디렉토리. |
| `extensionsConfig` | 패키지의 `proxy/extensions.json` | 확장 구성 파일 경로. |
| `watch` | `true` | 확장 구성에 대해 `fs.watch`를 시작할지 여부. 통합/컴파일된 바이너리 사용 시 `false`로 설정합니다. |

**프로세스당 하나의 확장 레지스트리.** 파이프라인은 모듈 범위에서 공유 확장 레지스트리를 유지합니다. 동일한 프로세스에서 두 개의 `startProxy()` 인스턴스를 호스팅하는 것은 지원되지만(다른 포트, 다른 바인딩 주소), 이들은 해당 레지스트리를 공유합니다 — 후속 `loadExtensions` 호출은 두 인스턴스 모두에 대해 교체합니다. 인스턴스별로 다른 확장 구성을 원하는 경우 별도의 프로세스에서 실행하세요.

**CLI 호출 방식은 변경되지 않았습니다.** `node proxy/server.mjs`, `cache-fix-proxy server` 및 래퍼의 자식 포크 경로는 모두 자동으로 리스닝하고 SIGTERM/SIGINT 핸들러를 설치합니다. 라이브러리 가져오기는 이 동작을 트리거하지 않습니다 — 자동 리스닝은 메인 모듈 체크에 의해 보호됩니다.

*임베디드 팩토리는 [Crunchloop DAP](https://dap.crunchloop.ai)의 [@bilby91](https://github.com/bilby91)에 의해 기여되었습니다 — [PR #123](https://github.com/cnighswonger/claude-code-cache-fix/pull/123) 참조.*

## v3.x에서 업그레이드

**v4.0.0의 동작 변경:**

- **`thinking-block-sanitize` v1은 이제 기본적으로 켜져 있습니다.** v3.8.0–v3.9.x에서는 `CACHE_FIX_THINKING_SANITIZE=on`을 통해 선택적이었습니다. 37개 세션에서 일주일간의 프로덕션 강아지 테스트 후(0개 `cannot be modified` 400, 캐시 히트율 평균 94.66% vs 베이스라인 92.44%, ~35% 세션에서 정화 발생, 하루당 약 800개 블록 제거, 최대 938K 컨텍스트 건강) v1 완화는 새로운 기본값입니다. `CACHE_FIX_THINKING_SANITIZE=off`로 명시적으로 비활성화합니다. v2(추가 도구 해시 불일치 제거)는 `=v2`를 통해 선택적입니다. [#63147](https://github.com/anthropics/claude-code/issues/63147) 및 [#162](https://github.com/cnighswonger/claude-code-cache-fix/issues/162) 참조.
- **프로세스 내 확장 핫리로드는 이제 기본적으로 꺼져 있습니다.** v3.x에서는 켜져 있었습니다. 이전 동작을 복원하려면 `CACHE_FIX_HOT_RELOAD=on`으로 설정하세요. 기본적으로 꺼짐은 [#196](https://github.com/cnighswonger/claude-code-cache-fix/issues/196)에 문서화된 Node ESM 스테일 임포트 경쟁을 제거합니다. 이 경쟁은 핫리로드 트리거 후 17시간 동안 새로 병합된 확장을 로드하지 못하는 문제가 발생합니다. 파일 감시자가 핫리로드 후 확장의 전이 종속성이 이미 Node 로더에 캐시되었을 때 발생합니다; 냉 시작은 영향을 받지 않습니다.

### 통합자 참고 (Bun 호스트, `createProxyServer()` / `startProxy()`를 사용한 DAP 스타일 통합)

v4.0.0은 `CACHE_FIX_THINKING_SANITIZE`를 기본적으로 꺼진 상태에서 켜는 것으로 변경합니다. v1 빈 텍스트 제거는 모든 요청 본문을 통과하는 동안 실행됩니다. 호스트가 이전의 정화되지 않은 동작에 의존하는 경우(예: 하위 코드가 빈 `thinking` 블록이 순환 후 살아남기를 기대하는 경우), 다음 방법으로 이를 유지하세요:

- 호스트 환경에서 `CACHE_FIX_THINKING_SANITIZE=off`를 설정하거나,
- 코드에서 요청 처리 전에 `process.env.CACHE_FIX_THINKING_SANITIZE = "off"`를 설정합니다 — 모드는 `modeFromEnv()`를 통해 요청별로 읽으며, 모듈 로드 시 캐시되지 않습니다.

이 변경은 7일간의 프로덕션 강아지 테스트(37개 세션, 0개 `cannot be modified` 400, 캐시 히트율 평균 94.66% vs 92.44% 베이스라인)를 기반으로 합니다. [PR #201](https://github.com/cnighswonger/claude-code-cache-fix/pull/201)에서 유효성 데이터와 [#63147](https://github.com/anthropics/claude-code/issues/63147)의 상류 컨텍스트를 참조하세요.

v4.0.0에서 새 확장을 추가하거나 기존 확장에 코드 변경을 적용하려면 관리자 수준의 프록시 재시작이 필요합니다. 핫리로드를 다시 활성화하려는 경우에 따라 두 가지 업그레이드 흐름이 있습니다.

### 흐름 1 — 코드 전용 npm 업그레이드 (권장 기본값)

기존 systemd 유닛 / launchd plist는 변경되지 않으며, 디스크의 프록시 코드만 npm으로 업데이트됩니다. 새 코드를 가져오려면 실행 중인 프로세스를 재시작하세요.

**Linux (systemd 사용자 유닛):**

```
npm install -g claude-code-cache-fix@4
systemctl --user restart cache-fix-proxy
```

`daemon-reload`는 필요하지 않으며, 유닛 파일 내용은 변경되지 않았습니다.

**macOS (launchd 사용자 에이전트):**

```
npm install -g claude-code-cache-fix@4
launchctl kickstart gui/$(id -u)/com.cnighswonger.cache-fix-proxy
```

`kickstart`는 기존 plist 하위에서 에이전트를 다시 실행합니다.

### 흐름 2 — 관리자 레벨에서 핫리로드 재활성화

핫리로드를 활성화하는 경우(예: 사용 중인 프록시에 사용자 확장을 확장 디렉토리에 배치하고 재시작 없이 선택하려는 경우), 다음 작업을 실행하세요. 이 작업은 유닛 / plist를 재작성하여 관리자가 프록시를 시작할 때마다 `CACHE_FIX_HOT_RELOAD=on`이 설정되도록 합니다.

**Linux (systemd 사용자 유닛):**

```
CACHE_FIX_HOT_RELOAD=on cache-fix-proxy install-service
systemctl --user daemon-reload
systemctl --user restart cache-fix-proxy
```

유닛 파일 내용이 변경되었으므로 `daemon-reload`가 필요합니다.

**macOS (launchd 사용자 에이전트):**

```
CACHE_FIX_HOT_RELOAD=on cache-fix-proxy install-service
launchctl bootout gui/$(id -u)/com.cnighswonger.cache-fix-proxy
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.cnighswonger.cache-fix-proxy.plist
launchctl kickstart gui/$(id -u)/com.cnighswonger.cache-fix-proxy
```

plist 내용이 변경되었으므로 `bootout` + `bootstrap`이 필요합니다 — `kickstart`만으로는 plist 변경사항을 인식하지 못합니다.

**핫리로드 트레이드오프에 대한 참고:** 선택 경로에서도 장시간 실행 프로세스에서는 ESM 스테일 임포트 경쟁이 발생할 수 있습니다. `/health`가 저하된 경우(503 + `{status:"degraded",...}` 반환) 유일한 복구 방법은 프로세스 재시작이며, 프록시는 이때 `[CRITICAL]` 힌트를 기록합니다. 관측성 계층은 [#197](https://github.com/cnighswonger/claude-code-cache-fix/pull/197)에서 확인하세요.

## 이 프록시가 방어하는 내용

**캐시 경제 회귀.** cache-fix의 원래 목적은 Claude Code에서 사용자에게 실제 돈과 할당량을 소모시키는 캐시 처리 행동을 흡수하는 것입니다 — TTL 다운그레이드, 캐시 파괴 헤더 진동, ID 락 문제 및 이슈 기록에 문서화된 다른 회귀 카탈로그. 프록시는 CC와 Anthropic API 사이에 위치하며 요청 및 응답 스트림을 정규화하고 충분한 관측성(상태줄 통합 및 quota-status 파일)을 내보내어 사용자가 세션이 실제로 무엇을 하고 있는지 볼 수 있도록 합니다. 이는 오늘날 거의 모든 사용자에게 핵심 기능입니다.

**부트스트랩 채널 관측성.** Claude Code v2.1.150은 `/api/claude_cli/bootstrap`에서 서버 제공 문자열을 가져와 에이전트의 행동 지시 프롬프트 경로에 병합하는 프롬프트 섹션 소비자를 도입했습니다. 2026년 5월에 Anthropic 보안 팀에 이 동작을 제출했습니다; Anthropic은 *정보적*으로 종료하고 TLS를 전송 무결성 경계로 간주하며 응용 계층 인증 검사를 추가하지 않기로 결정했습니다. cache-fix는 v3.7.0에서 이 경로에 대해 명시적 처리를 제공했고, v3.7.1에서는 CC v2.1.152에 도입된 환경 변수 선택된 GrowthBook 프롬프트 주입 표면(원격 제어 모드: `CLAUDE_CODE_SYSTEM_PROMPT_GB_FEATURE`는 플래그 키를 명명하고 캐시된 값은 시스템 프롬프트 본문으로 사용됨)도 포함하여 확장했습니다.

cache-fix의 `bootstrap-defense` 확장은 `CACHE_FIX_BOOTSTRAP_MODE`를 통해 선택할 수 있는 세 가지 모드를 제공합니다:

| 모드 | 기본? | 동작 |
|---|---|---|
| `audit` | 예 | 부트스트랩 응답은 CC로 프록시 전달됩니다. 각 응답은 `~/.claude/cache-fix-bootstrap-log.jsonl`에 기록되며 표면 메타데이터를 포함합니다: 어떤 프롬프트 소스 표면이 트리거되었는지(`tengu_heron_brook` 레거시 및/또는 환경 변수 선택), 값의 SHA-256 해시(처음 16진수 문자 — 절대 값 자체가 아님), `CLAUDE_CODE_REMOTE` 플래그. 다중 표면 응답은 `request_id` + 타임스탬프 창으로 연관된 표면당 하나의 레코드를 출력합니다. |
| `block` | 선택적 | `onRequest`는 빈 JSON 본문과 200을 반환합니다. 상류는 절대 호출되지 않으며, 플래그 맵은 절대 디스크에 있는 GrowthBook 캐시에 도달하지 않습니다. 레거시 및 환경 변수 선택된 주입 표면 모두를 방어합니다. |
| `allowlist` | 선택적(실험적) | 부트스트랩 응답은 프록시 전달되지만, 허용 목록에 없는 프롬프트 소스 키(`tengu_heron_brook` 레거시 + 환경 변수 선택된 키)는 CC에 도달하기 전에 응답 본문에서 제거됩니다. 기본 허용 목록은 `tengu_heron_brook`(유일하게 알려진 역사적 합법적 키)입니다; `CACHE_FIX_BOOTSTRAP_ALLOWED_KEYS=comma,separated,list`로 구성합니다. 완전히 거부하려면 `CACHE_FIX_BOOTSTRAP_ALLOWED_KEYS=`(명시적 빈 값)를 전달합니다. 다른 GrowthBook 플래그 키는 그대로 통과합니다. 향후 CC 릴리스에서 합법적인 프롬프트 소스 키가 추가될 경우 업데이트가 필요할 수 있습니다. |

참고: cache-fix v3.6.2 및 이전 버전은 부트스트랩 경로에 대해 404를 반환했습니다. 프록시 라우터가 포함하지 않았기 때문입니다 — 실질적으로는 cache-fix 사용자의 CC에 부트스트랩 콘텐츠가 도달하지 않았습니다. v3.7.0의 기본 `audit`는 그 동작을 변경했으며, 명시적 `CACHE_FIX_BOOTSTRAP_MODE=block`은 이 동작을 유지합니다. 전체 공개 기록(Anthropic의 자세한 종료 텍스트 포함)은 [`docs/disclosure/heron-brook-2026-05.md`](docs/disclosure/heron-brook-2026-05.md)에 있습니다.

**참고 자료:**
- [`docs/disclosure/heron-brook-2026-05.md`](docs/disclosure/heron-brook-2026-05.md) — 전체 공개 기록
- [`CHANGELOG.md`](CHANGELOG.md#371---2026-05-27) — v3.7.1 릴리스 항목 (확장 표면 커버리지 + 허용 목록 모드); [v3.7.0 항목](CHANGELOG.md#370---2026-05-26)은 이전 동작 변경 노트를 다룹니다
- [`cnighswonger/heron-brook-poc`](https://github.com/cnighswonger/heron-brook-poc) — 부트스트랩 채널 동작 재현기

**자동 1M 컨텍스트 과도 보호.** CC v2.1.161 이상(특히 VS Code 확장 표면)은 사용자 요청 없이 자동으로 1M 컨텍스트를 선택할 수 있으며, 즉시 과도 크레딧을 소모합니다. 프록시의 `auto-1m-guard` 확장은 출발 `anthropic-beta` 헤더에서 `context-1m-2025-08-07` 토큰을 감지하고, `CACHE_FIX_AUTO_1M_GUARD`를 통해 선택한 모드에 따라 경고하거나 제거합니다:

| 모드 | 기본? | 동작 |
|---|---|---|
| `off` | 아니요 | 확장은 무작위입니다. |
| `warn` | 예 | 토큰을 감지합니다. 각 세션 JSON(`auto_1m_detected`, `auto_1m_action: "warn"`, `auto_1m_advice`)에 주석을 저장하고 stderr 로그 라인을 출력합니다. 이 라인은 프로세스 수명 동안 최초 감지 1회로 고정됩니다(조언 문구는 변하지 않으며, 확장 리로드로 재무장되지 않습니다). 요청을 수정하지 않습니다. |
| `strip` | 선택적 | 전송 전 토큰을 감지하고 `anthropic-beta` 헤더에서 제거합니다. 주석: `auto_1m_action: "stripped"`. |

CC 측 종료 스위치는 `CLAUDE_CODE_DISABLE_1M_CONTEXT=1`(환경 변수)이며, CC 프로세스에 실제로 도달했을 때 올바른 수정입니다. VS Code 확장 표면에서는 이 환경 변수가 신뢰할 수 없다고 보고됩니다; 프록시 인터셉트는 요청을 생성한 어떤 CC 래퍼든 작동하므로 간격을 우회합니다. [CC#64919](https://github.com/anthropics/claude-code/issues/64919) 추적; [`docs/directives/proxy-auto-1m-guard.md`](docs/directives/proxy-auto-1m-guard.md)에서 프록시 가시 신호가 베타 헤더(예: CC는 `req.body.model` 클라이언트 측에서 `[1m]` 접미사를 제거하기 전에 보냅니다)임을 확인하는 바이너리 워크를 참조하세요.

## 클라이언트 훅

일부 Claude Code 동작은 요청 계층 아래에 있습니다 — 이들은 프록시가 트래픽을 볼 수 있는 이전에 도구 배포 경로에서 발생합니다. cache-fix는 [`hooks/examples/`](hooks/README.md) 하위에 독립적인 훅 스크립트를 제공하여 이러한 경우를 처리합니다. 이들은 프록시와 독립적이며, 자체 `~/.claude/settings.json`을 가리키는 방식으로 설치합니다.

| 스크립트 | 동작 |
|---|---|
| [`worktree-edit-guard.py`](docs/hooks/worktree-edit-guard.md) | 활성 git 워크트리에서 벗어나는 `Edit`/`Write`/`MultiEdit`/`NotebookEdit` 도구 호출을 차단하여 워크트리 세션의 부모 체크 손상 방지. [CC#59628](https://github.com/anthropics/claude-code/issues/59628) 해결 |

## 기여된 도구

프록시 확장이나 CC 훅이 아닌 독립적인 스크립트 — 별도로 설치 가능하며 특정 상류 문제를 해결합니다.

| 도구 | 동작 |
|---|---|
| [`tools/gh-auth-status-shim/`](tools/gh-auth-status-shim/README.md) | PATH 확인된 `gh` 래퍼로 CC Desktop의 거짓 "GitHub CLI 인증 만료" 토스트를 억제합니다. [CC#67055](https://github.com/anthropics/claude-code/issues/67055) 해결: CC Desktop의 PR 폴러는 `gh auth status`의 모든 0이 아닌 반환(포함된 5초 스파인 타임아웃)을 `"auth"` 토스트 카테고리로 매핑합니다. 이 쉬미는 `gh auth status` 호출을 4초 내부 타임아웃으로 가로채고 결과를 분류하며, 거짓 타임아웃 신호를 억제하기 위해 종료 코드 0을 반환하여 진짜 만료(`not logged in`, `HTTP 401`)는 정상적으로 전달합니다. Anthropic의 분류자 수정이 릴리스될 때까지의 대안. **알려진 제한:** PATH 범위 내 모든 호출자의 `gh auth status` 종료 코드 의미(단지 CC가 아님); macOS 커버리지는 launchd PATH 상속으로 인해 확인되지 않음; 네이티브 Windows CC Desktop은 지원되지 않음. |

## 권장 CC 운영 구성

프록시는 요청 계층에서 해결할 수 있는 것을 해결합니다. 몇 가지 CC 클라이언트 측 환경 변수와 `~/.claude/settings.json` 스위치는 프록시가 도달하지 못하는 인접 문제를 해결합니다 — CC 업데이트 시 조용한 모델 교체, 모호한 모델 폴백, 스키마 제거 부작용. 이들을 권장 사항으로 표시하며, 사용자는 자신의 구성을 결정합니다.

이 발견은 [@fgrosswig](https://github.com/fgrosswig)의 CC v2.1.91 바이너리 분석에서 나왔습니다. 방법론은 공개 PowerShell + ASCII 문자열 추출이며, 그는 결과 목록을 친절하게 개인적으로 공유했습니다.

### 제안된 `~/.claude/settings.json` env 블록

아래 모델 ID는 예시입니다 — 선호하는 주요 및 빠른 소형 모델로 대체하세요. 핵심은 *어떤 것*을 명확히 고정하는 것이 CC의 기본값에 의존하는 것보다 좋습니다.

```json
{
  "env": {
    "CLAUDE_CODE_DISABLE_LEGACY_MODEL_REMAP": "1",
    "ANTHROPIC_MODEL": "claude-opus-4-7",
    "ANTHROPIC_SMALL_FAST_MODEL": "claude-haiku-4-5-20251001"
  }
}
```

**`CLAUDE_CODE_DISABLE_LEGACY_MODEL_REMAP=1`** — 가장 영향력 있는 플래그입니다. CC에는 특정 버전 업데이트 후 사용자가 고정한 모델을 다른 모델로 조용히 재매핑하는 레거시 코드 경로가 있습니다. `1`로 설정하면 재매핑이 비활성화되며, 고정한 모델은 그대로 사용됩니다. (고정하지 않으면 CC의 기본값이 적용됩니다.)

**`ANTHROPIC_MODEL`** — 주요 모델을 고정합니다. 이 것을 명확하게 유지하면 CC 버전 업데이트 시 캐시 접두사 해시가 안정적으로 유지되며, 그렇지 않으면 기본값이 변경됩니다. 실제로 사용할 모델로 조정하세요.

**`ANTHROPIC_SMALL_FAST_MODEL`** — 짧은 보조 호출(예: 제목 생성, 분류)에 CC가 사용하는 측면 "빠른" 모델을 고정합니다. 명시적 고정이 없으면 업데이트 시 다른 패밀리로 조용히 폴백될 수 있습니다.

### `autoCompactWindow=1000000` 주의사항

다른 곳에서 추천된 설정을 본 경우: 이 설정은 활성 모델이 1M 컨텍스트를 충족할 때만 작동합니다(현재 `claude-sonnet-4-6` 또는 적절한 베타 헤더가 있는 `claude-opus-4-6`). 이러한 전제 조건이 없으면 하드코딩된 200K로 제한됩니다. 설정과 관계없이.

### `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` 스키마 제거 부작용

이 플래그를 설정하면 CC는 출발 요청에서 `["name", "description", "input_schema", "cache_control"]` 범위 외의 도구 필드를 제거합니다. `defer_loading` 또는 `eager_input_streaming`에 의존하는 사용자 정의 도구는 이러한 필드를 조용히 잃고 다른 동작을 하게 됩니다. 플래그를 켜기 전에 알아두면 좋습니다.

## 캐시 비용에 영향을 주는 알려진 CC 동작

이것들은 cache-fix가 패치하는 버그가 아닙니다 — 사용자가 세션 비용을 추정할 때 알아야 할 상류 CC 동작입니다.

### 진단 슬래시 명령어가 대화 기록을 확장합니다 ([#49335](https://github.com/anthropics/claude-code/issues/49335))

`/context`, `/release-notes`(그리고 아마도 다른 상태 검사 명령어)를 실행하면 진단 출력이 터미널에 렌더링하는 것이 아니라 대화 기록에 추가됩니다. 후속 턴은 프롬프트 캐시를 통해 팽창된 부하를 재생하고, 상태 검사 작업의 토큰 비용을 증가시킵니다. v2.1.148에서 단일 `/context` 호출은 +3,480 `cache_creation_input_tokens`로 측정되었습니다; 다른 사용자는 별도 세션에서 약 5K를 보고했습니다. `/release-notes`는 더 나쁩니다 — 기본적으로 전체 변경 로그를 덤프합니다.

진단이 더 나쁩니다: 캐시에 부과되는 팽창된 부하는 로컬 JSONL 트랜스크립트에 기록되지 않으므로, 비용 원천을 현지에서 감사할 수 없습니다 — 응답 사용 메타데이터의 `cache_creation_input_tokens` 점프에서만 추론할 수 있습니다. (프록시 모드 사용자는 응답 헤더에서 직접 쓴 `~/.claude/quota-status/` 파일의 델타를 검사할 수 있습니다.)

**상류 수정 전까지의 대안:** 장시간 세션에서는 이 명령어를 자주 사용하지 마세요. 세션에서 자주 사용해야 하는 경우 진단 실행 후 `/compact`를 사용하여 누출을 재설정하세요.

## 빠른 시작: 사전 로드 (CC v2.1.112 및 이전 버전)

Node.js 기반 CC 버전(v2.1.112 또는 이전)을 사용하는 경우, 사전 로드 인터셉터는 프록시 없이 작동합니다:

```bash
npm install -g claude-code-cache-fix
NODE_OPTIONS="--import claude-code-cache-fix" claude
```

> **참고:** 사전 로드는 CC v2.1.113+(Bun 바이너리)에서는 작동하지 않습니다. 위의 프록시를 사용하세요.

래퍼 스크립트, 셸 별칭, Windows 지침 및 VS Code 사전 로드 모드 통합은 [docs/preload-setup.md](docs/preload-setup.md) 참조.

## VS Code 확장

[VS Code 확장](https://github.com/cnighswonger/claude-code-cache-fix-vscode) (v0.5.0)은 프록시 및 사전 로드 모드를 모두 지원합니다:

**프록시 모드(권장):**
1. 프록시 시작 (위 참조)
2. VS Code 명령 팔레트에서: **Claude Code Cache Fix: Enable Proxy Mode**
3. 활성 Claude Code 세션 재시작

**사전 로드 모드(CC ≤v2.1.112):**
1. `npm install -g claude-code-cache-fix`
2. [GitHub Releases](https://github.com/cnighswonger/claude-code-cache-fix-vscode/releases/latest)에서 VSIX 다운로드
3. 설치: `code --install-extension claude-code-cache-fix-0.5.0.vsix`
4. 명령 팔레트: **Claude Code Cache Fix: Enable**

VSIX 없이 수동 VS Code 래퍼 설정의 경우, [docs/preload-setup.md](docs/preload-setup.md#vs-code-preload-mode) 참조.

## 보안 모델

> **프록시와 인터셉터는 API 요청 및 응답에 대한 완전한 읽기/쓰기 접근 권한을 갖습니다.** 이는 해당 방법의 본질적인 것입니다 — 모든 fetch 인터셉터, 프록시 또는 게이트웨이가 이 위치를 갖습니다.

**무엇을 하는가:** 캐시 버그를 수정하기 위해 출발 요청 구조(블록 순서, 지문, TTL, git-상태)를 수정합니다. 모니터링을 위해 응답 헤더 및 SSE 사용 데이터를 읽습니다.

**무엇을 하지 않는가:** 프록시 또는 인터셉터는 네트워크 호출을 하지 않습니다. 모든 원격 측정은 `~/.claude/` 아래 로컬 파일에 기록됩니다. 데이터는 귀하의 머신에서 나가지 않습니다.

**공급망:** 프록시 모드: `proxy/extensions/`에 있는 작은 집중 확장 모듈(대부분 수백 줄 이내; 파이프라인은 구성 가능하여 단일 항목을 독립적으로 읽을 수 있음). 사전 로드 모드: 단일 비압축 파일(`preload.mjs`). 개발 종속성 하나(`zod`는 테스트에서만 스키마 유효성 검사용). 설치 전 검토하세요. 게시된 빌드는 npm의 기본 레지스트리 서명을 포함합니다; sigstore 원천 증명은 현재 게시되지 않았습니다 — 후속 작업으로 추적됩니다.

**독립적 감사:** [@TheAuditorTool](https://github.com/anthropics/claude-code/issues/38335#issuecomment-4244413605)에 의해 [“합법적인 도구”로 평가됨](https://github.com/anthropics/claude-code/issues/38335#issuecomment-4244413605) (2026-04-14).

## 문제

Claude Code에서 `--resume` 또는 `/resume`를 사용할 때 프롬프트 캐시가 조용히 깨집니다. 캐시된 토큰을 읽는 대신(비용이 적은), API는 모든 턴에서 처음부터 재구성합니다(비용이 많이 드는). ~$0.50/시간이어야 하는 세션이 아무런 표시 없이 $5–10/시간을 소모할 수 있습니다.

세 가지 버그가 이 문제를 초래합니다:

1. **부분 블록 산란** — 첨부 블록(스킬 목록, MCP 서버, 지연 도구, 훅)은 `messages[0]`에 있어야 합니다. 재개 시 일부 또는 모든 것이 후속 메시지로 이동하여 캐시 접두사를 변경합니다.

2. **지문 불안정성** — `cc_version` 지문(예: `2.1.92.a3f`)은 `messages[0]` 내용에서 계산되며, 메타/첨부 블록을 포함합니다. 이러한 블록이 이동하면 지문이 변경되고 시스템 프롬프트가 변경되어 캐시가 깨집니다.

3. **비결정론적 도구 정렬** — 도구 정의는 턴 간에 다른 순서로 도착하여 요청 바이트를 변경하고 캐시 키를 무효화합니다.

또한, Read 도구를 통해 읽은 이미지는 대화 기록에서 base64로 지속되며 모든 후속 API 호출에서 전송되어 토큰 비용을 조용히 증가시킵니다.

## 작동 방식

**프록시 모드**(v3.0.0+): `localhost:9801`에서 HTTP 서버는 `POST /v1/messages` 요청을 가로챕니다. 확장 모듈 파이프라인은 각 요청을 처리합니다 — 블록 순서 정규화, 지문 제거, 도구 정렬 안정화, TTL 마커 관리, thinking 블록 정화, 원격 측정 기록 등. 확장은 `proxy/extensions.json`에 구성된 `.mjs` 파일로 `proxy/extensions/`에 위치하며, 프록시 시작 시 한 번만 로드됩니다(핫리로드는 v4.0.0부터 선택적입니다 — [v3.x 업그레이드](#upgrading-from-v3x) 참조). 다른 모든 트래픽은 그대로 통과합니다.

**사전 로드 모드**(v2.x): Claude Code가 API 호출하기 전에 `globalThis.fetch`를 패치하는 Node.js `--import` 모듈입니다. 동일한 수정을 인라인으로 적용합니다 — 사용자 메시지에서 재배치된 블록을 스캔하고, 도구를 정렬하며, 지문을 재계산하고, TTL 마커를 주입합니다.

두 모드 모두 멱등성입니다 — 수정이 필요하지 않으면 요청은 수정되지 않고 통과됩니다. 두 모드 모두 대화 내용을 수정하지 않습니다; API에 도달하기 전에 요청 구조만 정규화합니다.

## 수정에서 벗어나기

패키지는 서로 다른 생명주기를 가진 세 가지 목적을 제공합니다:

| 목적 | 예시 | 비활성화 시기 |
|---|---|---|
| **버그 수정** | 블록 재배치, 지문, 도구 정렬, TTL | CC가 기본 버그를 수정했을 때 — 건강 라인 확인 |
| **모니터링** | 할당량 추적, 마이크로 컴팩트 감지, GrowthBook 플래그 | 영원히 유지 — 이러한 감지는 향후 회귀 감지 |
| **최적화** | 이미지 제거, 출력 효율성 재작성 | 워크플로우에 도움이 되는 동안 유지 |

### 건강 상태(사전 로드 모드)

첫 번째 API 호출 시 인터셉터는 건강 상태 라인을 기록합니다(`CACHE_FIX_DEBUG=1` 필요):

```
cache-fix health: relocate=active(2h ago) fingerprint=dormant(5 clean sessions) tool_sort=active ttl=active identity=waiting
```

- **active(Xh ago)** — 수정이 최근 적용됨
- **dormant(N clean sessions)** — N 세션 동안 버그가 감지되지 않음; CC가 수정했을 수 있음
- **safety-blocked(Nx)** — 순환 검증 실패; 수정 자동 비활성화
- **waiting** — 수정이 아직 트리거되지 않음

### 회귀 감지

수정을 비활성화한 후 5회 이상 호출에서 캐시 읽기 비율이 50% 미만으로 떨어지는 경우:
```
REGRESSION WARNING: cache_read ratio averaged 12% across last 5 calls.
Fixes are disabled — consider re-enabling to recover cache performance.
```

## 안전성

### 지문 순환 검증

`cc_version` 지문을 재작성하기 전에 인터셉터는 하드코딩된 소금과 문자 인덱스가 Claude Code가 보낸 지문을 재현하는지 확인합니다. 검증이 실패하면(예: CC가 알고리즘을 변경함) 재작성은 자동으로 건너뜁니다. 이는 인터셉터가 절대 원래 CC보다 캐시 성능을 악화시킬 수 없음을 보장합니다.

### 실패 안전 설계

모든 수정은 무작위로 실패하도록 설계되었습니다:
- 블록 감지 정규식이 일치하지 않으면 → 블록이 재배치되지 않음 (CC 동작)
- 지문 형식이 변경되면 → 지문이 재작성되지 않음 (CC 동작)
- 도구 정렬이 변경되지 않으면 → 요청이 그대로 통과
- TTL 주입 대상 구조가 변경되면 → TTL이 주입되지 않음 (CC 동작)

인터셉터는 *도움* 또는 *아무것도 하지 않음*만 할 수 있습니다. 더 나쁘게 만들 수 없습니다.

## 상태줄 — 실시간 할당량 경고

두 모드 모두 매번 API 호출 시 할당량 상태를 기록합니다. 프록시 모드(v3.5.0+)는 `~/.claude/quota-status/account.json`(계정 전역 필드: Q5h/Q7d, 상태, 과도)과 `~/.claude/quota-status/sessions/<id>.json`(세션별 캐시 필드: TTL 레벨, 히트율)으로 분할됩니다. 사전 로드 모드는 기존 `~/.claude/quota-status.json`(단일 세션 구성)을 유지합니다. 포함된 `tools/quota-statusline.sh` 스크립트는 실시간 상태줄을 표시하여 다음을 보여줍니다:

- **Q5h** 할당량 바 `[███░┃░░░░░]` + 백분율 + `(exhaust X, reset Y)`. 채워진 셀은 소모된 할당량입니다; 무거운 수직 틱은 창 내 경과 시간 위치입니다. 채우기 오른쪽의 틱 = 속도 미달; 채우기 내부의 틱 = 시간보다 빠르게 소모(과속). `exhaust`는 현재 소모율에서 100%에 도달하는 예상 시간입니다; `reset`은 창이 롤오버되기 전까지의 벽 시계 시간입니다. `exhaust < reset`인 경우, 창 재설정 전에 100%에 도달합니다 — 속도를 줄이세요.
- **Q7d** 같은 모양이며 일 단위 기간(예: `(exhaust 3d13h, reset 3d0h)`). 하루 미만의 경우, 접미사는 자동으로 `h/m` 형식으로 전환됩니다(예: `(exhaust 1h41m, reset 0h30m)`).
- **TTL 레벨** — 건강할 때는 `TTL:1h`, **서버가 다운그레이드했을 때는 빨간색 `TTL:5m`** (일반적으로 Q5h ≥ 100%에서)
- **주중 피크 시간(13:00–19:00 UTC) 동안 노란색 PEAK**
- **캐시 히트율 %**
- **활성 시 OVERAGE 표시기**
- **제공된 모델 차이 표시기** — 요청된 모델과 제공된 모델이 다를 때([CC#66728](https://github.com/anthropics/claude-code/issues/66728)의 분류자 기반 교환 패턴), 바는 빨간색 `requested → served` 세그먼트를 가지며, 패밀리 인식 히어로가 고정되면 검은색-노란색 `requested → served`가 됩니다. 기본적으로 차이 없음 경로에서는 세그먼트가 나타나지 않습니다. `[1m]` 접미사는 `auto_1m_detected` 설정 시 요청 측에만 표시됩니다.

예제 라인(창 중간, 건강 상태):

```
Q5h [███░┃░░░░░] 30% (exhaust 4h40m, reset 3h00m) | Q7d [█████┃░░░░] 53% (exhaust 3d13h, reset 3d0h) | TTL:1h 98.3%
```

예상이 의미 없는 경우 `(exhaust …, reset …)` 접미사는 부분적으로 삭제됩니다: 0%(새 창) 및 100%(이미 소진)에서는 `reset`만 표시됩니다; 창 시작 후 첫 5분 동안 소모율이 안정적이지 않아 예측할 수 없으므로 Q5h와 Q7d 모두에서 `exhaust`는 그때까지 보류됩니다; 오래된 `resets_at`(서버가 다음 API 호출 갱신 전에 값을 유지)는 둘 다 삭제됩니다.

바는 유니코드 블록 문자(`█┃░`)를 사용합니다 — 대부분의 현대 터미널은 이를 올바르게 렌더링합니다. 터미널이 상자를 대체하거나 대체 글꼴을 사용하는 경우, 유니코드 지원 폰트(DejaVu, Fira, Iosevka, JetBrains Mono 등)를 구성하세요.

### 설치

```bash
mkdir -p ~/.claude/hooks
cp "$(npm root -g)/claude-code-cache-fix/tools/quota-statusline.sh" ~/.claude/hooks/
chmod +x ~/.claude/hooks/quota-statusline.sh
```

`~/.claude/settings.json`에 추가:

```json
{
  "statusLine": {
    "type": "command",
    "command": "~/.claude/hooks/quota-statusline.sh"
  }
}
```

### 상태줄이 중요한 이유

서버가 TTL을 5m으로 다운그레이드하면(100% 이상의 할당량 감지), **5분 이상 유휴 상태일 때마다 전체 컨텍스트 재구성이 발생합니다**. 상태줄 없이는 이는 보이지 않습니다. 상태줄이 있으면 빨간색 `TTL:5m` 경고가 사용자에게 알려줍니다: **작업을 중단하고 Q5h 창이 재설정될 때까지 기다린 후 다시 시작하세요**. 과도를 통과하면 소모가 증가하며, 일시정지로 순환을 깨뜨릴 수 있습니다.

### 권장: git-status 주입 비활성화

Claude Code는 모든 호출 시 실시간 `git status`를 시스템 프롬프트에 주입합니다. 파일 편집은 git 상태를 변경하여 전체 접두사 캐시를 파괴합니다. 이를 비활성화하면 호출당 약 1,800 토큰을 절약할 수 있습니다:

```bash
export CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS=1
```

또는 `~/.claude/settings.json`에 `"includeGitInstructions": false`를 추가합니다. Claude Code는 여전히 Bash 도구를 통해 필요 시 `git status`를 실행할 수 있습니다. 커뮤니티 검증은 [@wadabum](https://github.com/cnighswonger/claude-code-cache-fix/issues/11)에 의해: git 상태 변경 시 캐시 생성 18 토큰(플래그 없이 수천 토큰)입니다.

**왜 이 작업을 프록시 확장으로 제공하지 않습니까:** 프록시는 Claude Code가 시스템 프롬프트를 구성한 후 요청을 가로챕니다 — 이때 변동 가능한 `git status` 텍스트는 이미 이전 턴에서 모델이 의존한 접두사의 일부이며, 이후 제거하면 캐시 자체가 파괴됩니다. 수정은 소스에서 발생해야 합니다. `CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS=1`은 프롬프트 구성 전에 주입을 방지하여 원래 플래그가 적절한 도구입니다. 이후 제거는 모델이 볼 수 있는 컨텍스트를 제거하고 명시적 Bash 호출로 복구할 수 있으며, 어시스턴트 작성 텍스트와의 잘못된 일치 위험도 있습니다.

## 마이그레이션: v3.4.x → v3.5.0+

사용자 정의 상태줄, 모니터링 스크립트 또는 `~/.claude/quota-status.json`을 직접 읽는 모든 것을 작성한 경우 이 섹션이 해당됩니다. v3.5.0은 프록시 모드에서 해당 파일을 분할했으며, 사전 로드 모드는 변경되지 않았습니다.

### 무엇이 변경되었는가

| | v3.4.x 및 이전 (프록시 + 사전 로드) | v3.5.0+ 프록시 모드 | v3.5.0+ 사전 로드 모드 |
|---|---|---|---|
| 할당량 필드(Q5h, Q7d, 상태, 과도) | `~/.claude/quota-status.json` | `~/.claude/quota-status/account.json` | `~/.claude/quota-status.json` (레거시 경로) |
| 캐시 필드(TTL 레벨, 히트율, cache_creation/읽기) | 위 파일과 동일 | `~/.claude/quota-status/sessions/<filename>.json` | 위 파일과 동일 |
| 다중 세션 할당 | 없음 — 마지막 작성자가 승리 | 세션별 파일 | 사전 로드는 단일 세션 구성 |

`<filename>`은 요청의 `x-claude-code-session-id` 헤더를 통해 결정론적 안전 이름 규칙으로 파생됩니다: UUID 및 `[A-Za-z0-9_-]{1,128}`와 일치하는 다른 ID는 통과합니다; null/빈칸/공백은 `unknown`이 됩니다; 그 외에는 `inv-<sha256[:16]>`로 매핑됩니다. 전체 규칙은 [`docs/directives/proxy-quota-status-per-session.md`](docs/directives/proxy-quota-status-per-session.md)에 문서화되어 있습니다.

레거시 `~/.claude/quota-status.json`은 업그레이드 후 첫 번째 프록시 모드 쓰기 시 자동 삭제됩니다. 세션별 파일이 `CACHE_FIX_QUOTA_STATUS_TTL_DAYS`(기본값 `7`)보다 오래된 경우 쓰기 시 정리됩니다.

### 소비자 측 마이그레이션 패턴

스크립트는 먼저 v3.5.0+ 프록시 경로를 시도하고, 없으면 레거시 경로로 폴백해야 합니다. 이렇게 하면 두 모드 모두 작동하며(업그레이드 중인 호스트에서도) 세션 ID는 일반적으로 Claude Code가 상태줄 훅을 호출할 때 stdin에서 가져옵니다; 다른 소비자의 경우, 가장 최근에 수정된 `~/.claude/projects/*/*.jsonl` 파일 이름에서 캡처합니다.

**Bash (상태줄 스타일):**
```bash
QS_DIR="$HOME/.claude/quota-status"
ACCOUNT="$QS_DIR/account.json"
LEGACY="$HOME/.claude/quota-status.json"

# 표준 파일명 규칙 — proxy/extensions/cache-telemetry.mjs와 일치해야 합니다.
# sessionFilename(): trim, then "" → unknown, safe regex passthrough, else
# inv-<sha256-prefix>. 이 없으면 잘못된 또는 공백 ID는 세션별 파일을 놓칩니다.
session_filename() {
  local trimmed
  trimmed="$(printf '%s' "$1" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
  if [ -z "$trimmed" ]; then echo unknown; return; fi
  if printf '%s' "$trimmed" | grep -qE '^[A-Za-z0-9_-]{1,128}$'; then
    printf '%s' "$trimmed"
  else
    # Linux의 sha256sum; macOS의 shasum -a 256. 둘 다 "<hex>  -"를 출력합니다.
    local hash
    if command -v sha256sum >/dev/null 2>&1; then
      hash="$(printf '%s' "$trimmed" | sha256sum)"
    else
      hash="$(printf '%s' "$trimmed" | shasum -a 256)"
    fi
    printf 'inv-%s' "$(printf '%s' "$hash" | cut -c1-16)"
  fi
}

# 세션 ID: CC stdin 우선, 그렇지 않으면 최신 jsonl
sid="$(jq -r '.session_id // empty' 2>/dev/null < /dev/stdin || true)"
if [ -z "$sid" ]; then
  sid="$(ls -t "$HOME"/.claude/projects/*/*.jsonl 2>/dev/null | head -1 | xargs -I{} basename {} .jsonl)"
fi
filename="$(session_filename "$sid")"

# 할당량: account.json (v3.5.0+) → 레거시로 폴백
if [ -f "$ACCOUNT" ]; then
  quota_json="$(cat "$ACCOUNT")"
elif [ -f "$LEGACY" ]; then
  quota_json="$(cat "$LEGACY")"
fi

# 캐시: sessions/<filename>.json (v3.5.0+) → 레거시로 폴백
if [ -f "$QS_DIR/sessions/$filename.json" ]; then
  cache_json="$(cat "$QS_DIR/sessions/$filename.json")"
elif [ -f "$LEGACY" ]; then
  cache_json="$(cat "$LEGACY")"
fi
```

**Node:**
```js
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const home = homedir();
const accountPath = join(home, ".claude", "quota-status", "account.json");
const legacyPath = join(home, ".claude", "quota-status.json");

const SAFE_NAME_RE = /^[A-Za-z0-9_-]{1,128}$/;

// cache-telemetry.mjs sessionFilename()과 동일합니다. 읽기 측 규칙은 쓰기 측 규칙과 일치해야 하며, 그렇지 않으면 잘못된/공백 ID는 세션별 파일을 놓칩니다.
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

배포된 [`tools/quota-statusline.sh`](tools/quota-statusline.sh)는 bash 버전의 참조 구현입니다. [`/coffee` 스킬](https://github.com/cnighswonger/claude-code-coffee) v1.4.0은 세션별 따뜻한 문을 위한 참조입니다.

### 왜 세션별인가요

다중 에이전트 호스트(하나의 프록시를 공유하는 여러 Claude Code 세션)에서 v3.5.0 이전 단일 전역 파일은 각 세션이 응답 시 다른 세션의 캐시 통계를 덮어썼습니다. 세션 A에서 상태줄을 읽는 것은 B가 최근 요청을 보냈을 때 B의 TTL 레벨을 표시합니다. 세션별 파일과 계정 전역 할당량 파일은 이 문제를 해결하지만, 쉬운 계정 범위 뷰는 유지됩니다. 원본 보고서는 [#104](https://github.com/cnighswonger/claude-code-cache-fix/issues/104)에서 확인할 수 있습니다.

### `CLAUDE_CONFIG_DIR`

Claude Code는 `CLAUDE_CONFIG_DIR`를 읽어 기본 `~/.claude`(다른 디렉토리에 여러 독립적 구성 루트를 유지하는 데 사용됨)에서 구성을 이동합니다. 프록시는 이제 **모든** 디스크 상태에 대해 동일한 변수를 존중합니다: `quota-status/`, `usage.jsonl`, `cache-fix-state/`, 세션 미러, 스냅샷 및 OAuth 이벤트는 모두 `$CLAUDE_CONFIG_DIR` 아래에 위치하며, 하드코딩된 `~/.claude`가 아닙니다. 설정되지 않은 경우 프록시는 `~/.claude`를 정확히 이전과 같이 사용합니다(일반적인 단일 구성 경우 변경 없음).

이것은 **하나의 구성 디렉토리당 하나의 프록시**를 실행할 때 중요합니다: 그렇지 않으면 모든 프록시가 `~/.claude/quota-status/account.json`에 쓰고 할당량 상태를 서로 덮어씁니다. 각 프록시에 동일한 `CLAUDE_CONFIG_DIR`를 제공하고, Claude Code 클라이언트가 사용하는 상태는 깨끗하게 분리됩니다.

## 이미지 제거 (사전 로드 모드)

Read 도구를 통해 읽은 이미지는 대화 기록에서 base64로 지속되며, 모든 후속 API 호출과 함께 전송됩니다. 단일 500KB 이미지는 Opus 4.6에서 턴당 약 62,500 토큰을 소모하고, Opus 4.7에서는 새로운 토크나이저로 인해 **85,000+**가 소모됩니다. 4.7에서는 이미지 제거를 강력히 권장합니다.

```bash
export CACHE_FIX_IMAGE_KEEP_LAST=3
```

마지막 3개의 사용자 메시지에서 이미지를 유지하고, 오래된 이미지는 텍스트 자리 표시자로 대체합니다. `tool_result` 블록만 대상입니다 — 사용자가 붙여넣은 이미지는 절대 처리되지 않습니다.

### 과대 이미지 보호 (레거시, v3.2.1)

```bash
export CACHE_FIX_IMAGE_MAX_DIM=2000
```

Anthropic API는 다중 이미지 요청에 대해 두 가지 이미지 관련 제한을 적용하며, 동일한 오류 메시지는 둘 중 하나에서 발생할 수 있습니다:

> `"An image in the conversation exceeds the dimension limit for many-image requests (2000px). Start a new session with fewer images."`

두 가지 압력 축으로 해결합니다:

| 압력 | 변수 | 동작 |
|---|---|---|
| **대화에 너무 많은 이미지** | `CACHE_FIX_IMAGE_KEEP_LAST=N` | 오래된 사용자 메시지에서 이미지를 제거하고 마지막 N개만 유지합니다. |
| **단일 이미지가 너무 큼** | `CACHE_FIX_IMAGE_MAX_DIM=2000` | 차원 제한을 초과하는 이미지를 원본 크기를 기록하는 증거 자리 표시자로 대체합니다. 사용자 메시지 직접 이미지와 tool_result 중첩 이미지를 모두 포함합니다. |

두 가지는 함께 작동합니다: 둘 다 설정되면 `KEEP_LAST`가 먼저 실행됩니다(카운트 감소), 그리고 `MAX_DIM`이 남은 것에 대해 실행됩니다(크기 제한). 차원 축의 일반적인 트리거: 고해상도 원고 스캔, 레티나 스크린샷, 전체 해상도 사진.

순수 JS PNG 및 JPEG 헤더 파싱 — 네이티브 종속성 없음. 다른 형식(GIF, WebP, AVIF, BMP)은 크기와 관계없이 그대로 통과합니다. 실패 시 열림: 차원을 파싱할 수 없는 이미지(잘린 헤더, 지원되지 않는 형식)는 제거되지 않고 유지됩니다 — 유효한 이미지를 제거하는 것보다 요청을 보내는 것이 더 좋습니다.

### 이미지 보호 파이프라인 (v3.3.0)

Anthropic의 실제 규칙을 반영하는 조건 파이프라인입니다. 단일 환경 변수로 엄격하게 선택 가능합니다:

```bash
export CACHE_FIX_IMAGE_GUARD=1
```

활성화되면 프록시는 다음을 실행합니다:

| 통과 | 트리거 | 동작 |
|---|---|---|
| **통과 0** (레거시) | `CACHE_FIX_IMAGE_KEEP_LAST=N` 설정됨 | N 가장 최근보다 오래된 사용자 메시지에서 tool_result 이미지를 제거합니다. |
| **통과 3** | `CACHE_FIX_IMAGE_PRESERVE_DETAIL=1` 및 이미지 긴 변이 모델 원래 한계 초과 | `sharp`를 통한 Lanczos 크기 조정으로 원래 한계(2576 px for Opus 4.7, 1568 px otherwise)에 맞춥니다. 가로세로 비율 및 미디어 유형을 유지합니다. |
| **통과 1** | 이미지 긴 변이 활성 거부 한계 초과 | 제거하고 증거 자리 표시자로 대체합니다. 활성 한계 = `MAX_DIM` 설정 시 해당 값, 그렇지 않으면 2000 px(카운트 > 20) 또는 8000 px(카운트 ≤ 20) |
| **통과 2** | 요청 본문이 `CACHE_FIX_IMAGE_REQUEST_SIZE_MAX`(기본값 30 MB)를 초과 | 가장 오래된 이미지를 삭제하여 예산 내로 만듭니다. |
| **카운트 한계** | 남은 이미지 수가 `CACHE_FIX_IMAGE_COUNT_MAX`(기본값 100)를 초과 | 가장 오래된 이미지를 한계까지 삭제합니다. |

실행 순서: **통과 0 → 통과 3 → 통과 1 → 통과 2 → 카운트 한계**. 각 통과는 독립적입니다 — 통과 1은 절대 크기 조정하지 않으며, 통과 3은 절대 제거하지 않습니다.

#### 선택적 `sharp` 종속성

통과 3은 Lanczos 크기 조정을 위해 [sharp](https://www.npmjs.com/package/sharp)가 필요합니다. 이는 **선택적 동료 종속성**으로 선언됩니다 — 통과 3이 필요하면 별도로 설치하세요:

```bash
npm install sharp
```

`sharp`가 누락되면 통과 3은 깨끗하게 건너뜁니다(원격 측정은 `library_missing: true` 기록). 통과 1 + 통과 2 + 카운트 한계는 여전히 실행됩니다.

#### 우선순위 매트릭스

| 환경 변수 조합 | 동작 |
|---|---|
| 아무것도 설정되지 않음 | 이미지 처리 없음(백워드 호환 기본; 확장은 단절됨). |
| `KEEP_LAST=N`만 | 기존 v3.2.1: 사용자 메시지의 tool_result 이미지 수 제한, 먼저 실행. 파이프라인 없음. |
| `MAX_DIM=N`만 | 기존 v3.2.1: 하드 크기 제한, 제거 전용. 파이프라인 없음. |
| `KEEP_LAST=N` + `MAX_DIM=N` | 기존 v3.2.1 조합: `KEEP_LAST`가 먼저 실행(카운트 감소), 이후 `MAX_DIM`이 생존자에 대해 실행(크기 제한). 파이프라인 없음, 통과 2 및 통과 3 없음. |
| `IMAGE_GUARD=1` | 새로운 파이프라인: 통과 1(조건적 한계) + 통과 2(요청 크기 보호) + 이미지 수 제한. |
| `IMAGE_GUARD=1` + `MAX_DIM=N` | `MAX_DIM`은 통과 1의 조건적 한계(한계 값으로 작동)를 재정의합니다; 통과 2는 여전히 실행됩니다. |
| `IMAGE_GUARD=1` + `PRESERVE_DETAIL=1` | 통과 3(Lanczos 크기 조정 via `sharp`) 추가. `sharp`가 사용 불가능할 때 제거 동작으로 폴백합니다. |
| `IMAGE_GUARD=1` + `KEEP_LAST=N` | `KEEP_LAST`는 먼저 수 제한(통과 0)으로 실행됩니다; 파이프라인은 나머지에 대해 실행됩니다. |
| `IMAGE_GUARD=1` + `KEEP_LAST=N` + `MAX_DIM=N` | 삼중: `KEEP_LAST`가 먼저 실행; 파이프라인은 나머지에 대해 실행되지만 `MAX_DIM`은 통과 1의 조건적 한계를 재정의합니다; 통과 2는 여전히 실행됩니다. |
| `PRESERVE_DETAIL=1` 없이 `IMAGE_GUARD=1` | 경고 로그, 무작위로 처리. 파이프라인이 실행되지 않으면 `PRESERVE_DETAIL`는 의미가 없습니다. |

#### 조정 가능한 항목

| 환경 변수 | 기본값 | 목적 |
|---|---|---|
| `CACHE_FIX_IMAGE_GUARD` | 설정되지 않음 | 최상위 파이프라인 게이트(`=1` 활성화). |
| `CACHE_FIX_IMAGE_PRESERVE_DETAIL` | 설정되지 않음 | `sharp`를 통한 통과 3 Lanczos 크기 조정 활성화. |
| `CACHE_FIX_IMAGE_REQUEST_SIZE_MAX` | 31457280 (30 MB) | 통과 2 바이트 예산. Anthropic의 32 MB 한계에서 2 MB 헤더 공간. |
| `CACHE_FIX_IMAGE_COUNT_MAX` | 100 | 하드 이미지 수 제한. 레거시 Claude 1/2.x/Instant의 경우 600으로 설정 가능. |

## 이미지 재시도 서킷 브레이커 (프록시 모드, 선택적)

CC가 영구적인 "이미지를 처리할 수 없습니다" 오류를 만나면 현재 핸들러는 이를 일시적으로 간주하고 재시도합니다 — 전체 대화 컨텍스트와 동일한 34 MB 이미지 부하로 — [anthropics/claude-code#66815](https://github.com/anthropics/claude-code/issues/66815)당 약 19회까지. 하나의 나쁜 이미지는 폭풍이 자연스럽게 멈출 때까지 Max 계획 사용자의 5시간 할당량의 ~60%를 소모할 수 있습니다.

브레이커는 모든 messages-경로 응답을 감시합니다. 상류가 영구적인 이미지 처리 오류를 반환하면 실패를 기록하고 `(sessionId, requestSignature)` 키와 요청의 이미지 SHA-256 해시로 기록합니다. 동일한 세션에서 다음 요청이 30초 슬라이딩 쿨오프 내에 기록된 실패와 일치하는 이미지 해시를 포함하면 브레이커는 로컬에서 재시도를 단절합니다 — 와이어 포맷 정확한 합성 응답(스트림 true의 경우 SSE 이벤트 시퀀스, 그렇지 않으면 JSON 래퍼)을 방출하여 핸들러가 정상적으로 완료된 어시스턴트 턴으로 소비합니다. 합성 텍스트는 실패를 명명하고 사용자에게 이미지를 삭제하거나 교체하도록 요청합니다. 재시도 폭풍을 "여러 상류 호출"에서 하나로 제한합니다.

환경 변수로 선택적 활성화; v4.2.0 첫 배포 시 검증 대기 중:

```bash
export CACHE_FIX_IMAGE_RETRY_BREAKER=on
```

| 모드 | 동작 |
|---|---|
| `on` | 감지 + 기록 + 재시도 단절 |
| `off`(기본) | 통과, 감지 없음, 로깅 없음 |
| `dry-run` | 감지 + 기록 + JSONL 이벤트 로깅, 하지만 **단절하지 않음** (생산 디버깅에 유용) |

| 환경 변수 | 기본값 | 목적 |
|---|---|---|
| `CACHE_FIX_IMAGE_RETRY_BREAKER` | `off` | 모드 게이트 — `on` / `off` / `dry-run` |
| `CACHE_FIX_IMAGE_RETRY_COOLOFF_MS` | 30000 | 기록된 각 실패에 대한 슬라이딩 쿨오프 창 |
| `CACHE_FIX_IMAGE_RETRY_MAX_ENTRIES` | 4096 | 메모리 내 실패 매핑의 LRU 제한 |
| `CACHE_FIX_IMAGE_RETRY_LOG_PATH` | `~/.claude/image-retry-events.jsonl` | 구조화된 이벤트 로그 경로 (5 MB 단일 계층 회전) |

**관측성 표면:** JSONL 이벤트 로그가 유일한 신호입니다. 단절된 요청은 `usage.jsonl` 행을 생성하지 않습니다 — `usage-log` 및 `cache-telemetry`를 완전히 우회합니다(상류 호출 없음 → SSE 스트림 없음 → 행 없음). 각 발화는 `{ event: "breaker_fire", mode, session_id, image_hashes, retry_count, remaining_ms, request_id, ... }`를 기록하고, 각 첫 번째 실패는 `{ event: "failure_recorded", ... }`를 기록합니다. 로그는 해시와 메타데이터만 포함 — 이미지 바이트, 요청 본문, 인증 헤더 없음.

**감지 조건**(모두 만족해야 함):

1. 동일한 세션에서 이전 응답이 이미지 처리 오류 조건과 일치합니다(400 HTTP + 표준 `invalid_request_error` 래퍼 + 이미지 클래스 메시지).
2. 현재 요청은 기록된 실패의 이미지 해시와 일치하는 이미지 콘텐츠 블록을 포함합니다.
3. 현재 요청은 슬라이딩 쿨오프 창 내에 도착합니다.
4. 현재 요청은 동일한 세션입니다(요청 헤더 `x-claude-code-session-id` / `x-session-id` / `x-anthropic-session-id`로 확인).

세션 없는 요청은 `"unknown"`으로 분류됩니다 — 요청 서명으로 격리되지 않으며, 알려진 한계이며 30초 슬라이딩 창으로 완화됩니다.

## 세션 예산 서킷 브레이커 (프록시 모드, 선택적)

선택적 **세션당 하드 지출 한도**. CC 세션의 누적 토큰 소비(또는 예상 비용, 또는 소비 *속도*)가 설정한 한도를 초과하면 해당 세션에 대한 추가 `/v1/messages`는 로컬에서 단절됩니다 — 상류로 도달하지 않으므로 크레딧을 소모하거나 자동 구매를 유발하거나(직접 API 키 사용자인 경우) 카드 청구를 유지할 수 없습니다. [anthropics/claude-code#68285](https://github.com/anthropics/claude-code/issues/68285)에서 동기화: Workflow 팬아웃 700+ 서브에이전트가 프리미엄 계층 기본값을 상속받았으며, 에이전트당 모델 한도와 지출 게이트가 없어 ~$350 크레딧을 소모하고 ~$800 자동 구매를 유발하여 사용자가 개입할 때까지. 모든 700 서브에이전트는 단일 세션의 자식이므로, 세션당 한도는 원천에서 런어우드를 막습니다.

**이것은 서킷 브레이커이며, 측정기 아닙니다.** 피를 멈춥니다; 각 요청을 센트 단위로 가격을 붙이지 않습니다. 합계는 본문에서(`msg.usage` 토큰 수, 모든 Messages 응답에 포함됨) 및 인증 독립적으로 계산되므로 구독/OAuth 및 직접 API 키 클라이언트 모두에서 동일하게 작동합니다.

게이트를 통해 선택적 활성화; **기본적으로 꺼져 있으며**, 최소한 하나의 한도를 설정해야 작동합니다:

```bash
export CACHE_FIX_SESSION_BUDGET=on
export CACHE_FIX_SESSION_BUDGET_COST_USD=25      # 예: 이 세션을 ~$25에서 중단
```

| 모드 | 동작 |
|---|---|
| `on` | 세션당 합계; 한도를 확실히 초과하면 다음 요청 단절 |
| `off`(기본) | 통과, 합계 없음, 로깅 없음 |
| `dry-run` | 합계 + 블록 지점에서 `would_block` 이벤트 로깅, 하지만 **모든 요청 전달** (강제 전에 측정) |

### 세 가지 블로킹 레버(최소 하나 설정)

| 환경 변수 | 기본값 | 목적 |
|---|---|---|
| `CACHE_FIX_SESSION_BUDGET` | `off` | 게이트 — `on` / `off` / `dry-run` |
| `CACHE_FIX_SESSION_BUDGET_TOKENS` | 설정되지 않음 | 세션의 누적 `input + cache_creation` 토큰이 이 정수를 초과하면 하드 중단. 계획에 독립적이며 **정확** — 백업 레버입니다. |
| `CACHE_FIX_SESSION_BUDGET_COST_USD` | 설정되지 않음 | 예상 비용(토큰 × `tools/rates.json`)이 이 부동 소수점 수를 초과하면 하드 중단. |
| `CACHE_FIX_SESSION_BUDGET_RATE_TPM` | 설정되지 않음 | 세션의 토큰/분이 슬라이딩 창을 초과하면 하드 중단 — **초기 팬아웃 캐치** (대량 배치가 떨어지기 전에 경사에서 발생). |
| `CACHE_FIX_SESSION_BUDGET_RATE_WINDOW_MS` | 60000 | 속도 레버의 슬라이딩 창. |
| `CACHE_FIX_SESSION_BUDGET_MAX_ENTRIES` | 4096 | 메모리 내 세션당 합계 매핑의 LRU 제한. |
| `CACHE_FIX_SESSION_BUDGET_EVENT_LOG` | `~/.claude/session-budget-events.jsonl` | 구조화된 화재 이벤트 로그 경로 (5 MB 단일 계층 회전). |

### 어떤 레버가 어떤 청구 모델에 사용되는가

브레이커는 **두 가지** 청구 모델을 지원하지만 위험 — 그래서 주요 레버가 다릅니다:

- **구독 (OAuth, 예: Max) — #68285 사례.** 토큰은 할당량까지이며, 위험은 계정 전역 자동 구매 벽입니다. `_TOKENS`(또는 `_RATE_TPM`)를 사용하여 런어우드 *세션*을 할당량에 도달하기 전에 캡니다. 비용은 여기서 정보적입니다.
- **직접 API 키 (사용 요금) — 더 심각한 경우.** 할당량 버퍼가 없습니다: 모든 토큰은 즉시 API 목록 가격으로 청구되며, 동일한 팬아웃은 *지출 회로*가 없으며 카드를 청구하여 키의 계층 제한 또는 은행 개입까지. 여기서 `_COST_USD`는 **실제 달러 한도**입니다: `tools/rates.json`은 Anthropic의 API 목록 가격이므로 `tokens × rates.json`은 실제 돈입니다.

**비용은 추정치이며, 토큰 한도와 짝을 이루어 보장된 달러 경계를 제공합니다.** `rates.json`은 새로 출시된 모델에 지연될 수 있습니다. 알 수 없는 모델은 비용 합계에 **0**을 기여합니다(실패 열림으로 설계됨), 따라서 오래된 비율은 조용히 *하위* 계산되어 예상 달러 수치를 초과할 수 있습니다. 토큰 및 비율 레버는 항상 정확합니다. API 키에 하드 달러 한도가 필요하면 **또한 `_TOKENS` 설정**하여 오래된/알 수 없는 비율이 무제한 지출을 허용하지 않도록 합니다 — 토큰 한도가 추정치를 백업합니다. (`tools/rates.json`은 Anthropic의 가격 페이지에서 주간으로 새로 고침됩니다; 인간이 모든 가격 차이를 검토합니다.)

두 요청 모드는 모두 포함됩니다: 스트리밍 응답은 `message_start` 이벤트에서 누적되고, 비스트리밍(`stream:false`) 응답은 반환된 JSON 본문에서 누적됩니다. 합계, 한도 및 블록 동작은 모두 동일합니다 — 모드가 예산을 우회하지 않습니다.

### 실패 열림, 항상

계정이 불확실할 때 — 게이트 꺼짐, 한도 설정되지 않음, `usage` 누락 또는 파싱 불가능, 세션 키 없음, `rates.json`에서 모델 알 수 없음(비용 레버만), 재시작 후 첫 요청 또는 모든 예외 — 요청은 **전달됩니다.** 블록은 게이트 `on` **그리고** 적어도 하나의 레버가 숫자적으로, 확실히 한도를 초과해야 합니다. 예산 브레이커가 실패 *닫기*로 세션을 고정하면 프록시 버그로 인해 전체 세션이 멈추는 것이 더 나쁩니다. 하나의 환경 전환(`CACHE_FIX_SESSION_BUDGET=off`)은 완전히 비활성화합니다.

### 관측성 표면 (측정기 우회)

단절된 요청은 상류 호출 전에 반환되므로 **`usage.jsonl` 행을 생성하지 않습니다** — 올바르게(비용이 발생하지 않음), 하지만 **측정기에는 없습니다.** 유일한 화재 신호는 JSONL 이벤트 로그입니다: 각 블록은 `{ event: "session_budget_block", would_block, sid, lever, limit, observed, cumulative_tokens, cumulative_cost_usd, request_id, ts }`를 기록합니다. `dry-run`은 동일한 레코드를 기록하지만 `would_block: true`로 전달합니다. 로그는 합계와 초과한 한도만 포함 — **요청/응답 본문, 모델 입력 콘텐츠, 인증 헤더 없음.** `request_id`는 선택적입니다(로컬 블록 요청은 상류 요청 ID가 없습니다; 클라이언트 요청 헤더가 있는 경우 채워지고, 그렇지 않으면 `null` — 절대 위조되지 않음).

각 화재 이벤트는 **관찰적인** `account_q5h_contribution`도 포함합니다 — 이 세션이 계정의 롤링 5시간 할당량 소모에 얼마나 기여했는지 추정치, 세션의 윈도우 토큰 공유로 인해(`{ window_ms, account_q5h_delta, session_token_share, attributed_q5h_delta }`). 이는 Anthropic의 **계정 전역** `anthropic-ratelimit-unified-5h-utilization` 헤더에서 파생되므로 **절대** 블록 레버가 아닙니다 — 다른 세션의 소모로 인해 무죄한 세션이 트리거됩니다. 운영자에게 *어떤* 세션이 할당량을 주도하는지 보여주기 위한 것입니다. API 키 트래픽은 헤더를 누락하므로 필드는 단순히 생략됩니다.

할당 분모는 프록시의 **프로세스 전역** 토큰 풀이며, 이 추정치는 프록시 인스턴스가 **하나의** Anthropic 계정을 서비스하는 경우에만 유효합니다(일반적인 단일 운영자 배포). 하나의 인스턴스가 여러 계정을 전면으로 하면 독립 계정이 동일한 분모를 공유하고 세션 기여도는 과대 또는 과소 평가될 수 있습니다. 관찰적으로 이는 게이트에 영향을 주지 않습니다.

### 알려진 제한

- **병행 초과.** 대량 팬아웃은 거의 동시에 발생하므로 순수 누적(`_TOKENS`/`_COST_USD`) 한도는 인플라이트 배치의 토큰이 떨어진 후에만 트리거됩니다 — 그 배치만큼 초과합니다. **`_RATE_TPM`은 이 문제를 완화**하여 배치가 완료되기 전에 경사에서 발생합니다.
- **출력 비용은 사후적입니다** — 합계는 *다음* 요청을 기준으로 하며, 현재 요청은 아닙니다.
- **재시작 시 합계 재설정** — 메모리 내에 있으며, 세션 중간 프록시 재시작 시 0이 됩니다. 안전 백업에는 적절합니다.
- **세션당, 계정당 아님** — 불법적인 *세션*을 캡니다; Anthropic의 계정 전역 할당량을 낮추거나 자동 구매를 직접 막을 수 없습니다. 단일 세션 런어우드(#68285)의 경우, 해당 세션을 캡하는 것이 적절하고 충분한 조치입니다.

## `cc_version` 정규화 (프록시 모드, 선택적)

일부 Claude Code 배포 채널 — 특히 자동 업데이트 하위 VS Code 확장 — 시스템 프롬프트의 `x-anthropic-billing-header`에서 `MAJOR.MINOR.PATCH` 위에 빌드 해시를 포함하는 `cc_version` 값을 내보냅니다(예: `2.1.185.<buildhash>`). 빌드 해시가 세션 중에 변할 때(바이너리 자동 업데이트가 턴 간에), 해당 값은 캐시 가능한 접두사 내에 위치하므로 후속 턴마다 전체 `cache_creation` 비용을 지불해야 합니다 — Anthropic의 접두사 캐시는 바이트 정확하며 필드는 범위 내입니다.

기존 `fingerprint-strip`는 이 경우를 다루지 않습니다: 사용자 메시지 텍스트의 CC 생성 지문과 일치하는 접미사만 재작성합니다. 바이너리 빌드 해시는 검증에 실패하고 `fingerprint-strip`는 재작성을 하지 않고 null을 반환합니다.

환경 변수로 선택적 활성화; 기본적으로 꺼져 있습니다:

```bash
export CACHE_FIX_NORMALIZE_CC_VERSION=strip          # X.Y.Z.<suffix> → X.Y.Z로 축소
# 또는
export CACHE_FIX_NORMALIZE_CC_VERSION=pin:2.1.185    # 운영자 제공 리터럴
```

| 모드 | 동작 |
|---|---|
| `off`(기본) | 변이 없음 |
| `strip` | `cc_version=X.Y.Z(.suffix)+`를 `cc_version=X.Y.Z`로 축소 |
| `pin:<value>` | `cc_version=<anything>`을 운영자 리터럴로 대체합니다. 유효성 검사: `^[A-Za-z0-9.\-]+$`, 최대 64자(주변 헤더 문법을 깨뜨리는 것은 실패 열림으로 `off`로 돌아가고 stderr 경고 하나를 출력). |

확장은 순서 90에서 실행되며, 순서 100의 `fingerprint-strip` 이전입니다. 정규화 후 `cc_version`은 최대 3개의 세그먼트를 가지므로 `fingerprint-strip`의 `dotParts.length < 4` 보호는 무작위로 작동합니다 — 두 확장은 깨끗하게 협력하며 다른 순서 위험 없음. 필드 경계가 있는 정규식 `(^|[;\s:])cc_version=([^;\s]+)`으로 인해 다른 필드 값에 포함된 `cc_version=` 하위 문자열이 실수로 재작성되지 않습니다. 원자 실패 열림: 계획된 재작성은 로컬 배열에 단계를 적용하고 스캔 완료 후에만 적용됩니다; 스캔 중 오류가 발생하면 본문 바이트가 그대로 유지됩니다.

## 세션 백업 (프록시 모드, 선택적)

CC의 트랜스크립트 회귀에 대한 벨트 앤 서스펜더 백업 [anthropics/claude-code#66734](https://github.com/anthropics/claude-code/issues/66734) (기존 트랜스크립트 재작성으로 메타데이터만 있는 스텁) 및 [anthropics/claude-code#66486](https://github.com/anthropics/claude-code/issues/66486) (대화 세션에서 누락된 트랜스크립트). 프록시가 경로에 있을 때, 모든 어시스턴트 메시지 + 관찰된 도구 결과 / 사용자 입력은 사용자 제어 하위의 세션별 JSONL 파일에 미러링되며, CC 자체 트랜스크립트 작성기와 독립적입니다. CC의 트랜스크립트는 살아 있을 때 표준이며, 그렇지 않으면 복구 경로입니다.

환경 변수로 선택적 활성화; v4.2.0 및 v4.3.0에서 프라이버시 포지처 사이클 후 기본적으로 꺼져 있습니다:

```bash
export CACHE_FIX_SESSION_MIRROR=on
```

| 환경 변수 | 기본값 | 목적 |
|---|---|---|
| `CACHE_FIX_SESSION_MIRROR` | `off` | 마스터 게이트 — `on` 활성화 미러링 |
| `CACHE_FIX_SESSION_MIRROR_DIR` | `~/.claude/session-mirrors/` | 저장소 루트 |
| `CACHE_FIX_SESSION_MIRROR_MAX_BYTES` | 100 MB | 세션별 활성 파일 회전 임계값 |
| `CACHE_FIX_SESSION_MIRROR_RETENTION_DAYS` | 30 | 보존 스윕 수평(이보다 오래된 파일은 연결 해제) |
| `CACHE_FIX_SESSION_MIRROR_MAX_SESSIONS` | 1024 | 메모리 내 중복 상태 매핑의 LRU 제한 |
| `CACHE_FIX_SESSION_MIRROR_INCLUDE_THINKING` | `true` | `thinking` 콘텐츠 블록을 미러 레코드에서 제외하려면 `false`로 설정 |

**형식 일치:** 미러 레코드는 CC 2.1.148의 확인된 트랜스크립트 랩 형식과 정확히 동일합니다 — 기존 트랜스크립트 리더(포함 `restore-claude-history-linux`)는 미러 파일을 변경 없이 파싱합니다. 단일 구별 필드는 `source: "cache-fix-proxy-mirror"`입니다. 쓰기 시 알려진 세 가지 제한 사항:

1. `cwd`는 항상 `null`입니다(프록시가 호출자 작업 디렉토리를 알지 못함).
2. `uuid`는 대시 형식(`8-4-4-4-12`)이지만 버전/변형 비트는 RFC 유효하지 않습니다. `(sessionId, timestamp, messageId)`의 결정론적 해시이며, 체인은 재구성 가능합니다; 형식 유효 파서는 이를 수용합니다.
3. 도구 결과 사용자 레코드는 `toolUseResult` 및 `sourceToolAssistantUUID`를 생략합니다(프록시가 재구성할 수 없는 CC 내부 풍부한 개체).

저장소 구조: `<DIR>/<sessionFilename(sessionId)>/<timestamp>.jsonl`. `[A-Za-z0-9_-]{1,128}`와 일치하지 않는 세션 ID는 `inv-<sha256[:16]>`로 분류됩니다(경로 탐색 안전). 세션 없는 요청은 `unknown/` 디렉토리를 공유합니다.

**운영 이벤트**(열기 / 회전 / 스윕 / 오류)는 `~/.claude/session-mirrors/session-mirror-events.jsonl`(5 MB 단일 계층 회전)에 로깅됩니다. 미러는 상류 트래픽에 대해 읽기 전용입니다; 요청이나 응답은 수정되지 않으며, 작성자 오류는 파이프라인의 각 훅 try/catch로 응답 스트림에서 격리됩니다.

최악의 경우 디스크 사용량 계산은 [docs/disk-usage.md](docs/disk-usage.md)를 참조하세요.

## 캐시 브레이크포인트 (프록시 모드, 선택적)

Anthropic의 프롬프트 캐시는 요청당 최대 **네 개**의 `cache_control` 마커를 지원합니다. Claude Code는 현재 네 개 중 세 개를 사용합니다; 세 번째(자동 주입된 `messages[0]` 콘텐츠 — 훅, 스킬, 프로젝트 CLAUDE.md, 지연 도구, MCP 서버 설명 — 및 첫 번째 실제 사용자 콘텐츠 사이)는 완전히 누락되어 있습니다. 이 마커가 없으면 자동 주입된 범위 내의 모든 변경이 이후 모든 것을 캐시에 파괴합니다. wadabum은 이 추가로 인해 새로운 세션 첫 번째 턴에서 ~6,500 토큰 절약을 예측했습니다 ([anthropics/claude-code#47098](https://github.com/anthropics/claude-code/issues/47098)).

프록시는 선택적으로 누락된 마커를 주입할 수 있습니다. 커뮤니티 데이터에 대해 유효성 검사 전까지 기본적으로 꺼져 있습니다.

```sh
export CACHE_FIX_INJECT_MESSAGES_BREAKPOINT=1
```

주입은 보수적입니다: 요청이 이미 1–3개의 마커(전형적인 CC 모양)를 포함할 때만 작동하며, 요청이 4개 마커 한도에 도달했거나(400 발생) 0개 마커(에이전트 SDK / API 직접 모양)인 경우 거부합니다. 경계 감지는 모든 다섯 가지 관찰된 자동 주입 블록 종류 — 훅, 스킬, CLAUDE.md, 지연 도구, MCP — 및 마지막 자동 주입 블록에 마커를 배치합니다.

진단 전용 환경 변수는 요청을 수정하지 않고 `messages[0]`의 구조적 모양을 덤프합니다:

```sh
export CACHE_FIX_DUMP_MESSAGES_HEAD=/tmp/messages-head.jsonl
```

| 환경 변수 | 기본값 | 목적 |
|---|---|---|
| `CACHE_FIX_INJECT_MESSAGES_BREAKPOINT` | 설정되지 않음 | 브레이크포인트 #3 주입 활성화 (`=1` 선택적) |
| `CACHE_FIX_DUMP_MESSAGES_HEAD` | 설정되지 않음 | `messages[0].content` 모양의 진단 JSONL 덤프 — 읽기 전용, 수정 없음 |

## 마이크로 컴팩트 안정성 (프록시 모드, 선택적)

약 90분 유휴 후, Claude Code의 `time_based_microcompact`(그리고 `FDY()`에 의해 트리거된 냉 컴팩트 경로)는 오래된 `tool_result` 콘텐츠를 센티넬 문자열로 대체합니다. 원래 콘텐츠는 캐시 목적에서는 사라졌으며, 이 부분은 프록시에서 복구할 수 없습니다. 하지만 센티넬 자체는 포함된 타임스탬프(`[Old tool result content cleared at 2026-04-30T13:42:11Z]`)를 포함할 수 있으며, 이는 동일한 이미지가 지워진 위치에 대해 *두 번째* 마이크로 컴팩트를 실행하면 다른 바이트를 쓰게 되어 해당 위치 이후 모든 것을 캐시에 파괴합니다. 이 확장은 복구 가능한 절반을 다룹니다: 센티넬을 바이트 안정적인 표준 형식으로 정규화하여 반복 마이크로 컴팩트가 캐시를 뒤섞지 않도록 합니다. **1단계만** — 진단 + 선택적 정규화. 2단계(원래 tool_result 콘텐츠의 스냅샷 및 복원)는 v3.5.0+에서 1단계 프로덕션 데이터를 기다리며 연기됩니다.

```sh
# 단계 1 (진단): CC의 센티넬이 실제로 어떻게 보이는지 분석합니다.
export CACHE_FIX_DUMP_MICROCOMPACT=/tmp/microcompact-dump.jsonl

# 단계 2 (정규화): 센티넬 형식이 확인되면 선택적 활성화합니다.
export CACHE_FIX_NORMALIZE_MICROCOMPACT=1
```

감지는 두 가지 모드가 있습니다:
- **모드 A** — 확인된 CC 센티넬 패턴(일반 형식 및 ISO-8601 타임스탬프 변형)과 정확히 일치합니다. 모드 A는 정규화 대상입니다.
- **모드 B** — 접두사만 일치(텍스트가 `[Old tool result content cleared`로 시작하지만 모드 A 패턴과 정확히 일치하지 않음). 모드 B는 **진단 전용**입니다: 절대 정규화되지 않으며, 덤프 레코드는 64자 접두사만 제거합니다.

모드 A/B 분리는 센티넬이 사용자 유도 콘텐츠로 뒤따를 수 있는 경우(예: 도구가 사용자 입력을 결과에 다시 반영함)를 보호합니다 — 모드 B의 제거 보장은 이 콘텐츠를 진단 덤프에서 제외합니다.

| 환경 변수 | 기본값 | 목적 |
|---|---|---|
| `CACHE_FIX_DUMP_MICROCOMPACT` | 설정되지 않음 | 감지된 센티넬의 진단 JSONL 덤프 경로. 읽기 전용 — 수정 없음. |
| `CACHE_FIX_NORMALIZE_MICROCOMPACT` | 설정되지 않음 | 정규화 활성화 (`=1` 선택적). 모드 A 일치를 표준 형식으로 변환합니다. |
| `CACHE_FIX_MICROCOMPACT_NORMALIZED` | `[Old tool result content cleared]` | 표준 대체 문자열 재정의. |
| `CACHE_FIX_MICROCOMPACT_SENTINEL_PATTERN_<N>` | 설정되지 않음 | 사용자 정의 모드 A 정규식 패턴 추가. 번호(1-인덱스, 희소 가능). |
| `CACHE_FIX_MICROCOMPACT_SENTINEL_PREFIX_<N>` | 설정되지 않음 | 사용자 정의 모드 B 리터럴 접두사. 비표준 센티넬 패밀리의 사용자 정의 모드 A 패턴과 함께 사용하여 해당 패밀리의 접두사 전용 변형도 모드 B 캡처에 제거됩니다. |
| `CACHE_FIX_MICROCOMPACT_REDACT_LEN` | `64` | 덤프 레코드에서 모드 B 접두사 길이. 완전히 접두사를 억제하려면 `0`으로 설정합니다. |
| `CACHE_FIX_DUMP_MICROCOMPACT_INCLUDE_NORMALIZED` | 설정되지 않음 | 덤프 레코드에서 원본 `sentinel_text` 옆에 후 정규화 텍스트를 추가(대체하지 않음). |

## 생각 요약 (프록시 모드, 선택적, Opus 4.7+)

Opus 4.7에서 Anthropic은 API 기본값을 `"summarized"`에서 `"omitted"`로 변경했습니다. 동시에 Claude Code의 CLI에는 `!getIsNonInteractiveSession()` 게이트가 있으며, 세션이 대화형일 때만 `display: "summarized"`를 전달합니다. 이 조합은 `--input-format stream-json`으로 시작된 모든 CC 하위 프로세스 — VS Code 채팅 패널, Antigravity 패널, SDK, `claude --print` —는 생각이 활성화된 요청(`thinking.type`은 CC 버전에 따라 `"enabled"` 또는 `"adaptive"`)을 보내지만 `display` 없이, API 응답은 `thinking` 필드가 비어 있는 생각 블록(다중-KB 서명 포함)입니다. UI는 정적 "Thinking" 스텁을 표시하지만 어시스턴트는 절대 추론 콘텐츠를 표시하지 않습니다.

상류 원인 및 패치는 [anthropics/claude-code#59844](https://github.com/anthropics/claude-code/issues/59844)에 제안되었습니다(credit: [@ojura](https://github.com/ojura)). 이 확장은 프록시 측 보완입니다: Opus 4.7 엔드포인트에 대한 요청이 생각이 활성화되었지만 `display`가 설정되지 않은 경우, API 경계에서 구성된 모드를 주입합니다. cache-fix-proxy를 통해 라우팅되는 모든 CC 버전에서 작동하며, Anthropic이 CLI 수정을 배포할 때까지 기다릴 필요가 없습니다.

```sh
# 요약 복원 (기본 내장 — 비대화 표면은 추론 콘텐츠를 받습니다)
export CACHE_FIX_THINKING_DISPLAY=summarized

# 강제-억제 재정의 (생성 런타임이 생각 블록을 전혀 원하지 않는 경우)
export CACHE_FIX_THINKING_DISPLAY=omitted

# 명시적 무작위 (확장은 변경되지 않고 통과합니다)
export CACHE_FIX_THINKING_DISPLAY=disabled
```

확장은 v3.6.1부터 **기본적으로 켜져 있습니다**. Opus 4.7에서 주입이 활성화된 경우, 5개의 연속 `claude -p` 호출(기준선 vs 주입 — 두 윈도우 모두 2번 이후부터 1.000 캐시 히트율)에서 절대 감소가 0%로 측정되었습니다. 요청 본문에 `thinking.display`를 추가하면 Anthropic이 해시하는 바이트가 변경되지만, Anthropic의 캐시 레이어는 주입된 접두사를 다른 접두사와 동일하게 수용하고 색인화합니다. 이전 "주입 없음" 동작(예: 요청 본문 변경을 완전히 피하려는 경우)을 원하는 사용자는 `CACHE_FIX_THINKING_DISPLAY=disabled`를 명시적으로 설정합니다.

확장에 내장된 범위 규칙:

- **모델-게이트.** 요청의 `model`이 `/^claude-opus-4-7/`과 일치할 때만 작동합니다 — `claude-opus-4-7` 및 `claude-opus-4-7-1m`을 포함합니다. Sonnet 4.7은 별도 검증이 필요합니다(API 기본 변경이 다를 수 있음); 향후 버전(4.8+)은 확인되지 않은 동작을 자동 적용하는 대신 명시적 cache-fix 업데이트가 필요합니다.
- **사용자 선택 보존.** 요청에 이미 `thinking.display`가 설정되어 있는 경우(두 가지 모두 `"summarized"` 또는 `"omitted"`), 확장은 절대 덮어쓰지 않습니다. 명시적 사용자 선택은 항상 승리합니다.
- **생각 활성 유형만.** 확장은 Opus 4.7에서 생각 블록을 생성하는 두 가지 활성 모드인 `thinking.type` ∈ `{ "enabled", "adaptive" }`에서 작동합니다. 다른 값(`"disabled"`, 향후 모드)은 건너뜁니다. 보수적: Anthropic이 다른 표시 의미 체계를 가진 새로운 생각 유형을 배포하는 경우, 잘못된 동작을 자동 적용하는 것보다는 수정을 놓치는 것이 좋습니다.

| 환경 변수 | 기본값 | 목적 |
|---|---|---|
| `CACHE_FIX_THINKING_DISPLAY` | `summarized`(내장) | `summarized` / `omitted` / `disabled` 중 하나. `summarized`는 생각 요약 복원(기본). `omitted`는 생각 블록을 강제로 억제합니다. `disabled`는 확장을 완전히 비활성화합니다. |

## 세션-건강 조기 경고 (프록시 모드, 생각-비동기 위험)

장시간 실행되는 Opus 4.7 `[1m]` 세션은 교차된 생각 블록을 누적하고 활성 컨텍스트를 확장하여 Claude Code의 자체 역사 재구성이 생각 블록 서명을 비동기화시켜, 이후 모든 턴에서 영구적인 `400 … thinking blocks … cannot be modified`가 발생합니다(상류 원인: [anthropics/claude-code#63147](https://github.com/anthropics/claude-code/issues/63147)). 세션은 예고 없이 갑작스럽게 종료됩니다.

`session-health` 확장은 트립과 관련된 조건을 감시하고 세션이 위험 구역에 도달하기 전에 경고하여 운영자는 세션을 의도적으로 종료(세션 상태 핸드오프, `/clear`)할 수 있도록 하며, 죽은 세션에 놀라지 않도록 합니다. 이는 **읽기 전용**입니다 — 요청/응답 본문을 수정하지 않으며, 비동기를 복구하려 시도하지 않습니다(이것은 CC 측면이며, #63147). 각 요청 시 세션별 파일(`~/.claude/quota-status/sessions/<id>.json`)에 숫자 원격 측정을 기록하고, 세션이 처음 `high` 위험에 도달하면 한 번의 stderr 라인을 출력합니다. 카운트만 — 생각 텍스트나 서명은 절대 로깅되지 않습니다.

세션별 JSON에 추가된 필드:

- `context_tokens` — 최신 요청의 활성 컨텍스트(`input + cache_read + cache_creation`)
- `thinking_block_count` — 최신 요청의 `thinking`/`redacted_thinking` 블록 수
- `thinking_block_max` — 세션 고수준 표시(프록시 재시작 시 유지)
- `first_seen`, `request_count` — 세션 나이 + 요청 합계
- `thinking_desync_risk` — `ok` / `warn` / `high`(신호가 비활성화된 경우 생략)

토큰 임계값은 관찰된 ~382K 토큰 트립에 고정되며, 경고는 설계상 보수적입니다 — 조기에 "조기에 종료"하는 것이 죽은 세션보다 훨씬 저렴합니다. 블록 수는 기록되지만 아직 경고를 게이트하지 않습니다(실패 분포가 알려진 후 신속한 후속 조치로 활성화됨).

| 환경 변수 | 기본값 | 목적 |
|---|---|---|
| `CACHE_FIX_THINKING_RISK_WARN_TOKENS` | `250000` | `thinking_desync_risk`가 `warn`이 되는 컨텍스트 토큰 수준 |
| `CACHE_FIX_THINKING_RISK_HIGH_TOKENS` | `340000` | 위험 수준이 `high`가 되고 한 번의 stderr 경고가 발생하는 컨텍스트 토큰 수준 |
| `CACHE_FIX_THINKING_RISK` | 설정되지 않음(켜짐) | 경고 신호를 억제하려면 `off`로 설정합니다(.stderr 라인 + `thinking_desync_risk` 필드). 원시 카운트 원격 측정은 계속 기록됩니다. |

## 생각-블록 정화 (프록시 모드, 기본적으로 켜짐, 생각-비동기 완화)

생각-비동기 응답의 *완화* 절반(위의 세션-건강 경고 절반)입니다. 역사 재생 경로(재개 / `--continue` / 자동 압축 / 병렬 도구-취소)에서 Claude Code는 이전 어시스턴트 턴의 확장된 생각을 **제거된** 형식 `{ "type":"thinking", "thinking":"", "signature":"<intact>" }`으로 재전송합니다. API는 **최신** 어시스턴트 메시지에서 수정된 생각을 거부하고 영구적인 `400 … thinking … blocks cannot be modified`를 발생시켜, 이후 모든 턴에서 세션을 고정합니다(상류 원인: [anthropics/claude-code#63147](https://github.com/anthropics/claude-code/issues/63147)).

`thinking-block-sanitize` 확장은 요청 전에 전달되기 전에 이러한 제거된 블록을 삭제합니다 — API는 선택적 역사로 간주합니다. 경험적으로 해결된 턴-선택 규칙: **모든 이전 어시스턴트 턴과 최신 어시스턴트 턴에서 제거된 생각을 삭제하고, 최신 턴이 활성 도구-계속인 경우** (마지막 블록은 후속 `tool_result`에 의해 응답되는 `tool_use`)는 API가 서명된 생각을 요구하며 프록시는 비어 있는 텍스트를 복원할 수 없으므로 턴을 그대로 유지합니다. **이 경우 생각을 유지하고 슬릿을 피하는 환경 변수는 없습니다:** `CLAUDE_CODE_DISABLE_THINKING=1` / `MAX_THINKING_TOKENS=0`은 생각을 완전히 비활성화하여(손실적 — 추론 없음) 슬릿을 멈추고, `DISABLE_INTERLEAVED_THINKING=1`은 `400`을 멈추지 않습니다 — 따라서 답은 재개하지 않고 치유/종료하는 것입니다. 이것이 정확히 프록시 완화가 중요한 이유입니다: **이 역사 재생 경로에서 추론을 유지하면서 슬릿을 피할 수 있는 유일한 경로**입니다. 비어 있지 않은 생각은 절대 건드리지 않으며, v1의 범위 밖인 `redacted_thinking`입니다.

**v4.0.0부터 기본적으로 켜져 있습니다.** v1은 v3.8.0–v3.9.x에서 `CACHE_FIX_THINKING_SANITIZE=on`을 통해 선택적이었습니다. 37개 세션에서 일주일간의 프로덕션 강아지 테스트 후(0개 `cannot be modified` 400, 캐시 히트율 평균 94.66% vs 베이스라인 92.44%, ~35% 세션에서 정화 발생, 하루당 약 800개 블록 제거, 최대 938K 컨텍스트 건강) v1 완화는 새로운 기본값입니다. 변환은 결정론적이며 캐시-접두사 안정적이며, 세션별 JSON(카운트만 — 내용 없음)에 요청당 `thinking_blocks_dropped` 수를 출력하여 세션-건강 신호를 보완합니다. v2는 [#196](https://github.com/cnighswonger/claude-code-cache-fix/issues/196)가 닫힌 조용한 로드 실패 모드 이후 v2가 이전 테스트에서 실행되지 못했기 때문에 선택적입니다.

| 환경 변수 | 기본값 | 목적 |
|---|---|---|
| `CACHE_FIX_THINKING_SANITIZE` | 설정되지 않음 (= v1) | v4.0.0+: v1 제거 블록 삭제는 기본값입니다. 명시적으로 비활성화하려면 `off`로 설정(3.x 기본-비활성화 동작으로 돌아갑니다). v2 도구 해시 불일치 삭제를 추가로 활성화하려면 `v2`로 설정합니다. v1을 위해 `on`(백워드 호환 — 설정되지 않은 것과 동일). |

## 시스템 프롬프트 재작성 (사전 로드 모드, 선택적)

인터셉터는 Claude Code의 `# Output efficiency` 시스템-프롬프트 섹션을 재작성할 수 있습니다. 기본적으로 비활성화됩니다. `CACHE_FIX_OUTPUT_EFFICIENCY_REPLACEMENT`으로 활성화합니다. 세 가지 알려진 프롬프트 변형과 사용 지침은 [docs/output-efficiency-prompts.md](docs/output-efficiency-prompts.md)를 참조하세요.

## 모니터링 및 진단

사전 로드 인터셉터는 마이크로 컴팩트 저하, 거짓 비율 제한기, GrowthBook 플래그 상태, 사용 원격 측정 및 비용 보고서에 대한 모니터링을 포함합니다. 할당량 추적은 프록시 및 사전 로드 모드 모두에서 `~/.claude/quota-status/`(프록시: 세션별 분할) 또는 `~/.claude/quota-status.json`(사전 로드: 단일 세션 레거시 경로)를 통해 작동합니다.

자세한 내용, 디버그 모드, 접두사 차이, 환경 변수 및 번들 할당량 분석 도구는 [docs/monitoring.md](docs/monitoring.md)를 참조하세요.

### `usage-log` 확장 및 `MeterRowSchema v:1` 와이어 포맷

`usage-log` 확장(프록시/extensions.json을 통해 선택적)은 `~/.claude/usage.jsonl`에 API 응답당 하나의 JSON 라인을 추가합니다. 행 형식은 `MeterRowSchema v:1`입니다 — [`claude-code-meter`](https://github.com/cnighswonger/claude-code-meter)의 엄격한 스키마로 유효성 검사된 크로스-리포 컨트랙트입니다. 아래 모든 필드는 호출당 캡처됩니다:

| 필드 | 유형 | 출처 |
|---|---|---|
| `v` | 리터럴 `1` | 상수 |
| `ts` | ISO-8601 날짜시간 | 서버가 행을 방출한 시간 |
| `sid` | 8자 소문자 16진수 | 프록시 세션 ID, 프록시의 수명 동안 고정 |
| `model` | 문자열 ≤64 | 응답 스트림에서 `message_start.message.model` |
| `requested_model` | 문자열 ≤64 (선택적) | 요청 본문 `model` 필드 |
| `model_mismatch` | bool (선택적) | `requested_model && model && requested_model !== model`일 때 true |
| `speed` | `"standard"` / `"fast"` / `""` | 응답 `usage.speed` |
| `service_tier` | 문자열 ≤32 | 응답 `usage.service_tier` |
| `input_tokens` | int ≥0 | 응답 사용 |
| `output_tokens` | int ≥0 | 응답 사용 |
| `cache_creation_input_tokens` | int ≥0 | 응답 사용 |
| `cache_read_input_tokens` | int ≥0 | 응답 사용 |
| `ephemeral_1h_input_tokens` | int ≥0 | 응답 사용 |
| `ephemeral_5m_input_tokens` | int ≥0 | 응답 사용 |
| `web_search_requests` | int ≥0 | 응답 사용 |
| `q5h` / `q7d` | float 0–2 | `anthropic-ratelimit-unified-{5h,7d}-utilization` 헤더 |
| `q5h_reset` / `q7d_reset` | int (유닉스 초) | 해당 재설정 헤더 |
| `qstatus`, `qoverage`, `qclaim` | 소문자 열거형 | 통합 상태 / 과도 / 클레임 헤더 |
| `qfallback_pct` | float 0–1 | 통합 폴백 백분율 |
| `qoverage_util` | float ≥0 (선택적) | 과도 사용량 헤더 |
| `qrepresentative_claim` | 문자열 ≤16 (선택적) | 대표 클레임 헤더 |
| `org_id` | 16자 16진수 (선택적) | `sha256(anthropic-organization-id).slice(0, 16)` — 절대 원본 아님 |
| `overage_disabled_reason` | 문자열 ≤64 (선택적) | 과도 비활성화 이유 헤더 |
| `cache_hit_rate` | float 0–1 | `cache_read_input_tokens / (input + cache_creation + cache_read)` |
| `q5h_delta`, `q7d_delta` | float | 이전 행의 q5h/q7d에서의 호출당 차이; 재시작 후 첫 호출은 0 |
| `request_id` | 문자열 ≤64 (선택적) | 상류 `request-id` 응답 헤더. **v4.2.0부터 기본적으로 켜짐.** pre-meter-v0.7.0 설치에 대한 킬 스위치(`CACHE_FIX_USAGE_LOG_REQID=off`)로, 이 필드를 생략합니다. **크로스-리포 게이트:** `claude-code-meter >= v0.7.0`은 선택적 필드를 수용하며, 이전 meter 설치는 엄격한 개체 스키마로 알 수 없는 키를 거부합니다. |

**`request_id`가 운영에 중요한 이유.** `sid` 필드는 프록시 부팅 시 한 번 생성되며, 모든 CC 세션이 공유합니다. 하나의 프록시를 통해 여러 동시 CC 세션을 실행하는 호스트(에이전트 팔레트에서 일반적)에서는 모든 세션의 행이 동일한 `sid`로 충돌합니다 — `usage.jsonl`만으로는 "어떤 세션이 오늘 Opus 토큰의 80%를 소모했는지?"를 묻는 것이 불가능합니다. CC의 세션별 JSONL 트랜스크립트인 `~/.claude/projects/<project>/<session-uuid>.jsonl`은 모든 API 호출에 대해 `requestId`를 포함합니다. 메터 행에서 동일한 값을 캡처하면 후속 조인은 간단합니다:

```bash
# usage.jsonl 행이 어떤 CC 세션에 속하는지 찾습니다:
for row in $(jq -c . < ~/.claude/usage.jsonl); do
  req=$(jq -r '.request_id // empty' <<< "$row")
  [ -z "$req" ] && continue
  grep -l "\"requestId\":\"$req\"" ~/.claude/projects/*/*.jsonl
done
```

일치하는 트랜스크립트의 파일 이름은 CC 세션 UUID이며, 필드가 포함된 모든 메터 행에 대해 세션별 attribution을 복구합니다.

### `upstream-error-log` 확장 (200이 아닌 응답 캡처)

위의 `usage-log` 확장은 성공(200) 응답만 기록합니다. 200이 아닌 것들(429 용량 제한, 5xx 오류)은 디버그 로그에 구조화되지 않은 라인만 남습니다. 따라서 `usage.jsonl` 기반 분석에서는 서버 측 제한이 거의 보이지 않습니다.

`upstream-error-log`(v4.2.0에서 선택적)는 모든 `status >= 400`에 대해 구조화된 기록을 `~/.claude/usage-log/upstream-errors.jsonl`에 출력합니다. 두 가지 다른 429 클래스는 사용자에게 동일하게 보입니다 — **계정/사용 한도**는 `anthropic-ratelimit-unified-*` 헤더 + `retry-after`를 포함합니다; **인프라/용량**은 Cloudflare 전면이며, `x-should-retry: true`만 포함하고, NO 비율 제한 헤더(“서버가 요청을 일시적으로 제한하고 있습니다. 사용자 한도가 아닙니다” 케이스). 구분자는 `has_ratelimit_headers`(bool): 헤더가 있으면 → 사용 한도; 없으면 → 용량 이벤트.

환경 변수로 선택적 활성화; 기본적으로 꺼져 있습니다:

```bash
export CACHE_FIX_UPSTREAM_ERROR_LOG=on
```

| 환경 변수 | 기본값 | 목적 |
|---|---|---|
| `CACHE_FIX_UPSTREAM_ERROR_LOG` | `off` | 마스터 게이트 — `on` 활성화 캡처 |
| `CACHE_FIX_UPSTREAM_ERROR_LOG_PATH` | `~/.claude/usage-log/upstream-errors.jsonl` | 로그 경로 재정의 |

행당 기록 필드: `schema_version`, `ts`, `type`, `session_id`, `requested_model`, `request_path`, `response_status`, `upstream_message`, `has_ratelimit_headers`, `ratelimit_status`, `ratelimit_overage_status`, `x_should_retry`(문자열에서 bool로 정규화), `retry_after`, `upstream_request_id`, `upstream_connection_id`.

이것은 기존 `rate-limit-log` 확장의 **슈퍼셋**입니다 — `rate-limit-log`는 표준 `rate_limit_error` 본문 래퍼에만 트리거되고 용량 클래스 429는 본문 모양이 다르므로 누락됩니다; `upstream-error-log`는 모든 `status >= 400`에 대해 트리거되며 본문 모양과 관계없이 작동합니다. 독립적인 JSONL 스트림이며, 분석가는 `session_id + ts`로 조인합니다. 두 가지 모두 동시에 활성화할 수 있으며 상호 간섭이 없습니다.

### 프록시 소유 OAuth 새로 고침 (선택적)

기본적으로 꺼진 하위 시스템으로, cache-fix 프록시는 `~/.claude/.credentials.json`의 OAuth 자격 증명을 단일, 적극적이고 잠금 협력 갱신자로 만듭니다. 동일한 OS 사용자로 실행되는 모든 동시 Claude Code 클라이언트를 401로 회수하고, 클라이언트 측 재시작으로 복구할 수 없는 실패(오직 대화형 `/login`만 가능)를 일으킬 수 있는 갱신 토큰 회전 경쟁을 닫습니다.

경쟁: Anthropic의 갱신 토큰은 모든 사용 시 회전됩니다. 성공적인 갱신은 새로운 액세스 토큰과 새로운 갱신 토큰을 반환하여 이전 토큰을 무효화합니다; 소비된 갱신 토큰을 재사용하는 것은 도둑질로 간주되어 전체 패밀리를 회수합니다. N 클라이언트가 하나의 `~/.claude/.credentials.json`을 공유하고 액세스 토큰이 만료되면(~8h 주기), 두 클라이언트가 동일한 갱신 토큰을 POST할 수 있습니다 — 서버는 재사용을 감지하고 둘 다 회수합니다. 이후 파일의 갱신 토큰은 죽습니다; 오직 대화형 `/login`만 복구합니다.

최근 Claude Code 바이너리(2.1.148+)는 `proper-lockfile`을 통해 교차 프로세스 `~/.claude/.oauth_refresh.lock`을 제공하지만, 10초 스테일-브레이크 창이 있습니다. 10초 이상 실행되는 갱신 POST는 깨어난 클라이언트가 잠금 없이 진행하고 동일한 토큰을 POST하여 경쟁이 다시 발생합니다.

이 확장은 프록시가 적극적인 단일-갱신자로 만듭니다: 공유 토큰을 갱신하고, 갱신 중에 클라이언트의 자체 `.oauth_refresh.lock`을 유지하므로, 깨어난 클라이언트는 새로운 토큰을 발견하고 POST하지 않고 단절합니다. 정확히 하나의 파티가 토큰 엔드포인트에 도달 → 이중 지출 없음 → 패밀리 회수 없음.

환경 변수로 선택적 활성화; 기본적으로 꺼져 있습니다:

```bash
export CACHE_FIX_OAUTH_REFRESH=on
```

| 환경 변수 | 기본값 | 목적 |
|---|---|---|
| `CACHE_FIX_OAUTH_REFRESH` | `off` | 마스터 게이트 — `on` 활성화 갱신자 |
| `CACHE_FIX_OAUTH_CRED_PATH` | `~/.claude/.credentials.json` | 자격 증명 파일 경로 |
| `CACHE_FIX_OAUTH_TOKEN_URL` | `https://platform.claude.com/v1/oauth/token` | 토큰 엔드포인트 (테스트 재정의) |
| `CACHE_FIX_OAUTH_REFRESH_MARGIN_MS` | 7200000 (2h) | 만료가 이 창 내에 있을 때 갱신 |
| `CACHE_FIX_OAUTH_TICK_MS` | 300000 (5min) | 확인 간격 |
| `CACHE_FIX_OAUTH_POST_TIMEOUT_MS` | 8000 | 하드 갱신-POST 마감; **클라이언트의 10000 ms 스테일-브레이크보다 작아야 합니다** |

`CACHE_FIX_OAUTH_POST_TIMEOUT_MS`는 부하가 있습니다. 갱신 POST에는 헤더와 응답 본문 읽기를 포함하는 `AbortController` 타이머가 있습니다. 시간 초과 시 결과는 알 수 없습니다 — 서버가 토큰을 회전했는지 여부 — 따라서 프록시는 기록하지 않으며 재시도하지 않으며, 별도의 `oauth_refresh_timeout` 이벤트를 발생시키고 다음 시도 전에 최소한 하나의 전체 스테일 창을 백오프합니다. 타이밍 경쟁에서 프록시가 손실되는 경우, *다시 POST하지 않고* 손실됩니다.

`proper-lockfile`을 런타임 종속성으로 추가합니다(다른 런타임 종속성은 `hpagent`입니다).

운영 이벤트는 `~/.claude/cache-fix-oauth-events.jsonl`에 기록됩니다. 일곱 가지 이벤트 클래스: `oauth_refreshed`(일반), `oauth_family_revoked`(소리 있음 — 인간 `/login` 필요; stderr 배너도 기록), `oauth_refresh_timeout`(결과 알 수 없음 — 기록 없음, 재시도 없음), `oauth_refresh_error`(정상 실패 — 파일 유지, 다음 틱 시도), `oauth_refresh_skipped`(이미 회전되었거나 더 이상 필요하지 않음), `oauth_lock_contended`(다른 작성자가 잠금을 보유함), `oauth_cred_*`(유효성 검사 실패: 심볼릭 링크 거부, 모드 경고, 읽을 수 없음). 기록은 `{event, outcome, status_code, expires_at, err_class, elapsed_ms}`만 포함 — 절대 토큰 문자열, 원본 POST 본문, 원본 응답 본문 없음.

모든 자격 증명 읽기에 유효성 검사: 심볼릭 링크가 아니며, 모드 `0600`, 소유자-일치-uid, JSON-형식 유효. 원자 영구 저장: 임시-쓰기(모드 0600) + fsync FD + 이름 바꾸기 + 상위 디렉토리 fsync, 회전 중 다른 자격 증명 필드를 유지합니다.

백아웃: 게이트 해제 + 프록시 재시작 → 오늘과 동일하게 클라이언트가 자체 관리합니다(항상 파일을 읽으므로 복구는 자동입니다).

## 제한 사항

- **프록시는 실행 중인 프로세스가 필요합니다** — 프록시는 Claude Code보다 먼저 시작되어야 합니다. 실행되지 않고 `ANTHROPIC_BASE_URL`이 이를 가리키면 CC는 연결에 실패합니다. systemd 서비스로 실행하거나 건강 검사 래퍼 스크립트로 실행하는 것을 권장합니다.
- **과도 TTL 다운그레이드** — 5시간 할당량의 100%를 초과하면 서버에서 강제 TTL 다운그레이드가 1h에서 5m으로 발생합니다. 이는 서버 측이며 클라이언트 측에서는 수정할 수 없습니다. 프록시/인터셉터는 과도로 인해 캐시 불안정이 발생하는 것을 방지합니다.
- **마이크로 컴팩트는 방지할 수 없습니다** — 모니터링 기능은 컨텍스트 저하를 감지하지만 방지할 수 없습니다. 마이크로 컴팩트 및 예산 강제는 GrowthBook 플래그에 의해 서버에서 제어되며 클라이언트 측 비활성화 옵션은 없습니다.
- **시스템 프롬프트 재작성은 실험적입니다** — 사전 로드 전용, 선택적. 커뮤니티 보고서에서 논의된 동작 차이의 원인으로 증명되지 않았습니다. 사용 시 책임은 본인에게 있습니다.
- **버전 결합** — 지문 소금 및 블록 감지 휴리스틱은 Claude Code 내부에서 파생됩니다. 주요 리팩터링은 이 패키지 업데이트가 필요할 수 있습니다.

## 관련 연구

- **[@ArkNill/claude-code-hidden-problem-analysis](https://github.com/ArkNill/claude-code-hidden-problem-analysis)** — 38,996 요청 프록시 기반 분석: 7개 버그(마이크로 컴팩트, 예산 한도, 거짓 비율 제한기, JSONL 중복, 확장된 생각), GrowthBook 기능 플래그 인과 테스트, Opus 4.7 소모율 권고. v1.1.0의 모니터링 기능은 이 연구에 영향을 받았습니다.
- **[@Renvect/X-Ray-Claude-Code-Interceptor](https://github.com/Renvect/X-Ray-Claude-Code-Interceptor)** — 실시간 대시보드, 시스템 프롬프트 섹션 차이, 도구별 제거 임계값을 포함한 진단 HTTPS 프록시. `ANTHROPIC_BASE_URL`를 지원하는 모든 Claude 클라이언트에서 작동합니다.
- **[@fgrosswig/claude-usage-dashboard](https://github.com/fgrosswig/claude-usage-dashboard)** — SSE 실시간 모니터링, 다중 호스트 집계, 캐시 건강 점수를 포함한 자체 호스팅 증거 대시보드. 우리의 프록시 관점과 보완적입니다. 인터오프 설정은 [docs/dashboard-integration.md](docs/dashboard-integration.md) 참조.

## 프로덕션에서 사용

- **[Crunchloop DAP](https://dap.crunchloop.ai)** — 에이전트 SDK / DAP 개발 환경. 팀별 배포를 위해 인터셉터를 트렁크에 병합한 첫 번째 프로덕션 팀(2026-04-10). 실제 테스트를 통해 두 가지 다른 캐시 회귀 패턴을 식별했습니다 — 도구 정렬 진동 및 신선 세션 정렬 간격 — 그리고 v1.5.1 및 v1.6.2 수정을 위한 디버그 추적을 기여했습니다. Bun-컴파일 및 DAP 스타일 에이전트 바이너리 내에서 프록시를 실행할 수 있는 임베디드 프록시 팩토리를 기여했습니다(v3.6.0).
- **[VM Farms](https://vmfarms.com)** ([@vmfarms](https://github.com/vmfarms)) — `--resume --fork-session`으로 동시 다중 러너 워크로드를 실행하는 에이전트 개발 환경. 세 가지 cache-fix 프록시 모드 버그를 발견했습니다: 재개 마커 정규식 무작위(#96), 사전 로드 모드와의 TTL 레벨 감지 간격(#97), `CACHE_FIX_DEBUG`보다 이미지 제거 stderr 누출(#98) — 모두 v3.4.0 릴리스에서 해결되었습니다.

## 기여자

- **[@VictorSun92](https://github.com/VictorSun92)** — v2.1.88의 원래 몽키 패치 수정, v2.1.90에서 부분 산란 식별, 전방 스캔 감지, 올바른 블록 정렬, 더 긴 블록 매처 및 선택적 출력 효율성 재작성 훅 기여
- **[@bilby91](https://github.com/bilby91)** ([Crunchloop DAP](https://dap.crunchloop.ai)) — 에이전트 SDK / DAP 프로덕션 환경 검증, 1h 캐시 TTL 확인, 디버그 추적을 통한 도구 정렬 진동 발견(v1.5.1 수정), SKILLS SORT 진단을 통한 신선 세션 정렬 버그 발견(v1.6.2 수정). 인터셉터를 트렁크에 롤링한 첫 번째 프로덕션 팀. 임베디드 프록시 팩토리(`startProxy()` / `createProxyServer()`) 설계 및 기여(v3.6.0에서 배포됨, PR #123).
- **[@jmarianski](https://github.com/jmarianski)** — MITM 프록시 캡처 및 Ghidra 역공학을 통한 원인 분석, 다중 모드 캐시 테스트 스크립트
- **[@cnighswonger](https://github.com/cnighswonger)** — 지문 안정화, 도구 정렬 수정, 이미지 제거, 모니터링 기능, 과도 TTL 다운그레이드 발견, 프록시 아키텍처, 패키지 관리자
- **[@ArkNill](https://github.com/ArkNill)** — 마이크로 컴팩트 메커니즘 분석, GrowthBook 플래그 문서화, 거짓 비율 제한기 식별, CC v2.1.108+ 지문 검증 수정(PR #21), 한국어 README(PR #22), [claude-code-hidden-problem-analysis](https://github.com/ArkNill/claude-code-hidden-problem-analysis) 연구
- **[@Renvect](https://github.com/Renvect)** — 이미지 중복 발견, 크로스 프로젝트 디렉토리 오염 분석
- **[@fgrosswig](https://github.com/fgrosswig)** — [claude-usage-dashboard](https://github.com/fgrosswig/claude-usage-dashboard) 증거 방법론: 비용 요소 과도 비율 지표, `anthropic-*` 헤더 캡처 패턴, 우리의 대시보드 인터오프 레이어를 위한 프록시 NDJSON 스키마
- **[@TomTheMenace](https://github.com/TomTheMenace)** — Windows `.bat` 래퍼, 첫 번째 Windows 플랫폼 검증(7.5h/536-call Opus 4.6 세션, 98.4% 캐시 히트율)
- **[@arjansingh](https://github.com/arjansingh)** — 동적 `npm root -g` 경로 해석을 포함한 nvm 호환 래퍼 스크립트(PR #15)
- **[@beekamai](https://github.com/beekamai)** — npm root에 공백이 있는 경우 `claude-fixed.bat`의 Windows URL 인코딩 수정(PR #17)
- **[@JEONG-JIWOO](https://github.com/JEONG-JIWOO)** — VS Code 확장 조사: `claudeCode.claudeProcessWrapper`가 작업 통합 경로로 발견, Windows용 C 래퍼 작성(#16)
- **[@X-15](https://github.com/X-15)** — VS Code 확장 검증, v2.1.105에서 안전 검사 동작 확인(#16); VS Code 확장 자동 업데이트에서 빌드당 `cc_version` 캐시-버스트 패턴 발견(#238), v4.2.0에서 `cc-version-normalize` 확장으로 변경됨
- **[@deafsquad](https://github.com/deafsquad)** — 범용 smoosh_split 언-smoosh 수정(PR #26), 재개 산란 버그의 소스 수준 함수 어트리뷰션(anthropics/claude-code#43657), OTEL 원격 측정 발견, v3.0.0 프록시 아키텍처 제안 및 구축
- **[@vmfarms](https://github.com/vmfarms)** — 동시 다중 러너 프로덕션 검증, 프록시 모드 재개 마커 정규식 무작위(#96), TTL 레벨 감지 간격(#97), 이미지 제거 stderr 누출(#98)
- **[@ojura](https://github.com/ojura)** — Opus 4.7 생각 요약 원인 분석: CLI 바이너리 디코드(`!getIsNonInteractiveSession()` 게이트가 v2.1.142의 오프셋 230510599에 있음) 및 두 스택-특수 케이스 프레임워크를 제출하여 `thinking-display` 확장(v3.6.1)이 제안된 상류 수정의 깨끗한 프록시 측 보완이 되었습니다
- **[@yurukusa](https://github.com/yurukusa)** — [anthropics/claude-code#63147](https://github.com/anthropics/claude-code/issues/63147) 생각-비동기 슬릿에 대한 클러스터 분류: 13E (ToolSearch) 하위 패턴 합성으로 인해 `thinking-block-sanitize` v2 지시문 조건을 실현 가능하게 만들었습니다(cache-fix #171, v4.0.0에서 `=v2` 선택적 활성화로 배포됨)
- **[@schuay](https://github.com/schuay)** — `quota-statusline.sh` 개선: 10셀 할당량 바와 경과 시간 틱 및 소모-재설정 예측으로 이전 `%/min` 소모율 표시를 대체(PR #140, v3.6.2), d/h vs h/m 시간 형식 자동 선택 및 명명된 시간 단위 및 소모-난방 상수(PR #143, v3.7.0)
- **[@codeslake](https://github.com/codeslake)** — 원격 제어 / 모바일 세션 가시성 유지 프록시를 통한 전방 프록시 모드(HTTPS `CONNECT` + 상류 호스트 선택적 MITM) 선택적 활성화, CC >= 2.1.196에서 `ANTHROPIC_BASE_URL`-disables-RC 문제 해결(PR #251, #248 구현); 모든 디스크 프록시 상태에 대해 `CLAUDE_CONFIG_DIR` 존중하여 여러 구성 루트가 자격 증명/상태를 서로 덮어쓰지 않도록 함(PR #246)

이 문제에 대한 커뮤니티 노력에 기여했지만 이곳에 나열되지 않은 경우, 이슈나 PR을 열어주세요 — 모든 사람에게 적절한 명성을 부여하고 싶습니다.

## 지원

이 도구가 돈을 절약했다면 저에게 커피를 사주세요:

<a href="https://buymeacoffee.com/vsits" target="_blank"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me A Coffee" style="height: 60px !important;width: 217px !important;" ></a>

## 라이선스

[MIT](LICENSE)
