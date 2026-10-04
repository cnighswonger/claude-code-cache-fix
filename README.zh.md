# claude-code-cache-fix

[![npm](https://img.shields.io/npm/v/claude-code-cache-fix?color=blue)](https://www.npmjs.com/package/claude-code-cache-fix) [![Node.js](https://img.shields.io/badge/Node.js-18%2B-green)](https://nodejs.org/) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow)](https://opensource.org/licenses/MIT) [![GitHub stars](https://img.shields.io/github/stars/cnighswonger/claude-code-cache-fix)](https://github.com/cnighswonger/claude-code-cache-fix/stargazers)

[English](./README.md) | 中文 | [한국어](./README.ko.md) | [Français](./README.fr.md) | [Português](./docs/guia-pt-br.md)

> **说明：** 本翻译由机器辅助生成，可能滞后于英文版 README。任何权威信息请参见 [README.md](./README.md)。欢迎修正——请提交 PR。
>
> **Note:** This translation is machine-assisted and may lag the English README. For anything authoritative, see [README.md](./README.md). Corrections are very welcome — please open a PR.

为 [Claude Code](https://github.com/anthropics/claude-code) 打造的缓存优化代理。修复导致额度过度消耗的提示缓存 bug，稳定请求前缀，并监控静默回归。兼容所有 CC 版本，包括 v2.1.113+ 的 Bun 二进制版。

*此 README 文档记录了当前 `main`；发布可用性按功能标注。*

## 它对您的流量做了什么

本地代理位于 Claude Code 和 Anthropic 之间。在您继续阅读之前，请注意这的确切含义 —— 完整处理见 [安全模型](#security-model)。

- **默认绑定到 `127.0.0.1`**。
- **将 Claude Code 流量转发至 Anthropic。在默认路径上它不会发出其他出站调用** —— 遥测写入本地文件，位于 `~/.claude/`，从不发送到任何地方。两个可选功能会执行自己的出站操作，除非您启用它们：OAuth 刷新（`CACHE_FIX_OAUTH_REFRESH=on`）会发布到 Anthropic 的令牌端点，前向代理下载加速会重新发出发布下载到 `downloads.claude.ai` / `storage.googleapis.com`。
- **可以读取和重写 `POST /v1/messages`。** 这个能力 *就是* 缓存修复 —— 没有这个功能的版本无法工作。
- **它是幂等的：如果不需要修复，请求会原样通过。** 它规范化请求结构（块顺序、指纹、TTL）；它不会修改您的对话。
- **每个转换是一个文件** 在 `proxy/extensions/` 中，可独立阅读。
- [独立评估为合法工具](https://github.com/anthropics/claude-code/issues/38335#issuecomment-4244413605) 由 @TheAuditorTool (2026-04-14)。

前向代理模式（`--remote-control`）还会终止 `api.anthropic.com` 的 TLS，使用本地生成的 CA，您的客户端必须信任它。其他所有内容都是盲隧道。该模式是可选的，默认关闭。

## 您是否需要这个？

**如果您安装或测试它：** 重复出现 `cache_creation_input_tokens` 突增的恢复或长时间会话；缓存读取率低或不稳定；看到意外的 TTL 5m 降级、thinking-desync `400` 或图像重试风暴；或者以下非缓存表面适用。

**您可以跳过它：** 您的会话已经保持稳定的高缓存读取率；您很少恢复长时间会话；您不处于额度压力下；或您宁愿不在 API 路径中放置本地代理。**这四个都是不安装此项目的良好理由。**

如果您不确定哪个适用，请测量一下 —— 您无需安装此项目即可找出答案。

## 检查您是否遇到这个问题

Claude Code 已经在其会话转录中记录每个请求的缓存会计，因此您可以在安装任何东西之前立即测量您的缓存健康状况。

```bash
# 替换 <session-uuid>，或使用通配符选择最近的会话。
jq -r 'select(.message.usage.cache_read_input_tokens != null) |
  "\(.requestId)\t\(.message.usage.cache_read_input_tokens) \(.message.usage.cache_creation_input_tokens)"' \
  ~/.claude/projects/*/<session-uuid>.jsonl |
  sort -u -k1,1 | cut -f2 |
  awk '{n++; r+=$1; c+=$2}
       END {if (n==0) print "no usage rows found — check the session path";
            else printf "requests=%d cache_read=%d creation=%d read-ratio=%.0f%%\n", n, r, c, 100*r/(r+c)}'
```

`sort -u -k1,1` 每个 API 调用只计算一次 —— Claude Code 为每个请求写入多个转录行，且 **不是每次请求都相同次数** ([ArkNill 的分析](https://github.com/ArkNill/claude-code-hidden-problem-analysis))。求和原始行会按其重复次数加权每次调用。在一台机器上对本地转录进行两次独立扫描（2026-08-02）一致：**短会话是问题所在** —— 超过一半的 20 次请求以下的会话在未去重的情况下偏移一个点或更多，最坏情况 **41 点**，而长会话几乎都是子点（3/37）。短会话正是第一次阅读者将针对此问题进行测试的内容。

读取结果：

- **少于 ~20 次请求：数字无意义。** 冷启动还没有可读内容，因此创建占主导地位，每个健康的会话看起来都坏了。使用长或恢复的会话。
- **长时间会话持续低比率，或每次 `--resume` 时 `creation` 突增** —— 这就是此项目存在的问题。
- **长时间会话高比率** —— 您不需要这个。参见 *您是否需要这个？* 上面。

## 当前建议

> **v4.0.0** — 本地 HTTP 代理，包含成本影响和可观察性扩展的管道。两个长期默认值翻转：`thinking-block-sanitize` v1 默认开启（缓解 thinking-desync `400` 楔子 —— [#63147](https://github.com/anthropics/claude-code/issues/63147)) 和进程内扩展热重载默认关闭 (`CACHE_FIX_HOT_RELOAD=on`)。A/B 基线（v3.0.0 在 v2.1.117 上）：**通过代理的缓存命中率为 95.5% vs 直接的 82.3%** 在首次预热轮次上。[完整发布说明 →](https://github.com/cnighswonger/claude-code-cache-fix/releases/tag/v4.0.0)

> **Opus 4.7 警示：** 计量数据显示，对于等量可见 token，4.7 消耗 Q5h 额度的速率约为 4.6 的 **~2.4 倍**（[由 @ArkNill 独立确认](https://github.com/ArkNill/claude-code-hidden-problem-analysis/blob/main/16_OPUS-47-ADVISORY.md)）。两个因素：新的分词器（最多出 35% 的 token，[已有文档说明](https://platform.claude.com/docs/en/about-claude/models/whats-new-claude-4-7)）和自适应思考开销（约 105%，未在使用量响应中文档化）。Q5h 的影响会累积到 **Q7d**——大多数重度用户最先触及的周额度上限。变通方案：`CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING=1` 可将消耗降低约 3.3 倍，但可能在复杂任务上降低质量。参见 [讨论 #25](https://github.com/cnighswonger/claude-code-cache-fix/discussions/25)（初步观察）和 [讨论 #42](https://github.com/cnighswonger/claude-code-cache-fix/discussions/42)（受控 A/B 数据 + Q7d 分析）。

## 快速上手：代理（推荐）

代理适用于任何 CC 版本——Node.js 或 Bun 二进制版本。它位于 Claude Code 和 Anthropic API 之间，以可组合的扩展形式应用缓存修复。

```bash
# 安装
npm install -g claude-code-cache-fix

# 启动代理（在 localhost:9801 上运行）
node "$(npm root -g)/claude-code-cache-fix/proxy/server.mjs" &

# 通过代理启动 Claude Code
ANTHROPIC_BASE_URL=http://127.0.0.1:9801 claude
```

就这样。代理会自动应用其默认扩展管道。无需包装脚本、无需 `NODE_OPTIONS`、无需预加载。

### 前向代理模式（保持远程控制工作）

上述快速入门是 **反向代理模式**：您将 `ANTHROPIC_BASE_URL` 指向代理。这很简单，但在 Claude Code **>= 2.1.196** 上，非 Anthropic 的 `ANTHROPIC_BASE_URL` **会禁用远程控制**（`/remote-control`）、`/schedule` 和 claude.ai MCP 连接器（CC 将任何自定义基础 URL 视为 Bedrock/Vertex 网关）。如果您依赖这些功能，请使用前向代理模式。

在 **前向代理模式** 下，代理位于 *真实* `api.anthropic.com` 前面，作为 `HTTPS_PROXY`。Claude Code 的基础 URL 保持 `api.anthropic.com`，因此远程控制保持工作，而代理仍能看到并转换 `/v1/messages`。

```bash
# 在前向代理模式下启动代理
CACHE_FIX_FORWARD_PROXY=on node "$(npm root -g)/claude-code-cache-fix/proxy/server.mjs" &
# 它会打印两个环境变量来连接客户端，例如：
#   export HTTPS_PROXY=http://127.0.0.1:9801
#   export NODE_EXTRA_CA_CERTS=~/.claude/cache-fix-ca/ca.pem

# 通过代理启动 Claude Code（保持 ANTHROPIC_BASE_URL 不设置）
HTTPS_PROXY=http://127.0.0.1:9801 \
NODE_EXTRA_CA_CERTS=~/.claude/cache-fix-ca/ca.pem \
  claude
```

或者让启动器为您自动完成这两个步骤，使用 `--remote-control`：

```bash
# 启动代理并设置 CACHE_FIX_FORWARD_PROXY=on，自动连接客户端
# (HTTPS_PROXY + MITM CA，ANTHROPIC_BASE_URL 留空)。
cache-fix-proxy --remote-control
```

`--remote-control` 标志是上述手动连接的一步命令等效：它启动代理在前向代理模式下，等待 CA，然后启动 `claude` 指向 `HTTPS_PROXY` 并设置 `NODE_EXTRA_CA_CERTS`（并添加 `127.0.0.1,localhost,::1` 到 `NO_PROXY` 以便本地服务 —— 例如本地 HTTP/SSE-transport MCP 服务器绕过代理而不是路由到它；任何现有的 `NO_PROXY` 都会被保留）。不带标志时，启动器保持反向代理模式（设置 `ANTHROPIC_BASE_URL`），不变。有两点值得注意：远程控制在首次连接时进行受信任设备注册，可能需要几次 `/remote-control` 重试（这是 Claude Code 步骤，在代理失败之前运行）；在已经热启动的会话上启用 RC 会花费 **单次** 提示缓存重建（RC 添加一个 `anthropic-beta` 缓存键），因此如果您想要 RC，从一开始就使用 `--remote-control` 启动可以避免这次一次性翻转。`cache-fix-proxy --help` 记录两者。

> 如果您手动连接前向代理模式（自己设置 `HTTPS_PROXY` 而不是使用 `--remote-control`），请同时设置 `NO_PROXY=127.0.0.1,localhost,::1`，否则本地 HTTP-transport MCP 服务器和其他 localhost 服务会被路由到 cache-fix 代理并失败。stdio-transport MCP 服务器不受影响（它们使用管道，而不是网络）。

工作原理：代理还处理 HTTP `CONNECT`。它 **仅** MITM 上游主机 (`api.anthropic.com`)，终止 TLS 并使用本地生成的 CA，因此它可以运行相同的扩展管道，并且 **盲隧道化所有其他 CONNECT** (mcp-proxy, 遥测, npm, ...)。首次启动时，在 `$CLAUDE_CONFIG_DIR/cache-fix-ca/` 下生成 CA（默认 `~/.claude/cache-fix-ca/`；通过 `CACHE_FIX_CA_DIR` 覆盖）；客户端必须通过 `NODE_EXTRA_CA_CERTS` 信任它。到上游主机的 WebSocket/Upgrade（例如 `/voice`）会原样中继到上游。由于基础 URL 保持 `api.anthropic.com`，所有 `/api/oauth/*`, `/v1/agents`, 远程控制凭据获取等都会无阻碍地通过，远程控制保持启用。

企业代理链与反向模式相同：设置 `HTTPS_PROXY`/`HTTP_PROXY` 用于代理的 **自身** 上游出站（代理拨号 `api.anthropic.com` 通过它）。客户端的 `HTTPS_PROXY` 指向 cache-fix 代理；cache-fix 代理的 `HTTPS_PROXY`（在其自己的环境中）指向企业代理。

**共享代理上的崩溃语义。** 在前向代理模式下，代理 MITM 整个上游主机，因此进行中的 Claude Code 会话被连接到 *此* 端口，无法失败转移。为了防止一个坏请求导致进程崩溃，成功的前向代理附加安装了 `uncaughtException`/`unhandledRejection` 处理程序，记录并继续服务而不是崩溃。这些处理程序限定于前向模式（反向代理保持 Node 的默认崩溃行为，让其监督者重启它）并在最后一个前向实例关闭时移除。权衡：在 **共享 / 多租户** 代理上，启用前向模式会改变每个客户端的崩溃行为 —— 致命错误会被吞掉而不是暴露给监督者。如果您为多个会话运行一个代理，请权衡这一点与受监督的每会话模型。

**持久运行它。** 上面的 `... node .../proxy/server.mjs &` 适用于快速尝试，但后台进程不受监督：如果崩溃或机器重启，它不会自动重启。要将前向代理模式作为管理服务运行（自动重启、登录时启动），请使用与 [作为服务运行](#running-as-a-service) 下描述的相同 `install-service` 路径 —— 只是在安装时设置标志，使其烘焙到单元中：

```bash
CACHE_FIX_FORWARD_PROXY=on cache-fix-proxy install-service
```

生成的 systemd 单元 / launchd 代理携带 `CACHE_FIX_FORWARD_PROXY=on`，因此服务启动代理在前向代理模式下并保持运行（systemd `Restart=on-failure` 加上健康检查计时器；launchd `KeepAlive`）。

**服务只管理代理端。** 它 **不** —— 也不能 —— 设置您的 `claude` 客户端的任何内容，这是一个单独的进程。您仍需在启动 `claude` 的任何 shell 中手动连接客户端，使用上述前向代理快速入门中的两个值：

- `HTTPS_PROXY` —— 代理监听的位置：`http://127.0.0.1:<port>`（默认端口 `9801`，或您的 `CACHE_FIX_PROXY_PORT`）。
- `NODE_EXTRA_CA_CERTS` —— 代理首次启动时生成的 CA：`~/.claude/cache-fix-ca/ca.pem`（或 `$CACHE_FIX_CA_DIR/ca.pem`）。

三种方式连接它，取决于您希望变量应用的范围。

> **如果此主机上的任何其他内容也 MITMs `api.anthropic.com`** —— 企业 TLS 检查代理、账户切换针代理 —— 不要使用这些配方。`NODE_EXTRA_CA_CERTS` 只接受一个文件，因此将其绑定到我们的 CA 会静默取消信任每个其他组件。使用 `--remote-control`，它发布到 `ca-trust.d/` 并消费合并的捆绑包。参见 [与同一台机器上的另一个 MITM 共存](#coexisting-with-another-mitm-on-the-same-machine-ca-trustd)。

```bash
# a) 每次调用 —— 仅限此次 claude 运行
HTTPS_PROXY=http://127.0.0.1:9801 \
NODE_EXTRA_CA_CERTS=~/.claude/cache-fix-ca/ca.pem \
  claude

# b) 整个 shell —— 添加到 ~/.zshrc / ~/.bashrc（该 shell 中的每个 HTTPS 都通过代理；无害，因为非 Anthropic 主机是盲隧道，但如果代理始终关闭，该 shell 的 HTTPS 会中断）
export HTTPS_PROXY=http://127.0.0.1:9801
export NODE_EXTRA_CA_CERTS=~/.claude/cache-fix-ca/ca.pem

# c) 仅限 claude —— shell 函数（推荐；避免 b 的影响范围）
claude() {
  HTTPS_PROXY=http://127.0.0.1:9801 \
  NODE_EXTRA_CA_CERTS=~/.claude/cache-fix-ca/ca.pem \
    command claude "$@"
}
```

#### 与同一台机器上的另一个 MITM 共存（`ca-trust.d`）

`NODE_EXTRA_CA_CERTS` 只接受 **一个** 文件。如果主机上的任何其他内容也 MITMs `api.anthropic.com` 并且也设置了该变量 —— 企业代理、账户切换针代理 —— 最后写入者胜出，每个其他 CA 都会静默取消信任。2026-07-30 测量：一台机器上的两个此类组件轮流破坏彼此的 TLS，没有归因于任一组件的错误。

因此 `--remote-control` 不只是分配变量。它：

1. **发布** 我们的 CA 到 `<config>/ca-trust.d/ccf.pem` —— 我们自己的文件名，从不与兄弟文件冲突，每次启动都会重写（代理在 CA 目录被清除时重新生成其 CA，且旧的 pem 会广告一个没有签名密钥的内容），如果字节匹配则跳过，并通过临时 + `rename` 写入，因此读取者永远不会看到半写文件。
2. **读取** `<config>/ca-trust.pem` —— 由一个外部写入器从环境/企业根证书加上每个发布的 `ca-trust.d/*.pem` 构建的合并捆绑包 —— 并指向 `NODE_EXTRA_CA_CERTS`。

`<config>` 是 `CLAUDE_CONFIG_DIR` 或 `~/.claude`。**我们从不写入合并捆绑包**：合并需要找到环境特定的企业根证书（Linux 主机可能将其保留在捆绑包外；Mac 保留在钥匙串中），两个组件同时重建它会竞争一个输出。

该捆绑包仅在 node 指定该文件时实际验证我们的代理叶子。启动器不预测这一点 —— 它询问：一个从出生起就设置 `NODE_EXTRA_CA_CERTS` 的子进程建立一个持有我们叶子的 TLS 服务器并连接到它。只有从加载器真正加载了我们 CA 的捆绑包才能完成此握手。

一个失败的捆绑包比没有捆绑包更糟 —— 它会使客户端不信任其被路由通过的代理，因此每个请求都会因 TLS 失败而不是仅仅失去其他组件的 CA。

**为什么询问而不是解析。** 之前的版本模型了 node 加载器的正则表达式：base64 量子、填充位置、标记中的连字符运行，openssl 容忍的十种空白字符。它经过五轮审查，但在真实捆绑包上仍然错误 —— 接受一个 node 加载不到的，拒绝一个 node 正常加载的。它试图达到的规则实际上无法从外部表达：一个相同的撕裂在解析器中是恢复还是致命，仅取决于其截断体是否恰好是完整的 DER，这是一个字节问题，解析器无法回答。加载器可以在一次生成（裸 `node -e ''` 上约 25 毫秒 —— 测量，40 对交错：17.3 毫秒裸，42.4 毫秒探测）中做到这一点。那 25 毫秒是什么：一个 `--remote-control` 启动约 520 毫秒端到端，其中约 493 毫秒是启动代理并等待其监听。因此探测约占启动的 8%，几乎全部是 CA 工作。

**三种结果，从不两种。** `ok`、`not ok` 和 `unknown` —— 最后一个意味着无法运行探测。当无法询问时回答“不可用”的守卫会丢弃机器上每个企业根证书。

**损坏的合并不会使其他发布者失去他们的 CA。** 损坏存在于合并中，而不是喂养它的文件中，因此启动器从仍能工作的 `ca-trust.d/` 发布者重建而不是回退到其自己的 CA。节省的是每个幸存发布者的证书：在这台机器上测量（我们加一个对等），一个证书在旧回退下，两个在重建下；在三发布者主机上，一个是三个。

两个路径都是 `<config>` 下的固定名称，故意不覆盖其自身的环境变量。它们是单一约定的两半：单独一半的旋钮让参与者发布到没有构建器查看的地方，或读取一个构建器不写入的文件，同时仍看起来实现契约。`CLAUDE_CONFIG_DIR` 已经重新定位这对，它一起移动两个部分。

注意消费者检查的限制：完整，并且携带我的 CA。是否 *完整* —— 即没有企业根证书丢失 —— 是构建者的保证，消费者不应据此行动，即使可以。

这是一个设计选择，而不是缺失的能力，区别很重要，因为另一种读法是邀请：有人将之前的捆绑包作为状态添加，相信限制被解除，并添加一个地板。它仍然错误。当一个根被退休或组件被卸载时，收缩是 *合法的*，只有构建者知道发生了什么 —— 因此持有两个捆绑包的读者无法区分回归和事实。测量：一个合法的捆绑包在此机器上是 5 个证书，在另一台机器上是 168 个，因此任何在一台主机上捕获缩小的地板都会拒绝下一台主机上的健康捆绑包。

**这是同一用户进程之间的合作约定，而不是信任边界。** 检查证明 *解析并携带我们* —— 从不 *仅包含批准的写入者*。任何可以写入 `<config>` 的人都可以给我们一个格式良好的捆绑包，其中包含我们的 CA 和他们的 CA，并且它将被接受，就像他们已经替换 `ca-trust.d/ccf.pem`、CA 目录或此文件一样。该契约防御的是组件意外取消信任彼此的故障，这是实际发生的故障；它不防御本地攻击者，后者有更简单的路径。

#### `CACHE_FIX_DOWNLOAD_REWRITE` 会破坏 `claude update` —— 离开它关闭

`CACHE_FIX_DOWNLOAD_REWRITE=on` 看起来像一个纯性能旋钮。它不是：打开它 **完全禁用 `claude update`** 在该主机上。重写下载 URL 意味着读取它，这意味着 MITM `downloads.claude.ai` —— 而发布渠道客户端只绑定 **公共根证书** 并拒绝任何私有 CA，因此版本检查在下载一个字节之前就失败了：

```
Failed to fetch version from .../claude-code-releases/latest after 3 attempt(s):
  unable to verify the first certificate
```

使用 `openssl s_client -proxy 127.0.0.1:9901 -connect downloads.claude.ai:443 -servername downloads.claude.ai` 测量：

| `CACHE_FIX_DOWNLOAD_REWRITE` | 叶子 CN | 验证 |
|---|---|---|
| `on` | `api.anthropic.com` | 代码 21 |
| `off` | `downloads.claude.ai` (WR3 / GTS Root R1) | 代码 0 |

两件事使这比初看起来更糟：

- **它不能缩小到二进制下载。** MITM 是在 `CONNECT` 时间按主机决定的，版本检查与下载本身共享 `downloads.claude.ai`。它是主机范围的全有或全无。
- **没有客户端覆盖能到达该客户端。** `HTTPS_PROXY` / `ALL_PROXY`、`/etc/hosts`、`/etc/resolv.conf` 和 `NODE_EXTRA_CA_CERTS` 都在控制路径上被证明无效 —— 本地解析器记录了 0 次查询，TCP 转发器记录了 0 次连接，而通过相同转发器的 `node https.get` 返回 200。因此无论注入多少 CA 都无法使重写工作。只有不拦截才有效。

其他主机不受影响：通过同一代理的 `github.com` 返回其真实证书并验证。该标志默认关闭；除非您准备以其他方式更新 Claude Code，否则保持关闭。

### 代理做了什么

在每次 `/v1/messages` 请求上，管道运行一个有序扩展链，涵盖缓存稳定性、可观察性、thinking-desync 缓解、图像、微压缩、断点、引导通道和其他表面。几个扩展由环境变量控制，详见其下部分；引导通道处理默认为 `audit` 模式。主要功能：

| 扩展 | 它修复了什么 |
|---|---|
| `fingerprint-strip` | 从系统提示中移除不稳定的 cc_version 指纹 |
| `sort-stabilization` | 工具和 MCP 定义的确定性排序 |
| `ttl-management` | 检测服务器 TTL 等级，注入正确的 cache_control 标记 |
| `identity-normalization` | 规范化消息身份字段以保持前缀稳定 |
| `fresh-session-sort` | 修复首次轮次中的非确定性排序 |
| `cache-control-normalize` | 规范化消息间的 cache_control 标记 |
| `cache-telemetry` | 从响应头中提取缓存统计 → `~/.claude/quota-status/{account.json,sessions/<id>.json}` |
| `session-health` | 观察每个会话的 thinking-desync 风险（上下文大小 + thinking 块数量），并在会话进入危险区域前发出警告。只读 |
| `thinking-block-sanitize` | 丢弃已省略（空文本）的 thinking 块，以预先阻止 CC thinking-desync `400` 错误（#63147）。**自 v4.0.0 起默认开启** (v1 模式)。设置 `CACHE_FIX_THINKING_SANITIZE=off` 禁用，`=v2` 用于额外的工具哈希不匹配丢弃（可选）。 |
| `workflow-agent-id-synthesis` | 为 Workflow-tool 子代理派生一个稳定的每腿代理 ID，其 canonical `x-claude-code-agent-id` 头 CC 不设置 ([CC#66761](https://github.com/anthropics/claude-code/issues/66761))。默认开启；存储在 `ctx.meta._workflowAgentId` 中，从不离开代理。当安装了 meter v0.8.0+ 且设置了 `CACHE_FIX_USAGE_LOG_AGENT_ID=on` 时，`usage-log` 会发出 `agent_id` + `agent_id_source` 字段。主开关：`CACHE_FIX_WORKFLOW_AGENT_DERIVATION=off`。 |
| `session-budget-breaker` | 可选的硬 **每会话支出上限** —— 一旦其累积 token / 估计成本 / 消耗率超过您设置的限制，本地短路该会话的请求，因此失控的扇出不会驱动信用或自动购买 ([CC#68285](https://github.com/anthropics/claude-code/issues/68285))。默认关闭；失败开放。门控 `CACHE_FIX_SESSION_BUDGET=on` + 一个上限。参见 [会话预算断路器](#session-budget-circuit-breaker-proxy-mode-opt-in)。 |

扩展作为 `.mjs` 文件存在于 `proxy/extensions/` 中，配置在 `proxy/extensions.json` 中。自 v4.0.0 起，代理在启动时加载一次；添加、删除或修改扩展需要监督级代理重启（参见 [从 v3.x 升级](#upgrading-from-v3x)）。热重载作为可选功能通过 `CACHE_FIX_HOT_RELOAD=on` 提供，适用于希望恢复 v3.x 行为的用户；该路径受 [#196](https://github.com/cnighswonger/claude-code-cache-fix/issues/196) 中记录的 Node ESM 停滞导入竞争影响。

**开发新扩展？** 请参见 [docs/parallel-proxy-test-harness.md](docs/parallel-proxy-test-harness.md) 了解我们如何在不干扰生产代理的情况下，使用真实 `claude -p` 流量端到端测试扩展的模式。

### 作为服务运行

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
systemctl --user enable --now cache-fix-proxy-healthcheck.timer   # 自动恢复——见下文
sudo loginctl enable-linger $USER   # 可选：在开机时启动，而非仅在登录时启动
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

镜像标签：`latest`、`4`、`4.0`、`4.0.0`（语义化版本阶梯，所以 `4` 始终指向最新的 4.x）。`latest` 始终跟踪最新的标记发布。

**Linux 注意：** 下文链式上游 `host.docker.internal` 示例在 Docker Desktop（macOS / Windows）上是自动可用的。在纯 Linux Docker Engine 上，通常需要 `--add-host=host.docker.internal:host-gateway`，以便该名称解析到主机网桥。否则，容器的名称查找会失败，代理无法访问主机上运行的上游服务。将 cache-fix 代理链式通过主机上运行的 `llm-relay` 的示例：

```bash
docker run -d --name cache-fix-proxy --restart=always -p 9801:9801 \
  --add-host=host.docker.internal:host-gateway \
  -e CACHE_FIX_PROXY_UPSTREAM=http://host.docker.internal:8080 \
  ghcr.io/cnighswonger/claude-code-cache-fix:latest
```

**Docker 中的前向代理模式**（保持远程控制；参见 [前向代理模式](#forward-proxy-mode-keeps-remote-control-working)）。添加 `-e CACHE_FIX_FORWARD_PROXY=on` 并将 `CACHE_FIX_CA_DIR` 指向可写路径。该镜像以非特权 `node` 用户（uid 1000）运行，且一个新鲜的 Docker 命名卷挂载 **根拥有**，因此使用您 `chown` 到 uid 1000 的绑定挂载（这也会在重启时持久化 CA 并允许主机读取它）：

```bash
mkdir -p ./cache-fix-ca && sudo chown 1000:1000 ./cache-fix-ca
docker run -d --name cache-fix-proxy --restart=always -p 9801:9801 \
  -e CACHE_FIX_FORWARD_PROXY=on \
  -e CACHE_FIX_CA_DIR=/ca -v "$PWD/cache-fix-ca:/ca" \
  ghcr.io/cnighswonger/claude-code-cache-fix:latest

# 现在 CA 在主机上的 ./cache-fix-ca/ca.pem。指向代理的客户端（保持 ANTHROPIC_BASE_URL 不设置以保持远程控制启用）：
HTTPS_PROXY=http://127.0.0.1:9801 NODE_EXTRA_CA_CERTS=$PWD/cache-fix-ca/ca.pem claude
```

如果您不需要 CA 在主机上持久化，可以丢弃卷并让它留在容器的可写层中：`-e CACHE_FIX_CA_DIR=/tmp/cache-fix-ca`（然后 `docker cp cache-fix-proxy:/tmp/cache-fix-ca/ca.pem ./ca.pem` 来获取它）。检查是否成功：`curl -s localhost:9801/health` 必须报告 `"forward_proxy":true`；如果为 `false`，则代理回退到反向代理（例如不可写的 CA 目录）。

### 健康检查

```bash
curl http://127.0.0.1:9801/health
# {"status":"ok"}
```

### 代理配置

所有代理设置均通过环境变量控制。在启动代理服务器之前设置它们。

| 变量 | 默认值 | 说明 |
|---|---|---|
| `CACHE_FIX_PROXY_PORT` | `9801` | 监听端口 |
| `CACHE_FIX_PROXY_BIND` | `127.0.0.1` | 绑定地址 |
| `CACHE_FIX_PROXY_UPSTREAM` | `https://api.anthropic.com` | 上游 URL。更改以链式另一个代理（例如 `http://localhost:8080`） |
| `CACHE_FIX_FORWARD_PROXY` | 未设置 | 设置为 `on` 以启用前向代理模式（HTTP CONNECT + 对上游主机的选择性 MITM），因此客户端指向 `HTTPS_PROXY` 而不是 `ANTHROPIC_BASE_URL`，保持远程控制启用。参见 [前向代理模式](#forward-proxy-mode-keeps-remote-control-working)。 |
| `CACHE_FIX_CA_DIR` | `~/.claude/cache-fix-ca` | 前向代理 CA/叶子证书目录（首次启动时生成一次）。客户端通过 `NODE_EXTRA_CA_CERTS` 信任 `ca.pem`。 |
| `CACHE_FIX_PROXY_TIMEOUT` | `600000` | 请求超时时间（毫秒） |
| `CACHE_FIX_EXTENSIONS_DIR` | `proxy/extensions/` | 扩展 `.mjs` 文件目录 |
| `CACHE_FIX_EXTENSIONS_CONFIG` | `proxy/extensions.json` | 扩展配置文件 |
| `CACHE_FIX_DEBUG` | `0` | 启用调试日志 |
| `CACHE_FIX_HOT_RELOAD` | 未设置 | 设置为 `on` 以启用进程内扩展热重载。自 v4.0.0 起默认关闭 —— 参见 [从 v3.x 升级](#upgrading-from-v3x) 了解详情和监督者重启流程。 |
| `CACHE_FIX_READ_DEDUPE` | 未设置 | 设置为 `1` 以去重重复的 `Read` 工具结果，这些结果在轮次中重新出现且未更改。保持第一次出现完整；替换后续字节相同的（基于 `file_path` + 内容 + `offset` + `limit`）为稳定指针行。默认关闭；在会话中选择性启用以验证后再广泛推广。参见 [扩展影响指南](docs/extension-impact-guide.md)。 |
| `CACHE_FIX_ADVISOR_PLAN` | 未设置 | `tools/tier-advisor.mjs` 的计划覆盖 —— 一个 `max-5x`, `max-20x`, `pro`。绕过启发式计划检测。参见 [层级顾问](docs/tier-advisor.md)。 |
| `CACHE_FIX_ADVISOR_UPGRADE_THRESHOLD` | `80` | 触发层级顾问推荐升级的预测 Q7d 百分比。 |
| `CACHE_FIX_ADVISOR_DOWNGRADE_THRESHOLD` | `20` | 触发层级顾问推荐降级的预测 Q7d 百分比（与 `DOWNGRADE_WEEKS` 连续周数门控配对）。 |
| `CACHE_FIX_ADVISOR_DOWNGRADE_WEEKS` | `2` | 在层级顾问推荐降级前，需要连续完成的周数低于降级阈值。单周下降从不触发；单周峰值确实会触发升级（被限制的成本不对称性）。 |

### 企业环境（代理、自定义 CA）

代理在转发到 `api.anthropic.com` 时遵循以下环境变量。在 Zscaler / Netskope / Forcepoint / Bluecoat / 企业级 squid 代理后面时，在代理的环境中设置这些变量。

| 变量 | 效果 |
|---|---|
| `HTTPS_PROXY` / `HTTP_PROXY`（及其小写变体） | 通过企业 HTTP CONNECT 代理路由上游请求。 |
| `NO_PROXY` | 逗号分隔的绕过代理的主机列表。支持 `*` 和 `.suffix.example.com`。 |
| `CACHE_FIX_PROXY_CA_FILE` | 包含一个或多个额外 CA 证书的 PEM 文件路径（用于 SSL 检测代理）。 |
| `NODE_EXTRA_CA_CERTS` | Node 标准机制——同样被遵循。 |
| `CACHE_FIX_PROXY_REJECT_UNAUTHORIZED=0` | **不安全的逃生门。** 禁用 TLS 验证。仅作为最后手段使用，在等待 IT 提供企业 CA 包期间。 |

示例（Windows PowerShell）：

```powershell
$env:HTTPS_PROXY = 'http://proxy.corp.example:8080'
$env:NO_PROXY    = 'localhost,127.0.0.1,.corp.example'
$env:CACHE_FIX_PROXY_CA_FILE = 'C:\corp\zscaler-root.pem'
node "$(npm root -g)\claude-code-cache-fix\proxy\server.mjs"
```

首次请求时 stderr 会打印 `[upstream] using proxy http://proxy.corp.example:8080 ...`。如果没有设置代理/CA 环境变量，行为与早期版本相同（Node 默认代理、系统信任存储）。

### 在您自己的进程中嵌入代理

如果您交付的 Node 或 Bun 二进制文件需要在进程内运行 cache-fix 代理（例如，避免 fork 出 Node 子进程的 Bun 编译代理），可以从 `claude-code-cache-fix/proxy/server` 导入工厂函数：

```js
import { startProxy } from "claude-code-cache-fix/proxy/server";

const handle = await startProxy({
  port: 0,        // 操作系统分配的临时端口；传入数字以指定端口
  bind: "127.0.0.1",
  watch: false,   // 跳过 fs.watch——推荐用于编译后的二进制文件
});

console.log(`proxy listening on ${handle.address}:${handle.port}`);

// ...之后...
await handle.close();
```

**`createProxyServer()` → `http.Server`** 构建一个连接到 `http.Server` 的请求处理器。返回的服务器*尚未*监听，扩展管道也尚未加载——当您想自己管理生命周期时使用此项。

**`startProxy(options?)` → `Promise<{ server, port, address, close }>`** 加载扩展管道，可选地启动文件监视器，并开始监听。返回一个包含绑定端口（当请求 `port: 0` 时解析得到）的句柄，以及释放服务器和监视器的 `close()` 方法。

选项（全部可选；全部回退到 CLI 使用的相同环境变量）：

| 选项 | 默认值 | 效果 |
|---|---|---|
| `port` | `CACHE_FIX_PROXY_PORT` 环境变量，否则 `9801` | 监听端口。传入 `0` 以使用操作系统分配的临时端口。 |
| `bind` | `CACHE_FIX_PROXY_BIND` 环境变量，否则 `127.0.0.1` | 绑定地址。 |
| `extensionsDir` | 包内的 `proxy/extensions/` | 加载 `.mjs` 扩展的目录。 |
| `extensionsConfig` | 包内的 `proxy/extensions.json` | 扩展配置文件路径。 |
| `watch` | `true` | 是否在扩展配置上启动 `fs.watch`。嵌入/编译二进制使用时设为 `false`。 |

**每个进程一个扩展注册表。** 管道在模块作用域维护一个共享的扩展注册表。在同一进程中托管两个 `startProxy()` 实例是受支持的（不同端口、不同绑定地址），但它们共享该注册表——后续的 `loadExtensions` 调用会为两者替换它。如果您需要每个实例使用不同的扩展配置，请在单独的进程中运行它们。

**CLI 调用方式不变。** `node proxy/server.mjs`、`cache-fix-proxy server` 以及包装器的子进程 fork 路径都像之前一样自动监听并安装 SIGTERM/SIGINT 处理器。库导入绝不会触发该行为——自动监听受主模块检查的保护。

_可嵌入工厂函数由 [Crunchloop DAP](https://dap.crunchloop.ai) 的 [@bilby91](https://github.com/bilby91) 贡献——参见 [PR #123](https://github.com/cnighswonger/claude-code-cache-fix/pull/123)。_

## 从 v3.x 升级

**v4.0.0 中的行为变化：**

- **`thinking-block-sanitize` v1 现在默认开启。** 在 v3.8.0–v3.9.x 中是通过 `CACHE_FIX_THINKING_SANITIZE=on` 选择的。在 37 个会话中经过七天的生产狗粮测试（零 `cannot be modified` 400，缓存命中率平均 94.66% vs 基线 92.44%，每会话约 35% 的会话中发生清理，每天约 800 个块被丢弃，最大 938K 上下文健康）v1 缓解现在是新默认值。设置 `CACHE_FIX_THINKING_SANITIZE=off` 明确禁用。v2（额外的工具哈希不匹配丢弃）保持通过 `=v2` 选择。参见 [#63147](https://github.com/anthropics/claude-code/issues/63147) 和 [#162](https://github.com/cnighswonger/claude-code-cache-fix/issues/162)。
- **进程内扩展热重载现在默认关闭。** 在 v3.x 中是开启的。设置 `CACHE_FIX_HOT_RELOAD=on` 以恢复之前的行为。默认关闭消除了 [#196](https://github.com/cnighswonger/claude-code-cache-fix/issues/196) 中记录的 Node ESM 停滞导入竞争，其中文件监视器在热重载触发后 17 小时静默未能加载新合并的扩展。当文件监视器重新导入一个其传递依赖项已被 Node 加载器缓存的扩展时会触发该竞争；冷启动不受影响。

### 嵌入者注意（Bun 主机，使用 `createProxyServer()` / `startProxy()` 的 DAP 风格集成）

v4.0.0 将 `CACHE_FIX_THINKING_SANITIZE` 从默认关闭翻转为默认开启。v1 空文本丢弃将在通过嵌入式代理的每个请求体上运行。如果您的主机依赖于之前的无清理行为（例如，下游代码期望空的 `thinking` 块在往返后存活），请通过以下方式保留它：

- 在您的主机环境中设置 `CACHE_FIX_THINKING_SANITIZE=off`，或
- 在您的代码中任何请求处理前设置 `process.env.CACHE_FIX_THINKING_SANITIZE = "off"` —— 模式通过 `modeFromEnv()` 每次请求读取，而不是在模块加载时缓存。

翻转由 7 天的生产狗粮测试支持（37 个会话，零 `cannot be modified` 400，缓存命中率平均 94.66% vs 92.44% 基线）。参见 [PR #201](https://github.com/cnighswonger/claude-code-cache-fix/pull/201) 获取验证数据和 [#63147](https://github.com/anthropics/claude-code/issues/63147) 的上游上下文。

在 v4.0.0 中，添加新扩展或对现有扩展进行代码更改需要监督级代理重启。根据您是否也想要恢复热重载，有两种升级流程。

### 流程 1 —— 仅代码 npm 升级（推荐默认）

您现有的 systemd 单元 / launchd plist 不变；只有磁盘上的代理代码通过 npm 更新。重启运行的进程以获取新代码。

**Linux (systemd 用户单元)：**

```
npm install -g claude-code-cache-fix@4
systemctl --user restart cache-fix-proxy
```

无需 `daemon-reload` —— 单元文件内容不变。

**macOS (launchd 用户代理)：**

```
npm install -g claude-code-cache-fix@4
launchctl kickstart gui/$(id -u)/com.cnighswonger.cache-fix-proxy
```

`kickstart` 在现有 plist 下重新执行代理。

### 流程 2 —— 在监督层恢复热重载

如果您积极使用热重载（例如，您在运行的代理中将自定义扩展放入扩展目录并希望它们在不重启的情况下被拾取），请运行此操作。这会重写单元 / plist，使每次监督者启动代理时都设置 `CACHE_FIX_HOT_RELOAD=on`。

**Linux (systemd 用户单元)：**

```
CACHE_FIX_HOT_RELOAD=on cache-fix-proxy install-service
systemctl --user daemon-reload
systemctl --user restart cache-fix-proxy
```

需要 `daemon-reload`，因为单元文件内容已更改。

**macOS (launchd 用户代理)：**

```
CACHE_FIX_HOT_RELOAD=on cache-fix-proxy install-service
launchctl bootout gui/$(id -u)/com.cnighswonger.cache-fix-proxy
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.cnighswonger.cache-fix-proxy.plist
launchctl kickstart gui/$(id -u)/com.cnighswonger.cache-fix-proxy
```

需要 `bootout` + `bootstrap`，因为 plist 内容已更改 —— 仅 `kickstart` 不会拾取 plist 更改。

**关于热重载权衡的注意：** 即使在选择路径上，长时间运行的进程仍可能遇到 ESM 停滞导入竞争。如果遇到降级的 `/health`（返回 503 + `{status:"degraded",...}`），唯一恢复方法是进程重启；代理会在发生时记录 `[CRITICAL]` 提示。参见 [#197](https://github.com/cnighswonger/claude-code-cache-fix/pull/197) 获取可观测性层。

## 此代理防御的内容

**缓存经济性回归。** cache-fix 的最初目的是吸收 Claude Code 中导致用户损失真金白银和额度的缓存处理行为——TTL 降级、破坏缓存的请求头抖动、身份锁定问题，以及在我们 issue 历史中记录的其他回归目录。代理位于 CC 和 Anthropic API 之间，规范化请求和响应流，并发出足够的可观测性（通过状态行集成和 quota-status 文件），使用户能够看到会话实际在做的事情。这是当今几乎所有用户的核心功能。

**Bootstrap 通道可观测性。** Claude Code v2.1.150 引入了一个提示段消费者，从 `/api/claude_cli/bootstrap` 获取服务器提供的字符串并将其合并到代理的行为指令提示路径中。我们于 2026 年 5 月向 Anthropic 的安全团队报告了此行为；Anthropic 以 _信息性（Informative）_ 结案，将 TLS 视为传输完整性边界，并拒绝添加应用层真实性检查。cache-fix v3.7.0 为此路径添加了显式处理。v3.7.1 扩展了此处理，以覆盖 CC v2.1.152 中引入的由环境变量选择的 GrowthBook 提示注入面（远程控制模式：`CLAUDE_CODE_SYSTEM_PROMPT_GB_FEATURE` 指定一个标志键，其缓存值被用作系统提示体）。

cache-fix 的 `bootstrap-defense` 扩展提供三种模式，通过 `CACHE_FIX_BOOTSTRAP_MODE` 选择：

| 模式 | 默认？ | 行为 |
|---|---|---|
| `audit` | 是 | Bootstrap 响应代理透传至 CC。每条响应记录到 `~/.claude/cache-fix-bootstrap-log.jsonl`，包含表面元数据：哪些提示源表面被触发（`tengu_heron_brook` 旧版和/或环境变量选择），值的 SHA-256 哈希（前 16 个十六进制字符——从不记录值本身），以及 `CLAUDE_CODE_REMOTE` 标志。多表面响应每个表面发出一记录，通过 `request_id` + 时间戳窗口关联。 |
| `block` | 主动选择 | `onRequest` 返回 200 及空 JSON 体。绝不调用上游，任何标志映射绝不触及磁盘上的 GrowthBook 缓存。同时防御旧版和环境变量选择的注入面。 |
| `allowlist` | 主动选择（实验性） | Bootstrap 响应代理透传，但不在允许列表中的提示源合格键（旧版 `tengu_heron_brook` + 环境变量选择的键）在到达 CC 前从响应体中剥离。默认允许列表为 `tengu_heron_brook`（唯一已知的历史合法键）；通过 `CACHE_FIX_BOOTSTRAP_ALLOWED_KEYS=逗号,分隔,列表` 配置。传入 `CACHE_FIX_BOOTSTRAP_ALLOWED_KEYS=`（显式空值）以完全拒绝所有。其他 GrowthBook 标志键原样透传。如果 Anthropic 在未来 CC 版本中添加合法的提示源键，可能需要更新。 |

注意：cache-fix v3.6.2 及更早版本对 bootstrap 路径返回 404，因为代理路由器未包含该路径——实际效果是 bootstrap 内容未到达 cache-fix 用户的 CC。v3.7.0 的默认 `audit` 改变了该行为；显式 `CACHE_FIX_BOOTSTRAP_MODE=block` 可保留旧行为。完整的披露记录，包括 Anthropic 的逐字结案文本，位于 [`docs/disclosure/heron-brook-2026-05.md`](docs/disclosure/heron-brook-2026-05.md)。

**参考资料：**

- [`docs/disclosure/heron-brook-2026-05.md`](docs/disclosure/heron-brook-2026-05.md) — 完整披露记录
- [`CHANGELOG.md`](CHANGELOG.md#371---2026-05-27) — v3.7.1 发布条目（扩展表面覆盖 + 允许列表模式）；[v3.7.0 条目](CHANGELOG.md#370---2026-05-26) 涵盖之前的行为变更说明
- [`cnighswonger/heron-brook-poc`](https://github.com/cnighswonger/heron-brook-poc) — bootstrap 通道行为的复现器

**自动 1M 上下文超量保护。** CC v2.1.161 及以后（特别是 VS Code 扩展表面）可以在不请求的情况下自动选择 1M 上下文，立即消耗超量信用。代理的 `auto-1m-guard` 扩展检测传出 `anthropic-beta` 头上的 `context-1m-2025-08-07` 标记，并根据您通过 `CACHE_FIX_AUTO_1M_GUARD` 选择的模式警告或剥离它：

| 模式 | 默认？ | 行为 |
|---|---|---|
| `off` | 否 | 扩展无操作。 |
| `warn` | 是 | 检测标记。将注释存储到每个会话 JSON (`auto_1m_detected`, `auto_1m_action: "warn"`, `auto_1m_advice`) 并发出 stderr 日志行。该行在进程生命周期内锁定为首次检测（建议文本不会变化，扩展重载也不会重新触发）。不修改请求。 |
| `strip` | 主动选择 | 在转发前检测并从 `anthropic-beta` 头中删除标记。注释：`auto_1m_action: "stripped"`。 |

CC 端的关闭开关是 `CLAUDE_CODE_DISABLE_1M_CONTEXT=1`（环境变量），当它实际到达 CC 进程时才是正确修复。在 VS Code 扩展表面，该环境变量据报道不可靠；代理拦截绕过了这个间隙，因为它在任何 CC 启动器产生的请求上都作用于网络。跟踪 [CC#64919](https://github.com/anthropics/claude-code/issues/64919)；参见 [`docs/directives/proxy-auto-1m-guard.md`](docs/directives/proxy-auto-1m-guard.md) 了解确认代理可见信号是 beta 头（CC 在发送前从 `req.body.model` 客户端侧剥离 `[1m]` 后缀）的二进制步行。

## 客户端钩子

一些 Claude Code 行为发生在请求层以下 —— 它们在代理看到流量之前就在工具分发路径上发生。cache-fix 在 [`hooks/examples/`](hooks/README.md) 下提供独立的钩子脚本，用于这些情况。它们与代理独立，您通过指向自己的 `~/.claude/settings.json` 安装它们。

| 脚本 | 它做什么 |
|---|---|
| [`worktree-edit-guard.py`](docs/hooks/worktree-edit-guard.md) | 阻止目标路径逃出活动 git 工作树的 `Edit`/`Write`/`MultiEdit`/`NotebookEdit` 工具调用，防止工作树会话中的父检查损坏。解决 [CC#59628](https://github.com/anthropics/claude-code/issues/59628)。 |

## 贡献工具

独立脚本，不是代理扩展或 CC 钩子 —— 可单独安装，解决特定的上游问题。

| 工具 | 它做什么 |
|---|---|
| [`tools/gh-auth-status-shim/`](tools/gh-auth-status-shim/README.md) | PATH 解析的 `gh` 包装器，抑制 CC Desktop 的假“GitHub CLI 认证已过期”吐司。解决 [CC#67055](https://github.com/anthropics/claude-code/issues/67055)：CC Desktop 的 PR 轮询器将 `gh auth status` 的任何非零返回（包括其 5s 派生超时）映射到 `"auth"` 吐司类别。该包装器拦截 `gh auth status` 调用，使用 4s 内部超时，分类结果，并返回退出码 0 以抑制瞬态/超时信号的假吐司，同时让真正的过期（`not logged in`, `HTTP 401`）正常传播。在 Anthropic 的分类器修复发布前的变通方案。**已知限制：** 重写 PATH 范围内所有调用者的 `gh auth status` 退出码语义（不仅仅是 CC）；由于 launchd PATH 继承，macOS 覆盖未验证；原生 Windows CC Desktop 不支持。 |

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

如果您在别处看到推荐设置：它只在活动模型符合 1M 上下文时生效（目前是 `claude-sonnet-4-6` 或带有适当 beta 头的 `claude-opus-4-6`）。没有这些前提条件，它会硬编码为 200K，无论您设置什么。

### `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` schema-strip 侧面效应

如果您设置了此标志，CC 会从传出请求中剥离任何不在 `["name", "description", "input_schema", "cache_control"]` 范围内的工具字段。依赖 `defer_loading` 或 `eager_input_streaming` 的自定义工具将静默丢失这些字段并表现出不同的行为。在打开标志前值得知道。

## 已知 CC 行为影响缓存成本

这些不是 cache-fix 修复的 bug —— 它们是用户在估算会话成本时应了解的上游 CC 行为。

### 诊断斜杠命令增加对话历史 ([#49335](https://github.com/anthropics/claude-code/issues/49335))

运行 `/context`、`/release-notes`（可能还有其他状态检查命令）会将诊断输出附加到对话历史，而不是仅在终端中渲染。后续轮次通过提示缓存重放膨胀的负载，增加状态检查操作的成本。在 v2.1.148 上单次 `/context` 调用测量为 +3,480 `cache_creation_input_tokens`；另一个用户报告在单独会话上约 5K。`/release-notes` 更糟 —— 默认转储完整变更日志。

诊断更糟：账单到您缓存的膨胀负载不会写入本地 JSONL 转录，因此您无法本地审计成本来源 —— 您只能从响应使用元数据中的 `cache_creation_input_tokens` 跳跃中推断。 (代理模式用户可以检查 `~/.claude/quota-status/` 文件中的增量，代理直接从响应头写入。)

**在上游修复前的变通方案：** 在长会话中谨慎使用这些命令。如果您需要频繁使用，考虑在诊断运行后使用 `/compact` 重置泄漏。

## 快速上手：预加载（CC v2.1.112 及更早版本）

如果您使用的是基于 Node.js 的 CC 版本（v2.1.112 或更早），预加载拦截器无需代理即可工作：

```bash
npm install -g claude-code-cache-fix
NODE_OPTIONS="--import claude-code-cache-fix" claude
```

> **注意：** 预加载在 CC v2.1.113+（Bun 二进制）上不工作。请使用上面的代理。

参见 [docs/preload-setup.md](docs/preload-setup.md) 获取包装脚本、shell 别名、Windows 指令和 VS Code 预加载模式集成。

## VS Code 扩展

[VS Code 扩展](https://github.com/cnighswonger/claude-code-cache-fix-vscode)（v0.5.0）支持代理和预加载模式：

**代理模式（推荐）：**
1. 启动代理（见上文）
2. 在 VS Code 命令面板中：**Claude Code Cache Fix: Enable Proxy Mode**
3. 重启任何活动的 Claude Code 会话

**预加载模式（CC ≤v2.1.112）：**
1. `npm install -g claude-code-cache-fix`
2. 从 [GitHub Releases](https://github.com/cnighswonger/claude-code-cache-fix-vscode/releases/latest) 下载 VSIX
3. 安装：`code --install-extension claude-code-cache-fix-0.5.0.vsix`
4. 命令面板：**Claude Code Cache Fix: Enable**

对于手动 VS Code 包装器设置（不使用 VSIX），请参见 [docs/preload-setup.md](docs/preload-setup.md#vs-code-preload-mode)。

## 安全模型

> **代理和拦截器对 API 请求和响应具有完全的读写访问权限。** 这是该方法固有的 —— 任何 fetch 拦截器、代理或网关都具有此位置。

**它做什么：** 修改传出请求结构（块顺序、指纹、TTL、git-status）以修复缓存 bug。读取响应头和 SSE 使用数据用于监控。

**它不做什么：** 代理或拦截器不会发出网络调用。所有遥测写入本地文件在 `~/.claude/` 下。没有数据离开您的机器。

**供应链：** 代理模式：`proxy/extensions/` 中的小而集中的扩展模块（大多数在几百行内；管道是可组合的，您可以单独阅读任何一项）。预加载模式：单个未压缩文件 (`preload.mjs`)。一个开发依赖项 (`zod` 仅用于测试中的模式验证)。安装前请审查。发布的构建携带 npm 默认注册表签名；sigstore 证明性归因目前未发布 —— 跟踪为后续。

**独立审计：** [被评估为 "合法工具"](https://github.com/anthropics/claude-code/issues/38335#issuecomment-4244413605) 由 @TheAuditorTool (2026-04-14)。

## 问题

当您在 Claude Code 中使用 `--resume` 或 `/resume` 时，提示缓存会静默破坏。而不是读取缓存 token（便宜），API 在每次轮次中从头重建它们（昂贵）。一个应花费 ~$0.50/hour 的会话可以燃烧 $5–10/hour 而没有明显的指示。

三个 bug 造成此问题：

1. **部分块散射** —— 附件块（技能列表、MCP 服务器、延迟工具、钩子）应该位于 `messages[0]`。在恢复时，一些或所有漂移到后续消息中，改变缓存前缀。

2. **指纹不稳定** —— `cc_version` 指纹（例如 `2.1.92.a3f`）从 `messages[0]` 内容计算，包括元/附件块。当这些块移动时，指纹改变，系统提示改变，缓存破坏。

3. **非确定性工具排序** —— 工具定义可以在轮次之间以不同顺序到达，改变请求字节并使缓存键失效。

此外，通过 Read 工具读取的图像在对话历史中以 base64 持久，并在每次后续 API 调用中发送，静默增加 token 成本。

## 它如何工作

**代理模式**（v3.0.0+）：`localhost:9801` 上的 HTTP 服务器拦截 `POST /v1/messages` 请求。扩展模块管道处理每个请求 —— 规范化块顺序、剥离指纹、稳定工具排序、管理 TTL 标记、清理 thinking 块、记录遥测等。扩展作为 `.mjs` 文件配置在 `proxy/extensions.json` 中，并在代理启动时加载一次（自 v4.0.0 起热重载是可选的 —— 参见 [从 v3.x 升级](#upgrading-from-v3x)）。所有其他流量原样通过。

**预加载模式**（v2.x）：Node.js `--import` 模块在 Claude Code 进行 API 调用前修补 `globalThis.fetch`。内联应用相同修复 —— 扫描用户消息中的重新定位块、排序工具、重新计算指纹、注入 TTL 标记。

两种模式都是幂等的 —— 如果不需要修复，请求原样通过。两种模式都不修改您的对话；它们只在 API 调用前规范化请求结构。

## 从修复中毕业

该包有三个目的，生命周期不同：

| 目的 | 示例 | 何时禁用 |
|---|---|---|
| **Bug 修复** | 块重新定位、指纹、工具排序、TTL | 当 CC 修复底层 bug —— 检查健康行 |
| **监控** | 额度跟踪、微压缩检测、GrowthBook 标志 | 永久保留 —— 这些检测未来回归 |
| **优化** | 图像剥离、输出效率重写 | 只要它们帮助您的工作流程就保留 |

### 健康状态（预加载模式）

首次 API 调用时，拦截器记录健康状态行（需要 `CACHE_FIX_DEBUG=1`）：

```
cache-fix health: relocate=active(2h ago) fingerprint=dormant(5 clean sessions) tool_sort=active ttl=active identity=waiting
```

- **active(Xh ago)** —— 最近应用了修复
- **dormant(N clean sessions)** —— 在 N 个会话中未检测到 bug；CC 可能已修复
- **safety-blocked(Nx)** —— 往返验证失败；修复自动禁用
- **waiting** —— 修复尚未触发

### 回归检测

如果在禁用修复后 5 次以上调用中缓存读取率低于 50%：

```
REGRESSION WARNING: cache_read ratio averaged 12% across last 5 calls.
Fixes are disabled — consider re-enabling to recover cache performance.
```

## 安全

### 指纹往返验证

在重写 `cc_version` 指纹之前，拦截器验证其硬编码盐和字符索引是否重现 Claude Code 发送的指纹。如果验证失败（CC 更改了算法），重写会自动跳过。这确保拦截器永远不会使缓存性能比原生 CC 更差。

### 故障安全设计

每个修复都设计为失败到无操作：
- 如果块检测正则表达式不匹配 → 块不会重新定位（CC 行为）
- 如果指纹格式更改 → 指纹不会重写（CC 行为）
- 如果工具排序没有变化 → 负载原样通过
- 如果 TTL 注入目标结构更改 → TTL 不注入（CC 行为）

拦截器只能 *帮助* 或 *不做任何事情*。它不能使事情更糟。

## 状态行 —— 实时额度警告

两种模式在每次 API 调用时写入额度状态。代理模式（v3.5.0+）分为 `~/.claude/quota-status/account.json`（账户全局字段：Q5h/Q7d、状态、超量）和 `~/.claude/quota-status/sessions/<id>.json`（每个会话缓存字段：TTL 等级、命中率）。预加载模式保持旧的 `~/.claude/quota-status.json`（单会话构造）。包含的 `tools/quota-statusline.sh` 脚本显示实时状态行，显示：

- **Q5h** 额度条 `[███░┃░░░░░]` + 百分比 + `(exhaust X, reset Y)`。填充单元是消耗额度；粗垂直刻度是窗口中的墙钟流逝位置。刻度在填充右侧 = 低于节奏；刻度在填充内 = 燃烧快于时间（超节奏）。`exhaust` 是当前燃烧速率下的 100% 投影时间；`reset` 是窗口滚动前的墙钟时间。当 `exhaust < reset`，您将在窗口重置前达到 100% —— 放慢节奏。
- **Q7d** 相同形状，持续时间以天为单位（例如 `(exhaust 3d13h, reset 3d0h)`）。低于一天时后缀自动切换到 `h/m` 格式（例如 `(exhaust 1h41m, reset 0h30m)`）。
- **TTL 等级** —— 健康时为 `TTL:1h`，**服务器降级时为红色 `TTL:5m`**（通常在 Q5h ≥ 100%）
- **工作日高峰时段（13:00–19:00 UTC）黄色的 PEAK**
- **缓存命中率百分比**
- **活动时的 OVERAGE 标志**
- **服务模型差异指示器** —— 当服务模型与请求模型不同时（[CC#66728](https://github.com/anthropics/claude-code/issues/66728) 中的分类器驱动交换模式），条形图获得红色 `requested → served` 段，或一旦家族感知启发式锁定后为黑色黄色 `requested → served`。默认无差异路径不显示段。当 `auto_1m_detected` 设置时，请求侧仅显示 `[1m]` 后缀。

示例行（窗口中点，健康状态）：

```
Q5h [███░┃░░░░░] 30% (exhaust 4h40m, reset 3h00m) | Q7d [█████┃░░░░] 53% (exhaust 3d13h, reset 3d0h) | TTL:1h 98.3%
```

当投影无意义时，`(exhaust …, reset …)` 后缀会分段删除：在 0%（新窗口）和 100%（已耗尽）时仅显示 `reset`；在窗口开始后前 5 分钟内燃烧速率不够稳定以进行投影（单次早期调用主导速率），因此 Q5h 和 Q7d 都会保留 `exhaust` 直到那时；一个陈旧的 `resets_at`（服务器报告值位于刷新之前）会删除两者。

条形使用 Unicode 块字符 (`█┃░`) —— 大多数现代终端正确渲染这些。如果您的终端替换为方框或替换字形，请配置支持 Unicode 的字体（任何 DejaVu、Fira、Iosevka、JetBrains Mono 等）。

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

当服务器将您的 TTL 降级为 5m（Q5h ≥ 100% 的额度感知降级）时，**每次空闲超过 5 分钟都会导致完整上下文重建**。没有状态行，这是不可见的。有了它，红色 `TTL:5m` 警告告诉您：**停止工作，等待 Q5h 窗口重置，然后恢复**。强行通过超量会加剧消耗；暂停打破循环。

### 推荐：禁用 git-status 注入

Claude Code 在每次调用时将实时 `git status` 注入系统提示。任何文件编辑都会改变 git status，破坏整个前缀缓存。禁用此操作可节省 ~1,800 token 每次调用：

```bash
export CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS=1
```

或在 `~/.claude/settings.json` 中添加 `"includeGitInstructions": false`。Claude Code 仍可通过 Bash 工具运行 `git status` 当它需要上下文时。社区验证由 [@wadabum](https://github.com/cnighswonger/claude-code-cache-fix/issues/11)：在 git 状态更改中缓存创建 18 token（无标志时为数千）。

**为什么我们不为此提供代理扩展：** 代理在 Claude Code 已经组成系统提示后拦截请求 —— 此时易变的 `git status` 文本已经是模型在上一轮中依赖的前缀的一部分，事后剥离会破坏缓存。修复必须在源头发生。`CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS=1` 防止在提示组成前注入，这就是原生标志是正确工具的原因。事后剥离还会移除模型可见的上下文，而显式 Bash 调用可以恢复，并可能错误匹配助手编写的文本。

## 迁移：v3.4.x → v3.5.0+

如果您编写了自定义状态行、监控脚本或任何直接读取 `~/.claude/quota-status.json` 的内容，此部分适用于您。v3.5.0 在代理模式下拆分该文件；预加载模式不变。

### 什么改变了

| | v3.4.x 及更早版本（代理 + 预加载） | v3.5.0+ 代理模式 | v3.5.0+ 预加载模式 |
|---|---|---|---|
| 额度字段（Q5h, Q7d, 状态, 超量） | `~/.claude/quota-status.json` | `~/.claude/quota-status/account.json` | `~/.claude/quota-status.json`（旧路径） |
| 缓存字段（TTL 等级、命中率、cache_creation/读取） | 同上文件 | `~/.claude/quota-status/sessions/<filename>.json` | 同上文件 |
| 多会话归属 | 无 —— 最后写入者胜出 | 每会话文件 | 预加载是单会话构造 |

`<filename>` 从请求的 `x-claude-code-session-id` 标头通过确定性安全名称规则派生：UUID 和其他匹配 `[A-Za-z0-9_-]{1,128}` 的 ID 通过；null/空/空白变为 `unknown`；任何其他映射到 `inv-<sha256[:16]>`。完整规则记录在 [`docs/directives/proxy-quota-status-per-session.md`](docs/directives/proxy-quota-status-per-session.md)。

旧的 `~/.claude/quota-status.json` 在升级后首次代理模式写入时自动删除。每会话文件超过 `CACHE_FIX_QUOTA_STATUS_TTL_DAYS`（默认 `7`）的在写入时被清除。

### 消费者端迁移模式

您的脚本应首先尝试 v3.5.0+ 代理路径，如果不存在则回退到旧路径。这样它在两种模式下都工作（以及在升级主机上）。会话 ID 通常来自 Claude Code 在调用状态行钩子时的 stdin；对于其他消费者，从最近修改的 `~/.claude/projects/*/*.jsonl` 文件名中捕获。

**Bash（状态行风格）：**
```bash
QS_DIR="$HOME/.claude/quota-status"
ACCOUNT="$QS_DIR/account.json"
LEGACY="$HOME/.claude/quota-status.json"

# 标准文件名规则 —— 必须镜像 proxy/extensions/cache-telemetry.mjs
# sessionFilename(): trim, 然后 "" → unknown, 安全正则通过，否则 inv-<sha256-prefix>。没有这个，格式错误或空白 ID 会错过每会话文件，即使写入器在规范名称下创建了它。
session_filename() {
  local trimmed
  trimmed="$(printf '%s' "$1" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
  if [ -z "$trimmed" ]; then echo unknown; return; fi
  if printf '%s' "$trimmed" | grep -qE '^[A-Za-z0-9_-]{1,128}$'; then
    printf '%s' "$trimmed"
  else
    # Linux 上的 sha256sum；macOS 上的 shasum -a 256。两者都输出 "<hex>  -"。
    local hash
    if command -v sha256sum >/dev/null 2>&1; then
      hash="$(printf '%s' "$trimmed" | sha256sum)"
    else
      hash="$(printf '%s' "$trimmed" | shasum -a 256)"
    fi
    printf 'inv-%s' "$(printf '%s' "$hash" | cut -c1-16)"
  fi
}

# 会话 ID：优先 CC stdin，回退到最近的 jsonl
sid="$(jq -r '.session_id // empty' 2>/dev/null < /dev/stdin || true)"
if [ -z "$sid" ]; then
  sid="$(ls -t "$HOME"/.claude/projects/*/*.jsonl 2>/dev/null | head -1 | xargs -I{} basename {} .jsonl)"
fi
filename="$(session_filename "$sid")"

# 额度：account.json (v3.5.0+) → 回退到旧版
if [ -f "$ACCOUNT" ]; then
  quota_json="$(cat "$ACCOUNT")"
elif [ -f "$LEGACY" ]; then
  quota_json="$(cat "$LEGACY")"
fi

# 缓存：sessions/<filename>.json (v3.5.0+) → 回退到旧版
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

// 与 cache-telemetry.mjs sessionFilename() 镜像。读取端规则必须匹配写入端规则；否则格式错误/空白 ID 会错过其每会话文件。
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

随附的 [`tools/quota-statusline.sh`](tools/quota-statusline.sh) 是 bash 版本的参考实现。[`/coffee` 技能](https://github.com/cnighswonger/claude-code-coffee) v1.4.0 是每会话温暖门的参考。

### 为什么每会话

在多代理主机（多个 Claude Code 会话共享一个代理）上，v3.5.0 之前的单个全局文件导致每个会话在每次响应中覆盖其他人的缓存统计。从会话 A 读取状态行会在 B 最近发送请求时显示 B 的 TTL 等级。每会话文件加上账户全局额度文件解决此问题，同时不丢失轻松的账户范围视图。参见 [#104](https://github.com/cnighswonger/claude-code-cache-fix/issues/104) 获取原始报告。

### `CLAUDE_CONFIG_DIR`

Claude Code 读取 `CLAUDE_CONFIG_DIR` 将其配置根目录从默认的 `~/.claude`（用于在不同目录中保持多个独立配置根）移开。代理现在也使用相同变量处理 **所有** 其磁盘状态：`quota-status/`, `usage.jsonl`, `cache-fix-state/`, 会话镜像、快照和 OAuth 事件都位于 `$CLAUDE_CONFIG_DIR` 而不是硬编码的 `~/.claude`。当未设置时，代理使用 `~/.claude` 完全如前（对常见单配置情况无变化）。

这在您运行 **一个代理每个配置目录** 时很重要：没有它，每个代理都会写入 `~/.claude/quota-status/account.json` 并互相覆盖额度状态。给每个代理相同的 `CLAUDE_CONFIG_DIR` 其 Claude Code 客户端使用，其状态会干净地分离。

## 图像剥离（预加载模式）

通过 Read 工具读取的图像在对话历史中以 base64 持久，随每次后续 API 调用一起发送。单个 500KB 图像在 Opus 4.6 上每次轮次花费 ~62,500 token，在 Opus 4.7 上因新分词器而 **~85,000+**。强烈建议在 4.7 上剥离图像。

```bash
export CACHE_FIX_IMAGE_KEEP_LAST=3
```

保留最后 3 个用户消息中的图像，用文本占位符替换较旧的图像。仅针对 `tool_result` 块 —— 用户粘贴的图像从不处理。

### 超大图像保护（旧版，v3.2.1）

```bash
export CACHE_FIX_IMAGE_MAX_DIM=2000
```

Anthropic API 对多图像请求强制执行两个图像相关限制，且相同错误消息可能触发任一：

> `"An image in the conversation exceeds the dimension limit for many-image requests (2000px). Start a new session with fewer images."`

两个压力轴来解决它们：

| 压力 | 变量 | 它做什么 |
|---|---|---|
| **对话中图像过多** | `CACHE_FIX_IMAGE_KEEP_LAST=N` | 从旧用户消息中剥离图像，只保留最后 N 个。 |
| **任何单个图像太大** | `CACHE_FIX_IMAGE_MAX_DIM=2000` | 替换超过维度限制的图像为记录原始尺寸的取证占位符。覆盖用户消息直接图像和 tool_result 嵌套图像。 |

两者组合：同时设置时，`KEEP_LAST` 先运行（减少数量），然后 `MAX_DIM` 运行在剩余图像上（限制保留图像的大小）。常见触发维度轴：高分辨率手稿扫描、retina 截图、全分辨率照片。

纯 JS PNG 和 JPEG 头解析 —— 无本地依赖。其他格式（GIF、WebP、AVIF、BMP）无论尺寸如何都原样通过。失败开放：无法解析尺寸的图像（截断头、不支持格式）会保留而不是剥离 —— 发送可能出错的请求比剥离有效图像更好。

### 图像保护管道（v3.3.0）

一个镜像 Anthropic 实际规则的条件管道。严格通过单个环境变量启用：

```bash
export CACHE_FIX_IMAGE_GUARD=1
```

启用时，代理运行：

| 通道 | 触发 | 行动 |
|---|---|---|
| **通道 0**（旧版） | 设置 `CACHE_FIX_IMAGE_KEEP_LAST=N` | 从比 N 最近的旧用户消息中剥离 tool_result 图像 |
| **通道 3** | 设置 `CACHE_FIX_IMAGE_PRESERVE_DETAIL=1` 并且图像长边 > 模型原生上限 | 通过 `sharp` 进行 Lanczos 缩放至原生上限（Opus 4.7 为 2576 px，否则为 1568 px），保留宽高比和媒体类型 |
| **通道 1** | 图像长边 > 活跃拒绝上限 | 剥离并替换为取证占位符。活跃上限 = 如果设置 `MAX_DIM` 则为该值，否则 2000 px（当数量 > 20）或 8000 px（数量 ≤ 20） |
| **通道 2** | 请求体超过 `CACHE_FIX_IMAGE_REQUEST_SIZE_MAX`（默认 30 MB） | 删除最旧图像直到在预算内 |
| **数量上限** | 剩余图像数量 > `CACHE_FIX_IMAGE_COUNT_MAX`（默认 100） | 删除最旧图像至上限 |

执行顺序：**通道 0 → 通道 3 → 通道 1 → 通道 2 → 数量上限**。每个通道独立 —— 通道 1 永不缩放；通道 3 永不剥离。

#### 可选的 `sharp` 依赖

通道 3 需要 [sharp](https://www.npmjs.com/package/sharp) 进行 Lanczos 缩放。它被声明为 **可选的对等依赖** —— 如果您想要通道 3，请单独安装：

```bash
npm install sharp
```

如果缺少 `sharp`，通道 3 会干净地跳过（遥测记录 `library_missing: true`）；通道 1 + 通道 2 + 数量上限仍运行。

#### 优先级矩阵

| 环境变量组合 | 行为 |
|---|---|
| 未设置 | 无图像处理（向后兼容默认；扩展短路）。 |
| 仅 `KEEP_LAST=N` | 现有 v3.2.1：用户消息中 tool_result 图像的数量上限，首先运行。无管道。 |
| 仅 `MAX_DIM=N` | 现有 v3.2.1：硬尺寸上限，仅剥离。无管道。 |
| `KEEP_LAST=N` + `MAX_DIM=N` | 现有 v3.2.1 组合：`KEEP_LAST` 首先运行（减少数量），然后 `MAX_DIM` 运行在幸存者上（限制尺寸）。无管道，无通道 2，无通道 3。 |
| `IMAGE_GUARD=1` | 新管道：通道 1（条件上限）+ 通道 2（请求大小保护）+ 图像数量上限。 |
| `IMAGE_GUARD=1` + `MAX_DIM=N` | `MAX_DIM` 覆盖通道 1 的条件上限（作为上限值）；通道 2 仍运行。 |
| `IMAGE_GUARD=1` + `PRESERVE_DETAIL=1` | 添加通道 3（通过 `sharp` 的 Lanczos 缩放）。当 `sharp` 不可用时，回退到剥离行为。 |
| `IMAGE_GUARD=1` + `KEEP_LAST=N` | `KEEP_LAST` 首先运行作为数量上限（通道 0）；管道在剩余图像上运行。 |
| `IMAGE_GUARD=1` + `KEEP_LAST=N` + `MAX_DIM=N` | 三路：`KEEP_LAST` 首先运行；管道在剩余图像上运行，但 `MAX_DIM` 覆盖通道 1 的条件上限；通道 2 仍运行。 |
| 无 `IMAGE_GUARD=1` 的 `PRESERVE_DETAIL=1` | 记录警告，视为无操作。没有管道运行时 `PRESERVE_DETAIL` 没有意义。 |

#### 可调参数

| 环境变量 | 默认值 | 目的 |
|---|---|---|
| `CACHE_FIX_IMAGE_GUARD` | 未设置 | 主管道门（`=1` 启用）。 |
| `CACHE_FIX_IMAGE_PRESERVE_DETAIL` | 未设置 | 启用通道 3 通过 `sharp` 的 Lanczos 缩放。 |
| `CACHE_FIX_IMAGE_REQUEST_SIZE_MAX` | 31457280 (30 MB) | 通道 2 字节预算。Anthropic 32 MB 封顶的 2 MB 头部空间。 |
| `CACHE_FIX_IMAGE_COUNT_MAX` | 100 | 硬图像数量上限。如需旧版 Claude 1/2.x/Instant，可设为 600。 |

## 图像重试断路器（代理模式，可选）

当 CC 遇到永久 "图像无法处理" 错误时，当前的处理程序将其视为瞬态并重试 —— 带有完整对话上下文和相同 34 MB 图像负载 —— 每 [anthropics/claude-code#66815](https://github.com/anthropics/claude-code/issues/66815) 约 19 次。一个坏图像可以在风暴自然停止前消耗 Max 计划用户 5 小时额度的 ~60%。

断路器监视每个 messages 路由响应。当上游返回永久图像处理错误时，它会记录失败，键为 `(sessionId, requestSignature)` 并携带请求的图像 SHA-256 哈希。当同一会话上的下一次请求携带与 30 秒滑动冷却窗口内记录的失败匹配的图像哈希时，断路器在本地短路重试 —— 发出一个符合线格式的合成响应（对于 `stream:true` 是 SSE 事件序列，否则是 JSON 包装），处理程序将其消费为正常完成的助手轮次。合成文本命名失败并要求用户删除或替换图像。将重试风暴从“多次上游调用”限制为一次。

通过环境变量启用；v4.2.0 首次发布时默认关闭，等待模拟验证：

```bash
export CACHE_FIX_IMAGE_RETRY_BREAKER=on
```

| 模式 | 行为 |
|---|---|
| `on` | 检测 + 记录 + 短路重试 |
| `off`（默认） | 通过，无检测，无日志 |
| `dry-run` | 检测 + 记录 + 日志 JSONL 事件，但 **不** 短路（用于生产调试） |

| 环境变量 | 默认值 | 目的 |
|---|---|---|
| `CACHE_FIX_IMAGE_RETRY_BREAKER` | `off` | 模式门 —— `on` / `off` / `dry-run` |
| `CACHE_FIX_IMAGE_RETRY_COOLOFF_MS` | 30000 | 每个记录失败的滑动冷却窗口 |
| `CACHE_FIX_IMAGE_RETRY_MAX_ENTRIES` | 4096 | 内存中失败映射的 LRU 限制 |
| `CACHE_FIX_IMAGE_RETRY_LOG_PATH` | `~/.claude/image-retry-events.jsonl` | 结构化事件日志路径（5 MB 单层旋转） |

**可观测性表面：** JSONL 事件日志是唯一信号。短路请求不会产生 `usage.jsonl` 行 —— 它们绕过 `usage-log` 和 `cache-telemetry` 完全（无上游调用 → 无 SSE 流 → 无行）。每次触发写入 `{ event: "breaker_fire", mode, session_id, image_hashes, retry_count, remaining_ms, request_id, ... }`；每次首次失败写入 `{ event: "failure_recorded", ... }`。日志仅携带哈希和元数据 —— 无图像字节，无请求体，无认证头。

**检测条件**（必须全部满足）：

1. 同一会话上的前一个响应匹配图像处理错误谓词（HTTP 400 + 标准 `invalid_request_error` 包装 + 图像类消息）。
2. 当前请求携带 SHA-256 哈希匹配记录失败的图像哈希的图像内容块。
3. 当前请求在滑动冷却窗口内到达。
4. 当前请求在同一会话上（通过 `x-claude-code-session-id` / `x-session-id` / `x-anthropic-session-id` 解析）。

无会话请求归类到 `"unknown"` —— 它们不被请求签名隔离，这是一个已知限制，由 30 秒滑动窗口缓解。

## 会话预算断路器（代理模式，可选）

一个可选的 **硬每会话支出上限。** 一旦 CC 会话的累积 token 消耗（或其估计成本，或其消耗 *速率*）超过您设置的限制，该会话的进一步 `/v1/messages` 将在本地短路 —— 它们永远不会到达 Anthropic，因此无法消耗信用、触发自动购买，或（对于直接 API 密钥用户）保持账单到卡。动机来自 [anthropics/claude-code#68285](https://github.com/anthropics/claude-code/issues/68285)：一个 Workflow 扇出 700+ 子代理继承了高级默认值，没有每代理模型上限和支出门，燃烧 ~$350 的信用并触发 ~$800 的自动购买，直到用户干预。所有 700 个子代理都是单个会话的子代，因此每会话上限在源头封堵失控。

**这是一个断路器，不是计量器。** 它停止出血；它不按分定价每个请求。总计来自 body（`msg.usage` token 计数，每个 Messages 响应都携带）和认证独立，因此对订阅/OAuth 和直接 API 密钥客户端都相同。

通过门启用；**默认关闭**，直到您设置至少一个上限：

```bash
export CACHE_FIX_SESSION_BUDGET=on
export CACHE_FIX_SESSION_BUDGET_COST_USD=25      # 例如在 ~$25 停止此会话
```

| 模式 | 行为 |
|---|---|
| `on` | 每会话总计；一旦自信超过上限，短路下一次请求 |
| `off`（默认） | 通过，无总计，无日志 |
| `dry-run` | 总计 + 在阻断点记录 `would_block` 事件，但 **转发每个请求**（在强制前测量） |

### 三个阻断杠杆（至少设置一个）

| 环境变量 | 默认值 | 目的 |
|---|---|---|
| `CACHE_FIX_SESSION_BUDGET` | `off` | 门 —— `on` / `off` / `dry-run` |
| `CACHE_FIX_SESSION_BUDGET_TOKENS` | 未设置 | 当会话的累积 `input + cache_creation` token 超过此整数时硬停止。与计划无关且 **精确** —— 最后手段杠杆。 |
| `CACHE_FIX_SESSION_BUDGET_COST_USD` | 未设置 | 当估计成本（token × `tools/rates.json`）超过此浮点数时硬停止。 |
| `CACHE_FIX_SESSION_BUDGET_RATE_TPM` | 未设置 | 当会话在滑动窗口中的 token/min 超过此整数时硬停止 —— **早期扇出捕获**（在大批次落地前在斜坡上触发）。 |
| `CACHE_FIX_SESSION_BUDGET_RATE_WINDOW_MS` | 60000 | 速率杠杆的滑动窗口。 |
| `CACHE_FIX_SESSION_BUDGET_MAX_ENTRIES` | 4096 | 内存中每会话总计映射的 LRU 限制。 |
| `CACHE_FIX_SESSION_BUDGET_EVENT_LOG` | `~/.claude/session-budget-events.jsonl` | 结构化火灾事件日志路径（5 MB 单层旋转）。 |

### 哪个杠杆用于哪种计费模型

断路器服务 **两种** 计费模型，但危险 —— 因此主要杠杆不同：

- **订阅（OAuth，例如 Max）—— #68285 案例。** token 是额度直到超量；危险是账户全局自动购买墙。使用 `_TOKENS`（或 `_RATE_TPM`）在会话失控驱动账户进入自动购买前封堵它。成本在此处是信息性的。
- **直接 API 密钥（按使用付费）—— 更严重的情况。** 没有额度缓冲：每个 token 立即以 API 列价计费，同样的扇出没有任何支出电路 —— 它会持续计费直到密钥的等级限制或银行介入。这里 `_COST_USD` 是 **实际美元上限**：`tools/rates.json` 是 Anthropic 的 API 列价，因此 `tokens × rates.json` 是实际的钱。

**成本是估计值 —— 与 token 限制配对以保证美元界限。** `rates.json` 可能滞后新发布的模型。未知模型在成本总计中贡献 **0**（设计为失败开放），因此过时的速率会静默 *低估* 并可能让成本超过预期美元数字。token 和速率杠杆总是精确的。如果您希望 API 密钥有硬美元上限，**也设置 `_TOKENS`** 以便过时/未知速率不会让支出无限制 —— token 限制然后回退估计。（`tools/rates.json` 每周通过 fetch-and-open-PR cron 从 Anthropic 定价页面刷新；人类审查每个定价差异。）

两种请求模式都覆盖：流式响应从 `message_start` 事件累积，非流式（`stream:false`）响应从返回的 JSON 主体累积。总计、上限和阻断行为完全相同 —— 没有模式绕过预算。

### 失败开放，始终

如果会计不确定 —— 门关闭，无上限设置，`usage` 缺失或无法解析，无会话键，模型未知于 `rates.json`（仅成本杠杆），重启后的第一次请求，或任何抛出异常 —— 请求 **转发**。阻断需要门 `on` **且** 至少一个杠杆数值、自信地超过其上限。失败关闭的预算断路器会在代理 bug 上卡住整个会话，这比超量更糟。一个环境翻转（`CACHE_FIX_SESSION_BUDGET=off`）完全禁用它。

### 可观测性表面（计量绕过）

短路请求在任何上游调用前返回，因此它不会产生 **任何 `usage.jsonl` 行** —— 正确（未产生成本），但请注意它 **不在** 计量器中。唯一火灾信号是 JSONL 事件日志：每次阻断写入 `{ event: "session_budget_block", would_block, sid, lever, limit, observed, cumulative_tokens, cumulative_cost_usd, request_id, ts }`。`dry-run` 写入相同的记录，但 `would_block: true` 并转发。日志仅携带总计和超过的上限 —— **无请求/响应体，无模型输入内容，无认证头。** `request_id` 是可空的（本地阻断请求没有上游请求 ID；如果存在客户端请求头则填充，否则为 `null` —— 从不伪造）。

每次火灾事件还携带一个 **观察性** 的 `account_q5h_contribution` —— 估计该会话驱动账户滚动 5 小时额度燃烧的比例，按会话的窗口 token 分享（`{ window_ms, account_q5h_delta, session_token_share, attributed_q5h_delta }`）。这是从 Anthropic 的 **账户全局** `anthropic-ratelimit-unified-5h-utilization` 头派生的，因此它 **永远** 不是阻断杠杆 —— 它会因另一个会话的燃烧而触发无辜会话。它仅用于显示操作员 *哪个* 会话驱动账户额度。API 密钥流量缺少该头，因此字段简单省略。

归因分母是代理的 **进程全局** token 池，因此估计只有在代理实例服务 **一个** Anthropic 账户时才有效（正常单操作员部署）。如果一个实例前端多个账户，独立账户共享同一分母，会话贡献可能被高估或低估。作为观察性，这从不影响门控。

### 已知限制

- **并发超量。** 大扇出几乎同时触发，因此纯累积（`_TOKENS`/`_COST_USD`）上限只在飞行批次的 token 落地后触发 —— 它超量约该批次。**`_RATE_TPM` 缓解此问题** 通过在批次完成前在斜坡上触发。
- **输出成本是事后** —— 总计门控的是 *下* 一次请求，而不是当前请求。
- **重启重置总计** —— 它在内存中；会话中途代理重启会清零。对于安全后盾可接受。
- **每会话，不是每账户** —— 它封堵了违规的 *会话*；它不能降低 Anthropic 的账户全局额度或直接阻止自动购买。对于单会话失控（#68285），封堵该会话是正确且足够的行动。

## `cc_version` 规范化（代理模式，可选）

一些 Claude Code 分发渠道 —— 特别是自动更新下的 VS Code 扩展 —— 在系统提示的 `x-anthropic-billing-header` 中发出一个 `cc_version` 值，该值在 `MAJOR.MINOR.PATCH` 之上包含构建哈希（例如 `2.1.185.<buildhash>`）。当构建哈希在会话中变化时（二进制自动更新在轮次之间），该值位于可缓存前缀内，因此每次后续轮次都支付全 `cache_creation` 成本直到后缀稳定 —— Anthropic 的前缀缓存是字节精确的，字段在范围内。

现有的 `fingerprint-strip` 不涵盖此情况：它只重写与 CC 生成的用户消息文本指纹匹配的后缀。二进制构建哈希无法通过验证，`fingerprint-strip` 返回 null 而不重写。

通过环境变量启用；默认关闭：

```bash
export CACHE_FIX_NORMALIZE_CC_VERSION=strip          # 将 X.Y.Z.<suffix> → X.Y.Z
# 或
export CACHE_FIX_NORMALIZE_CC_VERSION=pin:2.1.185    # 操作员提供的字面值
```

| 模式 | 行为 |
|---|---|
| `off`（默认） | 无变异 |
| `strip` | 将 `cc_version=X.Y.Z(.suffix)+` 合并到 `cc_version=X.Y.Z` |
| `pin:<value>` | 将 `cc_version=<anything>` 替换为操作员字面值。验证：`^[A-Za-z0-9.\-]+$`，最大 64 字符（任何会破坏周围头语法的失败开放到 `off` 并发出一次 stderr 警告）。 |

扩展在顺序 90 运行，在顺序 100 的 `fingerprint-strip` 之前。规范化后 `cc_version` 最多有 3 个部分，因此 `fingerprint-strip` 的 `dotParts.length < 4` 保护使其成为无操作 —— 两者干净地协作，无其他排序危险。字段边界锚定正则表达式 `(^|[;\s:])cc_version=([^;\s]+)` 因此嵌入在另一个字段值中的 `cc_version=` 子字符串不会被意外重写。原子失败开放：计划重写在本地数组中阶段，在扫描完成后应用；扫描期间的任何错误都会保持体字节完整。

## 会话备份（代理模式，可选）

一个带扣的备份，以防 CC 的转录回归 [anthropics/claude-code#66734](https://github.com/anthropics/claude-code/issues/66734)（就地转录重写为元数据仅存根）和 [anthropics/claude-code#66486](https://github.com/anthropics/claude-code/issues/66486)（交互式会话中缺少转录）。当代理在路径上时，每个助手消息 + 观察到的工具结果 / 用户输入都会镜像到用户控制下的每会话 JSONL 文件中，独立于 CC 自身的转录写入器。CC 的转录保持规范，当它存活时；当它不存活时，镜像是恢复路径。

通过环境变量启用；v4.2.0 和 v4.3.0 默认关闭，等待隐私姿态周期：

```bash
export CACHE_FIX_SESSION_MIRROR=on
```

| 环境变量 | 默认值 | 目的 |
|---|---|---|
| `CACHE_FIX_SESSION_MIRROR` | `off` | 主门 —— `on` 启用镜像 |
| `CACHE_FIX_SESSION_MIRROR_DIR` | `~/.claude/session-mirrors/` | 存储根目录 |
| `CACHE_FIX_SESSION_MIRROR_MAX_BYTES` | 100 MB | 每会话活动文件旋转阈值 |
| `CACHE_FIX_SESSION_MIRROR_RETENTION_DAYS` | 30 | 保留清除范围（超过此时间的文件会被取消链接） |
| `CACHE_FIX_SESSION_MIRROR_MAX_SESSIONS` | 1024 | 内存中去重状态映射的 LRU 限制 |
| `CACHE_FIX_SESSION_MIRROR_INCLUDE_THINKING` | `true` | 设置为 `false` 以从镜像记录中排除 `thinking` 内容块 |

**格式一致性：** 镜像记录使用 CC 2.1.148 的验证转录信封形状完全 —— 现有转录读取器（包括 `restore-claude-history-linux`）解析镜像文件不变。唯一区分字段是 `source: "cache-fix-proxy-mirror"`。写入时三个已知限制：

1. `cwd` 始终为 `null`（代理不知道调用者工作目录）。
2. `uuid` 为短横线格式（8-4-4-4-12），但变体位不合法。它是 `(sessionId, timestamp, messageId)` 的确定性哈希，因此链可重建；形状验证解析器接受它。
3. 工具结果用户记录省略 `toolUseResult` 和 `sourceToolAssistantUUID`（CC 内部丰富对象代理无法重建）。

存储布局：`<DIR>/<sessionFilename(sessionId)>/<timestamp>.jsonl`。不匹配 `[A-Za-z0-9_-]{1,128}` 的会话 ID 桶到 `inv-<sha256[:16]>`（路径遍历安全）。无会话请求共享一个 `unknown/` 目录。

**操作事件**（打开 / 旋转 / 清扫 / 错误）记录到 `~/.claude/session-mirrors/session-mirror-events.jsonl`（5 MB 单层旋转）。镜像对上游流量是只读的；不修改请求或响应，写入错误由管道中的每个钩子 try/catch 隔离。

参见 [docs/disk-usage.md](docs/disk-usage.md) 获取最坏情况磁盘占用会计。

## 缓存断点（代理模式，可选）

Anthropic 的提示缓存支持每个请求最多 **四个** `cache_control` 标记。Claude Code 目前使用其中的三个；第三个（在自动注入的 `messages[0]` 内容 —— 钩子、技能、项目 CLAUDE.md、延迟工具、MCP 服务器描述 —— 和第一个真实用户内容之间）完全缺失。没有该标记，自动注入范围内的每次更改都会破坏后续所有缓存。wadabum 预测添加它可节省 ~6,500 token 每次新鲜会话首次轮次（[anthropics/claude-code#47098](https://github.com/anthropics/claude-code/issues/47098)）。

代理可以在选择时注入缺失的标记。默认关闭，直到与社区数据验证：

```sh
export CACHE_FIX_INJECT_MESSAGES_BREAKPOINT=1
```

注入是保守的：它只在请求已携带 1–3 个标记（典型 CC 形状）时触发，并拒绝如果请求达到 4 标记限制（会 400）或零标记（Agent SDK / API 直接形状此扩展不构建）时。边界检测覆盖所有五种观察到的自动注入块类型 —— 钩子、技能、CLAUDE.md、延迟工具、MCP —— 并将标记放在最后一个自动注入块上。

仅诊断环境变量转储 `messages[0]` 的结构形状以用于夹具来源，而不修改请求：

```sh
export CACHE_FIX_DUMP_MESSAGES_HEAD=/tmp/messages-head.jsonl
```

| 环境变量 | 默认值 | 目的 |
|---|---|---|
| `CACHE_FIX_INJECT_MESSAGES_BREAKPOINT` | 未设置 | 启用断点 #3 注入（`=1` 选择）。 |
| `CACHE_FIX_DUMP_MESSAGES_HEAD` | 未设置 | 诊断 JSONL 转储 `messages[0].content` 形状 —— 只读，无修改。 |

## 微压缩稳定性（代理模式，可选）

在 ~90 分钟空闲后，Claude Code 的 `time_based_microcompact`（和由 `FDY()` 触发的冷压缩路径）会用哨兵字符串替换旧 `tool_result` 内容。原始内容对缓存目的已消失；那部分无法从代理恢复。但哨兵本身可以携带嵌入的时间戳（`[Old tool result content cleared at 2026-04-30T13:42:11Z]`），这意味着对同一已清除位置的 *第二次* 微压缩写入不同字节 —— 即使没有添加新内容，也会破坏该位置之后的所有缓存。

此扩展解决可恢复的一半：将哨兵规范化为字节稳定的规范形式，因此重复微压缩不会搅动缓存。**仅阶段 1** —— 诊断 + 选择性规范化。阶段 2（原始 tool_result 内容的快照和恢复）推迟到 v3.5.0+ 待阶段 1 生产数据。

```sh
# 步骤 1（诊断）：表征 CC 的哨兵实际看起来像什么。
export CACHE_FIX_DUMP_MICROCOMPACT=/tmp/microcompact-dump.jsonl

# 步骤 2（规范化）：一旦哨兵格式确认，选择性启用。
export CACHE_FIX_NORMALIZE_MICROCOMPACT=1
```

检测有两种模式：
- **模式 A** —— 精确匹配已确认的 CC 哨兵模式（裸形式和 ISO-8601 时间戳变体）。模式 A 匹配可进行规范化。
- **模式 B** —— 仅前缀匹配（文本以 `[Old tool result content cleared` 开头但不完全匹配模式 A）模式。模式 B 是 **诊断专用**：从不规范化，转储记录仅红字到 64 字符前缀。

模式 A/B 分离保护哨兵可能后跟用户派生内容的情况（例如，一个工具将用户输入回显到其结果中） —— 模式 B 的红字保证将该内容排除在诊断转储外。

| 环境变量 | 默认值 | 目的 |
|---|---|---|
| `CACHE_FIX_DUMP_MICROCOMPACT` | 未设置 | 检测哨兵的诊断 JSONL 转储路径。只读 —— 无修改。 |
| `CACHE_FIX_NORMALIZE_MICROCOMPACT` | 未设置 | 启用规范化（`=1` 选择）。将模式 A 匹配转换为规范形式。 |
| `CACHE_FIX_MICROCOMPACT_NORMALIZED` | `[Old tool result content cleared]` | 覆盖规范替换字符串。 |
| `CACHE_FIX_MICROCOMPACT_SENTINEL_PATTERN_<N>` | 未设置 | 添加自定义模式 A 正则表达式。编号（1 索引，稀疏 OK）。 |
| `CACHE_FIX_MICROCOMPACT_SENTINEL_PREFIX_<N>` | 未设置 | 自定义模式 B 字面前缀。与非默认哨兵家族的自定义模式 A 模式配对，因此该家族的仅前缀变体也会被红字捕获。 |
| `CACHE_FIX_MICROCOMPACT_REDACT_LEN` | `64` | 转储记录中的模式 B 前缀长度。设为 `0` 以完全抑制前缀。 |
| `CACHE_FIX_DUMP_MICROCOMPACT_INCLUDE_NORMALIZED` | 未设置 | 在转储记录中添加后规范化文本（不替换）原始 `sentinel_text`。 |

## Thinking 摘要（代理模式，可选，Opus 4.7+）

在 Opus 4.7 上，Anthropic 将 `thinking.display` 的 API 默认从 `"summarized"` 翻转为 `"omitted"`。同时，Claude Code 的 CLI 有一个 `!getIsNonInteractiveSession()` 门，仅当会话交互时才传播 `display: "summarized"`。组合意味着每个使用 `--input-format stream-json` 启动的 CC 子进程 —— VS Code 聊天面板、Antigravity 面板、SDK、`claude --print` —— 发送一个启用 thinking 的请求（`thinking.type` 是 `"enabled"` 或 `"adaptive"`，取决于 CC 版本），但不带 `display`，API 响应的 `thinking` 字段为空（加上多 KB 签名）。UI 显示静态 "Thinking" stub 时代理运行但从不显示推理内容。

上游根本原因和补丁在 [anthropics/claude-code#59844](https://github.com/anthropics/claude-code/issues/59844) 中提出（信用：[@ojura](https://github.com/ojura)）。此扩展是代理端补充：当请求到 Opus 4.7 端点的 thinking 已启用但 `display` 未设置时，在 API 边界注入配置模式。适用于通过 cache-fix-proxy 路由的任何 CC 版本，无需等待 Anthropic 发布 CLI 修复。

```sh
# 恢复摘要（内置默认 —— 非交互表面获得推理内容）
export CACHE_FIX_THINKING_DISPLAY=summarized

# 强制抑制覆盖（完全不想要 thinking 块的代理运行时）
export CACHE_FIX_THINKING_DISPLAY=omitted

# 显式无操作（扩展原样通过）
export CACHE_FIX_THINKING_DISPLAY=disabled
```

自 v3.6.1 起，扩展 **默认开启**。缓存前缀测试测量在 Opus 4.7 上启用注入时稳定状态 `cache_read` 比率下降 0%（每窗口 5 次连续 `claude -p` 调用，基线 vs 注入 —— 从调用 2 开始两个窗口都保持 1.000 cache_read 比率）。将 `thinking.display` 添加到请求体更改 Anthropic 哈希的字节，但 Anthropic 的缓存层接受并索引注入前缀的方式与任何其他前缀相同。希望旧的 "无注入" 行为（例如完全避免任何请求体变异）的用户明确设置 `CACHE_FIX_THINKING_DISPLAY=disabled`。

扩展中内置的作用域规则：

- **模型门控。** 仅在请求的 `model` 匹配 `/^claude-opus-4-7/` 时触发 —— 覆盖 `claude-opus-4-7` 和 `claude-opus-4-7-1m`。Sonnet 4.7 需要单独验证（API 默认翻转可能不同）；未来版本（4.8+）需要显式 cache-fix 升级而不是自动应用未经验证的行为。
- **用户选择保留。** 如果请求已设置 `thinking.display`（无论是 `"summarized"` 还是 `"omitted"`），扩展从不覆盖。明确的用户选择总是获胜。
- **仅 Thinking 活跃类型。** 扩展在 `thinking.type` ∈ `{ "enabled", "adaptive" }` 时触发 —— 在 Opus 4.7 上产生 thinking 块的两个活跃模式。其他值（`"disabled"`，未来模式）被跳过。保守：如果 Anthropic 发布具有不同显示语义的新 thinking 类型，我们宁愿错过修复而不是自动应用错误行为。

| 环境变量 | 默认值 | 目的 |
|---|---|---|
| `CACHE_FIX_THINKING_DISPLAY` | `summarized`（内置） | 一个 `summarized` / `omitted` / `disabled`。`summarized` 恢复 thinking 摘要（默认）。`omitted` 强制抑制 thinking 块。`disabled` 完全退出扩展。 |

## 会话健康预警（代理模式，thinking-desync 风险）

长时间运行的 Opus 4.7 `[1m]` 会话累积交错的 thinking 块并增长其活动上下文，直到 Claude Code 自身的历史重建使 thinking-block 签名不同步，导致每次后续轮次永久 `400 … thinking blocks … cannot be modified`（上游根本原因：[anthropics/claude-code#63147](https://github.com/anthropics/claude-code/issues/63147)）。会话突然死亡且无先前信号。

`session-health` 扩展监视与触发相关的条件，并在会话达到危险区域 **之前** 警告，因此操作员可以故意退休它（写入会话状态交接，`/clear`），而不是被死会话惊吓。它是 **只读的** —— 它从不修改请求/响应体，也从不尝试修复不同步（那是 CC 端，#63147）。每次请求时将数字遥测记录到每会话文件（`~/.claude/quota-status/sessions/<id>.json`），并在会话首次进入 `high` 风险时发出一次 stderr 行。仅计数 —— 从不记录 thinking 文本或签名。

添加到每会话 JSON 的字段：

- `context_tokens` —— 最新请求的活动上下文（`input + cache_read + cache_creation`）
- `thinking_block_count` —— 最新请求中的 `thinking`/`redacted_thinking` 块
- `thinking_block_max` —— 会话高水位标记（跨代理重启携带）
- `first_seen`, `request_count` —— 会话年龄 + 请求总计
- `thinking_desync_risk` —— `ok` / `warn` / `high`（当信号禁用时省略）

token 阈值锚定到观察到的 ~382K-token 触发点并有余量；警告设计保守 —— 提前 "尽快退休" 比死会话便宜得多。块计数记录但尚未触发警告（在已知失败分布后激活快速跟进）。

| 环境变量 | 默认值 | 目的 |
|---|---|---|
| `CACHE_FIX_THINKING_RISK_WARN_TOKENS` | `250000` | `thinking_desync_risk` 变为 `warn` 的上下文 token 级别。 |
| `CACHE_FIX_THINKING_RISK_HIGH_TOKENS` | `340000` | 风险变为 `high` 且一次性 stderr 警告触发的上下文 token 级别。 |
| `CACHE_FIX_THINKING_RISK` | 未设置（开启） | 设置为 `off` 以抑制警告信号（stderr 行 + `thinking_desync_risk` 字段）。原始计数遥测继续记录。 |

## Thinking-block 清理（代理模式，默认开启，thinking-desync 缓解）

思考不同步响应的 *缓解* 半部分（*警告前* 部分是上面的 session-health）。在历史重放路径上（恢复 / `--continue` / 自动压缩 / 并行工具取消），Claude Code 重新发送先前助手轮次的扩展 thinking，以 **省略** 形式 `{ "type":"thinking", "thinking":"", "signature":"<intact>" }`。API 拒绝在 **最新** 助手消息中修改 thinking，并永久返回 `400 … thinking … blocks cannot be modified`，这会使会话在每次后续轮次中卡住（上游根本原因：[anthropics/claude-code#63147](https://github.com/anthropics/claude-code/issues/63147)）。

`thinking-block-sanitize` 扩展在转发前从请求中删除这些省略的块 —— API 将其视为可选历史。通过经验解决轮次选择规则：从 **所有先前助手轮次和最新助手轮次中删除省略的 thinking，除非最新轮次是活动工具延续**（其最后一个块是 `tool_use` 由后续 `tool_result` 回答）。在那种情况下，API 要求签名的 thinking 完整，代理无法恢复空文本，因此保留该轮次不变。**对于这种情况，没有环境变量同时保留 thinking 并避免楔子：** `CLAUDE_CODE_DISABLE_THINKING=1` / `MAX_THINKING_TOKENS=0` 仅通过完全禁用 thinking 来阻止楔子（损失性 —— 无推理），而 `DISABLE_INTERLEAVED_THINKING=1` 不会阻止 `400` —— 因此答案是不要恢复 + 治疗/退休会话。这正是代理缓解的原因：**它是唯一在覆盖的历史重放路径上保留推理同时避免楔子的路径**。非空 thinking 从不处理；`redacted_thinking` 在 v1 范围外。

**自 v4.0.0 默认开启。** v1 是通过 `CACHE_FIX_THINKING_SANITIZE=on` 在 v3.8.0–v3.9.x 中选择的。在 37 个会话中经过七天的生产狗粮测试（零 `cannot be modified` 400，缓存命中率平均 94.66% vs 基线 92.44%，每会话约 35% 的会话中发生清理，每天约 800 个块被丢弃，最大 938K 上下文健康）v1 缓解现在是新默认值。该转换是确定性的且缓存前缀稳定，并在每会话 JSON 中发出每次请求的 `thinking_blocks_dropped` 计数（仅计数 —— 从不内容）以补充 session-health 信号。v2 在 [#196](https://github.com/cnighswonger/claude-code-cache-fix/issues/196) 关闭静默加载失败模式后等待其自己的生产狗粮窗口才能运行。

| 环境变量 | 默认值 | 目的 |
|---|---|---|
| `CACHE_FIX_THINKING_SANITIZE` | 未设置 (= v1) | v4.0.0+：v1 省略块删除是默认。设置为 `off` 明确禁用（返回到 v3.x 默认关闭行为）。设置为 `v2` 以额外启用 v2 工具哈希不匹配删除。设置为 `on` 用于 v1（向后兼容 —— 等同于未设置）。 |

## 系统提示重写（预加载模式，可选）

拦截器可以重写 Claude Code 的 `# Output efficiency` 系统提示部分。默认关闭。通过 `CACHE_FIX_OUTPUT_EFFICIENCY_REPLACEMENT` 启用。参见 [docs/output-efficiency-prompts.md](docs/output-efficiency-prompts.md) 获取三个已知提示变体和使用说明。

## 监控与诊断

预加载拦截器包括对微压缩降级、假速率限制器、GrowthBook 标志状态、使用遥测和成本报告的监控。额度跟踪在代理和预加载模式下通过 `~/.claude/quota-status/`（代理：每会话拆分）或 `~/.claude/quota-status.json`（预加载：单会话旧路径）工作。

参见 [docs/monitoring.md](docs/monitoring.md) 获取完整详细信息、调试模式、前缀差异、环境变量和捆绑的额度分析工具。

### `usage-log` 扩展和 `MeterRowSchema v:1` 线格式

`usage-log` 扩展（通过 `proxy/extensions.json` 选择）在 `~/.claude/usage.jsonl` 中为每个 API 响应追加一行 JSON。行形状是 `MeterRowSchema v:1` —— 由 [`claude-code-meter`](https://github.com/cnighswonger/claude-code-meter) 的严格模式验证的跨仓库契约。以下每个字段在每次调用中捕获：

| 字段 | 类型 | 来源 |
|---|---|---|
| `v` | 字面值 `1` | 常量 |
| `ts` | ISO-8601 日期时间 | 服务器在行发出时的时间 |
| `sid` | 8 位小写十六进制 | 代理会话 ID，代理生命周期内粘性 |
| `model` | 字符串 ≤64 | 响应流中的 `message_start.message.model` |
| `requested_model` | 字符串 ≤64（可选） | 请求体 `model` 字段 |
| `model_mismatch` | 布尔值（可选） | 当 `requested_model && model && requested_model !== model` 时为 true |
| `speed` | `"standard"` / `"fast"` / `""` | 响应 `usage.speed` |
| `service_tier` | 字符串 ≤32 | 响应 `usage.service_tier` |
| `input_tokens` | 整数 ≥0 | 响应使用 |
| `output_tokens` | 整数 ≥0 | 响应使用 |
| `cache_creation_input_tokens` | 整数 ≥0 | 响应使用 |
| `cache_read_input_tokens` | 整数 ≥0 | 响应使用 |
| `ephemeral_1h_input_tokens` | 整数 ≥0 | 响应使用 |
| `ephemeral_5m_input_tokens` | 整数 ≥0 | 响应使用 |
| `web_search_requests` | 整数 ≥0 | 响应使用 |
| `q5h` / `q7d` | 浮点 0–2 | `anthropic-ratelimit-unified-{5h,7d}-utilization` 头 |
| `q5h_reset` / `q7d_reset` | 整数（unix 秒） | 对应重置头 |
| `qstatus`, `qoverage`, `qclaim` | 小写枚举 | 统一状态 / 超量 / 声明头 |
| `qfallback_pct` | 浮点 0–1 | 统一回退百分比 |
| `qoverage_util` | 浮点 ≥0（可选） | 超量使用头 |
| `qrepresentative_claim` | 字符串 ≤16（可选） | 代表性声明头 |
| `org_id` | 16 位十六进制（可选） | `sha256(anthropic-organization-id).slice(0, 16)` —— 永远不原始 |
| `overage_disabled_reason` | 字符串 ≤64（可选） | 超量禁用原因头 |
| `cache_hit_rate` | 浮点 0–1 | `cache_read_input_tokens / (input + cache_creation + cache_read)` |
| `q5h_delta`, `q7d_delta` | 浮点 | 每次调用与前一行 q5h/q7d 的差值；重启后第一次调用为 0 |
| `request_id` | 字符串 ≤64（可选） | 上游 `request-id` 响应头。**自 v4.2.0 默认开启。** `CACHE_FIX_USAGE_LOG_REQID=off` 是一个杀开关（省略字段）用于卡在 pre-meter-v0.7.0 安装的操作员。**跨仓库门：** `claude-code-meter >= v0.7.0` 接受可选字段；旧版 meter 安装通过严格对象模式拒绝未知键。 |

**为什么 `request_id` 在操作上很重要。** `sid` 字段在代理启动时生成一次，并在代理服务的每个 CC 会话中共享。在运行多个并发 CC 会话通过一个代理的主机上（在代理舰队中常见），每个会话的行都会合并到同一个 `sid` —— 无法从 `usage.jsonl` 中问 "哪个会话燃烧了今天 Opus token 的 80%？"。CC 的每会话 JSONL 转录在 `~/.claude/projects/<project>/<session-uuid>.jsonl` 中已经携带每个 API 调用的 `requestId`。在计量行中捕获相同值使事后连接变得简单：

```bash
# 找到每个 usage.jsonl 行属于哪个 CC 会话：
for row in $(jq -c . < ~/.claude/usage.jsonl); do
  req=$(jq -r '.request_id // empty' <<< "$row")
  [ -z "$req" ] && continue
  grep -l "\"requestId\":\"$req\"" ~/.claude/projects/*/*.jsonl
done
```

匹配转录的文件名是 CC 会话 UUID，恢复每个发出该字段的计量行的每会话归属。

### `upstream-error-log` 扩展（非 200 响应捕获）

上面的 `usage-log` 扩展只记录成功（200）响应。非 200s（429 容量节流，5xx 错误）只留下调试日志中的非结构化行，因此服务器端节流对基于 `usage.jsonl` 的任何分析都是有效不可见的。

`upstream-error-log`（选择性启用，v4.2.0 新增）为每个 `status >= 400` 发出结构化记录到 `~/.claude/usage-log/upstream-errors.jsonl`。两种不同的 429 类看起来对用户相同 —— **账户/使用限制** 携带 `anthropic-ratelimit-unified-*` 头 + `retry-after`；**基础设施/容量** 是 Cloudflare 前端，仅携带 `x-should-retry: true`，无速率限制头（"服务器暂时限制请求，而不是您的使用限制" 的情况）。区分器是 `has_ratelimit_headers`（布尔值）：有头 → 使用限制；无头 → 容量事件。

通过环境变量启用；默认关闭：

```bash
export CACHE_FIX_UPSTREAM_ERROR_LOG=on
```

| 环境变量 | 默认值 | 目的 |
|---|---|---|
| `CACHE_FIX_UPSTREAM_ERROR_LOG` | `off` | 主门 —— `on` 启用捕获 |
| `CACHE_FIX_UPSTREAM_ERROR_LOG_PATH` | `~/.claude/usage-log/upstream-errors.jsonl` | 日志路径覆盖 |

每行记录字段：`schema_version`, `ts`, `type`, `session_id`, `requested_model`, `request_path`, `response_status`, `upstream_message`, `has_ratelimit_headers`, `ratelimit_status`, `ratelimit_overage_status`, `x_should_retry`（从字符串标准化为布尔值），`retry_after`, `upstream_request_id`, `upstream_connection_id`。

这是现有 `rate-limit-log` 扩展的 **超集** —— `rate-limit-log` 仅在标准 `rate_limit_error` 主体包络触发，错过容量类 429s（其主体形状不同）；`upstream-error-log` 在每个 `status >= 400` 时触发，无论主体形状如何。独立的 JSONL 流；分析师通过 `session_id + ts` 连接。两者可以同时启用而无干扰。

### 代理拥有的 OAuth 刷新（可选）

默认关闭的子系统，使 cache-fix 代理成为 `~/.claude/.credentials.json` 中 OAuth 凭证的单一、主动、锁协作刷新器。关闭了刷新令牌旋转竞争，该竞争可能撤销整个令牌家族并导致每个并发 Claude Code 客户端运行相同 OS 用户时 401 —— 一种客户端重启无法恢复的故障（只有交互式 `/login` 才能恢复）。

竞争：Anthropic 的刷新令牌在每次使用时旋转。每次成功刷新返回新的访问令牌和新的刷新令牌，使先前令牌失效；重用已消耗的刷新令牌被视为盗窃并撤销整个家族。当 N 个客户端共享一个 `~/.claude/.credentials.json` 并且访问令牌过期（~8h 频率），两个客户端可以竞争 POST 相同的刷新令牌 —— 服务器看到重用并撤销两者。之后，文件中的刷新令牌死亡；只有交互式 `/login` 可以恢复。

最近的 Claude Code 二进制（2.1.148+）通过 `proper-lockfile` 在跨进程共享 `~/.claude/.oauth_refresh.lock`，但有 10 秒过期窗口。运行时间超过 10s 的刷新 POST 允许唤醒客户端在无锁情况下继续并 POST 相同令牌 —— 竞争仍然发生。

此扩展使代理成为主动单一刷新器：它保持共享令牌新鲜，并在刷新期间持有客户端自己的 `.oauth_refresh.lock`，因此唤醒客户端会发现新鲜令牌并短路而不 POST。恰好一个方达到令牌端点 → 无双重支出 → 无家族撤销。

通过环境变量启用；默认关闭：

```bash
export CACHE_FIX_OAUTH_REFRESH=on
```

| 环境变量 | 默认值 | 目的 |
|---|---|---|
| `CACHE_FIX_OAUTH_REFRESH` | `off` | 主门 —— `on` 启用刷新器 |
| `CACHE_FIX_OAUTH_CRED_PATH` | `~/.claude/.credentials.json` | 凭证文件路径 |
| `CACHE_FIX_OAUTH_TOKEN_URL` | `https://platform.claude.com/v1/oauth/token` | 令牌端点（测试覆盖） |
| `CACHE_FIX_OAUTH_REFRESH_MARGIN_MS` | 7200000 (2h) | 当到期在该窗口内时刷新 |
| `CACHE_FIX_OAUTH_TICK_MS` | 300000 (5min) | 检查间隔 |
| `CACHE_FIX_OAUTH_POST_TIMEOUT_MS` | 8000 | 硬刷新 POST 死线；**必须低于客户端的 10000 ms 过期窗口** |

`CACHE_FIX_OAUTH_POST_TIMEOUT_MS` 是负载承载。刷新 POST 有 `AbortController` 计时器覆盖头和响应体读取。超时后结果是未知 —— 服务器可能或可能没有旋转令牌 —— 因此代理不写入，不重试，发出不同的 `oauth_refresh_timeout` 事件，并在任何下一次尝试前至少等待一个完整过期窗口。排序保证如果代理在计时竞争中失败，它通过 *不 POST 再次* 而不是并发 POST。

添加 `proper-lockfile` 作为运行时依赖（唯一其他运行时依赖是 `hpagent`）。

操作事件记录到 `~/.claude/cache-fix-oauth-events.jsonl`。七种事件类：`oauth_refreshed`（常规），`oauth_family_revoked`（响亮 —— 需要人工 `/login`；还写入 stderr 横幅），`oauth_refresh_timeout`（未知结果 —— 不写入，不重试），`oauth_refresh_error`（干净失败 —— 保留文件，下一次尝试），`oauth_refresh_skipped`（已旋转或不再到期），`oauth_lock_contended`（另一个写入者持有锁），`oauth_cred_*`（验证失败：符号链接拒绝，模式警告，不可读）。记录仅携带 `{event, outcome, status_code, expires_at, err_class, elapsed_ms}` —— 从不令牌字符串，从不原始 POST 主体，从不原始响应主体。

每次凭证读取的验证门：不是符号链接，模式 `0600`，所有者匹配 UID，JSON 形状有效。原子持久化：临时写入（模式 0600）+ fsync FD + 重命名 + fsync 父目录，保留旋转期间的每个其他凭证字段。

回退：关闭门 + 代理重启 → 客户端自管理完全如今天（它们总是读取文件，因此回退是自动的）。

## 限制

- **代理需要运行进程** —— 代理必须在 Claude Code 之前启动。如果它未运行且 `ANTHROPIC_BASE_URL` 指向它，CC 将无法连接。我们推荐将其作为 systemd 服务运行或使用健康检查包装脚本。
- **超量 TTL 降级** —— 超过 5 小时额度的 100% 会触发服务器强制 TTL 从 1h 降至 5m。这是服务器端的，无法在客户端修复。代理/拦截器防止缓存不稳定导致您进入超量的第一步。
- **微压缩不可预防** —— 监控功能检测上下文降级但无法阻止它。微压缩和预算执行由 GrowthBook 标志控制，没有客户端禁用选项。
- **系统提示重写是实验性的** —— 仅预加载，选择性启用。未证明是社区报告中讨论的行为差异的原因。使用风险自负。
- **版本耦合** —— 指纹盐和块检测启发式来自 Claude Code 内部。重大重构可能需要更新此包。

## 相关研究

- **[@ArkNill/claude-code-hidden-problem-analysis](https://github.com/ArkNill/claude-code-hidden-problem-analysis)** —— 38,996 次请求代理分析：7 个 bug（微压缩、预算上限、假速率限制器、JSONL 重复、扩展 thinking），GrowthBook 功能标志因果测试，Opus 4.7 燃烧率建议。v1.1.0 中的监控功能受此研究启发。
- **[@Renvect/X-Ray-Claude-Code-Interceptor](https://github.com/Renvect/X-Ray-Claude-Code-Interceptor)** —— 带实时仪表板、系统提示部分差异、每工具剥离阈值的诊断 HTTPS 代理。适用于任何支持 `ANTHROPIC_BASE_URL` 的 Claude 客户端。
- **[@fgrosswig/claude-usage-dashboard](https://github.com/fgrosswig/claude-usage-dashboard)** —— 自托管取证仪表板，带 SSE 实时监控、多主机聚合、缓存健康评分。与我们代理的视角互补。参见 [docs/dashboard-integration.md](docs/dashboard-integration.md) 获取互操作设置。

## 生产中使用

- **[Crunchloop DAP](https://dap.crunchloop.ai)** —— Agent SDK / DAP 开发环境。第一个将拦截器合并到主干以进行团队部署的生产团队（2026-04-10）。通过实际测试识别了两种不同的缓存回归模式 —— 工具排序抖动和新鲜会话排序间隙 —— 并贡献了驱动 v1.5.1 和 v1.6.2 修复的调试跟踪。贡献了嵌入式代理工厂（v3.6.0），使代理可以在 Bun 编译和 DAP 风格代理二进制中运行，而无需 fork Node 子进程。
- **[VM Farms](https://vmfarms.com)** ([@vmfarms](https://github.com/vmfarms)) —— 使用 `--resume --fork-session` 运行并发多运行器工作负载的代理开发环境。揭示了三个 cache-fix 代理模式 bug：恢复标记正则表达式无操作（#96）、TTL 等级检测与预加载模式差距（#97）、图像剥离 stderr 泄漏超过 `CACHE_FIX_DEBUG`（#98）——所有这些在 v3.4.0 版本中解决。

## 贡献者

- **[@VictorSun92](https://github.com/VictorSun92)** —— v2.1.88 的原始补丁修复，v2.1.90 中识别部分散射，贡献前向扫描检测、正确块排序、更紧的块匹配器和可选输出效率重写钩子
- **[@bilby91](https://github.com/bilby91)** ([Crunchloop DAP](https://dap.crunchloop.ai)) —— Agent SDK / DAP 生产环境验证，1h 缓存 TTL 确认，通过调试跟踪发现工具排序抖动（v1.5.1 修复），通过 SKILLS SORT 诊断发现新鲜会话排序 bug（v1.6.2 修复）。第一个将拦截器推到主干的生产团队。设计并贡献了嵌入式代理工厂（`startProxy()` / `createProxyServer()`）在 v3.6.0 中发布（PR #123）。
- **[@jmarianski](https://github.com/jmarianski)** —— 通过 MITM 代理捕获和 Ghidra 反向工程进行根本原因分析，多模式缓存测试脚本
- **[@cnighswonger](https://github.com/cnighswonger)** —— 指纹稳定、工具排序修复、图像剥离、监控功能、超量 TTL 降级发现、代理架构、包维护者
- **[@ArkNill](https://github.com/ArkNill)** —— 微压缩机制分析、GrowthBook 标志文档、假速率限制器识别、CC v2.1.108+ 指纹验证修复（PR #21）、韩语 README（PR #22）、[claude-code-hidden-problem-analysis](https://github.com/ArkNill/claude-code-hidden-problem-analysis) 研究
- **[@Renvect](https://github.com/Renvect)** —— 图像重复发现、跨项目目录污染分析
- **[@fgrosswig](https://github.com/fgrosswig)** —— [claude-usage-dashboard](https://github.com/fgrosswig/claude-usage-dashboard) 取证方法：成本因子超支比率指标，`anthropic-*` 头捕获模式，代理 NDJSON 模式，为我们的仪表板互操作层提供信息
- **[@TomTheMenace](https://github.com/TomTheMenace)** —— Windows `.bat` 包装器，首次 Windows 平台验证（7.5h/536 次调用 Opus 4.6 会话，98.4% 缓存命中率）
- **[@arjansingh](https://github.com/arjansingh)** —— 具有动态 `npm root -g` 路径解析的 nvm 兼容包装脚本（PR #15）
- **[@beekamai](https://github.com/beekamai)** —— 当 npm root 包含空格时 `claude-fixed.bat` 的 Windows URL 编码修复（PR #17）
- **[@JEONG-JIWOO](https://github.com/JEONG-JIWOO)** —— VS Code 扩展调查：发现 `claudeCode.claudeProcessWrapper` 为工作集成路径，为 Windows 编写 C 包装器（#16）
- **[@X-15](https://github.com/X-15)** —— VS Code 扩展验证，通过每修复健康状态分析确认 v2.1.105 上的安全检查行为（#16）；揭示了 VS Code 扩展自动更新中的每构建 `cc_version` 缓存破坏模式（#238），在 v4.2.0 中成为 `cc-version-normalize` 扩展
- **[@deafsquad](https://github.com/deafsquad)** —— 通用 smoosh_split 解除合并修复（PR #26），恢复散列 bug 的源级函数归因（anthropics/claude-code#43657），OTEL 遥测发现，为 v3.0.0 提出并构建代理架构
- **[@vmfarms](https://github.com/vmfarms)** —— 并发多运行器生产验证，揭示代理模式恢复标记正则表达式无操作（#96）、TTL 等级检测差距（#97）和图像剥离 stderr 泄漏（#98）
- **[@ojura](https://github.com/ojura)** —— Opus 4.7 thinking-summaries 根本原因分析：提交 [anthropics/claude-code#59844](https://github.com/anthropics/claude-code/issues/59844) 包含 CLI 二进制解码（v2.1.142 中偏移 230510599 的 `!getIsNonInteractiveSession()` 门）和两堆叠特殊案例框架，使 `thinking-display` 扩展（v3.6.1）成为提议的上游修复的干净代理端补充
- **[@yurukusa](https://github.com/yurukusa)** —— [anthropics/claude-code#63147](https://github.com/anthropics/claude-code/issues/63147) thinking-desync 楔子的集群分类；13E（ToolSearch）子模式合成使 `thinking-block-sanitize` v2 指令谓词可处理（cache-fix #171，v4.0.0 中通过 `=v2` 选择启用）
- **[@schuay](https://github.com/schuay)** —— `quota-statusline.sh` 增强：10 单元额度条带，包含已用时间刻度和 exhaust-vs-reset 投影，取代之前的 `%/min` 燃烧率显示（PR #140, v3.6.2），以及 d/h vs h/m 时间格式自动选择加上命名时间单位和燃烧预热常数（PR #143, v3.7.0）
- **[@codeslake](https://github.com/codeslake)** —— 可选的前向代理模式（HTTP `CONNECT` + 对上游主机的选择性 MITM），保持远程控制 / 移动会话可见性通过代理，解决 CC >= 2.1.196 上 `ANTHROPIC_BASE_URL` 禁用 RC 的问题（PR #251，实现 #248）；以及对所有磁盘代理状态使用 `CLAUDE_CONFIG_DIR`，因此多个配置根不会互相覆盖凭证/状态（PR #246）

如果您为这些问题贡献了社区努力但未列在此处，请打开一个问题或 PR —— 我们希望正确地给予每个人信用。

## 支持

如果这个工具为您节省了金钱，请考虑给我买杯咖啡：

<a href="https://buymeacoffee.com/vsits" target="_blank"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me A Coffee" style="height: 60px !important;width: 217px !important;" ></a>

## 许可证

[MIT](LICENSE)
