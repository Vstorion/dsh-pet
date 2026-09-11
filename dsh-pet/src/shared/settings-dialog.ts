// 桌宠设置面板（src/shared，浏览器 bundle 与桌面 shared-core 共用）：
// 自 menu.ts / chat.ts / task.ts 之后第四个「两端共用同一份 DOM」例外——
// 右键人物 →「设置」弹出，字段与 DSH Web 的「桌宠配置」设置页**完全一致**
// （宠物列表 / 名字 / 大小 / 位置角落 + 偏移 / 显示位置 / 角色透明度 /
//   余额功能 / 碎碎念 / 工作状态联动 / 系统通知总开关 / 保存 / 恢复默认）。
//
// 数据流（与 Web 设置页同一份契约，读写同一份配置，两个入口天然一致）：
//   - 读：GET <base>/config 的**成品聚合**（host readAllConfig 合并，字段填满），
//     只取 main 条目的 pets（可编辑层）+ notificationsEnabled；文件宠物（pet/ 目录）
//     不可编辑，只显示条数提示——与 Web 设置页同一条规则；
//   - 写：PUT <base>/config { pets, notificationsEnabled }（host saveUserConfig 白名单重建
//     用户层 main-config.json；task 段/手改的顶层精调字段由 host 透传保留）；
//   - 恢复默认：DELETE <base>/config → 重新拉成品。
//
// 生效语义：保存后 host 会 syncDesktop()（重解析桌面宠物并重载辅助进程）——
// 浏览器 overlay 由调用方 onSaved 重新拉配置即时重渲染，桌面端窗口重建后带新值。
import { OPACITY_MAX, OPACITY_MIN, PET_DISPLAYS, clampOpacity } from './config';
import type { Corner, PetDisplay } from './types';

/** 可编辑宠物（本面板只提交这些字段；task 等段由 host 从磁盘原样透传保留） */
export interface SettingsPet {
  id: string;
  name: string;
  size: number;
  opacity: number;
  balanceEnabled: boolean;
  whisperEnabled: boolean;
  workStatusEnabled: boolean;
  display: PetDisplay;
  position: { corner: Corner; marginX: number; marginY: number };
}

const CORNERS: Corner[] = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
const CORNER_LABELS: Record<Corner, string> = {
  'top-left': '左上角',
  'top-right': '右上角',
  'bottom-left': '左下角',
  'bottom-right': '右下角',
};
const DISPLAY_LABELS: Record<PetDisplay, string> = {
  web: '仅浏览器',
  desktop: '仅桌面',
  both: '两者都显示',
  none: '都不显示',
};

