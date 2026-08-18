#!/usr/bin/env node
/**
 * DSH 飞书桥 v3 -- 官方 SDK 长连接 + 任务管理命令。
 * 手机飞书私聊机器人 -> 命令(本地处理) / 消息(队列 -> DSH 插件注入指定会话) -> 回复。
 *
 * 命令(发原文即可,大小写不限):
 *   任务列表 | 列表          查看电脑端全部 DSH 任务(卡片式清单,发数字切换)
 *   3 | 切换 3              把手机消息固定发到第 3 个任务(直接发数字)
 *   跟随 | 跟随电脑          恢复自动跟随电脑当前活跃任务
 *   当前                    查看现在的消息去向
 */
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const lark = require("@larksuiteoapi/node-sdk");

const BRIDGE_DIR = __dirname + "/bridge";
const IN_DIR = BRIDGE_DIR + "/in";
const TARGET_PATH = BRIDGE_DIR + "/feishu-target.json";
const DSH_HOME = os.homedir() + "/.dsh";

let cfg = null;
try {
  cfg = JSON.parse(fs.readFileSync(__dirname + "/config.json", "utf8"));
  cfg = { appId: cfg.feishu.appId, appSecret: cfg.feishu.appSecret };
} catch (e) {
  try {
    cfg = JSON.parse(fs.readFileSync(BRIDGE_DIR + "/feishu.json", "utf8"));
  } catch (e2) {
    console.error("错误: 缺少 config.json 或 bridge/feishu.json 配置");
    process.exit(1);
  }
}
const APP_ID = cfg.appId;
const APP_SECRET = cfg.appSecret;

// ---------- 文件日志(无论谁启动,日志都落盘可查) ----------
try {
  const logStream = require("fs").createWriteStream("/tmp/feishu-bridge.log", { flags: "a" });
  const origLog = console.log, origErr = console.error;
  console.log = (...a) => { origLog(...a); logStream.write(new Date().toISOString() + " " + a.join(" ") + "\n"); };
  console.error = (...a) => { origErr(...a); logStream.write(new Date().toISOString() + " ERR " + a.join(" ") + "\n"); };
} catch (e) {}

// ---------- 单实例锁(端口锁,防多实例重复处理队列) ----------
const net = require("net");
const LOCK_PORT = 13880;
const lockServer = net.createServer();
lockServer.on("error", () => {
  console.error("[feishu] 已有实例运行(端口 " + LOCK_PORT + " 被占用),本实例退出");
  process.exit(1);
});
lockServer.listen(LOCK_PORT, "127.0.0.1", () => console.log("[feishu] 单实例锁已持有(端口 " + LOCK_PORT + ")"));
// ---------- 心跳(供 monitor.js 检测存活) ----------
const HB_FILE = "/tmp/dsh-heartbeat";
function beat() { try { require("fs").writeFileSync(HB_FILE, String(Date.now())); } catch (e) {} }
beat();
setInterval(beat, 60000);


const client = new lark.Client({ appId: APP_ID, appSecret: APP_SECRET });

// ---------- 任务(会话)列表 ----------
function readJson(fp, fallback) {
  try { return JSON.parse(fs.readFileSync(fp, "utf8")); } catch { return fallback; }
}

// 在 ~/.dsh/sessions/<编码后的工作区>/<会话ID>/ 下定位会话文件(目录名编码规则复杂,直接扫描匹配会话ID)
function findSessionFile(sid) {
  try {
    const base = DSH_HOME + "/sessions";
    for (const d of fs.readdirSync(base)) {
      const fp = path.join(base, d, sid, "session.jsonl.zstd");
      try { fs.statSync(fp); return fp; } catch {}
    }
  } catch {}
  return null;
}

function listDSHSessions() {
  const wsStore = readJson(DSH_HOME + "/storages/workspace.json", null);
  const proj = readJson(DSH_HOME + "/storages/session_projcache.json", null);
  const archived = new Set(((wsStore && wsStore.global && wsStore.global.archivedSessionIds) || []));
  const rows = (proj && proj.tables && proj.tables.sessions) || {};
  const items = [];
  const workspaces = (wsStore && wsStore.tables && wsStore.tables.workspaces) || {};
  for (const ws of Object.values(workspaces)) {
    for (const sid of ws.sessionIds || []) {
      if (archived.has(sid)) continue;
      const row = rows[sid] && rows[sid].rows;
      const stats = (row && row.sessionStats && row.sessionStats.val) || {};
      // 与 DSH 界面一致:只列出有对话轮次的会话(空白会话不显示)
      if (!(stats.turns > 0)) continue;
      // 与 DSH 界面一致:用 lastPromptAt(最后发起对话时间)作为"最近使用时间"
      const meta = (row && row.sessionListMetadata && row.sessionListMetadata.val) || {};
      const lastAt = meta.lastPromptAt || 0;
      const title = (row && row.title && row.title.val || "").trim();
      const wsName = ws.title || path.basename(ws.path || "");
      const label = title || wsName; // 有对话的会话通常都有标题;兜底用工作区名,不再出现"未命名"
      items.push({ id: sid, label, wsName, lastAt });
    }
  }
  items.sort((a, b) => b.lastAt - a.lastAt);
  return items;
}

