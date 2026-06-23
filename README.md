# 🃏 炸金花 · 在线棋牌（node-zhajinhua）

一个**零外部依赖**的炸金花（三张）网页棋牌游戏：**单机对战 AI** + **真人联机**（好友 / 密码房 / 观战 / 聊天 / 金币 / 排行榜）。

仅用 Node.js 内置模块实现，`node server.js` 即可启动，开箱即用，适合 VPS 自托管。游戏入口就是网站首页。

> ⚠️ 本游戏仅供娱乐与学习，**请勿用于赌博**。金币为虚拟积分，无任何现实价值。

---

## ✨ 功能特性

### 玩法（大众规则）
- 牌型从大到小：**豹子 > 同花顺 > 金花(同花) > 顺子 > 对子 > 单张**。
- 顺子中 **A-2-3 最小**，**Q-K-A 最大**。
- **闷牌（蒙牌）** 跟注 1 倍单注，**看牌** 后跟注 / 比牌为 2 倍单注。
- 可 **看牌 / 跟注 / 加注 / 比牌 / 弃牌**；只剩一人时赢得整个底池，达到回合上限则强制摊牌。
- **比牌平局** 时，主动发起比牌的一方判负。

### 单机模式
无需登录，可选对手数量、底注、初始筹码、单注封顶与 **机器人难度（新手 / 普通 / 高手）**，随时与 AI 对战。

### 联机模式（真人同桌 · 棋牌式圆桌）
| 功能 | 说明 |
| --- | --- |
| 🪑 **圆桌座位** | 玩家围坐椭圆牌桌，「你」固定底部，含头像 / 筹码 / 庄家皇冠 / 在线指示灯 / 出牌倒计时 |
| 🔒 **房间密码** | 创建私密房，凭房间号 + 密码进入；房主可一键复制房号 / 密码分享 |
| 👀 **观战名单** | 进入即观战，点空位入座；实时显示观战人数与名单，观众看不到任何暗牌 |
| 💬 **聊天 / 表情 / 快捷语** | 桌内实时聊天，一键表情与快捷语，在对应座位弹出聊天气泡 |
| 👥 **好友系统** | 加好友（申请 / 接受）、在线状态、所在房间，一键 **邀请入房**（免密直进） |
| 🔔 **实时通知** | 全局通知：好友申请、好友上线、入房邀请以浮层 Toast 弹出 |
| 💰 **金币经济** | 入座买入、离桌 / 结束兑回，零和守恒；每日 **签到** 领金币 + 破产救济 |
| 🏆 **战绩 & 排行榜** | 记录局数 / 夺冠 / 总盈亏，金币排行榜；**本局战报** 回顾每手亮牌 |
| 🧑‍🎨 **头像** | 16 款 emoji 头像任选，桌上 / 好友 / 排行榜同步显示 |
| 🔊 **音效** | WebAudio 合成的发牌 / 下注 / 轮到你 / 胜负音效，可一键开关（无素材） |
| 🤝 **托管** | 一键托管自动出牌（小注跟、大注弃），手动操作即收回 |
| 👮 **房主管理** | 房主可 **踢人**、加 / 减机器人、设机器人难度，房主退出自动转移 |
| 📶 **断线重连** | 自身断线显示重连横幅（SSE 自动重连）；他人掉线 / 重连在聊天提示 |
| 📱 **PWA** | 支持「添加到主屏幕」离线访问外壳，手机横屏自适应 |

### 技术要点
- **实时推送**：房间状态与全局通知均基于 **SSE（Server-Sent Events）**，无需任何 WebSocket 库。
- **服务端权威**：发牌、洗牌、机器人决策全部在服务端完成，**他人暗牌不会下发**给浏览器，杜绝前端作弊。
- **零依赖**：不依赖任何 npm 包，仅用 Node.js 内置 `http` / `crypto` / `fs`。
- **数据持久化**：用户、好友、金币、战绩以 JSON 文件存储（`data/users.json`），密码用 `crypto.scrypt` **加盐哈希**，绝不保存明文；会话使用 HttpOnly Cookie。

---

## 🚀 快速开始

```bash
node server.js
# 默认监听 http://localhost:25500，浏览器打开即可游玩
```

可用环境变量：
- `PORT`（默认 25500）、`HOST`（默认 0.0.0.0）
- `ZJH_DATA_DIR`：用户数据目录（默认项目根目录下的 `data/`）

运行自测：

```bash
npm test    # 引擎/单机 27 项 + 用户/好友/金币/联机 38 项
```

---

## 🌐 接口说明

游戏全部交互均为本服务自身的 HTTP / SSE 接口，前端在 `public/zhajinhua/`。

单机：
| 接口 | 说明 |
| --- | --- |
| `GET /` · `GET /zhajinhua/` | 游戏网页界面 |
| `POST /zhajinhua/api/new` | 新建单机局，body：`{ botCount, ante, startChips, maxStake, botDifficulty }` |
| `POST /zhajinhua/api/action` | 你的一次动作，body：`{ gameId, action, arg }`；`action` ∈ `look/call/raise/compare/fold/next` |
| `GET /zhajinhua/api/state?gameId=` | 查询某单机局状态 |

用户 / 好友：
| 接口 | 说明 |
| --- | --- |
| `POST /auth/{register,login,logout}` · `GET /auth/me` | 注册 / 登录 / 退出 / 当前用户 |
| `GET /zhajinhua/api/profile` · `POST /zhajinhua/api/profile/avatar` | 个人资料（金币 / 战绩 / 头像 / 最近对局）· 换头像 |
| `POST /zhajinhua/api/checkin` · `GET /zhajinhua/api/leaderboard` | 每日签到 · 金币排行榜 |
| `GET /zhajinhua/api/friends` · `POST /zhajinhua/api/friends/{request,accept,decline,remove,invite}` | 好友列表与操作 |
| `GET /zhajinhua/api/notify/stream` | **SSE** 全局通知（好友申请 / 上下线 / 邀请） |

