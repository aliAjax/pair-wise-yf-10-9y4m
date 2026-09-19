const http = require("http");
const { readFile, writeFile, mkdir } = require("fs/promises");
const path = require("path");

const PORT = Number(process.env.PORT || 3019);
const DB_FILE = path.join(__dirname, "data", "db.json");

const initialData = {
  tunes: [
    {
      id: "tune_demo",
      title: "雨后圆舞曲",
      composer: "匿名",
      stripSpec: {
        widthMm: 70,
        scale: "20音",
        tempoBpm: 82,
        paperType: "半透明纸带"
      },
      createdAt: new Date().toISOString()
    }
  ],
  sections: [
    {
      id: "section_demo_1",
      tuneId: "tune_demo",
      startBeat: 1,
      endBeat: 32,
      laneRange: "1-10",
      checked: true,
      note: "开头主题已试奏"
    },
    {
      id: "section_demo_2",
      tuneId: "tune_demo",
      startBeat: 33,
      endBeat: 64,
      laneRange: "4-18",
      checked: false,
      note: "副歌段等待校对"
    }
  ],
  issues: [
    {
      id: "issue_demo",
      tuneId: "tune_demo",
      sectionId: "section_demo_2",
      type: "漏孔",
      beat: 41,
      lane: 12,
      description: "第41拍高音孔漏打",
      status: "open",
      createdAt: new Date().toISOString(),
      resolvedAt: null
    }
  ],
  requisitions: [
    {
      id: "requisition_demo_1",
      batchNo: "B20260616-001",
      tuneId: "tune_demo",
      startBeat: 1,
      endBeat: 32,
      widthMm: 70,
      status: "issued",
      issueIds: [],
      note: "开头主题卷带",
      createdAt: "2026-06-16T00:05:00.000Z",
      issuedAt: "2026-06-16T00:05:00.000Z",
      history: [{ type: "created", at: "2026-06-16T00:05:00.000Z" }]
    }
  ]
};

const routes = [
  "GET /health",
  "GET /tunes",
  "POST /tunes",
  "GET /tunes/:id/progress",
  "GET /tunes/:id/sections",
  "POST /tunes/:id/sections",
  "GET /tunes/:id/unchecked-sections",
  "GET /tunes/:id/requisitions",
  "PATCH /sections/:id/check",
  "GET /issues",
  "POST /issues",
  "PATCH /issues/:id/status",
  "GET /requisitions",
  "POST /requisitions",
  "GET /requisitions/:id",
  "GET /usage?tuneId="
];

async function ensureDb() {
  await mkdir(path.dirname(DB_FILE), { recursive: true });
  try {
    JSON.parse(await readFile(DB_FILE, "utf8"));
  } catch {
    await writeFile(DB_FILE, JSON.stringify(initialData, null, 2));
  }
}

async function readDb() {
  await ensureDb();
  const db = JSON.parse(await readFile(DB_FILE, "utf8"));
  if (!Array.isArray(db.requisitions)) db.requisitions = [];
  return db;
}

async function writeDb(data) {
  await writeFile(DB_FILE, JSON.stringify(data, null, 2));
}

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
}

function parseUrl(req) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  return { pathname: url.pathname, searchParams: url.searchParams };
}

async function parseBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error("请求体必须是合法JSON");
    error.status = 400;
    throw error;
  }
}

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function required(body, fields) {
  const missing = fields.filter((field) => body[field] === undefined || body[field] === "");
  if (missing.length) {
    const error = new Error(`缺少字段：${missing.join(", ")}`);
    error.status = 400;
    throw error;
  }
}

function findTune(db, tuneId) {
  const tune = db.tunes.find((item) => item.id === tuneId);
  if (!tune) {
    const error = new Error("曲目不存在");
    error.status = 404;
    throw error;
  }
  return tune;
}

function buildProgress(db, tuneId) {
  findTune(db, tuneId);
  const sections = db.sections.filter((item) => item.tuneId === tuneId);
  const issues = db.issues.filter((item) => item.tuneId === tuneId);
  const checkedCount = sections.filter((item) => item.checked).length;
  const openIssues = issues.filter((item) => item.status !== "resolved").length;
  const requisitions = db.requisitions.filter((item) => item.tuneId === tuneId);
  const pendingReview = requisitions.filter((item) => item.status === "pending_review").length;
  return {
    tuneId,
    totalSections: sections.length,
    checkedSections: checkedCount,
    uncheckedSections: sections.length - checkedCount,
    openIssues,
    resolvedIssues: issues.length - openIssues,
    requisitionBatches: requisitions.length,
    pendingReviewBatches: pendingReview,
    issuedBatches: requisitions.length - pendingReview,
    requisitionedBeats: requisitions.reduce((sum, item) => sum + (item.endBeat - item.startBeat + 1), 0),
    percent: sections.length ? Math.round((checkedCount / sections.length) * 100) : 0
  };
}

