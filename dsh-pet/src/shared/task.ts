// 任务对话窗（src/shared，浏览器 bundle 与桌面 shared-core 共用）：
//  - 与 chat.ts 同模式：数据获取 = 纯函数（fetch 封装），弹窗 = 两端共用同一份 DOM；
//  - 任务走 host /dsh-pet-7340/task/* 端点（host 进程内直调 DSH Agent：followup 派发、
//    会话粘性绑定、事件帧缓冲），本文件只负责「展示 + 输入 + 轮询排水」，不含任何业务判定；
//  - 工作区驱动：先选 DSH 工作区（与 Web 侧边栏同一份，'' = 默认工作目录/未分组），
//    再在该工作区内选对话或新建；绑定（workspaceId + sessionId）由 host 落盘 task-state.json；
//  - 任务消息无长度上限（闲聊才限 2000 字）——textarea 不设 maxLength。

/** 一条任务流帧（host 帧化后的最小展示词汇；两端共用同一契约） */
export type TaskStreamFrame =
  | { type: 'turn-start'; seq: number }
  | { type: 'user'; seq: number; text: string }
  | { type: 'chunk'; seq: number; text: string }
  | { type: 'assistant'; seq: number; text: string }
  | { type: 'tool-call'; seq: number; name: string; id: string }
  | { type: 'tool-result'; seq: number; id: string; ok: boolean }
  | { type: 'turn-end'; seq: number }
  | { type: 'error'; seq: number; message: string }
  | { type: 'truncated'; seq: number };

/** 工作区列表项（host /task/workspaces 返回；'' = 默认工作目录） */
export interface TaskWorkspaceItem {
  workspaceId: string;
  /** 显示名（Web 同款标题；缺失时客户端按 path 回落） */
  title: string;
  /** 工作目录绝对路径（'' 仅见于默认目录条目） */
  path: string;
}

/** 会话下拉列表项（host /task/sessions 返回，已按工作区过滤） */
export interface TaskSessionItem {
  sessionId: string;
  /** 标题（host 尽力而为：无标题/降级时为空串） */
  title: string;
  /** 会话工作目录（缺失为空串） */
  cwd: string;
  /** 是否进程内 live（live 的会话可直接续聊，无需 resume） */
  live: boolean;
}

/** 当前粘性绑定（host /task/current 返回） */
export interface TaskCurrentState {
  sessionId: string | null;
  workspaceId: string;
  /** 绑定工作区的路径（展示/提示用；工作区已删除时为空串） */
  folder: string;
}

/** /task/stream 响应：该宠物当前绑定会话的帧缓冲（客户端按 seq 去重）+ 运行中标志 */
export interface TaskStreamState {
  ok: boolean;
  sessionId: string | null;
  /** 绑定会话是否正在运行（Agent.status === 'running'；占位提示的权威来源） */
  running: boolean;
  events: TaskStreamFrame[];
  message?: string;
}

/** /task/history 响应：绑定会话的既有对话面（user/assistant 最终消息 + 已捕获水位 seq） */
export interface TaskHistoryState {
  ok: boolean;
  sessionId: string;
  messages: Array<{ role: 'user' | 'assistant'; text: string }>;
  /** 快照覆盖到的最后事件 seq（客户端帧去重水位） */
  lastSeq: number;
}

const FETCH_TIMEOUT_MS = 10_000; // 单次请求超时（轮询失败静默重试；发送/取消略长）
const POLL_INTERVAL_MS = 500; // 排水轮询周期（与插件既有轮询族一致）

/** 无标题时的简短标识：剥掉 session-/pet- 前缀取 8 位（避免整串会话 id 刷屏） */
function shortSessionLabel(sessionId: string): string {
  const bare = sessionId.replace(/^(session|pet)-/, '');
  return bare.slice(0, 8) || sessionId;
}

/** 带超时的 fetch JSON（网络/解析失败显式抛错，调用方决定处理方式，绝不静默伪造） */
async function fetchJson(url: string, init?: RequestInit, timeoutMs = FETCH_TIMEOUT_MS): Promise<unknown> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const raw: unknown = await res.json().catch(() => null);
  if (!raw || typeof raw !== 'object') throw new Error('dsh-pet: 任务端点响应非法');
  return raw;
}

