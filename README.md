# 手摇风琴纸带打孔API

纯后端零依赖Node服务，使用 `data/db.json` 持久化曲目、纸带区间、试奏问题和卷带切割领用批次。

## 启动

```bash
PORT=3019 node server.js
```

## 主要接口

- `GET /health`
- `GET /tunes`
- `POST /tunes`
- `GET /tunes/:id/progress`
- `GET /tunes/:id/sections`
- `POST /tunes/:id/sections`
- `GET /tunes/:id/unchecked-sections`
- `GET /tunes/:id/requisitions` — 该曲目领用批次列表
- `PATCH /sections/:id/check`
- `GET /issues?tuneId=&status=`
- `POST /issues`
- `PATCH /issues/:id/status`
- `GET /requisitions?tuneId=&status=` — 批次列表（含开放问题数、拍数等同步字段）
- `POST /requisitions` — 登记卷带切割领用批次
- `GET /requisitions/:id` — 批次详情（含完整历史）
- `GET /usage?tuneId=` — 纸带用量统计（批次数、覆盖拍数、按宽度分组）

## 卷带切割领用闭环

登记字段：`tuneId`（曲目）、`startBeat`/`endBeat`（起止拍）、`widthMm`（纸带宽度）、
可选 `batchNo`（不填自动生成）、`note`。

**整批拒绝（HTTP 409，不写文件，原领用记录和进度不变）**，响应中 `violations` 一次列出全部原因：

1. 起止拍非法；
2. 纸带宽度与曲目 `stripSpec.widthMm` 规格不符；
3. 与同一曲目已有批次区间重叠；
4. 范围内仍有未解决问题；
5. 该曲目存在 `pending_review` 待复核批次——问题全部解决后才允许生成下一批。

**领用后的状态流转：**

- 批次创建后状态为 `issued`，记录 `history`。
- 领用后在批次覆盖拍号内新增问题（`POST /issues`），批次仅被置为 `pending_review`
  并挂接 `issueIds`、追加历史，旧领用记录原样保留，不回滚。
- 批次内问题全部解决（`PATCH /issues/:id/status`）后批次自动恢复 `issued`
  并追加 `review_passed` 历史；问题被重新打开则再次进入待复核。
- 批次列表、曲目进度（`requisitionBatches`/`pendingReviewBatches`/`requisitionedBeats`）
  和 `/usage` 用量统计均从同一份数据实时计算，写回 `data/db.json`。

## 闭环示例

```bash
# 登记一卷33-64拍的领用（演示数据中该范围有未解决问题，会被整批拒绝）
curl -X POST http://127.0.0.1:3019/requisitions \
  -H 'Content-Type: application/json' \
  -d '{"tuneId":"tune_demo","startBeat":33,"endBeat":64,"widthMm":70}'

# 解决问题后再领用；领用后出现新问题，批次自动进入待复核
curl -X PATCH http://127.0.0.1:3019/issues/issue_demo/status \
  -H 'Content-Type: application/json' -d '{"status":"resolved"}'

curl http://127.0.0.1:3019/tunes/tune_demo/progress
curl http://127.0.0.1:3019/usage
```
