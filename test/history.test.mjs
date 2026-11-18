import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHistoryStore, imageExtension, maskEmail, recordImageTask, sourceFromHeaders } from "../lib/history.mjs";
import { createGuiService } from "../lib/gui-service.mjs";

/** 一张 1x1 的 PNG。 */
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/**
 * 建一个临时目录。
 *
 * @returns {Promise<{dir: string, close: Function}>} 临时目录
 */
async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), "gptfree-history-"));
  return { dir, close: () => rm(dir, { recursive: true, force: true }) };
}

/**
 * 造一条生图记录。
 *
 * @param {any} store 历史存储
 * @param {object} extra 要覆盖的字段
 * @returns {Promise<any>} 记下的记录
 */
async function recordOne(store, extra) {
  return store.record({
    at: Date.parse("2026-11-13T10:00:00.000Z"),
    model: "gpt-image-2.6",
    prompt: "一只猫头鹰",
    revisedPrompt: "一只棕色猫头鹰",
    size: "1024x1024",
    outputFormat: "png",
    account: "someone@example.com",
    durationMs: 12345,
    source: "apifox",
    status: "ok",
    images: [{ b64: PNG_BASE64, mimeType: "image/png" }],
    ...extra,
  });
}

test("记一次生图：图片落盘，索引里只有元信息", async () => {
  const temp = await tempDir();
  try {
    const store = createHistoryStore({ dir: temp.dir });
    const record = await recordOne(store);
    assert(record);
    assert.equal(record.prompt, "一只猫头鹰");
    assert.equal(record.account, "so***@example.com");
    assert.equal(record.images.length, 1);

    const index = JSON.parse(await readFile(join(temp.dir, "history.json"), "utf8"));
    assert.equal(index.entries.length, 1);
    // 索引里不存图片本身，只存文件与大小
    assert(!JSON.stringify(index).includes(PNG_BASE64));
    assert(index.entries[0].images[0].bytes > 0);

    const onDisk = await readFile(join(temp.dir, index.entries[0].images[0].file));
    assert.equal(onDisk.toString("base64"), PNG_BASE64);
  } finally { await temp.close(); }
});

test("取一条历史：带图片的 base64 回来", async () => {
  const temp = await tempDir();
  try {
    const store = createHistoryStore({ dir: temp.dir });
    const record = await recordOne(store);
    const got = await store.get(record.id);
    assert.equal(got.prompt, "一只猫头鹰");
    assert.equal(got.images[0].b64, PNG_BASE64);
    assert.equal(await store.get("nope"), null);
  } finally { await temp.close(); }
});

test("删一条历史：索引与图片文件一起没了", async () => {
  const temp = await tempDir();
  try {
    const store = createHistoryStore({ dir: temp.dir });
    const record = await recordOne(store);
    const file = join(temp.dir, record.images[0].file);
    assert.equal(await store.remove(record.id), true);
    assert.equal(await store.remove(record.id), false);
    assert.deepEqual(await store.list(), []);
    await assert.rejects(() => readFile(file));
  } finally { await temp.close(); }
});

test("清空历史：记录与图片目录都清掉", async () => {
  const temp = await tempDir();
  try {
    const store = createHistoryStore({ dir: temp.dir });
    await recordOne(store);
    await recordOne(store, { at: Date.parse("2026-11-13T11:00:00.000Z") });
    await store.clear();
    assert.deepEqual(await store.list(), []);
    assert.equal((await store.stats()).count, 0);
  } finally { await temp.close(); }
});

test("超过条数上限：从最旧的开始丢", async () => {
  const temp = await tempDir();
  try {
    const store = createHistoryStore({ dir: temp.dir, maxEntries: 3 });
    for (let i = 0; i < 5; i++) {
      await recordOne(store, { at: Date.parse("2026-11-13T10:0" + i + ":00.000Z") });
    }
    const entries = await store.list();
    assert.equal(entries.length, 3);
    // 新的在前，最旧的两条被丢了
    assert.equal(entries[0].prompt, "一只猫头鹰");
    assert.equal(entries.length, 3);
  } finally { await temp.close(); }
});

