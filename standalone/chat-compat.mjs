/**
 * OpenAI Chat Completions 与 Responses 两套协议之间的纯转换。
 *
 * 号池的上游（ChatGPT Web / Codex）只讲 Responses 协议，而大量第三方软件
 * 只讲 Chat Completions。这个模块负责两个方向：
 *   - 请求：messages → Responses 的 input / instructions；
 *   - 响应：Responses 的 JSON 与 SSE 事件流 → Chat Completions 的 JSON 与 SSE。
 *
 * 这里的函数都是纯函数：不碰网络、不读环境、不改入参，方便单测。
 */

/**
 * @typedef {Object} ChatMessage
 * @property {string} role 角色（system / developer / user / assistant / tool）
 * @property {string|Array<{type?: string, text?: string}>} content 消息内容
 */

/**
 * @typedef {Object} ChatRequest
 * @property {string} model 模型名
 * @property {ChatMessage[]} messages 消息列表
 * @property {boolean} [stream] 是否流式
 */

/**
 * @typedef {Object} ResponsesRequest
 * @property {string} model 模型名
 * @property {Array<{role: string, content: Array<{type: string, text: string}>}>} input 输入项
 * @property {string} [instructions] 汇总后的系统提示
 * @property {boolean} [stream] 是否流式
 */

/** 系统类角色：单独汇总为 instructions，其余角色原样转成 input 项。 */
const SYSTEM_ROLES = new Set(["system", "developer"]);

/**
 * 把一条消息的内容压成纯文本：字符串直接用，数组则把各段 text 拼起来。
 *
 * @param {unknown} content 消息内容
 * @returns {string} 纯文本内容
 */
export function messageText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const part of content) {
    if (typeof part === "string") { parts.push(part); continue; }
    if (!part || typeof part !== "object") continue;
    const text = typeof part.text === "string" ? part.text : "";
    if (text) parts.push(text);
  }
  return parts.join("");
}

/**
 * 把 Chat Completions 的请求体转成 Responses 的请求体。
 *
 * system / developer 消息合并为 instructions，其余按 user / assistant 转成 input 项；
 * content 一律用 input_text 数组，两条上游路径都认这种形状。
 *
 * @param {ChatRequest} request 客户端发来的 chat 请求
 * @returns {ResponsesRequest} Responses 请求体
 */
export function toResponsesRequest(request) {
  const messages = Array.isArray(request?.messages) ? request.messages : [];
  const systemParts = [];
  const input = [];
  for (const message of messages) {
    const role = String(message?.role || "user").toLowerCase();
    const text = messageText(message?.content);
    if (!text) continue;
    if (SYSTEM_ROLES.has(role)) { systemParts.push(text); continue; }
    input.push({
      role: role === "assistant" ? "assistant" : "user",
      content: [{ type: "input_text", text }],
    });
  }
  const body = {
    model: String(request?.model || ""),
    input,
  };
  if (systemParts.length) body.instructions = systemParts.join("\n\n");
  if (request?.stream === true) body.stream = true;
  return body;
}

/**
 * 从 Responses 的 JSON 里取出助手的正文。
 *
 * @param {any} responses Responses 响应对象
 * @returns {string} 助手正文
 */
export function responsesText(responses) {
  const output = Array.isArray(responses?.output) ? responses.output : [];
  const parts = [];
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const content = Array.isArray(item.content) ? item.content : [];
    for (const part of content) {
      if (part?.type === "output_text" && typeof part.text === "string") parts.push(part.text);
    }
  }
  return parts.join("");
}

/**
 * Responses 的结束原因换成 Chat Completions 的说法。
 *
 * @param {any} responses Responses 响应对象
 * @returns {string} finish_reason
 */
export function responsesFinishReason(responses) {
  if (responses?.status === "incomplete") return "length";
  if (responses?.status === "failed" || responses?.status === "cancelled") return "stop";
  return "stop";
}

/**
 * Responses 的 usage 换成 Chat Completions 的口径。
 *
 * @param {any} responses Responses 响应对象
 * @returns {{prompt_tokens: number, completion_tokens: number, total_tokens: number}} usage
 */
