/**
 * dsh-pet 宿主半侧 —— 重启更新桥（update bridge）。
 *
 * 「harness coat」的启动检测 check-update.ps1 把"DSH 本体是否有更新"落成
 * <coat>/update-check.json；本模块把它暴露给两端右键菜单：
 *   - update/status   → 启动检测结果（available=true 才显示「重启更新」菜单项）
 *   - update/restart  → 拉起 <coat>/restart-dsh-update.ps1（独立 PowerShell 控制台：
 *     关闭 DSH → git fetch/rebase 更新本体 → 重新启动；进度显示在该窗口。
 *     只更新 DSH 本体，不碰 dsh-pet 插件）
 *
 * coat 根目录推导：DSH 由 Start-DSH-Web.bat 以 <coat>/deepseek-harness 为 cwd 启动，
 * 故 dirname(process.cwd()) 即 coat 根；DSH_PET_COAT_DIR 环境变量可显式覆盖。
 * 自包含（不 import src/shared —— DSH 单文件加载约束）。
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

/** 更新路由应答（与 host/index.ts 的 RouteResult 结构兼容；更新路由不返回文件） */
export type UpdateRouteResult =
  | { kind: 'json'; status: number; obj: unknown; headers?: Record<string, string> }
  | { kind: 'text'; status: number; body: string };

/** 更新桥返回值：route 供 handlePetRoute 挂载 */
export interface UpdateBridge {
  route: (rest: string, method: string) => Promise<UpdateRouteResult>;
}

function json(status: number, obj: unknown, headers?: Record<string, string>): UpdateRouteResult {
  return { kind: 'json', status, obj, headers };
}

/** coat 根目录候选（环境变量覆盖优先，其次按 bat 启动约定推导） */
function coatDirCandidates(): string[] {
  const out: string[] = [];
  const env = process.env.DSH_PET_COAT_DIR;
  if (env && env.trim()) out.push(resolve(env.trim()));
  const cwd = process.cwd();
  out.push(dirname(cwd)); // Start-DSH-Web.bat 的 cwd = <coat>/deepseek-harness → 上一级即 coat
  out.push(cwd);
  return out;
}

/** 在 coat 根候选目录里找第一个存在的文件 */
function findCoatFile(name: string): string | undefined {
  for (const dir of coatDirCandidates()) {
    const p = join(dir, name);
    if (existsSync(p)) return p;
  }
  return undefined;
}

/** 创建更新桥：/update/status（读启动检测状态）+ /update/restart（拉起重启更新脚本） */
export function createUpdateBridge(): UpdateBridge {
  const route = async (rest: string, method: string): Promise<UpdateRouteResult> => {
    if (rest === 'update/status') {
      if (method !== 'GET') return json(405, { error: 'method not allowed' });
      const file = findCoatFile('update-check.json');
      if (!file) return json(200, { ok: true, available: false, reason: 'no-check-file' });
      try {
        const raw = await readFile(file, 'utf8');
        const parsed = JSON.parse(raw.replace(/^\uFEFF/, '')) as Record<string, unknown>;
        return json(
          200,
          {
            ok: true,
            available: parsed.available === true,
            local: typeof parsed.local === 'string' ? parsed.local : '',
            upstream: typeof parsed.upstream === 'string' ? parsed.upstream : '',
            checkedAt: typeof parsed.checkedAt === 'string' ? parsed.checkedAt : '',
          },
          { 'cache-control': 'no-cache, no-store' },
        );
      } catch {
        return json(200, { ok: true, available: false, reason: 'state-unreadable' });
      }
    }

    if (rest === 'update/restart') {
      if (method !== 'POST') return json(405, { error: 'method not allowed' });
      const script = findCoatFile('restart-dsh-update.ps1');
      if (!script) {
        return json(500, {
          ok: false,
          message: 'restart-dsh-update.ps1 not found (expected in the harness coat folder)',
        });
      }
      try {
        // 独立控制台窗口（cmd start → powershell）：DSH 数秒后被脚本关闭时更新脚本不受牵连，
        // 进度（git fetch/rebase 输出）显示在该 PowerShell 窗口
        const child = spawn(
          process.env.ComSpec ?? 'cmd.exe',
          [
            '/c',
            'start',
            '""',
            'powershell.exe',
            '-NoProfile',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            '"' + script + '"',
          ],
          { detached: true, stdio: 'ignore', windowsHide: false },
        );
        child.unref();
        return json(200, { ok: true });
      } catch (e) {
        return json(500, { ok: false, message: e instanceof Error ? e.message : String(e) });
      }
    }

    return json(404, { error: 'unknown update route: ' + rest });
  };

  return { route };
}