function relTime(ms) {
  if (!ms) return "无记录";
  const d = new Date(ms);
  const now = new Date();
  const diff = now - ms;
  const min = 60 * 1000, hour = 60 * min, day = 24 * hour;
  if (diff < min) return "刚刚";
  if (diff < hour) return Math.floor(diff / min) + "分钟前";
  if (d.toDateString() === now.toDateString()) return "今天 " + d.toTimeString().slice(0, 5);
  const yest = new Date(now - day);
  if (d.toDateString() === yest.toDateString()) return "昨天 " + d.toTimeString().slice(0, 5);
  return (d.getMonth() + 1) + "月" + d.getDate() + "日 " + d.toTimeString().slice(0, 5);
}

function targetState() {
  const st = readJson(TARGET_PATH, {});
  if (st.mode !== "pinned") return { mode: "auto" };
  return st;
}

// 当前消息去向的会话(pinned 且会话存在时),供 model-select 等命令携带
function resolveCurrentTarget(chatId) {
  const st = targetState();
  if (st.mode === "pinned" && st.sessionId && sessionDirExists(st.sessionId)) return st.sessionId;
  return null;
}

function saveState(st) { try { fs.writeFileSync(TARGET_PATH, JSON.stringify(st, null, 1)); } catch {} }

function sessionDirExists(sid) { return !!findSessionFile(sid); }

function buildTaskList() {
  const items = listDSHSessions();
  const st = targetState();
  // 当前(消息实际进入的会话)与跟随(自动进入电脑最近活跃对话)分开标记
  let currentId = null;
  let followId = null;
  if (st.mode === "pinned") currentId = st.sessionId;
  else if (items.length) { currentId = items[0].id; followId = items[0].id; }
  let lines = ["📋 DSH 任务列表（共 " + items.length + " 个，按最近使用排序）"];
  items.forEach((it, i) => {
    const marks = [];
    if (it.id === currentId) marks.push("←当前");
    if (it.id === followId) marks.push("跟随");
    lines.push((i + 1) + ". [" + it.wsName + "] " + it.label + "（" + relTime(it.lastAt) + "）" + (marks.length ? " " + marks.join(" · ") : ""));
  });
  lines.push("", "发「数字」切换任务 · 发「跟随」自动进入电脑最近活跃对话");
  return { text: lines.join("\n"), items };
}

// ---------- 任务卡片(互动卡片, 第一版测试的字号布局) ----------
function buildTaskCard(items, st) {
  // 排序规则(自定义):当前生效会话置顶,其余按最后活跃时间倒序
  let currentId = null; // "当前":消息实际进入的会话
  let followId = null;  // "跟随":跟随模式下指向的最近活跃会话
  if (st.mode === "pinned") currentId = st.sessionId;
  else if (items.length) { currentId = items[0].id; followId = items[0].id; }
  const sorted = items.slice().sort((a, b) => {
    const ac = a.id === currentId ? 0 : 1;
    const bc = b.id === currentId ? 0 : 1;
    if (ac !== bc) return ac - bc;
    return b.lastAt - a.lastAt;
  });
  // 按工作区分组(不重复:工作区只出现在分组标题,行内不再显示)
  const groups = [];
  for (const it of sorted) {
    let g = groups.find((x) => x.ws === it.wsName);
    if (!g) { g = { ws: it.wsName, items: [] }; groups.push(g); }
    g.items.push(it);
  }
  // 布局(同第一版测试):分组标题灰字加粗,每行"对话名 + 标记"同行、时间换行,全部默认字号,无按钮
  const elements = [];
  for (const g of groups) {
    elements.push({
      tag: "div",
      text: { tag: "lark_md", content: "<font color='grey'>**" + g.ws + "** · " + g.items.length + " 个对话</font>" },
    });
    for (const it of g.items) {
      const marks = [];
      if (it.id === currentId) marks.push("<font color='green'>**当前**</font>");
      if (it.id === followId) marks.push("<font color='blue'>**跟随**</font>");
      const label = it.label.replace(/\|/g, "");
      elements.push({
        tag: "div",
        text: {
          tag: "lark_md",
          content: "**" + label + "**" + (marks.length ? " " + marks.join(" ") : "") + "\n" + relTime(it.lastAt),
        },
      });
    }
  }
  return {
    schema: "2.0",
    header: { template: "blue", title: { tag: "plain_text", content: "📋 DSH 任务（" + items.length + "）" } },
    body: {
      elements: [
        ...elements,
        { tag: "hr" },
        { tag: "div", text: { tag: "plain_text", content: "发数字切换任务 · 发「跟随」恢复跟随 · 发「当前」查看", text_size: "small" } },
      ],
    },
  };
}

