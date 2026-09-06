/**
 * dsh-pet desktop helper renderer —— 启动入口。
 *
 * 依赖链（index.html 顺序加载）：shared-core.js → constants.js → sprite.js →
 * events.js → renderer.js（本文件）。本文件只做：配置加载 / 错误处理 / 启动装配 / 素材注入。
 *
 * 与浏览器 overlay 严格对齐（宠物行为/文案完全一致）：
 *   - 纯逻辑（常量/选择器/移动几何/余额折算/拍平）来自 shared-core.js
 *     （= src/shared 的构建产物，window.PetShared）——与浏览器 bundle 共用同一份源码；
 *   - 配置唯一来源 = 宿主 /dsh-pet-7340/config 的**成品聚合**（host readAllConfig 合并，
 *     绝对正确、字段填满）：一步 fetch → S.flattenConfigPets 拍平，加载失败**大声报错**
 *     并显示红色错误条（每 5s 自动重试），绝无静默兜底池；
 *   - 动画素材经宿主 /dsh-pet-7340/thumb/<素材根>/<name>.webm（素材根 = 条目 key）；
 *   - 几何模型：窗口 = 宠物包围盒 + 四周外扩余量（WINDOW_MARGIN_RATIO，为气泡/弹窗预留空间）。
 *     sprite 固定在窗口内 (margin.l, margin.t) 处，宠物的"移动"由本页把目标屏幕位置
 *     逐帧上报（petBridge.setBounds）→ 主进程按 sprite 位置 + 外扩余量移动窗口；
 *     视口 = 主屏工作区（workAreaW/H 由主进程注入），漫游/角落/位置换算都用它。
 *     外扩区透明且点击穿透（只有身体命中区可交互），不挡下层应用。
 *   - 右键级联菜单（与浏览器共用同一份组件：树+渲染+样式来自 shared-core 的 menu 模块）：
 *     右键宠物弹出，桌面端工具根项「打开网站（系统默认浏览器）/ 查看余额 / 回到初始位置」+ 动作点播；
 *     菜单开启期间整窗保持可交互（悬停菜单不触发穿透翻转），关闭/离开窗口即恢复穿透。
 *   - 系统通知不是宠物行为（浏览器半侧 notify.ts 负责），桌面端不重复实现。
 */
'use strict';

// ---------- 配置（大声报错；失败 5s 重试） ----------
function showError(message) {
  console.error('[dsh-pet] ' + message);
  window.__dshPetDebug.configOk = false;
  errorEl.textContent = 'dsh-pet 配置错误：' + message;
  errorEl.classList.add('visible');
}
function hideError() {
  errorEl.classList.remove('visible');
  errorEl.textContent = '';
}
function scheduleReboot() {
  if (bootTimer) return;
  bootTimer = setTimeout(() => {
    bootTimer = null;
    void boot();
  }, 5000);
}

async function loadConfig() {
  // 唯一配置入口：宿主 /config 的成品聚合（host readAllConfig 已合并并保证绝对正确），
  // 一步拉取 → 拍平成渲染列表，零校验零兜底
  const res = await fetch(BASE + '/config', { cache: 'no-store' });
  if (!res.ok) throw new Error(`config http ${res.status}`);
  const merged = await res.json();
  return {
    pets: S.flattenConfigPets(merged),
    // 主条目周期（余额轮询等全局节奏；合并器已填内置默认）
    refreshSec: (merged && merged.main && merged.main.eventsRefreshSec) || {},
    // 拖拽抛掷物理参数（顶层全局，所有宠物共用；合并器已填内置默认）
    physics: (merged && merged.main && merged.main.physics) || S.DEFAULT_PHYSICS,
  };
}

// ---------- 启动（配置校验通过才建 sprite；失败大声报错 + 5s 自动重试） ----------
async function boot() {
  try {
    const cfg = await loadConfig();
    config = cfg;
    hideError();
    const pets = cfg.pets.filter((p) => S.isDesktopVisible(p.display));
    if (pets.length === 0) {
      showError('配置中没有 display 为 desktop/both 的宠物，桌面模式不显示宠物');
      scheduleReboot();
      return;
    }
    // 本窗口只承载一只宠物：petIndex 由主进程按 DSH_PET_PETS 顺序注入
    const pet = pets[CONFIG.petIndex];
    if (!pet) {
      showError('petIndex=' + CONFIG.petIndex + ' 超出桌面宠物列表（共 ' + pets.length + ' 只），本窗口不创建宠物');
      scheduleReboot();
      return;
    }
    for (const s of sprites) s.dispose();
    sprites = [new PetSprite(pet)];
    window.__dshPetDebug.configOk = true;
    window.__dshPetDebug.spriteCount = sprites.length;
    for (const s of sprites) s.playIdle();
    startLoops();
  } catch (e) {
    showError('配置加载失败：' + (e && e.message ? String(e.message) : String(e)));
    scheduleReboot();
  }
}