/** 面板样式 —— 两端注入同一份（视觉与右键菜单同族：白卡片 + 圆角 + 阴影） */
export const SETTINGS_CSS = [
  '.dsh-pet-settings{position:fixed;z-index:2147483002;width:400px;max-width:92vw;max-height:86vh;display:flex;',
  'flex-direction:column;background:rgba(255,255,255,.99);border:1px solid rgba(0,0,0,.12);border-radius:12px;',
  'box-shadow:0 14px 40px rgba(0,0,0,.26);color:#2b2b2b;font-size:13px;line-height:1.5;',
  "font-family:'Microsoft YaHei UI','Segoe UI','PingFang SC',sans-serif;user-select:none}",
  '.dsh-pet-settings *{box-sizing:border-box}',
  '.dsh-pet-set-head{display:flex;align-items:center;justify-content:space-between;gap:10px;',
  'padding:10px 14px;border-bottom:1px solid rgba(0,0,0,.08);font-size:14px;font-weight:600}',
  '.dsh-pet-set-close{border:none;background:transparent;color:#7a7f85;font-size:18px;line-height:1;',
  'cursor:pointer;padding:0 4px;border-radius:6px}',
  '.dsh-pet-set-close:hover{background:rgba(43,99,255,.12);color:#2b2b2b}',
  '.dsh-pet-set-body{padding:10px 14px 12px;overflow-y:auto;display:flex;flex-direction:column;gap:9px}',
  '.dsh-pet-set-tabs{display:flex;flex-wrap:wrap;gap:6px;align-items:center}',
  '.dsh-pet-set-tab{border:1px solid rgba(0,0,0,.14);background:transparent;color:#2b2b2b;border-radius:8px;',
  'padding:3px 10px;font-size:12px;cursor:pointer;font-family:inherit}',
  '.dsh-pet-set-tab.is-sel{border-color:#2b63ff;background:rgba(43,99,255,.12)}',
  '.dsh-pet-set-tab.is-add{border-style:dashed;color:#5d636a}',
  '.dsh-pet-set-card{border:1px solid rgba(0,0,0,.1);border-radius:10px;padding:9px 11px;display:grid;',
  'grid-template-columns:1fr 1fr;gap:8px 10px}',
  '.dsh-pet-set-field{display:flex;flex-direction:column;gap:3px;min-width:0}',
  '.dsh-pet-set-field.is-wide{grid-column:1 / -1}',
  '.dsh-pet-set-label{font-size:11px;color:#6b7076}',
  '.dsh-pet-set-hint{font-size:10px;color:#9aa0a6;line-height:1.35}',
  '.dsh-pet-set-in{border:1px solid rgba(0,0,0,.16);border-radius:7px;background:#fff;color:#2b2b2b;',
  'padding:4px 8px;font-size:12px;min-height:26px;outline:none;font-family:inherit;width:100%}',
  '.dsh-pet-set-in:focus{border-color:#2b63ff}',
  '.dsh-pet-set-check{display:flex;align-items:center;gap:6px;font-size:12px}',
  '.dsh-pet-set-check input{width:15px;height:15px;accent-color:#2b63ff;flex:none}',
  '.dsh-pet-set-range{display:flex;align-items:center;gap:8px}',
  '.dsh-pet-set-range input[type=range]{flex:1;accent-color:#2b63ff;min-width:0}',
  '.dsh-pet-set-range span{font-size:11px;color:#6b7076;min-width:38px;text-align:right}',
  '.dsh-pet-set-foot{display:flex;align-items:center;gap:8px;padding:10px 14px;border-top:1px solid rgba(0,0,0,.08);',
  'flex-wrap:wrap}',
  '.dsh-pet-set-btn{border:1px solid rgba(0,0,0,.16);background:transparent;color:#2b2b2b;border-radius:8px;',
  'padding:4px 14px;font-size:12px;cursor:pointer;font-family:inherit}',
  '.dsh-pet-set-btn.is-primary{border-color:#2b63ff;background:#2b63ff;color:#fff}',
  '.dsh-pet-set-btn.is-danger{border-color:rgba(217,79,61,.5);color:#d94f3d}',
  '.dsh-pet-set-btn:disabled{opacity:.5;cursor:default}',
  '.dsh-pet-set-note{font-size:11px;color:#9aa0a6;line-height:1.4}',
  '.dsh-pet-set-msg{font-size:11.5px;margin-left:auto}',
  '.dsh-pet-set-msg.is-ok{color:#2e9e4f}',
  '.dsh-pet-set-msg.is-err{color:#d94f3d}',
].join('');

let cssInjected = false;
function injectCss(): void {
  if (cssInjected || typeof document === 'undefined') return;
  cssInjected = true;
  const tag = document.createElement('style');
  tag.dataset.plugin = 'dsh-pet';
  tag.dataset.pluginCss = 'dsh-pet/settings';
  tag.textContent = SETTINGS_CSS;
  document.head.appendChild(tag);
}

/** mountSettingsDialog 返回值 */
export interface SettingsDialogMount {
  /** 根元素（document.body 下） */
  el: HTMLElement;
  /** 关闭并清理（幂等） */
  close: () => void;
}

/** 生成一个未占用的宠物 id（pet-2、pet-3…；与 Web 设置页同一规则） */
function nextId(list: SettingsPet[]): string {
  for (let n = 2; ; n++) {
    const id = 'pet-' + n;
    if (!list.some((p) => p.id === id)) return id;
  }
}