async function sendCard(chatId, card) {
  try {
    await client.im.message.create({
      params: { receive_id_type: "chat_id" },
      data: { receive_id: chatId, msg_type: "interactive", content: JSON.stringify(card) },
    });
    console.log("[feishu] 已发送任务卡片到 " + chatId);
    return true;
  } catch (e) {
    console.error("[feishu] 卡片发送失败: " + ((e && e.message) || e));
    return false;
  }
}

// ---------- 命令处理(本地,不进DSH) ----------
const USAGE_TEXT = '📖 DSH 使用说明\n\n【指令】\n· 任务列表 —— 查看可切换的任务\n· 发数字 —— 切换到对应任务\n· 跟随 —— 恢复跟随电脑最近任务\n· 当前 —— 查看消息去向\n· 选择模型 —— 切换模型和推理强度\n· 停 —— 终止正在执行的任务\n· 继续 —— 恢复被终止的任务\n· 使用说明 —— 查看本说明\n\n【邮箱推送】\n每天 19:59 自动发邮件总结当天工作，标题「DSH提醒+日期」，无需任何操作。';

async function handleCommand(rawText, chatId) {
  const text = rawText.trim();
  const st = targetState();
  // 使用说明
  if (/^(使用说明|说明|帮助|help)$/i.test(text)) {
    await sendText(chatId, USAGE_TEXT);
    return true;
  }
  // 任务列表 -> 纯文本(已定稿,不再用卡片)
  if (/^(任务列表|列表|任务|list)$/i.test(text)) {
    const list = buildTaskList();
    saveState({ ...st, lastList: list.items.map((i) => ({ id: i.id, label: i.label, wsName: i.wsName })) });
    await sendText(chatId, list.text);
    return true;
  }
  // 切换 N:支持 "3" 直接切换,也兼容 "切换 3" / "switch 3"
  const m = text.match(/^切换\s*(\d+)$/) || text.match(/^switch\s*(\d+)$/i) || text.match(/^(\d{1,2})$/);
  if (m) {
    const n = Number(m[1]);
    const last = (st.lastList || (readJson(TARGET_PATH, {}).lastList)) || [];
    if (!last.length) { await sendText(chatId, "请先发送「任务列表」查看任务，再发送数字切换。"); return true; }
    if (n < 1 || n > last.length) { await sendText(chatId, "序号超出范围(1-" + last.length + ")，请发送「任务列表」确认。"); return true; }
    const target = last[n - 1];
    if (!sessionDirExists(target.id)) { await sendText(chatId, "任务 [" + (target.wsName || "") + "] " + target.label + " 已不存在，请重新发送「任务列表」。"); return true; }
    saveState({ mode: "pinned", sessionId: target.id, label: target.label, wsName: target.wsName, lastList: last });
    await sendText(chatId, "📌 已切换到任务：[" + (target.wsName || "") + "] " + target.label + "\n之后手机发的消息都会进这个任务，发送「任务列表」可选择其他任务。");
    return true;
  }
  // 选择模型 -> 走队列到 DSH 插件(模型列表来自 llm 服务)
  if (/^(选择模型|模型选择|模型|model)$/i.test(text)) {
    enqueueCommand(chatId, "model-list");
    await sendText(chatId, "正在获取模型列表...");
    return true;
  }
  // 模型选择中的数字应答(如 "1" 或 "1 high")
  const modelPick = text.match(/^(\d{1,2})(?:\s+(\S+))?$/);
  if (modelPick && pendingModel.has(chatId)) {
    const st = pendingModel.get(chatId);
    const idx = parseInt(modelPick[1], 10) - 1;
    const item = st.items && st.items[idx];
    if (item) {
      pendingModel.delete(chatId);
      // 携带当前目标会话,使模型切换对当前对话立即生效
      const curTarget = resolveCurrentTarget(chatId);
      enqueueCommand(chatId, "model-select", {
        provider: item.provider,
        model: item.id,
        ...(curTarget ? { targetSession: curTarget } : {}),
        ...(normalizeEffort(modelPick[2]) ? { effort: normalizeEffort(modelPick[2]) } : {}),
      });
      await sendText(chatId, "正在切换模型: " + item.name + (normalizeEffort(modelPick[2]) ? " 强度:" + normalizeEffort(modelPick[2]) : "") + " ...");
      return true;
    }
  }
  // 跟随电脑
  if (/^(跟随|跟随电脑|auto)$/i.test(text)) {
    const items = listDSHSessions();
    saveState({ mode: "auto", lastList: st.lastList });
    await sendText(chatId, "🖥️ 已恢复跟随：消息将进入电脑上最近活跃的任务" + (items[0] ? "（[" + items[0].wsName + "] " + items[0].label + "）" : "") + "。");
    return true;
  }
  // 当前
  if (/^(当前|状态)$/i.test(text)) {
    if (st.mode === "pinned") await sendText(chatId, "当前固定任务：[" + (st.wsName || "") + "] " + st.label);
    else { const items = listDSHSessions(); await sendText(chatId, "跟随电脑模式，最近活跃任务：" + (items[0] ? "[" + items[0].wsName + "] " + items[0].label : "(无)")); }
    return true;
  }
  return false;
}

