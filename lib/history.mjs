/**
 * 生图历史：把每次生成的图片与提示词落到本地，供插件页面与独立服务查看。
 *
 * 落在号池目录旁边（~/.magpie-gptfree/history/），插件与独立服务共用一份：
 *   - history.json   元数据索引，最多 500 条，按时间倒序
 *   - images/        图片原图，按 id 命名
 *
 * 写历史是尽力而为：失败只少一条记录，不该让已经生成的图丢掉。
 */
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { poolDir } from "./pool-vault.mjs";

/** 历史目录在号池目录下的名字。 */
const HISTORY_DIR = "history";

/** 索引文件名（放在历史目录里，与图片同层）。 */
const INDEX_FILE = "history.json";

/** 图片子目录名。 */
const IMAGES_DIR = "images";

/** 索引格式版本。 */
const FORMAT = 1;

/** 最多保留多少条记录。 */
export const MAX_ENTRIES = 500;

/** 图片总字节上限，超了从最旧的开始删。 */
export const MAX_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * 历史目录的路径。
 *
 * @returns {string} 绝对路径
 */
export function historyDir() {
  return join(poolDir(), HISTORY_DIR);
}

/**
 * 账号脱敏：只留前缀与域名，足够认出是哪个账号，不泄露完整地址。
 *
 * @param {unknown} email 账号邮箱
 * @returns {string} 脱敏后的账号
 */
export function maskEmail(email) {
  const text = String(email || "").trim();
  const at = text.indexOf("@");
  if (at <= 0) return "";
  return text.slice(0, 2) + "***" + text.slice(at);
}

/**
 * 按 MIME 猜图片的扩展名。
 *
 * @param {string} mimeType MIME 类型
 * @returns {string} 扩展名（不含点）
 */
export function imageExtension(mimeType) {
  const mime = String(mimeType || "").toLowerCase();
  if (mime.includes("jpeg") || mime.includes("jpg")) return "jpg";
  if (mime.includes("webp")) return "webp";
  if (mime.includes("gif")) return "gif";
  return "png";
}

/**
 * 生成一条记录的 id：时间戳便于排序，随机后缀避免同毫秒相撞。
 *
 * @param {number} at 生成时刻（毫秒）
 * @returns {string} 记录 id
 */
export function historyId(at) {
  const stamp = new Date(at).toISOString().replace(/[-:]/g, "").replace(/\..+/, "");
  return stamp + "-" + randomBytes(3).toString("hex");
}

/**
 * 从生图结果的一项里取出图片数据。
 *
 * 不按键名取：结果里的图片字段名是实现细节（worker 那边叫 b64_json 一类），
 * 按值取更稳——认的是「解码后确实是张图片」。
 *
 * @param {any} item 结果里的一项
 * @returns {string} 图片的 base64，取不到时为空
 */
export function imageDataOf(item) {
  if (!item || typeof item !== "object") return "";
  for (const value of Object.values(item)) {
    if (typeof value !== "string" || value.length < 32) continue;
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) continue;
    let head = "";
    try { head = Buffer.from(value.slice(0, 16), "base64").toString("latin1"); } catch { continue; }
    const isImage = head.startsWith("\x89PNG") || head.startsWith("\xff\xd8\xff") ||
      head.startsWith("GIF8") || (head.startsWith("RIFF") && head.slice(8, 12) === "WEBP");
    if (isImage) return value;
  }
  return "";
}

/**
 * 从生图结果的一项里取出图片的 MIME 类型。
 *
 * @param {any} item 结果里的一项
 * @returns {string} MIME 类型，取不到时按 PNG 算
 */
export function imageMimeOf(item) {
  for (const value of Object.values(item || {})) {
    if (typeof value === "string" && value.startsWith("image/")) return value;
  }
  return "image/png";
}