test("超过字节上限：图片大的那条先被丢", async () => {
  const temp = await tempDir();
  try {
    const store = createHistoryStore({ dir: temp.dir, maxBytes: 100 });
    await recordOne(store);
    await recordOne(store, { at: Date.parse("2026-11-13T11:00:00.000Z") });
    const entries = await store.list();
    assert.equal(entries.length, 1);
    // 留下的是较新的那条
    assert.equal(entries[0].at, "2026-11-13T11:00:00.000Z");
  } finally { await temp.close(); }
});

test("从生图结果里取图记进历史", async () => {
  const temp = await tempDir();
  try {
    const store = createHistoryStore({ dir: temp.dir });
    const record = await recordImageTask(store, {
      request: { model: "gpt-image-2.6", prompt: "一只猫头鹰", size: "1024x1024", output_format: "png" },
      result: { data: [{ b64: PNG_BASE64, mime_type: "image/png", revised_prompt: "一只棕色猫头鹰" }] },
      account: "someone@example.com",
      durationMs: 42123,
      source: "curl",
    });
    assert(record);
    assert.equal(record.prompt, "一只猫头鹰");
    assert.equal(record.revisedPrompt, "一只棕色猫头鹰");
    assert.equal(record.durationMs, 42123);
    assert.equal(record.source, "curl");
    assert.equal(record.images.length, 1);
  } finally { await temp.close(); }
});

test("没有图片的结果不记进历史", async () => {
  const temp = await tempDir();
  try {
    const store = createHistoryStore({ dir: temp.dir });
    const record = await recordImageTask(store, { result: { data: [] } });
    assert.equal(record, null);
    assert.deepEqual(await store.list(), []);
  } finally { await temp.close(); }
});

test("图片字段名不是 b64 也取得到（按值认图，不靠键名）", async () => {
  const temp = await tempDir();
  try {
    const store = createHistoryStore({ dir: temp.dir });
    const record = await recordImageTask(store, {
      request: { model: "gpt-image-2.6", prompt: "一只猫头鹰" },
      result: {
        data: [{
          // 上游把这个字段叫什么由它自己定，这里换个名字也该照样取到
          image_blob_xyz: PNG_BASE64,
          media_type: "image/png",
          revised_prompt: "一只棕色猫头鹰",
        }],
      },
    });
    assert(record);
    assert.equal(record.images.length, 1);
    assert.equal(record.images[0].mimeType, "image/png");
  } finally { await temp.close(); }
});

test("编辑图：原图落盘、报文留文件引用、记为 edit", async () => {
  const temp = await tempDir();
  try {
    const store = createHistoryStore({ dir: temp.dir });
    const record = await recordImageTask(store, {
      request: {
        model: "gpt-image-2.6",
        prompt: "把猫换成柴犬",
        size: "1024x1024",
        quality: "high",
        background: "auto",
        output_format: "png",
        n: 1,
        images: [{ b64: PNG_BASE64, mime_type: "image/png", filename: "cat.png" }],
        masks: [],
      },
      result: { data: [{ b64: PNG_BASE64, media_type: "image/png" }] },
      account: "someone@example.com",
      durationMs: 1234,
      source: "Apifox",
    });
    assert(record);
    assert.equal(record.kind, "edit");
    // 原图也落盘了
    assert.equal(record.inputs.length, 1);
    assert.equal(record.inputs[0].filename, "cat.png");
    assert.equal(record.inputs[0].role, "image");
    const onDisk = await readFile(join(temp.dir, record.inputs[0].file));
    assert.equal(onDisk.toString("base64"), PNG_BASE64);
    // 报文是完整的，但输入图换成文件引用，不带 base64
    const request = JSON.parse(record.request);
    assert.equal(request.prompt, "把猫换成柴犬");
    assert.equal(request.quality, "high");
    assert.equal(request.model, "gpt-image-2.6");
    assert(request.images[0].file);
    assert(!record.request.includes(PNG_BASE64));
    // 取详情时原图也读得回来
    const got = await store.get(record.id);
    assert.equal(got.inputs[0].b64, PNG_BASE64);
    assert.equal(got.kind, "edit");
  } finally { await temp.close(); }
});