// ---------- 队列 ----------
const pendingModel = new Map(); // chatId -> { items: [{provider,id,name}] } 模型选择状态

function enqueue(text, chatId, targetSession) {
  const fileName = "feishu-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6) + ".json";
  const req = { status: "new", from: "feishu", chatId, text };
  if (targetSession) req.targetSession = targetSession;
  fs.writeFileSync(path.join(IN_DIR, fileName), JSON.stringify(req));
  console.log("[feishu] 已入队: " + fileName + " chat=" + chatId + (targetSession ? " target=" + targetSession : ""));
}

function enqueueCommand(chatId, command, extra) {
  const fileName = "feishu-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6) + ".json";
  const req = { status: "new", from: "feishu", chatId, command, ...(extra || {}) };
  fs.writeFileSync(path.join(IN_DIR, fileName), JSON.stringify(req));
  console.log("[feishu] 命令入队: " + command + " -> " + fileName);
}

function normalizeEffort(e) {
  const v = String(e || "").trim().toLowerCase();
  if (["off", "high", "max"].includes(v)) return v;
  return undefined;
}

async function sendText(chatId, text) {
  if (!text || !String(text).trim()) { console.log("[feishu] 跳过空回复"); return true; }
  try {
    await client.im.message.create({
      params: { receive_id_type: "chat_id" },
      data: { receive_id: chatId, msg_type: "text", content: JSON.stringify({ text }) },
    });
    console.log("[feishu] 已发送回复到 " + chatId);
    return true;
  } catch (e) {
    console.error("[feishu] 发送失败: " + ((e && e.message) || e));
    return false;
  }
}

async function drainQueue() {
  let files;
  try { files = fs.readdirSync(IN_DIR); } catch { return; }
  for (const f of files) {
    if (!f.startsWith("feishu-") || !f.endsWith(".json")) continue;
    const fp = path.join(IN_DIR, f);
    let state;
    try { state = JSON.parse(fs.readFileSync(fp, "utf8")); } catch { continue; }
    if (state.status === "done") {
      // 提示文件:若对应原消息已完成(正文已发),则丢弃该提示,避免"正文后补发提示"
      if (state.originFile) {
        let originDone = true;
        try {
          const o = JSON.parse(fs.readFileSync(path.join(IN_DIR, state.originFile), "utf8"));
          originDone = o.status === "done" || o.status === "error";
        } catch (e) { originDone = true; }
        if (originDone) {
          console.log("[feishu] 正文已回复,丢弃多余提示: " + f);
          try { fs.unlinkSync(fp); } catch {}
          continue;
        }
      }
      // 模型列表回复带 items 时缓存选择状态
      if (state.items && state.chatId && state.command === "model-list") {
        pendingModel.set(state.chatId, { items: state.items });
        console.log("[feishu] 已缓存模型列表: " + state.chatId + " (" + state.items.length + " 项)");
      }
      const ok = await sendText(state.chatId, state.reply || "(无回复)");
      if (ok) { try { fs.unlinkSync(fp); } catch {} }
    } else if (state.status === "error") {
      await sendText(state.chatId, "处理出错: " + (state.error || "未知错误"));
      try { fs.unlinkSync(fp); } catch {}
    }
  }
}

