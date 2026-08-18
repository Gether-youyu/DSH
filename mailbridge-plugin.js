// DSH 邮件/飞书桥接插件(持久化版 v13)
// 由 ~/.dsh/profiles/web/cordis.patch.yml 通过绝对路径加载
// 功能:任务切换(targetSession)+ 模型选择 + 忙时提示语 + 停/继续 + 审批桥 + 认领互斥 + 路径动态化
// v13:配置路径改用插件同目录 config.json(支持目录改名后仍可分发)
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
    function stripToolTrace(s) {
      if (!s) return '';
      let t = s;
      // 1) 标准 XML 形式: <tool_calls>...</tool_calls> / <invoke name=...> / <tool_result>...</tool_result>
      t = t.replace(/<\s*\/?\s*tool_calls[\s\S]*?<\s*\/\s*tool_calls\s*>/gi, ' ')
           .replace(/<\s*tool_calls[\s\S]*$/gi, ' ');
      t = t.replace(/<\s*invoke\s+name=[\s\S]*?>/gi, ' ').replace(/<\s*\/\s*invoke\s*>/gi, ' ');
      t = t.replace(/<\s*tool_result[\s\S]*?<\s*\/\s*tool_result\s*>/gi, ' ')
           .replace(/<\s*tool_result[\s\S]*$/gi, ' ');
      // 2) DSML 流标记变体(飞书显示为全角): ｜｜DSML ｜｜tool_calls ｜｜invoke 等
      t = t.replace(/[｜|]{1,2}\s*DSML[\s\S]*?[｜|]{1,2}\s*DSML/gi, ' ')
           .replace(/[｜|]{1,2}\s*DSML[\s\S]*$/gi, ' ');
      t = t.replace(/[｜|]{1,2}\s*tool_calls[\s\S]*?[｜|]{1,2}\s*tool_calls\s*>/gi, ' ')
           .replace(/[｜|]{1,2}\s*tool_calls[\s\S]*$/gi, ' ');
      t = t.replace(/[｜|]{1,2}\s*invoke[\s\S]*?>/gi, ' ').replace(/[｜|]{1,2}\s*\/\s*invoke\s*>/gi, ' ');
      // 兜底:清理残留 XML/DSML 标签碎片
      t = t.replace(/<\/?[a-zA-Z_][^>]*>/g, ' ').replace(/[<>]/g, ' ');
      t = t.replace(/[｜|]{1,2}\s*\/?\s*[a-z_]+[^\n]*?[｜|]?/gi, ' ');
      t = t.replace(/[ \t]{2,}/g, ' ').replace(/(\n\s*){2,}/g, '\n');
      t = t.replace(/[\/｜|]{1,3}\s*$/g, '');
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
      out += '\n推理强度可选: off / high / max';
      out += '\n不选强度则使用系统默认强度:' + effortName(DEFAULT_EFFORT);
      return { text: out, items: ordered.map((m) => ({ provider: m.provider, id: m.id, name: m.name })) };
    }

    async function selectModel(req) {
      const effort = req.effort || DEFAULT_EFFORT;
      await model.saveSelection({
        provider: req.provider,
        model: req.model,
        ...(effort ? { reasoningEffort: effort } : {}),
      });
      return { text: '✅ 已切换到模型: ' + req.model + ' 强度:' + effortName(effort) + '\n新会话将使用该模型。' };
    }

    async function handleCommand(req) {
      try {
        if (req.command === 'task-list') return await listTasks();
        if (req.command === 'task-select') return await selectTask(req);
        if (req.command === 'model-list') return await listModelsCmd();
        if (req.command === 'model-select') return await selectModel(req);
      } catch (e) {
        return { text: '命令处理出错: ' + ((e && e.message) || e) };
      }
      return { text: '未知命令' };
    }

    async function agentForSession(sessionId) {
      const roots = agents.roots() || [];
      const live = roots.find((a) => a.id === sessionId);
      if (live) return live;
      const sel = model.currentSelection();
      const handle = await agents.resume({
        resumeSessionId: sessionId,
        agentOptions: { provider: sel.provider, model: sel.model },
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
        const handle = await agents.resume({ resumeSessionId: FALLBACK_SESSION, agentOptions });
        fallbackAgent = handle.agent;
      } catch (e) {
        const handle = await agents.create({
          sessionId: FALLBACK_SESSION,
          meta: { cwd: '/' },
          agentOptions,
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
          agent.followup({
            role: 'user',
            content: [{ type: 'text', text: '[手机恢复执行] ' + resumed }],
            source: { kind: 'user' },
            id: 'mail-resume-' + Date.now(),
          });
          return '🔄 已恢复执行被终止的任务：' + String(resumed).slice(0, 60) + (String(resumed).length > 60 ? '…' : '');
        }
        return '没有已终止的任务可恢复。';
      }
      return null;
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
        const deadline = Date.now() + 10 * 60 * 1000;
        let saw = false;
        // 30 秒提示:请求文件仍未完成(回复未产出)则发送一次;已产出则不打扰
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

        while (Date.now() < deadline) {
          await sleep(600);
          const evs = (agent.session.events || []).filter((e) => e.seq >= firstSeq);
          if (evs.some((e) => e.type === 'turn/start' || e.type === 'assistant/message')) saw = true;
          if (saw) {
            const idle = await Promise.race([agent.whenIdle().then(() => true), sleep(2000).then(() => false)]);
            if (idle) break;
          }
        }
        disposePrompt();
        await sessions.flush(agent.session);
        const reply = summarize(agent.session.events, firstSeq) || '(处理超时,请稍后在电脑端查看)';
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

    console.log('[mailbridge] 持久化版 v13 已启动(路径动态化,可分发)');
  }
};
