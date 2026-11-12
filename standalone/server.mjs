/**
 * 脱离 Magpie 的独立 HTTP 服务：把本地号池直接暴露成 OpenAI 兼容接口。
 *
 * 插件在 Magpie 里时，号池是 Magpie 的一个 provider，请求经 Magpie 的网关转发；
 * 这个服务做的是同一件事，只是不再需要 Magpie 在场：
 *   - 号池的选号、失败换号、令牌续期、图片额度统计，都复用插件 lib/ 里的现成实现；
 *   - 文本走 Codex /responses 或 ChatGPT Web 会话接口，图片走 codex 图片接口。
 *
 * 对外提供：
 *   GET  /v1/models             模型列表
 *   POST /v1/responses          Responses 协议（原样透传上游）
 *   POST /v1/chat/completions   Chat Completions 协议（这里做协议转换）
 *   POST /v1/images/generations 生图
 *   POST /v1/images/edits       局部重绘
 *   GET  /health                健康检查
 *
 * 鉴权用 Bearer 密钥；密钥从环境变量 GPTFREE_API_KEY 读，不设置时自动生成并打印。
 * 用法见 standalone/README.md。
 */
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { poolFetch } from "../lib/codex-pool.mjs";
import { poolDir } from "../lib/pool-vault.mjs";
import { createApiHandler } from "./api.mjs";

/** 默认监听端口，与插件自己的 GUI 服务（37986）分开。 */
export const DEFAULT_PORT = 38080;

/** 默认只监听本机；要给局域网用，设 GPTFREE_HOST=0.0.0.0 并务必设置密钥。 */
export const DEFAULT_HOST = "127.0.0.1";

/**
 * 建这个 HTTP 服务。
 *
 * @param {{apiKey: string, fetchPool: Function}} options 依赖：密钥与取号池请求的函数
 * @returns {import("node:http").Server} Node 的 HTTP 服务
 */
export function createStandaloneServer(options) {
  const handler = createApiHandler({
    apiKey: String(options?.apiKey || ""),
    fetchPool: options?.fetchPool || poolFetch,
  });
  return createServer((req, res) => {
    handler(req, res).catch((error) => {
      if (res.headersSent) { res.end(); return; }
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({
        error: { message: String(error?.message || error), type: "server_error" },
      }));
    });
  });
}

/**
 * 按环境变量起服务：GPTFREE_API_KEY（密钥）、GPTFREE_PORT（端口）、GPTFREE_HOST（监听地址）。
 *
 * @returns {Promise<{server: import("node:http").Server, port: number, apiKey: string}>} 服务信息
 */
export async function startStandaloneServer() {
  const apiKey = String(process.env.GPTFREE_API_KEY || "").trim() || randomBytes(16).toString("hex");
  const port = Number(process.env.GPTFREE_PORT || DEFAULT_PORT);
  const host = String(process.env.GPTFREE_HOST || DEFAULT_HOST);
  const server = createStandaloneServer({ apiKey });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  const actualPort = address && typeof address === "object" ? address.port : port;
  console.log(`GPT号池 独立服务已启动：http://${host}:${actualPort}/v1`);
  console.log(`API 密钥：${apiKey}`);
  console.log("号池目录：" + poolDir());
  return { server, port: actualPort, apiKey };
}

/**
 * 直接运行时起服务：node standalone/server.mjs
 *
 * @returns {Promise<void>} 服务结束时结束
 */
async function main() {
  await startStandaloneServer();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error("GPT号池 独立服务启动失败：" + String(error?.message || error));
    process.exit(1);
  });
}
