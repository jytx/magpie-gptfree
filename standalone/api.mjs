/**
 * 独立服务的接口实现：路由分发、鉴权与各端点的处理。
 *
 * 与 server.mjs 分开是为了让文件各司其职：这里只管「一个请求该怎么答」，
 * 建服务与启动在 server.mjs。
 */
import { timingSafeEqual } from "node:crypto";
import { CODEX_BASE } from "../lib/codex-pool.mjs";
import { buildImageModelCatalog } from "../lib/chatgpt-web-image.mjs";
import { buildWebTextModelCatalog } from "../lib/chatgpt-web-text.mjs";
import {
  createSseConverter, toChatChunk, toChatChunkFromEvent, toChatCompletion,
  toChatRoleChunk, toResponsesRequest, toSseFrame,
} from "./chat-compat.mjs";

/** 上游响应里不该照抄的头：fetch 已解压正文，长度与编码都变了。 */
const SKIPPED_RESPONSE_HEADERS = new Set([
  "content-encoding", "content-length", "transfer-encoding", "connection",
]);

/**
 * 模型目录：文本模型来自 ChatGPT Web 会话接口，图片模型来自 codex 图片接口。
 *
 * @returns {{object: string, data: any[]}} OpenAI 风格的模型列表
 */
export function buildModelList() {
  const catalog = {
    ...buildWebTextModelCatalog(CODEX_BASE),
    ...buildImageModelCatalog(CODEX_BASE),
  };
  const created = Math.floor(Date.now() / 1000);
  return {
    object: "list",
    data: Object.values(catalog).map((model) => ({
      id: model.id,
      object: "model",
      created,
      owned_by: "gptfree-pool",
    })),
  };
}

/**
 * 比较请求带来的密钥与服务端的密钥。
 *
 * @param {string} given 请求带来的密钥
 * @param {string} expected 服务端的密钥
 * @returns {boolean} 是否一致
 */