/** GET /task/workspaces：工作区列表（首项恒为默认工作目录） */
export async function fetchTaskWorkspaces(baseUrl: string, petId: string): Promise<TaskWorkspaceItem[]> {
  const raw = (await fetchJson(baseUrl + '/task/workspaces?pet=' + encodeURIComponent(petId))) as Record<
    string,
    unknown
  >;
  const items = Array.isArray(raw.items) ? raw.items : [];
  return items
    .map((it) => {
      const o = it as Record<string, unknown>;
      return {
        workspaceId: typeof o.workspaceId === 'string' ? o.workspaceId : '',
        title: typeof o.title === 'string' ? o.title : '',
        path: typeof o.path === 'string' ? o.path : '',
      } as TaskWorkspaceItem;
    })
    .filter((it) => it.workspaceId !== '' || it.title.length > 0);
}

/** GET /task/current：当前粘性绑定 */
export async function fetchTaskCurrent(baseUrl: string, petId: string): Promise<TaskCurrentState> {
  const raw = (await fetchJson(baseUrl + '/task/current?pet=' + encodeURIComponent(petId))) as Record<string, unknown>;
  return {
    sessionId: typeof raw.sessionId === 'string' && raw.sessionId ? raw.sessionId : null,
    workspaceId: typeof raw.workspaceId === 'string' ? raw.workspaceId : '',
    folder: typeof raw.folder === 'string' ? raw.folder : '',
  };
}

/** GET /task/sessions?workspace=：某工作区内的会话列表 */
export async function fetchTaskSessions(
  baseUrl: string,
  petId: string,
  workspaceId: string,
): Promise<TaskSessionItem[]> {
  const url =
    baseUrl + '/task/sessions?pet=' + encodeURIComponent(petId) + '&workspace=' + encodeURIComponent(workspaceId);
  const raw = (await fetchJson(url)) as Record<string, unknown>;
  const items = Array.isArray(raw.items) ? raw.items : [];
  return items
    .map((it) => {
      const o = it as Record<string, unknown>;
      const sessionId = String(o.sessionId ?? '');
      if (!sessionId) return null;
      return {
        sessionId,
        title: typeof o.title === 'string' ? o.title : '',
        cwd: typeof o.cwd === 'string' ? o.cwd : '',
        live: o.live === true,
      } as TaskSessionItem;
    })
    .filter((it): it is TaskSessionItem => it !== null);
}

/** POST /task/open：绑定既有会话（sessionId）或在指定工作区新建（workspaceId） */
export async function postTaskOpen(
  baseUrl: string,
  petId: string,
  payload: { workspaceId?: string; sessionId?: string },
): Promise<{ sessionId: string }> {
  const raw = (await fetchJson(baseUrl + '/task/open?pet=' + encodeURIComponent(petId), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })) as Record<string, unknown>;
  if (raw.ok !== true || typeof raw.sessionId !== 'string' || !raw.sessionId) {
    throw new Error(typeof raw.message === 'string' ? raw.message : '任务会话打开失败');
  }
  return { sessionId: raw.sessionId };
}

/** POST /task/send：向绑定会话派发任务（无长度上限） */
export async function postTaskSend(baseUrl: string, petId: string, text: string): Promise<{ sessionId: string }> {
  const raw = (await fetchJson(baseUrl + '/task/send?pet=' + encodeURIComponent(petId), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  })) as Record<string, unknown>;
  if (raw.ok !== true || typeof raw.sessionId !== 'string' || !raw.sessionId) {
    throw new Error(typeof raw.message === 'string' ? raw.message : '任务派发失败');
  }
  return { sessionId: raw.sessionId };
}

