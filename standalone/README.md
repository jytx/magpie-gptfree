# 独立 HTTP 服务（脱离 Magpie 直接调用号池）

号池在 Magpie 里时，它是 Magpie 的一个 provider，外部软件要经 Magpie 的网关转发。
这个服务做的是同一件事，但不再需要 Magpie 在场：号池的选号、失败换号、令牌续期、
图片额度统计，都复用插件 `lib/` 里的现成实现。

## 起服务

```bash
GPTFREE_API_KEY=你的密钥 GPTFREE_PORT=38080 node standalone/server.mjs
```

- `GPTFREE_API_KEY`：接口密钥；不设就自动生成一个并打印出来。
- `GPTFREE_PORT`：端口，默认 `38080`。
- `GPTFREE_HOST`：监听地址，默认 `127.0.0.1`。要给局域网用，设 `0.0.0.0`，
  此时务必设置密钥。

号池数据沿用插件那一份（`~/.magpie-gptfree/`，可用 `MAGPIE_GPTFREE_HOME` 改），
和 Magpie 里的插件是同一批账号。

## 接口

| 接口 | 说明 |
| --- | --- |
| `GET /v1/models` | 模型列表（文本模型 + 图片模型） |
| `POST /v1/responses` | Responses 协议，原样透传上游 |
| `POST /v1/chat/completions` | Chat Completions 协议，服务内做协议转换（含流式） |
| `POST /v1/images/generations` | 生图 |
| `POST /v1/images/edits` | 局部重绘 |
| `GET /health` | 健康检查 |

鉴权用 `Authorization: Bearer <密钥>`（也认 `x-api-key`）。

## 用法

```bash
curl http://127.0.0.1:38080/v1/chat/completions \
  -H "Authorization: Bearer 你的密钥" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-5.6-luna","messages":[{"role":"user","content":"你好"}]}'
```

在第三方软件里填 Base URL `http://127.0.0.1:38080/v1`、上面的密钥，
模型名写 `gpt-5.6-luna` 或 `gpt-image-2.6`。

## 说明

- 文本走 Codex `/responses` 或 ChatGPT Web 会话接口，取决于账号的令牌类型；
  图片走 codex 图片接口。
- 与 Magpie 里的插件同时跑时，两者共用同一个号池文件。续期会写回该文件，
  而它的写锁只在单进程内有效，所以同一个时刻只让一个进程在跑更稳妥。
- 需要网络能直连 `chatgpt.com`；走代理时给进程设置 `HTTPS_PROXY`。
