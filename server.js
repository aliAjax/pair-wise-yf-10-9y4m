const http = require("http");
const { readFile, writeFile, mkdir } = require("fs/promises");
const path = require("path");

const PORT = Number(process.env.PORT || 3019);
const DB_FILE = path.join(__dirname, "data", "db.json");
// 估算用：每拍约 2mm 纸带，登记领用时可用 lengthMm 覆盖
const MM_PER_BEAT = 2;

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
  batches: [
    {
      id: "batch_demo_1",
      tuneId: "tune_demo",
      startBeat: 1,
      endBeat: 32,
      widthMm: 70,
      beats: 32,
      lengthMm: 64,
      status: "issued",
      note: "开头主题卷带已领用切割",
      createdAt: new Date().toISOString()
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
  "PATCH /sections/:id/check",
  "GET /issues",
  "POST /issues",
  "PATCH /issues/:id/status",
  "GET /batches",
  "POST /batches",
  "GET /usage"
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
  db.tunes ||= [];
  db.sections ||= [];
  db.issues ||= [];
  db.batches ||= [];
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

function rangesOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart <= bEnd && bStart <= aEnd;
}

function issueBeatRange(db, issue) {
  if (Number.isFinite(issue.beat)) return { start: issue.beat, end: issue.beat };
  const section = db.sections.find((item) => item.id === issue.sectionId);
  if (section) return { start: section.startBeat, end: section.endBeat };
  return null;
}

// 无法定位拍点的问题按影响整首曲目保守处理
function issueOverlapsRange(db, issue, startBeat, endBeat) {
  const range = issueBeatRange(db, issue);
  if (!range) return true;
  return rangesOverlap(range.start, range.end, startBeat, endBeat);
}

function openIssues(db, tuneId) {
  return db.issues.filter((item) => item.tuneId === tuneId && item.status !== "resolved");
}

// 领用后新增问题只把受影响批次置为待复核并保留旧记录；范围内问题全部解决后自动恢复已领用
function refreshBatchStatuses(db, tuneId) {
  const blocking = openIssues(db, tuneId);
  for (const batch of db.batches.filter((item) => item.tuneId === tuneId)) {
    const hasOpenIssue = blocking.some((issue) => issueOverlapsRange(db, issue, batch.startBeat, batch.endBeat));
    if (hasOpenIssue && batch.status === "issued") {
      batch.status = "pending_review";
      batch.reviewRequestedAt = new Date().toISOString();
    } else if (!hasOpenIssue && batch.status === "pending_review") {
      batch.status = "issued";
      batch.reviewedAt = new Date().toISOString();
    }
  }
}

function buildProgress(db, tuneId) {
  findTune(db, tuneId);
  const sections = db.sections.filter((item) => item.tuneId === tuneId);
  const issues = db.issues.filter((item) => item.tuneId === tuneId);
  const batches = db.batches.filter((item) => item.tuneId === tuneId);
  const checkedCount = sections.filter((item) => item.checked).length;
  const openCount = issues.filter((item) => item.status !== "resolved").length;
  return {
    tuneId,
    totalSections: sections.length,
    checkedSections: checkedCount,
    uncheckedSections: sections.length - checkedCount,
    openIssues: openCount,
    resolvedIssues: issues.length - openCount,
    percent: sections.length ? Math.round((checkedCount / sections.length) * 100) : 0,
    batches: {
      total: batches.length,
      issued: batches.filter((item) => item.status === "issued").length,
      pendingReview: batches.filter((item) => item.status === "pending_review").length,
      issuedBeats: batches.reduce((sum, item) => sum + (item.beats || 0), 0),
      issuedLengthMm: batches.reduce((sum, item) => sum + (item.lengthMm || 0), 0)
    }
  };
}

function buildUsage(db, tuneId) {
  const batches = db.batches.filter((item) => !tuneId || item.tuneId === tuneId);
  const byWidth = new Map();
  for (const batch of batches) {
    const key = String(batch.widthMm);
    if (!byWidth.has(key)) {
      byWidth.set(key, { widthMm: batch.widthMm, batches: 0, beats: 0, lengthMm: 0 });
    }
    const bucket = byWidth.get(key);
    bucket.batches += 1;
    bucket.beats += batch.beats || 0;
    bucket.lengthMm += batch.lengthMm || 0;
  }
  return {
    tuneId: tuneId || null,
    totalBatches: batches.length,
    issuedBatches: batches.filter((item) => item.status === "issued").length,
    pendingReviewBatches: batches.filter((item) => item.status === "pending_review").length,
    totalBeats: batches.reduce((sum, item) => sum + (item.beats || 0), 0),
    totalLengthMm: batches.reduce((sum, item) => sum + (item.lengthMm || 0), 0),
    byWidth: [...byWidth.values()]
  };
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

  if (req.method === "GET" && pathname === "/batches") {
    const tuneId = searchParams.get("tuneId");
    const status = searchParams.get("status");
    const batches = db.batches.filter((item) => (!tuneId || item.tuneId === tuneId) && (!status || item.status === status));
    return send(res, 200, { data: batches });
  }

  if (req.method === "POST" && pathname === "/batches") {
    const body = await parseBody(req);
    required(body, ["tuneId", "startBeat", "endBeat", "widthMm"]);
    const tune = findTune(db, body.tuneId);
    const startBeat = Number(body.startBeat);
    const endBeat = Number(body.endBeat);
    const widthMm = Number(body.widthMm);
    if (!Number.isFinite(startBeat) || !Number.isFinite(endBeat) || startBeat < 1 || endBeat < startBeat) {
      return send(res, 400, { error: "起止拍必须是正整数且起始拍不大于结束拍" });
    }
    if (!Number.isFinite(widthMm) || widthMm <= 0) {
      return send(res, 400, { error: "纸带宽度必须是正数" });
    }
    if (body.lengthMm !== undefined && (!Number.isFinite(Number(body.lengthMm)) || Number(body.lengthMm) <= 0)) {
      return send(res, 400, { error: "纸带长度必须是正数" });
    }
    // 整批校验：任一规则不满足即整批拒绝，原领用记录和进度不变
    const reasons = [];
    const specWidth = Number(tune.stripSpec && tune.stripSpec.widthMm);
    if (Number.isFinite(specWidth) && widthMm !== specWidth) {
      reasons.push(`纸带宽度${widthMm}mm与曲目规格${specWidth}mm不符`);
    }
    const overlapped = db.batches.filter(
      (item) => item.tuneId === tune.id && rangesOverlap(startBeat, endBeat, item.startBeat, item.endBeat)
    );
    if (overlapped.length) {
      reasons.push(`同一曲目区间重叠：${overlapped.map((item) => item.id).join(", ")}`);
    }
    const blockingIssues = openIssues(db, tune.id).filter((issue) => issueOverlapsRange(db, issue, startBeat, endBeat));
    if (blockingIssues.length) {
      reasons.push(`范围内仍有未解决问题：${blockingIssues.map((item) => item.id).join(", ")}`);
    }
    const pendingReview = db.batches.filter((item) => item.tuneId === tune.id && item.status === "pending_review");
    if (pendingReview.length) {
      reasons.push(`存在待复核批次，问题全部解决后才允许生成下一批：${pendingReview.map((item) => item.id).join(", ")}`);
    }
    if (reasons.length) {
      return send(res, 409, { error: "领用批次整批拒绝，原领用记录和进度不变", reasons });
    }
    const beats = endBeat - startBeat + 1;
    const batch = {
      id: makeId("batch"),
      tuneId: tune.id,
      startBeat,
      endBeat,
      widthMm,
      beats,
      lengthMm: body.lengthMm === undefined ? beats * MM_PER_BEAT : Number(body.lengthMm),
      status: "issued",
      note: body.note || "",
      createdAt: new Date().toISOString()
    };
    db.batches.push(batch);
    await writeDb(db);
    return send(res, 201, { data: batch });
  }

  if (req.method === "GET" && pathname === "/usage") {
    return send(res, 200, { data: buildUsage(db, searchParams.get("tuneId")) });
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
    refreshBatchStatuses(db, issue.tuneId);
    await writeDb(db);
    return send(res, 201, { data: issue });
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
    refreshBatchStatuses(db, issue.tuneId);
    await writeDb(db);
    return send(res, 200, { data: issue });
  }

  return send(res, 404, { error: "接口不存在", routes });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => send(res, error.status || 500, { error: error.message || "服务器错误" }));
});

server.listen(PORT, () => {
  console.log(`Organ strip punch API running at http://127.0.0.1:${PORT}`);
});
