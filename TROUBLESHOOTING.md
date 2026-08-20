# <DSH永不眠>排障手册(实战记录)

> 本文档记录 DSH永不眠(飞书/邮件桥)搭建过程中踩过的所有坑和最终正确配置。
> 目的:正确答案不丢失,任何人/任何工具按此操作即可复现,不再重复排障。

## 一、架构总览

```
手机飞书 ──> 飞书机器人(长连接)──> feishu-bridge.js ──> bridge/in/ 队列
                                                          │
手机邮箱 ──> QQ邮箱(IMAP/SMTP) ──> bridge.js ─────────────┘
                                                          ▼
                                          mailbridge 插件(DSH 进程内)
                                          轮询队列 → 注入 PC 当前活跃会话
                                          Agent 处理 → 回复写回队列
                                                          │
                                          feishu-bridge.js / bridge.js
                                          把回复发回飞书/邮件
```

- 队列目录:`<安装目录>/bridge/in/`(请求文件 `{status:"new", from, text, chatId?, targetSession?}`)
- 插件:持久化 `<安装目录>/mailbridge-plugin.js`(v14,注册于 `~/.dsh/profiles/web/cordis.patch.yml`)
- 插件逻辑:请求带 `targetSession` -> 注入指定会话(离线用 `agents.resume`);不带 -> 注入 PC 最近活跃会话;无活跃 -> 回退 `session-mail-bridge`
- 定时任务(v0.2 起):监控每分钟 + 每日总结 19:59,全部由飞书桥进程内置调度拉起,**无任何 cron / 独立 launchd 定时项**

## 二、飞书机器人配置(最终正确版)

1. 创建企业自建应用
2. **应用能力 → 机器人**(必须)
3. **权限管理**,以下权限**缺一不可**:
   - `im:message`(获取与发送单聊、群组消息)
   - ⚠️ **`im:message.p2p_msg:readonly`(获取用户发给机器人的单聊消息)——私聊事件推送必需,`im:message` 不够!这是本次排障最大的坑**
   - `im:message:send_as_bot`(以应用身份发消息)
4. **事件与回调 → 事件订阅**:
   - 添加事件 `im.message.receive_v1`
   - 订阅方式:**使用长连接接收事件**(WebSocket),不要 webhook
   - 修改后必须**保存**
5. **版本管理与发布**:每次改配置都要**创建版本重新发布**
6. **可用范围**:包含自己(测试期建议"仅创建者")

## 三、飞书长连接技术细节(文档里没有,源码里挖的)

