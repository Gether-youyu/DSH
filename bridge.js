#!/usr/bin/env node
/**
 * DSH 邮件桥 —— 让手机通过邮件与 DSH 对话(与 PC 端同一会话)。
 *
 * 流程:
 *   手机发邮件 → IMAP 轮询新邮件 → 写入 bridge/in/req-<ts>.json {status:"new"}
 *   → DSH 邮件桥插件处理 → 写回同一文件 {status:"done", reply}
 *   → 本桥读取回复 → SMTP 发回给发件人 → 删除队列文件
 *
 * 用法: node bridge.js (配置在 bridge/config.json)
 */
"use strict";

const fs = require("fs");
const path = require("path");
const net = require("net");
const tls = require("tls");

const BRIDGE_DIR = __dirname + "/bridge";
const IN_DIR = BRIDGE_DIR + "/in";
const CONFIG_PATH = __dirname + "/config.json";

let config = null;
try {
  config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  if (config.mail) config = config.mail; // 统一配置结构兼容
} catch (e) {
  console.error("错误: 缺少 " + CONFIG_PATH + " 配置文件。请先运行 setup 或填写配置。");
  process.exit(1);
}

const IMAP = config.imap;
const SMTP = config.smtp;
const ALLOWED_FROM = new Set((config.allowedFrom || []).map((s) => s.toLowerCase()));

// ---------- IMAP 客户端(极简) ----------
function imapConnect() {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host: IMAP.host, port: IMAP.port, rejectUnauthorized: false }, () => {
      resolve(socket);
    });
    socket.on("error", reject);
  });
}

function imapCmd(socket, tag, cmd) {
  return new Promise((resolve, reject) => {
    let buf = "";
    const onData = (chunk) => {
      buf += chunk.toString("utf8");
      if (buf.includes("\r\n" + tag + " ")) {
        socket.removeListener("data", onData);
        resolve(buf);
      }
    };
    socket.on("data", onData);
    socket.write(tag + " " + cmd + "\r\n");
    socket.setTimeout(30000, () => { socket.removeListener("data", onData); reject(new Error("IMAP 超时: " + cmd)); });
  });
}

async function fetchUnseen() {
  const socket = await imapConnect();
  try {
    await imapCmd(socket, "a1", "LOGIN " + IMAP.user + " " + IMAP.pass);
    await imapCmd(socket, "a2", 'SELECT INBOX');
    const searchRes = await imapCmd(socket, "a3", "SEARCH UNSEEN");
    const nums = (searchRes.match(/\* SEARCH ([\d ]+)/) || [])[1];
    const ids = nums ? nums.trim().split(/\s+/).map(Number) : [];
    const messages = [];
    for (const id of ids) {
      const fetchRes = await imapCmd(socket, "a4", "FETCH " + id + " (BODY[HEADER.FIELDS (FROM SUBJECT)] BODY[TEXT])");
      messages.push({ id, raw: fetchRes });
      await imapCmd(socket, "a5", "STORE " + id + " +FLAGS (\\Seen)");
    }
    await imapCmd(socket, "a6", "LOGOUT");
    return messages;
  } finally {
    socket.destroy();
  }
}

function decodePart(text) {
  // 处理 base64 和 quoted-printable 的常见情况
  const b64 = text.match(/Content-Transfer-Encoding:\s*base64/i);
  if (b64) {
    const body = text.replace(/^.*?Content-Transfer-Encoding:\s*base64\s*\r?\n\r?\n/s, "").replace(/[^A-Za-z0-9+/=]/g, "");
    try { return Buffer.from(body, "base64").toString("utf8"); } catch { return ""; }
  }
  return text.replace(/^.*?Content-Transfer-Encoding:[^\r\n]*\r?\n\r?\n/s, "").trim();
}

function parseEnvelope(raw) {
  const fromMatch = raw.match(/From:\s*(.*?)\r?\n/i);
  const subjectMatch = raw.match(/Subject:\s*(.*?)\r?\n/i);
  let from = fromMatch ? fromMatch[1].trim() : "";
  const m = from.match(/<([^>]+)>/);
  if (m) from = m[1];
  from = from.replace(/^"?(.*?)"?\s*$/, "$1").trim().toLowerCase();
  const subject = subjectMatch ? subjectMatch[1].trim() : "";
  const bodyRaw = raw.includes("\r\n\r\n") ? raw.slice(raw.indexOf("\r\n\r\n")) : "";
  let body = decodePart(bodyRaw).trim();
  // 去掉邮件客户端附带的"原始邮件"引用
  const cut = body.search(/原始邮件|-----Original Message-----|发件人[:：]/);
  if (cut > 0) body = body.slice(0, cut).trim();
  // 去掉 QQ 邮箱默认签名行
  body = body.replace(/\r?\n\s*\r?\n\s*[^\r\n@\s]+\s*\r?\n\s*\d+@qq\.com\s*$/m, "").trim();
  return { from, subject, body };
}