// ---------- 事件处理 ----------
const channel = new lark.LarkChannel({
  appId: APP_ID,
  appSecret: APP_SECRET,
  loggerLevel: lark.LoggerLevel.info,
});

// 从飞书消息 content 中提取纯文本:兼容 text 与 post(富文本) 两种类型
function extractText(msg) {
  const type = msg.rawContentType;
  const raw = String(msg.content || "");
  if (type === "text") return raw.replace(/@_user_\d+/g, "").trim();
  if (type === "post") {
    try {
      const parsed = JSON.parse(raw);
      const lines = [];
      for (const row of parsed.content || []) {
        let line = "";
        for (const seg of row || []) {
          if (seg && seg.tag === "text" && seg.text) line += seg.text;
        }
        lines.push(line);
      }
      return lines.join("\n").replace(/@_user_\d+/g, "").trim();
    } catch (e) {
      return raw.replace(/@_user_\d+/g, "").trim();
    }
  }
  return null;
}

channel.on("message", async (data) => {
  console.log("[feishu] 收到消息: " + JSON.stringify(data).slice(0, 800));
  const msg = data || {};
  if (msg.chatType !== "p2p") { console.log("[feishu] 非私聊(" + msg.chatType + "),忽略"); return; }
  const text = extractText(msg);
  if (text === null) { console.log("[feishu] 非文本(" + msg.rawContentType + "),忽略"); return; }
  if (!text) { console.log("[feishu] 空内容"); return; }
  const chatId = msg.chatId || (msg.raw && msg.raw.message && msg.raw.message.chat_id);
  if (!chatId) { console.log("[feishu] 无 chatId"); return; }
  try {
    if (await handleCommand(text, chatId)) return; // 命令本地处理
  } catch (e) { console.error("[feishu] 命令处理失败: " + e.message); }
  let targetSession = null;
  const st = targetState();
  if (st.mode === "pinned" && st.sessionId && sessionDirExists(st.sessionId)) targetSession = st.sessionId;
  enqueue(text, chatId, targetSession);
});

channel.on("reject", (evt) => console.log("[feishu] 事件被策略拒绝: " + JSON.stringify(evt)));
channel.on("error", (e) => console.log("[feishu] 通道错误: " + ((e && (e.code + " " + e.message)) || e)));
channel.on("reconnecting", () => console.log("[feishu] 连接断开,重连中..."));
channel.on("reconnected", () => console.log("[feishu] 已重新连接"));

// 卡片按钮回调:点「切换」直接切换任务
channel.on("cardAction", async (evt) => {
  const v = (evt && evt.action && evt.action.value) || {};
  if (!v.switchTo) { console.log("[feishu] 卡片回调无 switchTo,忽略"); return; }
  const sessionId = String(v.switchTo);
  console.log("[feishu] 卡片按钮切换 -> " + sessionId);
  if (!sessionDirExists(sessionId)) { await sendText(evt.chatId, "该任务已不存在，请重新发送「任务列表」。"); return; }
  const last = (readJson(TARGET_PATH, {}).lastList) || [];
  const t = last.find((i) => i.id === sessionId) || { id: sessionId, label: v.label || "任务", wsName: v.wsName || "" };
  saveState({ mode: "pinned", sessionId, label: t.label, wsName: t.wsName, lastList: last });
  await sendText(evt.chatId, "📌 已切换到任务：[" + (t.wsName || "") + "] " + t.label + "\n之后手机发的消息都会进这个任务，发送「任务列表」可选择其他任务。");
});

// 本地自测: node feishu-bridge.js test-list | test-card
if (process.argv[2] === "test-list") {
  console.log(buildTaskList().text);
  process.exit(0);
}
if (process.argv[2] === "test-card") {
  const items = listDSHSessions();
  const st = { mode: "pinned", sessionId: items[0] && items[0].id, label: (items[0] && items[0].label) || "" };
  console.log(JSON.stringify(buildTaskCard(items, st), null, 1));
  process.exit(0);
}

channel.connect().then(() => {
  console.log("[feishu] 飞书桥 v3 已启动,长连接已建立 " + new Date().toLocaleString() + ",App: " + APP_ID);
}).catch((e) => {
  console.error("[feishu] 连接失败: " + ((e && e.message) || e));
  process.exit(1);
});

setInterval(() => { drainQueue().catch((e) => console.error("[feishu] 队列处理失败: " + e.message)); }, 3000);
