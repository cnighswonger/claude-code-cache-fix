# claude-code-cache-fix

[![npm](https://img.shields.io/npm/v/claude-code-cache-fix?color=blue)](https://www.npmjs.com/package/claude-code-cache-fix) [![Node.js](https://img.shields.io/badge/Node.js-18%2B-green)](https://nodejs.org/) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow)](https://opensource.org/licenses/MIT) [![GitHub stars](https://img.shields.io/github/stars/cnighswonger/claude-code-cache-fix)](https://github.com/cnighswonger/claude-code-cache-fix/stargazers)

[English](./README.md) | 中文 | [한국어](./README.ko.md) | [Português](./docs/guia-pt-br.md)

[Claude Code](https://github.com/anthropics/claude-code) 的缓存优化代理。修复导致配额过度消耗的提示缓存 bug，稳定请求前缀，并监控静默回归。支持所有 CC 版本，包括 v2.1.113+ Bun 二进制文件。

> **v3.0.3** — 具有 7 个热重载扩展的本地 HTTP 代理。在 v2.1.117 上 A/B 测试：首次热启动轮次 **代理经由 95.5% 缓存命中率 vs 直连 82.3%**。[完整发布说明 →](https://github.com/cnighswonger/claude-code-cache-fix/releases/tag/v3.0.0)

> **Opus 4.7 注意事项：** 计量数据显示 4.7 在相同可见 token 数量下 **Q5h 配额消耗速率约为 4.6 的 2.4 倍**（[@ArkNill 独立确认](https://github.com/ArkNill/claude-code-hidden-problem-analysis/blob/main/16_OPUS-47-ADVISORY.md)）。两个因素：新的分词器（最多增加 35% token，[已记录](https://platform.claude.com/docs/en/about-claude/models/whats-new-claude-4-7)）和自适应思考开销（约 105%，未在使用量响应中记录）。Q5h 影响会复合累积到 **Q7d** — 大多数重度用户最先触及的周配额上限。解决方法：`CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING=1` 可将消耗降低约 3.3 倍，但可能降低复杂任务的质量。参见 [Discussion #25](https://github.com/cnighswonger/claude-code-cache-fix/discussions/25)（初始观察）和 [Discussion #42](https://github.com/cnighswonger/claude-code-cache-fix/discussions/42)（对照 A/B 数据 + Q7d 分析）。

## 快速开始：代理（推荐）

代理适用于任何 CC 版本 — Node.js 或 Bun 二进制文件。它位于 Claude Code 和 Anthropic API 之间，通过热重载扩展应用缓存修复。

```bash
# 安装
npm install -g claude-code-cache-fix

# 启动代理（在 localhost:9801 上运行）
node "$(npm root -g)/claude-code-cache-fix/proxy/server.mjs" &

# 通过代理启动 Claude Code
ANTHROPIC_BASE_URL=http://127.0.0.1:9801 claude
```

就这样。代理会自动应用所有 7 个缓存修复扩展。无需包装脚本、`NODE_OPTIONS` 或预加载。

### 代理的工作方式

每个 `/v1/messages` 请求都会按顺序执行 7 个扩展：

| 扩展 | 修复内容 |
|------|----------|
| `fingerprint-strip` | 移除系统提示中不稳定的 cc_version 指纹 |
| `sort-stabilization` | 确保工具和 MCP 定义的确定性排序 |
| `ttl-management` | 检测服务器 TTL 层级，注入正确的 cache_control 标记 |
| `identity-normalization` | 规范化消息身份字段以保持前缀稳定性 |
| `fresh-session-sort` | 修复首次轮次的非确定性排序 |
| `cache-control-normalize` | 规范化消息间的 cache_control 标记 |
| `cache-telemetry` | 从响应头提取缓存统计 → `~/.claude/quota-status.json` |

扩展支持热重载 — 在 `proxy/extensions/` 中添加、删除或修改 `.mjs` 文件，更改将在下一次请求时生效，无需重启。配置在 `proxy/extensions.json` 中。

### 作为服务运行

**Linux（systemd — 推荐）：**

创建 `~/.config/systemd/user/cache-fix-proxy.service`：

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

# 可选：开机启动（无需登录）
sudo loginctl enable-linger $USER
```

v3.1.0 计划提供 `cache-fix-proxy install-service` 子命令（[#48](https://github.com/cnighswonger/claude-code-cache-fix/issues/48)）。

**备选方案（任何操作系统）：**

```bash
nohup node "$(npm root -g)/claude-code-cache-fix/proxy/server.mjs" > /tmp/cache-fix-proxy.log 2>&1 &
echo 'export ANTHROPIC_BASE_URL=http://127.0.0.1:9801' >> ~/.bashrc
```

### 健康检查

```bash
curl http://127.0.0.1:9801/health
# {"status":"ok"}
```

### 企业环境（代理、自定义 CA）

代理在转发到 `api.anthropic.com` 时支持以下环境变量。在 Zscaler / Netskope / Forcepoint / Bluecoat / 企业 squid 等环境下，在代理的环境中设置这些变量。

| 变量 | 效果 |
|------|------|
| `HTTPS_PROXY` / `HTTP_PROXY`（及小写变体） | 通过企业 HTTP CONNECT 代理路由上游请求。 |
| `NO_PROXY` | 逗号分隔的主机列表，绕过代理。支持 `*` 和 `.suffix.example.com`。 |
| `CACHE_FIX_PROXY_CA_FILE` | PEM 文件路径，包含一个或多个额外 CA 证书（用于 SSL 检查代理）。 |
| `NODE_EXTRA_CA_CERTS` | Node.js 标准机制 — 同样支持。 |
| `CACHE_FIX_PROXY_REJECT_UNAUTHORIZED=0` | **不安全的逃生通道。** 禁用 TLS 验证。仅在等待 IT 提供企业 CA 证书包时作为最后手段使用。 |

## 快速开始：预加载（CC v2.1.112 及更早版本）

如果使用基于 Node.js 的 CC 版本（v2.1.112 或更早），预加载拦截器无需代理即可工作：

```bash
npm install -g claude-code-cache-fix
NODE_OPTIONS="--import claude-code-cache-fix" claude
```

> **注意：** 预加载不适用于 CC v2.1.113+（Bun 二进制文件）。请使用上述代理方式。

包装脚本、Shell 别名、Windows 说明和 VS Code 预加载模式集成请参见 [docs/preload-setup.md](docs/preload-setup.md)。

## VS Code 扩展

[VS Code 扩展](https://github.com/cnighswonger/claude-code-cache-fix-vscode)（v0.5.0）支持代理和预加载两种模式：

**代理模式（推荐）：**
1. 启动代理（见上文）
2. 在 VS Code 命令面板中：**Claude Code Cache Fix: Enable Proxy Mode**
3. 重启任何活跃的 Claude Code 会话

**预加载模式（CC ≤v2.1.112）：**
1. `npm install -g claude-code-cache-fix`
2. 从 [GitHub Releases](https://github.com/cnighswonger/claude-code-cache-fix-vscode/releases/latest) 下载 VSIX
3. 安装：`code --install-extension claude-code-cache-fix-0.5.0.vsix`
4. 命令面板：**Claude Code Cache Fix: Enable**

手动 VS Code 包装器设置（不使用 VSIX）请参见 [docs/preload-setup.md](docs/preload-setup.md#vs-code-preload-mode)。

## 安全模型

> **代理和拦截器对 API 请求和响应具有完全读写访问权限。** 这是该方法固有的特性 — 任何 fetch 拦截器、代理或网关都处于这个位置。

**它做什么：** 修改出站请求结构（块排序、指纹、TTL、git-status）以修复缓存 bug。读取响应头和 SSE 使用量数据用于监控。

**它不做什么：** 代理或拦截器不会发起网络调用。所有遥测数据写入 `~/.claude/` 下的本地文件。数据不会离开你的机器。

**供应链：** 代理模式：7 个小型扩展模块在 `proxy/extensions/` 中（每个不到 200 行）。预加载模式：单个未压缩文件（`preload.mjs`，约 1,700 行）。一个开发依赖（`zod`，仅用于测试中的模式验证）。安装前请审查代码。npm 出处（provenance）将每个发布版本链接到其源代码提交。

**独立审计：** 被 @TheAuditorTool [评估为"合法工具"](https://github.com/anthropics/claude-code/issues/38335#issuecomment-4244413605)（2026-04-14）。

## 问题描述

当你在 Claude Code 中使用 `--resume` 或 `/resume` 时，提示缓存会静默失效。API 不再读取已缓存的 token（廉价），而是每一轮都从头重建（昂贵）。原本每小时约 $0.50 的会话可能在无任何提示的情况下飙升至 $5-10/小时。

三个 bug 导致了这个问题：

1. **附件块散布** — 技能列表、MCP 服务器、延迟工具、钩子等附件块应当位于 `messages[0]`。恢复会话时，它们会漂移到后续消息中，改变缓存前缀。

2. **指纹不稳定** — `cc_version` 指纹（如 `2.1.92.a3f`）基于 `messages[0]` 的内容计算，包括元数据/附件块。当这些块偏移时，指纹改变，系统提示改变，缓存失效。

3. **工具定义排序不确定** — 工具定义在不同轮次间可能以不同顺序到达，改变请求字节并使缓存键失效。

此外，通过 Read 工具读取的图片以 base64 形式持久化在对话历史中，在每次后续 API 调用时一并发送，悄然增加 token 成本。

## 工作原理

**代理模式**（v3.0.0+）：一个位于 `localhost:9801` 的 HTTP 服务器拦截 `POST /v1/messages` 请求。七个扩展模块通过流水线处理每个请求 — 规范化块排序、剥离指纹、稳定工具排序、管理 TTL 标记。扩展是可热重载的 `.mjs` 文件，通过 `proxy/extensions.json` 配置。所有其他流量原样传递。

**预加载模式**（v2.x）：一个 Node.js `--import` 模块，在 Claude Code 发起 API 调用前修补 `globalThis.fetch`。应用相同的修复 — 扫描用户消息中的迁移块、排序工具、重新计算指纹、注入 TTL 标记。

两种模式都是幂等的 — 如果无需修复，请求原样传递。两种模式都不会修改你的对话；它们只在请求到达 API 之前规范化请求结构。

## 状态栏 — 实时配额警告

代理和预加载模式都会在每次 API 调用时将配额状态写入 `~/.claude/quota-status.json`。内置的 `tools/quota-statusline.sh` 脚本显示实时状态栏：

- **Q5h %** 及消耗速率（%/分钟）
- **Q7d %** 及消耗速率（%/小时）
- **TTL 层级** — 健康时显示 `TTL:1h`，**服务器降级时以红色显示 `TTL:5m`**（通常在 Q5h ≥ 100% 时）
- **PEAK** 在工作日高峰时段（UTC 13:00-19:00）以黄色显示
- **缓存命中率 %**
- **OVERAGE** 标志（激活时）

### 建议：禁用 git-status 注入

Claude Code 在每次调用时将实时 `git status` 注入系统提示。任何文件编辑都会改变 git status，从而使整个前缀缓存失效。禁用此功能每次调用可节省约 1,800 token：

```bash
export CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS=1
```

或在 `~/.claude/settings.json` 中添加 `"includeGitInstructions": false`。社区验证者 [@wadabum](https://github.com/cnighswonger/claude-code-cache-fix/issues/11)：跨 git 状态变化仅 18 token 缓存创建（禁用前为数千 token）。

## 图片剥离（预加载模式）

通过 Read 工具读取的图片以 base64 持久化在对话历史中，在每次后续 API 调用时随行发送。单张 500KB 图片在 Opus 4.6 上每轮带来约 62,500 token 开销，**在 Opus 4.7 上约 85,000+ token**（因新分词器）。强烈建议在 4.7 上启用图片剥离。

```bash
export CACHE_FIX_IMAGE_KEEP_LAST=3
```

## 系统提示重写（预加载模式，可选）

拦截器可重写 Claude Code 的 `# Output efficiency` 系统提示段落。默认禁用。使用 `CACHE_FIX_OUTPUT_EFFICIENCY_REPLACEMENT` 启用。三种已知提示变体及使用说明请参见 [docs/output-efficiency-prompts.md](docs/output-efficiency-prompts.md)。

## 监控与诊断

预加载拦截器包含对微压缩降级、虚假速率限制器、GrowthBook 标志状态、使用量遥测和成本报告的监控。配额追踪在代理和预加载模式下均通过 `~/.claude/quota-status.json` 工作。

完整详情、调试模式、前缀差异对比、环境变量和内置配额分析工具请参见 [docs/monitoring.md](docs/monitoring.md)。

## 限制

- **代理需要运行中的进程** — 必须在 Claude Code 之前启动代理。建议作为 systemd 服务运行或使用带健康检查的包装脚本。
- **超额 TTL 降级** — 超过 5 小时配额的 100% 会触发服务器端 TTL 从 1h 降级至 5m。这是服务器端决策，无法在客户端修复。代理/拦截器防止可能推你进入超额状态的缓存不稳定。
- **微压缩不可阻止** — 监控功能可以检测上下文降级但无法阻止。微压缩和预算执行是通过 GrowthBook 标志的服务器控制，没有客户端禁用选项。
- **系统提示重写是实验性的** — 仅预加载模式，可选。未证明是社区报告中讨论的行为差异的原因。使用风险由用户自行承担。
- **版本耦合** — 指纹 salt 和块检测启发式规则源自 Claude Code 内部实现。重大重构可能需要更新此包。

## 追踪的问题

我们监控 30 多个与缓存、配额和上下文 bug 相关的上游 Claude Code 问题。完整列表、我们的参与情况、社区研究和关键贡献者请参见 [TRACKED_ISSUES.md](TRACKED_ISSUES.md)。

## 相关研究

- **[@ArkNill/claude-code-hidden-problem-analysis](https://github.com/ArkNill/claude-code-hidden-problem-analysis)** — 38,996 请求的代理分析：7 个 bug（微压缩、预算上限、虚假速率限制器、JSONL 重复、扩展思考）、GrowthBook 功能标志因果测试、Opus 4.7 消耗率警告。v1.1.0 的监控功能基于此研究。
- **[@Renvect/X-Ray-Claude-Code-Interceptor](https://github.com/Renvect/X-Ray-Claude-Code-Interceptor)** — 带实时仪表板的诊断 HTTPS 代理、系统提示段落差异对比、按工具的剥离阈值。支持所有使用 `ANTHROPIC_BASE_URL` 的 Claude 客户端。
- **[@fgrosswig/claude-usage-dashboard](https://github.com/fgrosswig/claude-usage-dashboard)** — 自托管取证仪表板，SSE 实时监控、多主机聚合、缓存健康评分。与我们代理的视角互补。连接设置请参见 [docs/dashboard-integration.md](docs/dashboard-integration.md)。

## 生产环境使用

- **[Crunchloop DAP](https://dap.crunchloop.ai)** — Agent SDK / DAP 开发环境。首个将拦截器合入 trunk 并团队级部署的生产团队（2026-04-10）。通过实际测试发现两类缓存回归问题 — 工具排序抖动与新会话排序缺口，并贡献了驱动 v1.5.1 和 v1.6.2 修复的调试日志。

## 贡献者

- **[@VictorSun92](https://github.com/VictorSun92)** — v2.1.88 原始 monkey-patch 修复，v2.1.90 部分散布识别，前向扫描检测、正确块排序、更严格的块匹配器及可选 output-efficiency 重写钩子
- **[@bilby91](https://github.com/bilby91)** ([Crunchloop DAP](https://dap.crunchloop.ai)) — Agent SDK / DAP 生产环境验证，1h 缓存 TTL 确认，调试追踪发现工具排序抖动（v1.5.1 修复），SKILLS SORT 诊断发现新会话排序 bug（v1.6.2 修复）。首个将拦截器合入 trunk 的生产团队。
- **[@jmarianski](https://github.com/jmarianski)** — 通过 MITM 代理抓包和 Ghidra 逆向分析定位根因，多模式缓存测试脚本
- **[@cnighswonger](https://github.com/cnighswonger)** — 指纹稳定化、工具排序修复、图片剥离、监控功能、超额 TTL 降级发现、代理架构，包维护者
- **[@ArkNill](https://github.com/ArkNill)** — 微压缩机制分析、GrowthBook 标志文档、虚假速率限制器识别、CC v2.1.108+ 指纹验证修复（PR #21）、韩文 README（PR #22）、[claude-code-hidden-problem-analysis](https://github.com/ArkNill/claude-code-hidden-problem-analysis) 研究
- **[@Renvect](https://github.com/Renvect)** — 图片重复发现、跨项目目录污染分析
- **[@fgrosswig](https://github.com/fgrosswig)** — [claude-usage-dashboard](https://github.com/fgrosswig/claude-usage-dashboard) 取证方法论：成本因子开销比率指标、`anthropic-*` 头部捕获模式、为仪表板互通层提供参考的代理 NDJSON 模式
- **[@TomTheMenace](https://github.com/TomTheMenace)** — Windows `.bat` 包装器、首个 Windows 平台验证（7.5 小时/536 调用 Opus 4.6 会话，98.4% 缓存命中率）
- **[@arjansingh](https://github.com/arjansingh)** — 动态 `npm root -g` 路径解析的 nvm 兼容包装脚本（PR #15）
- **[@beekamai](https://github.com/beekamai)** — npm root 包含空格时的 Windows URL 编码修复（PR #17）
- **[@JEONG-JIWOO](https://github.com/JEONG-JIWOO)** — VS Code 扩展调查：发现 `claudeCode.claudeProcessWrapper` 作为可行的集成路径，编写 Windows C 包装器（#16）
- **[@X-15](https://github.com/X-15)** — VS Code 扩展验证、v2.1.105 安全检查行为确认的每项修复状态分析（#16）、Windows 代理管道修复（#53）、企业代理支持（PR #54）
- **[@deafsquad](https://github.com/deafsquad)** — 通用 smoosh_split un-smoosh 修复（PR #26）、恢复散布 bug 的源码级函数归因（anthropics/claude-code#43657）、OTEL 遥测发现、v3.0.0 代理架构提议与构建

如果你参与了这些问题的社区协作但尚未被列出，欢迎开 issue 或 PR — 我们希望正确致谢每一位贡献者。

## 支持

如果这个工具帮你省了钱，请考虑请我喝杯咖啡：

<a href="https://buymeacoffee.com/vsits" target="_blank"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me A Coffee" style="height: 60px !important;width: 217px !important;" ></a>

## 许可证

[MIT](LICENSE)
