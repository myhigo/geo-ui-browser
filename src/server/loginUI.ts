// 平台登录管理页（多账号版，极简无外部依赖）。入口 GET /admin。
// 每个账号一张卡：状态/账号号/备注 + 昵称·今日查询·最近使用（两列网格）+ 代理选择 + 启停/备注/测试/删除。
// 配置了 GEO_NOVNC_URL 时，有账号处于「登录中」会内嵌 noVNC 窗口供人工扫码 / 输入验证码。
import { config } from '../config/index.js';

export function adminPageHtml(): string {
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>控制台</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: system-ui, -apple-system, sans-serif; background: #f6f7f9; color: #1f2329; display: flex; min-height: 100vh; }
  aside { width: 170px; background: #fff; border-right: 1px solid #e5e6eb; padding: 16px 10px; flex: none; }
  aside h1 { font-size: 14px; font-weight: 600; padding: 0 8px 12px; }
  .menu-item { display: block; width: 100%; text-align: left; padding: 8px 12px; border: 0; border-radius: 6px; background: none; font-size: 13px; cursor: pointer; margin-bottom: 4px; color: #4e5969; }
  .menu-item:hover { background: #f2f3f5; }
  .menu-item.on { background: #e8f3ff; color: #165dff; font-weight: 500; }
  main { flex: 1; padding: 24px 28px; max-width: 980px; }
  h2 { font-size: 16px; font-weight: 600; margin: 4px 0 14px; }
  .acc { background: #fff; border: 1px solid #e5e6eb; border-radius: 10px; padding: 16px 20px; margin-bottom: 14px; }
  .acc-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 14px; align-items: start; }
  .acc-grid > .acc { margin-bottom: 0; }
  .acc-top { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .acc-id { font-size: 13px; color: #4e5969; font-family: ui-monospace, monospace; }
  .acc-remark { font-size: 14px; font-weight: 500; }
  .dot { width: 9px; height: 9px; border-radius: 50%; display: inline-block; margin-right: 6px; }
  .st-active { background: #00b42a; } .st-waiting { background: #ff7d00; } .st-failed { background: #f53f3f; } .st-none { background: #c9cdd4; } .st-cooling { background: #ff7d00; }
  .st-label { font-size: 13px; color: #1f2329; }
  .meta { font-size: 12px; color: #86909c; margin-top: 8px; line-height: 1.8; }
  .meta b { color: #4e5969; font-weight: 500; }
  /* 账号卡片：标签左、值右。值列用 minmax(0,1fr) 保证长内容在列内换行而不撑破卡片 */
  .acc-info { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 4px 10px; margin-top: 10px; font-size: 12px; align-items: baseline; }
  .acc-info b { color: #4e5969; font-weight: 500; word-break: break-all; }
  .acc-row { display: flex; align-items: center; gap: 8px; margin-top: 10px; font-size: 12px; flex-wrap: wrap; }
  /* 卡片最窄约 240px，下拉必须能收缩，否则会顶破卡片导致整片错行 */
  .acc-row .proxy-sel { flex: 1 1 auto; min-width: 0; max-width: 100%; }
  .k { color: #86909c; white-space: nowrap; }
  .note { font-size: 12px; color: #e02020; margin-top: 6px; }
  .btns { margin-top: 12px; display: flex; gap: 8px; flex-wrap: wrap; }
  .btns .right { margin-left: auto; }
  button { background: #fff; border: 1px solid #c9cdd4; color: #4e5969; border-radius: 6px; padding: 7px 16px; font-size: 13px; cursor: pointer; }
  button:hover { border-color: #165dff; color: #165dff; }
  button.primary { background: #165dff; border-color: #165dff; color: #fff; }
  button.primary:hover { background: #0e42d2; }
  button.danger:hover { border-color: #f53f3f; color: #f53f3f; }
  button:disabled { opacity: .5; cursor: not-allowed; }
  .plat-tab { background: #fff; border: 1px solid #c9cdd4; color: #4e5969; border-radius: 6px; padding: 6px 16px; font-size: 13px; cursor: pointer; }
  .plat-tab:hover { border-color: #165dff; color: #165dff; }
  .plat-tab.on { background: #e8f3ff; border-color: #165dff; color: #165dff; font-weight: 500; }
  select.proxy-sel { padding: 5px 8px; border: 1px solid #c9cdd4; border-radius: 6px; font-size: 12px; color: #1f2329; background: #fff; max-width: 260px; }
  select.proxy-sel:focus { outline: none; border-color: #165dff; }
  a.btn { display: inline-block; background: #fff; border: 1px solid #c9cdd4; color: #4e5969; border-radius: 6px; padding: 6px 14px; font-size: 13px; text-decoration: none; }
  a.btn:hover { border-color: #165dff; color: #165dff; }
  a.btn.primary { background: #165dff; border-color: #165dff; color: #fff; }
  table.src { width: 100%; border-collapse: collapse; font-size: 13px; }
  table.src th { color: #86909c; font-weight: 400; text-align: left; padding: 6px 8px; border-bottom: 1px solid #e5e6eb; }
  table.src td { padding: 6px 8px; border-bottom: 1px solid #f2f3f5; }
  textarea.inp { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; line-height: 1.7; resize: vertical; }
  .hint { font-size: 12px; color: #86909c; background: #f7f8fa; border-radius: 6px; padding: 10px 12px; line-height: 1.7; margin: 14px 0; }
  .inp { padding: 8px 10px; border: 1px solid #c9cdd4; border-radius: 6px; font-size: 13px; color: #1f2329; background: #fff; }
  .inp:focus { outline: none; border-color: #165dff; }
  .empty { color: #86909c; font-size: 13px; padding: 10px 0; }
  .toast { position: fixed; top: 18px; left: 50%; transform: translateX(-50%); background: #1f2329; color: #fff; padding: 8px 16px; border-radius: 6px; font-size: 13px; opacity: 0; transition: opacity .25s; pointer-events: none; z-index: 9; }
  .toast.show { opacity: 1; }
</style>
</head>
<body>
<aside>
  <h1>控制台</h1>
  <div id="menu"></div>
</aside>
<main id="panel"><div style="color:#86909c;font-size:13px;">加载中…</div></main>
<div id="toast" class="toast"></div>
<script>
var CUR = null, POLL = null, SA_LAST = '', TESTPOLL = null;
// 账号管理页当前选中的平台（2026-09-22 菜单改版：平台从侧边菜单移到账号管理页顶部 tab）
var ACC_PLATFORM = null;
// 代理冷却间隔（秒），展示用（服务端 GEO_IP_INTERVAL）
var IP_INTERVAL = ${JSON.stringify(config.ipIntervalSec)};
// 收录检测勾「开启浏览器」时弹出的 noVNC 标签页引用 + 任务结束标记（结束后自动关标签页）
var PULL_WIN = null, PULL_ENDED = false;
// 已构建面板的结构标识："<平台>|<有无登录窗口>"。用于避免轮询时整块重建
var PANEL_KEY = null;
var NOVNC_URL = ${JSON.stringify(config.novncUrl)};
var BASE = ${JSON.stringify(config.basePath)};
function api(p){ return (BASE || '') + p; }
var ST = { none:{t:'未登录',c:'#c9cdd4'}, waiting:{t:'登录中',c:'#ff7d00'}, active:{t:'已登录',c:'#00b42a'}, cooling:{t:'冷却中',c:'#ff7d00'}, failed:{t:'不可用',c:'#f53f3f'} };
function $(s){ return document.querySelector(s); }
function toast(m){ var t=$('#toast'); t.textContent=m; t.classList.add('show'); setTimeout(function(){ t.classList.remove('show'); }, 2400); }
function esc(x){ return String(x==null?'':x).replace(/[&<>"]/g, function(ch){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[ch]; }); }
// 紧凑时间：MM-DD HH:mm。卡片窄，完整 toLocaleString（含秒）太长会撑破布局
function fmtTime(ts){ var d=new Date(ts); var p=function(n){ return n<10?'0'+n:''+n; }; return p(d.getMonth()+1)+'-'+p(d.getDate())+' '+p(d.getHours())+':'+p(d.getMinutes()); }
// 2026-09-22 菜单四项定稿：代理管理 / 账号管理 / 信源分析 / 收录检测（平台移到账号管理页顶部 tab）
function menu(platforms){
  var items = [
    {id:'__proxies', label:'代理管理'},
    {id:'__accounts', label:'账号管理'},
    {id:'__sources', label:'信源分析'},
    {id:'__pull', label:'收录检测'}
  ];
  $('#menu').innerHTML = items.map(function(it){ return '<button class="menu-item'+(CUR===it.id?' on':'')+'" data-id="'+it.id+'">'+it.label+'</button>'; }).join('');
  Array.prototype.forEach.call(document.querySelectorAll('.menu-item'), function(b){ b.onclick=function(){ CUR=b.dataset.id; menu(platforms); render(); }; });
}
function render(){
  if(TESTPOLL){ clearInterval(TESTPOLL); TESTPOLL=null; }
  if(CUR==='__proxies'){ renderProxies(); return; }
  if(CUR==='__pull'){ renderPull(); return; }
  if(CUR==='__sources'){ renderSources(); return; }
  if(CUR==='__accounts'){ renderAccounts(); return; }
  if(!CUR) return;
}
// 账号管理页（2026-09-22 改版：平台在页面顶部 tab，点击切换；菜单只保留四大项）
function renderAccounts(){
  if(TESTPOLL){ clearInterval(TESTPOLL); TESTPOLL=null; }
  Promise.all([
    fetch(api('/api/login/platforms')).then(function(r){ return r.json(); }),
    fetch(api('/api/proxies')).then(function(r){ return r.json(); }).catch(function(){ return {proxies:[]}; })
  ]).then(function(arr){
    var d = arr[0]; var PROXIES = (arr[1]&&arr[1].proxies)||[];
    var plats = d.platforms||[];
    if(!ACC_PLATFORM || !plats.some(function(x){ return x.platformId===ACC_PLATFORM; })) ACC_PLATFORM = plats.length ? plats[0].platformId : null;
    if(!ACC_PLATFORM){ $('#panel').innerHTML='<h2>账号管理</h2><div class="empty">暂无平台。</div>'; return; }
    var p = plats.filter(function(x){ return x.platformId===ACC_PLATFORM; })[0];
    if(!p) return;
    menu(plats);
    // 账号 → 代理绑定下拉（2026-09-22 新增；换绑后账号需重新登录，由后端处理）
    var proxySelHtml = function(a){
      var cur = a.proxyId||0;
      var opts = '<option value="0">不绑代理（不参与调度）</option>'
        + PROXIES.filter(function(x){ return x.enabled!==false || cur===x.id; }).map(function(x){
          // 与代理管理页保持一致：以 port===0 判直连，标签显示 IP 而非"宿主机"
          var isDirect = x.port===0;
          var label = isDirect ? esc(x.host)+'（直连）' : esc(x.host)+':'+x.port+'（'+x.protocol+'）';
          return '<option value="'+x.id+'"'+(cur===x.id?' selected':'')+'>'+label+'</option>';
        }).join('');
      return '<select class="proxy-sel" data-acc="'+esc(a.id)+'">'+opts+'</select>';
    };
    // 是否需要内嵌 noVNC iframe：仅登录窗口（waiting）嵌在页面里；
    // 测试窗口改为弹出独立窗口（见 syncTestButtons），不嵌 iframe。
    var needLogin = p.accounts.some(function(a){ return a.status==='waiting'; });
    var needVnc = !!(NOVNC_URL && needLogin);

    // —— 账号卡片（每次刷新）——
    var accHtml;
    if(!p.accounts.length){
      accHtml = '<div class="empty">还没有账号，点右上角「添加账号登录」开第一个号。</div>';
    } else {
      accHtml = '<div class="acc-grid">';
      p.accounts.forEach(function(a){
      var st = ST[a.status] || {t:a.status,c:'#c9cdd4'};
      var off = a.enabled===false;
      accHtml += '<div class="acc"'+(off?' style="opacity:.55"':'')+'>'
        + '<div class="acc-top"><span class="dot" style="background:'+st.c+'"></span>'
        + '<span class="st-label">'+st.t+(a.busy?'（使用中）':'')+'</span>'
        + '<span class="acc-id">'+esc(a.id)+'</span>'
        + (off?'<span class="meta" style="margin:0;">已停用</span>':'')+'</div>';
      // 标签左 / 值右：备注 / 昵称 / 今日查询 / 最近使用 / 连续失败
      // 备注单独一行并带标签，否则混在标题行里看不出是备注
      accHtml += '<div class="acc-info">'
        + '<span class="k">备注</span><b>'+esc(a.remark||'-')+'</b>'
        + '<span class="k">昵称</span><b>'+esc(a.nickname||'-')+'</b>'
        + '<span class="k">今日查询</span><b>'+(a.todayQueries==null?0:a.todayQueries)+'</b>'
        + '<span class="k">最近使用</span><b>'+(a.lastUsedAt?fmtTime(a.lastUsedAt):'-')+'</b>'
        + (a.consecutiveFails?'<span class="k">连续失败</span><b>'+a.consecutiveFails+'</b>':'')
        + '</div>';
      accHtml += '<div class="acc-row"><span class="k">代理</span>'+proxySelHtml(a)+'</div>';
      if(a.note) accHtml += '<div class="note">'+esc(a.note)+'</div>';
      // 第一行：主操作（登录/验证 + 退出）
      accHtml += '<div class="btns">';
      if(a.status==='waiting') {
        accHtml += '<button class="primary" data-kind="verify" data-acc="'+a.id+'">验证登录</button>';
      } else if(a.status==='active' || a.status==='cooling') {
        // 已登录态：登录按钮置灰、不可点击（避免重复登录）
        accHtml += '<button class="primary" data-kind="start" data-acc="'+a.id+'" disabled title="已登录，无需重复登录">登录</button>';
      } else {
        accHtml += '<button class="primary" data-kind="start" data-acc="'+a.id+'">登录</button>';
      }
      if(a.status!=='none' && a.status!=='waiting') accHtml += '<button data-kind="logout" data-acc="'+a.id+'">退出</button>';
      accHtml += '</div>';
      // 第二行：次要操作 + 删除靠右
      accHtml += '<div class="btns">';
      if(a.status!=='waiting') {
        accHtml += '<button data-kind="remark" data-acc="'+a.id+'">备注</button>';
        accHtml += '<button data-kind="toggle" data-acc="'+a.id+'">'+(off?'启用':'停用')+'</button>';
      }
      // 仅「已登录」状态的账号显示测试按钮（active=已登录 / cooling=冷却中；none/waiting/failed 不显示）
      if(a.status==='active' || a.status==='cooling') {
        accHtml += '<button data-testbtn="'+p.platformId+'/'+a.id+'">测试</button>';
      }
      accHtml += '<button class="danger right" data-kind="delete" data-acc="'+a.id+'">删除</button>';
      accHtml += '</div></div>';
      });
      accHtml += '</div>';
    }
    // —— 外壳（含 noVNC iframe 和文本输入框）——
    // 这两个元素是「有状态」的：若每 3 秒的轮询都整块重建，会同时造成
    //   1) noVNC 反复断连重连 → 窗口一直是黑屏
    //   2) 输入框被重建 → 刚填的手机号/验证码被清空、焦点丢失（表现为"输入不进去"）
    // 因此只在结构变化（切平台 / 登录窗口出现或消失 / 面板被其他视图占用过）时重建外壳，
    // 轮询时只刷新 #acc-area 里的账号卡片。
    var key = 'acc|' + ACC_PLATFORM + '|' + (needVnc ? 'vnc' : 'novnc');
    if(PANEL_KEY !== key || !document.getElementById('acc-area')){
      var shell = '<div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;"><h2>账号管理</h2><button class="primary" data-kind="start">＋ 添加账号登录</button></div>'
        + '<div style="margin:10px 0;display:flex;gap:8px;flex-wrap:wrap;">' + plats.map(function(x){ return '<button class="plat-tab'+(x.platformId===ACC_PLATFORM?' on':'')+'" data-plat="'+x.platformId+'">'+x.label+'</button>'; }).join('') + '</div>';
      if(p.hint) shell += '<div class="hint">'+esc(p.hint)+'</div>';
      if(needVnc){
        shell += '<div class="acc" style="margin-bottom:14px;">'
          + '<div class="meta" style="margin-bottom:8px;">登录窗口：请在下方窗口内完成扫码 / 输入验证码，完成后点账号卡上的「验证登录」。</div>'
          + '<iframe id="novnc" src="'+esc(NOVNC_URL)+'" style="width:100%;height:760px;border:1px solid #e5e6eb;border-radius:8px;background:#000;"></iframe>'
          + '<div style="display:flex;gap:8px;margin-top:10px;align-items:center;">'
          + '<input id="vnc-text" class="inp" style="flex:1;" placeholder="手机号 / 验证码：填入后点「发送到窗口」">'
          + '<button id="vnc-send">发送到窗口</button></div>'
          + '<div class="meta">若浏览器未提供剪贴板接口，会自动改为复制到剪贴板，你在窗口内 Ctrl+V 粘贴即可。</div>'
          + '</div>';
      }
      shell += '<div id="acc-area"></div>';
      $('#panel').innerHTML = shell;
      PANEL_KEY = key;
    }
    var acc = document.getElementById('acc-area');
    if(acc) acc.innerHTML = accHtml;

    if(POLL) clearInterval(POLL); POLL=null;
    if(needVnc) POLL=setInterval(renderAccounts,3000);
    syncTestButtons();
    if(TESTPOLL) clearInterval(TESTPOLL);
    TESTPOLL = setInterval(syncTestButtons, 4000);
  }).catch(function(){});
}
// 点「测试」弹出的 noVNC 标签页引用（按 key 存，支持多账号同时开测试窗口）
var WIN_REFS = {};
function syncTestButtons(){
  fetch(api('/api/login/test/sessions')).then(function(r){ return r.json(); }).then(function(d){
    var set = {}; (d.sessions||[]).forEach(function(s){ set[s]=true; });
    Array.prototype.forEach.call(document.querySelectorAll('[data-testbtn]'), function(btn){
      var key = btn.getAttribute('data-testbtn');
      var open = !!set[key];
      btn.textContent = open ? '关闭测试' : '测试';
      btn.onclick = function(){
        var parts = key.split('/'); var platform = parts[0]; var accountId = parts.slice(1).join('/');
        if(!open){
          try { var w = window.open(NOVNC_URL, '_blank'); if(w) WIN_REFS[key] = w; } catch(e) { /* 弹窗被拦时后端窗口仍会开，用户可手动开 noVNC */ }
        }
        fetch(api('/api/login/'+platform+'/'+(open?'test-close':'test')), { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({accountId: accountId}) })
          .then(function(r){ return r.json().then(function(j){ return {ok:r.ok, j:j}; }); })
          .then(function(o){
            toast((o.j&&o.j.msg)||'已提交');
            // 关闭测试成功 → 一并关掉之前弹出的 noVNC 标签页（同源脚本打开的窗口可被 close）
            if(open){
              var w = WIN_REFS[key];
              if(w && !w.closed){ try { w.close(); } catch(e) { /* 已被用户手动关过等场景，忽略 */ } }
              delete WIN_REFS[key];
            }
            syncTestButtons();
          })
          .catch(function(e){ toast('请求失败：'+e.message); });
      };
    });
  }).catch(function(){});
}
// ---- 代理管理页（2026-09-22 新增）：IP 池增删/启停，绑定数展示，删除前需先解绑 ----
function renderProxies(){
  if(POLL) clearInterval(POLL); POLL=null;
  $('#panel').innerHTML =
      '<h2>代理管理</h2>'
    + '<div class="acc"><div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">'
    + '<input id="px-host" class="inp" style="width:180px;" placeholder="IP 或域名">'
    + '<input id="px-port" class="inp" style="width:110px;" placeholder="端口（0=直连）">'
    + '<select id="px-proto" class="inp" style="width:96px;"><option value="http">http</option><option value="socks5">socks5</option></select>'
    + '<input id="px-user" class="inp" style="width:130px;" placeholder="账号（可选）">'
    + '<input id="px-pass" class="inp" style="width:130px;" type="password" placeholder="密码（可选）">'
    + '<input id="px-note" class="inp" style="width:150px;" placeholder="备注（可选）">'
    + '<button class="primary" id="px-add">添加</button></div></div>'
    + '<div id="px-list" style="margin-top:14px;">加载中…</div>';
  $('#px-add').onclick = function(){
    var host = $('#px-host').value.trim();
    var portRaw = $('#px-port').value.trim();
    if(!host){ toast('请填 IP 或域名'); return; }
    if(portRaw === ''){ toast('请填端口（0 = 直连不代理）'); return; }
    var port = Number(portRaw);
    if(!Number.isInteger(port) || port < 0 || port > 65535){ toast('端口需为 0-65535 的整数（0 = 直连不代理）'); return; }
    // host / port 分开传，与 geo_ui_proxy_ip 的 host、port 两列一一对应
    var payload = { host: host, port: port, protocol: $('#px-proto').value };
    var u = $('#px-user').value.trim(); if(u) payload.username = u;
    var p = $('#px-pass').value; if(p) payload.password = p;
    var n = $('#px-note').value.trim(); if(n) payload.note = n;
    fetch(api('/api/proxies'), { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(payload) })
      .then(function(r){ return r.json().catch(function(){ return {msg:'响应解析失败'}; }); })
      .then(function(j){ toast((j&&j.msg)||'已添加'); $('#px-host').value=''; $('#px-port').value=''; $('#px-user').value=''; $('#px-pass').value=''; $('#px-note').value=''; pxTick(); })
      .catch(function(e){ toast('请求失败：'+e.message); });
  };
  pxTick();
  POLL = setInterval(pxTick, 5000);
}
function pxTick(){
  fetch(api('/api/proxies')).then(function(r){ return r.json(); }).then(function(d){
    var box = $('#px-list'); if(!box) return;
    var list = d.proxies||[];
    if(!list.length){ box.innerHTML = '<div class="empty">还没有代理 IP（宿主机直连行会随服务启动自动出现）。</div>'; return; }
    box.innerHTML = list.map(function(p){
      // port=0 即直连（不设代理）。标题一律显示 IP，直连与否由后面的协议徽标（直连/http/socks5）区分
      var isDirect = p.port===0;
      var title = isDirect ? esc(p.host) : esc(p.host)+':'+p.port;
      var proto = p.protocol==='direct' ? '直连' : esc(p.protocol);
      return '<div class="acc"><div class="acc-top">'
        + '<span class="st-label" style="font-family:ui-monospace,monospace;">'+title+'</span>'
        + '<span class="meta">'+proto+'</span>'
        + (p.enabled===false?'<span class="meta" style="color:#f53f3f;">已停用</span>':'<span class="meta" style="color:#00b42a;">启用中</span>')
        + '</div>'
        + '<div class="meta">绑定账号：<b>'+p.accounts+'</b> ｜ 最近使用：<b>'+(p.lastUsedAt?new Date(p.lastUsedAt).toLocaleString():'从未使用')+'</b>'
        + (p.username?' ｜ 账号：<b>'+esc(p.username)+'</b>':'')
        + (isDirect?'':(p.note?' ｜ 备注：<b>'+esc(p.note)+'</b>':'')) + '</div>'
        + '<div class="btns"><button data-px="'+p.id+'" data-pxact="toggle" data-en="'+(p.enabled?'1':'0')+'">'+(p.enabled?'停用':'启用')+'</button>'
        + '<button class="danger" data-px="'+p.id+'" data-pxact="del">删除</button></div></div>';
    }).join('');
  }).catch(function(){ var b=$('#px-list'); if(b) b.innerHTML='<span class="empty">代理列表加载失败</span>'; });
}
// ---- 信源分析页：逐行输入关键词 → 全平台顺序采集 → 每个平台一个 JSON 文件（按引用次数降序） ----
function renderSources(){
  if(POLL) clearInterval(POLL); POLL=null;
  $('#panel').innerHTML =
      '<h2>信源分析</h2>'
    + '<div class="acc"><div class="meta">任务名称（可选，作为产物文件夹名；留空自动用时间）</div>'
    + '<div style="margin:10px 0;"><input id="sa-name" class="inp" style="width:100%;" placeholder="如：连锁系统信源-第一轮"></div>'
    + '<div class="meta">关键词（每行一个，按顺序依次执行）</div>'
    + '<div style="margin:10px 0;"><textarea id="sa-kw" class="inp" rows="8" style="width:100%;" placeholder="每行一个关键词，例如：多门店连锁管理系统"></textarea></div>'
    + '<div class="meta">平台</div>'
    + '<div id="sa-platforms" style="margin:10px 0;font-size:13px;color:#4e5969;">加载平台…</div>'
    + '<div class="meta">执行模式</div>'
    + '<div style="margin:10px 0;font-size:13px;color:#4e5969;">'
    + '<label style="margin-right:16px;"><input type="radio" name="sa-mode" value="serial" checked> 串行</label>'
    + '<label><input type="radio" name="sa-mode" value="parallel"> 并行</label>'
    + '</div>'
    + '<div class="btns"><button class="primary" id="sa-go">▶ 开始分析</button><button id="sa-refresh">刷新状态</button>'
    + '<label style="font-size:13px;color:#4e5969;"><input type="checkbox" id="sa-headed"> 开启浏览器</label></div>'
    + '<div id="sa-status" class="meta" style="margin-top:12px;">加载状态…</div></div>'
    + '<div id="sa-history"></div>';
  fetch(api('/api/platforms')).then(function(r){ return r.json(); }).then(function(d){
    var box=$('#sa-platforms'); if(!box) return;
    box.innerHTML = (d.platforms||[]).map(function(p){
      return '<label style="margin-right:16px;"><input type="checkbox" class="sa-plat" value="'+esc(p.platformId)+'"> '+esc(p.label)+' · '+esc(p.modelId)+'</label>';
    }).join('');
  }).catch(function(){ var b=$('#sa-platforms'); if(b) b.innerHTML='<span class="empty">平台加载失败</span>'; });
  $('#sa-go').onclick = function(){
    // ⚠️ 整段 HTML 在 TS 模板字符串里：要交给浏览器的换行转义必须双写反斜杠，
    //    否则会被当成真实换行、把这段 JS 的字符串撑断（页面直接白屏报 Invalid or unexpected token）
    var kw = $('#sa-kw').value.split('\\n').map(function(s){ return s.trim(); }).filter(function(s){ return s; });
    if(!kw.length){ toast('请填入至少一个关键词'); return; }
    var plats=[]; Array.prototype.forEach.call(document.querySelectorAll('.sa-plat:checked'), function(c){ plats.push(c.value); });
    if(!plats.length){ toast('请至少选一个平台'); return; }
    var name = $('#sa-name').value.trim();
    var payload = { keywords: kw, platforms: plats };
    if(name) payload.name = name;
    if($('#sa-headed').checked) payload.headed = true;
    var mEl = document.querySelector('input[name="sa-mode"]:checked');
    payload.mode = mEl ? mEl.value : 'serial';
    fetch(api('/api/source-analysis/run'), { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(payload) })
      .then(function(r){ return r.json().catch(function(){ return {msg:'响应解析失败'}; }); })
      .then(function(j){ toast((j&&j.msg)||'已提交'); SA_LAST=''; saTick(); });
  };
  $('#sa-refresh').onclick = function(){ SA_LAST=''; saTick(); saHistory(); };
  SA_LAST=''; saTick(); saHistory();
  POLL = setInterval(saTick, 3000);
}
function saTick(){
  fetch(api('/api/source-analysis/status')).then(function(r){ return r.json(); }).then(function(s){
    var el=$('#sa-status'); if(!el) return;
    if(!s || !s.taskId){ el.innerHTML='<span style="color:#86909c;">尚未运行过信源分析</span>'; return; }
    var modeTxt = s.mode === 'parallel' ? '（并行）' : '（串行）';
    var runningList = [];
    if (s.perPlatform) { for (var pk in s.perPlatform) { if (s.perPlatform[pk] && s.perPlatform[pk].running) runningList.push(pk); } }
    var platTxt = runningList.length ? runningList.join('、') : (s.currentPlatform || '');
    var html = '状态：<b>'+(s.running?'<span style="color:#ff7d00;">运行中</span>':'已结束')+'</b>'
      + ' ｜ 关键词：<b>'+(s.doneKeywords||0)+'/'+s.totalKeywords+'</b>'
      + (s.running&&s.currentKeyword ? ' ｜ 正在跑：<b>'+esc(s.currentKeyword)+'</b>（'+esc(platTxt)+'）'+modeTxt : '')
      + ' ｜ 任务：<b>'+esc(s.taskId)+'</b>';
    if((s.platforms||[]).length){
      html += '<div style="margin-top:6px;">' + s.platforms.map(function(p){
        return '<span style="margin-right:14px;">'+esc(p.modelId)+'：成功 <b>'+p.ok+'</b> 失败 <b>'+p.fail+'</b> 站点 <b>'+p.domains+'</b> 引用 <b>'+p.hits+'</b></span>';
      }).join('') + '</div>';
    }
    if(s.lastError) html += '<div class="note">'+esc(s.lastError)+'</div>';
    el.innerHTML = html;
    if(!s.running && s.taskId){ var key = s.taskId + ':' + (s.finishedAt||0); if(key!==SA_LAST){ SA_LAST=key; saHistory(); } }
  }).catch(function(){});
}
function saHistory(){
  var box=$('#sa-history'); if(!box) return;
  fetch(api('/api/source-analysis/tasks')).then(function(r){ return r.json(); }).then(function(d){
    var tasks=d.tasks||[]; if(!tasks.length){ box.innerHTML=''; return; }
    box.innerHTML = '<h2 style="margin-top:18px;">历史任务</h2><div class="acc">'
      + tasks.slice(0,20).map(function(t){
          var dt = t.finishedAt ? new Date(t.finishedAt).toLocaleString() : '未完成';
          var label = t.name ? t.name : t.taskId;
          // 整条条目可点 → 调 open 接口在文件管理器打开对应目录（不罗列目录内文件）
          return '<div class="sa-task" data-open="'+esc(t.taskId)+'" style="padding:10px 0;border-bottom:1px solid #f2f3f5;cursor:pointer;">'
            + '<div class="acc-top" style="justify-content:space-between;"><span class="acc-remark" style="font-weight:600;">'+esc(label)+'</span>'
            + '<span class="meta">'+t.keywords+' 词 ｜ '+dt+'</span></div>'
            + '<div class="meta">'+esc(t.taskId)+'</div></div>';
        }).join('') + '</div>';
    Array.prototype.forEach.call(box.querySelectorAll('.sa-task'), function(el){
      el.onclick = function(){
        var id = el.getAttribute('data-open');
        fetch(api('/api/source-analysis/open'), { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ taskId: id }) })
          .then(function(r){ return r.json().catch(function(){ return {}; }); })
          .then(function(j){ toast(j.dir ? ('已在文件管理器打开：'+j.dir) : (j.msg||'已尝试打开')); });
      };
    });
  }).catch(function(){});
}
// ---- Pull 采集页：对方服务地址可填（默认 127.0.0.1:8101，记入 localStorage），触发 /api/pull/run 并轮询状态 ----
function renderPull(){
  if(POLL) clearInterval(POLL); POLL=null;
  var host = localStorage.getItem('geo_pull_host') || 'http://127.0.0.1:8101';
  $('#panel').innerHTML =
    '<h2>收录检测</h2>'
    + '<div class="acc"><div class="meta">服务地址</div>'
    + '<div style="margin:10px 0;"><input id="pull-host" class="inp" style="width:100%;" value="'+esc(host)+'" placeholder="http://127.0.0.1:8101"></div>'
    + '<div class="meta">可选参数</div>'
    + '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:10px 0;">'
    + '<div class="meta">平台</div>'
    + '<div style="display:flex;gap:16px;flex-wrap:wrap;align-items:center;margin:6px 0 14px;">'
    + '<label style="font-size:13px;color:#1d2129;"><input type="checkbox" name="pull-plat" value="qwen"> 千问</label>'
    + '<label style="font-size:13px;color:#1d2129;"><input type="checkbox" name="pull-plat" value="wenxiaoyan"> 百度文心</label>'
    + '<label style="font-size:13px;color:#1d2129;"><input type="checkbox" name="pull-plat" value="hunyuan"> 腾讯元宝</label>'
    + '<label style="font-size:13px;color:#1d2129;"><input type="checkbox" name="pull-plat" value="doubao"> 豆包</label>'
    + '<label style="font-size:13px;color:#1d2129;"><input type="checkbox" name="pull-plat" value="deepseek"> DeepSeek</label>'
    + '</div>'
    + '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;width:100%;margin:2px 0 6px;">'
    + '<input id="pull-start" class="inp" style="width:190px;" placeholder="startTime yyyy-MM-dd HH:mm:ss">'
    + '<input id="pull-end" class="inp" style="width:190px;" placeholder="endTime yyyy-MM-dd HH:mm:ss">'
    + '<label style="font-size:13px;color:#4e5969;"><input type="checkbox" id="pull-headed"> 开启浏览器</label>'
    + '</div>'
    + '</div>'
    + '<div class="btns"><button class="primary" id="pull-go">▶ 运行</button><button id="pull-refresh">刷新状态</button></div>'
    + '<div id="pull-status" class="meta" style="margin-top:12px;">加载状态…</div></div>'
    + '<div class="hint">服务地址会作为 pullHost 传给 /api/pull/run（优先于服务端 GEO_PULL_HOST）；运行后后台执行，本页每 3s 自动刷新进度；详细日志看服务端控制台。</div>';
  $('#pull-go').onclick = function(){
    var h = $('#pull-host').value.trim();
    if(!h){ toast('请填对方服务地址'); return; }
    localStorage.setItem('geo_pull_host', h);
    var payload = { pullHost: h };
    var plats = Array.prototype.slice.call(document.querySelectorAll('input[name="pull-plat"]:checked')).map(function(c){ return c.value; });
    if (plats.length) payload.platforms = plats;
    var s1 = $('#pull-start').value.trim(); if(s1) payload.startTime = s1;
    var s2 = $('#pull-end').value.trim(); if(s2) payload.endTime = s2;
    var headed = $('#pull-headed').checked;
    if(headed) payload.headed = true;
    // 勾了「开启浏览器」→ 同步弹出 noVNC 标签页看容器里的浏览器画面（同步调用避免被浏览器拦截）；任务结束自动关闭（见 pullStatusTick）
    if(headed){
      try { PULL_WIN = window.open(NOVNC_URL, '_blank'); }
      catch(e) { PULL_WIN = null; }
      if(!PULL_WIN) toast('弹窗被浏览器拦截，可手动打开 '+NOVNC_URL);
    }
    fetch(api('/api/pull/run'), { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(payload) })
      .then(function(r){ return r.json().catch(function(){ return {msg:'响应解析失败'}; }); })
      .then(function(j){ toast((j&&j.msg)||'已提交'); pullStatusTick(); });
  };
  $('#pull-refresh').onclick = pullStatusTick;
  pullStatusTick();
  POLL = setInterval(pullStatusTick, 3000);
}
function pullStatusTick(){
  fetch(api('/api/pull/status')).then(function(r){ return r.json(); }).then(function(s){
    var el = $('#pull-status'); if(!el) return;
    if(!s || (!s.running && !s.startedAt)){ el.innerHTML = '<span style="color:#86909c;">尚未运行过任何 pull 轮次</span>'; return; }
    // 任务结束（从运行中变为结束）→ 自动关闭「开启浏览器」时弹出的 noVNC 标签页
    if(!s.running){
      if(!PULL_ENDED){ PULL_ENDED = true; if(PULL_WIN && !PULL_WIN.closed){ try { PULL_WIN.close(); } catch(e) {} } PULL_WIN = null; }
    } else {
      PULL_ENDED = false;
    }
    el.innerHTML = '状态：<b>'+(s.running?'<span style="color:#ff7d00;">运行中</span>':'已结束')+'</b>'
      + ' ｜ 页数：<b>'+s.pages+'</b> ｜ 拉取：<b>'+s.fetched+'</b> ｜ 成功：<b>'+s.success+'</b> ｜ 失败：<b>'+s.failed+'</b> ｜ 回推失败：<b>'+s.reportFailed+'</b>'
      + (s.host ? ' ｜ 目标：<b>'+esc(s.host)+'</b>' : '')
      + (s.lastError ? '<div class="note">上次错误：'+esc(s.lastError)+'</div>' : '');
  }).catch(function(){});
}
// 事件委托：账号卡与顶部按钮统一走 data-kind / data-acc（避免内联 onclick 引号转义问题）
function post(kind, accountId, extra){
  if(kind!=='start' && !accountId){ toast('缺少账号'); return; }
  var plat = (CUR==='__accounts') ? ACC_PLATFORM : CUR;
  var url = (kind==='toggle')
    ? api('/api/accounts/'+plat+'/'+accountId+'/'+kind)
    : api('/api/login/'+plat+'/'+kind);
  var body = { accountId: accountId||undefined };
  if(extra) for(var k in extra) body[k] = extra[k];
  fetch(url, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(body) })
    .then(function(r){ return r.json().catch(function(){ return {msg:'响应解析失败'}; }); })
    .then(function(j){ toast((j&&j.msg)||'已提交'); render(); })
    .catch(function(e){ toast('请求失败：'+e.message); });
}
// 文本注入：优先走 noVNC 的 rfb.clipboardPasteFrom，取不到就降级到剪贴板
function sendToVnc(){
  var t = $('#vnc-text'); if(!t || !t.value.trim()){ toast('请先填写要发送的内容'); return; }
  var text = t.value.trim(), sent = false;
  try {
    var w = document.getElementById('novnc') && document.getElementById('novnc').contentWindow;
    if(w && w.rfb && typeof w.rfb.clipboardPasteFrom === 'function'){ w.rfb.clipboardPasteFrom(text); sent = true; }
  } catch(e) { sent = false; }
  if(sent){ toast('已发送到登录窗口'); return; }
  if(navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(text).then(function(){ toast('已复制到剪贴板，请在窗口内 Ctrl+V 粘贴'); },
      function(){ toast('复制失败，请手动输入'); });
  } else { toast('无法自动发送，请手动输入'); }
}
document.addEventListener('click', function(ev){
  if(ev.target && ev.target.closest && ev.target.closest('#vnc-send')){ sendToVnc(); return; }
  // 账号管理页顶部平台 tab（2026-09-22）
  var pt = ev.target && ev.target.closest ? ev.target.closest('button.plat-tab') : null;
  if(pt){ ACC_PLATFORM = pt.getAttribute('data-plat'); render(); return; }
  // 代理管理行按钮（启停/删除，2026-09-22）
  var px = ev.target && ev.target.closest ? ev.target.closest('button[data-px]') : null;
  if(px){
    var pid = Number(px.getAttribute('data-px'));
    var act = px.getAttribute('data-pxact');
    if(act==='del' && !confirm('确认删除该代理 IP？已绑定账号时会拒绝删除，需先到账号管理解绑。')) return;
    var opt = act==='del' ? { method:'DELETE' } : { method:'PATCH', headers:{'content-type':'application/json'}, body: JSON.stringify({ enabled: px.getAttribute('data-en')!=='1' }) };
    fetch(api('/api/proxies/'+pid), opt)
      .then(function(r){ return r.json().catch(function(){ return {msg:'响应解析失败'}; }); })
      .then(function(j){ toast((j&&j.msg)||'已操作'); pxTick(); })
      .catch(function(e){ toast('请求失败：'+e.message); });
    return;
  }
  var b = ev.target && ev.target.closest ? ev.target.closest('button[data-kind]') : null;
  if(!b || !CUR) return;
  if(b.hasAttribute('disabled')) return; // 已登录态：登录按钮置灰，禁止触发
  var kind = b.getAttribute('data-kind');
  var acc = b.getAttribute('data-acc') || undefined;
  if(kind==='remark'){
    var remark = prompt('账号备注（用于区分账号，如：主号-尾号1234）');
    if(remark===null || !remark.trim()) return;
    fetch(api('/api/login/'+((CUR==='__accounts')?ACC_PLATFORM:CUR)+'/remark'), { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({accountId:acc, remark:remark.trim()}) })
      .then(function(r){ return r.json(); }).then(function(j){ toast((j&&j.msg)||'已更新'); render(); })
      .catch(function(e){ toast('请求失败：'+e.message); });
    return;
  }
  if(kind==='delete' && !confirm('确认删除账号 '+(acc||'')+'？目录与登录态都会被清掉。')) return;
  if(kind==='toggle'){ post(kind, acc); return; }
  post(kind, acc);
});
// 账号绑定代理下拉（change 事件；2026-09-22）
document.addEventListener('change', function(ev){
  var sel = ev.target && ev.target.closest ? ev.target.closest('select.proxy-sel') : null;
  if(!sel) return;
  var accountId = sel.getAttribute('data-acc');
  var v = sel.value;
  var plat = (CUR==='__accounts') ? ACC_PLATFORM : CUR;
  if(!plat || !accountId){ return; }
  fetch(api('/api/accounts/'+plat+'/'+accountId+'/proxy'), { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ proxyId: v==='0' ? null : Number(v) }) })
    .then(function(r){ return r.json().catch(function(){ return {msg:'响应解析失败'}; }); })
    .then(function(j){ toast((j&&j.msg)||'已提交'); render(); })
    .catch(function(e){ toast('请求失败：'+e.message); });
});
fetch(api('/api/login/platforms')).then(function(r){ return r.json(); }).then(function(d){
  var ps = d.platforms||[];
  // 2026-09-22 菜单改版：默认落在「账号管理」页
  CUR = ps.length ? '__accounts' : '__pull';
  menu(ps); render();
}).catch(function(){ $('#panel').innerHTML='<div class="empty">加载失败，请刷新重试。</div>'; });
</script>
</body>
</html>`;
}
