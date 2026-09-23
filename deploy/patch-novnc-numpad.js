#!/usr/bin/env node
// noVNC 数字小键盘修复（2026-09-23，geo-ui-browser 部署补丁）
//
// 现象：登录窗口里「左侧主键盘数字可输入、右侧数字小键盘没反应/像方向移动」。
// 根因有两层：
//   1) noVNC 对数字小键盘发送 KP_0..KP_9 keysym；容器 Xvfb 的 NumLock 默认关闭，
//      远端 Chrome 把小键盘 keysym 解释成 Home/End/方向键 → 输入框"没反应"。
//      （主键盘数字发标准 keysym，不受 NumLock 影响，所以正常。）
//   2) 本机 NumLock 关闭时，浏览器把小键盘 1 报告成 key='End'、8 报告成 'ArrowUp'，
//      noVNC 按 key 查表 → 发方向 keysym → 远端"方向移动"。
// 修复：
//   A. domkeytable.js：数字小键盘 keysym 从 KP_* 改为标准数字 keysym（处理 key='1' 分支）。
//   B. util.js getKeysym：按 code 优先判断，Numpad0-9 / NumpadDecimal 无论 key 是什么
//      一律发标准数字 keysym（处理本机 NumLock 关闭、key='End'/'ArrowUp' 分支）。
// 双管齐下，与两端 NumLock 状态彻底解耦——小键盘与主键盘行为一致，恒输入数字。
//
// 幂等：已打过补丁时跳过，不重复改。
const fs = require('fs');

// ---------- A. domkeytable.js ----------
const f = '/usr/share/novnc/core/input/domkeytable.js';
let s = fs.readFileSync(f, 'utf8');
const map = {
  '0': '0', '1': '1', '2': '2', '3': '3', '4': '4',
  '5': '5', '6': '6', '7': '7', '8': '8', '9': '9',
  'Decimal': 'period',
};
let total = 0;
for (const k in map) {
  const pat = new RegExp('KeyTable\\.XK_KP_' + k + '\\)', 'g');
  const before = s;
  s = s.replace(pat, 'KeyTable.XK_' + map[k] + ')');
  total += (before.match(pat) || []).length;
}
fs.writeFileSync(f, s);
console.log(`[novnc-patch] domkeytable.js numpad digits -> standard keysyms, replaced ${total} (expect 11)`);
if (total !== 11) {
  console.warn('[novnc-patch] ⚠️ 替换数不是 11，请检查 noVNC 版本是否变化（继续构建，但补丁可能未完全生效）');
}

// ---------- B. util.js getKeysym code-first ----------
const f2 = '/usr/share/novnc/core/input/util.js';
let u = fs.readFileSync(f2, 'utf8');
const anchor = 'export function getKeysym(evt){';
const inject =
  'export function getKeysym(evt){\n' +
  '    // [geo-ui-browser] 数字小键盘按 code 优先发标准数字 keysym，与两端 NumLock 状态解耦\n' +
  '    //（本机 NumLock 关闭时浏览器把 Numpad1 报告成 key=\'End\'，按 key 查表会发方向键）\n' +
  '    if (evt.code && evt.code.indexOf(\'Numpad\') === 0) {\n' +
  '        var d = evt.code.slice(6);\n' +
  '        if (/^[0-9]$/.test(d)) { return KeyTable[\'XK_\' + d]; }\n' +
  '        if (d === \'Decimal\') { return KeyTable.XK_period; }\n' +
  '    }\n';
if (u.indexOf('[geo-ui-browser]') === -1) {
  u = u.replace(anchor, inject);
  fs.writeFileSync(f2, u);
  console.log('[novnc-patch] util.js getKeysym code-first numpad -> injected');
} else {
  console.log('[novnc-patch] util.js already patched, skip');
}
