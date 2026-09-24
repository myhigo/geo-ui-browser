#!/usr/bin/env node
// noVNC 一键粘贴修复 v2（2026-09-24，geo-ui-browser 部署补丁）
//
// 现象：登录 iframe（noVNC）里无法粘贴，只能手输账号密码。
// 根因 v1 教训：document 级 paste 监听只在焦点位于页面可编辑区域时触发；
//       用户实际操作是焦点在 noVNC 画布（canvas）内按 Ctrl+V，
//       浏览器不派发 paste 事件 → 监听永远不触发 → 粘贴无反应。
// v2 方案：在 vnc.html 注入一个常驻「粘贴条」（右下角输入框）：
//       用户点击粘贴条输入框 → 焦点在本地 INPUT → 浏览器原生 Ctrl+V 必然成功
//       → 脚本读 clipboardData → clipboardPasteFrom 写入远端 X 剪贴板
//       （x11vnc XFIXES 接收）→ sendKey 自动在远端按一次 Ctrl+V 粘进当前输入框。
//       完全绕开 canvas 焦点与浏览器剪贴板权限问题。
// 同时保留 v1 的 document paste 监听（焦点落在非输入区时 Ctrl+V 也自动粘贴）。
//
// 幂等：marker 已存在则跳过。
const fs = require('fs');

// ── 1) ui.js：保留 v1 document 级 paste 监听 ────────────────────────────────
const uif = '/usr/share/novnc/app/ui.js';
let s = fs.readFileSync(uif, 'utf8');
const uiMarker = '/* geo-paste-auto */';
if (!s.includes(uiMarker)) {
  const code = `
/* geo-paste-auto: 本地 Ctrl+V → 远端剪贴板 + 自动远端 Ctrl+V（2026-09-24 v2） */
/* noVNC 的 UI 是 ES 模块内对象，不挂 window；暴露钩子供 vnc.html 全局脚本取 rfb */
if (!window.__geoGetRfb) {
  window.__geoGetRfb = function () { return UI && UI.rfb ? UI.rfb : null; };
}
document.addEventListener('paste', function (geoPasteEv) {
  var tg = geoPasteEv.target;
  if (tg && (tg.tagName === 'TEXTAREA' || tg.tagName === 'INPUT')) return;
  var d = geoPasteEv.clipboardData || {};
  var t = (typeof d.getData === 'function') ? d.getData('text/plain') : '';
  var rfb = window.__geoGetRfb ? window.__geoGetRfb() : null;
  if (!t || !rfb || rfb._rfb_connection_state !== 'connected') return;
  geoPasteEv.preventDefault();
  rfb.clipboardPasteFrom(t);
  rfb.sendKey(0xffe3, 'ControlLeft', true);
  rfb.sendKey(0x76, 'KeyV', true);
  rfb.sendKey(0x76, 'KeyV', false);
  rfb.sendKey(0xffe3, 'ControlLeft', false);
});
`;
  s = s + code;
  fs.writeFileSync(uif, s);
  console.log('[novnc-patch] ui.js paste-auto injected');
} else {
  console.log('[novnc-patch] ui.js paste-auto already injected, skip');
}

