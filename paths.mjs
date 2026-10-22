// paths.mjs — 资源目录（只读，随安装包）与用户数据目录（可写，打包后在 %APPDATA%）
// 兼容三种运行方式：打包版 Electron / 开发态 Electron / 纯 Node CLI
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

// 只读资源根：安装目录（asar 关闭，PowerShell 脚本/类目表可直接读取）
export const RES_DIR = path.dirname(fileURLToPath(import.meta.url));

const APP_NAME = 'wawa-unified-studio';

// 打包判定：进程不是 electron.exe/node.exe 且带 resources 目录
export function isPackaged() {
  if (!process.resourcesPath) return false;
  const exe = path.basename(process.execPath).toLowerCase();
  return exe !== 'electron.exe' && exe !== 'node.exe';
}

let _user = null;
// 可写根：打包版 → %APPDATA%\蛙蛙投稿工具；开发态 → 项目目录（行为与旧版一致）
export function userBase() {
  if (_user) return _user;
  _user = process.env.WAWAWA_DATA_DIR || (isPackaged()
    ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), APP_NAME)
    : RES_DIR);
  fs.mkdirSync(_user, { recursive: true });
  return _user;
}

export const userPath = (...p) => path.join(userBase(), ...p);