- 获取长连接 URL 的真实端点(2026 版 SDK):
  `POST https://open.feishu.cn/callback/ws/endpoint`
  Body:`{"AppID": "cli_xxx", "AppSecret": "xxx"}`(**字段名大写**)
  响应:`data.URL`(wss://msg-frontier.feishu.cn/...)
  ⚠️ 网上流传的 `/open-apis/event/v1/websocket/endpoint` 已废弃,返回 404
- WS 帧协议:**protobuf 二进制帧**(headers 数组 + payload),不是 JSON —— 裸 WebSocket 无法解析,必须用官方 SDK `@larksuiteoapi/node-sdk`
- SDK `LarkChannel` 事件注册名是**归一化名 `"message"`**,不是 `"im.message.receive_v1"`(后者注册了也不会被调用)
- 心跳:SDK 自动处理;连接建立但服务器不发任何帧 = 事件订阅/权限配置未生效,与代码无关

## 四、open_id 陷阱(本次第二个大坑)

- `GET /open-apis/bot/v3/info` 返回的 `open_id` 是**机器人自己**的
- 测试"机器人主动发消息"必须用**用户**的 open_id:从消息事件 `sender.sender_id.open_id` 取,或查询用户信息
- 用机器人 open_id 发消息会报 `230013 Bot has NO availability to this user`,造成"机器人不可用"的误判

## 五、公司网络排障结论(封闭内网三层封锁)

- 外网 DNS(8.8.8.8/1.1.1.1):不可达;公司 DNS 对隧道域名返回污染结果
- 直连外网 443:按域名白名单放行(Cloudflare/百度/腾讯/163/QQ 等),Google/GitHub 超时
- cloudflared/Tailscale/ngrok:全部不可用(DNS 污染 + 端口过滤 + TLS 指纹识别 cloudflared 协议)
- 局域网:WiFi 客户端隔离(lenovo-internet 同 WiFi 设备互访被拦);跨网段 ACL 收紧
- **结论:本地 DSH 无法通过任何公网隧道/局域网直连被手机访问;最终方案 = 飞书/邮件桥(利用必然放行的 IM/邮件通道)**

## 六、邮件桥

- 配置:根目录 `config.json` 的 `mail` 段(imap/smtp 服务器、账号、授权码、白名单 allowedFrom);兼容旧版 `bridge/config.json`
- QQ 邮箱:IMAP 993 / SMTP 465,授权码在 QQ 邮箱设置里生成
- 已知坑:QQ 邮箱 SMTP 的 QUIT 响应 221 会被误判为错误(状态机需处理);邮件正文会带签名/原始邮件引用,需清理
- 邮件体验差于飞书(轮询延迟、正文污染),建议飞书为主

## 七、插件说明

- `targetSession`:请求带会话 ID 时注入指定会话(离线用 `agents.resume` 恢复)
- 竞态修复:`whenIdle` 可能在新回合开始前返回,需轮询事件(`turn/start`/`assistant/message`)确认新回合产生后再取回复
- 消息来源前缀:`[来自飞书]` / `[来自邮件]`,PC 端可见来源
- 持久化:插件文件 + `~/.dsh/profiles/web/cordis.patch.yml` insert,DSH 重启自动加载
- 「继续」(v14):恢复被终止任务必须走与普通消息相同的投递流程(followup -> 等待 turn/end -> 结果写回队列),否则恢复执行后飞书收不到最终回复

## 八、launchd 与系统登录项(2026-08-20 实战)

- **服务形态**:桥守护用 .app 包装(`DSH feishu.app/Contents/MacOS/DSH feishu` 内 exec node)。若 plist 直接指向 node 二进制,登录项会显示为「Node.js Foundation」;包装后显示为「DSH feishu」,重跑 install.sh 可自动迁移
- **EIO(5) 误报**:`launchctl bootstrap/load` 对已注册(label 已存在)的服务报 `Input/output error`,不是故障;`launchctl print gui/$(id -u)/<label>` 查真实状态。另外 /tmp 下放 plist 会因符号链接同样报 EIO,测试须用真实路径
- **BTM 幽灵条目**:删了 plist、bootout 服务、重启、注销重登后,系统设置「登录项」可能仍显示旧开关--macOS 后台任务管理数据库( root 所有,`/private/var/db/com.apple.backgroundtaskmanagement/`)的孤儿条目不随上述操作清除。根除:`sudo sfltool resetbtm` + 重启。**代价:所有后台项开关状态被重置为开启,需手动关回不需要的**
- **验证纪律**:判断"是否清除"必须全量输出后核对(`sfltool dumpbtm` 需 root;非 root 视角导出的内容与系统设置看到的不是同一份数据,不能作为清除证据)。曾因输出被 head 截断连续两次误报"已清除"

## 九、消息重复轰炸事故(2026-08-20,已根治)

- **现象**:飞书约 9 分钟收到 430+ 条重复回复
- **根因**:桥的投递流程是"发送 -> 删除队列文件 -> 下一轮";从受限沙箱环境手动启动的桥进程"能发不能删"(unlink 报 EPERM),每 3 秒把已完成文件重发一轮
- **教训**:桥进程必须由 launchd 正常拉起;排障时若必须手动启动,用 `open -a "DSH feishu.app"`(经 LaunchServices 启动,不受沙箱限制)
- **根治**(桥 v5):发送成功但删除失败时,进程内记录该文件并永久跳过(24h 自动清理防内存膨胀),该故障形态不可能再发生;轰炸本身不产生模型调用,不产生 token 费用
