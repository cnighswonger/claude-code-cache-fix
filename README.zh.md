# claude-code-cache-fix

[![npm](https://img.shields.io/npm/v/claude-code-cache-fix?color=blue)](https://www.npmjs.com/package/claude-code-cache-fix) [![Node.js](https://img.shields.io/badge/Node.js-18%2B-green)](https://nodejs.org/) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow)](https://opensource.org/licenses/MIT) [![GitHub stars](https://img.shields.io/github/stars/cnighswonger/claude-code-cache-fix)](https://github.com/cnighswonger/claude-code-cache-fix/stargazers)

[English](./README.md) | 中文 | [한국어](./README.ko.md) | [Português](./docs/guia-pt-br.md)

为 [Claude Code](https://github.com/anthropics/claude-code) 打造的缓存优化代理。修复导致额度过度消耗的提示缓存 bug，稳定请求前缀，并监控静默回归。兼容所有 CC 版本，包括 v2.1.113+ 的 Bun 二进制版。

> **v3.0.3** — 本地 HTTP 代理，含 7 个热重载扩展。在 v2.1.117 上经过 A/B 测试：**首次预热轮次中，通过代理的缓存命中率为 95.5%，直连为 82.3%**。[完整发布说明 →](https://github.com/cnighswonger/claude-code-cache-fix/releases/tag/v3.0.0)

> **Opus 4.7 警示：** 计量数据显示，对于等量可见 token，4.7 消耗 Q5h 额度的速率约为 4.6 的 **~2.4 倍**（[由 @ArkNill 独立确认](https://github.com/ArkNill/claude-code-hidden-problem-analysis/blob/main/16_OPUS-47-ADVISORY.md)）。两个因素：新的分词器（最多出 35% 的 token，[已有文档说明](https://platform.claude.com/docs/en/about-claude/models/whats-new-claude-4-7)）和自适应思考开销（约 105%，未在使用量响应中文档化）。Q5h 的影响会累积到 **Q7d**——大多数重度用户最先触及的周额度上限。变通方案：`CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING=1` 可将消耗降低约 3.3 倍，但可能在复杂任务上降低质量。参见 [讨论 #25](https://github.com/cnighswonger/claude-code-cache-fix/discussions/25)（初步观察）和 [讨论 #42](https://github.com/cnighswonger/claude-code-cache-fix/discussions/42)（受控 A/B 数据 + Q7d 分析）。

---

## 快速上手：代理模式（推荐）

代理适用于任何 CC 版本——Node.js 或 Bun 二进制版本均可。它位于 Claude Code 和 Anthropic API 之间，以热重载扩展的形式应用缓存修复。

```bash
# 安装
npm install -g claude-code-cache-fix

# 启动代理（在 localhost:9801 上运行）
node "$(npm root -g)/claude-code-cache-fix/proxy/server.mjs" &

# 通过代理启动 Claude Code
ANTHROPIC_BASE_URL=http://127.0.0.1:9801 claude
```

就这样。代理会自动应用全部 7 个缓存修复扩展。无需包装脚本、无需 `NODE_OPTIONS`、无需预加载。

### 代理做了什么

每次 `/v1/messages` 请求上，9 个扩展按顺序执行（其中一个需主动选择）：

| 扩展                      | 修复内容                                                                                                                                   |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `fingerprint-strip`       | 从系统提示中移除不稳定的 cc_version 指纹                                                                                                   |
| `sort-stabilization`      | 对工具和 MCP 定义进行确定性排序                                                                                                            |
| `ttl-management`          | 检测服务器 TTL 等级，注入正确的 cache_control 标记                                                                                          |
| `identity-normalization`  | 规范化消息身份字段以保持前缀稳定                                                                                                           |
| `fresh-session-sort`      | 修复首次轮次中的非确定性排序                                                                                                               |
| `cache-control-normalize` | 规范化消息间的 cache_control 标记                                                                                                          |
| `cache-telemetry`         | 从响应头中提取缓存统计 → `~/.claude/quota-status/{account.json,sessions/<id>.json}`                                                        |
| `session-health`          | 观察每个会话的 thinking-desync 风险（上下文大小 + thinking 块数量），并在会话进入危险区域前发出警告。只读                                  |
| `thinking-block-sanitize` | 丢弃已省略（空文本）的 thinking 块，以预先阻止 CC thinking-desync `400` 错误（#63147）。**需主动选择**（`CACHE_FIX_THINKING_SANITIZE=on`） |

扩展支持热重载——在 `proxy/extensions/` 中添加、删除或修改 `.mjs` 文件，更改会在下一次请求时生效，无需重启。配置位于 `proxy/extensions.json`。

**正在开发新扩展？** 参见 [docs/parallel-proxy-test-harness.md](docs/parallel-proxy-test-harness.md)，了解我们在不干扰生产代理的情况下，使用真实 `claude -p` 流量端到端测试扩展的模式。

### 以服务方式运行

**推荐方式（Linux/macOS）——`install-service` 子命令：**

```bash
cache-fix-proxy install-service
```

自动检测您的平台并写入相应配置：

- **Linux** → `~/.config/systemd/user/cache-fix-proxy.service`（systemd 用户单元）
- **macOS** → `~/Library/LaunchAgents/com.cnighswonger.cache-fix-proxy.plist`（launchd 代理）

输出会打印启用和启动服务的后续命令。在 Linux 上：

```bash
systemctl --user daemon-reload
systemctl --user enable --now cache-fix-proxy
systemctl --user enable --now cache-fix-proxy-healthcheck.timer  # 自动恢复——见下文
sudo loginctl enable-linger $USER  # 可选：在开机时启动，而非仅在登录时启动
```

**自动恢复（Linux）：** `install-service` 还会放置一个健康检查伴生项（`cache-fix-proxy-healthcheck.service` + `.timer`）。定时器每 2 分钟触发一次；oneshot 服务运行 `curl -fs http://127.0.0.1:<port>/health`，如果探测失败则执行 `systemctl --user start cache-fix-proxy.service`。这可以在 2 分钟内从任何停止中恢复代理——无论是正常还是异常、预期还是意外的停止。背景说明：`Restart=on-failure` 不会在正常停止时触发，所以在有此伴生项之前，任何来源的 `systemctl stop`（包括 2026 年 4 月 25 日 Anthropic 宕机期间的不明来源停止）都会让代理无限期宕机。macOS 不需要伴生项——launchd 的 `KeepAlive` 已经会在任何退出时自动重启。

在 macOS 上：

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.cnighswonger.cache-fix-proxy.plist
launchctl enable gui/$(id -u)/com.cnighswonger.cache-fix-proxy
launchctl kickstart gui/$(id -u)/com.cnighswonger.cache-fix-proxy
```

安装的配置会在安装时从环境变量中读取 `CACHE_FIX_PROXY_PORT`、`CACHE_FIX_PROXY_UPSTREAM` 和 `CACHE_FIX_DEBUG`。在环境变量变更后，重新运行 `install-service --force` 以重新生成，或直接编辑服务文件。配合 `cache-fix-proxy uninstall-service` 可干净移除（停止、禁用、删除）。

该服务在前台运行 `cache-fix-proxy server`，这仅是代理本身，不含包装模式的 claude 启动器。

**手动方式（任意平台）：**

```bash
nohup cache-fix-proxy server > /tmp/cache-fix-proxy.log 2>&1 &
echo 'export ANTHROPIC_BASE_URL=http://127.0.0.1:9801' >> ~/.bashrc
```

### Docker

每次发布标签时，都会向 GitHub Container Registry 发布多架构（amd64、arm64）容器镜像。

```bash
docker run -d --name cache-fix-proxy \
 --restart=always \
 -p 9801:9801 \
 ghcr.io/cnighswonger/claude-code-cache-fix:latest

# 然后在您的 shell 中：
export ANTHROPIC_BASE_URL=http://127.0.0.1:9801
```

使用 `--restart=always` 代替 systemd 健康检查伴生项——Docker 原生处理自动恢复。无需挂载任何内容；容器是无状态的。使用 `-e CACHE_FIX_PROXY_PORT=...` 覆盖默认端口。使用 `-e CACHE_FIX_PROXY_UPSTREAM=http://host.docker.internal:8080` 覆盖上游地址（例如链式通过 llm-relay）。该镜像以非特权 `node` 用户（uid 1000）运行，并暴露一个 `HEALTHCHECK`，Docker 可用于存活探测。

对于 SSL 检测代理背后的企业环境，挂载您的 CA 包并设置环境变量：

```bash
docker run -d --name cache-fix-proxy --restart=always -p 9801:9801 \
 -e HTTPS_PROXY=http://proxy.corp.example:8080 \
 -e CACHE_FIX_PROXY_CA_FILE=/etc/ssl/corp-ca.pem \
 -v /path/to/zscaler-root.pem:/etc/ssl/corp-ca.pem:ro \
 ghcr.io/cnighswonger/claude-code-cache-fix:latest
```

镜像标签：`latest`、`3`、`3.2`、`3.2.1`（语义化版本阶梯，所以 `3` 始终指向最新的 3.x 版本）。`latest` 始终跟踪最新的标记发布。

**Linux 注意：** 下文链式上游 `host.docker.internal` 示例在 Docker Desktop（macOS / Windows）上是自动可用的。在纯 Linux Docker Engine 上，通常需要 `--add-host=host.docker.internal:host-gateway`，以便该名称解析到主机网桥。否则，容器的名称查找会失败，代理无法访问主机上运行的上游服务。将 cache-fix 代理链式通过主机上运行的 `llm-relay` 的示例：

```bash
docker run -d --name cache-fix-proxy --restart=always -p 9801:9801 \
 --add-host=host.docker.internal:host-gateway \
 -e CACHE_FIX_PROXY_UPSTREAM=http://host.docker.internal:8080 \
 ghcr.io/cnighswonger/claude-code-cache-fix:latest
```

### 健康检查

```bash
curl http://127.0.0.1:9801/health
# {"status":"ok"}
```

### 代理配置

所有代理设置均通过环境变量控制。在启动代理服务器之前设置它们。

| 变量                          | 默认值                      | 说明                                                           |
| ----------------------------- | --------------------------- | -------------------------------------------------------------- |
| `CACHE_FIX_PROXY_PORT`        | `9801`                      | 监听端口                                                       |
| `CACHE_FIX_PROXY_BIND`        | `127.0.0.1`                 | 绑定地址                                                       |
| `CACHE_FIX_PROXY_UPSTREAM`    | `https://api.anthropic.com` | 上游 URL。更改以链式另一个代理（例如 `http://localhost:8080`） |
| `CACHE_FIX_PROXY_TIMEOUT`     | `600000`                    | 请求超时时间（毫秒）                                             |
| `CACHE_FIX_EXTENSIONS_DIR`    | `proxy/extensions/`         | 扩展 `.mjs` 文件目录                                           |
| `CACHE_FIX_EXTENSIONS_CONFIG` | `proxy/extensions.json`     | 扩展配置文件                                                   |
| `CACHE_FIX_DEBUG`             | `0`                         | 启用调试日志                                                   |

### 企业环境（代理、自定义 CA）

代理在转发到 `api.anthropic.com` 时遵循以下环境变量。在 Zscaler / Netskope / Forcepoint / Bluecoat / 企业级 squid 代理后面时，在代理的环境中设置这些变量。

| 变量                                        | 效果                                                                                   |
| ------------------------------------------- | -------------------------------------------------------------------------------------- |
| `HTTPS_PROXY` / `HTTP_PROXY`（及其小写变体） | 通过企业 HTTP CONNECT 代理路由上游请求。                                                |
| `NO_PROXY`                                  | 逗号分隔的绕过代理的主机列表。支持 `*` 和 `.suffix.example.com`。                      |
| `CACHE_FIX_PROXY_CA_FILE`                   | 包含一个或多个额外 CA 证书的 PEM 文件路径（用于 SSL 检测代理）。                       |
| `NODE_EXTRA_CA_CERTS`                       | Node 标准机制——同样被遵循。                                                            |
| `CACHE_FIX_PROXY_REJECT_UNAUTHORIZED=0`     | **不安全的逃生门。** 禁用 TLS 验证。仅作为最后手段使用，在等待 IT 提供企业 CA 包期间。 |

示例（Windows PowerShell）：

```powershell
$env:HTTPS_PROXY = 'http://proxy.corp.example:8080'
$env:NO_PROXY   = 'localhost,127.0.0.1,.corp.example'
$env:CACHE_FIX_PROXY_CA_FILE = 'C:\corp\zscaler-root.pem'
node "$(npm root -g)\claude-code-cache-fix\proxy\server.mjs"
```

当代理正确配置后，首次请求时 stderr 会打印 `[upstream] using proxy http://proxy.corp.example:8080 ...`。如果没有设置代理/CA 环境变量，行为与早期版本相同（Node 默认代理、系统信任存储）。

### 在您自己的进程中嵌入代理

如果您交付的 Node 或 Bun 二进制文件需要在进程内运行 cache-fix 代理（例如，避免 fork 出 Node 子进程的 Bun 编译代理），可以从 `claude-code-cache-fix/proxy/server` 导入工厂函数：

```js
import { startProxy } from "claude-code-cache-fix/proxy/server";

const handle = await startProxy({
  port: 0, // 操作系统分配的临时端口；传入数字以指定端口
  bind: "127.0.0.1",
  watch: false, // 跳过 fs.watch——推荐用于编译后的二进制文件
});

console.log(`proxy listening on ${handle.address}:${handle.port}`);

// ...之后...
await handle.close();
```

**`createProxyServer()` → `http.Server`** 构建一个连接到 `http.Server` 的请求处理器。返回的服务器*尚未*监听，扩展管道也尚未加载——当您想自己管理生命周期时使用此项。

**`startProxy(options?)` → `Promise<{ server, port, address, close }>`** 加载扩展管道，可选地启动文件监视器，并开始监听。返回一个包含绑定端口（当请求 `port: 0` 时解析得到）的句柄，以及释放服务器和监视器的 `close()` 方法。

选项（全部可选；全部回退到 CLI 使用的相同环境变量）：

| 选项               | 默认值                                            | 效果                                                                 |
| ------------------ | ------------------------------------------------- | -------------------------------------------------------------------- |
| `port`             | `CACHE_FIX_PROXY_PORT` 环境变量，否则 `9801`      | 监听端口。传入 `0` 以使用操作系统分配的临时端口。                    |
| `bind`             | `CACHE_FIX_PROXY_BIND` 环境变量，否则 `127.0.0.1` | 绑定地址。                                                           |
| `extensionsDir`    | 包内的 `proxy/extensions/`                        | 加载 `.mjs` 扩展的目录。                                             |
| `extensionsConfig` | 包内的 `proxy/extensions.json`                    | 扩展配置文件路径。                                                   |
| `watch`            | `true`                                            | 是否在扩展配置上启动 `fs.watch`。嵌入/编译二进制使用时设为 `false`。 |

**每个进程一个扩展注册表。** 管道在模块作用域维护一个共享的扩展注册表。在同一进程中托管两个 `startProxy()` 实例是受支持的（不同端口、不同绑定地址），但它们共享该注册表——后续的 `loadExtensions` 调用会为两者替换它。如果您需要每个实例使用不同的扩展配置，请在单独的进程中运行它们。

**CLI 调用方式不变。** `node proxy/server.mjs`、`cache-fix-proxy server` 以及包装器的子进程 fork 路径都像之前一样自动监听并安装 SIGTERM/SIGINT 处理器。库导入绝不会触发该行为——自动监听受主模块检查的保护。

_可嵌入工厂函数由 [Crunchloop DAP](https://dap.crunchloop.ai) 的 [@bilby91](https://github.com/bilby91) 贡献——参见 [PR #123](https://github.com/cnighswonger/claude-code-cache-fix/pull/123)。_

---

## 此代理防御的内容

**缓存经济性回归。** cache-fix 的最初目的是吸收 Claude Code 中导致用户损失真金白银和额度的缓存处理行为——TTL 降级、破坏缓存的请求头抖动、身份锁定问题，以及在我们 issue 历史中记录的其他回归目录。代理位于 CC 和 Anthropic API 之间，规范化请求和响应流，并发出足够的可观测性（通过状态行集成和 quota-status 文件），使用户能够看到会话实际在做的事情。这是当今几乎所有用户的核心功能。

**Bootstrap 通道可观测性。** Claude Code v2.1.150 引入了一个提示段消费者，从 `/api/claude_cli/bootstrap` 获取服务器提供的字符串并将其合并到代理的行为指令提示路径中。我们于 2026 年 5 月向 Anthropic 的安全团队报告了此行为；Anthropic 以 _信息性（Informative）_ 结案，将 TLS 视为传输完整性边界，并拒绝添加应用层真实性检查。cache-fix v3.7.0 为此路径添加了显式处理。v3.7.1 扩展了此处理，以覆盖 CC v2.1.152 中引入的由环境变量选择的 GrowthBook 提示注入面（远程控制模式：`CLAUDE_CODE_SYSTEM_PROMPT_GB_FEATURE` 指定一个标志键，其缓存值被用作系统提示体）。

cache-fix 的 `bootstrap-defense` 扩展提供三种模式，通过 `CACHE_FIX_BOOTSTRAP_MODE` 选择：

| 模式        | 默认？             | 行为                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `audit`     | 是                 | Bootstrap 响应代理透传至 CC。每条响应记录到 `~/.claude/cache-fix-bootstrap-log.jsonl`，包含表面元数据：哪些提示源表面被触发（`tengu_heron_brook` 旧版和/或环境变量选择），值的 SHA-256 哈希（前 16 个十六进制字符——从不记录值本身），以及 `CLAUDE_CODE_REMOTE` 标志。多表面响应每个表面发出一记录，通过 `request_id` + 时间戳窗口关联。                                                                                       |
| `block`     | 主动选择           | `onRequest` 返回 200 及空 JSON 体。绝不调用上游，任何标志映射绝不触及磁盘上的 GrowthBook 缓存。同时防御旧版和环境变量选择的注入面。                                                                                                                                                                                                                                                                                           |
| `allowlist` | 主动选择（实验性） | Bootstrap 响应代理透传，但不在允许列表中的提示源合格键（旧版 `tengu_heron_brook` + 环境变量选择的键）在到达 CC 前从响应体中剥离。默认允许列表为 `tengu_heron_brook`（唯一已知的历史合法键）；通过 `CACHE_FIX_BOOTSTRAP_ALLOWED_KEYS=逗号,分隔,列表` 配置。传入 `CACHE_FIX_BOOTSTRAP_ALLOWED_KEYS=`（显式空值）以完全拒绝所有。其他 GrowthBook 标志键原样透传。如果 Anthropic 在未来 CC 版本中添加合法的提示源键，可能需要更新。 |

注意：cache-fix v3.6.2 及更早版本对 bootstrap 路径返回 404，因为代理路由器未包含该路径——实际效果是 bootstrap 内容未到达 cache-fix 用户的 CC。v3.7.0 的默认 `audit` 改变了该行为；显式 `CACHE_FIX_BOOTSTRAP_MODE=block` 可保留旧行为。完整的披露记录，包括 Anthropic 的逐字结案文本，位于 [`docs/disclosure/heron-brook-2026-05.md`](docs/disclosure/heron-brook-2026-05.md)。

**参考资料：**

- [`docs/disclosure/heron-brook-2026-05.md`](docs/disclosure/heron-brook-2026-05.md) — 完整披露记录
- [`CHANGELOG.md`](CHANGELOG.md#371---2026-05-27) — v3.7.1 发布条目（扩展表面覆盖 + 允许列表模式）；[v3.7.0 条目](CHANGELOG.md#370---2026-05-26) 涵盖之前的行为变更说明
- [`cnighswonger/heron-brook-poc`](https://github.com/cnighswonger/heron-brook-poc) — bootstrap 通道行为的复现器

---

## 推荐的 CC 运营配置

代理修复了它在请求层能修复的内容。几个 CC 客户端侧环境变量和 `~/.claude/settings.json` 设置可以解决代理无法触及的邻近问题——CC 更新时的静默模型切换、模糊的模型回退、schema 剥离副作用。在此作为建议提供；用户自行决定配置。

这些发现来自 [@fgrosswig](https://github.com/fgrosswig) 对 CC v2.1.91 的二进制分析。方法为公开的 PowerShell + ASCII 字符串提取；他出于善意私下分享了结果清单。

### 建议的 `~/.claude/settings.json` env 块

以下模型 ID 仅作示意——替换为您偏好的主模型和快速小模型。关键在于，锁定*某个*明确的模型优于依赖 CC 的默认值。

```json
{
 "env": {
   "CLAUDE_CODE_DISABLE_LEGACY_MODEL_REMAP": "1",
   "ANTHROPIC_MODEL": "claude-opus-4-7",
   "ANTHROPIC_SMALL_FAST_MODEL": "claude-haiku-4-5-20251001"
 }
}
```

**`CLAUDE_CODE_DISABLE_LEGACY_MODEL_REMAP=1`** — 最重要的标志。CC 有一个旧版代码路径，会在某些版本更新后将您锁定的模型静默重映射到另一个模型。将其设为 `1` 禁用该重映射；您锁定什么模型，就用什么模型。（如果不锁定，CC 的默认值照常适用。）

**`ANTHROPIC_MODEL`** — 锁定主模型。保持此项明确意味着缓存前缀哈希在 CC 版本升级时保持稳定，否则会切换您的默认值。调整为您实际要用的模型。

**`ANTHROPIC_SMALL_FAST_MODEL`** — 锁定 CC 用于简短辅助调用（例如标题生成、分类）的侧通道"快速"模型。没有显式锁定时，此模型可能在更新时静默回退到不同系列。

### `autoCompactWindow=1000000` 注意事项

如果您在其他地方看到过 `autoCompactWindow: 1000000` 设置的推荐：它仅在活动模型符合 1M 上下文条件时生效（目前为带有适当 beta 头的 `claude-sonnet-4-6` 或 `claude-opus-4-6`）。没有这些前置条件时，无论设置什么值，它都以硬编码的 200K 为上限。

### `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` 的 schema 剥离副作用

如果设置此标志，CC 会从传出请求中剥离 `["name", "description", "input_schema", "cache_control"]` 之外的任何工具字段。依赖 `defer_loading` 或 `eager_input_streaming` 的自定义工具将静默丢失这些字段并表现出不同的行为。在打开此标志之前值得了解。

---

## 影响缓存成本的已知 CC 行为

这些不是 cache-fix 修补的 bug——它们是用户在评估会话成本时应该了解的上游 CC 行为。

### 诊断斜杠命令会膨胀对话历史（[#49335](https://github.com/anthropics/claude-code/issues/49335)）

运行 `/context`、`/release-notes`（以及可能的其他状态检查命令）会将诊断输出追加到对话历史中，而非仅渲染在终端上。后续轮次通过提示缓存重放膨胀后的载荷，在本应免费的状态检查操作上叠加 token 成本。经验测量：在 v2.1.148 上单次 `/context` 调用增加 +3,480 `cache_creation_input_tokens`；另一用户报告在另一会话中约 5K。`/release-notes` 更糟——默认会倾倒完整更新日志。

诊断上更糟的是：计入您缓存的膨胀载荷不会写入本地 JSONL 记录，因此您无法在本地审计成本来源——只能从响应使用量元数据中的 `cache_creation_input_tokens` 跳跃来推断。（代理模式用户可以在 `~/.claude/quota-status/` 文件中检查增量，这些文件由代理直接从响应头写入。）

**在上游修复之前的变通方案：** 在长会话中谨慎使用这些命令。如果在会话中需要频繁使用，考虑在诊断运行后使用 `/compact` 来重置流失。

---

## 快速上手：预加载模式（CC v2.1.112 及更早版本）

如果您使用基于 Node.js 的 CC 版本（v2.1.112 或更早），预加载拦截器无需代理即可工作：

```bash
npm install -g claude-code-cache-fix
NODE_OPTIONS="--import claude-code-cache-fix" claude
```

> **注意：** 预加载模式在 CC v2.1.113+（Bun 二进制版）上**不**工作。请使用上面的代理。

参见 [docs/preload-setup.md](docs/preload-setup.md) 了解包装脚本、shell 别名、Windows 说明以及 VS Code 预加载模式集成。

---

## VS Code 扩展

[VS Code 扩展](https://github.com/cnighswonger/claude-code-cache-fix-vscode)（v0.5.0）支持代理和预加载两种模式：

**代理模式（推荐）：**

1. 启动代理（见上文）
2. 在 VS Code 命令面板中：**Claude Code Cache Fix: Enable Proxy Mode**
3. 重启任何活动的 Claude Code 会话

**预加载模式（CC ≤v2.1.112）：**

1. `npm install -g claude-code-cache-fix`
2. 从 [GitHub Releases](https://github.com/cnighswonger/claude-code-cache-fix-vscode/releases/latest) 下载 VSIX
3. 安装：`code --install-extension claude-code-cache-fix-0.5.0.vsix`
4. 命令面板：**Claude Code Cache Fix: Enable**

有关手动 VS Code 包装器设置（不使用 VSIX），参见 [docs/preload-setup.md](docs/preload-setup.md#vs-code-preload-mode)。

---

## 安全模型

> **代理和拦截器对 API 请求和响应具有完全的读写访问权限。** 这是该方法的固有特性——任何 fetch 拦截器、代理或网关都具有此地位。

**它做什么：** 修改传出请求结构（块顺序、指纹、TTL、git-status）以修复缓存 bug。读取响应头和 SSE 使用量数据以进行监控。

**它不做什么：** 代理或拦截器不发起网络调用。所有遥测数据写入 `~/.claude/` 下的本地文件。不会有数据离开您的机器。

**供应链：** 代理模式：`proxy/extensions/` 中的 7 个小扩展模块（每个不足 200 行）。预加载模式：单个未压缩文件（`preload.mjs`，约 1,700 行）。一个开发依赖（`zod`，仅用于测试中的 schema 验证）。安装前请审查。已发布的构建带有 npm 默认注册表签名；sigstore 来源证明目前未发布——作为后续事项跟踪。

**独立审计：** 由 @TheAuditorTool 于 2026-04-14 [评估为"合法工具（LEGITIMATE TOOL）"](https://github.com/anthropics/claude-code/issues/38335#issuecomment-4244413605)。

---

## 问题所在

当您在 Claude Code 中使用 `--resume` 或 `/resume` 时，提示缓存会静默损坏。API 不再读取缓存的 token（便宜），而是在每轮从头重建（昂贵）。本应每小时约 $0.50 的会话可能烧掉 $5-10/小时，却没有任何可见迹象表明出了问题。

三个 bug 导致此问题：

1. **部分块散落** — 附件块（技能列表、MCP 服务器、延迟工具、钩子）本应位于 `messages[0]`。恢复时，部分或全部漂移到后面的消息中，改变了缓存前缀。

2. **指纹不稳定** — `cc_version` 指纹（例如 `2.1.92.a3f`）从 `messages[0]` 内容（包括元/附件块）计算得出。当这些块移位时，指纹变化，系统提示变化，缓存失效。

3. **非确定性工具排序** — 工具定义在各轮次之间可能以不同顺序到达，改变请求字节并无效缓存键。

此外，通过 Read 工具读取的图像以 base64 形式持久保存在对话历史中，并在每次后续 API 调用时发送，静默叠加 token 成本。

---

## 工作原理

**代理模式**（v3.0.0+）：`localhost:9801` 上的 HTTP 服务器拦截 `POST /v1/messages` 请求。七个扩展模块通过管道处理每个请求——规范化块顺序、剥离指纹、稳定工具排序、管理 TTL 标记。扩展是热重载的 `.mjs` 文件，在 `proxy/extensions.json` 中配置。所有其他流量原样透传。

**预加载模式**（v2.x）：一个 Node.js `--import` 模块，在 Claude Code 发起 API 调用之前修补 `globalThis.fetch`。内联应用相同的修复——扫描用户消息中的重定位块、排序工具、重新计算指纹、注入 TTL 标记。

两种模式都是幂等的——如果无需修复，请求原样透传。两种模式都不修改您的对话；它们仅在请求到达 API 之前规范化请求结构。

---

## 从修复中毕业

该包服务于三个目的，具有不同的生命周期：

| 目的         | 示例                                  | 何时禁用                          |
| ------------ | ------------------------------------- | --------------------------------- |
| **Bug 修复** | 块重定位、指纹、工具排序、TTL         | 当 CC 修复底层 bug 时——检查健康行 |
| **监控**     | 额度跟踪、微压缩检测、GrowthBook 标志 | 永久保留——这些检测未来的回归      |
| **优化**     | 图像剥离、输出效率重写                | 只要有助于工作流就保留            |

### 健康状态（预加载模式）

首次 API 调用时，拦截器记录一条健康状态行（需要 `CACHE_FIX_DEBUG=1`）：

```
cache-fix health: relocate=active(2h ago) fingerprint=dormant(5 clean sessions) tool_sort=active ttl=active identity=waiting
```

- **active(Xh ago)** — 修复在 X 小时前被应用
- **dormant(N clean sessions)** — N 个会话中未检测到 bug；CC 可能已修复
- **safety-blocked(Nx)** — 往返验证失败；修复自动禁用
- **waiting** — 修复尚未被触发

### 回归检测

如果禁用修复后，跨 5 次以上调用，cache_read 比率降至 50% 以下：

```
REGRESSION WARNING: cache_read ratio averaged 12% across last 5 calls.
Fixes are disabled — consider re-enabling to recover cache performance.
```

（回归警告：最近 5 次调用的 cache_read 比率平均为 12%。修复已禁用——考虑重新启用以恢复缓存性能。）

---

## 安全性

### 指纹往返验证

在重写 `cc_version` 指纹之前，拦截器验证其硬编码的 salt 和字符索引能否复现 Claude Code 发送的指纹。如果验证失败（CC 更改了算法），重写自动跳过。这确保拦截器永远无法使缓存性能比原生 CC _更差_。

### 失效安全设计

每个修复都设计为失败时退化为空操作：

- 如果块检测正则不匹配 → 块不重定位（= CC 行为）
- 如果指纹格式变化 → 指纹不重写（= CC 行为）
- 如果工具排序未产生变化 → 载荷原样透传
- 如果 TTL 注入目标结构变化 → TTL 不注入（= CC 行为）

拦截器只能*帮助*或*什么都不做*。它不能让事情变得更糟。

---

## 状态行——实时额度警告

两种模式在每次 API 调用时写入额度状态。代理模式（v3.5.0+）拆分为 `~/.claude/quota-status/account.json`（账户全局字段：Q5h/Q7d、状态、超额）加上 `~/.claude/quota-status/sessions/<id>.json`（每个会话的缓存字段：TTL 等级、命中率）。预加载模式保留旧版 `~/.claude/quota-status.json`（按设计为单会话）。附带的 `tools/quota-statusline.sh` 脚本显示实时状态行，包含：

- **Q5h** 额度条 `[███░┃░░░░░]` + 百分比 + `(exhaust X, reset Y)`。实心格为已消耗额度；粗竖线为窗口内挂钟已过位置。竖线在实心格右侧 = 低于消耗速度；竖线在实心格内 = 消耗速度快于时间流逝（超速）。`exhaust` 为按当前消耗速率到达 100% 的预计时间；`reset` 为窗口翻转的挂钟剩余时间。当 `exhaust < reset` 时，您将在窗口重置前达到 100%——应减速。
- **Q7d** 相同形态，以天为量级（例如 `(exhaust 3d13h, reset 3d0h)`）。不足一天时，后缀自动切换为 `h/m` 格式（例如 `(exhaust 1h41m, reset 0h30m)`）。
- **TTL 等级** — 健康时 `TTL:1h`，**服务器降级时显示红色 `TTL:5m`**（通常在 Q5h ≥ 100% 时）
- 工作日高峰时段（13:00–19:00 UTC）显示黄色 **PEAK**
- **缓存命中率 %**
- 激活时显示 **OVERAGE** 标志

示例行（窗口中期，健康状态）：

```
Q5h [███░┃░░░░░] 30% (exhaust 4h40m, reset 3h00m) | Q7d [█████┃░░░░] 53% (exhaust 3d13h, reset 3d0h) | TTL:1h 98.3%
```

`(exhaust …, reset …)` 后缀在预测无意义时逐步省去：0%（新窗口）和 100%（已耗尽）时只显示 `reset`；窗口开始后的前 5 分钟内消耗速率不够稳定，不足以预测（单次早期调用主导速率），因此 Q5h 和 Q7d 的 `exhaust` 在此期间暂不显示；`resets_at` 过期（服务器报告的值位于过去，在下一次 API 调用刷新前）两者均不显示。

该条使用 Unicode 块字符（`█┃░`）——大多数现代终端均能正确渲染。如果您的终端替换为方框或替换字形，请配置支持 Unicode 的字体（如 DejaVu、Fira、Iosevka、JetBrains Mono 等）。

### 设置

```bash
mkdir -p ~/.claude/hooks
cp "$(npm root -g)/claude-code-cache-fix/tools/quota-statusline.sh" ~/.claude/hooks/
chmod +x ~/.claude/hooks/quota-statusline.sh
```

添加到 `~/.claude/settings.json`：

```json
{
 "statusLine": {
   "type": "command",
   "command": "~/.claude/hooks/quota-statusline.sh"
 }
}
```

### 为什么状态行很重要

当服务器将您的 TTL 降级为 5m（Q5h ≥ 100% 时的额度感知降级），**每次空闲超过 5 分钟都会导致完整的上下文重建**。没有状态行，这是不可见的。有了它，红色的 `TTL:5m` 警告告诉您：**停止工作，等待 Q5h 窗口重置，然后恢复**。硬撑着超额使用会加剧流失；暂停则打破循环。

### 推荐：禁用 git-status 注入

Claude Code 在每次调用时将实时 `git status` 注入系统提示。任何文件编辑都会改变 git status，这会破坏整个前缀缓存。禁用此功能每次调用可节省约 1,800 token：

```bash
export CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS=1
```

或在 `~/.claude/settings.json` 中添加 `"includeGitInstructions": false`。Claude Code 在需要上下文时仍然可以通过 Bash 工具运行 `git status`。社区验证（[@wadabum](https://github.com/cnighswonger/claude-code-cache-fix/issues/11)）：跨 git 状态变化仅 18 token 的缓存创建（相比之下，不设标志则为数千）。

**为什么不为此提供代理扩展：** 代理在 Claude Code 已组合系统提示后才拦截请求——此时，易变的 `git status` 文本已经是模型在前一轮中条件依赖的前缀的一部分，事后剥离它本身会破坏缓存。修复必须发生在源头。`CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS=1` 在提示组合之前阻止注入，这就是原生标志是正确工具的原因。事后剥离还会移除模型可见的上下文（显式 Bash 调用可以恢复），并有对助手编写文本产生误匹配的风险。

---

## 迁移：v3.4.x → v3.5.0+

如果您编写了自定义状态行、监控脚本或其他任何直接读取 `~/.claude/quota-status.json` 的内容，本节适合您。v3.5.0 在代理模式中拆分了该文件；预加载模式不变。

### 变更内容

|                                                   | v3.4.x 及更早（代理 + 预加载） | v3.5.0+ 代理模式                                  | v3.5.0+ 预加载模式                        |
| ------------------------------------------------- | ------------------------------ | ------------------------------------------------- | ----------------------------------------- |
| 额度字段（Q5h、Q7d、状态、超额）                  | `~/.claude/quota-status.json`  | `~/.claude/quota-status/account.json`             | `~/.claude/quota-status.json`（旧版路径） |
| 缓存字段（TTL 等级、命中率、cache_creation/read） | 同上文件                       | `~/.claude/quota-status/sessions/<filename>.json` | 同上文件                                  |
| 多会话归属                                        | 无——最后写入者胜               | 每个会话单独文件                                  | 预加载按设计为单会话                      |

`<filename>` 从请求的 `x-claude-code-session-id` 头通过确定性安全名称规则派生：UUID 和其他匹配 `[A-Za-z0-9_-]{1,128}` 的 ID 直接通过；null/空/空白变为 `unknown`；其他映射到 `inv-<sha256-prefix>`。完整规则记录在 [`docs/directives/proxy-quota-status-per-session.md`](docs/directives/proxy-quota-status-per-session.md)。

旧版 `~/.claude/quota-status.json` 在升级后首次代理模式写入时自动删除。早于 `CACHE_FIX_QUOTA_STATUS_TTL_DAYS`（默认 `7`）天的按会话文件在写入时清理。

### 消费者侧迁移模式

您的脚本应首先尝试 v3.5.0+ 代理路径，如果不存在则回退到旧版路径。这样它可以在两种模式下工作（以及在升级中的主机上）。会话 ID 通常来自 Claude Code 在调用状态行钩子时的 stdin；对于其他消费者，从最近修改的 `~/.claude/projects/*/*.jsonl` 文件名捕获。

**Bash（状态行风格）：**

```bash
QS_DIR="$HOME/.claude/quota-status"
ACCOUNT="$QS_DIR/account.json"
LEGACY="$HOME/.claude/quota-status.json"

# 规范文件名规则——必须与 proxy/extensions/cache-telemetry.mjs 一致
# sessionFilename()：trim，然后 "" → unknown，安全正则透传，否则
# inv-<sha256-prefix>。否则，格式错误或含空白的 id 会错过
# 按会话文件，即使写入器已在规范名称下创建了一个。
session_filename() {
 local trimmed
 trimmed="$(printf '%s' "$1" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
 if [ -z "$trimmed" ]; then echo unknown; return; fi
 if printf '%s' "$trimmed" | grep -qE '^[A-Za-z0-9_-]{1,128}$'; then
   printf '%s' "$trimmed"
 else
   # Linux 上用 sha256sum；macOS 上用 shasum -a 256。两者输出 "<hex> -"。
   local hash
   if command -v sha256sum >/dev/null 2>&1; then
     hash="$(printf '%s' "$trimmed" | sha256sum)"
   else
     hash="$(printf '%s' "$trimmed" | shasum -a 256)"
   fi
   printf 'inv-%s' "$(printf '%s' "$hash" | cut -c1-16)"
 fi
}

# 会话 id：优先 CC stdin，回退到最近的 jsonl
sid="$(jq -r '.session_id // empty' 2>/dev/null < /dev/stdin || true)"
if [ -z "$sid" ]; then
 sid="$(ls -t "$HOME"/.claude/projects/*/*.jsonl 2>/dev/null | head -1 | xargs -I{} basename {} .jsonl)"
fi
filename="$(session_filename "$sid")"

# 额度：account.json（v3.5.0+）→ 回退到旧版
if [ -f "$ACCOUNT" ]; then
 quota_json="$(cat "$ACCOUNT")"
elif [ -f "$LEGACY" ]; then
 quota_json="$(cat "$LEGACY")"
fi

# 缓存：sessions/<filename>.json（v3.5.0+）→ 回退到旧版
if [ -f "$QS_DIR/sessions/$filename.json" ]; then
 cache_json="$(cat "$QS_DIR/sessions/$filename.json")"
elif [ -f "$LEGACY" ]; then
 cache_json="$(cat "$LEGACY")"
fi
```

**Node：**

```js
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const home = homedir();
const accountPath = join(home, ".claude", "quota-status", "account.json");
const legacyPath = join(home, ".claude", "quota-status.json");

const SAFE_NAME_RE = /^[A-Za-z0-9_-]{1,128}$/;

// 镜像 cache-telemetry.mjs 的 sessionFilename()。读者侧规则必须与
// 写者侧规则一致；否则格式错误/含空白的 id 会错过其按会话文件。
function sessionFilename(rawId) {
  if (rawId === null || rawId === undefined) return "unknown";
  const s = String(rawId).trim();
  if (s.length === 0) return "unknown";
  if (SAFE_NAME_RE.test(s)) return s;
  return "inv-" + createHash("sha256").update(s).digest("hex").slice(0, 16);
}

function readQuotaJson() {
  if (existsSync(accountPath))
    return JSON.parse(readFileSync(accountPath, "utf8"));
  if (existsSync(legacyPath))
    return JSON.parse(readFileSync(legacyPath, "utf8"));
  return null;
}

function readCacheJson(sessionId) {
  const filename = sessionFilename(sessionId);
  const p = join(
    home,
    ".claude",
    "quota-status",
    "sessions",
    `${filename}.json`,
  );
  if (existsSync(p)) return JSON.parse(readFileSync(p, "utf8"));
  if (existsSync(legacyPath))
    return JSON.parse(readFileSync(legacyPath, "utf8"));
  return null;
}
```

附带的 [`tools/quota-statusline.sh`](tools/quota-statusline.sh) 是 bash 版本的参考实现。[`/coffee` 技能](https://github.com/cnighswonger/claude-code-coffee) v1.4.0 是按会话热度门的参考实现。

### 为什么按会话

在多代理主机（多个 Claude Code 会话共享一个代理）上，v3.5.0 之前的单一全局文件导致每个会话的每次响应都覆盖其他会话的缓存统计。从会话 A 读取状态行会显示会话 B 的 TTL 等级（只要 B 最近发送了请求）。按会话文件加账户全局额度文件解决了此问题，同时不失简单的账户全局视图。参见 [#104](https://github.com/cnighswonger/claude-code-cache-fix/issues/104) 了解原始报告。

---

## 图像剥离（预加载模式）

通过 Read 工具读取的图像以 base64 形式持久保存在对话历史中，伴随每次后续 API 调用。一张 500KB 的图像在 Opus 4.6 上每次轮次消耗约 62,500 token，在 Opus 4.7 上由于新的分词器达到 **~85,000+ token**。强烈建议在 4.7 上进行图像剥离。

```bash
export CACHE_FIX_IMAGE_KEEP_LAST=3
```

保留最近 3 条用户消息中的图像，用文本占位符替换更早的图像。仅针对 `tool_result` 块——用户粘贴的图像绝不触及。

### 超大图像守卫（旧版，v3.2.1）

```bash
export CACHE_FIX_IMAGE_MAX_DIM=2000
```

Anthropic API 在多图像请求上强制执行 TWO 个图像相关限制，相同的错误消息可能因任一个触发：

> `"An image in the conversation exceeds the dimension limit for many-image requests (2000px). Start a new session with fewer images."`
> （"对话中的某图像超出了多图像请求的尺寸限制（2000px），请以较少的图像开始新会话。"）

解决两条压力轴：

| 压力               | 变量                          | 作用                                                                                            |
| ------------------ | ----------------------------- | ----------------------------------------------------------------------------------------------- |
| **对话中图像过多** | `CACHE_FIX_IMAGE_KEEP_LAST=N` | 从旧用户消息中剥离图像，仅保留最近 N 张。                                                       |
| **某张图像过大**   | `CACHE_FIX_IMAGE_MAX_DIM=2000` | 用注明原始尺寸的取证占位符替换超出尺寸限制的图像。覆盖用户消息直接图像和 tool_result 嵌入图像。 |

两者组合：同时设置时，`KEEP_LAST` 首先运行（减少数量），然后 `MAX_DIM` 对剩余图像运行（限制保留图像的尺寸）。常见触发尺寸轴的情况：高分辨率手稿扫描、retina 屏幕截图、全分辨率照片。

纯 JS PNG 和 JPEG 文件头解析——无原生依赖。其他格式（GIF、WebP、AVIF、BMP）无论尺寸如何均原样通过。失效打开：无法解析尺寸的图像（头部截断、不支持的格式）保留而非剥离——宁可发送可能出错的请求，也不剥离我们无法测量的有效图像。

### 图像守卫管道（v3.3.0）

一个镜像 Anthropic 实际规则的条件化管道。严格通过单一环境变量主动选择：

```bash
export CACHE_FIX_IMAGE_GUARD=1
```

启用后，代理运行：

| 阶段               | 触发条件                                                      | 动作                                                                                                         |
| ------------------ | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **阶段 0**（旧版） | `CACHE_FIX_IMAGE_KEEP_LAST=N` 已设置                          | 从早于最近 N 条的用户消息中剥离 tool_result 图像                                                             |
| **阶段 3**         | `CACHE_FIX_IMAGE_PRESERVE_DETAIL=1` 且图像长边 > 模型原生上限 | 通过 `sharp` Lanczos 缩放至原生上限（Opus 4.7 为 2576 px，否则为 1568 px），保持宽高比和媒体类型             |
| **阶段 1**         | 图像长边 > 活动拒绝上限                                       | 剥离并用取证占位符替换。活动上限 = `MAX_DIM`（如设置），否则 2000 px（数量 > 20 时）或 8000 px（数量 ≤ 20 时） |
| **阶段 2**         | 请求体超出 `CACHE_FIX_IMAGE_REQUEST_SIZE_MAX`（默认 30 MB）   | 丢弃最旧图像直至低于预算                                                                                     |
| **数量上限**       | 幸存图像数量 > `CACHE_FIX_IMAGE_COUNT_MAX`（默认 100）        | 丢弃最旧图像下降至上限                                                                                       |

执行顺序：**阶段 0 → 阶段 3 → 阶段 1 → 阶段 2 → 数量上限**。每个阶段独立——阶段 1 绝不缩放；阶段 3 绝不剥离。

#### 可选 `sharp` 依赖

阶段 3 需要 [sharp](https://www.npmjs.com/package/sharp) 进行 Lanczos 缩放。它声明为**可选的对等依赖**——如需阶段 3 请单独安装：

```bash
npm install sharp
```

如果缺少 `sharp`，阶段 3 干净跳过（遥测记录 `library_missing: true`）；阶段 1 + 阶段 2 + 数量上限仍会运行。

#### 优先级矩阵

| 环境变量组合                                  | 行为                                                                                                                    |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 未设置任何                                    | 不处理图像（后向兼容默认值；扩展短路）。                                                                                |
| 仅 `KEEP_LAST=N`                              | 现有 v3.2.1：用户消息中 tool_result 图像的数量上限，首先运行。无管道。                                                  |
| 仅 `MAX_DIM=N`                                | 现有 v3.2.1：硬尺寸上限，仅剥离。无管道。                                                                               |
| `KEEP_LAST=N` + `MAX_DIM=N`                   | 现有 v3.2.1 组合：`KEEP_LAST` 首先运行（减少数量），然后 `MAX_DIM` 对剩余运行（限制尺寸）。无管道，无阶段 2，无阶段 3。 |
| `IMAGE_GUARD=1`                               | 新管道：阶段 1（条件上限）+ 阶段 2（请求大小守卫）+ 图像数量上限。                                                      |
| `IMAGE_GUARD=1` + `MAX_DIM=N`                 | `MAX_DIM` 覆盖阶段 1 的条件上限（作为上限值）；阶段 2 仍运行。                                                          |
| `IMAGE_GUARD=1` + `PRESERVE_DETAIL=1`         | 添加阶段 3（通过 `sharp` 的 Lanczos 缩放）。当 `sharp` 不可用时，回退到剥离行为。                                       |
| `IMAGE_GUARD=1` + `KEEP_LAST=N`               | `KEEP_LAST` 首先作为数量上限运行（阶段 0）；管道对剩余运行。                                                            |
| `IMAGE_GUARD=1` + `KEEP_LAST=N` + `MAX_DIM=N` | 三向：`KEEP_LAST` 首先运行；管道对剩余运行，但 `MAX_DIM` 覆盖阶段 1 的条件上限；阶段 2 仍运行。                         |
| 没有 `IMAGE_GUARD=1` 的 `PRESERVE_DETAIL=1`   | 记录警告，视为空操作。`PRESERVE_DETAIL` 在管道未运行的情况下无意义。                                                    |

#### 可调参数

| 环境变量                           | 默认值            | 用途                                                             |
| ---------------------------------- | ----------------- | ---------------------------------------------------------------- |
| `CACHE_FIX_IMAGE_GUARD`            | 未设置            | 顶级管道开关（`=1` 启用）。                                      |
| `CACHE_FIX_IMAGE_PRESERVE_DETAIL`  | 未设置            | 启用阶段 3 通过 `sharp` 进行 Lanczos 缩放。                      |
| `CACHE_FIX_IMAGE_REQUEST_SIZE_MAX` | 31457280（30 MB） | 阶段 2 字节预算。距 Anthropic 的 32 MB 上限留 2 MB 余量。        |
| `CACHE_FIX_IMAGE_COUNT_MAX`        | 100               | 硬图像数量上限。如需要可设为 600 用于旧版 Claude 1/2.x/Instant。 |

---

## 缓存断点（代理模式，主动选择）

Anthropic 的提示缓存每条请求支持最多**四个** `cache_control` 标记。Claude Code 目前使用其中三个；第三个（位于自动注入的 `messages[0]` 内容——钩子、技能、项目 CLAUDE.md、延迟工具、MCP 服务器描述——与第一个真实用户内容之间）完全缺失。没有该标记，自动注入范围内的每次更改都会破坏其后所有内容的缓存。wadabum 预计添加它可为每次新会话首轮节省约 6,500 token（[anthropics/claude-code#47098](https://github.com/anthropics/claude-code/issues/47098)）。

代理可在主动选择时注入缺失的标记。默认关闭，待社区数据验证后开启。

```sh
export CACHE_FIX_INJECT_MESSAGES_BREAKPOINT=1
```

注入是保守的：仅在请求已携带 1–3 个标记（典型 CC 形态）时触发，如果请求已达 4 标记限制（会返回 400）或标记数为零（Agent SDK / API 直连形态，此扩展不为其设计）则拒绝。边界检测覆盖所有五种观察到的自动注入块类型——钩子、技能、CLAUDE.md、延迟工具、MCP——并将标记放置在**最后**一个自动注入块上。

一个仅诊断的环境变量可导出 `messages[0]` 的结构形态用于样本收集，而不修改请求：

```sh
export CACHE_FIX_DUMP_MESSAGES_HEAD=/tmp/messages-head.jsonl
```

| 环境变量                               | 默认值 | 用途                                                       |
| -------------------------------------- | ------ | ---------------------------------------------------------- |
| `CACHE_FIX_INJECT_MESSAGES_BREAKPOINT` | 未设置 | 启用断点 #3 注入（`=1` 主动选择）。                        |
| `CACHE_FIX_DUMP_MESSAGES_HEAD`         | 未设置 | 诊断 JSONL 导出 `messages[0].content` 形状——只读，不修改。 |

---

## 微压缩稳定性（代理模式，主动选择）

闲置约 90 分钟后，Claude Code 的 `time_based_microcompact`（及由 `FDY()` 触发的冷压缩路径）会用哨兵字符串替换旧的 `tool_result` 内容。就缓存而言，原始内容已消失；该部分无法从代理恢复。但哨兵本身可能携带嵌入的时间戳（`[Old tool result content cleared at 2026-04-30T13:42:11Z]`），这意味着对同一已清除位置的*第二次*微压缩会写入不同字节——破坏该位置之后所有内容的缓存，尽管没有添加新内容。

此扩展处理可恢复的一半：将哨兵规范化为字节稳定的规范形式，使重复的微压缩不会搅动缓存。**仅阶段 1**——诊断 + 主动选择规范化。阶段 2（快照并恢复原始 tool_result 内容）推迟到 v3.5.0+，待阶段 1 生产数据收集后推进。

```sh
# 步骤 1（诊断）：表征 CC 的哨兵实际长什么样。
export CACHE_FIX_DUMP_MICROCOMPACT=/tmp/microcompact-dump.jsonl

# 步骤 2（规范化）：哨兵格式确认后，主动选择。
export CACHE_FIX_NORMALIZE_MICROCOMPACT=1
```

检测有两种模式：

- **模式 A** — 与已确认的 CC 哨兵模式（裸形式和 ISO-8601 时间戳变体）的精确匹配。模式 A 匹配有资格进行规范化。
- **模式 B** — 仅前缀匹配（文本以 `[Old tool result content cleared` 开头但不完全匹配模式 A）。模式 B 为**仅诊断**：永不被规范化，导出记录仅编辑为 64 字符前缀。

模式 A/B 分离防止哨兵可能后跟用户派生内容的情况（例如，将用户输入回显到其结果的工具）——模式 B 的编辑保证使该内容远离诊断导出。

| 环境变量                                         | 默认值                              | 用途                                                                                                        |
| ------------------------------------------------ | ----------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `CACHE_FIX_DUMP_MICROCOMPACT`                    | 未设置                              | 检测到的哨兵的诊断 JSONL 导出路径。只读——不修改。                                                           |
| `CACHE_FIX_NORMALIZE_MICROCOMPACT`               | 未设置                              | 启用规范化（`=1` 主动选择）。将模式 A 匹配修改为规范形式。                                                  |
| `CACHE_FIX_MICROCOMPACT_NORMALIZED`              | `[Old tool result content cleared]` | 覆盖规范替换字符串。                                                                                        |
| `CACHE_FIX_MICROCOMPACT_SENTINEL_PATTERN_<N>`     | 未设置                              | 添加自定义模式 A 正则表达式模式。编号（从 1 开始，可稀疏）。                                                |
| `CACHE_FIX_MICROCOMPACT_SENTINEL_PREFIX_<N>`     | 未设置                              | 自定义模式 B 文字前缀。与非默认哨兵系列的自定义模式 A 模式配对，使该系列的前缀变体也获得编辑的模式 B 捕获。 |
| `CACHE_FIX_MICROCOMPACT_REDACT_LEN`              | `64`                                | 导出记录中模式 B 的前缀长度。设为 `0` 完全抑制前缀。                                                        |
| `CACHE_FIX_DUMP_MICROCOMPACT_INCLUDE_NORMALIZED` | 未设置                              | 在导出记录中同时添加规范化后文本（不替换）原始 `sentinel_text`。                                            |

---

## Thinking 摘要（代理模式，主动选择，Opus 4.7+）

在 Opus 4.7 上，Anthropic 将 `thinking.display` 的 API 默认值从 `"summarized"` 翻转为 `"omitted"`。同时，Claude Code 的 CLI 有一个 `!getIsNonInteractiveSession()` 门控，仅在会话为交互式时传播 `display: "summarized"`。两者结合意味着每个以 `--input-format stream-json` 生成的 CC 子进程——VS Code 聊天面板、Antigravity 面板、SDK、`claude --print`——发送一个启用了 thinking 的请求（`thinking.type` 为 `"enabled"` 或 `"adaptive"`，取决于 CC 版本），不带 `display`，而 API 返回的 thinking 块中 `thinking` 字段为空（外加一个多 KB 的签名）。UI 在代理运行时显示静态的"Thinking"存根，但从未显示任何推理内容。

上游根因及补丁在 [anthropics/claude-code#59844](https://github.com/anthropics/claude-code/issues/59844) 中提出（致谢：[@ojura](https://github.com/ojura)）。此扩展是代理侧补充：当发往 Opus 4.7 端点的请求启用了 thinking 但 `display` 未设置时，在 API 边界注入配置的模式。适用于通过 cache-fix-proxy 路由的任何 CC 版本，无需等待 Anthropic 发布 CLI 修复。

```sh
# 恢复摘要（内置默认值——非交互界面获得推理内容）
export CACHE_FIX_THINKING_DISPLAY=summarized

# 强制抑制覆盖（不想要任何 thinking 块的代理运行时）
export CACHE_FIX_THINKING_DISPLAY=omitted

# 显式空操作（扩展原样透传）
export CACHE_FIX_THINKING_DISPLAY=disabled
```

从 v3.6.1 起，此扩展**默认开启**。缓存前缀测试测量了在 Opus 4.7 上注入活跃时，稳态 `cache_read` 比率的绝对下降为 0%（每个窗口 5 次顺序 `claude -p` 调用，基线 vs 注入——两个窗口从第 2 次调用起均保持 1.000 cache_read 比率）。向请求体添加 `thinking.display` 会改变 Anthropic 哈希的字节，但 Anthropic 的缓存层接受并索引注入前缀的方式与索引任何其他前缀相同。希望保持旧"不注入"行为的用户（例如，完全避免请求体修改）可显式设置 `CACHE_FIX_THINKING_DISPLAY=disabled`。

扩展内置的作用域规则：

- **模型门控。** 仅在请求的 `model` 匹配 `/^claude-opus-4-7/` 时触发——覆盖 `claude-opus-4-7` 和 `claude-opus-4-7-1m`。Sonnet 4.7 需要单独验证（API 默认翻转可能不同）；未来版本（4.8+）需要显式 cache-fix 版本升级，而非自动应用未经验证的行为。
- **用户主动选择优先保留。** 如果请求已有 `thinking.display` 设置（`"summarized"` 或 `"omitted"`），扩展永不覆盖。显式用户选择始终胜出。
- **仅 thinking 活跃类型。** 扩展对 `thinking.type` ∈ `{ "enabled", "adaptive" }` 触发——这两种是在 Opus 4.7 上产生 thinking 块的活跃模式。其他值（`"disabled"`、未来模式）跳过。保守设计：如果 Anthropic 发布具有不同 display 语义的新 thinking 类型，我们宁愿错过修复，也不愿自动应用错误行为。

| 环境变量                     | 默认值              | 用途                                                                                                                                                |
| ---------------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CACHE_FIX_THINKING_DISPLAY` | `summarized`（内置） | 以下之一：`summarized` / `omitted` / `disabled`。`summarized` 恢复 thinking 摘要（默认）。`omitted` 强制抑制 thinking 块。`disabled` 让扩展完全退出。 |

---

## 会话健康预警（代理模式，thinking-desync 风险）

长时间运行的 Opus 4.7 `[1m]` 会话会累积交错的 thinking 块并增长其实时上下文，直到 Claude Code 自身的历史重建使 thinking 块签名失同步，在每次后续轮次上产生永久性的 `400 … thinking blocks … cannot be modified` 错误（上游根因：[anthropics/claude-code#63147](https://github.com/anthropics/claude-code/issues/63147)）。会话突然死亡，事先没有任何信号。

`session-health` 扩展监视与触发相关的条件，并在会话**到达危险区域之前**发出警告，使操作者可以有意地退役该会话（写入会话状态交接，`/clear`），而不是被死会话突袭。它是**只读的**——它从不修改请求/响应体，也从不尝试修复失同步（那是 CC 侧的问题，#63147）。它在每次请求时将数值遥测记录到按会话文件（`~/.claude/quota-status/sessions/<id>.json`）中，并在会话首次进入 `high` 风险时发出一次性 stderr 行。仅计数——绝不记录 thinking 文本或签名。

添加到按会话 JSON 的字段：

- `context_tokens` — 最新请求的实时上下文（`input + cache_read + cache_creation`）
- `thinking_block_count` — 最新请求中的 `thinking`/`redacted_thinking` 块数量
- `thinking_block_max` — 会话历史最高水位（跨代理重启持续保留）
- `first_seen`、`request_count` — 会话年龄 + 请求计数
- `thinking_desync_risk` — `ok` / `warn` / `high`（信号禁用时省略）

token 阈值锚定在观察到的约 382K token 触发点并留有余量；警告设计为保守——过早的"即将退役"远比死会话便宜。块计数被记录但尚未触发警告（一旦故障分布已知，将在校准的快速跟进中激活）。

| 环境变量                              | 默认值       | 用途                                                                                       |
| ------------------------------------- | ------------ | ------------------------------------------------------------------------------------------ |
| `CACHE_FIX_THINKING_RISK_WARN_TOKENS` | `250000`      | `thinking_desync_risk` 变为 `warn` 的上下文 token 级别。                                   |
| `CACHE_FIX_THINKING_RISK_HIGH_TOKENS` | `340000`      | 风险变为 `high` 且一次性 stderr 警告触发的上下文 token 级别。                              |
| `CACHE_FIX_THINKING_RISK`             | 未设置（开） | 设为 `off` 抑制警告信号（stderr 行 + `thinking_desync_risk` 字段）。原始计数遥测继续记录。 |

---

## Thinking 块清理（代理模式，主动选择，thinking-desync 缓解）

thinking-desync 响应的*缓解*部分（*预警*部分是上面的 session-health）。在历史重放路径上（resume / `--continue` / 自动压缩 / 并行工具取消），Claude Code 以**已省略**形态重新发送先前助手轮次的扩展 thinking：`{ "type":"thinking", "thinking":"", "signature":"<intact>" }`。API 拒绝修改**最新**助手消息中的 thinking，并产生永久性的 `400 … thinking … blocks cannot be modified`，使会话在每次后续轮次上卡死（上游根因：[anthropics/claude-code#63147](https://github.com/anthropics/claude-code/issues/63147)）。

`thinking-block-sanitize` 扩展在请求转发前丢弃那些已省略块——API 将其视为可选历史。经验解决出的轮次选择规则：从**所有先前助手轮次和最新助手轮次**中丢弃已省略 thinking，**除非最新轮次是活跃的工具续接**（其最后一个块是 `tool_use`，后跟一个 `tool_result` 应答）。在那种情况下，API 要求签名 thinking 完整，而代理无法恢复已清空的文本，因此它保持该轮次不变。**对于这种情况，没有任何环境变量能既保留 thinking 又避免卡死：** `CLAUDE_CODE_DISABLE_THINKING=1` / `MAX_THINKING_TOKENS=0` 仅通过完全禁用 thinking 来阻止卡死（有损——无推理），而 `DISABLE_INTERLEAVED_THINKING=1` *不能*阻止 `400`——因此答案是不恢复 + 修复/退役会话。这正是代理缓解如此重要的原因：**对于其覆盖的历史重放路径，它是保留推理同时避免卡死的唯一路径**。非空 thinking 永不触碰；`redacted_thinking` 不在 v1 范围内。

**主动选择。** v1 在 `CACHE_FIX_THINKING_SANITIZE=on` 后面发布（默认关闭）：它修改请求体，完整的现场覆盖验证尚待进行。该变换是确定性的且缓存前缀稳定的，并在按会话 JSON 中发出每次请求的 `thinking_blocks_dropped` 计数（仅计数——从不记录内容），作为 session-health 信号的补充。

| 环境变量                      | 默认值       | 用途                                                                              |
| ----------------------------- | ------------ | --------------------------------------------------------------------------------- |
| `CACHE_FIX_THINKING_SANITIZE` | 未设置（关） | 设为 `on` 启用请求路径中已省略 thinking 块的丢弃。关 = 空操作（不修改、不遥测）。 |

---

## 系统提示重写（预加载模式，可选）

拦截器可以重写 Claude Code 的 `# Output efficiency` 系统提示段。默认禁用。使用 `CACHE_FIX_OUTPUT_EFFICIENCY_REPLACEMENT` 启用。参见 [docs/output-efficiency-prompts.md](docs/output-efficiency-prompts.md) 了解三种已知提示变体及使用说明。

---

## 监控与诊断

预加载拦截器包括微压缩降级监控、伪速率限制器、GrowthBook 标志状态、使用量遥测和成本报告。额度跟踪在代理和预加载两种模式下均通过 `~/.claude/quota-status/`（代理：按会话拆分）或 `~/.claude/quota-status.json`（预加载：单会话旧版路径）工作。

参见 [docs/monitoring.md](docs/monitoring.md) 了解完整细节、调试模式、前缀差异对比、环境变量以及附带的额度分析工具。

---

## 局限性

- **代理需要运行中的进程**——代理必须在 Claude Code 之前启动。如果代理未运行而 `ANTHROPIC_BASE_URL` 指向它，CC 将无法连接。我们推荐将其作为 systemd 服务运行，或使用带健康检查的包装脚本。
- **超额 TTL 降级**——超过 5 小时额度的 100% 会触发服务器强制 TTL 降级，从 1 小时降至 5 分钟。这是服务器侧的，无法在客户端修复。代理/拦截器防止的是首先将您推入超额状态的缓存不稳定。
- **微压缩不可阻止**——监控功能检测上下文降级但无法阻止。微压缩和预算执行通过 GrowthBook 标志由服务器控制，没有客户端禁用选项。
- **系统提示重写是实验性的**——仅预加载、主动选择。未被证明是社区报告中讨论的行为差异的原因。使用风险自负。
- **版本耦合**——指纹 salt 和块检测启发式方法源自 Claude Code 内部实现。重大重构可能需要更新此包。

---

## 相关研究

- **[@ArkNill/claude-code-hidden-problem-analysis](https://github.com/ArkNill/claude-code-hidden-problem-analysis)** — 基于 38,996 次请求的代理分析：7 个 bug（微压缩、预算上限、伪速率限制器、JSONL 重复、扩展 thinking）、GrowthBook 功能标志因果测试、Opus 4.7 消耗速率警示。v1.1.0 中的监控功能基于此研究。
- **[@Renvect/X-Ray-Claude-Code-Interceptor](https://github.com/Renvect/X-Ray-Claude-Code-Interceptor)** — 诊断性 HTTPS 代理，具有实时仪表板、系统提示段差异对比、按工具剥离阈值。适用于任何支持 `ANTHROPIC_BASE_URL` 的 Claude 客户端。
- **[@fgrosswig/claude-usage-dashboard](https://github.com/fgrosswig/claude-usage-dashboard)** — 自托管取证仪表板，具有 SSE 实时监控、多主机聚合、缓存健康评分。与我们代理的观察点互补。参见 [docs/dashboard-integration.md](docs/dashboard-integration.md) 了解互操作设置。

---

## 生产环境使用案例

- **[Crunchloop DAP](https://dap.crunchloop.ai)** — Agent SDK / DAP 开发环境。首个将拦截器合并到主干进行团队范围部署的生产团队（2026-04-10）。通过实际测试识别了两种不同的缓存回归模式——工具排序抖动和新会话排序缺口——并贡献了驱动 v1.5.1 和 v1.6.2 修复的调试跟踪。贡献了可嵌入代理工厂函数（v3.6.0），使代理可在 Bun 编译和 DAP 式代理二进制文件内进程内运行，无需 fork Node 子进程。
- **[VM Farms](https://vmfarms.com)**（[@vmfarms](https://github.com/vmfarms)）— 使用 `--resume --fork-session` 运行并发多运行器工作负载的代理开发环境。暴露了三个 cache-fix 代理模式 bug：resume-marker 正则空操作（#96）、TTL 等级检测与预加载模式的差距（#97）、以及图像剥离 stderr 泄漏超出 `CACHE_FIX_DEBUG` 范围（#98）——均在 v3.4.0 版本中解决。

---

## 贡献者

- **[@VictorSun92](https://github.com/VictorSun92)** — v2.1.88 的原始 monkey-patch 修复，识别 v2.1.90 的部分散落问题，贡献前向扫描检测、正确的块排序、更紧密的块匹配器和可选的 output-efficiency 重写钩子
- **[@bilby91](https://github.com/bilby91)**（[Crunchloop DAP](https://dap.crunchloop.ai)）— Agent SDK / DAP 生产环境验证，1h 缓存 TTL 确认，通过调试跟踪发现工具排序抖动（v1.5.1 中修复），通过 SKILLS SORT 诊断发现新会话排序 bug（v1.6.2 中修复）。首个将拦截器推至主干的生产团队。设计并贡献了 v3.6.0 中的可嵌入代理工厂函数（`startProxy()` / `createProxyServer()`）（PR #123）。
- **[@jmarianski](https://github.com/jmarianski)** — 通过 MITM 代理捕获和 Ghidra 逆向工程进行根因分析，多模式缓存测试脚本
- **[@cnighswonger](https://github.com/cnighswonger)** — 指纹稳定化、工具排序修复、图像剥离、监控功能、超额 TTL 降级发现、代理架构、包维护者
- **[@ArkNill](https://github.com/ArkNill)** — 微压缩机制分析、GrowthBook 标志文档、伪速率限制器识别、CC v2.1.108+ 指纹验证修复（PR #21）、韩文 README（PR #22）、[claude-code-hidden-problem-analysis](https://github.com/ArkNill/claude-code-hidden-problem-analysis) 研究
- **[@Renvect](https://github.com/Renvect)** — 图像重复发现、跨项目目录污染分析
- **[@fgrosswig](https://github.com/fgrosswig)** — [claude-usage-dashboard](https://github.com/fgrosswig/claude-usage-dashboard) 取证方法论：成本因素开销比指标、`anthropic-*` 请求头捕获模式、代理 NDJSON 模式（为我们仪表板互操作层提供信息）
- **[@TomTheMenace](https://github.com/TomTheMenace)** — Windows `.bat` 包装器，首个 Windows 平台验证（7.5 小时/536 次调用 Opus 4.6 会话，98.4% 缓存命中率）
- **[@arjansingh](https://github.com/arjansingh)** — 带动态 `npm root -g` 路径解析的 nvm 兼容包装脚本（PR #15）
- **[@beekamai](https://github.com/beekamai)** — 当 npm root 包含空格时 `claude-fixed.bat` 的 Windows URL 编码修复（PR #17）
- **[@JEONG-JIWOO](https://github.com/JEONG-JIWOO)** — VS Code 扩展调查：发现 `claudeCode.claudeProcessWrapper` 作为有效集成路径，为 Windows 编写 C 包装器（#16）
- **[@X-15](https://github.com/X-15)** — VS Code 扩展验证，按修复健康状态分析确认 v2.1.105 的安全检查行为（#16）
- **[@deafsquad](https://github.com/deafsquad)** — 通用 smoosh_split 反合并修复（PR #26），resume 散落 bug 的源码级函数归因（anthropics/claude-code#43657），OTEL 遥测发现，提议并构建 v3.0.0 的代理架构
- **[@vmfarms](https://github.com/vmfarms)** — 并发多运行器生产验证，暴露代理模式 resume-marker 正则空操作（#96）、TTL 等级检测差距（#97）和图像剥离 stderr 泄漏（#98）
- **[@ojura](https://github.com/ojura)** — Opus 4.7 thinking-summaries 根因分析：提交了 [anthropics/claude-code#59844](https://github.com/anthropics/claude-code/issues/59844)，包含 CLI 二进制解码（v2.1.142 偏移量 230510599 处的 `!getIsNonInteractiveSession()` 门控）和双堆叠特殊案例框架，使 `thinking-display` 扩展（v3.6.1）成为所提议上游修复的干净代理侧补充
- **[@schuay](https://github.com/schuay)** — `quota-statusline.sh` 增强：10 格额度条，带已过时间刻度线和 exhaust-vs-reset 预测，替换之前 `%/min` 消耗速率显示（PR #140，v3.6.2），以及 d/h 与 h/m 时间格式自动选择，加命名时间单位和消耗预热常数（PR #143，v3.7.0）

如果您为这些问题的社区努力做出过贡献而未出现在此处，请提交 issue 或 PR——我们希望对每位贡献者予以应有的致谢。

---

## 支持

如果此工具为您节省了资金，考虑请我喝杯咖啡：

<a href="https://buymeacoffee.com/vsits" target="_blank"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me A Coffee" style="height: 60px !important;width: 217px !important;" ></a>

---

## 许可证

[MIT](LICENSE)