function isOpenIssue(issue) {
  return issue.status !== "resolved";
}

// 判断问题是否落在领用批次覆盖的拍号范围内；问题缺少拍号时按所属区间是否与批次相交判断
function issueInRange(db, issue, req) {
  if (issue.tuneId !== req.tuneId) return false;
  if (issue.beat !== undefined && issue.beat !== null) {
    return issue.beat >= req.startBeat && issue.beat <= req.endBeat;
  }
  const section = db.sections.find((item) => item.id === issue.sectionId);
  if (!section) return false;
  return section.endBeat >= req.startBeat && section.startBeat <= req.endBeat;
}

function countOpenIssues(db, req) {
  return db.issues.filter((issue) => isOpenIssue(issue) && issueInRange(db, issue, req)).length;
}

function serializeRequisition(db, req) {
  const tune = db.tunes.find((item) => item.id === req.tuneId);
  return {
    ...req,
    beatSpan: req.endBeat - req.startBeat + 1,
    openIssueCount: countOpenIssues(db, req),
    tuneTitle: tune ? tune.title : null
  };
}

function nextBatchNo(db) {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const seq = db.requisitions.length + 1;
  return `B${date}-${String(seq).padStart(3, "0")}`;
}

function buildUsage(db, tuneId) {
  let tunes = db.tunes;
  if (tuneId) {
    findTune(db, tuneId);
    tunes = tunes.filter((tune) => tune.id === tuneId);
  }
  const byTune = tunes.map((tune) => {
    const reqs = db.requisitions.filter((req) => req.tuneId === tune.id);
    const pending = reqs.filter((req) => req.status === "pending_review").length;
    return {
      tuneId: tune.id,
      title: tune.title,
      specWidthMm: tune.stripSpec.widthMm,
      totalBatches: reqs.length,
      issuedBatches: reqs.length - pending,
      pendingReviewBatches: pending,
      totalBeats: reqs.reduce((sum, req) => sum + (req.endBeat - req.startBeat + 1), 0),
      byWidth: reqs.reduce((acc, req) => {
        const key = String(req.widthMm);
        acc[key] = (acc[key] || 0) + 1;
        return acc;
      }, {})
    };
  });
  return {
    totalBatches: byTune.reduce((sum, item) => sum + item.totalBatches, 0),
    totalBeats: byTune.reduce((sum, item) => sum + item.totalBeats, 0),
    pendingReviewBatches: byTune.reduce((sum, item) => sum + item.pendingReviewBatches, 0),
    byTune
  };
}

// 领用后新增问题：把命中区间的批次挂接问题并置为待复核，保留旧记录，仅追加历史
function applyIssueToRequisitions(db, issue) {
  const affected = [];
  if (!isOpenIssue(issue)) return affected;
  db.requisitions.forEach((req) => {
    if (!issueInRange(db, issue, req)) return;
    if (!req.issueIds.includes(issue.id)) req.issueIds.push(issue.id);
    if (req.status !== "pending_review") {
      req.status = "pending_review";
      req.history.push({ type: "pending_review", at: new Date().toISOString(), issueId: issue.id, reason: issue.description });
    }
    affected.push(req.id);
  });
  return affected;
}

// 问题状态变化后重算相关批次：关联问题全部解决才恢复已领用
function refreshRequisitionsForIssue(db, issue) {
  const affected = [];
  db.requisitions.forEach((req) => {
    if (req.tuneId !== issue.tuneId) return;
    const linked = req.issueIds.includes(issue.id) || issueInRange(db, issue, req);
    if (!linked) return;
    if (isOpenIssue(issue) && !req.issueIds.includes(issue.id)) {
      req.issueIds.push(issue.id);
    }
    const openCount = countOpenIssues(db, req);
    if (openCount === 0 && req.status === "pending_review") {
      req.status = "issued";
      req.history.push({ type: "review_passed", at: new Date().toISOString(), issueId: issue.id });
    } else if (openCount > 0 && req.status === "issued") {
      req.status = "pending_review";
      req.history.push({ type: "pending_review", at: new Date().toISOString(), issueId: issue.id, reason: issue.description });
    }
    affected.push(req.id);
  });
  return affected;
}

