import assert from "node:assert/strict";
import { test } from "node:test";
import { createGuiService, startGuiServer } from "../lib/gui-service.mjs";

test("GUI 端口被占时会重试：占用者一退出，自己就绑上", async () => {
  // 上一个宿主退出前的那一瞬，新宿主绑定 37986 必失败。不重试的话，
  // 这次宿主就永远没有 GUI 页面了。
  const holder = createGuiService({ port: 0 });
  const address = await holder.listen();
  let settled = null;
  const pending = startGuiServer({ port: address.port, retries: 8, retryMs: 150, reuse: false })
    .then((service) => { settled = service; return service; })
    .catch((error) => { settled = error; throw error; });
  try {
    await new Promise((resolve) => setTimeout(resolve, 400));
    // 还在重试，没有放弃
    assert.equal(settled, null);
    // 占用者退出
    await holder.close();
    const service = await pending;
    assert(service && typeof service.listen === "function");
    assert.equal(service.server.address().port, address.port);
    await service.close();
  } finally {
    await holder.close().catch(() => {});
    await pending.catch(() => {});
  }
});

test("端口一直被占时，重试完了才报错", async () => {
  const holder = createGuiService({ port: 0 });
  const address = await holder.listen();
  try {
    await assert.rejects(
      () => startGuiServer({ port: address.port, retries: 2, retryMs: 100, reuse: false }),
      /could not bind to 127\.0\.0\.1/,
    );
  } finally {
    await holder.close();
  }
});
