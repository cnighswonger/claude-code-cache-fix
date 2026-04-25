# claude-code-cache-fix

[![npm](https://img.shields.io/npm/v/claude-code-cache-fix?color=blue)](https://www.npmjs.com/package/claude-code-cache-fix) [![Node.js](https://img.shields.io/badge/Node.js-18%2B-green)](https://nodejs.org/) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow)](https://opensource.org/licenses/MIT) [![GitHub stars](https://img.shields.io/github/stars/cnighswonger/claude-code-cache-fix)](https://github.com/cnighswonger/claude-code-cache-fix/stargazers)

[English](./README.md) | [中文](./README.zh.md) | 한국어 | [Português](./docs/guia-pt-br.md)

[Claude Code](https://github.com/anthropics/claude-code)용 캐시 최적화 프록시입니다. 과도한 쿼터 소모를 유발하는 프롬프트 캐시 버그를 수정하고, 요청 접두사를 안정화하며, 자동 회귀를 모니터링합니다. v2.1.113+ Bun 바이너리를 포함한 모든 CC 버전에서 동작합니다.

> **v3.0.3** — 7개 핫리로드 확장을 갖춘 로컬 HTTP 프록시입니다. v2.1.117에서 A/B 테스트 결과: 첫 번째 웜 턴에서 **프록시 경유 95.5% 캐시 히트율 vs 직접 연결 82.3%**. [전체 릴리스 노트 →](https://github.com/cnighswonger/claude-code-cache-fix/releases/tag/v3.0.0)

> **Opus 4.7 주의사항:** 계측 데이터에 따르면 4.7은 동일한 가시 토큰 수 대비 **Q5h 쿼터를 4.6의 약 2.4배 속도로 소모**합니다([@ArkNill이 독립 확인](https://github.com/ArkNill/claude-code-hidden-problem-analysis/blob/main/16_OPUS-47-ADVISORY.md)). 두 가지 요인: 새 토크나이저(최대 35% 더 많은 토큰, [문서화됨](https://platform.claude.com/docs/en/about-claude/models/whats-new-claude-4-7))와 적응적 사고 오버헤드(약 105%, 사용량 응답에 미문서화). Q5h 영향은 **Q7d**(대부분의 헤비 유저가 먼저 도달하는 주간 쿼터 상한)에 복리로 누적됩니다. 우회 방법: `CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING=1`을 설정하면 소모율이 약 3.3배 감소하지만, 복잡한 작업에서 품질이 떨어질 수 있습니다. [Discussion #25](https://github.com/cnighswonger/claude-code-cache-fix/discussions/25)(초기 관찰)와 [Discussion #42](https://github.com/cnighswonger/claude-code-cache-fix/discussions/42)(통제된 A/B 데이터 + Q7d 분석)를 참조하십시오.

## 빠른 시작: 프록시 (권장)

프록시는 모든 CC 버전(Node.js 또는 Bun 바이너리)에서 동작합니다. Claude Code와 Anthropic API 사이에 위치하여 핫리로드 확장으로 캐시 수정을 적용합니다.

```bash
# 설치
npm install -g claude-code-cache-fix

# 프록시 시작 (localhost:9801에서 실행)
node "$(npm root -g)/claude-code-cache-fix/proxy/server.mjs" &

# 프록시를 경유하여 Claude Code 실행
ANTHROPIC_BASE_URL=http://127.0.0.1:9801 claude
```

이것으로 완료입니다. 프록시가 7개 캐시 수정 확장을 자동으로 적용합니다. 래퍼 스크립트, `NODE_OPTIONS`, 프리로드가 필요 없습니다.

### 프록시의 동작

모든 `/v1/messages` 요청에 7개 확장이 순서대로 실행됩니다:

| 확장 | 수정 대상 |
|------|----------|
| `fingerprint-strip` | 시스템 프롬프트에서 불안정한 cc_version 핑거프린트를 제거합니다 |
| `sort-stabilization` | 도구 및 MCP 정의의 결정적 순서를 보장합니다 |
| `ttl-management` | 서버 TTL 티어를 감지하고 올바른 cache_control 마커를 주입합니다 |
| `identity-normalization` | 접두사 안정성을 위해 메시지 ID 필드를 정규화합니다 |
| `fresh-session-sort` | 첫 번째 턴의 비결정적 순서를 수정합니다 |
| `cache-control-normalize` | 메시지 간 cache_control 마커를 정규화합니다 |
| `cache-telemetry` | 응답 헤더에서 캐시 통계를 추출하여 `~/.claude/quota-status.json`에 기록합니다 |

확장은 핫리로드됩니다 — `proxy/extensions/`에서 `.mjs` 파일을 추가, 제거 또는 수정하면 프록시 재시작 없이 다음 요청부터 적용됩니다. 설정은 `proxy/extensions.json`에 있습니다.

### 서비스로 실행

**Linux (systemd — 권장):**

`~/.config/systemd/user/cache-fix-proxy.service`를 생성합니다:

```ini
[Unit]
Description=Claude Code Cache Fix Proxy (v3.x)
After=network.target

[Service]
Type=simple
ExecStart=/usr/local/bin/node /path/to/claude-code-cache-fix/proxy/server.mjs
Restart=on-failure
RestartSec=5
Environment=CACHE_FIX_PROXY_PORT=9801

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now cache-fix-proxy

# 선택: 로그인 전 부팅 시 시작
sudo loginctl enable-linger $USER
```

`cache-fix-proxy install-service` 서브커맨드는 v3.1.0에서 계획 중입니다([#48](https://github.com/cnighswonger/claude-code-cache-fix/issues/48)).

**폴백 (모든 OS):**

```bash
nohup node "$(npm root -g)/claude-code-cache-fix/proxy/server.mjs" > /tmp/cache-fix-proxy.log 2>&1 &
echo 'export ANTHROPIC_BASE_URL=http://127.0.0.1:9801' >> ~/.bashrc
```

### 상태 확인

```bash
curl http://127.0.0.1:9801/health
# {"status":"ok"}
```

## 빠른 시작: 프리로드 (CC v2.1.112 이하)

Node.js 기반 CC 버전(v2.1.112 이하)을 사용 중이라면 프록시 없이 프리로드 인터셉터를 사용할 수 있습니다:

```bash
npm install -g claude-code-cache-fix
NODE_OPTIONS="--import claude-code-cache-fix" claude
```

> **참고:** 프리로드는 CC v2.1.113+(Bun 바이너리)에서 동작하지 않습니다. 위의 프록시를 사용하십시오.

래퍼 스크립트, 셸 별칭, Windows 설명, VS Code 프리로드 모드 연동은 [docs/preload-setup.md](docs/preload-setup.md)를 참조하십시오.

## VS Code 확장

[VS Code 확장](https://github.com/cnighswonger/claude-code-cache-fix-vscode)(v0.5.0)은 프록시와 프리로드 모드를 모두 지원합니다:

**프록시 모드 (권장):**
1. 프록시를 시작합니다(위 참조)
2. VS Code 명령 팔레트에서: **Claude Code Cache Fix: Enable Proxy Mode**
3. 활성 Claude Code 세션을 재시작합니다

**프리로드 모드 (CC ≤v2.1.112):**
1. `npm install -g claude-code-cache-fix`
2. [GitHub Releases](https://github.com/cnighswonger/claude-code-cache-fix-vscode/releases/latest)에서 VSIX를 다운로드합니다
3. 설치: `code --install-extension claude-code-cache-fix-0.5.0.vsix`
4. 명령 팔레트에서: **Claude Code Cache Fix: Enable**

VSIX 없이 수동 VS Code 래퍼를 설정하려면 [docs/preload-setup.md](docs/preload-setup.md#vs-code-preload-mode)를 참조하십시오.

## 보안 모델

> **프록시와 인터셉터는 API 요청 및 응답에 대한 전체 읽기/쓰기 접근 권한을 가집니다.** 이는 이 방식에 내재적인 것으로, 모든 fetch 인터셉터, 프록시, 게이트웨이가 이러한 위치를 가집니다.

**하는 것:** 캐시 버그 수정을 위해 발신 요청 구조(블록 순서, 핑거프린트, TTL, git-status)를 수정합니다. 모니터링을 위해 응답 헤더와 SSE 사용량 데이터를 읽습니다.

**하지 않는 것:** 프록시 또는 인터셉터에서 네트워크 호출을 하지 않습니다. 모든 텔레메트리는 `~/.claude/` 아래 로컬 파일에 기록됩니다. 데이터는 사용자의 컴퓨터를 떠나지 않습니다.

**공급망:** 프록시 모드: `proxy/extensions/`에 7개 소형 확장 모듈(각 200줄 미만). 프리로드 모드: 단일 비축소 파일(`preload.mjs`, ~1,700줄). 개발 의존성 1개(`zod`, 테스트 스키마 검증용). 설치 전 코드를 직접 검토하십시오. npm provenance로 각 버전이 소스 커밋에 연결됩니다.

**독립 감사:** @TheAuditorTool에 의해 ["LEGITIMATE TOOL"로 평가](https://github.com/anthropics/claude-code/issues/38335#issuecomment-4244413605) (2026-04-14).

## 문제점

Claude Code에서 `--resume` 또는 `/resume`를 사용하면 프롬프트 캐시가 자동으로 깨집니다. 캐시된 토큰을 읽는 대신(저렴) 매 턴마다 처음부터 재구축합니다(고비용). 시간당 약 $0.50이어야 할 세션이 아무런 표시 없이 $5-10/시간까지 치솟을 수 있습니다.

세 가지 버그가 원인입니다:

1. **블록 분산(Partial block scatter)** — 스킬 목록, MCP 서버, 지연 도구, 훅 등 첨부 블록이 `messages[0]`에 있어야 하지만, 세션 재개 시 이후 메시지로 이동하여 캐시 접두사가 변경됩니다.

2. **핑거프린트 불안정(Fingerprint instability)** — `cc_version` 핑거프린트(예: `2.1.92.a3f`)가 메타/첨부 블록을 포함한 `messages[0]` 내용으로 계산됩니다. 블록이 이동하면 핑거프린트가 바뀌고, 시스템 프롬프트가 바뀌고, 캐시가 무효화됩니다.

3. **도구 정의 순서 비결정적(Non-deterministic tool ordering)** — 도구 정의가 턴 간에 다른 순서로 도착할 수 있어 요청 바이트가 변경되고 캐시 키가 무효화됩니다.

또한 Read 도구로 읽은 이미지가 base64로 대화 기록에 저장되어 이후 모든 API 호출에 함께 전송되며, 토큰 비용이 자동으로 누적됩니다.

## 동작 원리

**프록시 모드** (v3.0.0+): `localhost:9801`의 HTTP 서버가 `POST /v1/messages` 요청을 인터셉트합니다. 7개 확장 모듈이 파이프라인을 통해 각 요청을 처리합니다 — 블록 순서 정규화, 핑거프린트 제거, 도구 정렬 안정화, TTL 마커 관리. 확장은 `proxy/extensions.json`에 설정된 핫리로드 `.mjs` 파일입니다. 그 외 모든 트래픽은 변경 없이 통과합니다.

**프리로드 모드** (v2.x): Claude Code가 API 호출을 하기 전에 `globalThis.fetch`를 패치하는 Node.js `--import` 모듈입니다. 동일한 수정을 인라인으로 적용합니다 — 사용자 메시지에서 재배치된 블록을 스캔하고, 도구를 정렬하고, 핑거프린트를 재계산하고, TTL 마커를 주입합니다.

두 모드 모두 멱등적입니다 — 수정이 필요 없으면 요청이 그대로 전달됩니다. 두 모드 모두 대화를 수정하지 않으며, API에 전달되기 전 요청 구조만 정규화합니다.

## 수정 졸업

이 패키지는 수명 주기가 다른 세 가지 목적을 수행합니다:

| 목적 | 예시 | 비활성화 시점 |
|------|------|-------------|
| **버그 수정** | 블록 재배치, 핑거프린트, 도구 정렬, TTL | CC가 근본 버그를 수정했을 때 — 상태 표시줄을 확인하십시오 |
| **모니터링** | 쿼터 추적, 마이크로컴팩트 감지, GrowthBook 플래그 | 영구 유지 — 향후 회귀를 감지합니다 |
| **최적화** | 이미지 제거, 출력 효율성 재작성 | 워크플로우에 도움이 되는 동안 유지하십시오 |

### 상태 확인 (프리로드 모드)

첫 API 호출 시 인터셉터가 상태 표시줄을 기록합니다(`CACHE_FIX_DEBUG=1` 필요):

```
cache-fix health: relocate=active(2h ago) fingerprint=dormant(5 clean sessions) tool_sort=active ttl=active identity=waiting
```

- **active(Xh ago)** — 수정이 최근에 적용됨
- **dormant(N clean sessions)** — N개 세션 동안 버그가 감지되지 않음; CC가 수정했을 수 있음
- **safety-blocked(Nx)** — 왕복 검증 실패; 수정이 자동 비활성화됨
- **waiting** — 수정이 아직 트리거되지 않음

### 회귀 감지

수정을 비활성화한 후 5회 이상 호출에서 cache_read 비율이 50% 미만으로 떨어지면:
```
REGRESSION WARNING: cache_read ratio averaged 12% across last 5 calls.
Fixes are disabled — consider re-enabling to recover cache performance.
```

## 안전성

### 핑거프린트 왕복 검증

`cc_version` 핑거프린트를 재작성하기 전에, 인터셉터는 하드코딩된 salt와 문자 인덱스가 Claude Code가 보낸 핑거프린트를 재현하는지 검증합니다. 검증이 실패하면(CC가 알고리즘을 변경한 경우) 재작성이 자동으로 건너뜁니다. 이로써 인터셉터가 기본 CC보다 캐시 성능을 *악화시키는* 일이 없도록 보장합니다.

### 페일세이프 설계

모든 수정은 실패 시 무작동(no-op)으로 전환되도록 설계되어 있습니다:
- 블록 감지 정규식이 매칭되지 않으면 → 블록이 재배치되지 않음 (CC 동작)
- 핑거프린트 형식이 변경되면 → 핑거프린트가 재작성되지 않음 (CC 동작)
- 도구 정렬이 변경 사항을 생성하지 않으면 → 페이로드가 그대로 전달됨
- TTL 주입 대상 구조가 변경되면 → TTL이 주입되지 않음 (CC 동작)

인터셉터는 *도움을 주거나* *아무것도 하지 않습니다*. 상황을 악화시킬 수 없습니다.

## 상태 표시줄 — 실시간 쿼터 경고

프록시와 프리로드 모드 모두 매 API 호출마다 `~/.claude/quota-status.json`에 쿼터 상태를 기록합니다. 포함된 `tools/quota-statusline.sh` 스크립트로 실시간 상태를 표시할 수 있습니다:

- **Q5h %** (소진율, %/분)
- **Q7d %** (소진율, %/시간)
- **TTL 티어** — 정상 시 `TTL:1h`, **서버 다운그레이드 시 빨간색 `TTL:5m`** (일반적으로 Q5h ≥ 100% 시)
- **PEAK** — 평일 피크 시간(UTC 13:00-19:00) 시 노란색 표시
- **캐시 히트율 %**
- **OVERAGE** 플래그 (활성 시)

### 설정

```bash
mkdir -p ~/.claude/hooks
cp "$(npm root -g)/claude-code-cache-fix/tools/quota-statusline.sh" ~/.claude/hooks/
chmod +x ~/.claude/hooks/quota-statusline.sh
```

`~/.claude/settings.json`에 추가합니다:

```json
{
  "statusLine": {
    "type": "command",
    "command": "~/.claude/hooks/quota-statusline.sh"
  }
}
```

### 상태 표시줄이 중요한 이유

서버가 TTL을 5m으로 다운그레이드하면(Q5h ≥ 100%에서 쿼터 인식 다운그레이드), **5분 이상의 모든 유휴 시간이 전체 컨텍스트 재구축을 유발합니다**. 상태 표시줄이 없으면 이는 보이지 않습니다. 상태 표시줄의 빨간색 `TTL:5m` 경고는 **작업을 중단하고, Q5h 윈도우가 리셋될 때까지 기다린 후 재개하라**는 신호입니다. 초과 상태에서 작업을 계속하면 소모가 복리로 누적되지만, 일시 중지하면 악순환이 끊깁니다.

### 권장: git-status 주입 비활성화

Claude Code는 매 호출마다 `git status` 출력을 시스템 프롬프트에 주입합니다. 파일 편집 시마다 git 상태가 바뀌어 전체 접두사 캐시가 무효화됩니다. 비활성화하면 호출당 약 1,800 토큰을 절약합니다:

```bash
export CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS=1
```

또는 `~/.claude/settings.json`에 `"includeGitInstructions": false`를 추가하십시오. Claude Code는 컨텍스트가 필요할 때 Bash 도구를 통해 `git status`를 직접 실행할 수 있습니다. [@wadabum](https://github.com/cnighswonger/claude-code-cache-fix/issues/11)이 커뮤니티 검증: git 상태 변경 시 캐시 생성 18토큰(이 플래그 없이는 수천 토큰).

## 이미지 제거 (프리로드 모드)

Read 도구로 읽은 이미지는 base64로 인코딩되어 대화 기록에 저장되며, 이후 모든 API 호출에 함께 전송됩니다. 500KB 이미지 하나가 Opus 4.6에서 턴당 약 62,500 토큰, **Opus 4.7에서는 새 토크나이저로 인해 약 85,000+ 토큰**의 추가 비용을 발생시킵니다. 4.7에서는 이미지 제거를 강력히 권장합니다.

```bash
export CACHE_FIX_IMAGE_KEEP_LAST=3
```

최근 3개 사용자 메시지의 이미지를 유지하고 이전 것은 텍스트 자리 표시자로 대체합니다. `tool_result` 블록만 대상이며, 사용자가 직접 붙여넣은 이미지는 영향받지 않습니다.

## 시스템 프롬프트 재작성 (프리로드 모드, 선택)

인터셉터가 Claude Code의 `# Output efficiency` 시스템 프롬프트 섹션을 재작성할 수 있습니다. 기본 비활성화입니다. `CACHE_FIX_OUTPUT_EFFICIENCY_REPLACEMENT`로 활성화하십시오. 세 가지 알려진 프롬프트 변형과 사용법은 [docs/output-efficiency-prompts.md](docs/output-efficiency-prompts.md)를 참조하십시오.

## 모니터링 & 진단

프리로드 인터셉터에는 마이크로컴팩트 열화, 가상 속도 제한기, GrowthBook 플래그 상태, 사용량 텔레메트리, 비용 리포트에 대한 모니터링이 포함됩니다. 쿼터 추적은 프록시와 프리로드 모드 모두에서 `~/.claude/quota-status.json`을 통해 동작합니다.

전체 상세, 디버그 모드, 접두사 비교, 환경 변수, 내장 쿼터 분석 도구는 [docs/monitoring.md](docs/monitoring.md)를 참조하십시오.

## 제한 사항

- **프록시는 실행 프로세스가 필요합니다** — Claude Code보다 먼저 프록시를 시작해야 합니다. 프록시가 실행 중이지 않은데 `ANTHROPIC_BASE_URL`이 이를 가리키면 CC가 연결에 실패합니다. systemd 서비스 또는 상태 확인 래퍼 스크립트로 실행하는 것을 권장합니다.
- **초과 TTL 다운그레이드** — 5시간 쿼터 100% 초과 시 서버가 TTL을 1h에서 5m으로 강제 다운그레이드합니다. 서버 측 결정이므로 클라이언트에서 수정할 수 없습니다. 프록시/인터셉터는 초과 상태로 밀어넣을 수 있는 캐시 불안정을 사전에 방지합니다.
- **마이크로컴팩트 방지 불가** — 모니터링은 컨텍스트 열화를 감지할 수 있지만 방지할 수는 없습니다. 마이크로컴팩트와 예산 집행은 클라이언트 비활성화 옵션이 없는 GrowthBook 플래그를 통한 서버 제어입니다.
- **시스템 프롬프트 재작성은 실험적입니다** — 프리로드 전용, 선택적. 커뮤니티 보고에서 논의된 동작 차이의 원인으로 입증되지 않았습니다. 사용자 책임하에 사용하십시오.
- **버전 결합** — 핑거프린트 salt와 블록 감지 휴리스틱은 Claude Code 내부 구현에서 파생됩니다. 대규모 리팩토링 시 이 패키지 업데이트가 필요할 수 있습니다.

## 추적 이슈

캐시, 쿼터, 컨텍스트 버그와 관련된 30개 이상의 upstream Claude Code 이슈를 모니터링하고 있습니다. 전체 목록, 관여 현황, 커뮤니티 리서치, 주요 기여자는 [TRACKED_ISSUES.md](TRACKED_ISSUES.md)를 참조하십시오.

## 관련 리서치

- **[@ArkNill/claude-code-hidden-problem-analysis](https://github.com/ArkNill/claude-code-hidden-problem-analysis)** — 38,996건 프록시 기반 분석: 7개 버그(마이크로컴팩트, 예산 상한, 가상 속도 제한기, JSONL 중복, 확장 사고), GrowthBook 기능 플래그 인과 테스트, Opus 4.7 소모율 주의보. v1.1.0 모니터링 기능은 이 리서치에 기반합니다.
- **[@Renvect/X-Ray-Claude-Code-Interceptor](https://github.com/Renvect/X-Ray-Claude-Code-Interceptor)** — 실시간 대시보드가 있는 진단용 HTTPS 프록시, 시스템 프롬프트 섹션 비교, 도구별 제거 임계값. `ANTHROPIC_BASE_URL`을 지원하는 모든 Claude 클라이언트에서 동작합니다.
- **[@fgrosswig/claude-usage-dashboard](https://github.com/fgrosswig/claude-usage-dashboard)** — 셀프 호스팅 포렌식 대시보드, SSE 실시간 모니터링, 멀티호스트 집계, 캐시 건전성 점수화. 프록시의 관점과 상호 보완적입니다. 연동 설정은 [docs/dashboard-integration.md](docs/dashboard-integration.md)를 참조하십시오.

## 프로덕션 사용

- **[Crunchloop DAP](https://dap.crunchloop.ai)** — Agent SDK / DAP 개발 환경. 팀 전체 배포를 위해 인터셉터를 트렁크에 머지한 최초의 프로덕션 팀(2026-04-10). 실제 테스트를 통해 두 가지 캐시 회귀 패턴(도구 순서 흔들림, 새 세션 정렬 갭)을 식별하고, v1.5.1과 v1.6.2 수정을 이끈 디버그 트레이스를 기여했습니다.

## 기여자

- **[@VictorSun92](https://github.com/VictorSun92)** — v2.1.88 최초 monkey-patch 수정, v2.1.90에서 부분 분산 식별, 전방 스캔 감지, 올바른 블록 순서, 더 엄격한 블록 매처, 선택적 출력 효율성 재작성 훅 기여
- **[@bilby91](https://github.com/bilby91)** ([Crunchloop DAP](https://dap.crunchloop.ai)) — Agent SDK / DAP 프로덕션 환경 검증, 1시간 캐시 TTL 확인, 디버그 트레이스를 통한 도구 순서 흔들림 발견(v1.5.1에서 수정), SKILLS SORT 진단을 통한 새 세션 정렬 버그 발견(v1.6.2에서 수정). 인터셉터를 트렁크에 배포한 최초의 프로덕션 팀
- **[@jmarianski](https://github.com/jmarianski)** — MITM 프록시 캡처 및 Ghidra 역공학을 통한 근본 원인 분석, 다중 모드 캐시 테스트 스크립트
- **[@cnighswonger](https://github.com/cnighswonger)** — 핑거프린트 안정화, 도구 순서 수정, 이미지 제거, 모니터링 기능, 초과 TTL 다운그레이드 발견, 프록시 아키텍처, 패키지 관리자
- **[@ArkNill](https://github.com/ArkNill)** — 마이크로컴팩트 메커니즘 분석, GrowthBook 플래그 문서화, 가상 속도 제한기 식별, CC v2.1.108+ 핑거프린트 검증 수정(PR #21), 한국어 README(PR #22), [claude-code-hidden-problem-analysis](https://github.com/ArkNill/claude-code-hidden-problem-analysis) 리서치
- **[@Renvect](https://github.com/Renvect)** — 이미지 중복 발견, 프로젝트 간 디렉토리 오염 분석
- **[@fgrosswig](https://github.com/fgrosswig)** — [claude-usage-dashboard](https://github.com/fgrosswig/claude-usage-dashboard) 포렌식 방법론: 비용 팩터 오버헤드 비율 메트릭, `anthropic-*` 헤더 캡처 패턴, 대시보드 연동 레이어에 참고가 된 프록시 NDJSON 스키마
- **[@TomTheMenace](https://github.com/TomTheMenace)** — Windows `.bat` 래퍼, 최초 Windows 플랫폼 검증(7.5시간/536호출 Opus 4.6 세션, 98.4% 캐시 히트율)
- **[@arjansingh](https://github.com/arjansingh)** — 동적 `npm root -g` 경로 해석이 있는 nvm 호환 래퍼 스크립트(PR #15)
- **[@beekamai](https://github.com/beekamai)** — npm root에 공백이 포함된 경우의 Windows URL 인코딩 수정(PR #17)
- **[@JEONG-JIWOO](https://github.com/JEONG-JIWOO)** — VS Code 확장 조사: `claudeCode.claudeProcessWrapper`를 동작하는 통합 경로로 발견, Windows용 C 래퍼 작성(#16)
- **[@X-15](https://github.com/X-15)** — VS Code 확장 검증, v2.1.105에서 안전 검사 동작을 확인한 수정별 상태 분석(#16)
- **[@deafsquad](https://github.com/deafsquad)** — 범용 smoosh_split un-smoosh 수정(PR #26), 세션 재개 분산 버그의 소스 수준 함수 귀속(anthropics/claude-code#43657), OTEL 텔레메트리 발견, v3.0.0 프록시 아키텍처 제안 및 구축

이 이슈들에 대한 커뮤니티 노력에 기여하셨는데 여기에 이름이 없다면, 이슈 또는 PR을 열어주십시오 — 모든 분을 올바르게 크레딧하고 싶습니다.

## 지원

이 도구가 비용 절감에 도움이 되었다면, 커피 한 잔 사주시는 것을 고려해 주십시오:

<a href="https://buymeacoffee.com/vsits" target="_blank"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me A Coffee" style="height: 60px !important;width: 217px !important;" ></a>

## 라이선스

[MIT](LICENSE)