/** POST /task/cancel：中断绑定会话的当前回合（保留排队输入） */
export async function postTaskCancel(baseUrl: string, petId: string): Promise<void> {
  await fetchJson(baseUrl + '/task/cancel?pet=' + encodeURIComponent(petId), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
}

/** GET /task/history?session=：某会话的既有对话面（切换会话后同步历史用） */
export async function fetchTaskHistory(baseUrl: string, petId: string, sessionId: string): Promise<TaskHistoryState> {
  const raw = (await fetchJson(
    baseUrl + '/task/history?pet=' + encodeURIComponent(petId) + '&session=' + encodeURIComponent(sessionId),
  )) as Record<string, unknown>;
  const messages = Array.isArray(raw.messages)
    ? (raw.messages as Array<Record<string, unknown>>)
        .map((m) => {
          const role = m.role === 'user' || m.role === 'assistant' ? m.role : '';
          const text = typeof m.text === 'string' ? m.text : '';
          if (!role || !text) return null;
          return { role: role as 'user' | 'assistant', text };
        })
        .filter((m): m is { role: 'user' | 'assistant'; text: string } => m !== null)
    : [];
  return {
    ok: raw.ok === true,
    sessionId: typeof raw.sessionId === 'string' ? raw.sessionId : sessionId,
    messages,
    lastSeq: Number(raw.lastSeq ?? 0),
  };
}

/** GET /task/stream：拉取帧缓冲 */
export async function fetchTaskStream(baseUrl: string, petId: string): Promise<TaskStreamState> {
  const raw = (await fetchJson(baseUrl + '/task/stream?pet=' + encodeURIComponent(petId))) as Record<string, unknown>;
  const events = Array.isArray(raw.events) ? (raw.events as TaskStreamFrame[]) : [];
  return {
    ok: raw.ok === true,
    sessionId: typeof raw.sessionId === 'string' && raw.sessionId ? raw.sessionId : null,
    running: raw.running === true,
    events,
    message: typeof raw.message === 'string' ? raw.message : undefined,
  };
}

/** 弹窗样式 —— 两端注入同一份（与 CHAT_CSS 同模式；视觉对齐浏览器/桌面）。
 *  窗口形态：标题栏 + 工作区/会话行 + 滚动消息区 + 底部输入。字体与气泡同款（上首软糖体）。 */
export const TASK_CSS = [
  '.dsh-pet-task{position:fixed;z-index:2147483002;width:500px;max-width:88vw;',
  'max-height:min(680px,calc(100vh - 10px));',
  'background:rgba(255,255,255,.985);border:1px solid rgba(0,0,0,.14);border-radius:12px;',
  'box-shadow:0 12px 40px rgba(0,0,0,.26);color:#2b2b2b;font-size:13px;line-height:1.5;',
  "font-family:'ShangshouSoftCandy','Yuanti SC','YouYuan','幼圆','Comic Sans MS','PingFang SC','Microsoft YaHei',sans-serif;",
  'display:flex;flex-direction:column;user-select:none;overflow:hidden}',
  '.dsh-pet-task *{box-sizing:border-box}',
  '.dsh-pet-task-head{padding:8px 10px 6px;border-bottom:1px solid rgba(0,0,0,.08);flex:none}',
  '.dsh-pet-task-title{display:flex;align-items:center;justify-content:space-between;',
  'font-weight:700;font-size:14px;margin-bottom:6px}',
  '.dsh-pet-task-close{cursor:pointer;color:rgba(43,43,43,.5);font-size:15px;padding:0 2px;line-height:1}',
  '.dsh-pet-task-close:hover{color:#2b2b2b}',
  '.dsh-pet-task-row{display:flex;align-items:center;gap:5px;margin-top:4px}',
  '.dsh-pet-task-row label{flex:none;color:rgba(43,43,43,.62);font-size:12px}',
  '.dsh-pet-task-row select,.dsh-pet-task-row input{flex:1;min-width:0;font-family:inherit;font-size:12px;',
  'color:#2b2b2b;border:1px solid rgba(0,0,0,.16);border-radius:6px;padding:3px 6px;background:#fff}',
  '.dsh-pet-task-row button{flex:none;font-family:inherit;font-size:12px;color:#2b2b2b;',
  'border:1px solid rgba(0,0,0,.16);border-radius:6px;padding:3px 9px;background:#fff;cursor:pointer}',
  '.dsh-pet-task-row button:hover{background:rgba(0,0,0,.05)}',
  '.dsh-pet-task-msgs{flex:1;min-height:140px;max-height:480px;overflow-y:auto;padding:8px 10px;',
  'user-select:text;display:flex;flex-direction:column;gap:6px}',
  '.dsh-pet-task-msg{max-width:96%;padding:6px 10px;border-radius:9px;white-space:pre-wrap;',
  'overflow-wrap:anywhere;font-size:14px;cursor:pointer}',
  // 折叠态：一行省略号；展开态：内容超高时消息内部滚动（不把预览区撑爆）
  '.dsh-pet-task-msg.is-collapsed{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-height:1.8em}',
  '.dsh-pet-task-msg:not(.is-collapsed){max-height:260px;overflow-y:auto}',
  // 折叠/展开指示符（仅对话消息；占位行不参与）
  '.dsh-pet-task-msg-user.is-collapsed::before,.dsh-pet-task-msg-assistant.is-collapsed::before',
  '{content:"▸ " ;color:rgba(43,43,43,.45)}',
  '.dsh-pet-task-msg-user:not(.is-collapsed)::before,.dsh-pet-task-msg-assistant:not(.is-collapsed)::before',
  '{content:"▾ " ;color:rgba(43,43,43,.45)}',
  '.dsh-pet-task-msg-user{align-self:flex-end;background:#e8f2ff;color:#1f3a5f}',
  '.dsh-pet-task-msg-assistant{align-self:flex-start;background:rgba(0,0,0,.055)}',
  '.dsh-pet-task-msg-running{align-self:flex-start;color:rgba(43,43,43,.78);font-size:13px;padding:5px 9px;cursor:default}',
  '.dsh-pet-task-msg-tool{align-self:flex-start;font-size:12px;color:rgba(43,43,43,.62);padding:1px 2px}',
  '.dsh-pet-task-msg-err{align-self:flex-start;background:#fdecea;color:#b3402f}',
  '.dsh-pet-task-msg-note{align-self:center;font-size:11px;color:rgba(43,43,43,.45)}',
  '.dsh-pet-task-empty{color:rgba(43,43,43,.4);font-size:12px;text-align:center;margin-top:24px}',
  '.dsh-pet-task-foot{flex:none;padding:8px 10px 10px;border-top:1px solid rgba(0,0,0,.08)}',
  '.dsh-pet-task-input{display:block;width:100%;border:1px solid rgba(0,0,0,.16);border-radius:8px;',
  'outline:none;background:#fff;padding:7px 9px;font-size:13px;line-height:1.45;color:#2b2b2b;',
  'font-family:inherit;resize:vertical;min-height:34px;max-height:140px;overflow-y:auto;',
  'white-space:pre-wrap;overflow-wrap:anywhere}',
  '.dsh-pet-task-input:focus{border-color:rgba(70,130,200,.55)}',
  '.dsh-pet-task-input:disabled{opacity:.55}',
  '.dsh-pet-task-actions{display:flex;gap:6px;margin-top:6px;justify-content:flex-end}',
  '.dsh-pet-task-btn{font-family:inherit;font-size:12px;color:#fff;border:none;border-radius:7px;',
  'padding:5px 14px;cursor:pointer}',
  '.dsh-pet-task-btn-send{background:#4a7fc1}',
  '.dsh-pet-task-btn-send:hover{background:#3c6ca9}',
  '.dsh-pet-task-btn-send:disabled{opacity:.55;cursor:default}',
  '.dsh-pet-task-btn-cancel{background:#c0564a;display:none}',
  '.dsh-pet-task-btn-cancel:hover{background:#a8483d}',
  '.dsh-pet-task-errline{color:#d94f3d;font-size:12px;margin-top:5px;white-space:pre-wrap;',
  'overflow-wrap:anywhere;display:none}',
].join('');

let taskCssInjected = false;
function injectTaskCss(): void {
  if (taskCssInjected || typeof document === 'undefined') return;
  taskCssInjected = true;
  const tag = document.createElement('style');
  tag.dataset.plugin = 'dsh-pet';
  tag.dataset.pluginCss = 'dsh-pet/task';
  tag.textContent = TASK_CSS;
  document.head.appendChild(tag);
}

/** mountTaskDialog 返回值 */
export interface TaskDialogMount {
  /** 根元素（document.body 下） */
  el: HTMLElement;
  /** 关闭并清理（幂等；停轮询、解绑监听） */
  close: () => void;
}

/**
 * 挂载任务对话窗（两端共用；位置为视口坐标，超出视口自动夹回）。
 * 行为：打开即任务模式（P1 无模式切换）；工作区 → 会话两级选择，粘性绑定（host 落盘）；
 * 打开期间每 500ms 轮询 /task/stream 排水渲染；Esc 或点 × 关闭（不做点外关闭——窗口语义）。
 */
export function mountTaskDialog(opts: {
  petId: string;
  /** 宠物显示名（标题栏展示） */
  petName?: string;
  /** 端点基址：浏览器默认相对 /dsh-pet-7340；桌面传绝对 URL（bridge scheme 需绝对） */
  baseUrl?: string;
  x: number;
  y: number;
  onClose?: () => void;
}): TaskDialogMount {
  injectTaskCss();
  const { petId, x, y, onClose } = opts;
  const baseUrl = opts.baseUrl ?? '/dsh-pet-7340';
  const title = opts.petName?.trim() || petId;

  const root = document.createElement('div');
  root.className = 'dsh-pet-task';

  // ---- 头部：标题 + 关闭 ----
  const head = document.createElement('div');
  head.className = 'dsh-pet-task-head';
  const titleRow = document.createElement('div');
  titleRow.className = 'dsh-pet-task-title';
  const titleText = document.createElement('span');
  titleText.textContent = title + ' · 任务';
  const closeBtn = document.createElement('span');
  closeBtn.className = 'dsh-pet-task-close';
  closeBtn.textContent = '×';
  closeBtn.title = '关闭（Esc）';
  titleRow.appendChild(titleText);
  titleRow.appendChild(closeBtn);
  head.appendChild(titleRow);

  // 工作区行：先选工作区（同步 Web 已有工作区；'' = 默认工作目录/未分组）
  const workspaceRow = document.createElement('div');
  workspaceRow.className = 'dsh-pet-task-row';
  const workspaceLabel = document.createElement('label');
  workspaceLabel.textContent = '工作区';
  const workspaceSelect = document.createElement('select');
  workspaceSelect.title = '先选工作区，再选其中的对话';
  workspaceRow.appendChild(workspaceLabel);
  workspaceRow.appendChild(workspaceSelect);
  head.appendChild(workspaceRow);

  // 会话行：该工作区内的对话（含「＋ 新建对话」）
  const sessionRow = document.createElement('div');
  sessionRow.className = 'dsh-pet-task-row';
  const sessionLabel = document.createElement('label');
  sessionLabel.textContent = '会话';
  const sessionSelect = document.createElement('select');
  const newSessionOpt = document.createElement('option');
  newSessionOpt.value = '__new';
  newSessionOpt.textContent = '＋ 新建对话';
  sessionSelect.appendChild(newSessionOpt);
  sessionRow.appendChild(sessionLabel);
  sessionRow.appendChild(sessionSelect);
  head.appendChild(sessionRow);

  // ---- 消息区 ----
  const msgs = document.createElement('div');
  msgs.className = 'dsh-pet-task-msgs';
  const empty = document.createElement('div');
  empty.className = 'dsh-pet-task-empty';
  empty.textContent = '在下方输入任务，回车或点「发送」派发给 DSH';
  msgs.appendChild(empty);

  // ---- 底部：输入 + 发送/取消 ----
  const foot = document.createElement('div');
  foot.className = 'dsh-pet-task-foot';
  const input = document.createElement('textarea');
  input.className = 'dsh-pet-task-input';
  input.placeholder = '描述任务…';
  input.rows = 2;
  const errline = document.createElement('div');
  errline.className = 'dsh-pet-task-errline';
  const actions = document.createElement('div');
  actions.className = 'dsh-pet-task-actions';
  const sendBtn = document.createElement('button');
  sendBtn.className = 'dsh-pet-task-btn dsh-pet-task-btn-send';
  sendBtn.textContent = '发送';
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'dsh-pet-task-btn dsh-pet-task-btn-cancel';
  cancelBtn.textContent = '取消任务';
  actions.appendChild(cancelBtn);
  actions.appendChild(sendBtn);
  foot.appendChild(input);
  foot.appendChild(errline);
  foot.appendChild(actions);

  root.appendChild(head);
  root.appendChild(msgs);
  root.appendChild(foot);
  document.body.appendChild(root);

  // 位置：以 (x,y) 落点，超出视口夹回
  const rr = root.getBoundingClientRect();
  root.style.left = Math.max(4, Math.min(x, window.innerWidth - rr.width - 4)) + 'px';
  root.style.top = Math.max(4, Math.min(y, window.innerHeight - rr.height - 4)) + 'px';

  // ---- 渲染状态 ----
  let closed = false;
  let sending = false;
  let running = false;
  let lastSeq = 0; // 帧去重水位（event.seq 单调；<= 已处理）
  let placeholderEl: HTMLElement | null = null; // 「正在努力工作...」占位行
  let latestAnswerEl: HTMLElement | null = null; // 最新的回答（唯一保持展开的消息）
  const entryEls: HTMLElement[] = []; // 消息条目（FIFO；只保留最近 MAX_ENTRIES 条）
  const MAX_ENTRIES = 6; // 只显示最近 3 轮对话（3 条用户输入 + 3 条回答）
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let workspaces: TaskWorkspaceItem[] = [];
  let sessions: TaskSessionItem[] = [];
  let currentWorkspaceId = '';
  let currentBoundSessionId: string | null = null;

  const showError = (text: string): void => {
    errline.textContent = text;
    errline.style.display = 'block';
  };
  const clearError = (): void => {
    errline.textContent = '';
    errline.style.display = 'none';
  };

  const ensureArea = (): void => {
    if (empty.parentNode === msgs) msgs.removeChild(empty);
  };

  /** 内容增长后若对话框底部/右侧超出视口，向上/向左回夹——保证输入框永不被裁掉 */
  const clampPosition = (): void => {
    const r = root.getBoundingClientRect();
    if (r.bottom > window.innerHeight - 4) {
      root.style.top = Math.max(4, window.innerHeight - r.height - 4) + 'px';
    }
    if (r.right > window.innerWidth - 4) {
      root.style.left = Math.max(4, window.innerWidth - r.width - 4) + 'px';
    }
  };

  /** 追加一条消息（用户/回答）：collapsed=true 折叠成一行；点击整行切换折叠/展开。
   *  只保留最近 3 轮（6 条）：超出时逐出最旧一条 */
  const appendEntry = (role: 'user' | 'assistant', text: string, collapsed: boolean): HTMLElement => {
    ensureArea();
    const el = document.createElement('div');
    el.className = 'dsh-pet-task-msg ' + (role === 'user' ? 'dsh-pet-task-msg-user' : 'dsh-pet-task-msg-assistant');
    el.textContent = text;
    el.classList.toggle('is-collapsed', collapsed);
    el.title = collapsed ? '点击展开' : '点击折叠';
    el.addEventListener('click', () => {
      const now = el.classList.toggle('is-collapsed');
      el.title = now ? '点击展开' : '点击折叠';
    });
    msgs.appendChild(el);
    entryEls.push(el);
    while (entryEls.length > MAX_ENTRIES) {
      const old = entryEls.shift();
      if (old) {
        if (old === latestAnswerEl) latestAnswerEl = null;
        old.remove();
      }
    }
    clampPosition();
    msgs.scrollTop = msgs.scrollHeight;
    return el;
  };

  /** 新回答出现时：把上一个展开的回答折叠（除最新回答外全部一行） */
  const collapseLatestAnswer = (): void => {
    if (latestAnswerEl) {
      latestAnswerEl.classList.add('is-collapsed');
      latestAnswerEl.title = '点击展开';
      latestAnswerEl = null;
    }
  };

  /** 「正在努力工作...」占位行（运行期间唯一的前台提示，最终回答到达时被替换） */
  const showPlaceholder = (): void => {
    if (placeholderEl) return;
    ensureArea();
    placeholderEl = document.createElement('div');
    placeholderEl.className = 'dsh-pet-task-msg dsh-pet-task-msg-running';
    placeholderEl.textContent = '正在努力工作...';
    msgs.appendChild(placeholderEl);
    clampPosition();
    msgs.scrollTop = msgs.scrollHeight;
  };

  const removePlaceholder = (): void => {
    if (!placeholderEl) return;
    placeholderEl.remove();
    placeholderEl = null;
  };

  /** 运行态切换：开始 → 显示占位；结束 → 撤下占位（最终回答到达时它已被替换） */
  const applyRunning = (now: boolean): void => {
    if (now === running) return;
    running = now;
    if (now) showPlaceholder();
    else removePlaceholder();
    updateRunUi();
  };

  /** 处理一帧（按 seq 去重；帧可能来自本端发送或 Web 端驱动的同一会话）。
   *  只渲染最终输出：chunk/工具调用等中间过程一律省略；除最新回答外全部折叠成一行。 */
  const handleFrame = (frame: TaskStreamFrame): void => {
    if (frame.seq <= lastSeq) return;
    lastSeq = frame.seq;
    switch (frame.type) {
      case 'turn-start':
        applyRunning(true);
        break;
      case 'user':
        appendEntry('user', frame.text, true);
        break;
      case 'chunk':
        break; // 中间过程省略：不渲染流式碎块
      case 'assistant': {
        // 最终回答：替换占位行，成为唯一展开的最新回答
        removePlaceholder();
        collapseLatestAnswer();
        latestAnswerEl = appendEntry('assistant', frame.text, false);
        break;
      }
      case 'tool-call':
      case 'tool-result':
        break; // 中间过程省略：不渲染工具调用
      case 'turn-end':
        applyRunning(false);
        break;
      case 'error': {
        applyRunning(false);
        collapseLatestAnswer();
        const el = appendEntry('assistant', '任务出错：' + frame.message, false);
        el.classList.add('dsh-pet-task-msg-err');
        latestAnswerEl = el;
        break;
      }
      case 'truncated':
        break; // 折叠展示下无需省略提示
      default:
        break;
    }
  };

  const updateRunUi = (): void => {
    cancelBtn.style.display = running ? 'block' : 'none';
    sendBtn.disabled = sending || running;
  };

  // 工作区下拉重建（标题优先，无标题用路径；保持当前选中）
  const rebuildWorkspaceSelect = (): void => {
    workspaceSelect.innerHTML = '';
    for (const w of workspaces) {
      const opt = document.createElement('option');
      opt.value = w.workspaceId;
      opt.textContent = w.title || w.path || w.workspaceId || '默认工作目录';
      if (w.path) opt.title = w.path;
      workspaceSelect.appendChild(opt);
    }
    workspaceSelect.value = currentWorkspaceId;
  };

  // 会话下拉重建（保持当前选中；列表失败静默——下拉最少可用「新建」）
  const rebuildSessionSelect = (): void => {
    const current = sessionSelect.value;
    sessionSelect.innerHTML = '';
    sessionSelect.appendChild(newSessionOpt);
    for (const s of sessions) {
      const opt = document.createElement('option');
      opt.value = s.sessionId;
      opt.textContent = (s.title || '未命名 · ' + shortSessionLabel(s.sessionId)) + (s.live ? '' : '（离线）');
      sessionSelect.appendChild(opt);
    }
    if (current) sessionSelect.value = current;
  };

  // 绑定会话若在当前工作区列表内则选中，否则停在「＋ 新建对话」
  const syncSelectToBound = (): void => {
    sessionSelect.value =
      currentBoundSessionId && sessions.some((s) => s.sessionId === currentBoundSessionId)
        ? currentBoundSessionId
        : '__new';
  };

  // 清空消息区（切换会话/新建后）
  const resetMessages = (): void => {
    msgs.innerHTML = '';
    msgs.appendChild(empty);
    lastSeq = 0;
    placeholderEl = null;
    latestAnswerEl = null;
    entryEls.length = 0;
    running = false;
    updateRunUi();
  };

  // 拉取某工作区内的会话列表
  const refreshSessions = (): Promise<void> => {
    return fetchTaskSessions(baseUrl, petId, currentWorkspaceId)
      .then((items) => {
        sessions = items;
        rebuildSessionSelect();
        syncSelectToBound();
      })
      .catch(() => {
        sessions = [];
        rebuildSessionSelect();
      });
  };

  // 轮询排水：/task/stream 拉帧缓冲，逐帧处理；失败静默重试（下一轮）；in-flight 防护防堆积
  let polling = false;
  const poll = (): void => {
    if (closed || polling) return;
    polling = true;
    fetchTaskStream(baseUrl, petId)
      .then((state) => {
        if (closed || !state.ok) return;
        if (state.sessionId && state.sessionId !== currentBoundSessionId) {
          currentBoundSessionId = state.sessionId;
          syncSelectToBound();
        }
        applyRunning(state.running);
        for (const frame of state.events) handleFrame(frame);
      })
      .catch(() => {
        /* 轮询失败静默：下轮重试 */
      })
      .finally(() => {
        polling = false;
      });
  };

  // 同步某会话的历史对话面（切换/打开会话后）：全部折叠成一行，仅最新回答保持展开；
  // 只取最近 3 轮（6 条）；快照水位 seq 并入去重水位——历史已含的帧不再重复渲染
  const loadHistory = (sessionId: string): Promise<void> => {
    return fetchTaskHistory(baseUrl, petId, sessionId)
      .then((h) => {
        if (closed || h.sessionId !== currentBoundSessionId) return;
        lastSeq = Math.max(lastSeq, h.lastSeq);
        const recent = h.messages.slice(-MAX_ENTRIES);
        for (let i = 0; i < recent.length; i++) {
          const m = recent[i];
          const isLatest = i === recent.length - 1;
          if (m.role === 'assistant') {
            collapseLatestAnswer();
            const el = appendEntry('assistant', m.text, !isLatest);
            if (isLatest) latestAnswerEl = el;
          } else {
            appendEntry('user', m.text, true);
          }
        }
        clampPosition();
      })
      .catch(() => {
        /* 历史读取失败静默：轮询帧继续渲染后续消息 */
      });
  };

  // 绑定变更后的统一刷新：清消息 → 同步该会话历史 → 继续轮询
  const applyBinding = (): void => {
    resetMessages();
    if (currentBoundSessionId) loadHistory(currentBoundSessionId);
    poll();
  };

  // 发送任务
  const doSend = (): void => {
    if (closed || sending || running) return;
    const text = input.value.trim();
    if (!text) return;
    sending = true;
    clearError();
    updateRunUi();
    postTaskSend(baseUrl, petId, text)
      .then(({ sessionId }) => {
        input.value = '';
        currentBoundSessionId = sessionId;
        syncSelectToBound();
        poll();
      })
      .catch((e) => {
        showError('派发失败：' + String(e && e.message ? e.message : e));
      })
      .finally(() => {
        sending = false;
        updateRunUi();
        if (!closed) input.focus();
      });
  };

  // 取消当前任务
  const doCancel = (): void => {
    if (closed || !running) return;
    postTaskCancel(baseUrl, petId).catch(() => {
      /* 取消失败静默：turn/end 帧会收敛状态 */
    });
  };

  // 在当前工作区新建会话
  const doNewSession = (): void => {
    if (closed || sending) return;
    sending = true;
    clearError();
    postTaskOpen(baseUrl, petId, { workspaceId: currentWorkspaceId })
      .then(({ sessionId }) => {
        currentBoundSessionId = sessionId;
        refreshSessions().finally(() => {
          syncSelectToBound();
        });
        applyBinding();
      })
      .catch((e) => {
        showError('新建会话失败：' + String(e && e.message ? e.message : e));
      })
      .finally(() => {
        sending = false;
        updateRunUi();
      });
  };

  // 绑定既有会话
  const doBindSession = (sessionId: string): void => {
    if (closed || sending) return;
    sending = true;
    clearError();
    postTaskOpen(baseUrl, petId, { sessionId })
      .then(({ sessionId: bound }) => {
        currentBoundSessionId = bound;
        applyBinding();
      })
      .catch((e) => {
        showError('切换会话失败：' + String(e && e.message ? e.message : e));
        refreshSessions().finally(() => {
          syncSelectToBound();
        });
      })
      .finally(() => {
        sending = false;
        updateRunUi();
      });
  };

  // ---- 事件绑定 ----
  closeBtn.addEventListener('click', close);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      doSend();
    }
  });
  sendBtn.addEventListener('click', doSend);
  cancelBtn.addEventListener('click', doCancel);
  workspaceSelect.addEventListener('change', () => {
    // 换工作区：只切换会话列表过滤（不自动新建/绑定——由用户接着选对话或新建）
    currentWorkspaceId = workspaceSelect.value;
    refreshSessions();
  });
  sessionSelect.addEventListener('change', () => {
    const v = sessionSelect.value;
    if (v === '__new') doNewSession();
    else doBindSession(v);
  });
  document.addEventListener('keydown', onDocKeyDown, true);

  function onDocKeyDown(e: KeyboardEvent): void {
    if (closed) return;
    if (e.key === 'Escape') close();
  }

  function close(): void {
    if (closed) return;
    closed = true;
    if (pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    document.removeEventListener('keydown', onDocKeyDown, true);
    root.remove();
    if (onClose) onClose();
  }

  // ---- 启动：恢复粘性绑定 → 拉工作区 → 拉该工作区会话 → 开始轮询 ----
  const boot = (): void => {
    fetchTaskCurrent(baseUrl, petId)
      .then((state) => {
        if (closed) return;
        currentBoundSessionId = state.sessionId;
        currentWorkspaceId = state.workspaceId;
      })
      .catch(() => {
        /* 绑定读取失败静默：仍可用（发送时会由 host 兜底建会话） */
      })
      .finally(() => {
        if (closed) return;
        fetchTaskWorkspaces(baseUrl, petId)
          .then((items) => {
            if (closed) return;
            workspaces = items;
            rebuildWorkspaceSelect();
            // 绑定工作区若已不存在（被删），回落默认目录
            if (!items.some((w) => w.workspaceId === currentWorkspaceId)) currentWorkspaceId = '';
            workspaceSelect.value = currentWorkspaceId;
            return refreshSessions();
          })
          .catch(() => {
            workspaces = [{ workspaceId: '', title: '默认工作目录', path: '' }];
            rebuildWorkspaceSelect();
          })
          .finally(() => {
            if (closed) return;
            // 打开即有绑定会话：同步其历史对话面（折叠展示，最新回答展开）
            if (currentBoundSessionId) loadHistory(currentBoundSessionId);
            pollTimer = setInterval(poll, POLL_INTERVAL_MS);
          });
      });
  };

  boot();
  updateRunUi();
  input.focus();
  return { el: root, close };
}
