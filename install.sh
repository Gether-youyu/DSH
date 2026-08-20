#!/bin/bash
# ============================================================
# DSH永不眠一键安装脚本
# 用法: bash install.sh
# 作用: 检测环境 -> 生成配置 -> 注册 DSH 插件 -> 定时任务迁 launchd
#       -> 安装 launchd 守护 -> 启动服务 -> 自检(定时任务同走 launchd)
# ============================================================
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
NODE_BIN="/usr/local/bin/node"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE_DIR="$DSH_HOME/profiles/web"
PATCH_FILE="$PROFILE_DIR/cordis.patch.yml"
PLUGIN_FILE="$DIR/mailbridge-plugin.js"
LAUNCH_AGENTS="$HOME/Library/LaunchAgents"

echo "=============================================="
echo " DSH永不眠 一键安装"
echo " 安装目录: $DIR"
echo "=============================================="

# 运行时目录与配置权限
mkdir -p "$DIR/bridge/in"
chmod 600 "$DIR/config.json" 2>/dev/null || true

# ---------- 1. 环境检测 ----------
echo ""
echo "[1/7] 环境检测..."
if [ ! -x "$NODE_BIN" ]; then
  echo "  ❌ 未找到 node($NODE_BIN),请先安装 Node.js"
  exit 1
fi
"$NODE_BIN" --version | xargs echo "  ✅ Node.js:"
if [ ! -d "$DIR/node_modules/@larksuiteoapi/node-sdk" ]; then
  echo "  ⚠️ 缺少飞书 SDK,尝试安装..."
  (cd "$DIR" && PATH=/usr/local/bin:$PATH /usr/local/bin/npm install --cache /tmp/npm-cache @larksuiteoapi/node-sdk >/dev/null 2>&1) && echo "  ✅ SDK 已安装" || echo "  ❌ SDK 安装失败(请手动: cd $DIR && npm install @larksuiteoapi/node-sdk)"
fi

# ---------- 2. 配置 ----------
echo ""
echo "[2/7] 检查配置..."
if [ ! -f "$DIR/config.json" ]; then
  echo "  ❌ 缺少 config.json(请先按 config.example.json 模板填写)"
  echo "     复制模板: cp config.example.json config.json"
  exit 1
fi
"$NODE_BIN" -e "JSON.parse(require('fs').readFileSync('$DIR/config.json','utf8'))" 2>/dev/null \
  && echo "  ✅ config.json 格式有效" || { echo "  ❌ config.json 不是合法 JSON"; exit 1; }

# ---------- 3. 注册 DSH 插件 ----------
echo ""
echo "[3/7] 注册 DSH 插件..."
if [ -f "$PATCH_FILE" ]; then
  if grep -q "mailbridge" "$PATCH_FILE" 2>/dev/null; then
    echo "  ✅ 插件已注册($PATCH_FILE)"
  else
    cat >> "$PATCH_FILE" << EOF

# mailbridge: DSH永不眠桥接插件(由 install.sh 追加)
- insert:
    - id: mailbridge
      name: $PLUGIN_FILE
EOF
    echo "  ✅ 插件已写入 $PATCH_FILE(重启 DSH 生效)"
  fi
else
  echo "  ⚠️ 未找到 $PATCH_FILE,请确认 DSH web profile 存在"
fi

# ---------- 4. 定时任务(launchd 托管,替代旧 cron) ----------
echo ""
echo "[4/7] 配置定时任务(每日总结 19:59 + 监控每分钟,launchd 托管)..."
bash "$DIR/migrate-launchd.sh"

# ---------- 5. launchd 守护(桥自动重启) ----------
echo ""
echo "[5/7] 安装桥守护服务..."
mkdir -p "$LAUNCH_AGENTS"
# 先停掉手动启动的桥,避免与 launchd 实例争端口锁
pkill -9 -f "node.*feishu-bridge" 2>/dev/null || true
pkill -9 -f "node.*bridge\.js" 2>/dev/null || true
sleep 1

install_plist() {
  local name="$1" script="$2"
  local plist="$LAUNCH_AGENTS/$name.plist"
  cat > "$plist" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$name</string>
  <key>ProgramArguments</key>
  <array><string>$NODE_BIN</string><string>$DIR/$script</string></array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/$name.log</string>
  <key>StandardErrorPath</key><string>/tmp/$name.err.log</string>
</dict>
</plist>
EOF
  /bin/launchctl unload "$plist" 2>/dev/null || true
  /bin/launchctl load "$plist" 2>/dev/null && echo "  ✅ $name 守护已安装并启动" || echo "  ⚠️ $name 加载失败(可手动: launchctl load $plist)"
}

# 飞书桥(主通道)
install_plist "com.dsh.feishu-bridge" "feishu-bridge.js"
# 邮件桥默认不安装(备用通道,如需启用: install_plist "com.dsh.mail-bridge" "bridge.js" 并重启)

# ---------- 6. 队列清理 + 心跳 ----------
echo ""
echo "[6/7] 清理队列残留..."
rm -f "$DIR/bridge/in/"*.json 2>/dev/null
echo "  ✅ 队列已清理"

# ---------- 7. 自检 ----------
echo ""
echo "[7/7] 自检..."
sleep 3
if pgrep -f "node.*feishu-bridge" >/dev/null 2>&1; then
  echo "  ✅ 飞书桥运行中"
else
  echo "  ⚠️ 飞书桥未运行(查看 /tmp/com.dsh.feishu-bridge.log)"
fi
if curl -s -o /dev/null -w "%{http_code}" --max-time 5 http://127.0.0.1:3080/ 2>/dev/null | grep -q 200; then
  echo "  ✅ DSH 运行中(端口 3080)"
else
  echo "  ⚠️ DSH 未运行"
fi
"$NODE_BIN" -e "
const c=JSON.parse(require('fs').readFileSync('$DIR/config.json','utf8'));
console.log('  ✅ 配置检查: 飞书App='+(c.feishu&&c.feishu.appId||'?')+' 邮箱='+(c.mail&&c.mail.smtp&&c.mail.smtp.user||'?'))
"

echo ""
echo "=============================================="
echo " 安装完成!"
echo " - 飞书桥: launchctl list | grep dsh"
echo " - 日志:   /tmp/com.dsh.feishu-bridge.log"
echo " - 部署文档: $DIR/DEPLOY.md"
echo " 注意: 若 DSH 插件为新增注册,需重启 DSH 生效"
echo "=============================================="
