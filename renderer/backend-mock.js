'use strict';
/* ============================================================
 * MockBackend：静态预览用的模拟后端
 * 与 Electron preload(window.api) 完全同签名，事件走 MockBus。
 * app.js 只依赖 window.api ?? MockBackend，不感知差异。
 * ============================================================ */
(function () {
  const listeners = {};
  const bus = {
    on(ch, cb) { (listeners[ch] = listeners[ch] || []).push(cb); },
    emit(ch, d) { (listeners[ch] || []).forEach(cb => { try { cb(d); } catch (e) { console.error(e); } }); },
  };
  window.MockBus = bus;

  const nowClock = () => new Date().toTimeString().slice(0, 8);

  /* ---------- 模拟数据（后端任务 schema） ---------- */
  const mkCfg = (o) => Object.assign({
    作品名称: '', 作品简介: '', 作品分类: '长篇', 作品频道: '男频', 作品状态: '连载中',
    小说类目: [], 作品标签: [], 自定义标签: [], 作品字数: '', 投稿入口: '普通投稿',
    笔名: '蛙蛙大王', 封面: '', 本地文件: '',
  }, o);

  let _tid = 0;
  const tid = () => `t${++_tid}_${Date.now().toString(36)}`;

  const T = (name, cfg, ext) => Object.assign({
    id: tid(), name, cfg: mkCfg(Object.assign({ 作品名称: name }, cfg)),
    status: 'ready', message: '', range: { mode: 'all' }, deai: false,
    sid: null, siteInfo: null, coverPrompt: '', info: { coverSource: 'local' },
  }, ext);

  const mockTasks = [
    T('我在废土捡了个系统',
      { 作品简介: '核战后的废土世界，少年在垃圾场捡到一个自称"系统"的神秘铁球，从此踏上收集旧时代科技的重生之路。', 小说类目: ['科幻', '未来世界', '废土'], 作品标签: ['科幻', '废土', '系统流'], 自定义标签: ['重生'], 作品字数: 24000, 本地文件: 'C:\\mock\\novels\\我在废土捡了个系统.txt' },
      { status: 'running', message: '正在提交第11-20章', siteInfo: { found: true, text: '审核中·已投10章', canUpdate: true } }),
    T('深夜代驾那些事',
      { 作品简介: '代驾司机老周的方向盘上，坐着城市深夜的众生相：醉汉、明星、失业者，与不肯回家的人。', 小说类目: ['都市', '都市生活', '市井'], 作品标签: ['都市', '市井', '治愈'], 作品字数: 18000 },
      { status: 'done', message: '投稿完成', siteInfo: { found: true, text: '审核成功·已投3章', canUpdate: false } }),
    T('高武：从武馆杂役开始',
      { 作品简介: '灵气复苏的高武世界，武馆杂役少年觉醒残破面板，从最基础的站桩开始，一路碾压各路天骄。', 小说类目: ['玄幻', '东方玄幻', '高武'], 作品标签: ['玄幻', '高武', '爽文'], 作品字数: 32000, 本地文件: 'C:\\mock\\novels\\高武.txt' },
      { status: 'ready' }),
    T('雨夜欢迎你',
      { 作品简介: '连续暴雨的南方小城，代驾司机每晚十二点都会接到同一个地址的订单，而那栋楼十年前就烧没了。', 小说类目: ['悬疑', '悬疑侦探', '都市怪谈'], 作品标签: ['悬疑', '都市怪谈'], 作品分类: '短篇', 作品状态: '已完结', 作品字数: 9000 },
      { status: 'done', message: '投稿完成', siteInfo: { found: true, text: '审核中', canUpdate: false } }),
    T('前夫的白月光破产了',
      { 作品简介: '离婚三年后，前夫捧着破产的白月光跪在她公司楼下求复合，她笑着按下了电梯关门键。', 小说类目: ['言情', '现代言情', '婚恋'], 作品标签: ['言情', '婚恋', '爽文'], 作品频道: '女频', 作品分类: '短篇', 作品状态: '已完结', 作品字数: 12000 },
      { status: 'error', message: '章节字数不足' }),
    T('山海食堂',
      { 作品简介: '修仙界坊市深处有家小食堂，只做人间味道，食客却有剑仙、妖王与落魄书生。', 小说类目: ['仙侠', '幻想修仙', '轻松'], 作品标签: ['仙侠', '美食', '轻松'], 作品字数: 20000 },
      { status: 'done', message: '投稿完成', siteInfo: { found: true, text: '审核成功·已投8章', canUpdate: true } }),
    T('硅基黎明',
      { 作品简介: '曲率引擎熄火后，人类舰队在寂静星海中沉睡百年，最先醒来的船员听见的是硅基生命的"摇篮曲"。', 小说类目: ['科幻', '星际文明', '末日'], 作品标签: ['科幻', '星际', '硬核'], 作品字数: 28000, 本地文件: 'C:\\mock\\novels\\硅基黎明.txt' },
      { status: 'ready' }),
  ];

  const mockSiteData = {
    entries: ['普通投稿', '征文活动', '新人扶持'],
    tags: ['都市', '玄幻', '仙侠', '科幻', '悬疑', '言情', '历史', '游戏', '奇幻', '轻小说',
           '热血', '爽文', '治愈', '轻松', '群像', '无敌流', '系统流', '重生', '穿越', '废土',
           '高武', '美食', '种田', '婚恋', '甜宠', '市井', '星际', '末日', '无限流', '民间故事'],
    tree: {
      '科幻': { '未来世界': ['废土', '赛博朋克', '星际文明'], '时空穿梭': ['末日', '进化', '末日生存'] },
      '玄幻': { '东方玄幻': ['高武', '王朝', '气息修炼'], '异世大陆': ['穿越', '无敌流', '升级流'] },
      '仙侠': { '幻想修仙': ['轻松', '种田', '美食'], '古典仙侠': ['武侠', '江湖'] },
      '都市': { '都市生活': ['市井', '行业', '治愈'], '异术超能': ['系统流', '神豪', '重生'] },
      '言情': { '现代言情': ['婚恋', '甜宠', '豪门'], '古代言情': ['宫斗', '宅斗', '种田'] },
      '悬疑': { '悬疑侦探': ['都市怪谈', '惊悚', '推理'] },
    },
  };

  /* ---------- 本地生成器（与真实后端的本地兜底同思路） ---------- */
  const TITLE_POOL = {
    '科幻': ['深空拾荒者', '曲率引擎熄火之后', '第七观测站', '硅基夜曲', '星海孤舟', '废土修复师'],
    '玄幻': ['从站桩开始长生', '九州镇妖录', '觉醒残破面板的我', '武道无晓', '万法归一', '镇武司'],
    '仙侠': ['坊市烟火录', '青衫掌柜', '修仙界外卖员', '一碗灵汤', '剑来客栈', '山中无岁月'],
    '言情': ['离婚后她惊艳全网', '婚后心动禁止', '替嫁新娘不认输', '联姻之外', '晚风知我心'],
    '悬疑': ['第十二个订单', '电梯里的第七个人', '烧毁的楼栋', '深夜代驾笔记', '谁在敲门', '雨停之前'],
    '都市': ['写字楼灯光史', '凌晨四点的面粉厂', '城中村房东', '夜班便利店里', '隔壁的老楼'],
  };
  const TITLE_GENERIC = ['无名之辈', '命运岔路口', '长夜将尽', '逆流而上', '微光之城'];

  function localTitleVariants(title, intro) {
    const g = (mockTasks.find(t => t.cfg.作品名称 === title) || {}).cfg;
    const cat = ((g && g.小说类目 && g.小说类目[0]) || '都市');
    const pool = (TITLE_POOL[cat] || TITLE_GENERIC).filter(x => x !== title);
    return pool.slice(0, 3);
  }
  function localIntroVariants(body) {
    const hook = (body || '这是一个还没有简介的故事。').replace(/[。！？.!?]*$/, '');
    return [
      `${hook}。当命运的齿轮重新转动，他才发现：所谓奇迹，不过是无数个不肯认输的日夜。`,
      `所有人都以为他完了，只有他自己知道，牌才刚摸到一半。${hook}。爽点密集，反转不断。`,
      `${hook}。市井烟火与惊涛暗涌之下，是一颗不肯认命的心。`,
    ];
  }
  function localCoverPrompt(title, intro) {
    return `中国网络小说封面插画，竖版构图，主体人物剪影居中偏下，上部留白给书名文字区，色调统一，电影感，高质量插画。小说名《${title}》` + (intro ? `，简介：${intro.slice(0, 60)}` : '');
  }
  function drawPlaceholderCover(title, variant) {
    const palettes = [['#0f3b34', '#3f9d7a'], ['#1a1a2e', '#7b2ff7'], ['#12294b', '#2f80ed'],
      ['#b12a5b', '#ff8fb1'], ['#3a1c71', '#d76d77'], ['#15181c', '#45525c']];
    const [a, b] = palettes[variant % palettes.length];
    const w = 768, h = 1024;
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d');
    const g = ctx.createLinearGradient(0, 0, w * 0.35, h);
    g.addColorStop(0, a); g.addColorStop(1, b);
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = 'rgba(255,255,255,.2)'; ctx.lineWidth = w * 0.035;
    ctx.beginPath(); ctx.arc(w * 0.88, h * 0.92, w * 0.17, 0, 7); ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,.92)';
    ctx.font = `${Math.round(w * 0.028)}px "Microsoft YaHei", sans-serif`;
    ctx.fillText('AI生成 · 演示', w * 0.06, h * 0.075);
    const perLine = title.length <= 5 ? title.length : Math.ceil(Math.min(title.length, 12) / 2);
    const lines = [];
    for (let i = 0; i < title.length && lines.length < 3; i += perLine) lines.push(title.slice(i, i + perLine));
    const fs = Math.round(h * (lines.length > 1 ? 0.085 : 0.1));
    ctx.font = `bold ${fs}px "Microsoft YaHei", sans-serif`;
    ctx.textAlign = 'center';
    ctx.shadowColor = 'rgba(0,0,0,.35)'; ctx.shadowBlur = fs * 0.25;
    const startY = h * 0.46 - (lines.length - 1) * fs * 0.62;
    lines.forEach((ln, i) => ctx.fillText(ln, w / 2, startY + i * fs * 1.24));
    ctx.shadowBlur = 0;
    ctx.fillStyle = 'rgba(255,255,255,.85)';
    ctx.fillRect(w / 2 - w * 0.05, h * 0.58, w * 0.1, 3);
    ctx.font = `${Math.round(h * 0.026)}px "Microsoft YaHei", sans-serif`;
    ctx.fillText('著 · 蛙蛙大王', w / 2, h * 0.63);
    return cv.toDataURL('image/png');
  }

  /* ---------- 模拟运行流水线 ---------- */
  const RUN_STEPS = ['解析归档稿件', '登录蛙蛙账号（自动滑块）', '拉取站内投稿状态', '去AI重写（前10章）',
    '上传全书到作品库', '提交投稿范围', '等待站内响应'];
  const mockRun = { active: false, paused: false, browserLost: false, timer: null, list: [], idx: 0, step: 0, mode: 'dry' };

  function mockEmitStatus() {
    bus.emit('run-status', { running: mockRun.active, paused: mockRun.paused, browserLost: mockRun.browserLost });
  }
  function mockFinishCurrent(ok, note) {
    const item = mockRun.list[mockRun.idx];
    const t = mockTasks.find(x => x.id === item.id);
    if (!t) return;
    if (ok === 'skip') { t.status = 'ready'; t.message = '已手动跳过'; }
    else if (ok) {
      t.status = mockRun.mode === 'dry' ? 'previewed' : 'done'; t.message = '';
      t.siteInfo = { found: true, text: mockRun.mode === 'dry' ? '干跑完成（未真实提交）' : '审核中', canUpdate: false };
    } else {
      t.status = 'error'; t.message = note || '接口超时';
      item._fail = true;
    }
    bus.emit('task-status', { id: t.id, status: t.status, message: t.message });
  }
  function mockTick() {
    if (!mockRun.active) return;
    if (mockRun.paused) { mockRun.timer = setTimeout(mockTick, 300); return; }
    const item = mockRun.list[mockRun.idx];
    const t = mockTasks.find(x => x.id === item.id);
    if (!t) { mockAdvance(true); return; }
    bus.emit('task-status', { id: t.id, status: 'running', message: RUN_STEPS[mockRun.step] });
    bus.emit('run-progress', { i: mockRun.idx + 1, total: mockRun.list.length, name: t.cfg.作品名称, step: RUN_STEPS[mockRun.step] });
    const failHere = mockRun.mode === 'submit' && /硅基黎明/.test(t.cfg.作品名称) && mockRun.step === RUN_STEPS.length - 2;
    if (failHere) {
      bus.emit('log', { line: `❌《${t.cfg.作品名称}》提交失败：接口超时（自动重试 3 次未成功）` });
      mockAdvance(false, '接口超时（自动重试 3 次未成功）');
      return;
    }
    mockRun.step++;
    if (mockRun.step >= RUN_STEPS.length) {
      bus.emit('log', { line: `${mockRun.mode === 'dry' ? '🔎' : '✅'}《${t.cfg.作品名称}》${mockRun.mode === 'dry' ? '干跑完成（未真实提交）' : '投递成功'}` });
      mockAdvance(true);
      return;
    }
    mockRun.timer = setTimeout(mockTick, 420 + Math.random() * 380);
  }
  function mockAdvance(ok, note) {
    mockFinishCurrent(ok, note);
    mockRun.idx++; mockRun.step = 0;
    if (mockRun.idx >= mockRun.list.length) {
      mockRun.active = false;
      bus.emit('run-progress', { done: true, dryRun: mockRun.mode === 'dry', ok: mockRun.list.filter(i => !i._fail).length, fail: mockRun.list.filter(i => i._fail).length, skip: 0 });
      mockEmitStatus();
      return;
    }
    mockTick();
  }

  /* ---------- Mock window.api 同签名实现 ---------- */
  window.MockBackend = {
    isMock: true,
    async getSiteData() { return JSON.parse(JSON.stringify(mockSiteData)); },
    async getSettings() {
      try { return JSON.parse(localStorage.getItem('mock-settings') || '{}'); } catch { return {}; }
    },
    async saveSettings(patch) {
      const cur = await this.getSettings();
      try { localStorage.setItem('mock-settings', JSON.stringify(Object.assign(cur, patch))); } catch {}
      return { ok: true };
    },
    async getCredentials() {
      try { return JSON.parse(localStorage.getItem('mock-cred') || 'null') || { has: true, phone: '18500007967' }; }
      catch { return { has: true, phone: '18500007967' }; }
    },
    async saveCredentials(phone) {
      try { localStorage.setItem('mock-cred', JSON.stringify({ has: !!phone, phone: phone || '' })); } catch {}
      return { ok: true };
    },
    async clearCredentials() { return { ok: true }; },
    async pickFiles(kind) {
      if (kind === 'image') {
        return new Promise(resolve => {
          const inp = document.createElement('input');
          inp.type = 'file'; inp.accept = 'image/*';
          inp.onchange = () => {
            const f = inp.files[0];
            if (!f) return resolve([]);
            const reader = new FileReader();
            reader.onload = () => resolve([reader.result]);   // dataURL 充当路径
            reader.readAsDataURL(f);
          };
          inp.click();
        });
      }
      return new Promise(resolve => {
        const inp = document.createElement('input');
        inp.type = 'file'; inp.accept = '.txt,.docx'; inp.multiple = true;
        inp.onchange = () => {
          const chosen = [...inp.files];
          chosen.forEach(f => { MockBackend._files.set(f.name, f); });
          resolve(chosen.map(f => 'C:\\mock\\uploads\\' + f.name));
        };
        inp.click();
      });
    },
    async archiveCover(src) { return { ok: true, path: src }; },
    async saveCover({ src, name }) {
      if (!src) return { ok: false, error: '无封面' };
      const a = document.createElement('a');
      a.href = src;
      a.download = `${name || '封面'}.png`;
      a.click();
      return { ok: true, path: '已通过浏览器下载' };
    },
    _files: new Map(),
    async prepareTask({ kind, path, work }) {
      await new Promise(r => setTimeout(r, 400));
      if (kind === 'site') {
        const name = work.title;
        return {
          ok: true,
          cfg: mkCfg({ 作品名称: name, 作品简介: work.intro || '从站内作品导入，简介沿用站内版本。', 作品字数: work.wordCount || '', 作品频道: '男频' }),
          info: { coverSource: 'site' },
        };
      }
      const fname = (path || '').split(/[\\/]/).pop().replace(/\.(txt|docx)$/i, '');
      const f = this._files.get(fname + '.txt') || this._files.get(fname + '.docx');
      let intro = '已导入本地稿件（模拟解析）。';
      let words = '';
      if (f && /\.txt$/i.test(f.name)) {
        try {
          const text = await f.text();
          const count = text.replace(/\s/g, '').length;
          if (count) words = count;
          const head = text.replace(/\s+/g, ' ').trim().slice(0, 110);
          if (head) intro = head;
        } catch {}
      }
      return { ok: true, cfg: mkCfg({ 作品名称: fname, 作品简介: intro, 作品字数: words, 本地文件: path || '' }), info: { coverSource: 'local' } };
    },
    async siteWorks() {
      await new Promise(r => setTimeout(r, 800));
      return {
        ok: true,
        works: [
          { title: '长安十二味', storyType: 'long', wordCount: 15000, update: '2026-09-08', submitted: true, cover: '' },
          { title: '相亲遇到前上司之后', storyType: 'short', wordCount: 11000, update: '2026-09-07', submitted: true, cover: '' },
          { title: '电梯里的第七个人', storyType: 'short', wordCount: 8000, update: '2026-09-01', submitted: false, cover: '' },
        ],
      };
    },
    async loadTasks() { return JSON.parse(JSON.stringify(mockTasks)); },
    async saveTasks(list) {
      // 把渲染层的任务列表写回 mock 数据源（保留运行中状态不被覆盖）
      for (const snap of list) {
        const t = mockTasks.find(x => x.id === snap.id);
        if (!t) continue;
        if (t.status !== 'running' && t.status !== 'queued') t.status = snap.status;
        t.cfg = snap.cfg; t.range = snap.range; t.deai = snap.deai;
        t.sid = snap.sid; t.siteInfo = snap.siteInfo; t.coverPrompt = snap.coverPrompt || '';
      }
      return { ok: true };
    },
    async loadLogs() {
      return [
        { line: '🐉 龙利鱼投稿助手启动完成（演示模式，使用模拟后端）' },
        { line: '✅ 平台授权校验通过：蛙蛙写作（185***7967）' },
        { line: 'INFO 任务调度器已启动，下次批量投稿时间 今晚 20:00' },
        { line: '✅《深夜代驾那些事》投递成功（第1-3章）' },
        { line: '⚠️《前夫的白月光破产了》投递失败：章节字数不足' },
        { line: '❌《硅基黎明》投递失败：接口超时（重试 3 次未成功）' },
        { line: 'INFO《雨夜欢迎你》已提交，等待站内审核' },
      ];
    },
    async genCandidates(cfg, field, count = 3, prompt, options = {}) {
      await new Promise(r => setTimeout(r, 700));
      if (field === 'title') return { ok: true, items: localTitleVariants(cfg.作品名称, cfg.作品简介).slice(0, count), source: 'local' };
      if (field === 'intro') return { ok: true, items: localIntroVariants(cfg.作品简介).slice(0, count), source: 'local' };
      if (field === 'cover-prompt') return { ok: true, prompt: prompt || localCoverPrompt(cfg.作品名称, cfg.作品简介), promptSource: prompt ? 'manual' : 'default' };
      if (field === 'cover') {
        const v = Math.floor(Math.random() * 6);
        return { ok: true, cover: drawPlaceholderCover(cfg.作品名称 || '未命名', v), prompt: prompt || localCoverPrompt(cfg.作品名称, cfg.作品简介), promptSource: prompt ? 'manual' : 'default', source: 'local' };
      }
      return { ok: false, error: '未知字段' };
    },
    async refreshPanel(checkList) {
      await new Promise(r => setTimeout(r, 1100));
      const byTitle = {}, updates = {};
      for (const item of checkList) {
        if (Math.random() < 0.55) {
          byTitle[item.title] = { status: 'reviewing', submittedN: 6 + Math.floor(Math.random() * 8) };
        }
        if (item.file) {
          const localN = 20 + Math.floor(Math.random() * 30);
          const sub = (byTitle[item.title] || {}).submittedN ?? 0;
          updates[item.title] = { localN, submittedN: sub, canUpdate: localN - sub >= 2 };
        }
      }
      return { ok: true, byTitle, updates };
    },
    async runTasks(list, mode, headless) {
      if (mockRun.active) return { ok: false, error: '已有任务在运行' };
      mockRun.active = true; mockRun.paused = false; mockRun.browserLost = false;
      mockRun.mode = mode; mockRun.list = list.map(x => Object.assign({ _fail: false }, x));
      mockRun.idx = 0; mockRun.step = 0;
      mockEmitStatus();
      setTimeout(mockTick, 300);
      return { ok: true, results: [] }; // 真正的结果通过事件流回
    },
    runControl(action) {
      if (!mockRun.active) return { ok: false, error: '当前没有运行中的任务' };
      if (action === 'pause') { mockRun.paused = true; mockEmitStatus(); }
      else if (action === 'resume') { mockRun.paused = false; mockRun.browserLost = false; mockEmitStatus(); }
      else if (action === 'skip') {
        const item = mockRun.list[mockRun.idx];
        const t = mockTasks.find(x => x.id === item.id);
        if (t) { t.status = 'ready'; t.message = '已手动跳过'; bus.emit('task-status', { id: t.id, status: 'ready', message: '已手动跳过' }); }
        clearTimeout(mockRun.timer);
        mockAdvance('skip');
      } else if (action === 'abort') {
        clearTimeout(mockRun.timer);
        const cur = mockTasks.find(x => x.id === (mockRun.list[mockRun.idx] || {}).id);
        if (cur && (cur.status === 'running' || cur.status === 'queued')) { cur.status = 'ready'; cur.message = '已停止'; }
        mockRun.active = false;
        mockEmitStatus();
        bus.emit('run-progress', { done: true, dryRun: mockRun.mode === 'dry', stopped: true, ok: mockRun.idx, fail: 0, skip: 0 });
      }
      return { ok: true };
    },
    async revenueSummary() {
      await new Promise(r => setTimeout(r, 1200));
      const days = [];
      const base = [86, 64, 120, 98, 142, 76, 110, 88, 135, 96, 158, 124, 102, 146];
      let total = 5200;
      for (let i = 13; i >= 0; i--) {
        const d = new Date(Date.now() - i * 86400000);
        const rev = base[13 - i];
        total += rev;
        days.push({ date: d.toISOString().slice(0, 10), rev, total, readers: 8000 + (13 - i) * 260 });
      }
      const books = [
        { sid: 's1', title: '我在废土捡了个系统', status: '已签约', channel: '男频', type: '长篇', words: 24000, dayRev: 52.4, follows: 32418, fDelta: 1204, total: 5286, week: { sum: 320, prev: 290 }, firstDate: '2026-07-21', ignored: false, hasData: true, daily: days.map(p => ({ date: p.date, r: p.rev * 0.36, f: p.readers, fd: 260 })) },
        { sid: 's2', title: '深夜代驾那些事', status: '已签约', channel: '男频', type: '长篇', words: 18000, dayRev: 18.6, follows: 21047, fDelta: 386, total: 2144, week: { sum: 128, prev: 141 }, firstDate: '2026-07-25', ignored: false, hasData: true, daily: [] },
        { sid: 's3', title: '山海食堂', status: '已签约', channel: '男频', type: '长篇', words: 20000, dayRev: 16.8, follows: 15662, fDelta: 431, total: 2286, week: { sum: 116, prev: 108 }, firstDate: '2026-08-02', ignored: false, hasData: true, daily: [] },
        { sid: 's4', title: '雨夜欢迎你', status: '审核中', channel: '男频', type: '短篇', words: 9000, dayRev: 6.2, follows: 9864, fDelta: -56, total: 864, week: { sum: 44, prev: 51 }, firstDate: '2026-08-11', ignored: false, hasData: true, daily: [] },
        { sid: 's5', title: '前夫的白月光破产了', status: '已签约', channel: '女频', type: '短篇', words: 12000, dayRev: 9.4, follows: 7233, fDelta: 124, total: 1102, week: { sum: 62, prev: 58 }, firstDate: '2026-08-15', ignored: false, hasData: true, daily: [] },
      ];
      return {
        ok: true, latestDate: days[days.length - 1].date, syncedCount: 0,
        totalRevenue: total, yesterdayDelta: 23.4, totalFollows: 124062, readerUp: 3320, readerDown: 210,
        totalBooks: books.length + 2, signedCount: 5,
        last7Total: 812.5, prev7Total: 686.2,
        series: days,
        monthly: [{ month: '2026-08', rev: 2468.0, endReaders: 118000 }, { month: '2026-09', rev: 899.2, endReaders: 124062 }],
        byChannel: { '男频': { count: 6, total: 9866, dayRev: 94, follows: 86234 }, '女频': { count: 3, total: 2230, dayRev: 52.2, follows: 37828 } },
        byType: { '长篇': { count: 6, total: 10240, dayRev: 112.2, follows: 96400 }, '短篇': { count: 3, total: 1856, dayRev: 34, follows: 27662 } },
        byStatus: { '已签约': { count: 5, total: 11682, dayRev: 130, follows: 101000 }, '审核中': { count: 2, total: 414, dayRev: 16.2, follows: 23062 } },
        byCat: { '科幻': { count: 3, total: 6100, dayRev: 71, follows: 52000 }, '都市': { count: 3, total: 3820, dayRev: 44.6, follows: 41000 }, '其他': { count: 3, total: 2176, dayRev: 30.6, follows: 31062 } },
        books,
      };
    },
    async toggleRevIgnore() { return { ok: true }; },
    async exportRevenueCsv() { return { ok: false, error: '演示模式不支持导出（需在应用内使用）' }; },
    async listTemplates() { return []; },
    async saveTemplate() { return { ok: true }; },
    async applyTemplate() { return { ok: true }; },
    async deleteTemplate() { return { ok: true }; },
    async listAccounts() {
      try { return JSON.parse(localStorage.getItem('mock-accounts') || '[]'); } catch { return []; }
    },
    async saveAccount(name, phone) {
      const list = await this.listAccounts();
      const i = list.findIndex(a => a.name === name);
      if (i >= 0) list[i].phone = phone; else list.push({ name, phone });
      try { localStorage.setItem('mock-accounts', JSON.stringify(list)); } catch {}
      return { ok: true };
    },
    async switchAccount() { return { ok: true }; },
    async deleteAccount(name) {
      const list = (await this.listAccounts()).filter(a => a.name !== name);
      try { localStorage.setItem('mock-accounts', JSON.stringify(list)); } catch {}
      return { ok: true };
    },
    async testAi(kind) {
      await new Promise(r => setTimeout(r, 800));
      return { ok: true, message: kind === 'image' ? '图像AI 测试图生成成功（演示）' : '文本AI 连接正常（演示）' };
    },
    async checkUpdate() { return { ok: true, isNewer: false, current: '2.1.0' }; },
    async notifyDone() { return { ok: true }; },
    async openOutput() { return { ok: true }; },
    async openPath() { return { ok: true }; },
    onRevStatus(cb) { bus.on('rev-status', cb); },
    onLog(cb) { bus.on('log', cb); },
    onRunStatus(cb) { bus.on('run-status', cb); },
    onTaskStatus(cb) { bus.on('task-status', cb); },
    onRunProgress(cb) { bus.on('run-progress', cb); },
    onLoginWait(cb) { bus.on('login-wait', cb); },
  };
})();
