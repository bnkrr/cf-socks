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

H2/H3 模式适合大量短的 client-first 交换，但它不是 `net.Conn` transport。在 Workers 上，单条 HTTP request stream 不能可靠承载长期打开的全双工 TCP tunnel，因此交互式连接仍使用 WSS。

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
```

### 方式 A：Cloudflare Dashboard

在 Cloudflare dashboard 中创建一个 Worker，把 [worker/single-file.js](worker/single-file.js) 复制到在线编辑器，并设置环境变量：

```text
AUTH_SECRET=<your generated secret>
AUTH_WINDOW_SECONDS=120
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
  --var "AUTH_WINDOW_SECONDS:120"
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

`Do(ctx, "tcp", "github.com:22", nil)` 会发送空 payload，H2 或 H3 都可读取 SSH 这类 server-first banner；但它仍然不是交互式连接。`Do` 在发送 payload 后也不会向目标 TCP 侧发送 EOF；它适合目标能根据已发送字节响应，或目标会先发数据的场景。

WSS `Dial` 返回 `net.Conn`。读 deadline 是可恢复的本地等待超时；写 deadline 只会在 WebSocket message 开始写入前生效，一旦写入已经开始，如需放弃连接请调用 `Close()`。关闭 WSS 也会关闭 Worker 侧的目标 TCP 连接，重连不能恢复同一个 TCP session。

## 安全

Worker 不是开放代理。客户端必须先使用从 `AUTH_SECRET` 派生的加密 bearer token 完成鉴权，Worker 才会打开任何出站 TCP 连接。

不要提交真实密钥。请使用 Wrangler secrets、Cloudflare 环境变量或本地 shell 环境变量。

## 限制

- Worker 出站 TCP 不能连接到 Cloudflare IP 段。
- 目前没有实现 SOCKS5 UDP ASSOCIATE 和 BIND。
- 每条被代理的 TCP 连接都会使用一条到 Worker 的 WebSocket。
- H2/H3 模式只支持 bounded payload；它不是 SOCKS 或 `net.Conn` transport，也不提供目标 TCP 半关闭/EOF 信号。

## 相关项目

这些项目和 `cf-socks` 的部分能力重叠，但产品边界或数据路径不同。

| 项目 | 相似点 | 差异 |
| --- | --- | --- |
| [serverless-proxy](https://github.com/serverless-proxy/serverless-proxy) | Worker 直连 TCP 目标。 | 使用自定义 WebSocket/HTTP2 入口，不是本地 SOCKS5。 |
| [ClassicUO gate](https://github.com/ClassicUO/gate) | Worker 桥接 WebSocket 和 TCP。 | 固定游戏服务器目标，不是通用 dialer。 |
| [zizifn/edgetunnel](https://github.com/zizifn/edgetunnel) | Worker 直连 TCP 目标。 | 面向 VLESS 代理栈。 |
| [cmliu/edgetunnel](https://github.com/cmliu/edgetunnel) | Worker 直连 TCP 目标。 | 更偏完整边缘代理配置生态。 |
| [EDtunnel](https://github.com/6Kmfi6HP/EDtunnel) | Worker 直连 TCP 目标。 | 多协议 VLESS/Trojan/SOCKS 风格代理节点。 |
| [linksocks](https://github.com/linksocks/linksocks) | SOCKS-over-WebSocket 隧道平台。 | Worker 模式更偏 connector/provider 中继。 |
| [linksocks.js](https://github.com/linksocks/linksocks.js) | 运行在 Cloudflare Workers 上。 | 中继 connector 和 provider，而不是 Worker 直接 dial 目标。 |
| [socksflareprox](https://github.com/quippy-dev/socksflareprox) | 本地 SOCKS，路径中包含 Cloudflare。 | 使用 Worker HTTP 端点和 Python 客户端。 |
| [cf-fetch-socks](https://github.com/oxcl/cf-fetch-socks) | 结合了 Workers 和 SOCKS 概念。 | Worker 使用上游 SOCKS 代理，流量方向相反。 |
