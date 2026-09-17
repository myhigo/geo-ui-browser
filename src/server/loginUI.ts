// 平台登录管理页（多账号版，极简无外部依赖）。入口 GET /admin。
// 每个账号一张卡：id/别名/标识/状态 + 登录/退出/删除/改备注，账号间独立不串。
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
  .acc-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 14px; align-items: start; }
  .acc-grid > .acc { margin-bottom: 0; }
  .acc-top { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .acc-id { font-size: 13px; color: #4e5969; font-family: ui-monospace, monospace; }
  .acc-alias { font-size: 14px; font-weight: 500; }
  .dot { width: 9px; height: 9px; border-radius: 50%; display: inline-block; margin-right: 6px; }
  .st-active { background: #00b42a; } .st-waiting { background: #ff7d00; } .st-failed { background: #f53f3f; } .st-none { background: #c9cdd4; } .st-cooling { background: #ff7d00; }
  .st-label { font-size: 13px; color: #1f2329; }
  .meta { font-size: 12px; color: #86909c; margin-top: 8px; line-height: 1.8; }
  .meta b { color: #4e5969; font-weight: 500; }
  .note { font-size: 12px; color: #e02020; margin-top: 6px; }
  .btns { margin-top: 12px; display: flex; gap: 8px; flex-wrap: wrap; }
  button { background: #fff; border: 1px solid #c9cdd4; color: #4e5969; border-radius: 6px; padding: 7px 16px; font-size: 13px; cursor: pointer; }
  button:hover { border-color: #165dff; color: #165dff; }
  button.primary { background: #165dff; border-color: #165dff; color: #fff; }
  button.primary:hover { background: #0e42d2; }
  button.danger:hover { border-color: #f53f3f; color: #f53f3f; }
  button:disabled { opacity: .5; cursor: not-allowed; }
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
var ST = { none:{t:'未登录',c:'#c9cdd4'}, waiting:{t:'登录中',c:'#ff7d00'}, active:{t:'已登录',c:'#00b42a'}, cooling:{t:'冷却中',c:'#ff7d00'}, failed:{t:'不可用',c:'#f53f3f'} };
function $(s){ return document.querySelector(s); }
function toast(m){ var t=$('#toast'); t.textContent=m; t.classList.add('show'); setTimeout(function(){ t.classList.remove('show'); }, 2400); }
function esc(x){ return String(x==null?'':x).replace(/[&<>"]/g, function(ch){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[ch]; }); }
function menu(platforms){
  $('#menu').innerHTML = platforms.map(function(p){ return '<button class="menu-item'+(CUR===p.platformId?' on':'')+'" data-id="'+p.platformId+'">'+p.label+'</button>'; }).join('')
    + '<button class="menu-item'+(CUR==='__sources'?' on':'')+'" data-id="__sources">信源分析</button>'
    + '<button class="menu-item'+(CUR==='__pull'?' on':'')+'" data-id="__pull">收录检测</button>';
  Array.prototype.forEach.call(document.querySelectorAll('.menu-item'), function(b){ b.onclick=function(){ CUR=b.dataset.id; menu(platforms); render(); }; });
}
function render(){
  if(TESTPOLL){ clearInterval(TESTPOLL); TESTPOLL=null; }
  if(CUR==='__pull'){ renderPull(); return; }
  if(CUR==='__sources'){ renderSources(); return; }
  if(!CUR) return;
  fetch('/api/login/platforms').then(function(r){ return r.json(); }).then(function(d){
    var p = (d.platforms||[]).filter(function(x){ return x.platformId===CUR; })[0];
    if(!p) return;
    menu(d.platforms||[]);
    var html = '<div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;"><h2>'+p.label+' · 账号管理</h2><button class="primary" data-kind="start">＋ 添加账号登录</button></div>';
    if(p.hint) html += '<div class="hint">'+esc(p.hint)+'</div>';
    if(!p.accounts.length){ html += '<div class="empty">还没有账号，点右上角「添加账号登录」开第一个号。</div>'; }
    else {
      html += '<div class="acc-grid">';
      p.accounts.forEach(function(a){
      var st = ST[a.status] || {t:a.status,c:'#c9cdd4'};
      html += '<div class="acc"><div class="acc-top"><span class="dot" style="background:'+st.c+'"></span><span class="st-label">'+st.t+(a.busy?'（使用中）':'')+'</span>'+(a.alias?'<span class="acc-alias">'+esc(a.alias)+'</span>':'')+'</div>';
      html += '<div class="meta">昵称：<b>'+esc(a.marker||'--')+'</b> ｜ 今日查询次数：<b>'+((a.todayQueries==null?0:a.todayQueries))+'</b></div>';
      if(a.note) html += '<div class="note">'+esc(a.note)+'</div>';
      html += '<div class="meta">'+(a.lastUsedAt?'最近使用：<b>'+new Date(a.lastUsedAt).toLocaleString()+'</b>':'最近使用：<b>-</b>')+(a.consecutiveFails?' ｜ 连续失败：<b>'+a.consecutiveFails+'</b>':'')+'</div>';
      html += '<div class="btns">';
      if(a.status==='waiting') {
        html += '<button class="primary" data-kind="verify" data-acc="'+a.id+'">我已登录完成，验证</button>';
      } else if(a.status==='active' || a.status==='cooling') {
        // 已登录态：登录按钮置灰、不可点击（避免重复登录）
        html += '<button class="primary" data-kind="start" data-acc="'+a.id+'" disabled title="已登录，无需重复登录">登录</button>';
      } else {
        html += '<button class="primary" data-kind="start" data-acc="'+a.id+'">登录</button>';
      }
      if(a.status!=='none' && a.status!=='waiting') html += '<button data-kind="logout" data-acc="'+a.id+'">退出</button>';
      if(a.status!=='waiting') {
        html += '<button data-kind="alias" data-acc="'+a.id+'">改备注</button>';
      }
      // 仅「已登录」状态的账号显示测试按钮（active=已登录 / cooling=冷却中；none/waiting/failed 不显示）
      if(a.status==='active' || a.status==='cooling') {
        html += '<button data-testbtn="'+p.platformId+'/'+a.id+'">测试</button>';
      }
      html += '<button class="danger" data-kind="delete" data-acc="'+a.id+'">删除账号</button>';
      html += '</div></div>';
      });
      html += '</div>';
    }
    $('#panel').innerHTML = html;
    if(POLL) clearInterval(POLL); POLL=null;
    if(p.accounts.some(function(a){ return a.status==='waiting'; })) POLL=setInterval(render,3000);
    syncTestButtons();
    if(TESTPOLL) clearInterval(TESTPOLL);
    TESTPOLL = setInterval(syncTestButtons, 4000);
  }).catch(function(){});
}
// 测试窗口按钮：按后端真实状态回显「测试 / 关闭测试」，点击走 test / test-close 接口。
// key = platformId/accountId；后端是权威来源（用户手动关窗也会同步）。
function syncTestButtons(){
  fetch('/api/login/test/sessions').then(function(r){ return r.json(); }).then(function(d){
    var set = {}; (d.sessions||[]).forEach(function(s){ set[s]=true; });
    Array.prototype.forEach.call(document.querySelectorAll('[data-testbtn]'), function(btn){
      var key = btn.getAttribute('data-testbtn');
      var open = !!set[key];
      btn.textContent = open ? '关闭测试' : '测试';
      btn.onclick = function(){
        var parts = key.split('/'); var platform = parts[0]; var accountId = parts.slice(1).join('/');
        fetch('/api/login/'+platform+'/'+(open?'test-close':'test'), { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({accountId: accountId}) })
          .then(function(r){ return r.json().then(function(j){ return {ok:r.ok, j:j}; }); })
          .then(function(o){ toast((o.j&&o.j.msg)||'已提交'); syncTestButtons(); })
          .catch(function(e){ toast('请求失败：'+e.message); });
      };
    });
  }).catch(function(){});
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
    + '<label style="font-size:13px;color:#4e5969;"><input type="checkbox" id="sa-headed" checked> 开启浏览器</label></div>'
    + '<div id="sa-status" class="meta" style="margin-top:12px;">加载状态…</div></div>'
    + '<div id="sa-history"></div>';
  fetch('/api/platforms').then(function(r){ return r.json(); }).then(function(d){
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
    fetch('/api/source-analysis/run', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(payload) })
      .then(function(r){ return r.json().catch(function(){ return {msg:'响应解析失败'}; }); })
      .then(function(j){ toast((j&&j.msg)||'已提交'); SA_LAST=''; saTick(); });
  };
  $('#sa-refresh').onclick = function(){ SA_LAST=''; saTick(); saHistory(); };
  SA_LAST=''; saTick(); saHistory();
  POLL = setInterval(saTick, 3000);
}
function saTick(){
  fetch('/api/source-analysis/status').then(function(r){ return r.json(); }).then(function(s){
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
  fetch('/api/source-analysis/tasks').then(function(r){ return r.json(); }).then(function(d){
    var tasks=d.tasks||[]; if(!tasks.length){ box.innerHTML=''; return; }
    box.innerHTML = '<h2 style="margin-top:18px;">历史任务</h2><div class="acc">'
      + tasks.slice(0,20).map(function(t){
          var dt = t.finishedAt ? new Date(t.finishedAt).toLocaleString() : '未完成';
          var label = t.name ? t.name : t.taskId;
          // 整条条目可点 → 调 open 接口在文件管理器打开对应目录（不罗列目录内文件）
          return '<div class="sa-task" data-open="'+esc(t.taskId)+'" style="padding:10px 0;border-bottom:1px solid #f2f3f5;cursor:pointer;">'
            + '<div class="acc-top" style="justify-content:space-between;"><span class="acc-alias" style="font-weight:600;">'+esc(label)+'</span>'
            + '<span class="meta">'+t.keywords+' 词 ｜ '+dt+'</span></div>'
            + '<div class="meta">'+esc(t.taskId)+'</div></div>';
        }).join('') + '</div>';
    Array.prototype.forEach.call(box.querySelectorAll('.sa-task'), function(el){
      el.onclick = function(){
        var id = el.getAttribute('data-open');
        fetch('/api/source-analysis/open', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ taskId: id }) })
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
    + '<label style="font-size:13px;color:#4e5969;"><input type="checkbox" id="pull-headed" checked> 开启浏览器</label>'
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
    if($('#pull-headed').checked) payload.headed = true;
    fetch('/api/pull/run', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(payload) })
      .then(function(r){ return r.json().catch(function(){ return {msg:'响应解析失败'}; }); })
      .then(function(j){ toast((j&&j.msg)||'已提交'); pullStatusTick(); });
  };
  $('#pull-refresh').onclick = pullStatusTick;
  pullStatusTick();
  POLL = setInterval(pullStatusTick, 3000);
}
function pullStatusTick(){
  fetch('/api/pull/status').then(function(r){ return r.json(); }).then(function(s){
    var el = $('#pull-status'); if(!el) return;
    if(!s || (!s.running && !s.startedAt)){ el.innerHTML = '<span style="color:#86909c;">尚未运行过任何 pull 轮次</span>'; return; }
    el.innerHTML = '状态：<b>'+(s.running?'<span style="color:#ff7d00;">运行中</span>':'已结束')+'</b>'
      + ' ｜ 页数：<b>'+s.pages+'</b> ｜ 拉取：<b>'+s.fetched+'</b> ｜ 成功：<b>'+s.success+'</b> ｜ 失败：<b>'+s.failed+'</b> ｜ 回推失败：<b>'+s.reportFailed+'</b>'
      + (s.host ? ' ｜ 目标：<b>'+esc(s.host)+'</b>' : '')
      + (s.lastError ? '<div class="note">上次错误：'+esc(s.lastError)+'</div>' : '');
  }).catch(function(){});
}
// 事件委托：账号卡与顶部按钮统一走 data-kind / data-acc（避免内联 onclick 引号转义问题）
function post(kind, accountId){
  if(kind!=='start' && !accountId){ toast('缺少账号'); return; }
  fetch('/api/login/'+CUR+'/'+kind, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({accountId: accountId||undefined}) })
    .then(function(r){ return r.json().catch(function(){ return {msg:'响应解析失败'}; }); })
    .then(function(j){ toast((j&&j.msg)||'已提交'); render(); })
    .catch(function(e){ toast('请求失败：'+e.message); });
}
document.addEventListener('click', function(ev){
  var b = ev.target && ev.target.closest ? ev.target.closest('button[data-kind]') : null;
  if(!b || !CUR) return;
  if(b.hasAttribute('disabled')) return; // 已登录态：登录按钮置灰，禁止触发
  var kind = b.getAttribute('data-kind');
  var acc = b.getAttribute('data-acc') || undefined;
  if(kind==='alias'){
    var alias = prompt('账号备注（用于区分账号，如：主号-尾号1234）');
    if(alias===null || !alias.trim()) return;
    fetch('/api/login/'+CUR+'/alias', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({accountId:acc, alias:alias.trim()}) })
      .then(function(r){ return r.json(); }).then(function(j){ toast((j&&j.msg)||'已更新'); render(); })
      .catch(function(e){ toast('请求失败：'+e.message); });
    return;
  }
  if(kind==='delete' && !confirm('确认删除账号 '+(acc||'')+'？目录与登录态都会被清掉。')) return;
  post(kind, acc);
});
fetch('/api/login/platforms').then(function(r){ return r.json(); }).then(function(d){
  var ps = d.platforms||[];
  CUR = ps.length ? ps[0].platformId : '__pull';
  menu(ps); render();
}).catch(function(){ $('#panel').innerHTML='<div class="empty">加载失败，请刷新重试。</div>'; });
</script>
</body>
</html>`;
}
