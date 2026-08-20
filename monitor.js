#!/usr/bin/env node
/**
 * DSH永不眠监控 —— 心跳检测 + 队列积压告警。
 * 由飞书桥内置调度每分钟拉起(v4 起),异常时通过飞书机器人告警。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const https = require("https");

const DIR = __dirname;
const config = JSON.parse(fs.readFileSync(path.join(DIR, "config.json"), "utf8"));
const APP_ID = config.feishu.appId;
const APP_SECRET = config.feishu.appSecret;
const ALERT_CHAT = (config.notify && config.notify.alertChatId) || "";
const IN_DIR = path.join(DIR, (config.queue && config.queue.inDir) || "bridge/in");
const HB_FILE = (config.heartbeat && config.heartbeat.file) || "/tmp/dsh-heartbeat";
const HB_TIMEOUT = ((config.heartbeat && config.heartbeat.timeoutSec) || 180) * 1000;
const QUEUE_THRESHOLD = (config.queue && config.queue.alertThreshold) || 20;

// 桥心跳写入(由 feishu-bridge.js 定期调用此文件,此处只读)
function heartbeatAge() {
  try {
    const st = fs.statSync(HB_FILE);
    return Date.now() - st.mtimeMs;
  } catch (e) { return Infinity; }
}

function queueCount() {
  try { return fs.readdirSync(IN_DIR).filter((f) => f.endsWith(".json")).length; } catch (e) { return -1; }
}

// 飞书告警发送(复用机器人)
function sendAlert(text) {
  return new Promise((resolve) => {
    if (!ALERT_CHAT) { console.log("[monitor] 未配置 alertChatId,跳过告警: " + text.slice(0, 80)); return resolve(); }
    const body = JSON.stringify({
      app_id: APP_ID, app_secret: APP_SECRET,
    });
    // 获取 tenant token
    const req = https.request({
      hostname: "open.feishu.cn", path: "/open-apis/auth/v3/tenant_access_token/internal",
      method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    }, (res) => {
      let d = "";
      res.on("data", (c) => d += c);
      res.on("end", () => {
        try {
          const t = JSON.parse(d).tenant_access_token;
          if (!t) return resolve();
          const msg = JSON.stringify({ receive_id: ALERT_CHAT, msg_type: "text", content: JSON.stringify({ text }) });
          const req2 = https.request({
            hostname: "open.feishu.cn", path: "/open-apis/im/v1/messages?receive_id_type=chat_id",
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": "Bearer " + t, "Content-Length": Buffer.byteLength(msg) },
          }, (res2) => { res2.resume(); res2.on("end", resolve); });
          req2.on("error", () => resolve());
          req2.write(msg); req2.end();
        } catch (e) { resolve(); }
      });
    });
    req.on("error", () => resolve());
    req.write(body); req.end();
  });
}

async function main() {
  const problems = [];
  const hb = heartbeatAge();
  if (hb === Infinity) problems.push("⚠️ 飞书桥心跳文件不存在(桥可能未运行)");
  else if (hb > HB_TIMEOUT) problems.push("⚠️ 飞书桥心跳超时(" + Math.round(hb / 1000) + "秒无心跳,桥可能已挂)");

  const q = queueCount();
  if (q > QUEUE_THRESHOLD) problems.push("⚠️ 队列积压 " + q + " 条(阈值 " + QUEUE_THRESHOLD + "),消息可能处理不过来");

  if (problems.length) {
    const text = "【DSH 监控告警 " + new Date().toLocaleTimeString() + "】\n" + problems.join("\n") + "\n(请检查 /tmp/com.dsh.feishu-bridge.log)";
    await sendAlert(text);
    console.log("[monitor] 告警已发送: " + problems.join("; "));
  } else {
    console.log("[monitor] 正常(心跳 " + Math.round(hb / 1000) + "s,队列 " + q + " 条)");
  }
  process.exit(0);
}

main().catch((e) => { console.error("[monitor] 失败: " + e.message); process.exit(1); });
