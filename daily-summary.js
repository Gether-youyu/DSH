#!/usr/bin/env node
/**
 * DSH 每日邮件提醒 —— 每天 19:59 由 cron 触发。
 * 直接统计会话文件当天活动(只解析时间/轮次元数据,不读对话正文),
 * 总结当天 0 点至执行前的用户活动,用 DeepSeek 生成生动总结,SMTP 发送。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const https = require("https");
const tls = require("tls");

const HOME = os.homedir();
const BRIDGE_DIR = __dirname + "/bridge";

// ---------- 配置 ----------
let cfg = null;
try { cfg = JSON.parse(fs.readFileSync(__dirname + "/config.json", "utf8")); if (cfg.mail) cfg = cfg.mail; } catch (e) {}
if (!cfg) { try { cfg = JSON.parse(fs.readFileSync(BRIDGE_DIR + "/config.json", "utf8")); } catch (e2) {} }
const EMAIL = (cfg && cfg.smtp && cfg.smtp.user) || "";
// 每日推送收件人:优先 daily.recipient,否则回退到发件邮箱
let RECIPIENT = EMAIL;
{
  try {
    const full = JSON.parse(fs.readFileSync(__dirname + "/config.json", "utf8"));
    if (full.daily && full.daily.recipient) RECIPIENT = full.daily.recipient;
  } catch (e) {}
}
const PASS = (cfg && cfg.smtp && cfg.smtp.pass) || "";
const SMTP_HOST = (cfg && cfg.smtp && cfg.smtp.host) || "smtp.qq.com";
const SMTP_PORT = (cfg && cfg.smtp && cfg.smtp.port) || 465;

function getApiKey() {
  // DSH 设置页凭据(~/.dsh/.credentials.yaml,Models 页写入)
  try {
    const c = fs.readFileSync(HOME + "/.dsh/.credentials.yaml", "utf8");
    const m = c.match(/DEEPSEEK_API_KEY:\s*["\x27]?([^"\x27\s]+)/);
    if (m) return m[1].replace(/["\x27]/g, "");
  } catch (e) {}
  // 环境变量兜底(手动启动 dsh 时可用)
  return process.env.DEEPSEEK_API_KEY || "";
}
const API_KEY = getApiKey();

// ---------- 读取会话文件,统计当天真实活动(只解析元数据行,不碰对话正文) ----------
const { execFileSync } = require("child_process");
function readZstdSession(fp) {
  // 用 zstd CLI 解压整文件为行(本地命令,不依赖 SDK)
  try {
    const out = execFileSync("zstd", ["-dc", fp], { maxBuffer: 512 * 1024 * 1024, encoding: "utf8" });
    return out;
  } catch (e) { return ""; }
}
function analyzeToday(fp, startOfDay, nowMs) {
  const raw = readZstdSession(fp);
  if (!raw) return null;
  const times = [];
  let turns = 0, steps = 0;
  for (const line of raw.split("\n")) {
    if (!line) continue;
    try {
      const o = JSON.parse(line);
      if (!o.time || o.time < startOfDay || o.time > nowMs) continue;
      times.push(o.time);
      if (o.type === "turn/start") turns++;
      if (o.type === "step/start") steps++;
    } catch (e) {}
  }
  if (!times.length) return null;
  times.sort((a, b) => a - b);
  return { firstAt: times[0], lastAt: times[times.length - 1], times, turns, steps };
}
function readMemory() {
  const proj = JSON.parse(fs.readFileSync(HOME + "/.dsh/storages/session_projcache.json", "utf8"));
  const sessions = (proj.tables && proj.tables.sessions) || {};
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const today = [];
  const sessionsRoot = HOME + "/.dsh/sessions";
  for (const [sid, s] of Object.entries(sessions)) {
    const rows = (s && s.rows) || {};
    const meta = (rows.sessionListMetadata && rows.sessionListMetadata.val) || {};
    const title = ((rows.title && rows.title.val) || "").trim();
    const lastAt = meta.lastPromptAt || 0;
    if (lastAt < startOfDay || lastAt > now.getTime()) continue;
    // 定位会话文件(目录按 cwd 编码,需扫描)
    let fp = "";
    try {
      for (const d of fs.readdirSync(sessionsRoot)) {
        const cand = sessionsRoot + "/" + d + "/" + sid + "/session.jsonl.zstd";
        if (fs.existsSync(cand)) { fp = cand; break; }
      }
    } catch (e) {}
    if (!fp) continue;
    const stat = analyzeToday(fp, startOfDay, now.getTime());
    if (!stat) continue;
    today.push({ sid, title, ...stat });
  }
  today.sort((a, b) => a.firstAt - b.firstAt);
  return { today, now, startOfDay };
}

// ---------- DeepSeek 总结 ----------
function callDeepSeek(prompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: "deepseek-chat",
      messages: [
        { role: "system", content: "你是一个温暖、生动、有情绪的中文助手,擅长用简洁有感染力的语言总结用户的工作。" },
        { role: "user", content: prompt },
      ],
      max_tokens: 800,
    });
    const req = https.request({
      hostname: "api.deepseek.com",
      path: "/chat/completions",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + API_KEY,
        "Content-Length": Buffer.byteLength(body),
      },
    }, (res) => {
      let data = "";
      res.on("data", (c) => data += c);
      res.on("end", () => {
        try {
          const j = JSON.parse(data);
          resolve((j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || "");
        } catch (e) { reject(new Error("解析失败: " + data.slice(0, 200))); }
      });
    });
    req.on("error", reject);
    req.setTimeout(60000, () => req.destroy(new Error("API 超时")));
    req.write(body);
    req.end();
  });
}

// ---------- SMTP 发送 ----------
function smtpSend(to, subject, text) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host: SMTP_HOST, port: SMTP_PORT, rejectUnauthorized: false }, () => {
      socket.write("EHLO dsh\r\n");
    });
    let stage = 0;
    let buf = "";
    socket.on("error", (e) => reject(e));
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      if (!buf.includes("\r\n")) return;
      const line = buf.split("\r\n")[0];
      const code = line.slice(0, 3);
      if (code === "221") { socket.destroy(); resolve(); return; }
      if (code !== "235" && code !== "250" && code !== "334" && code !== "354" && code !== "220") {
        socket.destroy(); reject(new Error("SMTP: " + line)); return;
      }
      buf = "";
      stage += 1;
      switch (stage) {
        case 1: socket.write("AUTH LOGIN\r\n"); break;
        case 2: socket.write(Buffer.from(EMAIL).toString("base64") + "\r\n"); break;
        case 3: socket.write(Buffer.from(PASS).toString("base64") + "\r\n"); break;
        case 4: socket.write("MAIL FROM:<" + EMAIL + ">\r\n"); break;
        case 5: socket.write("RCPT TO:<" + to + ">\r\n"); break;
        case 6: socket.write("DATA\r\n"); break;
        case 7: {
          const msg =
            "From: DSH <" + EMAIL + ">\r\n" +
            "To: <" + to + ">\r\n" +
            "Subject: " + subject + "\r\n" +
            "Content-Type: text/plain; charset=utf-8\r\n" +
            "MIME-Version: 1.0\r\n" +
            "Date: " + new Date().toUTCString() + "\r\n" +
            "\r\n" + text + "\r\n.\r\n";
          socket.write(msg);
          break;
        }
        case 8: socket.write("QUIT\r\n"); break;
      }
    });
  });
}

// ---------- 主流程 ----------
async function main() {
  const { today, now } = readMemory();
  const dateStr = now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0") + "-" + String(now.getDate()).padStart(2, "0");

  // 计算活跃时长(LLM+工具计算时间)
  // 活跃窗口 = 今天最早事件到最晚事件(或当前时间)的跨度
  // 活跃时长:合并所有事件时间点,相邻间隔>30分钟视为休息
  let workHours = 0;
  {
    const all = [];
    for (const t of today) for (const ts of (t.times || [])) all.push(ts);
    all.sort((a, b) => a - b);
    if (all.length > 1) {
      let activeMs = 0;
      for (let i = 1; i < all.length; i++) {
        const gap = all[i] - all[i - 1];
        if (gap > 0 && gap <= 30 * 60 * 1000) activeMs += gap;
      }
      workHours = activeMs / 3600000;
    }
  }
  const stillWorking = today.length > 0 && (now.getTime() - Math.max(...today.map((t) => t.lastAt))) < 30 * 60 * 1000;

  // 活动清单
  const items = today.map((t) => {
    const hh = new Date(t.firstAt);
    const ts = String(hh.getHours()).padStart(2, "0") + ":" + String(hh.getMinutes()).padStart(2, "0");
    const end = new Date(t.lastAt);
    const ts2 = String(end.getHours()).padStart(2, "0") + ":" + String(end.getMinutes()).padStart(2, "0");
    return "- [" + ts + "-" + ts2 + "] " + (t.title || "未命名任务") + "(" + t.turns + "轮)";
  }).join("\n") || "(今天暂无记录)";

  // 生成总结
  let summary = "";
  try {
    const prompt =
      "今天是" + dateStr + ",以下是用户今天0点至今在DSH上做的事情(来自会话索引和统计):\n" + items +
      "\n\n累计活跃计算时长约 " + workHours.toFixed(1) + " 小时。" +
      (stillWorking ? "用户现在可能仍在工作。" : "") +
      "\n请用简洁生动、有情绪的中文总结用户今天做了什么,语气亲切,可以适度夸奖用户。" +
      (workHours > 6 || stillWorking ? "最后提醒用户:今天辛苦了,放松一下,早点休息!" : "");
    summary = await callDeepSeek(prompt);
  } catch (e) {
    summary = "总结生成失败,以下是原始记录:\n" + items;
  }

  // 邮件正文
  const body =
    "📋 DSH 今日总结(" + dateStr + ")\n\n" +
    summary + "\n\n" +
    "——\n今日活动记录:\n" + items +
    "\n活跃计算时长: " + workHours.toFixed(1) + " 小时" +
    (stillWorking ? "(仍在工作中)" : "");

  const subject = "DSH提醒 " + dateStr;
  await smtpSend(RECIPIENT, subject, body);
  console.log("邮件已发送: " + subject);
}

main().catch((e) => { console.error("失败: " + e.message); process.exit(1); });
