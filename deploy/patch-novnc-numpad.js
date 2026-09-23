#!/usr/bin/env node
// noVNC 数字小键盘修复（2026-09-23，geo-ui-browser 部署补丁）
//
// 现象：登录窗口里「左侧主键盘数字可输入、右侧数字小键盘没反应」。
// 根因：noVNC 对数字小键盘发送 KP_0..KP_9 这类 keysym；远端 Xvfb 的 NumLock 默认关闭，
//       小键盘 keysym 被解释为 Home/End/方向键等导航键 → 输入框"没反应"。
//       主键盘数字发的是标准 keysym（XK_0..XK_9），不受 NumLock 影响，所以正常。
// 修复：把 domkeytable.js 里数字小键盘的 keysym 从 KP_* 改为标准数字 keysym，
//       与远端 NumLock 状态彻底解耦（小键盘与主键盘行为一致，恒输入数字）。
//
// 幂等：已打过补丁时替换计数为 0，直接跳过不重复改。
const fs = require('fs');
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
console.log(`[novnc-patch] numpad digits -> standard keysyms, replaced ${total} (expect 11)`);
if (total !== 11) {
  console.warn('[novnc-patch] ⚠️ 替换数不是 11，请检查 noVNC 版本是否变化（继续构建，但补丁可能未完全生效）');
}