// ── 2) vnc.html：注入常驻粘贴条 ─────────────────────────────────────────────
const htmlf = '/usr/share/novnc/vnc.html';
let h = fs.readFileSync(htmlf, 'utf8');
const barMarker = 'geo-paste-bar';
if (!h.includes(barMarker)) {
  const bar = `
<!-- geo-paste-bar: 一键粘贴条（2026-09-24 v2） -->
<div id="geo-paste-bar" style="position:fixed;right:12px;bottom:12px;z-index:2147483647;display:flex;align-items:center;gap:6px;background:rgba(28,28,30,.94);border:1px solid #5a5a5f;border-radius:20px;padding:5px 10px;box-shadow:0 2px 12px rgba(0,0,0,.45);font-size:12px;color:#bbb;cursor:pointer;" title="点这里，再按 Cmd/Ctrl+V 粘贴">
  <span id="geo-paste-tip">粘贴：</span>
  <input id="geo-paste-in" placeholder="点击后 Ctrl+V" style="width:240px;max-width:38vw;background:#1c1c1e;color:#eee;border:1px solid #5a5a5f;border-radius:14px;padding:4px 10px;font-size:13px;outline:none;cursor:text;" autocomplete="off" spellcheck="false">
  <button id="geo-paste-send" style="background:#3a6ff7;color:#fff;border:0;border-radius:14px;padding:4px 12px;font-size:13px;cursor:pointer;white-space:nowrap;">发送</button>
</div>
`;
  h = h.replace('</body>', bar + '</body>');
  const script = `
<script>
/* geo-paste-bar JS（2026-09-24 v2） */
(function(){
  var bar = document.getElementById('geo-paste-bar');
  var input = document.getElementById('geo-paste-in');
  if (!input) return;
  /* 点击条子任意位置 → 聚焦输入框（避免点到空白处没反应） */
  if (bar) bar.addEventListener('click', function (e) { if (e.target !== input) input.focus(); });
  function connected(){
    var rfb = (typeof window.__geoGetRfb === 'function') ? window.__geoGetRfb() : null;
    return !!(rfb && rfb._rfb_connection_state && rfb._rfb_connection_state === 'connected');
  }
  var tipEl = document.getElementById('geo-paste-tip');
  function tipShow(txt, color){
    if (tipEl) { tipEl.textContent = txt; tipEl.style.color = color || '#4ade80'; }
    setTimeout(function(){
      if (tipEl) { tipEl.textContent = '粘贴：'; tipEl.style.color = '#bbb'; }
      input.placeholder = '点击后 Ctrl+V';
    }, 2500);
  }
  function send(t){
    t = (t || '').trim();
    if (!t) { tipShow('内容为空', '#fbbf24'); return; }
    if (!connected()){
      tipShow('未连接', '#f87171');
      return;
    }
    try {
      var rfb = window.__geoGetRfb ? window.__geoGetRfb() : null;
      rfb.clipboardPasteFrom(t);
      rfb.sendKey(0xffe3, 'ControlLeft', true);
      rfb.sendKey(0x76, 'KeyV', true);
      rfb.sendKey(0x76, 'KeyV', false);
      rfb.sendKey(0xffe3, 'ControlLeft', false);
      input.value = '';
      tipShow('✓ 已发送');
    } catch (e) {
      tipShow('发送失败', '#f87171');
    }
  }
  /* 粘贴进输入框后不自动发送，等用户点「发送」（内容可先检查） */
  input.addEventListener('paste', function(){ /* 内容已由浏览器填入 input */ });
  var sendBtn = document.getElementById('geo-paste-send');
  function doSend(){ send(input.value); }
  if (sendBtn) sendBtn.addEventListener('click', doSend);
  input.addEventListener('keydown', function(e){
    if (e.key === 'Enter') { doSend(); e.preventDefault(); }
  });
  /* 兜底：焦点不在输入框时按 Cmd/Ctrl+V → 尝试读剪贴板直达；读不到则聚焦粘贴框引导再按一次 */
  document.addEventListener('keydown', function (e) {
    var mod = e.metaKey || e.ctrlKey;
    if (!mod) return;
    var k = (e.key || '').toLowerCase();
    if (k !== 'v') return;
    var tg = e.target;
    if (tg && (tg.tagName === 'INPUT' || tg.tagName === 'TEXTAREA' || tg.isContentEditable)) return;
    e.preventDefault();
    function fallback(){
      input.focus();
      input.placeholder = '请再按一次 Cmd/Ctrl+V';
      setTimeout(function(){ input.placeholder = '点击后 Ctrl+V'; }, 3000);
    }
    try {
      if (navigator.clipboard && navigator.clipboard.readText) {
        navigator.clipboard.readText().then(function (t) {
          if (t) { input.value = t; input.focus(); }
          else fallback();
        }).catch(fallback);
        return;
      }
    } catch (err) {}
    fallback();
  });
})();
</script>
`;
  h = h.replace('</body>', script + '</body>');
  fs.writeFileSync(htmlf, h);
  console.log('[novnc-patch] vnc.html paste-bar injected');
} else {
  console.log('[novnc-patch] vnc.html paste-bar already injected, skip');
}