export function toChatUsage(responses) {
  const usage = responses?.usage && typeof responses.usage === "object" ? responses.usage : {};
  const prompt = Number(usage.input_tokens) || 0;
  const completion = Number(usage.output_tokens) || 0;
  const total = Number(usage.total_tokens) || (prompt + completion);
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: total };
}

/**
 * 把 Responses 的 JSON 响应转成 Chat Completions 的响应。
 *
 * @param {any} responses Responses 响应对象
 * @param {{model: string, id: string, created: number}} meta 本次响应的元信息
 * @returns {any} chat.completion 对象
 */
export function toChatCompletion(responses, meta) {
  const text = responsesText(responses);
  return {
    id: meta.id,
    object: "chat.completion",
    created: meta.created,
    model: meta.model,
    choices: [{
      index: 0,
      message: { role: "assistant", content: text },
      finish_reason: responsesFinishReason(responses),
    }],
    usage: toChatUsage(responses),
  };
}

/**
 * 造一个 Chat Completions 的流式分片。
 *
 * @param {{id: string, created: number, model: string}} meta 本次响应的元信息
 * @param {string|null} delta 增量文本
 * @param {string|null} finishReason 结束原因
 * @param {{prompt_tokens: number, completion_tokens: number, total_tokens: number}|null} usage 用量
 * @returns {any} chat.completion.chunk 对象
 */
export function toChatChunk(meta, delta, finishReason, usage) {
  const chunk = {
    id: meta.id,
    object: "chat.completion.chunk",
    created: meta.created,
    model: meta.model,
    choices: [{ index: 0, delta: delta === null ? {} : { content: delta }, finish_reason: finishReason }],
  };
  if (usage) chunk.usage = usage;
  return chunk;
}

/**
 * 把 Responses 的一条 SSE 帧转成 Chat Completions 的分片；没有可转的内容时返回 null。
 *
 * @param {string} event 事件名
 * @param {any} data 事件数据
 * @param {{id: string, created: number, model: string}} meta 本次响应的元信息
 * @returns {any} chat.completion.chunk 对象
 */
export function toChatChunkFromEvent(event, data, meta) {
  if (event === "response.output_text.delta") {
    const delta = typeof data?.delta === "string" ? data.delta : "";
    if (!delta) return null;
    return toChatChunk(meta, delta, null, null);
  }
  if (event === "response.completed" || event === "response.incomplete") {
    const response = data?.response && typeof data.response === "object" ? data.response : {};
    return toChatChunk(meta, null, responsesFinishReason(response), toChatUsage(response));
  }
  return null;
}

/**
 * 造一个只带角色的首个流式分片：客户端靠它知道助手开始回答了。
 *
 * @param {{id: string, created: number, model: string}} meta 本次响应的元信息
 * @returns {any} chat.completion.chunk 对象
 */
export function toChatRoleChunk(meta) {
  return {
    id: meta.id,
    object: "chat.completion.chunk",
    created: meta.created,
    model: meta.model,
    choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
  };
}

/**
 * 造一个 SSE 帧。
 *
 * @param {any} data 帧里的 JSON 数据
 * @returns {string} SSE 帧文本
 */
export function toSseFrame(data) {
  return `data: ${JSON.stringify(data)}\n\n`;
}

/**
 * 建一个把上游 SSE 文本流转成 Chat Completions 分片的转换器。
 *
 * 上游是一段段到达的，帧边界可能落在中间，所以要按帧缓存、等齐了再转。
 *
 * @param {(event: string, data: any) => void} onFrame 每转出一帧就调用一次
 * @returns {{push: (text: string) => void, end: () => void}} 转换器
 */
export function createSseConverter(onFrame) {
  let buffer = "";
  const emit = (frame) => {
    if (!frame.trim()) return;
    let event = "message";
    const dataLines = [];
    for (const line of frame.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }
    const raw = dataLines.join("\n");
    if (!raw || raw === "[DONE]") return;
    let data = null;
    try { data = JSON.parse(raw); } catch { return; }
    onFrame(event, data);
  };
  return {
    push(text) {
      buffer += String(text || "");
      let index = buffer.indexOf("\n\n");
      while (index >= 0) {
        const frame = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        emit(frame);
        index = buffer.indexOf("\n\n");
      }
    },
    end() {
      if (buffer.trim()) emit(buffer);
      buffer = "";
    },
  };
}
