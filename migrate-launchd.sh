#!/bin/bash
# ============================================================
# cron → launchd 一次性迁移脚本
# 定时任务(每日总结 19:59 + 监控每分钟)改由 launchd 托管:
#   - 睡眠错过触发时刻的,唤醒后自动补跑(cron 错过即丢)
#   - 迁移后系统设置不再出现「旧后台任务」开关
# 必须在用户终端执行:macOS 的 App Management 权限保护,
# 第三方进程(如 AI 助手)注册 launchd 会被拒绝(error 5)
# 幂等:重复执行无副作用
# ============================================================
DIR="$(cd "$(dirname "$0")" && pwd)"
NODE_BIN="/usr/local/bin/node"
UID_N="$(id -u)"
LA="$HOME/Library/LaunchAgents"

echo "[1/4] 写入定时服务 plist..."
cat > "$LA/com.dsh.daily-summary.plist" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>com.dsh.daily-summary</string>
    <key>ProgramArguments</key>
    <array><string>$NODE_BIN</string><string>$DIR/daily-summary.js</string></array>
    <key>StartCalendarInterval</key>
    <dict><key>Hour</key><integer>19</integer><key>Minute</key><integer>59</integer></dict>
    <key>StandardOutPath</key><string>/tmp/daily-summary.log</string>
    <key>StandardErrorPath</key><string>/tmp/daily-summary.log</string>
</dict>
</plist>
EOF
cat > "$LA/com.dsh.monitor.plist" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>com.dsh.monitor</string>
    <key>ProgramArguments</key>
    <array><string>$NODE_BIN</string><string>$DIR/monitor.js</string></array>
    <key>StartInterval</key><integer>60</integer>
    <key>StandardOutPath</key><string>/tmp/dsh-monitor.log</string>
    <key>StandardErrorPath</key><string>/tmp/dsh-monitor.log</string>
</dict>
</plist>
EOF
echo "  ✅ com.dsh.daily-summary.plist / com.dsh.monitor.plist"

echo "[2/4] 加载服务(如系统弹授权窗请点「允许」)..."
for name in com.dsh.daily-summary com.dsh.monitor; do
  launchctl bootout "gui/$UID_N/$name" 2>/dev/null || true
  if launchctl bootstrap "gui/$UID_N" "$LA/$name.plist" 2>/dev/null || launchctl load -w "$LA/$name.plist" 2>/dev/null; then
    echo "  ✅ $name 已加载"
  else
    echo "  ❌ $name 加载失败(error 5 通常是终端缺权限:系统设置 → 隐私与安全性 → App 管理,勾上终端后重跑)"
  fi
done

echo "[3/4] 清理旧 cron 条目..."
if crontab -l 2>/dev/null | grep -qE "daily-summary\.js|monitor\.js"; then
  crontab -l 2>/dev/null | grep -vE "daily-summary\.js|monitor\.js" | crontab -
  echo "  ✅ 旧 cron 已移除(「旧后台任务」开关将在注销/重新登录后消失)"
else
  echo "  ✅ 无旧 cron 需要清理"
fi

echo "[4/4] 验证..."
sleep 2
OK=1
for name in com.dsh.daily-summary com.dsh.monitor; do
  if launchctl list 2>/dev/null | grep -q "$name"; then echo "  ✅ $name 运行中"; else echo "  ⚠️ $name 未检测到"; OK=0; fi
done
if [ "$(crontab -l 2>/dev/null | grep -cE 'daily-summary\.js|monitor\.js')" = "0" ]; then
  echo "  ✅ cron 已清空"
else
  echo "  ⚠️ cron 仍有残留"
  OK=0
fi
[ "$OK" = "1" ] && echo "🎉 迁移完成" || echo "⚠️ 有未完成项,按提示处理后重跑本脚本(幂等)"
