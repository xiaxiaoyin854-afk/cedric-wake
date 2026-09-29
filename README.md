# cedric-wake

定时醒来，读心潮，自己决定要不要用 Bark 给她推一条消息。不经过聊天前端，手机不用开 App，也不用开梯子。

## 流程

1. 大约每 90 分钟醒一次（带随机抖动，不会整点准时）
2. 安静时段、今天发满、离上次太近，就直接跳过，不叫醒模型，也不花钱
3. 读心潮此刻状态和小屋来信
4. 把人设、时间、最近发过的消息一起交给模型，模型自己决定发不发
5. 要发就走 Bark 推到手机，并回传一次心潮事件

## 部署

```bash
git clone https://github.com/xiaxiaoyin854-afk/cedric-wake.git /opt/cedric-wake
cd /opt/cedric-wake
cp .env.example .env && nano .env     # 填模型、Bark key、心潮地址
cp persona.example.md persona.md && nano persona.md

npm run test-push    # 手机响 = Bark 通了
npm run dry          # 走一遍完整流程，只打印不推送
npm run once         # 真推一条

bash install.sh      # 装成常驻服务
journalctl -u cedric-wake -f
```

## 记录

- `data/sent.jsonl`：真的推出去的消息
- `data/wake.jsonl`：每次叫醒模型后的决定和理由（包括决定不发的）

`.env`、`persona.md`、`data/` 都不进 git。