/** 把 host 成品配置里的 main 条目宠物规整成可编辑实例（字段已由合并器填满，这里只做类型收窄） */
function toEditable(raw: unknown): SettingsPet | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;
  const id = typeof p.id === 'string' ? p.id : '';
  if (!id) return null;
  const pos = p.position && typeof p.position === 'object' ? (p.position as Record<string, unknown>) : {};
  const corner = String(pos.corner ?? '') as Corner;
  const display = String(p.display ?? '') as PetDisplay;
  return {
    id,
    name: typeof p.name === 'string' && p.name ? p.name : id,
    size: Number(p.size) || 0,
    opacity: clampOpacity(p.opacity),
    balanceEnabled: p.balanceEnabled === true,
    whisperEnabled: p.whisperEnabled === true,
    workStatusEnabled: p.workStatusEnabled === true,
    display: (PET_DISPLAYS as readonly string[]).includes(display) ? display : 'both',
    position: {
      corner: CORNERS.includes(corner) ? corner : 'bottom-right',
      marginX: Number.isFinite(Number(pos.marginX)) ? Number(pos.marginX) : 0,
      marginY: Number.isFinite(Number(pos.marginY)) ? Number(pos.marginY) : 0,
    },
  };
}

/**
 * 挂载「设置」面板（两端共用）。位置为视口坐标（不传则居中——桌面全屏透明窗用居中）。
 *
 * @param opts.baseUrl 端点基址（默认相对 '/dsh-pet-7340'；桌面传 BASE，可能为 bridge scheme）
 * @param opts.onSaved 保存/恢复默认成功后的回调：浏览器侧据此重拉配置重渲染
 *                     （桌面侧无需处理——host 保存后会重载辅助进程，窗口带新值重建）
 */
