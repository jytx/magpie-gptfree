import assert from "node:assert/strict";
import { test } from "node:test";
import { createGuiService, startGuiServer } from "../lib/gui-service.mjs";
import { keepGuiServerAlive, stopGuiRetryLoop } from "../lib/gui-retry.mjs";

// 保活测试的启动替身：retries 归零、不复用模块级单例，让每一轮
// 尝试立刻成败分明。测试只关心「端口空出来之前会不会等、空出来
// 之后会不会绑上」，不关心 startGuiServer 自己的短重试。
const startOnce = ({ port, onPoolChange }) =>
  startGuiServer({ port, onPoolChange, retries: 0, retryMs: 1, reuse: false });

test("短重试放弃后，保活循环等端口空出来自动绑上", async () => {
  // 复现交接竞态：占用者（旧宿主）先占住端口，保活循环持续轮询；
  // 占用者一退出，服务应被拉起并回调 onUp，页面随之恢复。
  const holder = createGuiService({ port: 0 });
  const address = await holder.listen();
  let recovered = null;
  const keep = keepGuiServerAlive({
    start: startOnce,
    port: address.port,
    onPoolChange: () => {},
    onUp: (service) => { recovered = service; },
    intervalMs: 100,
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 350));
    // 端口仍被占：还在轮询，既没有放弃也没有误报恢复
    assert.equal(recovered, null);
    // 占用者退出（模拟旧宿主终于退干净）
    await holder.close();
    await keep;
    assert(recovered && typeof recovered.close === "function");
    assert.equal(recovered.server.address().port, address.port);
  } finally {
    await holder.close().catch(() => {});
    await recovered?.close().catch(() => {});
    await keep.catch(() => {});
    stopGuiRetryLoop();
  }
});

test("循环运行期间重复启动被忽略：宿主内只有一个保活循环", async () => {
  const holder = createGuiService({ port: 0 });
  const address = await holder.listen();
  let firstUp = null;
  let secondUp = null;
  const first = keepGuiServerAlive({
    start: startOnce,
    port: address.port,
    onPoolChange: () => {},
    onUp: (service) => { firstUp = service; },
    intervalMs: 100,
  });
  // 第二次启动请求发生在第一个循环运行中：应直接返回，
  // 不产生第二个循环，其 onUp 永不被调。
  const second = keepGuiServerAlive({
    start: startOnce,
    port: address.port,
    onPoolChange: () => {},
    onUp: (service) => { secondUp = service; },
    intervalMs: 100,
  });
  try {
    await second;
    await new Promise((resolve) => setTimeout(resolve, 50));
    await holder.close();
    await first;
    assert(firstUp, "第一个循环应当完成恢复");
    assert.equal(secondUp, null, "重复启动被忽略");
  } finally {
    await holder.close().catch(() => {});
    await firstUp?.close().catch(() => {});
    await first.catch(() => {});
    stopGuiRetryLoop();
  }
});

test("停止请求让循环收尾：之后端口空出来也不再绑定", async () => {
  // 占用者占住端口，保活循环轮询中；stop 后即使端口空出，
  // 循环也不该再起下一轮去绑定。
  const holder = createGuiService({ port: 0 });
  const address = await holder.listen();
  let recovered = null;
  const keep = keepGuiServerAlive({
    start: startOnce,
    port: address.port,
    onPoolChange: () => {},
    onUp: (service) => { recovered = service; },
    intervalMs: 100,
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 150));
    stopGuiRetryLoop();
    await keep;
    await holder.close();
    // 等待超过一个轮询周期：循环确已停止，没有绑定发生
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(recovered, null);
  } finally {
    stopGuiRetryLoop();
    await holder.close().catch(() => {});
    await recovered?.close().catch(() => {});
    await keep.catch(() => {});
  }
});

test("停止晚于绑定发生时，撤销这次绑定并收尾", async () => {
  // 构造竞态窗口：一次启动尝试在飞行途中绑定成功，而停止请求
  // 恰在其落定之前到达。循环必须关掉这个迟到的服务，而不是把
  // 没人管的监听句柄留在事件循环里（会把进程退出也拖住）。
  const late = { closed: false, close: async () => { late.closed = true; } };
  let calls = 0;
  const start = () => {
    calls += 1;
    if (calls === 1) return Promise.reject(new Error("port busy"));
    // 第二次调用：延迟落定的"成功"
    return new Promise((resolve) => setTimeout(() => resolve(late), 150));
  };
  let recovered = null;
  const keep = keepGuiServerAlive({
    start,
    port: 37986,
    onPoolChange: () => {},
    onUp: (service) => { recovered = service; },
    intervalMs: 100,
  });
  try {
    // t≈120ms：第二轮尝试还在飞行中，此刻请求停止
    await new Promise((resolve) => setTimeout(resolve, 120));
    stopGuiRetryLoop();
    await keep;
    assert.equal(calls, 2);
    assert.equal(late.closed, true, "迟到的绑定应被撤销");
    assert.equal(recovered, null, "停止后不再回调 onUp");
  } finally {
    stopGuiRetryLoop();
    await keep.catch(() => {});
  }
});