async function handle(req, res) {
  const { pathname, searchParams } = parseUrl(req);
  const db = await readDb();

  if (req.method === "GET" && pathname === "/health") {
    return send(res, 200, { ok: true, service: "organ-strip-punch-api", routes });
  }

  if (req.method === "GET" && pathname === "/tunes") {
    const tunes = db.tunes.map((tune) => ({ ...tune, progress: buildProgress(db, tune.id) }));
    return send(res, 200, { data: tunes });
  }

  if (req.method === "POST" && pathname === "/tunes") {
    const body = await parseBody(req);
    required(body, ["title", "stripSpec"]);
    const tune = {
      id: makeId("tune"),
      title: body.title,
      composer: body.composer || "",
      stripSpec: body.stripSpec,
      createdAt: new Date().toISOString()
    };
    db.tunes.push(tune);
    await writeDb(db);
    return send(res, 201, { data: tune });
  }

  const tuneSectionsMatch = pathname.match(/^\/tunes\/([^/]+)\/sections$/);
  if (tuneSectionsMatch && req.method === "GET") {
    const tuneId = tuneSectionsMatch[1];
    findTune(db, tuneId);
    return send(res, 200, { data: db.sections.filter((item) => item.tuneId === tuneId) });
  }

  if (tuneSectionsMatch && req.method === "POST") {
    const tuneId = tuneSectionsMatch[1];
    findTune(db, tuneId);
    const body = await parseBody(req);
    required(body, ["startBeat", "endBeat", "laneRange"]);
    const section = {
      id: makeId("section"),
      tuneId,
      startBeat: Number(body.startBeat),
      endBeat: Number(body.endBeat),
      laneRange: body.laneRange,
      checked: Boolean(body.checked),
      note: body.note || ""
    };
    db.sections.push(section);
    await writeDb(db);
    return send(res, 201, { data: section });
  }

  const uncheckedMatch = pathname.match(/^\/tunes\/([^/]+)\/unchecked-sections$/);
  if (uncheckedMatch && req.method === "GET") {
    const tuneId = uncheckedMatch[1];
    findTune(db, tuneId);
    return send(res, 200, { data: db.sections.filter((item) => item.tuneId === tuneId && !item.checked) });
  }

  const tuneRequisitionsMatch = pathname.match(/^\/tunes\/([^/]+)\/requisitions$/);
  if (tuneRequisitionsMatch && req.method === "GET") {
    const tuneId = tuneRequisitionsMatch[1];
    findTune(db, tuneId);
    const data = db.requisitions
      .filter((item) => item.tuneId === tuneId)
      .sort((a, b) => a.startBeat - b.startBeat)
      .map((item) => serializeRequisition(db, item));
    return send(res, 200, { data });
  }

  const progressMatch = pathname.match(/^\/tunes\/([^/]+)\/progress$/);
  if (progressMatch && req.method === "GET") {
    return send(res, 200, { data: buildProgress(db, progressMatch[1]) });
  }

  const checkMatch = pathname.match(/^\/sections\/([^/]+)\/check$/);
  if (checkMatch && req.method === "PATCH") {
    const section = db.sections.find((item) => item.id === checkMatch[1]);
    if (!section) return send(res, 404, { error: "区间不存在" });
    const body = await parseBody(req);
    section.checked = body.checked !== undefined ? Boolean(body.checked) : true;
    section.note = body.note ?? section.note;
    await writeDb(db);
    return send(res, 200, { data: section });
  }

  if (req.method === "GET" && pathname === "/issues") {
    const tuneId = searchParams.get("tuneId");
    const status = searchParams.get("status");
    const issues = db.issues.filter((item) => (!tuneId || item.tuneId === tuneId) && (!status || item.status === status));
    return send(res, 200, { data: issues });
  }

  if (req.method === "POST" && pathname === "/issues") {
    const body = await parseBody(req);
    required(body, ["tuneId", "sectionId", "type", "description"]);
    findTune(db, body.tuneId);
    const section = db.sections.find((item) => item.id === body.sectionId && item.tuneId === body.tuneId);
    if (!section) return send(res, 400, { error: "区间不存在或不属于该曲目" });
    const issue = {
      id: makeId("issue"),
      tuneId: body.tuneId,
      sectionId: body.sectionId,
      type: body.type,
      beat: body.beat === undefined ? null : Number(body.beat),
      lane: body.lane === undefined ? null : Number(body.lane),
      description: body.description,
      status: "open",
      createdAt: new Date().toISOString(),
      resolvedAt: null
    };
    db.issues.push(issue);
    const affectedRequisitions = applyIssueToRequisitions(db, issue);
    await writeDb(db);
    return send(res, 201, { data: issue, affectedRequisitions });
  }

  const issueStatusMatch = pathname.match(/^\/issues\/([^/]+)\/status$/);
  if (issueStatusMatch && req.method === "PATCH") {
    const issue = db.issues.find((item) => item.id === issueStatusMatch[1]);
    if (!issue) return send(res, 404, { error: "问题不存在" });
    const body = await parseBody(req);
    required(body, ["status"]);
    issue.status = body.status;
    issue.resolvedAt = body.status === "resolved" ? new Date().toISOString() : null;
    issue.note = body.note ?? issue.note;
    const affectedRequisitions = refreshRequisitionsForIssue(db, issue);
    await writeDb(db);
    return send(res, 200, { data: issue, affectedRequisitions });
  }

  if (req.method === "GET" && pathname === "/requisitions") {
    const tuneId = searchParams.get("tuneId");
    const status = searchParams.get("status");
    const data = db.requisitions
      .filter((item) => (!tuneId || item.tuneId === tuneId) && (!status || item.status === status))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .map((item) => serializeRequisition(db, item));
    return send(res, 200, { data });
  }

  if (req.method === "POST" && pathname === "/requisitions") {
    const body = await parseBody(req);
    required(body, ["tuneId", "startBeat", "endBeat", "widthMm"]);
    const tune = findTune(db, body.tuneId);
    const startBeat = Number(body.startBeat);
    const endBeat = Number(body.endBeat);
    const widthMm = Number(body.widthMm);

    const violations = [];
    if (!Number.isFinite(startBeat) || !Number.isFinite(endBeat) || !Number.isInteger(startBeat) || !Number.isInteger(endBeat)) {
      violations.push("起止拍必须为整数");
    } else if (startBeat >= endBeat) {
      violations.push("起止拍非法：起始拍必须小于结束拍");
    }
    if (!Number.isFinite(widthMm) || widthMm <= 0) {
      violations.push("纸带宽度必须为正数");
    } else if (tune.stripSpec.widthMm !== widthMm) {
      violations.push(`纸带宽度${widthMm}mm与曲目规格${tune.stripSpec.widthMm}mm不符`);
    }
    if (body.batchNo && db.requisitions.some((req) => req.batchNo === body.batchNo)) {
      violations.push(`批次号${body.batchNo}已存在`);
    }
    // 同一曲目区间重叠（含端点相接）
    const overlaps = Number.isFinite(startBeat) && Number.isFinite(endBeat)
      ? db.requisitions.filter(
          (req) => req.tuneId === tune.id && req.endBeat >= startBeat && req.startBeat <= endBeat
        )
      : [];
    overlaps.forEach((req) => {
      violations.push(`与批次${req.batchNo}（${req.startBeat}-${req.endBeat}拍）区间重叠`);
    });
    // 待复核批次未关闭，即使区间不重叠也不允许生成下一批
    if (Number.isFinite(startBeat) && Number.isFinite(endBeat)) {
      const pending = db.requisitions.find(
        (req) =>
          req.tuneId === tune.id &&
          req.status === "pending_review" &&
          !overlaps.some((overlap) => overlap.id === req.id)
      );
      if (pending) {
        violations.push(`批次${pending.batchNo}仍待复核，问题全部解决后才允许生成下一批`);
      }
    }
    // 范围内仍有未解决问题
    if (Number.isFinite(startBeat) && Number.isFinite(endBeat)) {
      const rangeProbe = { tuneId: tune.id, startBeat, endBeat };
      const openInRange = db.issues.filter((issue) => isOpenIssue(issue) && issueInRange(db, issue, rangeProbe));
      openInRange.forEach((issue) => {
        const where = issue.beat !== undefined && issue.beat !== null ? `第${issue.beat}拍` : "所属区间";
        violations.push(`范围内存在未解决问题（${issue.id}，${where}：${issue.description}）`);
      });
    }
    if (violations.length) {
      return send(res, 409, { error: "整批拒绝：领用条件不满足，原领用记录和进度不变", violations });
    }

    const now = new Date().toISOString();
    const requisition = {
      id: makeId("requisition"),
      batchNo: body.batchNo || nextBatchNo(db),
      tuneId: tune.id,
      startBeat,
      endBeat,
      widthMm,
      status: "issued",
      issueIds: [],
      note: body.note || "",
      createdAt: now,
      issuedAt: now,
      history: [{ type: "created", at: now }]
    };
    db.requisitions.push(requisition);
    await writeDb(db);
    return send(res, 201, { data: serializeRequisition(db, requisition) });
  }

  const requisitionMatch = pathname.match(/^\/requisitions\/([^/]+)$/);
  if (requisitionMatch && req.method === "GET") {
    const requisition = db.requisitions.find((item) => item.id === requisitionMatch[1]);
    if (!requisition) return send(res, 404, { error: "领用批次不存在" });
    return send(res, 200, { data: serializeRequisition(db, requisition) });
  }

  if (req.method === "GET" && pathname === "/usage") {
    return send(res, 200, { data: buildUsage(db, searchParams.get("tuneId")) });
  }

  return send(res, 404, { error: "接口不存在", routes });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => send(res, error.status || 500, { error: error.message || "服务器错误" }));
});

server.listen(PORT, () => {
  console.log(`Organ strip punch API running at http://127.0.0.1:${PORT}`);
});
