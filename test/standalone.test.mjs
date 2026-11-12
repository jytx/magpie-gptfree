import assert from "node:assert/strict";
import { test } from "node:test";
import { createStandaloneServer } from "../standalone/server.mjs";
import {
  createSseConverter, messageText, toChatCompletion, toResponsesRequest,
} from "../standalone/chat-compat.mjs";

/**
 * 起一个独立服务，跑完就关掉。
 *
 * @param {Function} fetchPool 假的上游请求函数
 * @param {string} apiKey 服务端密钥
 * @param {(base: string) => Promise<void>} run 测试主体
 * @returns {Promise<void>} 测试结束即完成
 */
async function withServer(fetchPool, apiKey, run) {
  const server = createStandaloneServer({ apiKey, fetchPool });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

/** 一个成功的 Responses 响应。 */
const RESPONSES_PAYLOAD = {
  id: "resp_1",
  object: "response",
  status: "completed",
  model: "gpt-5.6-luna",
  output: [{
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: "你好" }],
  }],
  usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
};

/**
 * 造一个只回固定 Responses 的上游。
 *
 * @returns {Function} 上游请求函数
 */
function jsonPool() {
  return async (_url, init) => {
    const body = JSON.parse(String(init?.body || "{}"));
    return new Response(JSON.stringify({ ...RESPONSES_PAYLOAD, model: body.model || RESPONSES_PAYLOAD.model }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

/**
 * 造一个流式 Responses 的上游。
 *
 * @returns {Function} 上游请求函数
 */
function streamPool() {
  const frames = [
    "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"你\"}\n\n",
    "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"好\"}\n\n",
    "event: response.completed\ndata: " + JSON.stringify({ type: "response.completed", response: RESPONSES_PAYLOAD }) + "\n\n",
  ];
  return async () => new Response(frames.join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

test("chat 请求转成 Responses：系统消息汇总为 instructions，其余进 input", () => {
  const body = toResponsesRequest({
    model: "gpt-5.6-luna",
    messages: [
      { role: "system", content: "你是助手" },
      { role: "user", content: "你好" },
      { role: "assistant", content: [{ type: "text", text: "在的" }] },
    ],
  });
  assert.equal(body.model, "gpt-5.6-luna");
  assert.equal(body.instructions, "你是助手");
  assert.equal(body.input.length, 2);
  assert.deepEqual(body.input[0], { role: "user", content: [{ type: "input_text", text: "你好" }] });
  assert.equal(body.input[1].role, "assistant");
  assert.equal(body.input[1].content[0].text, "在的");
});

test("消息内容压成纯文本：数组取各段 text", () => {
  assert.equal(messageText("直接"), "直接");
  assert.equal(messageText([{ type: "text", text: "一" }, { type: "text", text: "二" }]), "一二");
  assert.equal(messageText(null), "");
});

test("Responses 响应转成 chat.completion：正文、结束原因与用量口径", () => {
  const chat = toChatCompletion(RESPONSES_PAYLOAD, {
    id: "chatcmpl-x", created: 1, model: "gpt-5.6-luna",
  });
  assert.equal(chat.object, "chat.completion");
  assert.equal(chat.choices[0].message.content, "你好");
  assert.equal(chat.choices[0].finish_reason, "stop");
  assert.equal(chat.usage.prompt_tokens, 3);
  assert.equal(chat.usage.completion_tokens, 2);
  assert.equal(chat.usage.total_tokens, 5);
});

test("SSE 转换器按帧切开，帧边界落在中间也不丢内容", () => {
  const seen = [];
  const converter = createSseConverter((event, data) => seen.push([event, data.delta]));
  converter.push('event: response.output_text.delta\ndata: {"delta":"你"}');
  converter.push('\n\nevent: response.output_text.delta\ndata: {"delta":"好"}\n\n');
  converter.end();
  assert.deepEqual(seen, [
    ["response.output_text.delta", "你"],
    ["response.output_text.delta", "好"],
  ]);
});

test("独立服务的模型列表同时有文本模型与图片模型", async () => {
  await withServer(jsonPool(), "k", async (base) => {
    const response = await fetch(base + "/v1/models", { headers: { Authorization: "Bearer k" } });
    assert.equal(response.status, 200);
    const payload = await response.json();
    const ids = payload.data.map((m) => m.id);
    assert(ids.includes("gpt-5.6-luna"));
    assert(ids.includes("gpt-image-2.6"));
  });
});

test("独立服务校验密钥，缺密钥时拒绝", async () => {
  await withServer(jsonPool(), "secret", async (base) => {
    const denied = await fetch(base + "/v1/models");
    assert.equal(denied.status, 401);
    const wrong = await fetch(base + "/v1/models", { headers: { Authorization: "Bearer nope" } });
    assert.equal(wrong.status, 401);
    const ok = await fetch(base + "/v1/models", { headers: { Authorization: "Bearer secret" } });
    assert.equal(ok.status, 200);
  });
});

test("chat/completions 非流式：返回 chat.completion", async () => {
  await withServer(jsonPool(), "", async (base) => {
    const response = await fetch(base + "/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.6-luna", messages: [{ role: "user", content: "你好" }] }),
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.object, "chat.completion");
    assert.equal(payload.choices[0].message.content, "你好");
    assert.equal(payload.usage.total_tokens, 5);
  });
});

test("chat/completions 流式：逐帧转成 chat.completion.chunk 并以 [DONE] 收尾", async () => {
  await withServer(streamPool(), "", async (base) => {
    const response = await fetch(base + "/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.6-luna",
        messages: [{ role: "user", content: "你好" }],
        stream: true,
      }),
    });
    assert.equal(response.status, 200);
    const text = await response.text();
    const frames = text.split("\n\n").filter((f) => f.startsWith("data: "));
    const done = frames.at(-1);
    const chunks = frames.slice(0, -1)
      .map((f) => JSON.parse(f.slice(6)))
      .filter((d) => d.object === "chat.completion.chunk");
    assert.equal(chunks[0].choices[0].delta.role, "assistant");
    assert.equal(chunks[1].choices[0].delta.content, "你");
    assert.equal(chunks[2].choices[0].delta.content, "好");
    assert.equal(chunks[3].choices[0].finish_reason, "stop");
    assert.equal(chunks[3].usage.total_tokens, 5);
    assert(done.includes("[DONE]"));
  });
});

test("responses 端点原样透传上游的 Responses 载荷", async () => {
  await withServer(jsonPool(), "", async (base) => {
    const response = await fetch(base + "/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.6-luna", input: "你好" }),
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.object, "response");
    assert.equal(payload.output[0].content[0].text, "你好");
  });
});