// 注入打字资源：气泡字体 + 点击/拖拽光标图标（与浏览器 overlay 同一套素材，host 经 /dsh-pet-7340/ 提供）
function injectAssets() {
  const style = document.createElement('style');
  style.textContent =
    '@font-face{font-family:"ShangshouSoftCandy";src:url("' +
    BASE +
    '/font/' +
    encodeURIComponent('上首软糖体') +
    '.ttf") format("truetype");font-display:swap;font-weight:400}' +
    '.pet-hit{cursor:url("' +
    BASE +
    '/pic/cursor-grab.png") 16 16, grab}' +
    '.pet-hit.dragging{cursor:url("' +
    BASE +
    '/pic/cursor-grabbing.png") 16 16, grabbing}';
  document.head.appendChild(style);
  // 统一右键菜单样式（与浏览器注入同一份 MENU_CSS）
  const menuStyle = document.createElement('style');
  menuStyle.textContent = S.MENU_CSS;
  document.head.appendChild(menuStyle);
}

// 任务对话窗模式：全屏透明窗只承载任务对话框（共享组件与浏览器/宠物窗内联版同一份）
if (DIALOG) {
  injectAssets();
  const petId = DIALOG_PET;
  const petName = DIALOG_PET_NAME;
  const anchorX0 = Number(params.get('anchorX') || '0');
  const anchorY0 = Number(params.get('anchorY') || '0');
  const anchorWinX0 = Number(params.get('anchorWinX') || '0');
  const anchorWinY0 = Number(params.get('anchorWinY') || '0');
  // 屏幕坐标锚点（随宠物窗口位置变化而移动：窗口坐标变化量叠加到初始锚点）
  let anchor = Number.isFinite(anchorX0) && Number.isFinite(anchorY0) ? { x: anchorX0, y: anchorY0 } : null;
  window.petBridge.onPetBounds((b) => {
    const winX = Number(b && b.winX);
    const winY = Number(b && b.winY);
    if (!anchor || !Number.isFinite(winX) || !Number.isFinite(winY)) return;
    anchor = { x: anchorX0 + (winX - anchorWinX0), y: anchorY0 + (winY - anchorWinY0) };
  });
  // 屏幕坐标 → 本窗视口坐标（全屏窗内容区起点 = 主屏工作区原点）
  const toViewport = (p) => ({ x: p.x - window.screenX, y: p.y - window.screenY });
  const m = S.mountTaskDialog({
    petId,
    petName,
    baseUrl: BASE,
    x: anchor ? toViewport(anchor).x : 200,
    y: anchor ? toViewport(anchor).y : 160,
    anchor: anchor ? () => toViewport(anchor) : undefined,
    // 「查看历史」：系统默认浏览器打开 DSH Web，带 petTaskSession 深链参数（浏览器端宠物插件自动选中该会话）
    openHistory: (sessionId) => {
      const url = ORIGIN + '/?petTaskSession=' + (sessionId ? encodeURIComponent(sessionId) : '');
      window.petBridge.openDshSite(url);
    },
    onClose: () => {
      window.petBridge.closeTaskDialog({ petId });
    },
  });
  // 点击穿透翻转：光标悬停对话框 → 可交互（能点选/打字）；离开 → 全窗穿透（透明区域不挡下层应用）
  m.el.addEventListener('mouseenter', () => window.petBridge.setInteractive(true));
  m.el.addEventListener('mouseleave', () => window.petBridge.setInteractive(false));
} else {
  // 工作区尺寸由主进程注入并在进程生命周期内不变；窗口本身跟随宠物移动，
  // 这里仍兜底处理窗口内容区尺寸异常的情况（按当前窗口位置重新规整）。
  window.addEventListener('resize', () => {
    for (const s of sprites) s.position();
  });

  injectAssets();
  void boot();
}
