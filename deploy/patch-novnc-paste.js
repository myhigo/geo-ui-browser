#!/usr/bin/env node
// noVNC 一键粘贴修复（2026-09-23，geo-ui-browser 部署补丁）
//
// 现象：登录 iframe（noVNC）里无法粘贴，只能手输账号密码。
// 根因：Debian 版 noVNC 未监听浏览器 paste 事件自动上传剪贴板，
//       只有左侧剪贴板面板（手动点开 → 粘贴 → send）一条路。
// 修复：在 ui.js 注入 document 级 paste 监听——
//       本地在 noVNC 页面按 Ctrl+V 时：
//         1) clipboardPasteFrom(text) 把文本通过 VNC Clipboard 伪编码发给远端 X 剪贴板
//            （x11vnc 已带 XFIXES，支持接收）；
//         2) sendKey 自动在远端按一次 Ctrl+V，把文本直接粘进当前聚焦的输入框。
//       一次本地 Ctrl+V 即完成"粘贴"，无需手输，也不用两次手动操作。
// 排除项：焦点在 noVNC 面板输入框/textarea 时不拦截（保留面板原有粘贴行为）。
//
// 幂等：marker 已存在则跳过。
const fs = require('fs');

const f = '/usr/share/novnc/app/ui.js';
let s = fs.readFileSync(f, 'utf8');
const marker = '/* geo-paste-auto */';
if (s.includes(marker)) {
  console.log('[novnc-patch] paste-auto already injected, skip');
  process.exit(0);
}
const code = `
/* geo-paste-auto: 本地 Ctrl+V → 远端剪贴板 + 自动远端 Ctrl+V（2026-09-23） */
document.addEventListener('paste', function (geoPasteEv) {
  var tg = geoPasteEv.target;
  if (tg && (tg.tagName === 'TEXTAREA' || tg.tagName === 'INPUT')) return;
  var d = geoPasteEv.clipboardData || {};
  var t = (typeof d.getData === 'function') ? d.getData('text/plain') : '';
  if (!t || !UI.rfb || UI.rfb._rfb_connection_state !== 'connected') return;
  geoPasteEv.preventDefault();
  UI.rfb.clipboardPasteFrom(t);
  UI.rfb.sendKey(0xffe3, 'ControlLeft', true);
  UI.rfb.sendKey(0x76, 'KeyV', true);
  UI.rfb.sendKey(0x76, 'KeyV', false);
  UI.rfb.sendKey(0xffe3, 'ControlLeft', false);
});
`;
s = s + code;
fs.writeFileSync(f, s);
console.log('[novnc-patch] paste-auto injected into ui.js');
