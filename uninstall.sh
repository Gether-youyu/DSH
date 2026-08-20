#!/bin/bash
# ============================================================
# DSH永不眠 卸载脚本
# 用法: bash uninstall.sh
# 作用: 移除 launchd 守护、cron 定时、DSH 插件注册、队列清理
# 注意: 不删除项目文件本身(保留配置与代码,可重新安装)
# ============================================================
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE_DIR="$DSH_HOME/profiles/web"
PATCH_FILE="$PROFILE_DIR/cordis.patch.yml"
LAUNCH_AGENTS="$HOME/Library/LaunchAgents"

echo "=============================================="
echo " DSH永不眠 卸载"
echo "=============================================="

# ---------- 1. 停止并移除 launchd 守护 ----------
echo "[1/4] 停止守护服务..."
# 含历史版本遗留的服务名(feishu-bridge/monitor/daily-summary 为旧形态)
for name in com.dsh.feishu com.dsh.feishu-bridge com.dsh.mail-bridge com.dsh.monitor com.dsh.daily-summary; do
  plist="$LAUNCH_AGENTS/$name.plist"
  if [ -f "$plist" ]; then
    /bin/launchctl unload "$plist" 2>/dev/null || true
    /bin/rm -f "$plist"
    echo "  ✅ 已停止并移除 $name"
  fi
done
# 停止可能残留的桥进程
pkill -9 -f "node.*feishu-bridge" 2>/dev/null || true
pkill -9 -f "node.*bridge\.js" 2>/dev/null || true
echo "  ✅ 桥进程已停止"

# ---------- 2. 移除 cron 定时(历史版本遗留;新版本定时任务内置桥进程,随桥停止) ----------
echo "[2/4] 清理定时任务..."
/usr/bin/crontab -l 2>/dev/null | grep -v "daily-summary.js" | grep -v "monitor.js" | /usr/bin/crontab - 2>/dev/null || true
echo "  ✅ 旧 cron 已清理(如有)"

# ---------- 3. 移除 DSH 插件注册 ----------
echo "[3/4] 移除 DSH 插件注册..."
if [ -f "$PATCH_FILE" ]; then
  # 删除 mailbridge 的 insert 块(保留文件其他内容)
  /usr/bin/python3 - "$PATCH_FILE" << 'PYEOF'
import sys, re
path = sys.argv[1]
try:
    with open(path, 'r', encoding='utf-8') as f:
        content = f.read()
    # 匹配 "- insert:" 块中包含 mailbridge 的部分(从行首"- insert:"到下一个顶层"- "或文件尾)
    lines = content.split('\n')
    out = []
    skip = False
    i = 0
    while i < len(lines):
        line = lines[i]
        if line.strip() == '- insert:':
            # 检查这个块是否含 mailbridge
            j = i + 1
            block = [line]
            while j < len(lines) and not (lines[j].startswith('- ') and lines[j].strip() != '- insert:'):
                block.append(lines[j])
                j += 1
            if any('mailbridge' in b for b in block):
                print('  ✅ 已移除 mailbridge 插件注册块')
                i = j
                continue
            out.extend(block)
            i = j
            continue
        out.append(line)
        i += 1
    with open(path, 'w', encoding='utf-8') as f:
        f.write('\n'.join(out))
except Exception as e:
    print(f'  ⚠️ patch 清理失败: {e}')
PYEOF
  echo "  ✅ patch 已清理"
else
  echo "  ⚠️ 未找到 patch 文件"
fi

# ---------- 4. 清理运行时文件 ----------
echo "[4/4] 清理运行时文件..."
rm -f "$DIR/bridge/in/"*.json 2>/dev/null || true
rm -f "$DIR/bridge/schedule-state.json" 2>/dev/null || true
rm -f /tmp/dsh-heartbeat 2>/dev/null || true
echo "  ✅ 队列与心跳已清理"

echo ""
echo "=============================================="
echo " 卸载完成。项目文件与 config.json 已保留。"
echo " 重新安装: bash install.sh"
echo " 彻底删除: rm -rf $DIR"
echo " 提示: 若系统设置登录项仍显示残留开关,"
echo "       执行 sudo sfltool resetbtm 并重启即可清除"
echo "=============================================="