function keyMatches(given, expected) {
  const a = Buffer.from(String(given || ""));
  const b = Buffer.from(String(expected || ""));
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

/**
 * 取出请求里的密钥：Bearer 头或 x-api-key 头。
 *
 * @param {any} req Node 的请求对象
 * @returns {string} 密钥文本
 */
function requestKey(req) {
  const header = String(req.headers?.authorization || "");
  if (header.toLowerCase().startsWith("bearer ")) return header.slice(7).trim();
  return String(req.headers?.["x-api-key"] || "").trim();
}

/**
 * 读出请求的原始正文。
 *
 * @param {any} req Node 的请求对象
 * @returns {Promise<Buffer>} 正文
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/**
 * 回一个 JSON 错误。
 *
 * @param {any} res Node 的响应对象
 * @param {number} status HTTP 状态码
 * @param {string} message 错误信息
 * @param {string} [type] 错误类型
 * @returns {void}
 */
function sendError(res, status, message, type) {
  const body = JSON.stringify({ error: { message, type: type || "invalid_request_error" } });
  res.writeHead(status, { "content-type": "application/json" });
  res.end(body);
}

/**
 * 把上游的 Response 原样转给客户端（流式也照旧）。
 *
 * @param {any} res Node 的响应对象
 * @param {Response} upstream 上游响应
 * @returns {Promise<void>} 转完即结束
 */
async function pipeUpstream(res, upstream) {
  const headers = {};
  upstream.headers.forEach((value, key) => {
    if (!SKIPPED_RESPONSE_HEADERS.has(key.toLowerCase())) headers[key] = value;
  });
  res.writeHead(upstream.status, headers);
  if (!upstream.body) { res.end(); return; }
  for await (const chunk of upstream.body) res.write(Buffer.from(chunk));
  res.end();
}

/**
 * 本次 Chat Completions 响应的元信息。
 *
 * @param {string} model 客户端要的模型名
 * @returns {{id: string, created: number, model: string}} 元信息
 */
function chatMeta(model) {
  return {
    id: "chatcmpl-" + Math.random().toString(16).slice(2, 10) + Date.now().toString(16),
    created: Math.floor(Date.now() / 1000),
    model: String(model || ""),
  };
}

/**
 * 建接口处理函数。
 *
 * @param {{apiKey: string, fetchPool: Function}} options 依赖：密钥与取号池请求的函数
 * @returns {(req: any, res: any) => Promise<void>} 处理函数
 */
export function createApiHandler(options) {
  const apiKey = String(options?.apiKey || "");
  const fetchPool = options?.fetchPool;

  /**
   * 把请求交给号池，并把上游路径按端点对上。
   *
   * @param {any} req Node 的请求对象
   * @param {any} res Node 的响应对象
   * @param {string} upstreamPath 上游路径（codex 接口）
   * @param {Buffer} body 请求正文
   * @returns {Promise<void>} 转完即结束
   */
  const forward = async (req, res, upstreamPath, body) => {
    const upstream = await fetchPool(CODEX_BASE + upstreamPath, {
      body,
      headers: { "content-type": String(req.headers["content-type"] || "application/json") },
      signal: req.abortSignal,
    });
    await pipeUpstream(res, upstream);
  };

  /**
   * Chat Completions：请求转 Responses，响应（含流式）转回 Chat Completions。
   *
   * @param {any} req Node 的请求对象
   * @param {any} res Node 的响应对象
   * @returns {Promise<void>} 转完即结束
   */
  const chatCompletions = async (req, res) => {
    let parsed = null;
    try { parsed = JSON.parse((await readBody(req)).toString("utf8")); }
    catch { sendError(res, 400, "请求正文不是合法 JSON"); return; }

    const upstream = await fetchPool(CODEX_BASE + "/responses", {
      body: JSON.stringify(toResponsesRequest(parsed)),
      headers: { "content-type": "application/json" },
      signal: req.abortSignal,
    });
    if (!upstream.ok) { await pipeUpstream(res, upstream); return; }

    const meta = chatMeta(parsed?.model);
    if (parsed?.stream !== true) {
      const payload = await upstream.json();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(toChatCompletion(payload, meta)));
      return;
    }

    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.write(toSseFrame(toChatRoleChunk(meta)));
    const decoder = new TextDecoder();
    const converter = createSseConverter((event, data) => {
      const chunk = toChatChunkFromEvent(event, data, meta);
      if (chunk) res.write(toSseFrame(chunk));
    });
    for await (const chunk of upstream.body) converter.push(decoder.decode(chunk, { stream: true }));
    converter.end();
    res.write("data: [DONE]\n\n");
    res.end();
  };

  /**
   * 一个请求的路由分发。
   *
   * @param {any} req Node 的请求对象
   * @param {any} res Node 的响应对象
   * @returns {Promise<void>} 转完即结束
   */
  return async (req, res) => {
    // 客户端断开时把上游请求一并取消，别让号池继续跑没人要的回答。
    const controller = new AbortController();
    req.abortSignal = controller.signal;
    req.on("aborted", () => controller.abort());
    res.on("close", () => { if (!res.writableEnded) controller.abort(); });

    if (apiKey && !keyMatches(requestKey(req), apiKey)) {
      sendError(res, 401, "缺少或错误的 API 密钥", "authentication_error");
      return;
    }
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const route = `${req.method} ${url.pathname}`;
    if (route === "GET /health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }
    if (route === "GET /v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(buildModelList()));
      return;
    }
    if (route === "POST /v1/responses") {
      await forward(req, res, "/responses", await readBody(req));
      return;
    }
    if (route === "POST /v1/images/generations") {
      await forward(req, res, "/images/generations", await readBody(req));
      return;
    }
    if (route === "POST /v1/images/edits") {
      await forward(req, res, "/images/edits", await readBody(req));
      return;
    }
    if (route === "POST /v1/chat/completions") {
      await chatCompletions(req, res);
      return;
    }
    sendError(res, 404, `没有这个接口：${route}`);
  };
}
