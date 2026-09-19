# 手摇风琴纸带打孔API

纯后端零依赖Node服务，使用 `data/db.json` 持久化曲目、纸带区间和试奏问题。

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
- `PATCH /sections/:id/check`
- `GET /issues?tuneId=&status=`
- `POST /issues`
- `PATCH /issues/:id/status`
- `GET /batches?tuneId=&status=`
- `POST /batches`
- `GET /usage?tuneId=`

## 卷带切割领用闭环

`POST /batches` 登记领用批次：`tuneId`、`startBeat`、`endBeat`、`widthMm` 必填，`lengthMm`、`note` 可选（长度缺省按每拍 2mm 估算）。

满足以下任一条件即整批拒绝（409），原领用记录和进度不变：

- 同一曲目已有批次区间重叠；
- 纸带宽度与曲目 `stripSpec.widthMm` 不符；
- 范围内仍有未解决问题；
- 存在待复核批次（问题全部解决后才允许生成下一批）。

领用后新增问题只会把受影响批次置为 `pending_review` 并保留旧记录；范围内问题全部解决后批次自动恢复 `issued`，才允许生成下一批。批次列表（`GET /batches`）、曲目进度（`GET /tunes/:id/progress` 含批次汇总）和纸带用量统计（`GET /usage`）同步更新，数据写回 `data/db.json`。

## 闭环示例

```bash
curl http://127.0.0.1:3019/tunes/tune_demo/progress
curl -X POST http://127.0.0.1:3019/issues \
  -H 'Content-Type: application/json' \
  -d '{"tuneId":"tune_demo","sectionId":"section_demo_2","type":"错孔","beat":45,"lane":9,"description":"第45拍第9轨多打孔"}'

# 领用卷带批次（与既有批次不重叠、宽度匹配、范围内无未解决问题）
curl -X POST http://127.0.0.1:3019/batches \
  -H 'Content-Type: application/json' \
  -d '{"tuneId":"tune_demo","startBeat":65,"endBeat":96,"widthMm":70,"note":"尾段领用"}'
curl http://127.0.0.1:3019/batches?tuneId=tune_demo
curl http://127.0.0.1:3019/usage?tuneId=tune_demo
```