test("纯生图记为 generate，报文里没有输入图", async () => {
  const temp = await tempDir();
  try {
    const store = createHistoryStore({ dir: temp.dir });
    const record = await recordImageTask(store, {
      request: { model: "gpt-image-2.6", prompt: "一只猫头鹰", size: "1024x1024", output_format: "png" },
      result: { data: [{ b64: PNG_BASE64, media_type: "image/png" }] },
    });
    assert.equal(record.kind, "generate");
    assert.equal(record.inputs.length, 0);
    const request = JSON.parse(record.request);
    assert.equal(request.prompt, "一只猫头鹰");
    assert.equal(request.images, undefined);
  } finally { await temp.close(); }
});

test("删一条编辑记录：原图文件也一起没了", async () => {
  const temp = await tempDir();
  try {
    const store = createHistoryStore({ dir: temp.dir });
    const record = await recordImageTask(store, {
      request: {
        model: "gpt-image-2.6", prompt: "改一下",
        images: [{ b64: PNG_BASE64, mime_type: "image/png", filename: "cat.png" }],
      },
      result: { data: [{ b64: PNG_BASE64, media_type: "image/png" }] },
    });
    const inputFile = join(temp.dir, record.inputs[0].file);
    const outputFile = join(temp.dir, record.images[0].file);
    await store.remove(record.id);
    await assert.rejects(() => readFile(inputFile));
    await assert.rejects(() => readFile(outputFile));
  } finally { await temp.close(); }
});

test("账号脱敏与图片扩展名", () => {
  assert.equal(maskEmail("someone@example.com"), "so***@example.com");
  assert.equal(maskEmail(""), "");
  assert.equal(imageExtension("image/png"), "png");
  assert.equal(imageExtension("image/jpeg"), "jpg");
  assert.equal(imageExtension("image/webp"), "webp");
  assert.equal(imageExtension("image/gif"), "gif");
});

test("从请求头认出客户端", () => {
  assert.equal(sourceFromHeaders({ "user-agent": "Apifox/2.6.0" }), "Apifox");
  assert.equal(sourceFromHeaders({ "user-agent": "curl/8.7.1" }), "curl");
  assert.equal(sourceFromHeaders({}), "");
});

test("插件页面的历史接口：列出、取详情、删除、清空", async () => {
  const temp = await tempDir();
  const store = createHistoryStore({ dir: temp.dir });
  const service = createGuiService({ port: 0, history: store, poolRead: async () => [] });
  const address = await service.listen();
  const base = "http://127.0.0.1:" + address.port;
  try {
    const page = await (await fetch(base + "/ui")).text();
    const session = page.match(/meta name="gptfree-session" content="([a-f0-9]{64})"/)?.[1];
    assert(session);
    const api = async (route, body) => {
      const response = await fetch(base + "/api/" + route, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Origin: "null",
          "X-GPTFree-Session": session,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, data: await response.json() };
    };

    const empty = await api("history");
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.data.entries, []);

    const record = await recordOne(store);
    const listed = await api("history");
    assert.equal(listed.data.count, 1);
    assert.equal(listed.data.entries[0].prompt, "一只猫头鹰");

    const item = await api("history/item?id=" + record.id);
    assert.equal(item.status, 200);
    assert.equal(item.data.entry.images[0].b64, PNG_BASE64);

    const removed = await api("history/delete", { id: record.id });
    assert.equal(removed.data.removed, true);
    assert.deepEqual((await api("history")).data.entries, []);

    await recordOne(store);
    const cleared = await api("history/clear", {});
    assert.equal(cleared.data.cleared, true);
    assert.equal((await api("history")).data.count, 0);
  } finally {
    await service.close();
    await temp.close();
  }
});