// ---------- SMTP 客户端(极简) ----------
function smtpSend(to, subject, text) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host: SMTP.host, port: SMTP.port, rejectUnauthorized: false }, () => {
      step("EHLO " + SMTP.host.split(".")[0]);
    });
    let stage = 0;
    let buf = "";
    const fail = (msg) => { socket.destroy(); reject(new Error(msg)); };
    socket.on("error", fail);
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      if (!buf.includes("\r\n")) return;
      const line = buf.split("\r\n")[0];
      const code = line.slice(0, 3);
      if (code === "221") { socket.destroy(); resolve(); return; } // QUIT 正常再见
      if (code !== "235" && code !== "250" && code !== "334" && code !== "354" && code !== "220") {
        return fail("SMTP 错误: " + line);
      }
      buf = "";
      stage += 1;
      switch (stage) {
        case 1: socket.write("AUTH LOGIN\r\n"); break;
        case 2: socket.write(Buffer.from(SMTP.user).toString("base64") + "\r\n"); break;
        case 3: socket.write(Buffer.from(SMTP.pass).toString("base64") + "\r\n"); break;
        case 4: socket.write("MAIL FROM:<" + SMTP.user + ">\r\n"); break;
        case 5: socket.write("RCPT TO:<" + to + ">\r\n"); break;
        case 6: socket.write("DATA\r\n"); break;
        case 7: {
          const msg =
            "From: DSH <" + SMTP.user + ">\r\n" +
            "To: <" + to + ">\r\n" +
            "Subject: " + subject + "\r\n" +
            "Content-Type: text/plain; charset=utf-8\r\n" +
            "MIME-Version: 1.0\r\n" +
            "Date: " + new Date().toUTCString() + "\r\n" +
            "\r\n" +
            text + "\r\n.\r\n";
          socket.write(msg);
          break;
        }
        case 8: socket.write("QUIT\r\n"); break;
      }
    });
    function step(cmd) { if (stage === 0) { socket.write(cmd + "\r\n"); } }
  });
}

// ---------- 主循环 ----------
async function pollOnce() {
  const messages = await fetchUnseen();
  for (const msg of messages) {
    const env = parseEnvelope(msg.raw);
    if (!env.body) continue;
    if (!ALLOWED_FROM.has(env.from)) {
      console.log("[bridge] 忽略非白名单发件人: " + env.from);
      continue;
    }
    const ts = Date.now();
    const fileName = "req-" + ts + "-" + Math.random().toString(36).slice(2, 6) + ".json";
    const reqFile = path.join(IN_DIR, fileName);
    fs.writeFileSync(reqFile, JSON.stringify({ status: "new", from: env.from, subject: env.subject, text: env.body }));
    console.log("[bridge] 收到邮件(" + env.from + "),已入队: " + fileName);

    // 等待插件处理(轮询 out 状态)
    const deadline = Date.now() + 10 * 60 * 1000;
    let reply = null;
    while (Date.now() < deadline) {
      try {
        const state = JSON.parse(fs.readFileSync(reqFile, "utf8"));
        if (state.status === "done") { reply = state.reply; break; }
        if (state.status === "error") { reply = "处理出错: " + state.error; break; }
      } catch { /* 文件可能被写了一半,继续等 */ }
      await new Promise((r) => setTimeout(r, 3000));
    }
    if (reply === null) reply = "(DSH 处理超时,请稍后重试)";

    const subject = "Re: " + env.subject;
    await smtpSend(env.from, subject, reply);
    console.log("[bridge] 已回复 " + env.from + " (文件 " + fileName + ")");
    try { fs.unlinkSync(reqFile); } catch {}
  }
}

async function main() {
  console.log("[bridge] 邮件桥已启动,轮询间隔 " + (config.pollSeconds || 20) + " 秒");
  console.log("[bridge] 白名单: " + [...ALLOWED_FROM].join(", "));
  // 启动时清理残留的已处理队列文件
  for (const f of fs.readdirSync(IN_DIR)) {
    if (!f.endsWith(".json")) continue;
    try {
      const state = JSON.parse(fs.readFileSync(path.join(IN_DIR, f), "utf8"));
      if (state.status !== "new") fs.unlinkSync(path.join(IN_DIR, f));
    } catch { fs.unlinkSync(path.join(IN_DIR, f)); }
  }
  for (;;) {
    try {
      await pollOnce();
    } catch (e) {
      console.error("[bridge] 轮询失败: " + ((e && e.message) || e));
    }
    await new Promise((r) => setTimeout(r, (config.pollSeconds || 20) * 1000));
  }
}

main();
