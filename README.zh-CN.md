<div align="center">

# cf-socks

把 Cloudflare Workers 的出站 TCP `connect()` 能力暴露给本地客户端使用。

[![CI](https://github.com/bnkrr/cf-socks/actions/workflows/ci.yml/badge.svg)](https://github.com/bnkrr/cf-socks/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/bnkrr/cf-socks)](https://github.com/bnkrr/cf-socks/releases)
[![Go](https://img.shields.io/badge/go-1.24%2B-00ADD8)](https://go.dev/)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020)](https://workers.cloudflare.com/)

[English](README.md) | [简体中文](README.zh-CN.md)

</div>

```text
application -> local SOCKS5 agent -> WSS Dial -> Cloudflare Worker -> TCP target
```

`cf-socks` 目前提供本地 SOCKS5 入口，因为多数应用已经支持 SOCKS 代理；同时提供 Go SDK：WSS `Dial` 用于交互式 TCP，H2/H3 `Do` 用于有边界的 payload 交换。

## 工作方式

Cloudflare Workers 可以创建出站 TCP 连接，但不能监听入站原始 TCP。`cf-socks` 把 SOCKS5 服务保留在本机，并把 Worker 作为远端 TCP dialer 使用。

每条被代理的 TCP 连接流程如下：

1. 应用连接到本地 SOCKS5 agent。
2. agent 带加密 bearer token 通过安全 WebSocket 连接 Worker。
3. Worker 在接受 WebSocket upgrade 前完成鉴权。
4. Worker 连接请求的目标主机和端口。
5. agent 和 Worker 双向转发字节流。

HTTPS 由原始客户端在 SOCKS 隧道内处理。Worker 不终止、不检查目标 TLS 流量。

自定义客户端可以使用 `Client.Do` 走 HTTP/2 或 HTTP/3 bounded payload：

```text
payload -> H2/H3 POST -> Cloudflare Worker -> TCP target -> response body
```

H2/H3 模式适合大量短的 client-first 交换，但它不是 `net.Conn` transport。在 Workers 的 H2/H3 测试中，只要 request body 保持打开，response headers 和 body bytes 就没有到达客户端，因此单条 HTTP request stream 不能可靠承载长期打开的全双工 TCP tunnel。交互式连接仍使用 WSS。

## 传输语义

`cf-socks` 明确区分连接语义，因为对这个场景来说，Workers 的 HTTP request 路径不能提供和 TCP socket 相同的长期全双工行为。WSS `Dial` 是交互式 TCP 路径，返回 `net.Conn`。H2/H3 `Do` 是有边界的 request/response 操作：它向 TCP 目标发送一个可选 payload，并把目标响应流返回。这样 `Do(nil)` 读取 SSH banner 这类 server-first 场景是显式 API，但不会暗示 H2/H3 是通用 TCP 连接。

端点、鉴权和 Worker TCP 绑定细节见 [Protocol Model](docs/protocol.md)。

## 环境要求

- Go，用于构建和运行本地 agent。
- 一个 Cloudflare 账号，用于部署 Worker。
- 只有在使用 Wrangler 部署而不是复制 Worker 到 Cloudflare Dashboard 时，才需要 Node.js 和 npm。

安装项目依赖：

```bash
go mod download
```

## 部署 Worker

生成共享密钥：

```bash
export CF_SOCKS_AUTH_SECRET="$(openssl rand -hex 32)"
export CF_SOCKS_DIRECT_BEARER="$(openssl rand -base64 32)"
```

### 方式 A：Cloudflare Dashboard

在 Cloudflare dashboard 中创建一个 Worker，把 [worker/single-file.js](worker/single-file.js) 复制到在线编辑器，并设置环境变量：

```text
AUTH_SECRET=<your generated secret>
AUTH_WINDOW_SECONDS=120
DIRECT_BEARER=<your generated direct bearer>
```

然后在 dashboard 中部署 Worker。这个路径不需要本地安装 Node.js、npm 或 Wrangler。

Dashboard 文件由 Wrangler 使用的同一份 Worker 源码生成，请不要手动编辑。修改 Worker 源码后，可用下面命令重新生成：

```bash
npm install
npm run worker:bundle-dashboard
```

CI 会检查 [worker/single-file.js](worker/single-file.js) 是否和 `worker/src/` 保持同步。

### 方式 B：Wrangler

安装 Node 依赖：

```bash
npm install
```

快速临时部署：

```bash
npx wrangler deploy --temporary \
  --var "AUTH_SECRET:$CF_SOCKS_AUTH_SECRET" \
  --var "AUTH_WINDOW_SECONDS:120" \
  --var "DIRECT_BEARER:$CF_SOCKS_DIRECT_BEARER"
```

持久部署时，在 Cloudflare Worker 环境中配置相同的值，然后部署：

```bash
npx wrangler deploy
```

Worker endpoint 使用 base URL：

```text
https://<your-worker-host>
```

## 运行 Agent

从源码运行本地 SOCKS5 agent：

```bash
go run ./cmd/cf-socks-agent \
  -listen 127.0.0.1:1080 \
  -worker-url https://<your-worker-host> \
  -auth-secret "$CF_SOCKS_AUTH_SECRET"
```

或者构建本地二进制：

```bash
go build -o cf-socks-agent ./cmd/cf-socks-agent
./cf-socks-agent \
  -listen 127.0.0.1:1080 \
  -worker-url https://<your-worker-host> \
  -auth-secret "$CF_SOCKS_AUTH_SECRET"
```

然后把应用配置为使用：

```text
socks5h://127.0.0.1:1080
```

对于 Docker daemon 这类期望 HTTP proxy 的客户端，也可以开启 HTTP CONNECT 入口：

```bash
./cf-socks-agent \
  -listen 127.0.0.1:1080 \
  -http-listen 127.0.0.1:3128 \
  -worker-url https://<your-worker-host> \
  -auth-secret "$CF_SOCKS_AUTH_SECRET"
```

然后把这些客户端配置为使用：

```text
http://127.0.0.1:3128
```

HTTP CONNECT 入口只负责适配本地代理握手。`CONNECT host:port` 成功后，后续字节会走和 SOCKS5 相同的 WSS `Dial` 数据路径。

agent 默认会在连接空闲 5 分钟后关闭代理连接。使用 `-idle-timeout -1` 可以禁用 idle timeout。

## 验证

通过代理测试 HTTP：

```bash
curl --socks5-hostname 127.0.0.1:1080 http://httpforever.com/
```

通过代理测试 HTTPS：

```bash
curl --socks5-hostname 127.0.0.1:1080 https://www.google.com/
```

检查代理出口 IP：

```bash
curl --socks5-hostname 127.0.0.1:1080 https://ifconfig.me/ip
```

测试 HTTP CONNECT 入口：

```bash
curl -x http://127.0.0.1:3128 https://ifconfig.me/ip
```

也可以不安装 agent 或 SDK，直接用 Direct endpoint 验证 bounded TCP payload：

```bash
printf 'GET / HTTP/1.1\r\nHost: httpforever.com\r\nConnection: close\r\n\r\n' \
  | curl --http2 --no-buffer \
      -X POST \
      -H "Authorization: Bearer $CF_SOCKS_DIRECT_BEARER" \
      --data-binary @- \
      https://<your-worker-host>/direct/httpforever.com/80
```

对 SSH banner 这类 server-first 协议：

```bash
curl --http2 --no-buffer --max-time 10 \
  -X POST \
  -H "Authorization: Bearer $CF_SOCKS_DIRECT_BEARER" \
  https://<your-worker-host>/direct/github.com/22
```

## Go SDK

Go client SDK 的 import path 是 `github.com/bnkrr/cf-socks/sdk/go`。

需要交互式 TCP 流时使用 WSS `Dial`：

```go
import cfsocks "github.com/bnkrr/cf-socks/sdk/go"

client := cfsocks.Client{
    Endpoint:  "https://<your-worker-host>",
    Secret:    os.Getenv("CF_SOCKS_AUTH_SECRET"),
    Transport: cfsocks.TransportWSS,
}
conn, err := client.Dial(ctx, "tcp", "httpforever.com:80")
```

已有完整 payload 时使用 H2 `Do`：

```go
import cfsocks "github.com/bnkrr/cf-socks/sdk/go"

client := cfsocks.Client{
    Endpoint:  "https://<your-worker-host>",
    Secret:    os.Getenv("CF_SOCKS_AUTH_SECRET"),
    Transport: cfsocks.TransportH2,
}
resp, err := client.Do(ctx, "tcp", "httpforever.com:80", strings.NewReader(
    "GET / HTTP/1.1\r\nHost: httpforever.com\r\nConnection: close\r\n\r\n",
))
```

H3 `Do` 是同样 bounded-payload 模式的 QUIC 替代：

```go
import (
    "net/http"

    cfsocks "github.com/bnkrr/cf-socks/sdk/go"
    "github.com/quic-go/quic-go/http3"
)

transport := &http3.Transport{}
defer transport.Close()

client := cfsocks.Client{
    Endpoint:   "https://<your-worker-host>",
    Secret:     os.Getenv("CF_SOCKS_AUTH_SECRET"),
    Transport:  cfsocks.TransportH3,
    HTTPClient: &http.Client{Transport: transport},
}
resp, err := client.Do(ctx, "tcp", "httpforever.com:80", strings.NewReader(
    "GET / HTTP/1.1\r\nHost: httpforever.com\r\nConnection: close\r\n\r\n",
))
```

如果 bounded payload 需要更高并发，可以使用 pool。H2 pool 在 root SDK 中：

```go
pool, err := cfsocks.NewClientPool(cfsocks.ClientPoolConfig{
    Endpoint:  "https://<your-worker-host>",
    Secret:    os.Getenv("CF_SOCKS_AUTH_SECRET"),
    Transport: cfsocks.TransportH2,
    Size:      4,
})
defer pool.Close()

resp, err := pool.Do(ctx, "tcp", "httpforever.com:80", payload)
```

H3 的生命周期管理放在 `h3` helper package 中，这样 root SDK 不会强制所有用户引入 HTTP/3 依赖：

```go
import cfh3 "github.com/bnkrr/cf-socks/sdk/go/h3"

pool, err := cfh3.NewPool(cfh3.PoolConfig{
    Endpoint: "https://<your-worker-host>",
    Secret:   os.Getenv("CF_SOCKS_AUTH_SECRET"),
    Size:     4,
})
defer pool.Close()

resp, err := pool.Do(ctx, "tcp", "httpforever.com:80", payload)
```

`Do(ctx, "tcp", "github.com:22", nil)` 会发送空 payload，H2 或 H3 都可读取 SSH 这类 server-first banner；但它仍然不是交互式连接。`Do` 在发送 payload 后也不会向目标 TCP 侧发送 EOF；它适合目标能根据已发送字节响应，或目标会先发数据的场景。

WSS `Dial` 返回 `net.Conn`。读 deadline 是可恢复的本地等待超时；写 deadline 只会在 WebSocket message 开始写入前生效，一旦写入已经开始，如需放弃连接请调用 `Close()`。关闭 WSS 也会关闭 Worker 侧的目标 TCP 连接，重连不能恢复同一个 TCP session。

## 安全

Worker 不是开放代理。客户端必须先使用从 `AUTH_SECRET` 派生的加密 bearer token 完成鉴权，Worker 才会打开任何出站 TCP 连接。

Direct endpoint 只有配置了 `DIRECT_BEARER` 才会启用。请把它当作长期 API key；如果泄漏，应立即轮换。

不要提交真实密钥。请使用 Wrangler secrets、Cloudflare 环境变量或本地 shell 环境变量。

## Benchmarks

`cfsbench` 位于 `cmd/cfsbench`，可用于本地和真实 Worker benchmark。当前 DNS-over-TCP 测试显示：WSS 通过打开大量独立连接扩展吞吐，而 H2/H3 `Do` 在高并发 bounded request 场景下更适合使用 HTTP transport pool。命令、结果和解释见 [Benchmarks](docs/benchmarks.md)。

## 限制

- Worker 出站 TCP 不能连接到 Cloudflare IP 段。
- 目前没有实现 SOCKS5 UDP ASSOCIATE 和 BIND。
- 在 WSS `Dial` 和 SOCKS agent 模式下，每条 TCP 连接都会使用一条到 Worker 的 WebSocket。
- H2/H3 模式只支持 bounded payload；它不是 SOCKS 或 `net.Conn` transport，也不提供目标 TCP 半关闭/EOF 信号。

## 相关项目

`cf-socks` 的核心边界是把 Cloudflare Workers 的出站 TCP `connect()` 能力交给客户端使用：WSS `Dial` 承载交互式 TCP，H2/H3 `Do` 承载 bounded payload，本地 SOCKS5 agent 也基于同一套 SDK。下面这些项目和它有局部重叠，但通常选择了不同的数据路径或产品边界。

| 项目 | 相似点 | 差异 |
| --- | --- | --- |
| [serverless-proxy](https://github.com/serverless-proxy/serverless-proxy) | 最接近的技术路线：serverless WebSocket/HTTP2 到 TCP proxy。 | 连接语义不同：`cf-socks` 把 WSS `Dial` 和 H2/H3 `Do` 明确拆成两个 API。见[传输语义](#传输语义)。 |
| [ClassicUO gate](https://github.com/ClassicUO/gate) | Worker 桥接 WebSocket 客户端和 TCP。 | 面向 UO 游戏服务器保护，部署假设固定，不是通用 TCP dialer SDK。 |
| [zizifn/edgetunnel](https://github.com/zizifn/edgetunnel) | Worker 直连 TCP 目标。 | 面向 VLESS 代理节点，而不是 client SDK + SOCKS agent。 |
| [cmliu/edgetunnel](https://github.com/cmliu/edgetunnel) | Worker 直连 TCP 目标。 | 更偏完整边缘代理配置生态，不是小型可编程 dialer。 |
| [EDtunnel](https://github.com/6Kmfi6HP/EDtunnel) | Worker 直连 TCP 目标。 | 多协议 VLESS/Trojan/SOCKS 风格代理节点。 |
| [linksocks](https://github.com/linksocks/linksocks) / [linksocks.js](https://github.com/linksocks/linksocks.js) | SOCKS-over-WebSocket 和 Worker 兼容 relay 思路。 | connector/provider 中继模型，更偏桥接 peer 或私网；不是每次 SDK 调用都由 Worker 直接 dial 目标。 |
| [SocksFlareProx](https://github.com/quippy-dev/socksflareprox) / FlareProx 类工具 | 本地 SOCKS 或 HTTP proxying 经过 Cloudflare Workers。 | 更偏 HTTP endpoint/request proxy；不强调通用 raw TCP `Dial`/`Do` 语义。 |
| [cf-fetch-socks](https://github.com/oxcl/cf-fetch-socks) | 结合了 Workers 和 SOCKS 概念。 | 方向相反：Worker 侧 HTTP client 通过上游 SOCKS5 代理出站。 |