export function mountSettingsDialog(opts: {
  baseUrl?: string;
  x?: number;
  y?: number;
  onSaved?: (pets: SettingsPet[]) => void;
  onClose?: () => void;
}): SettingsDialogMount {
  injectCss();
  const base = (opts.baseUrl ?? '/dsh-pet-7340').replace(/\/$/, '');
  const configUrl = base + '/config';

  let pets: SettingsPet[] = [];
  let selId = '';
  let extraCount = 0;
  let notifyEnabled = true;
  let busy = false;
  let closed = false;

  const root = document.createElement('div');
  root.className = 'dsh-pet-settings';

  // ---------- 头部 ----------
  const head = document.createElement('div');
  head.className = 'dsh-pet-set-head';
  const title = document.createElement('div');
  title.textContent = '桌宠设置';
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'dsh-pet-set-close';
  closeBtn.textContent = '×';
  closeBtn.title = '关闭';
  closeBtn.addEventListener('click', () => close());
  head.appendChild(title);
  head.appendChild(closeBtn);

  // ---------- 主体 ----------
  const body = document.createElement('div');
  body.className = 'dsh-pet-set-body';
  const tabs = document.createElement('div');
  tabs.className = 'dsh-pet-set-tabs';
  const card = document.createElement('div');
  card.className = 'dsh-pet-set-card';
  const extraHint = document.createElement('div');
  extraHint.className = 'dsh-pet-set-note';
  const modeNote = document.createElement('div');
  modeNote.className = 'dsh-pet-set-note';
  modeNote.textContent =
    '保存后即时生效：「显示位置」含桌面的宠物会重载桌面宠物进程（窗口短暂重建）；浏览器内宠物立即重绘。';
  body.appendChild(tabs);
  body.appendChild(card);
  body.appendChild(extraHint);
  body.appendChild(modeNote);

  // 系统通知总开关（全局；与 Web 设置页同一字段）
  const notifyRow = document.createElement('label');
  notifyRow.className = 'dsh-pet-set-check';
  const notifyBox = document.createElement('input');
  notifyBox.type = 'checkbox';
  const notifyText = document.createElement('span');
  notifyText.textContent = '系统通知（对话完成 / 生成失败 / 权限申请 / 用户选择时弹系统级通知）';
  notifyRow.appendChild(notifyBox);
  notifyRow.appendChild(notifyText);
  notifyBox.addEventListener('change', () => {
    notifyEnabled = notifyBox.checked;
  });
  body.appendChild(notifyRow);

  // ---------- 底部 ----------
  const foot = document.createElement('div');
  foot.className = 'dsh-pet-set-foot';
  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'dsh-pet-set-btn is-primary';
  saveBtn.textContent = '保存';
  const resetBtn = document.createElement('button');
  resetBtn.type = 'button';
  resetBtn.className = 'dsh-pet-set-btn is-danger';
  resetBtn.textContent = '恢复默认';
  const msg = document.createElement('span');
  msg.className = 'dsh-pet-set-msg';
  foot.appendChild(saveBtn);
  foot.appendChild(resetBtn);
  foot.appendChild(msg);

  root.appendChild(head);
  root.appendChild(body);
  root.appendChild(foot);
  document.body.appendChild(root);

  // ---------- 位置（不传则居中；超出视口夹回） ----------
  // 注意：绝不能只在挂载时量一次——挂载瞬间卡片还是「加载中…」的矮面板，
  // 等内容填进来面板会长高，若不重排，底部（保存/恢复默认按钮）会掉出窗口之外
  // （桌面全屏透明窗无法滚动到窗口外，用户就点不到保存）。故每次结构变化都重排。
  const anchor =
    Number.isFinite(opts.x) && Number.isFinite(opts.y) ? { x: Number(opts.x), y: Number(opts.y) } : null;
  const layout = (): void => {
    const rect = root.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const left = anchor ? anchor.x : (vw - rect.width) / 2;
    const top = anchor ? anchor.y : (vh - rect.height) / 2;
    root.style.left = Math.max(4, Math.min(left, vw - rect.width - 4)) + 'px';
    root.style.top = Math.max(4, Math.min(top, vh - rect.height - 4)) + 'px';
  };
  layout();
  window.addEventListener('resize', layout);

  const setMsg = (kind: '' | 'ok' | 'err', text: string): void => {
    msg.className = 'dsh-pet-set-msg' + (kind ? ' is-' + kind : '');
    msg.textContent = text;
  };
  const setBusy = (flag: boolean): void => {
    busy = flag;
    saveBtn.disabled = flag;
    resetBtn.disabled = flag;
    notifyBox.disabled = flag;
    for (const el of Array.from(card.querySelectorAll('input,select,button')) as HTMLElement[]) {
      (el as HTMLInputElement).disabled = flag;
    }
  };

  // ---------- 控件工厂 ----------
  const field = (label: string, control: HTMLElement, hint?: string, wide = false): HTMLElement => {
    // 用 div 包裹（label 只允许短语内容，input/select 嵌 div 属非法结构）
    const wrap = document.createElement('div');
    wrap.className = 'dsh-pet-set-field' + (wide ? ' is-wide' : '');
    const lab = document.createElement('span');
    lab.className = 'dsh-pet-set-label';
    lab.textContent = label;
    wrap.appendChild(lab);
    wrap.appendChild(control);
    if (hint) {
      const h = document.createElement('span');
      h.className = 'dsh-pet-set-hint';
      h.textContent = hint;
      wrap.appendChild(h);
    }
    return wrap;
  };

  const textInput = (value: string, onChange: (v: string) => void): HTMLInputElement => {
    const el = document.createElement('input');
    el.type = 'text';
    el.className = 'dsh-pet-set-in';
    el.value = value;
    el.maxLength = 50;
    el.addEventListener('input', () => onChange(el.value));
    return el;
  };

  const numberInput = (value: number, step: number, onChange: (v: number) => void): HTMLInputElement => {
    const el = document.createElement('input');
    el.type = 'number';
    el.step = String(step);
    el.className = 'dsh-pet-set-in';
    el.value = String(value);
    el.addEventListener('input', () => onChange(Number(el.value)));
    return el;
  };

  const selectInput = <T extends string>(
    value: T,
    options: Array<{ value: T; label: string }>,
    onChange: (v: T) => void,
  ): HTMLSelectElement => {
    const el = document.createElement('select');
    el.className = 'dsh-pet-set-in';
    for (const o of options) {
      const opt = document.createElement('option');
      opt.value = o.value;
      opt.textContent = o.label;
      el.appendChild(opt);
    }
    el.value = value;
    el.addEventListener('change', () => onChange(el.value as T));
    return el;
  };

  const checkInput = (checked: boolean, onChange: (v: boolean) => void): HTMLInputElement => {
    const el = document.createElement('input');
    el.type = 'checkbox';
    el.checked = checked;
    el.style.width = '15px';
    el.style.height = '15px';
    el.style.accentColor = '#2b63ff';
    el.addEventListener('change', () => onChange(el.checked));
    return el;
  };

  // ---------- 渲染：宠物标签行 ----------
  const renderTabs = (): void => {
    tabs.textContent = '';
    for (const p of pets) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'dsh-pet-set-tab' + (p.id === selId ? ' is-sel' : '');
      b.textContent = (p.name || p.id) + ' (' + Math.round(p.opacity * 100) + '%)';
      b.addEventListener('click', () => {
        if (busy || p.id === selId) return;
        selId = p.id;
        renderTabs();
        renderCard();
      });
      tabs.appendChild(b);
    }
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'dsh-pet-set-tab is-add';
    add.textContent = '+ 添加宠物';
    add.addEventListener('click', () => {
      if (busy) return;
      const tpl = pets[0];
      if (!tpl) return;
      const id = nextId(pets);
      pets.push({
        id,
        // 新宠物默认名字 = 自己的新 id（与 Web 设置页同语义，避免继承模板名字造成同名）
        name: id,
        size: tpl.size,
        opacity: tpl.opacity,
        balanceEnabled: tpl.balanceEnabled,
        whisperEnabled: tpl.whisperEnabled,
        workStatusEnabled: tpl.workStatusEnabled,
        display: tpl.display,
        position: { ...tpl.position },
      });
      selId = id;
      setMsg('', '');
      renderTabs();
      renderCard();
    });
    tabs.appendChild(add);
  };

  // ---------- 渲染：选中宠物的字段卡片 ----------
  const renderCard = (): void => {
    card.textContent = '';
    const cur = pets.find((p) => p.id === selId);
    if (!cur) {
      const empty = document.createElement('div');
      empty.className = 'dsh-pet-set-note';
      empty.textContent = '暂无宠物，点击「+ 添加宠物」创建。';
      card.appendChild(empty);
      layout();
      return;
    }
    // id 只读展示（程序定位用；改名请改 name——与 Web 设置页同一语义）
    const idText = document.createElement('div');
    idText.className = 'dsh-pet-set-in';
    idText.style.color = '#9aa0a6';
    idText.textContent = cur.id;
    card.appendChild(field('id（程序定位用，不可改）', idText, '改名请用「名字」；id 决定素材目录与记忆文件', false));
    card.appendChild(
      field(
        '名字',
        textInput(cur.name, (v) => (cur.name = v)),
        '悬浮提示 + AI 人设里用这个名字',
      ),
    );
    card.appendChild(
      field(
        '大小（宽度 px）',
        numberInput(cur.size, 10, (v) => (cur.size = v)),
        '高度自动 = 宽度 × 9/16',
      ),
    );
    card.appendChild(
      field(
        '显示位置',
        selectInput(
          cur.display,
          PET_DISPLAYS.map((d) => ({ value: d, label: DISPLAY_LABELS[d] })),
          (v) => (cur.display = v),
        ),
        'web=仅浏览器 / desktop=仅桌面 / both=都显示 / none=都不显示',
      ),
    );

    // 透明度滑杆（10% ~ 100%）：只作用于角色本体，气泡/菜单/弹窗不受影响
    const rangeRow = document.createElement('div');
    rangeRow.className = 'dsh-pet-set-range';
    const range = document.createElement('input');
    range.type = 'range';
    range.min = String(Math.round(OPACITY_MIN * 100));
    range.max = String(Math.round(OPACITY_MAX * 100));
    range.step = '1';
    range.value = String(Math.round(cur.opacity * 100));
    const rangeVal = document.createElement('span');
    rangeVal.textContent = Math.round(cur.opacity * 100) + '%';
    range.addEventListener('input', () => {
      const pct = Number(range.value);
      cur.opacity = clampOpacity(pct / 100);
      rangeVal.textContent = pct + '%';
      // 标签行同步（不重建，避免滑杆失焦）
      const idx = pets.findIndex((p) => p.id === selId);
      const tabEl = tabs.children[idx] as HTMLElement | undefined;
      if (tabEl) tabEl.textContent = (cur.name || cur.id) + ' (' + pct + '%)';
    });
    rangeRow.appendChild(range);
    rangeRow.appendChild(rangeVal);
    card.appendChild(field('角色透明度', rangeRow, '只改变角色本身；气泡/菜单/设置面板保持不透明', true));

    card.appendChild(
      field(
        '位置',
        selectInput(
          cur.position.corner,
          CORNERS.map((c) => ({ value: c, label: CORNER_LABELS[c] })),
          (v) => (cur.position.corner = v),
        ),
      ),
    );
    card.appendChild(
      field(
        '水平偏移 px',
        numberInput(cur.position.marginX, 1, (v) => (cur.position.marginX = v)),
      ),
    );
    card.appendChild(
      field(
        '垂直偏移 px',
        numberInput(cur.position.marginY, 1, (v) => (cur.position.marginY = v)),
      ),
    );

    const checks = document.createElement('div');
    checks.className = 'dsh-pet-set-field is-wide';
    checks.style.gap = '6px';
    checks.appendChild(
      (() => {
        const row = document.createElement('label');
        row.className = 'dsh-pet-set-check';
        row.appendChild(checkInput(cur.balanceEnabled, (v) => (cur.balanceEnabled = v)));
        const s = document.createElement('span');
        s.textContent = '余额功能（触发余额动画并显示余额气泡）';
        row.appendChild(s);
        return row;
      })(),
    );
    checks.appendChild(
      (() => {
        const row = document.createElement('label');
        row.className = 'dsh-pet-set-check';
        row.appendChild(checkInput(cur.whisperEnabled, (v) => (cur.whisperEnabled = v)));
        const s = document.createElement('span');
        s.textContent = '碎碎念（按周期用 AI 生成一句话；会调用当前对话模型）';
        row.appendChild(s);
        return row;
      })(),
    );
    checks.appendChild(
      (() => {
        const row = document.createElement('label');
        row.className = 'dsh-pet-set-check';
        row.appendChild(checkInput(cur.workStatusEnabled, (v) => (cur.workStatusEnabled = v)));
        const s = document.createElement('span');
        s.textContent = '工作状态联动（跟随 DSH 思考/工作/等待/完成/出错切动画；仅监听）';
        row.appendChild(s);
        return row;
      })(),
    );
    card.appendChild(checks);

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'dsh-pet-set-btn is-danger';
    del.style.gridColumn = '1 / -1';
    del.style.justifySelf = 'end';
    del.textContent = '删除该宠物';
    del.addEventListener('click', () => {
      if (busy) return;
      if (pets.length <= 1) {
        setMsg('err', '至少保留一个宠物。');
        return;
      }
      pets = pets.filter((p) => p.id !== selId);
      selId = pets[0].id;
      setMsg('', ''); // 未点保存前不落盘：删除只是面板内的编辑动作
      renderTabs();
      renderCard();
    });
    card.appendChild(del);

    for (const el of Array.from(card.querySelectorAll('input,select,button')) as HTMLElement[]) {
      (el as HTMLInputElement).disabled = busy;
    }
    layout(); // 卡片重建后高度可能变化：重排，保证底部按钮永远在视口内
  };

  /** 校验当前面板内容（与 Web 设置页同一套规则） */
  const validated = (): boolean => {
    for (const p of pets) {
      if (!Number.isFinite(p.size) || p.size <= 0) {
        setMsg('err', '大小需为正数。');
        return false;
      }
      if (!Number.isFinite(p.position.marginX) || !Number.isFinite(p.position.marginY)) {
        setMsg('err', '偏移需为数字。');
        return false;
      }
      if (!Number.isFinite(p.opacity) || p.opacity < OPACITY_MIN || p.opacity > OPACITY_MAX) {
        setMsg('err', '透明度需在 ' + OPACITY_MIN * 100 + '% ~ 100% 之间。');
        return false;
      }
    }
    return true;
  };

  /** 提交体：只发白名单可编辑字段（task 等段由 host 从磁盘原样透传保留） */
  const bodyOf = (): string =>
    JSON.stringify({
      pets: pets.map((p) => ({
        id: p.id,
        name: p.name,
        size: p.size,
        opacity: clampOpacity(p.opacity),
        balanceEnabled: p.balanceEnabled,
        whisperEnabled: p.whisperEnabled,
        workStatusEnabled: p.workStatusEnabled,
        display: p.display,
        position: { ...p.position },
      })),
      notificationsEnabled: notifyEnabled,
    });

  const save = async (): Promise<void> => {
    if (busy) return;
    if (!validated()) return;
    setBusy(true);
    setMsg('', '保存中…');
    try {
      const res = await fetch(configUrl, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: bodyOf(),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      setMsg('ok', '已保存，桌宠即时生效。');
      if (opts.onSaved) opts.onSaved(pets.map((p) => ({ ...p, position: { ...p.position } })));
    } catch (e) {
      setMsg('err', '保存失败：' + String(e && (e as Error).message ? (e as Error).message : e));
    } finally {
      setBusy(false);
    }
  };

  /** 恢复默认：删除整个用户层（含手改的动画池/权重）→ 重新拉成品 */
  const reset = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setMsg('', '恢复中…');
    try {
      const res = await fetch(configUrl, { method: 'DELETE', signal: AbortSignal.timeout(10000) });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      await load();
      setMsg('ok', '已恢复默认配置。');
      if (opts.onSaved) opts.onSaved(pets.map((p) => ({ ...p, position: { ...p.position } })));
    } catch (e) {
      setMsg('err', '恢复默认失败：' + String(e && (e as Error).message ? (e as Error).message : e));
    } finally {
      setBusy(false);
    }
  };

  saveBtn.addEventListener('click', () => void save());
  resetBtn.addEventListener('click', () => void reset());

  /** 拉成品配置 → 只取 main 条目的可编辑宠物（文件宠物只统计条数） */
  const load = async (): Promise<void> => {
    const res = await fetch(configUrl, { cache: 'no-store', signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error('config HTTP ' + res.status);
    const merged = (await res.json()) as Record<string, Record<string, unknown>>;
    const list: SettingsPet[] = [];
    let extra = 0;
    for (const [entry, conf] of Object.entries(merged ?? {})) {
      const rawPets = Array.isArray(conf?.pets) ? (conf.pets as unknown[]) : [];
      if (entry === 'main') {
        for (const raw of rawPets) {
          const p = toEditable(raw);
          if (p) list.push(p);
        }
      } else {
        extra += rawPets.length;
      }
    }
    if (!list.length) throw new Error('配置里没有可编辑的宠物（main 条目为空）');
    pets = list;
    selId = pets[0].id;
    extraCount = extra;
    extraHint.textContent = extraCount
      ? '另 ' +
        extraCount +
        ' 只额外宠物由 pet/ 目录文件定义（<名>-config.json + <名>-animation/），不在此面板编辑——改文件即生效。'
      : '';
    const ne = merged?.main?.notificationsEnabled;
    notifyEnabled = typeof ne === 'boolean' ? ne : notifyEnabled;
    notifyBox.checked = notifyEnabled;
    renderTabs();
    renderCard();
  };

  setBusy(true);
  setMsg('', '加载中…');
  load()
    .then(() => setMsg('', ''))
    .catch((e) => setMsg('err', '加载配置失败：' + String(e && (e as Error).message ? (e as Error).message : e)))
    .finally(() => setBusy(false));

  // ---------- 关闭语义：× / Esc / 点面板外（桌面端面板外点击被窗口穿透，天然不会触发） ----------
  const onDocKeyDown = (e: KeyboardEvent): void => {
    if (closed) return;
    if (e.key === 'Escape') close();
  };
  const onDocPointerDown = (e: MouseEvent): void => {
    if (closed) return;
    if (root.contains(e.target as Node)) return;
    close();
  };
  document.addEventListener('keydown', onDocKeyDown, true);
  document.addEventListener('mousedown', onDocPointerDown, true);

  function close(): void {
    if (closed) return;
    closed = true;
    window.removeEventListener('resize', layout);
    document.removeEventListener('keydown', onDocKeyDown, true);
    document.removeEventListener('mousedown', onDocPointerDown, true);
    root.remove();
    if (opts.onClose) opts.onClose();
  }

  return { el: root, close };
}