/**
 * 把这次请求整理成一份可读、可复制的报文。
 *
 * 请求里的输入图是 base64，太大也不该进索引：它们已经落盘了，报文里只留
 * 文件引用（files/… 与大小），看得懂也复制得走。
 *
 * @param {any} request 解析后的请求
 * @param {any[]} inputs 落盘后的输入图
 * @returns {string} JSON 报文
 */
export function buildRequestText(request, inputs) {
  if (!request || typeof request !== "object") return "";
  const body = { ...request };
  const byRole = { image: [], mask: [] };
  for (const input of inputs || []) {
    const role = input?.role === "mask" ? "mask" : "image";
    byRole[role].push({
      file: input.file,
      mimeType: input.mimeType,
      filename: input.filename || "",
      bytes: input.bytes,
    });
  }
  if (Array.isArray(body.images) && byRole.image.length) body.images = byRole.image;
  if (Array.isArray(body.masks) && byRole.mask.length) body.masks = byRole.mask;
  for (const key of Object.keys(body)) {
    if (body[key] === undefined) delete body[key];
  }
  try { return JSON.stringify(body, null, 2); } catch { return ""; }
}

/**
 * 记一次生图到历史：把结果里的图片取出来，元信息一起记下。
 *
 * @param {any} store 历史存储（createHistoryStore 的返回值）
 * @param {any} entry 这次生图的信息：结果、请求、账号、耗时、来源
 * @returns {Promise<any|null>} 记下的记录，没有图片时为 null
 */
export async function recordImageTask(store, entry) {
  if (!store || typeof store.record !== "function") return null;
  const data = Array.isArray(entry?.result?.data) ? entry.result.data : [];
  const images = [];
  for (const item of data) {
    const b64 = imageDataOf(item);
    if (!b64) continue;
    images.push({ b64, mimeType: imageMimeOf(item) });
  }
  if (!images.length) return null;
  const first = data[0] || {};
  // 编辑图带原图（还有蒙版）：一并记下来，报文里只留文件引用
  const request = entry?.request && typeof entry.request === "object" ? entry.request : {};
  const inputs = [];
  for (const [role, field] of [["image", "images"], ["mask", "masks"]]) {
    const list = Array.isArray(request[field]) ? request[field] : [];
    for (const item of list) {
      const b64 = typeof item?.b64 === "string" ? item.b64 : "";
      if (!b64) continue;
      inputs.push({
        b64,
        mimeType: item?.mime_type || "image/png",
        filename: item?.filename || "",
        role,
      });
    }
  }
  return store.record({
    at: entry?.at,
    kind: inputs.length ? "edit" : "generate",
    model: request.model,
    prompt: request.prompt,
    revisedPrompt: first?.revised_prompt,
    size: request.size,
    outputFormat: request.output_format,
    account: entry?.account,
    durationMs: entry?.durationMs,
    source: entry?.source,
    status: "ok",
    request,
    inputs,
    images,
  });
}

/**
 * 从请求头猜出这次请求来自哪个客户端。
 *
 * 只有独立服务能拿到：它自己收 HTTP 请求，User-Agent 就在手里。经 Magpie
 * 网关转来的请求，宿主不把客户端的头转发给插件（internal/gateway/user_agent.go
 * 里账号型 provider 直接跳过），所以那条路上只能记成 "magpie"。
 *
 * @param {any} headers 请求头
 * @returns {string} 客户端标识
 */
export function sourceFromHeaders(headers) {
  const ua = String(headers?.["user-agent"] || "").trim();
  if (!ua) return "";
  const name = ua.split(/[/\s]/)[0].trim();
  return name || ua.slice(0, 40);
}

/**
 * 建一个历史存储。
 *
 * @param {{dir: string, maxEntries: number, maxBytes: number}} options 存储的位置与上限
 * @returns {{record: Function, list: Function, get: Function, remove: Function, clear: Function, stats: Function}} 存储
 */