联机房间：
| 接口 | 说明 |
| --- | --- |
| `GET /zhajinhua/api/rooms` | 房间列表（含是否私密、观战人数） |
| `POST /zhajinhua/api/room/create` | 创建房间，body：`{ name, password, maxSeats, ante, startChips, maxStake, botDifficulty }` |
| `POST /zhajinhua/api/room/enter` | 进入房间（观战），body：`{ roomId, password }` |
| `POST /zhajinhua/api/room/{sit,stand,leave,start,addbot,removebot,auto,kick}` | 入座 / 站起 / 离开 / 开始 / 加减机器人 / 托管 / 踢人 |
| `POST /zhajinhua/api/room/action` · `POST /zhajinhua/api/room/chat` | 联机出牌 · 聊天 |
| `GET /zhajinhua/api/room/stream?roomId=` | **SSE** 实时接收房间状态（座位 / 观战 / 聊天 / 战报） |

---

## 🧱 项目结构

```
node-zhajinhua/
├── server.js                 # HTTP / SSE 服务（内置 http 模块，零依赖）
├── src/
│   ├── auth/
│   │   ├── store.js          # 用户 / 好友 / 金币 / 战绩 文件存储 + scrypt 加盐哈希
│   │   └── sessions.js       # 内存会话 + Cookie 工具
│   └── zhajinhua/
│       ├── engine.js         # 牌力引擎：发牌 / 评估 / 比较（纯函数）
│       ├── core.js           # 下注流程状态机 + 机器人 AI（含难度，单机/联机共用）
│       ├── table.js          # 单机牌桌：你 vs AI（机器人同步驱动）
│       ├── store.js          # 单机对局内存会话存储
│       ├── room.js           # 联机房间：座位 / 观战 / 聊天 / 密码 / 金币 / 战报 + SSE
│       ├── rooms.js          # 联机大厅：房间创建 / 列表 / 回收
│       └── presence.js       # 全局在线状态与通知中心（好友 / 邀请）
├── public/zhajinhua/         # 前端（棋牌圆桌 + 大厅 + 好友 + PWA：manifest / sw.js）
├── data/                     # 用户数据（运行时生成，不入库）
├── test/                     # 自测（引擎/单机 + 用户/好友/金币/联机）
├── deploy/                   # systemd 服务 + Nginx 反代示例
├── Dockerfile · docker-compose.yml
```

### 设计要点
- **统一下注引擎**：抽出 `BettingGame` 核心状态机，单机 `Table` 与联机 `Room` 共用同一套牌型 / 下注 / 比牌 / 摊牌规则，保证两种模式行为一致。
- **金币零和守恒**：买入从金币扣除，离桌 / 结束 / 踢人 / 房间回收均按桌上筹码兑回；测试覆盖筹码与金币守恒。

---

## 🖥️ 部署到 VPS

零依赖，部署很简单。下面两种方式任选其一。**联机依赖 Cookie 登录态与 SSE 长连接，强烈建议前置 Nginx + HTTPS。**

### 方式 A：systemd + Nginx（推荐）

```bash
# 1. 安装 Node.js 18+
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -
sudo apt-get install -y nodejs git nginx

# 2. 拉取代码到 /opt/node-zhajinhua
sudo git clone https://github.com/doudoudoubao/node-zhajinhua.git /opt/node-zhajinhua

# 3. 先手动测试能否启动
cd /opt/node-zhajinhua && node server.js     # 看到“服务已启动”后 Ctrl+C 退出
npm test                                       # 可选：跑自测

# 4. 配置为后台常驻服务（开机自启 + 崩溃自动重启）
sudo cp /opt/node-zhajinhua/deploy/zhajinhua.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now zhajinhua
sudo systemctl status zhajinhua                # 确认 active (running)

# 5. Nginx 反向代理 + HTTPS（先把示例里域名改成你自己的）
sudo cp /opt/node-zhajinhua/deploy/nginx.conf.example /etc/nginx/conf.d/zhajinhua.conf
sudo vim /etc/nginx/conf.d/zhajinhua.conf      # 把 game.example.com 改成你的域名
sudo nginx -t && sudo systemctl reload nginx

# 6. 免费 HTTPS 证书
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d game.example.com
```

> Nginx 配置已对 **SSE** 做了优化（关闭缓冲、延长超时），否则联机实时推送会卡。
> 更新代码：`cd /opt/node-zhajinhua && sudo git pull && sudo systemctl restart zhajinhua`。

### 方式 B：Docker

```bash
curl -fsSL https://get.docker.com | sudo sh
git clone https://github.com/doudoudoubao/node-zhajinhua.git
cd node-zhajinhua
sudo docker compose up -d        # 监听 0.0.0.0:25500，用户数据持久化到 ./data
sudo docker compose logs -f
```

生产环境同样建议在前面加 Nginx + HTTPS：把 `docker-compose.yml` 端口映射改成 `127.0.0.1:25500:25500`，再参考方式 A 的第 5、6 步。

### 防火墙
- 用 Nginx 反代：放行 `80`、`443`，**不要**对公网直接暴露 `25500`。
- 直接暴露 25500（不推荐）：在云厂商安全组放行 25500。

---

## ⚖️ 免责声明

本项目仅用于学习交流与娱乐用途，**严禁用于任何形式的赌博**。游戏内金币为虚拟积分，不可兑换、无现实价值。请遵守所在地法律法规，因使用本项目产生的任何后果由使用者自行承担。

## 📄 License

MIT
