/**
 * GUI 服务的后台保活重试。
 *
 * 宿主交接竞态：新宿主启动时，GUI 端口（默认 37986）仍被上一个
 * 宿主占着——上一个宿主可能被生图任务卡住、要很久才退干净。
 * startGuiServer 内建的重试只有几秒，耗尽即放弃；此后端口空出
 * 来也没有人再绑定，侧边栏页面就永远停在「正在连接本地安全导入
 * 服务…」，只能重启 magpie 才能救回来（实测见 2026-11-18 的
 * app.log：连续多天每次宿主重启都绑不上）。
 *
 * 本模块在首次绑定失败后于后台按固定间隔继续尝试，绑上即止：
 * 失败静默（避免日志刷屏），成功时回调 onUp 让宿主补一条日志。
 * 启动函数由调用方注入（startGuiServer），便于测试替身；
 * stopGuiRetryLoop 可让循环停下，供测试与宿主主动收尾。
 */

// 当前循环的中止信号：null 表示没有保活循环在跑。
// 一个宿主进程内只需一个循环，运行期间的重复启动请求直接忽略。
let retryAbort = null;

// 保活轮询间隔（毫秒），导出给调用方共用：旧宿主分钟级才退干净的
// 情况也有，10 秒一探足够及时；等待由循环自己 await，不阻塞别人。
export const GUI_KEEPALIVE_INTERVAL_MS = 10000;

/**
 * 尝试启动一次：把注入的 start 的失败归一化成 null，
 * 让调用方无需区分「成功返回服务」与「reject 携带错误」。
 *
 * @param start 实际的启动函数（生产环境为 startGuiServer），
 *              接收 { port, onPoolChange }，成功 resolve 为服务对象。
 * @param port 目标端口。
 * @param onPoolChange 服务就绪后号池变动的回调，透传给 start。
 * @returns 成功时的服务对象；失败时为 null。
 */
const tryStart = async ({ start, port, onPoolChange }) => {
  try {
    return await start({ port, onPoolChange });
  } catch {
    // 端口仍被占（旧宿主没退干净）或其他启动失败：交给下一轮。
    return null;
  }
};

/**
 * 等待指定毫秒，可被中止信号提前唤醒。
 *
 * @param ms 等待的毫秒数。
 * @param signal 中止信号，触发时立即结束等待。
 */
const sleep = (ms, signal) => new Promise((resolve) => {
  // 已中止的信号不会再派发 abort 事件，注册前先查状态直接返回。
  if (signal?.aborted) { resolve(); return; }
  const timer = setTimeout(() => resolve(), ms);
  if (signal) {
    signal.addEventListener(
      "abort",
      () => { clearTimeout(timer); resolve(); },
      { once: true },
    );
  }
});

/**
 * 后台持续尝试启动 GUI 服务，直到成功或被停止。不抛错：所有
 * 失败都只体现为「继续下一轮」。
 *
 * @param start 实际的启动函数（注入 startGuiServer）。
 * @param port 目标端口。
 * @param onPoolChange 服务就绪后号池变动的回调，透传给 start。
 * @param onUp 服务绑上端口后的回调（用于补一条恢复日志），
 *             不需要时传 null。
 * @param intervalMs 两轮尝试之间的等待毫秒数。
 */
export const keepGuiServerAlive = async ({ start, port, onPoolChange, onUp, intervalMs }) => {
  if (retryAbort) return;
  const controller = new AbortController();
  retryAbort = controller;
  try {
    for (;;) {
      const service = await tryStart({ start, port, onPoolChange });
      if (service) {
        // 停止请求晚于绑定发生时，撤销这次绑定：宿主在收尾，
        // 保活拉起的服务不能留下来没人管（强引用句柄会把
        // 进程的退出也拖住）。
        if (controller.signal.aborted) {
          await service.close().catch(() => {});
          return;
        }
        try {
          if (typeof onUp === "function") onUp(service);
        } catch {
          // 恢复日志写不进去不能影响循环收尾。
        }
        return;
      }
      // 等待可被停止请求打断；被停掉的循环不再起下一轮。
      await sleep(intervalMs, controller.signal);
      if (controller.signal.aborted) return;
    }
  } finally {
    if (retryAbort === controller) retryAbort = null;
  }
};

/**
 * 停止当前保活循环：没有循环在跑时是空操作。正在进行的某一轮
 * 启动尝试（含其内建短重试）不受打断，结束后即收尾。
 */
export const stopGuiRetryLoop = () => {
  retryAbort?.abort();
};