export function createHistoryStore(options) {
  const dir = options?.dir || historyDir();
  const maxEntries = Number(options?.maxEntries) || MAX_ENTRIES;
  const maxBytes = Number(options?.maxBytes) || MAX_BYTES;
  const imagesDir = join(dir, IMAGES_DIR);
  const indexPath = join(dir, INDEX_FILE);

  // 索引的写入串行化：几次请求同时落盘时，一个一个来，不互相覆盖
  let queue = Promise.resolve();

  /**
   * 读索引。
   *
   * @returns {Promise<{version: number, entries: any[]}>} 索引
   */
  async function readIndex() {
    let parsed = null;
    try { parsed = JSON.parse(await readFile(indexPath, "utf8")); }
    catch { return { version: FORMAT, entries: [] }; }
    const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
    return { version: FORMAT, entries };
  }

  /**
   * 写索引（原子写：临时文件 + 改名）。
   *
   * @param {{version: number, entries: any[]}} index 索引
   * @returns {Promise<void>} 写完即结束
   */
  async function writeIndex(index) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const tmp = indexPath + "." + randomBytes(6).toString("hex") + ".tmp";
    try {
      await writeFile(tmp, JSON.stringify(index, null, 2), { mode: 0o600 });
      await rename(tmp, indexPath);
    } finally {
      await rm(tmp, { force: true }).catch(() => {});
    }
  }

  /**
   * 删掉一条记录的图片文件。
   *
   * @param {any} entry 记录
   * @returns {Promise<void>} 删完即结束
   */
  async function removeFiles(entry) {
    const files = [
      ...(Array.isArray(entry?.images) ? entry.images : []),
      ...(Array.isArray(entry?.inputs) ? entry.inputs : []),
    ];
    for (const image of files) {
      if (typeof image?.file !== "string" || !image.file) continue;
      await rm(join(dir, image.file), { force: true }).catch(() => {});
    }
  }

  /**
   * 统计索引里记着的总字节。
   *
   * @param {any[]} entries 记录列表
   * @returns {number} 字节数
   */
  function totalBytes(entries) {
    let bytes = 0;
    for (const entry of entries) {
      for (const image of entry?.images || []) bytes += Number(image?.bytes) || 0;
    }
    return bytes;
  }

  /**
   * 超出上限时从最旧的开始删（连带图片文件）。
   *
   * @param {any[]} entries 记录列表
   * @returns {Promise<any[]>} 裁剪后的记录列表
   */
  async function prune(entries) {
    const kept = [...entries];
    while (kept.length > maxEntries) {
      const dropped = kept.pop();
      await removeFiles(dropped);
    }
    let bytes = totalBytes(kept);
    while (kept.length && bytes > maxBytes) {
      // kept 的头是最新的一条，尾是最旧的；超了字节就从最旧的开始丢
      const dropped = kept.pop();
      await removeFiles(dropped);
      bytes = totalBytes(kept);
    }
    return kept;
  }

  /**
   * 记一次生图：图片落盘，元数据进索引。
   *
   * @param {any} entry 这次生图的元信息
   * @returns {Promise<any|null>} 记下的记录，失败时为 null
   */
  function record(entry) {
    const work = async () => {
      const at = Number(entry?.at) || Date.now();
      const id = historyId(at);
      const images = [];
      const list = Array.isArray(entry?.images) ? entry.images : [];
      await mkdir(imagesDir, { recursive: true, mode: 0o700 });
      for (let i = 0; i < list.length; i++) {
        const image = list[i];
        if (!image || typeof image.b64 !== "string" || !image.b64) continue;
        const ext = imageExtension(image.mimeType);
        const file = join(IMAGES_DIR, id + "-" + (i + 1) + "." + ext);
        const buf = Buffer.from(image.b64, "base64");
        await writeFile(join(dir, file), buf, { mode: 0o600 });
        images.push({ file, mimeType: image.mimeType || "image/png", bytes: buf.length });
      }
      // 输入图（编辑图的那张原图与蒙版）：也落盘，报文里只留文件引用
      const inputs = [];
      const inputList = Array.isArray(entry?.inputs) ? entry.inputs : [];
      for (let i = 0; i < inputList.length; i++) {
        const input = inputList[i];
        if (!input || typeof input.b64 !== "string" || !input.b64) continue;
        const ext = imageExtension(input.mimeType);
        const file = join(IMAGES_DIR, id + "-in-" + (i + 1) + "." + ext);
        const buf = Buffer.from(input.b64, "base64");
        await writeFile(join(dir, file), buf, { mode: 0o600 });
        inputs.push({
          file,
          mimeType: input.mimeType || "image/png",
          bytes: buf.length,
          filename: String(input.filename || ""),
          role: String(input.role || "image"),
        });
      }
      const record = {
        id,
        at: new Date(at).toISOString(),
        kind: String(entry?.kind || (inputs.length ? "edit" : "generate")),
        model: String(entry?.model || ""),
        prompt: String(entry?.prompt || ""),
        revisedPrompt: String(entry?.revisedPrompt || ""),
        size: String(entry?.size || ""),
        outputFormat: String(entry?.outputFormat || ""),
        account: maskEmail(entry?.account),
        durationMs: Number(entry?.durationMs) || 0,
        source: String(entry?.source || ""),
        status: String(entry?.status || "ok"),
        request: buildRequestText(entry?.request, inputs),
        inputs,
        images,
      };
      const index = await readIndex();
      const entries = await prune([record, ...index.entries]);
      await writeIndex({ version: FORMAT, entries });
      return record;
    };
    queue = queue.then(work, work);
    return queue.catch(() => null);
  }

  /**
   * 列出记录（不含图片内容）。
   *
   * @param {{limit: number}} options 取多少条
   * @returns {Promise<any[]>} 记录列表，新的在前
   */
  async function list(options) {
    const limit = Number(options?.limit) || 50;
    const index = await readIndex();
    return index.entries.slice(0, Math.max(0, limit));
  }

  /**
   * 取一条记录，连同图片的 base64。
   *
   * @param {string} id 记录 id
   * @returns {Promise<any|null>} 记录与图片，没有则为 null
   */
  async function get(id) {
    const index = await readIndex();
    const entry = index.entries.find((e) => e?.id === id);
    if (!entry) return null;
    const images = [];
    for (const image of entry.images || []) {
      try {
        const buf = await readFile(join(dir, image.file));
        images.push({ mimeType: image.mimeType, bytes: buf.length, b64: buf.toString("base64") });
      } catch {
        images.push({ mimeType: image.mimeType, bytes: 0, b64: "" });
      }
    }
    // 输入图（编辑图的原图与蒙版）也读出来，页面要看
    const inputs = [];
    for (const input of entry.inputs || []) {
      try {
        const buf = await readFile(join(dir, input.file));
        inputs.push({ ...input, b64: buf.toString("base64") });
      } catch {
        inputs.push({ ...input, b64: "" });
      }
    }
    return { ...entry, images, inputs };
  }

  /**
   * 删一条记录（连带图片文件）。
   *
   * @param {string} id 记录 id
   * @returns {Promise<boolean>} 是否删掉了
   */
  async function remove(id) {
    const index = await readIndex();
    const entries = index.entries.filter((e) => e?.id !== id);
    if (entries.length === index.entries.length) return false;
    await removeFiles(index.entries.find((e) => e?.id === id));
    await writeIndex({ version: FORMAT, entries });
    return true;
  }

  /**
   * 清空全部记录与图片。
   *
   * @returns {Promise<void>} 清完即结束
   */
  async function clear() {
    await writeIndex({ version: FORMAT, entries: [] });
    await rm(imagesDir, { recursive: true, force: true }).catch(() => {});
  }

  /**
   * 历史占了多少地方。
   *
   * @returns {Promise<{count: number, bytes: number}>} 条数与字节数
   */
  async function stats() {
    const index = await readIndex();
    let bytes = 0;
    for (const image of index.entries.flatMap((e) => e?.images || [])) {
      bytes += Number(image?.bytes) || 0;
    }
    return { count: index.entries.length, bytes };
  }

  return { record, list, get, remove, clear, stats };
}
