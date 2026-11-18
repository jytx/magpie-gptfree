# magpie-gptfree 插件的 GIF 生成能力实测报告

- 测试日期：2026-11-10
- 被测版本：`magpie-gptfree` v0.6.4（commit `eb0b076`，"support GPT Image 2.6 family including flare/sunburst and GIF output"）
- 被测通道：magpie 网关 `127.0.0.1:3425` → provider `gptfree-pool` → 插件 → ChatGPT Web `picture_v2`
- 结论：**支持。`gpt-image-2.6` 系列经该插件能产出真正的多帧 GIF 动图。**

## 一、结论速览

| 用例 | 模型 | `output_format` | 真实产物 | 帧数 | 尺寸 | 单帧延时 | 耗时 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A | `gpt-image-2.6` | `gif` | **GIF89a / `image/gif`** | **9** | 439×386 | 180ms | 124.8s |
| B | `gpt-image-2.6` | 不带 | PNG / `image/png` | 1 | 1212×1297 | — | 43.4s |
| C | `gpt-image-2.6-flare` | `gif` | **GIF89a / `image/gif`** | **9** | 439×390 | 180ms | 85.8s |
| D | `gpt-image-2` | `gif` | 无产物（400 拒绝） | — | — | — | 0.05s |

用例 A 与 B 的 prompt 完全相同，唯一变量是 `output_format`，因此可以确认：**`output_format=gif` 确实改变了上游的产物形态，不是「上游默认就出 GIF」**。

用例 D 是零额度探针：插件在触达上游之前就以 `GIF 动图需要 gpt-image-2.6 系列模型` 拒绝，证明 `output_format` 确实穿过网关到达了插件。

## 二、帧结构验证

不只是「文件后缀叫 .gif」。对产物按 GIF89a 块结构逐帧解析：

- 画布 439×386，共 9 帧，每帧矩形均为全画布 `(0, 0, 439, 386)`
- 每帧延时 180ms，总时长 1620ms（1.62s）
- **9 帧的图像数据指纹全部不同（9/9）** —— 是真动画，不是同一张图重复 9 次

验证工具链说明：本机 ImageMagick 缺 GIF 帧解码委托（`identify` 能读元数据，但 `convert`/`compare` 拆帧报 `no decode delegate`），故帧级验证改用纯标准库脚本解析 GIF 块结构取指纹。

## 三、两个必须知道的限制

### 1. `frame_count` / `frame_duration_ms` 在经网关的路径上收不到

插件实现了这两个参数（`lib/chatgpt-web-image.mjs:330`、`:159`；`python/image_worker.py:2036`），但 magpie 网关向 provider 重建请求体时，只带 `model`/`prompt`/`n`/`size`/`quality`/`background`/`output_format`/`complexity`（`internal/gateway/draw.go:1607-1625`、`:1636`）。

网关的 `drawingRead` 白名单（`internal/gateway/draw.go:619`）之外的字段会进 `d.Extra`，而 `d.Extra` **从不转发给 provider**——它只用于脱敏（`draw.go:743`）和检查 `layer_decomposition`（`draw.go:1034`）。

因此实测中帧数（9）与延时（180ms）全部由上游自行决定，插件收不到也无法指定。只有直接调用插件的 `/backend-api/codex/images/generations` 端点才可能用到这两个参数。

### 2. magpie-image MCP 的 `generate_image` 工具触发不到这个能力

该工具的请求体是固定构造的（`internal/imagemcp/imagemcp.go:464`），只含 `prompt`/`n`/`response_format`/`model`/`size`/`quality`/`complexity`/`background`，**不含 `output_format`**。经它调用永远不会进入插件的 GIF 分支。

要走通 GIF，需要直接打网关：

```bash
curl -X POST http://127.0.0.1:3425/v1/images/generations \
  -H "Authorization: Bearer magpie" \
  -H "Content-Type: application/json" \
  -d '{"model":"gptfree-pool/gpt-image-2.6","prompt":"...","n":1,"response_format":"b64","output_format":"gif"}'
```

## 四、对先前一次「GIF 无效」结论的更正

2026-11-10 早前曾得出「`output_format=gif` 在全部 5 个模型变体上无效、gpt-image-2.6 不具备 GIF 输出能力」的结论。**该结论不成立**，原因有二：

1. 那次探测走的是 magpie-image MCP 工具层，`output_format` 在工具层就被丢弃，从未发送到插件 —— 被测的是「工具不转发参数」，不是「插件不支持 GIF」。
2. 当时归因为「工具层硬编码 PNG 后缀」也不准确：落盘扩展名是按返回内容的真实 mime 决定的，且 `imageExt` 中含 `.gif`（`internal/imagemcp/imagemcp.go:757-782`）。当时 `.gif` 被改名 `.png`，恰恰说明上游返回的就是 PNG。

## 五、机制说明

插件本身没有 GIF 编码器（Python 侧仅标准库 + `curl_cffi`，无 Pillow），也**不本地合成动图**。其做法是：

1. 2.6 系模型映射为上游 `model="auto"`（`python/image_worker.py:84-92`），请求体不含任何 GIF/帧数字段；
2. `output_format=gif` 被转成中文提示词追加到 prompt 末尾（`python/image_worker.py:643-648`）：「生成格式为 gif 动图；输出真正的多帧动画，不要输出分镜拼图或静态帧。」，并附帧数/帧时长描述；
3. 上游 ChatGPT Web 依此产出真 GIF；
4. 下载后按字节 magic number 判定真实类型（`sniff_image_mime`，`python/image_worker.py:279-288`），不会把 PNG 伪装成 GIF。

即：**上游 ChatGPT Web 侧具备原生动图能力，插件的提示词引导能成功触发它**；插件自身的贡献是「模型白名单 + 提示词注入 + 真实格式判定」。

## 六、证据产物

保留在 `~/Documents/workspace/gptfree-gif-probe/`：

| 文件 | 说明 |
| --- | --- |
| `cat-2.6.gif` | 用例 A 产物，9 帧真 GIF |
| `cat-flare.gif` | 用例 C 产物，9 帧真 GIF |
| `cat-plain.png` | 用例 B 对照组，1212×1297 单帧 PNG |
| `resp-gif.json` / `resp-plain.json` / `resp-flare.json` | 三次请求的原始响应 |

解析脚本：`/tmp/gif-parser/gif_frames.py`（纯标准库 GIF 帧结构解析）。

## 七、附带状态变更

测试期间 provider `gptfree-pool` 处于关闭状态（`off: true`），无法被网关路由。测试通过 `magpie provider on gptfree-pool` 开启，**测完已用 `magpie provider off gptfree-pool` 恢复原状**（已核验 `providers.json` 中 `off = true`）。
