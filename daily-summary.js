#!/usr/bin/env node
/**
 * DSH 每日邮件提醒 —— 每天 19:59 由 cron 触发。
 * 扫描记忆文件的"系统索引 + 任务摘要"两层(不扫完整上下文),
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
const PASS = (cfg && cfg.smtp && cfg.smtp.pass) || "";
const SMTP_HOST = (cfg && cfg.smtp && cfg.smtp.host) || "smtp.qq.com";
const SMTP_PORT = (cfg && cfg.smtp && cfg.smtp.port) || 465;

function getApiKey() {
  try {
    const s = fs.readFileSync(HOME + "/.dsh/run-dsh-web.sh", "utf8");
    const m = s.match(/DEEPSEEK_API_KEY="([^"]+)"/);
    if (m) return m[1];
  } catch (e) {}
  return process.env.DEEPSEEK_API_KEY || "";
}
const API_KEY = getApiKey();

// ---------- 读取记忆文件(系统索引 + 任务摘要,不扫完整上下文) ----------
function readMemory() {
  const proj = JSON.parse(fs.readFileSync(HOME + "/.dsh/storages/session_projcache.json", "utf8"));
  const sessions = (proj.tables && proj.tables.sessions) || {};
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const today = [];
  for (const [sid, s] of Object.entries(sessions)) {
    const rows = (s && s.rows) || {};
    const meta = (rows.sessionListMetadata && rows.sessionListMetadata.val) || {};
    const title = ((rows.title && rows.title.val) || "").trim();
    const stats = (rows.sessionStats && rows.sessionStats.val) || {};
    const lastAt = meta.lastPromptAt || 0;
    if (lastAt >= startOfDay && lastAt <= now.getTime()) {
      today.push({
        sid, title,
        lastAt,
        turns: stats.turns || 0,
        steps: stats.steps || 0,
        llmMs: stats.llmMs || 0,
        toolMs: stats.toolMs || 0,
      });
    }
  }
  today.sort((a, b) => a.lastAt - b.lastAt);
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
  const workSec = today.reduce((a, b) => a + (b.llmMs + b.toolMs), 0) / 1000;
  const workHours = workSec / 3600;
  const stillWorking = today.length > 0 && (now.getTime() - Math.max(...today.map((t) => t.lastAt))) < 30 * 60 * 1000;

  // 活动清单
  const items = today.map((t) => {
    const hh = new Date(t.lastAt);
    const ts = String(hh.getHours()).padStart(2, "0") + ":" + String(hh.getMinutes()).padStart(2, "0");
    return "- [" + ts + "] " + (t.title || "未命名任务") + "(" + t.turns + "轮)";
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
  await smtpSend(EMAIL, subject, body);
  console.log("邮件已发送: " + subject);
}

main().catch((e) => { console.error("失败: " + e.message); process.exit(1); });
