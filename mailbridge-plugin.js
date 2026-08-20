// DSH 邮件/飞书桥接插件(持久化版 v13)
// 由 ~/.dsh/profiles/web/cordis.patch.yml 通过绝对路径加载
// 功能:任务切换(targetSession)+ 模型选择 + 忙时提示语 + 停/继续 + 审批桥 + 认领互斥 + 路径动态化
// v13:配置路径改用插件同目录 config.json(支持目录改名后仍可分发)
// v14:「继续」恢复任务改走完整投递流程(修复恢复后最终回复丢失);任务被终止/报错时如实告知
module.exports = {
  name: 'mailbridge',
  inject: ['fs', 'timer', 'agents', 'sessions', 'agentDefaultModel'],
  apply(ctx) {
    const fs = ctx.get('fs');
    const timer = ctx.get('timer');
    const agents = ctx.get('agents');
    const sessions = ctx.get('sessions');
    const model = ctx.get('agentDefaultModel');
    if (!fs || !timer || !agents || !sessions || !model) {
      console.error('[mailbridge] 必需服务缺失');
      return;
    }
    const sleep = (ms) => timer.timeout(ms);
    let BASE = '/tmp/dsh-bridge';
    let STATE_FILE = BASE + '/state.json';
    // 读取统一配置(告警 chatId 等)
    let ALERT_CHAT = '';
    (async () => {
      try {
        const cfgPath = __dirname + '/config.json';
        const cfgRaw = await fs.readText(await fs.resolve(cfgPath));
        const cfgJson = JSON.parse(cfgRaw);
        if (cfgJson.installDir) {
          BASE = cfgJson.installDir + '/bridge';
          STATE_FILE = BASE + '/state.json';
        }
        ALERT_CHAT = (cfgJson.notify && cfgJson.notify.alertChatId) || '';
        console.log('[mailbridge] 配置已加载: BASE=' + BASE + ' alert=' + (ALERT_CHAT ? 'yes' : 'no'));
      } catch (e) {
        console.error('[mailbridge] 配置读取失败(使用默认路径): ' + ((e && e.message) || e));
      }
    })();
    const FALLBACK_SESSION = 'session-mail-bridge';
    const EFFORT_NAMES = { off: 'Off', high: 'High', max: 'Max' };
    const BUSY_LINES = [
      '正在干活中……',
      '收到，正在吭哧吭哧干活中……',
      '收到，本AI正在疯狂输出中……',
      '收到，正在埋头苦干中……',
      '来活了，正在卖力干活中……',
    ];
    function busyPrompt() {
      const line = BUSY_LINES[Math.floor(Math.random() * BUSY_LINES.length)];
      return line + '\n输入「停」我会立即终止这次任务，输入「继续」我会执行最近一次被终止的任务，其他消息在本次任务结束后回复你。';
    }
    const DEFAULT_EFFORT = 'max';
    let fallbackAgent;
    let busy = false;

    // 剥离 assistant 消息里的工具调用轨迹(<tool_calls>/<invoke name= XML),防止泄漏给飞书/邮件
    // 全角/半角归一化:把飞书可能转义的 ＜＞｜｜ 统一还原为 <>|,再走标准正则
    function normalizeAngle(s) {
      return s.replace(/[＜＞]/g, (c) => (c === '＜' ? '<' : '>'))
              .replace(/[｜]/g, '|');
    }
    function stripToolTrace(s) {
      if (!s) return '';
      let t = normalizeAngle(s);
      // 1) 标准 XML 形式(归一化后统一处理): <tool_calls>...</tool_calls> / <invoke name=...> / <tool_result>...</tool_result>
      t = t.replace(/<\s*\/?\s*tool_calls[\s\S]*?<\s*\/\s*tool_calls\s*>/gi, ' ')
           .replace(/<\s*tool_calls[\s\S]*$/gi, ' ');
      t = t.replace(/<\s*invoke\s+name=[\s\S]*?>/gi, ' ').replace(/<\s*\/\s*invoke\s*>/gi, ' ');
      t = t.replace(/<\s*tool_result[\s\S]*?<\s*\/\s*tool_result\s*>/gi, ' ')
           .replace(/<\s*tool_result[\s\S]*$/gi, ' ');
      // 2) DSML 流标记变体(归一化后 |DSML |tool_calls |invoke 等)
      t = t.replace(/\|{1,2}\s*DSML[\s\S]*?\|{1,2}\s*DSML/gi, ' ')
           .replace(/\|{1,2}\s*DSML[\s\S]*$/gi, ' ');
      t = t.replace(/\|{1,2}\s*tool_calls[\s\S]*?\|{1,2}\s*tool_calls\s*>/gi, ' ')
           .replace(/\|{1,2}\s*tool_calls[\s\S]*$/gi, ' ');
      t = t.replace(/\|{1,2}\s*invoke[\s\S]*?>/gi, ' ').replace(/\|{1,2}\s*\/\s*invoke\s*>/gi, ' ');
      // 3) 兜底:清理残留标签碎片(含 | 变体)
      t = t.replace(/<\/?[a-zA-Z_][^>]*>/g, ' ').replace(/[<>]/g, ' ');
      t = t.replace(/\|{1,2}\s*\/?\s*[a-z_]+[^\n]*?\|?/gi, ' ');
      t = t.replace(/[ \t]{2,}/g, ' ').replace(/(\n\s*){2,}/g, '\n');
      t = t.replace(/[\/|]{1,3}\s*$/g, '');
      return t.trim();
    }

    function summarize(events, firstSeq) {
      let started = false;
      let text = '';
      for (const ev of events) {
        if (ev.seq < firstSeq) continue;
        if (ev.type === 'turn/start') { started = true; continue; }
        if (!started) continue;
        if (ev.type === 'assistant/message') {
          const joined = (ev.data.message.content || [])
            .filter((b) => b.type === 'text')
            .map((b) => stripToolTrace(b.text || ''))
            .filter((t) => t !== '')
            .join('');
          if (joined !== '') text = joined;
        }
      }
      return text;
    }

    async function readState() {
      try {
        const raw = await fs.readText(await fs.resolve(STATE_FILE));
        return JSON.parse(raw) || {};
      } catch (e) { return {}; }
    }
    async function writeState(state) {
      try { await fs.writeText(await fs.resolve(STATE_FILE), JSON.stringify(state, null, 2)); } catch (e) { console.error('[mailbridge] 写状态失败: ' + e.message); }
    }

    async function taskLabel(sessionId, cwd) {
      let title = '';
      let wsTitle = '';
      try {
        const st = ctx.get('sessionTitle');
        if (st) {
          const t = await st.readTitle(sessionId);
          title = (t && t.title) || '';
        }
      } catch (e) {}
      try {
        if (cwd) {
          const wsr = ctx.get('workspaceRegistry');
          if (wsr) {
            const ws = await wsr.resolveByPath(cwd);
            wsTitle = (ws && ws.title) || '';
          }
        }
      } catch (e) {}
      return { wsTitle, title };
    }

    async function listTasks() {
      const sq = ctx.get('sessionQuery');
      const items = [];
      if (sq) {
        const records = await sq.listSessions();
        for (const r of records || []) {
          const id = r.header.id;
          if (id === FALLBACK_SESSION || id.startsWith('session-mail-bridge')) continue;
          try {
            const label = await taskLabel(id, r.header.cwd);
            items.push({ id, wsTitle: label.wsTitle, title: label.title, createdAt: r.header.createdAt });
          } catch (e) {}
        }
      }
      const roots = agents.roots() || [];
      const liveIds = new Set(roots.map((a) => a.id));
      items.sort((a, b) => (liveIds.has(b.id) ? 1 : 0) - (liveIds.has(a.id) ? 1 : 0) || (b.createdAt || 0) - (a.createdAt || 0));
      const top = items.slice(0, 20);
      let out = '📋 任务列表:\n';
      top.forEach((it, i) => {
        out += (i + 1) + '. ' + (it.wsTitle ? '[' + it.wsTitle + '] ' : '') + (it.title || it.id.slice(-8)) + '\n';
      });
      out += '请输入序号切换任务(如:1)';
      return { text: out, items: top.map((it) => ({ id: it.id, label: (it.wsTitle ? '[' + it.wsTitle + '] ' : '') + (it.title || it.id.slice(-8)) })) };
    }

    async function selectTask(req) {
      const state = await readState();
      if (!state.chats) state.chats = {};
      state.chats[req.chatId] = { targetSession: req.targetSession };
      await writeState(state);
      const label = await taskLabel(req.targetSession, req.cwd);
      const name = (label.wsTitle ? '[' + label.wsTitle + '] ' : '') + (label.title || req.targetSession.slice(-8));
      return {
        text: '📌 已切换到任务：' + name + '\n之后手机发的消息都会进这个任务，发送「任务列表」可选择其他任务。',
      };
    }

    function effortName(e) { return EFFORT_NAMES[e] || e || '—'; }

    async function listModelsCmd() {
      const llmSvc = ctx.get('llm');
      const sel = model.currentSelection();
      const items = [];
      if (llmSvc) {
        const providers = llmSvc.listProviders();
        for (const p of providers || []) {
          try {
            const models = await llmSvc.listModels(p.id);
            for (const m of models || []) items.push({ provider: p.id, id: m.id, name: m.name });
          } catch (e) {}
        }
      }
      const ordered = [
        ...items.filter((m) => m.id === sel.model && m.provider === sel.provider),
        ...items.filter((m) => !(m.id === sel.model && m.provider === sel.provider)),
      ];
      let out = '🤖 模型列表:\n当前: ' + sel.model + ' 强度:' + effortName(sel.reasoningEffort) + '\n\n';
      ordered.forEach((m, i) => { out += (i + 1) + '. ' + m.name + '\n'; });
      out += '\n请输入序号选择模型';
      out += '\n推理强度可选: off / high / max(仅支持的模型)';
      out += '\n不选强度则使用模型默认强度';
      return { text: out, items: ordered.map((m) => ({ provider: m.provider, id: m.id, name: m.name })) };
    }

    async function selectModel(req) {
      // 用户不带强度时:不传 reasoningEffort,让 DSH 用模型自身默认(避免默认 max 被不支持)
      const effort = req.effort;
      const sel = { provider: req.provider, model: req.model, ...(effort ? { reasoningEffort: effort } : {}) };
      // 先校验该模型是否支持此推理强度(与官方 selectModel 同源校验)
      try {
        const llmSvc = ctx.get('llm');
        if (llmSvc) {
          await llmSvc.resolveCallConfig(sel);
        }
      } catch (e) {
        return { text: '❌ 该模型不支持 ' + effortName(effort) + ' 推理强度:' + ((e && e.message) || e) + '\n可重发数字选择模型,不带强度则用模型默认' };
      }
      // 1) 全局默认(新会话使用该模型)
      try { await model.saveSelection(sel); } catch (e) {}
      // 2) 走官方 session.selectModel 通道:当前会话立即生效(含已记录模型选择的会话)
      const sid = (req && req.targetSession) || '';
      let curEffect = false;
      if (sid) {
        try {
          const apiProxy = ctx.get('apiProxy');
          if (apiProxy && apiProxy.sessions && typeof apiProxy.sessions.selectModel === 'function') {
            // api.sessions.selectModel 是 RPC 业务方法,期望 { payload: {...} },返回 { rpcId, result:{ok,value} }
            const res = await apiProxy.sessions.selectModel({ payload: { sessionId: sid, ...sel } });
            const okFlag = !!(res && res.result && res.result.ok === true);
            const errInfo = (res && res.result && res.result.ok === false && res.result.error) ? (res.result.error.message || JSON.stringify(res.result.error)) : (res && res.error ? (res.error.message || JSON.stringify(res.error)) : '');
            if (!okFlag) throw new Error(errInfo || 'selectModel RPC 返回失败');
            curEffect = true;
          }
        } catch (e) {
          console.error('[mailbridge] 官方 selectModel 通道失败(回退仅全局默认): ' + ((e && e.message) || e));
        }
      }
      const tip = curEffect ? '\n当前对话已立即生效。' : '\n新会话将使用该模型。';
      const effTxt = effort ? ' 强度:' + effortName(effort) : '(模型默认强度)';
      return { text: '✅ 已切换到模型: ' + req.model + effTxt + tip };
    }


    // 创建全新会话并切换桥的 pin:用于会话上下文被污染(DSML 泄漏/超长历史)时干净重启
    // 走官方 apiProxy session.create(自动挂预设+注册工作区),再改名并更新 feishu-target.json
    async function sessionNewCmd(req) {
      const apiProxy = ctx.get('apiProxy');
      if (!apiProxy || !apiProxy.sessions || typeof apiProxy.sessions.create !== 'function') {
        return { text: '❌ 会话创建通道不可用' };
      }
      const payload = {};
      if (req.workspaceId) payload.workspaceId = req.workspaceId;
      else if (req.cwd) payload.cwd = req.cwd;
      const res = await apiProxy.sessions.create({ payload });
      const okFlag = !!(res && res.result && res.result.ok === true);
      if (!okFlag) {
        const errInfo = (res && res.result && res.result.error) ? (res.result.error.message || JSON.stringify(res.result.error)) : '未知错误';
        return { text: '❌ 创建会话失败: ' + errInfo };
      }
      const newSid = res.result.value && res.result.value.sessionId;
      if (!newSid) return { text: '❌ 创建会话失败: 返回无 sessionId' };
      if (req.title && apiProxy.sessions && typeof apiProxy.sessions.rename === 'function') {
        try { await apiProxy.sessions.rename({ payload: { sessionId: newSid, title: req.title } }); } catch (e) {
          console.error('[mailbridge] 新会话命名失败: ' + ((e && e.message) || e));
        }
      }
      let pin = {};
      try { pin = JSON.parse(await fs.readText(await fs.resolve(BASE + '/feishu-target.json'))); } catch (e) {}
      pin.mode = 'pinned';
      pin.sessionId = newSid;
      if (req.title) pin.label = req.title;
      if (!pin.wsName) pin.wsName = 'DSH永不眠';
      try {
        await fs.writeText(await fs.resolve(BASE + '/feishu-target.json'), JSON.stringify(pin, null, 1));
      } catch (e) {
        return { text: '✅ 会话已创建(' + newSid + ')但 pin 更新失败: ' + ((e && e.message) || e) };
      }
      return { text: '✅ 已创建新会话并切换: ' + (req.title || newSid) + '\n后续消息将进入干净的新会话。' };
    }

    async function handleCommand(req) {
      try {
        if (req.command === 'session-new') return await sessionNewCmd(req);
        if (req.command === 'task-list') return await listTasks();
        if (req.command === 'task-select') return await selectTask(req);
        if (req.command === 'model-list') return await listModelsCmd();
        if (req.command === 'model-select') return await selectModel(req);
      if (req.command === 'tool-check') return await toolCheckCmd(req);
      } catch (e) {
        return { text: '命令处理出错: ' + ((e && e.message) || e) };
      }
      return { text: '未知命令' };
    }

    async function toolCheckCmd(req) {
      const out = {};
      try {
        const tools = ctx.get('tools');
        out.defaultMode = tools.defaultMode;
        out.globalBash = !!tools.get('bash');
        try { out.globalView = [...tools.view().visible.keys()].join(',').slice(0, 500); } catch (e) { out.globalViewErr = String(e).slice(0, 100); }
      } catch (e) { out.toolsErr = String(e).slice(0, 150); }
      try {
        const sid = (req && req.targetSession) || '';
        const ag = sid ? await agentForSession(sid) : null;
        if (ag) {
          out.agentId = ag.id;
          out.preset = ag.session && ag.session.header && ag.session.header.agentPreset;
          const tools = ctx.get('tools');
          out.agentMode = tools.modeFor(ag);
          out.agentBash = !!tools.get('bash', ag);
          try { out.agentView = [...tools.view(ag).visible.keys()].join(',').slice(0, 500); } catch (e) { out.agentViewErr = String(e).slice(0, 100); }
        } else { out.agentErr = 'no sid'; }
      } catch (e) { out.agentErr = String(e).slice(0, 150); }
      try { fs.writeText(await fs.resolve('/tmp/toolcheck.json'), JSON.stringify(out, null, 1)); } catch (e) {}
      console.log('[mailbridge] tool-check: ' + JSON.stringify(out).slice(0, 600));
      return { text: '工具诊断已写入 /tmp/toolcheck.json' };
    }

    // 预设挂载回调:DSH Web 版的工具全部由 agent preset 提供(roster 挂载),
    // 直接 agents.resume 不带 setup 的 agent 不在任何预设作用域,工具注册表为空,
    // 表现为 "unknown tool bash"。按 apiproxy composeAgent 同款逻辑补挂:
    // 取会话最近一次 agent-preset/selected 事件(无则读 header),mount 到 agent 作用域。
    function presetSetup() {
      const presets = ctx.get('agentPresets');
      if (!presets) return undefined;
      return async (agentCtx) => {
        let presetId;
        try {
          const ag = agentCtx && agentCtx.agent;
          if (ag && ag.session) {
            const events = ag.session.events || [];
            for (let i = events.length - 1; i >= 0; i--) {
              const ev = events[i];
              if (ev && ev.type === 'agent-preset/selected' && ev.data && ev.data.agentPreset) {
                presetId = ev.data.agentPreset;
                break;
              }
            }
            if (presetId === undefined) {
              presetId = ag.session.header && ag.session.header.agentPreset;
            }
          }
        } catch (e) {}
        await presets.mount(agentCtx, presetId);
      };
    }

    async function agentForSession(sessionId) {
      const roots = agents.roots() || [];
      const live = roots.find((a) => a.id === sessionId);
      if (live) return live;
      const sel = model.currentSelection();
      const handle = await agents.resume({
        resumeSessionId: sessionId,
        agentOptions: { provider: sel.provider, model: sel.model },
        setup: presetSetup(),
      });
      return handle.agent;
    }

    async function targetAgent(req) {
      if (req && req.targetSession) {
        try { return await agentForSession(req.targetSession); } catch (e) {
          console.error('[mailbridge] 指定会话失败,回退: ' + ((e && e.message) || e));
        }
      }
      if (req && req.chatId) {
        const state = await readState();
        const saved = state.chats && state.chats[req.chatId];
        if (saved && saved.targetSession) {
          try { return await agentForSession(saved.targetSession); } catch (e) {}
        }
      }
      const roots = agents.roots();
      let best = null;
      let bestSeq = -1;
      for (const a of roots || []) {
        if (a.id === FALLBACK_SESSION) continue;
        const events = (a.session && a.session.events) || [];
        const last = events.length ? events[events.length - 1].seq : -1;
        if (last > bestSeq) { bestSeq = last; best = a; }
      }
      if (best) return best;
      if (fallbackAgent) return fallbackAgent;
      const sel = model.currentSelection();
      const agentOptions = { provider: sel.provider, model: sel.model };
      try {
        const handle = await agents.resume({ resumeSessionId: FALLBACK_SESSION, agentOptions, setup: presetSetup() });
        fallbackAgent = handle.agent;
      } catch (e) {
        const handle = await agents.create({
          sessionId: FALLBACK_SESSION,
          meta: { cwd: '/' },
          agentOptions,
          setup: presetSetup(),
        });
        fallbackAgent = handle.agent;
      }
      return fallbackAgent;
    }

    function isBusy(agent) {
      return agent && agent.status === 'running';
    }

    // ===== 审批桥(飞书审批) =====
    const pendingApprovals = []; // {id, agentId, resolve, timer}
    let approvalSeq = 0;

    // 审批通知目标 chatId:优先配置的 alertChatId,否则回退到 state.json 中任意活跃 chat(用户实际对话)
    async function resolveAlertChat() {
      if (ALERT_CHAT) return ALERT_CHAT;
      try {
        const st = await readState();
        const keys = Object.keys(st.chats || {});
        if (keys.length) return keys[0];
      } catch (e) {}
      return '';
    }

    function registerApprovalHandler(agent) {
      if (!agent || !agent.ctx || agent.__approvalRegistered) return;
      agent.__approvalRegistered = true;
      try {
        agent.ctx.on('approval/request', async (req, next) => {
          console.log('[mailbridge] ⭐审批请求(tool=' + (req && req.toolName) + ', reason=' + (req && req.reason) + ')');
          const p = { id: 'apv-' + (++approvalSeq), agentId: agent.id, resolve: null };
          pendingApprovals.push(p);
          const promise = new Promise((resolve) => { p.resolve = resolve; });
          const pf = 'feishu-approval-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6) + '.json';
          const reason = (req && req.reason) || '(无说明)';
          const tool = (req && req.toolName) || '(未知工具)';
          const notifyText = '⚠️ 需要审批\n工具: ' + tool + '\n原因: ' + reason + '\n\n回复「同意」或「拒绝」(5分钟内有效)';
          const targetChat = await resolveAlertChat();
          if (!targetChat) console.error('[mailbridge] 审批通知发送失败: 无可用 chatId(ALERT_CHAT 未配置且无活跃聊天)');
          fs.writeText(await fs.resolve(BASE + '/in/' + pf), JSON.stringify({ status: 'done', from: 'feishu', chatId: targetChat, reply: notifyText })).catch((e) => {});
          p.timer = timer.timeout(() => {
            const idx = pendingApprovals.indexOf(p);
            if (idx >= 0) { pendingApprovals.splice(idx, 1); p.resolve('cancelled'); }
          }, 300000);
          return promise; // 不调 next():飞书独占审批
        }, { prepend: true });
      } catch (e) {
        console.error('[mailbridge] 审批监听注册失败: ' + ((e && e.message) || e));
      }
    }

    timer.interval(() => {
      try {
        for (const a of agents.roots() || []) registerApprovalHandler(a);
      } catch (e) {}
    }, 5000);
    for (const a of agents.roots() || []) registerApprovalHandler(a);

    async function handleControlText(req, agent) {
      const text = String(req.text || '').trim();
      const state = await readState();
      if (!state.chats) state.chats = {};
      const chat = state.chats[req.chatId] || {};
      if (text === '停' || text === '停止') {
        if (isBusy(agent)) {
          try { agent.cancel('手机端用户请求终止任务'); } catch (e) {}
          chat.cancelled = chat.lastMsg || null;
          state.chats[req.chatId] = chat;
          await writeState(state);
          return '⏹ 已终止当前任务。\n输入「继续」可重新执行最近一次被终止的任务。';
        }
        return '当前没有正在执行的任务。';
      }
      if (text === '同意' || text === '允许' || text === '批准') {
        if (pendingApprovals.length) {
          const p = pendingApprovals.shift();
          if (p.timer) p.timer();
          p.resolve('allowed-once');
          return '✅ 已同意审批，任务继续执行。';
        }
        return '当前没有待审批的请求。';
      }
      if (text === '拒绝') {
        if (pendingApprovals.length) {
          const p = pendingApprovals.shift();
          if (p.timer) p.timer();
          p.resolve('rejected');
          return '❌ 已拒绝审批，任务已终止该操作。';
        }
        return '当前没有待审批的请求。';
      }
      if (text === '继续') {
        if (chat.cancelled) {
          const resumed = chat.cancelled;
          chat.cancelled = null;
          state.chats[req.chatId] = chat;
          await writeState(state);
          // 只返回恢复指令,不在此处 followup:由 handleRequest 走与普通任务相同的
          // "等待回合结束→提取回复→写回队列"流程。旧版在此直接 followup 后立即返回,
          // 被恢复任务的最终回复无人回收,永远送不到手机(v13 丢回复 bug 根因)
          return {
            ack: '🔄 已恢复执行被终止的任务：' + String(resumed).slice(0, 60) + (String(resumed).length > 60 ? '…' : ''),
            resumeText: '[手机恢复执行] ' + resumed,
          };
        }
        return '没有已终止的任务可恢复。';
      }
      return null;
    }

    // 等待当前回合真正结束并产出回复文本(普通任务与「继续」恢复任务共用)
    // 含:30 秒忙时提示、报错显式化、被终止如实告知
    async function waitTurnReply(agent, firstSeq, req, fileName) {
      const deadline = Date.now() + 10 * 60 * 1000;
      let saw = false;
      let prompted = false;
      const disposePrompt = timer.timeout(async () => {
        if (prompted) return;
        let finished = false;
        try {
          const raw = await fs.readText(await fs.resolve(BASE + '/in/' + fileName));
          const st = JSON.parse(raw);
          if (st.status === 'done' || st.status === 'error') finished = true;
        } catch (e) { finished = true; }
        if (!finished) {
          prompted = true;
          const pf = 'feishu-prompt-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6) + '.json';
          try {
            await fs.writeText(await fs.resolve(BASE + '/in/' + pf), JSON.stringify({ status: 'done', from: 'feishu', chatId: req.chatId, reply: busyPrompt(), originFile: fileName }));
            console.log('[mailbridge] 30秒未产出回复,已发送忙时提示: ' + pf);
          } catch (e) { console.error('[mailbridge] 忙时提示失败: ' + e.message); }
        }
      }, 30000);
      // 等待回合真正结束:看到 assistant/message 产出后,等待 turn/end 事件(而非 whenIdle 短暂空闲),
      // 避免 agent 工具调用间隙的假 idle 导致提前结束、取消 30 秒提示
      while (Date.now() < deadline) {
        await sleep(600);
        const evs = (agent.session.events || []).filter((e) => e.seq >= firstSeq);
        if (evs.some((e) => e.type === 'turn/start' || e.type === 'assistant/message')) saw = true;
        // 回合真正结束的标志:出现了 turn/end,或产出 assistant/message 后连续 2 次确认 idle(间隔检查,防假 idle)
        if (evs.some((e) => e.type === 'turn/end')) break;
        if (saw) {
          const idle1 = await Promise.race([agent.whenIdle().then(() => true), sleep(2000).then(() => false)]);
          if (idle1) {
            await sleep(600);
            const idle2 = await Promise.race([agent.whenIdle().then(() => true), sleep(2000).then(() => false)]);
            if (idle2) break; // 连续两次确认空闲,判定回合结束
          }
        }
      }
      disposePrompt();
      await sessions.flush(agent.session);
      // 回合以报错结束时如实告知错误;被终止时如实告知终止——不得一律误导为"处理超时"
      let turnErr = null;
      let turnAborted = false;
      for (const e of (agent.session.events || [])) {
        if (e.seq < firstSeq || e.type !== 'turn/end') continue;
        const r = e.data && e.data.reason;
        if (r && r.kind === 'error') turnErr = String((r.error && (r.error.message || r.error)) || '未知错误').slice(0, 300);
        if (r && r.kind === 'aborted') turnAborted = true;
      }
      let reply = summarize(agent.session.events, firstSeq);
      if (turnErr) reply = reply ? reply + '\n\n⚠️ 本次任务最后报错: ' + turnErr : '❌ 任务执行失败: ' + turnErr;
      if (!reply && turnAborted) reply = '⏹ 任务已被终止。输入「继续」可恢复执行。';
      if (!reply) reply = '(处理超时,请稍后在电脑端查看)';
      return reply;
    }

    async function handleRequest(fileName, req) {
      const target = await fs.resolve(BASE + '/in/' + fileName);
      try {
        await fs.writeText(target, JSON.stringify({ ...req, status: 'claimed', claimedAt: Date.now() }));
        if (req.command) {
          const result = await handleCommand(req);
          await fs.writeText(target, JSON.stringify({ ...req, status: 'done', reply: result.text, ...(result.items ? { items: result.items } : {}) }));
          console.log('[mailbridge] 命令处理完成: ' + req.command);
          return;
        }
        const agent = await targetAgent(req);
        const ctl = await handleControlText(req, agent);
        if (ctl !== null) {
          if (ctl && typeof ctl === 'object' && ctl.resumeText) {
            // 「继续」:恢复执行被终止的任务,复用普通任务的等待/投递流程,保证结果送达手机
            if (busy) {
              await fs.writeText(target, JSON.stringify({ ...req, status: 'done', reply: '⏳ 上一个任务还在收尾,稍后再发「继续」即可。' }));
              return;
            }
            busy = true;
            try {
              await agent.whenIdle();
              const firstSeq = agent.session.seq + 1;
              agent.followup({
                role: 'user',
                content: [{ type: 'text', text: ctl.resumeText }],
                source: { kind: 'user' },
                id: 'mail-resume-' + Date.now(),
              });
              const reply = ctl.ack + '\n\n' + (await waitTurnReply(agent, firstSeq, req, fileName));
              await fs.writeText(target, JSON.stringify({ ...req, status: 'done', reply }));
              console.log('[mailbridge] 已回复(恢复任务) ' + fileName);
            } catch (err) {
              try { await fs.writeText(target, JSON.stringify({ ...req, status: 'error', error: String((err && err.message) || err) })); } catch (_) {}
              console.error('[mailbridge] 恢复任务失败 ' + fileName + ': ' + ((err && err.message) || err));
            } finally { busy = false; }
            return;
          }
          await fs.writeText(target, JSON.stringify({ ...req, status: 'done', reply: ctl }));
          return;
        }
        // 忙/闲统一:直接 followup(agent 的 inbox 天然排队),回复由下方等待循环产出
        await agent.whenIdle();
        const firstSeq = agent.session.seq + 1;
        const sourceTag = req.from === 'feishu' ? '[来自飞书] ' : '[来自邮件] ';
        agent.followup({
          role: 'user',
          content: [{ type: 'text', text: sourceTag + String(req.text || '') }],
          source: { kind: 'user' },
          id: 'mail-' + fileName,
        });
        const state0 = await readState();
        if (!state0.chats) state0.chats = {};
        const chat0 = state0.chats[req.chatId] || {};
        chat0.lastMsg = String(req.text || '');
        state0.chats[req.chatId] = chat0;
        await writeState(state0);
        const reply = await waitTurnReply(agent, firstSeq, req, fileName);
        await fs.writeText(target, JSON.stringify({ ...req, status: 'done', reply }));
        console.log('[mailbridge] 已回复 ' + fileName);
      } catch (err) {
        try {
          await fs.writeText(target, JSON.stringify({ ...req, status: 'error', error: String((err && err.message) || err) }));
        } catch (_) {}
        console.error('[mailbridge] 处理失败 ' + fileName + ': ' + ((err && err.message) || err));
      }
    }

    const IN_FLIGHT = new Set();
    const CLAIMED_TIMEOUT_MS = 10 * 60 * 1000; // claimed 超过 10 分钟视为卡死(context disposed 等异常)
    const MAX_RETRIES = 3;

    timer.interval(async () => {
      const CONTROL = /^(停|停止|继续|同意|允许|批准|拒绝)$/;
      // 第一遍:控制消息(停/继续/同意/拒绝)——不受 busy 限制,必须随时响应
      try {
        const dir0 = await fs.resolve(BASE + '/in');
        const entries0 = await fs.listDir(dir0);
        for (const entry of entries0 || []) {
          if (!entry.name || !entry.name.endsWith('.json')) continue;
          if (IN_FLIGHT.has(entry.name)) continue;
          const raw0 = await fs.readText(await fs.resolve(BASE + '/in/' + entry.name));
          let req0;
          try { req0 = JSON.parse(raw0); } catch (e) { continue; }
          if (req0.status === 'new' && req0.text && CONTROL.test(String(req0.text).trim()) && !req0.command) {
            IN_FLIGHT.add(entry.name);
            try { await handleRequest(entry.name, req0); } finally { IN_FLIGHT.delete(entry.name); }
            break;
          }
        }
      } catch (e) {
        console.error('[mailbridge] 控制消息处理错误: ' + ((e && e.message) || e));
      }
      // 第二遍:普通消息(受 busy 保护,一次一条)
      if (busy) return;
      busy = true;
      try {
        const dir = await fs.resolve(BASE + '/in');
        const entries = await fs.listDir(dir);
        for (const entry of entries || []) {
          if (!entry.name || !entry.name.endsWith('.json')) continue;
          if (IN_FLIGHT.has(entry.name)) continue;
          const raw = await fs.readText(await fs.resolve(BASE + '/in/' + entry.name));
          let req;
          try { req = JSON.parse(raw); } catch (e) { continue; }
          if (req.status === 'new') {
            IN_FLIGHT.add(entry.name);
            try { await handleRequest(entry.name, req); } finally { IN_FLIGHT.delete(entry.name); }
            break;
          }
          if (req.status === 'claimed' && req.claimedAt && Date.now() - req.claimedAt > CLAIMED_TIMEOUT_MS) {
            const retries = (req.retries || 0) + 1;
            if (retries > MAX_RETRIES) {
              await fs.writeText(await fs.resolve(BASE + '/in/' + entry.name), JSON.stringify({ ...req, status: 'error', error: '重试 ' + MAX_RETRIES + ' 次仍卡死,放弃' }));
              console.error('[mailbridge] 卡死消息放弃: ' + entry.name);
              continue;
            }
            console.log('[mailbridge] 回收卡死消息,重试(' + retries + '): ' + entry.name);
            const newReq = { ...req, status: 'new', retries };
            await fs.writeText(await fs.resolve(BASE + '/in/' + entry.name), JSON.stringify(newReq));
            IN_FLIGHT.add(entry.name);
            try { await handleRequest(entry.name, newReq); } finally { IN_FLIGHT.delete(entry.name); }
            break;
          }
        }
      } catch (e) {
        console.error('[mailbridge] 轮询错误: ' + ((e && e.message) || e));
      } finally {
        busy = false;
      }
    }, 3000);

    console.log('[mailbridge] 持久化版 v14 已启动(恢复任务投递修复 + 终止/报错如实告知)');
  }
};
