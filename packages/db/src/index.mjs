import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { ContractError, redactSensitiveFields } from "../../contracts/src/index.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = path.resolve(__dirname, "../migrations");

const CLUB_CATEGORY_LABELS = {
  TECH_INNOVATION: "科技创新",
  ACADEMIC_CULTURE: "学术文化",
  ART_PERFORMANCE: "文艺展演",
  SPORTS_FITNESS: "体育竞技",
  VOLUNTEER_ORG: "志愿与组织"
};

export function createDefaultHautCampusContent() {
  const nowIso = new Date().toISOString();
  return {
    school_id: "haut",
    version: 1,
    updated_at: nowIso,
    updated_by: "system",
    bulletin: {
      enabled: true,
      title: "河工大社团纳新与校园频道云端直通车",
      content: "全校学生社团招新 QQ 群与校园互助频道已接入云端实时下发，点击即可一键呼起手机 QQ 加群或进入频道。",
      tag: "云端实时同步",
      action_url: ""
    },
    channels: [
      {
        id: "ch_official_main",
        title: "工大主频道",
        subtitle: "版本更新通知 · 校园消息 · 问题反馈",
        tag_label: "主频道",
        invite_url: "https://pd.qq.com/s/hautcampus",
        channel_number_hint: "点击加入",
        enabled: true,
        pinned: true,
        sort_order: 10,
        updated_at: nowIso
      },
      {
        id: "ch_freshman_guide",
        title: "新生答疑频道",
        subtitle: "报到流程 · 选课答疑 · 宿舍与校园卡使用",
        tag_label: "新生",
        invite_url: "https://pd.qq.com/s/hautfreshman",
        channel_number_hint: "点击加入",
        enabled: true,
        pinned: true,
        sort_order: 20,
        updated_at: nowIso
      },
      {
        id: "ch_academic_contest",
        title: "课程资料与竞赛组队",
        subtitle: "期末复习资料 · 大创/挑战杯/数模/ACM 组队",
        tag_label: "学习",
        invite_url: "https://pd.qq.com/s/hautstudy",
        channel_number_hint: "点击加入",
        enabled: true,
        pinned: false,
        sort_order: 30,
        updated_at: nowIso
      },
      {
        id: "ch_campus_life",
        title: "失物招领与二手闲置",
        subtitle: "校园卡失物招领 · 二手书流转 · 拼车同行",
        tag_label: "生活",
        invite_url: "https://pd.qq.com/s/hautlife",
        channel_number_hint: "点击加入",
        enabled: true,
        pinned: false,
        sort_order: 40,
        updated_at: nowIso
      }
    ],
    clubs: [
      {
        id: "club_acm",
        name: "ACM 程序设计协会",
        category: "TECH_INNOVATION",
        category_label: "科技创新",
        affiliated_unit: "信息科学与工程学院",
        activity_venue: "8号教学楼机房",
        summary: "开展算法训练、蓝桥杯与 ICPC/CCPC 竞赛备赛，周末有 C++ 与算法入门课。",
        qq_group_number: "784512903",
        highlights: ["蓝桥杯", "ACM集训", "算法入门"],
        enabled: true,
        pinned: true,
        sort_order: 10,
        updated_at: nowIso
      },
      {
        id: "club_robot",
        name: "机器人与智能车协会",
        category: "TECH_INNOVATION",
        category_label: "科技创新",
        affiliated_unit: "电气工程学院 / 机电工程学院",
        activity_venue: "工程训练中心",
        summary: "参与全国大学生智能汽车竞赛、RoboMaster 与嵌入式开发，包含硬件画板、机械和视觉。",
        qq_group_number: "692348150",
        highlights: ["智能车竞赛", "STM32", "硬件开发"],
        enabled: true,
        pinned: true,
        sort_order: 20,
        updated_at: nowIso
      },
      {
        id: "club_math_model",
        name: "数学建模协会",
        category: "TECH_INNOVATION",
        category_label: "科技创新",
        affiliated_unit: "理学院",
        activity_venue: "6号教学楼",
        summary: "组织数学建模国赛、美赛培训与跨专业组队。",
        qq_group_number: "815620493",
        highlights: ["数模组队", "MATLAB", "Python"],
        enabled: true,
        pinned: false,
        sort_order: 30,
        updated_at: nowIso
      },
      {
        id: "club_elec_tech",
        name: "电子科技协会",
        category: "TECH_INNOVATION",
        category_label: "科技创新",
        affiliated_unit: "人工智能与大数据学院",
        activity_venue: "9号教学楼创客空间",
        summary: "单片机学习、电子制作、校园义务维修与全国大学生电子设计竞赛交流。",
        qq_group_number: "739104826",
        highlights: ["电子设计竞赛", "义务维修", "单片机"],
        enabled: true,
        pinned: false,
        sort_order: 40,
        updated_at: nowIso
      },
      {
        id: "club_debate",
        name: "演讲与辩论协会",
        category: "ACADEMIC_CULTURE",
        category_label: "学术文化",
        affiliated_unit: "法学院 / 新闻与传播学院",
        activity_venue: "5号教学楼 / 钟楼报告厅",
        summary: "举办「新生杯」「秋实杯」校园辩论赛与日常演讲交流。",
        qq_group_number: "648291035",
        highlights: ["新生杯辩论赛", "演讲交流"],
        enabled: true,
        pinned: false,
        sort_order: 50,
        updated_at: nowIso
      },
      {
        id: "club_english",
        name: "英语协会",
        category: "ACADEMIC_CULTURE",
        category_label: "学术文化",
        affiliated_unit: "外国语学院",
        activity_venue: "钟楼草坪 / 7号教学楼",
        summary: "周五晚钟楼英语角、四六级备考交流与英语演讲、配音活动。",
        qq_group_number: "583920174",
        highlights: ["四六级备考", "英语角", "配音比赛"],
        enabled: true,
        pinned: false,
        sort_order: 60,
        updated_at: nowIso
      },
      {
        id: "club_erp",
        name: "ERP 沙盘协会",
        category: "ACADEMIC_CULTURE",
        category_label: "学术文化",
        affiliated_unit: "管理学院 / 经济贸易学院",
        activity_venue: "11号教学楼实训室",
        summary: "模拟企业运营与财务预算，参加企业竞争模拟大赛。",
        qq_group_number: "710492836",
        highlights: ["企业经营模拟", "商科竞赛"],
        enabled: true,
        pinned: false,
        sort_order: 70,
        updated_at: nowIso
      },
      {
        id: "club_guitar",
        name: "吉他社",
        category: "ART_PERFORMANCE",
        category_label: "文艺展演",
        affiliated_unit: "校团委社团管理部",
        activity_venue: "大学生活动中心 / 东操场",
        summary: "木吉他、乐队排练与草坪音乐节演出，周末有新手教学。",
        qq_group_number: "864201937",
        highlights: ["草坪音乐节", "乐队排练", "吉他教学"],
        enabled: true,
        pinned: false,
        sort_order: 80,
        updated_at: nowIso
      },
      {
        id: "club_hanfu",
        name: "汉服社",
        category: "ART_PERFORMANCE",
        category_label: "文艺展演",
        affiliated_unit: "设计艺术学院",
        activity_venue: "中心湖畔 / 美术楼",
        summary: "汉服妆造、传统手工、中秋游园会与校内约拍活动。",
        qq_group_number: "629401835",
        highlights: ["中秋游园会", "传统手工", "摄影约拍"],
        enabled: true,
        pinned: false,
        sort_order: 90,
        updated_at: nowIso
      },
      {
        id: "club_photo",
        name: "摄影协会",
        category: "ART_PERFORMANCE",
        category_label: "文艺展演",
        affiliated_unit: "新闻与传播学院",
        activity_venue: "7号教学楼 / 校内",
        summary: "相机与手机摄影交流、后期修图分享及校园外拍活动。",
        qq_group_number: "758291046",
        highlights: ["外拍交流", "修图分享"],
        enabled: true,
        pinned: false,
        sort_order: 100,
        updated_at: nowIso
      },
      {
        id: "club_skate",
        name: "轮滑社",
        category: "SPORTS_FITNESS",
        category_label: "体育竞技",
        affiliated_unit: "体育学院",
        activity_venue: "钟楼广场东侧轮滑场",
        summary: "每晚在钟楼轮滑场练习平花、刹停与速滑，新手有老社员带练。",
        qq_group_number: "592038471",
        highlights: ["新手带练", "高校刷街", "晚间训练"],
        enabled: true,
        pinned: false,
        sort_order: 110,
        updated_at: nowIso
      },
      {
        id: "club_badminton",
        name: "羽毛球协会",
        category: "SPORTS_FITNESS",
        category_label: "体育竞技",
        affiliated_unit: "体育学院",
        activity_venue: "体育馆羽毛球场",
        summary: "日常约球、基础步伐练习与「工大杯」羽毛球赛。",
        qq_group_number: "830192746",
        highlights: ["日常约球", "工大杯比赛"],
        enabled: true,
        pinned: false,
        sort_order: 120,
        updated_at: nowIso
      },
      {
        id: "club_night_run",
        name: "夜跑协会",
        category: "SPORTS_FITNESS",
        category_label: "体育竞技",
        affiliated_unit: "体育学院",
        activity_venue: "北区/东区田径场",
        summary: "晚间跑步打卡、体测 800/1000 米练习与郑开马拉松集体报名。",
        qq_group_number: "671829304",
        highlights: ["体测练习", "郑开马拉松", "晚间夜跑"],
        enabled: true,
        pinned: false,
        sort_order: 130,
        updated_at: nowIso
      },
      {
        id: "club_volunteer",
        name: "青年志愿者协会",
        category: "VOLUNTEER_ORG",
        category_label: "志愿与组织",
        affiliated_unit: "校团委",
        activity_venue: "大学生活动中心 204",
        summary: "发布校内外志愿服务活动、迎新志愿、图书馆整理与志愿汇时长录入。",
        qq_group_number: "901284756",
        highlights: ["志愿汇时长", "迎新服务", "社区支教"],
        enabled: true,
        pinned: false,
        sort_order: 140,
        updated_at: nowIso
      },
      {
        id: "club_art_troupe",
        name: "大学生艺术团",
        category: "VOLUNTEER_ORG",
        category_label: "志愿与组织",
        affiliated_unit: "校团委",
        activity_venue: "大学生活动中心大礼堂",
        summary: "包含合唱、舞蹈、器乐、话剧与主持队，负责迎新晚会与毕业晚会演出。",
        qq_group_number: "746192038",
        highlights: ["迎新晚会", "合唱舞蹈器乐", "主持礼仪"],
        enabled: true,
        pinned: false,
        sort_order: 150,
        updated_at: nowIso
      },
      {
        id: "club_broadcast",
        name: "工大之声广播站",
        category: "VOLUNTEER_ORG",
        category_label: "志愿与组织",
        affiliated_unit: "党委宣传部 / 校团委",
        activity_venue: "行政楼广播室",
        summary: "负责校园早晚广播点歌、公众号采编与学校活动播音主持。",
        qq_group_number: "683920417",
        highlights: ["广播点歌", "播音主持", "新媒体采编"],
        enabled: true,
        pinned: false,
        sort_order: 160,
        updated_at: nowIso
      }
    ]
  };
}

export function listMigrations() {
  const files = fs.readdirSync(MIGRATIONS_DIR).sort();
  const upFiles = files.filter((f) => f.endsWith(".sql") && !f.endsWith(".down.sql"));
  return upFiles.map((upFile) => {
    const base = upFile.replace(/\.sql$/, "");
    const downFile = `${base}.down.sql`;
    const upPath = path.join(MIGRATIONS_DIR, upFile);
    const downPath = path.join(MIGRATIONS_DIR, downFile);
    return {
      version: base,
      upPath,
      downPath,
      upSql: fs.readFileSync(upPath, "utf8"),
      downSql: fs.existsSync(downPath) ? fs.readFileSync(downPath, "utf8") : null
    };
  });
}

export class CloudDatabaseStore {
  constructor({ snapshotPath = null, pricingMicropeach = 1000 } = {}) {
    this.snapshotPath = snapshotPath;
    this.pricingMicropeach = pricingMicropeach;
    this.appliedMigrations = new Set();

    // Identity & Sessions
    this.users = new Map(); // id -> user
    this.userRoles = new Map(); // userId -> Set<string>
    this.authTransactions = new Map(); // loginTxn -> txn
    this.exchangeTickets = new Map(); // appTicket -> ticket
    this.deviceSessions = new Map(); // sessionId -> session

    // School & Credentials & Consents
    this.schoolIntegrations = new Map(); // school_id -> integration config
    this.schoolBindings = new Map(); // bindingId -> binding
    this.encryptedCredentials = new Map(); // credId -> encrypted record
    this.consents = new Map(); // consentId -> consent

    // Reservations & Triple-Schedule
    this.reservationPlans = new Map(); // planId -> plan
    this.reservationJobs = new Map(); // jobId -> job
    this.scheduleEvents = new Map(); // eventId -> event
    this.schoolReservations = new Map(); // jobId -> verified school reservation

    // Finance & Outbox
    this.reservationOrders = new Map(); // orderId -> order
    this.financeOperations = new Map(); // eventKey -> operation
    this.outboxEvents = [];

    // Parcel Hub
    this.parcels = new Map(); // parcelId -> parcel
    this.parcelEvents = new Map(); // parcelId -> events[]
    this.parcelSourceConnections = new Map(); // connectionId -> connection
    this.parcelSyncJobs = new Map(); // jobId -> sync job

    // Plugins
    this.pluginInstallations = new Map(); // `${userId}:${pluginId}` -> installation

    // Cloud-Controlled Campus Channels, Clubs & Dynamic Content
    this.campusContent = new Map(); // schoolId -> { school_id, version, updated_at, bulletin, channels, clubs }

    // Notifications, Audit, Idempotency
    this.notifications = new Map(); // notificationId -> notification
    this.auditEvents = [];
    this.idempotencyRecords = new Map(); // `${scope}|${actor}|${key}` -> { requestHash, status, body }

    this._seedDefaults();
    this.runMigrations();
    this._loadSnapshot();
  }

  _loadSnapshot() {
    if (!this.snapshotPath) return;
    try {
      if (!fs.existsSync(this.snapshotPath)) return;
      const raw = JSON.parse(fs.readFileSync(this.snapshotPath, "utf8"));
      const loadMap = (map, arr) => {
        if (!Array.isArray(arr)) return;
        for (const [k, v] of arr) map.set(k, v);
      };
      loadMap(this.users, raw.users);
      if (Array.isArray(raw.userRoles)) {
        for (const [k, arr] of raw.userRoles) {
          this.userRoles.set(k, new Set(Array.isArray(arr) ? arr : ["USER"]));
        }
      }
      loadMap(this.authTransactions, raw.authTransactions);
      loadMap(this.exchangeTickets, raw.exchangeTickets);
      loadMap(this.deviceSessions, raw.deviceSessions);
      loadMap(this.schoolBindings, raw.schoolBindings);
      loadMap(this.encryptedCredentials, raw.encryptedCredentials);
      loadMap(this.consents, raw.consents);
      loadMap(this.reservationPlans, raw.reservationPlans);
      loadMap(this.reservationJobs, raw.reservationJobs);
      loadMap(this.scheduleEvents, raw.scheduleEvents);
      loadMap(this.schoolReservations, raw.schoolReservations);
      loadMap(this.reservationOrders, raw.reservationOrders);
      loadMap(this.financeOperations, raw.financeOperations);
      loadMap(this.parcels, raw.parcels);
      loadMap(this.parcelEvents, raw.parcelEvents);
      loadMap(this.parcelSourceConnections, raw.parcelSourceConnections);
      loadMap(this.parcelSyncJobs, raw.parcelSyncJobs);
      loadMap(this.pluginInstallations, raw.pluginInstallations);
      loadMap(this.campusContent, raw.campusContent);
      if (!this.campusContent.has("haut")) {
        this.campusContent.set("haut", createDefaultHautCampusContent());
      }
      loadMap(this.notifications, raw.notifications);
      if (Array.isArray(raw.auditEvents)) {
        this.auditEvents = raw.auditEvents.slice(-500);
      }
    } catch {
      // Ignore corrupt snapshot
    }
  }

  saveSnapshot() {
    if (!this.snapshotPath) return;
    try {
      const dir = path.dirname(this.snapshotPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const data = {
        users: Array.from(this.users.entries()),
        userRoles: Array.from(this.userRoles.entries()).map(([k, set]) => [k, Array.from(set)]),
        authTransactions: Array.from(this.authTransactions.entries()).slice(-200),
        exchangeTickets: Array.from(this.exchangeTickets.entries()).slice(-200),
        deviceSessions: Array.from(this.deviceSessions.entries()),
        schoolBindings: Array.from(this.schoolBindings.entries()),
        encryptedCredentials: Array.from(this.encryptedCredentials.entries()),
        consents: Array.from(this.consents.entries()),
        reservationPlans: Array.from(this.reservationPlans.entries()),
        reservationJobs: Array.from(this.reservationJobs.entries()),
        scheduleEvents: Array.from(this.scheduleEvents.entries()),
        schoolReservations: Array.from(this.schoolReservations.entries()),
        reservationOrders: Array.from(this.reservationOrders.entries()),
        financeOperations: Array.from(this.financeOperations.entries()),
        parcels: Array.from(this.parcels.entries()),
        parcelEvents: Array.from(this.parcelEvents.entries()),
        parcelSourceConnections: Array.from(this.parcelSourceConnections.entries()),
        parcelSyncJobs: Array.from(this.parcelSyncJobs.entries()),
        pluginInstallations: Array.from(this.pluginInstallations.entries()),
        campusContent: Array.from(this.campusContent.entries()),
        notifications: Array.from(this.notifications.entries()),
        auditEvents: this.auditEvents.slice(-500)
      };
      const tmp = `${this.snapshotPath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data), "utf8");
      fs.renameSync(tmp, this.snapshotPath);
    } catch {
      // Ignore write error
    }
  }

  _seedDefaults() {
    this.schoolIntegrations.set("haut", {
      school_id: "haut",
      display_name: "河南工业大学 (HAUT)",
      provider_id: "school.haut.library",
      enabled: true,
      kill_switch: false,
      authorization_evidence_ref: null, // Default MOCK_ONLY until dual-person approval + evidence
      approver_primary_ref: null,
      approver_secondary_ref: null,
      updated_at: new Date().toISOString()
    });
    this.campusContent.set("haut", createDefaultHautCampusContent());
  }

  getCampusContent(schoolId = "haut", { includeDisabled = false } = {}) {
    const key = String(schoolId || "haut").toLowerCase();
    if (!this.campusContent.has(key)) {
      this.campusContent.set(key, {
        ...createDefaultHautCampusContent(),
        school_id: key
      });
    }
    const raw = this.campusContent.get(key);
    const sortFn = (a, b) => {
      const pinDiff = (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0);
      if (pinDiff !== 0) return pinDiff;
      return (Number(a.sort_order) || 100) - (Number(b.sort_order) || 100);
    };
    const channels = (Array.isArray(raw.channels) ? raw.channels : [])
      .filter((ch) => includeDisabled || ch.enabled !== false)
      .slice()
      .sort(sortFn);
    const clubs = (Array.isArray(raw.clubs) ? raw.clubs : [])
      .filter((cl) => includeDisabled || cl.enabled !== false)
      .slice()
      .sort(sortFn);
    return {
      school_id: raw.school_id || key,
      version: Number(raw.version || 1),
      updated_at: raw.updated_at || new Date().toISOString(),
      updated_by: raw.updated_by || "system",
      bulletin: raw.bulletin || {
        enabled: false,
        title: "",
        content: "",
        tag: "云端同步",
        action_url: ""
      },
      channels,
      clubs
    };
  }

  sanitizeSafeHttpsUrl(rawUrl, fallback = "") {
    const trimmed = String(rawUrl ?? "").trim();
    if (!trimmed) return fallback;
    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol !== "https:") return fallback;
      return parsed.toString();
    } catch {
      return fallback;
    }
  }

  updateCampusContent(schoolId = "haut", payload = {}, actorRef = "admin") {
    const key = String(schoolId || "haut").toLowerCase();
    const current = this.getCampusContent(key, { includeDisabled: true });
    const nowIso = new Date().toISOString();
    if (payload.bulletin && typeof payload.bulletin === "object") {
      current.bulletin = {
        enabled: payload.bulletin.enabled !== false,
        title: String(payload.bulletin.title ?? current.bulletin?.title ?? "").trim(),
        content: String(payload.bulletin.content ?? current.bulletin?.content ?? "").trim(),
        tag: String(payload.bulletin.tag ?? current.bulletin?.tag ?? "云端实时同步").trim() || "云端实时同步",
        action_url: this.sanitizeSafeHttpsUrl(payload.bulletin.action_url ?? current.bulletin?.action_url ?? "")
      };
    }
    if (Array.isArray(payload.channels)) {
      current.channels = payload.channels.map((ch, idx) => ({
        id: String(ch.id || `ch_${Date.now()}_${idx}`).trim(),
        title: String(ch.title || "").trim(),
        subtitle: String(ch.subtitle || "").trim(),
        tag_label: String(ch.tag_label || ch.tagLabel || "频道").trim(),
        invite_url: this.sanitizeSafeHttpsUrl(ch.invite_url || ch.defaultInviteUrl || "", "https://pd.qq.com/s/hautcampus"),
        channel_number_hint: String(ch.channel_number_hint || ch.channelNumberHint || "点击加入").trim(),
        enabled: ch.enabled !== false,
        pinned: Boolean(ch.pinned),
        sort_order: Number(ch.sort_order ?? ch.sortOrder ?? (idx + 1) * 10) || 100,
        updated_at: nowIso
      })).filter((ch) => ch.title);
    }
    if (Array.isArray(payload.clubs)) {
      current.clubs = payload.clubs.map((cl, idx) => {
        const cat = String(cl.category || "VOLUNTEER_ORG").trim().toUpperCase();
        return {
          id: String(cl.id || `club_${Date.now()}_${idx}`).trim(),
          name: String(cl.name || "").trim(),
          category: CLUB_CATEGORY_LABELS[cat] ? cat : "VOLUNTEER_ORG",
          category_label: CLUB_CATEGORY_LABELS[cat] || String(cl.category_label || "志愿与组织"),
          affiliated_unit: String(cl.affiliated_unit || cl.affiliatedUnit || "校团委").trim(),
          activity_venue: String(cl.activity_venue || cl.activityVenue || "大学生活动中心").trim(),
          summary: String(cl.summary || "").trim(),
          qq_group_number: String(cl.qq_group_number || cl.qqGroupNumber || "").trim(),
          highlights: Array.isArray(cl.highlights)
            ? cl.highlights.map((x) => String(x).trim()).filter(Boolean)
            : String(cl.highlights || "")
                .split(/[,，、|/]/)
                .map((x) => x.trim())
                .filter(Boolean),
          enabled: cl.enabled !== false,
          pinned: Boolean(cl.pinned),
          sort_order: Number(cl.sort_order ?? cl.sortOrder ?? (idx + 1) * 10) || 100,
          updated_at: nowIso
        };
      }).filter((cl) => cl.name);
    }
    current.version = Number(current.version || 1) + 1;
    current.updated_at = nowIso;
    current.updated_by = actorRef;
    this.campusContent.set(key, current);
    this.recordAudit({
      actor_kind: "ADMIN",
      actor_ref: actorRef,
      action: "UPDATE_CAMPUS_CONTENT",
      resource_kind: "campus_content",
      resource_ref: key,
      outcome: "SUCCESS",
      detail: { version: current.version, channels_count: current.channels.length, clubs_count: current.clubs.length }
    });
    return this.getCampusContent(key, { includeDisabled: true });
  }

  upsertCampusChannel(schoolId = "haut", channelInput = {}, actorRef = "admin") {
    const key = String(schoolId || "haut").toLowerCase();
    const current = this.getCampusContent(key, { includeDisabled: true });
    const nowIso = new Date().toISOString();
    const id = String(channelInput.id || `ch_${Date.now()}`).trim();
    const existingIdx = current.channels.findIndex((c) => c.id === id);
    const prev = existingIdx >= 0 ? current.channels[existingIdx] : {};
    const nextItem = {
      id,
      title: String(channelInput.title ?? prev.title ?? "").trim(),
      subtitle: String(channelInput.subtitle ?? prev.subtitle ?? "").trim(),
      tag_label: String(channelInput.tag_label ?? channelInput.tagLabel ?? prev.tag_label ?? "频道").trim() || "频道",
      invite_url: this.sanitizeSafeHttpsUrl(
        channelInput.invite_url ?? channelInput.defaultInviteUrl ?? prev.invite_url ?? "",
        "https://pd.qq.com/s/hautcampus"
      ),
      channel_number_hint:
        String(channelInput.channel_number_hint ?? channelInput.channelNumberHint ?? prev.channel_number_hint ?? "点击加入").trim() ||
        "点击加入",
      enabled: channelInput.enabled !== undefined ? Boolean(channelInput.enabled) : prev.enabled !== false,
      pinned: channelInput.pinned !== undefined ? Boolean(channelInput.pinned) : Boolean(prev.pinned),
      sort_order: Number(channelInput.sort_order ?? channelInput.sortOrder ?? prev.sort_order ?? (current.channels.length + 1) * 10) || 100,
      updated_at: nowIso
    };
    if (!nextItem.title) {
      throw new ContractError("BAD_REQUEST", "频道名称不能为空");
    }
    if (existingIdx >= 0) {
      current.channels[existingIdx] = nextItem;
    } else {
      current.channels.push(nextItem);
    }
    current.version = Number(current.version || 1) + 1;
    current.updated_at = nowIso;
    current.updated_by = actorRef;
    this.campusContent.set(key, current);
    this.recordAudit({
      actor_kind: "ADMIN",
      actor_ref: actorRef,
      action: "UPSERT_CAMPUS_CHANNEL",
      resource_kind: "campus_channel",
      resource_ref: id,
      outcome: "SUCCESS",
      detail: { title: nextItem.title, enabled: nextItem.enabled, pinned: nextItem.pinned }
    });
    return this.getCampusContent(key, { includeDisabled: true });
  }

  deleteCampusChannel(schoolId = "haut", channelId, actorRef = "admin") {
    const key = String(schoolId || "haut").toLowerCase();
    const current = this.getCampusContent(key, { includeDisabled: true });
    current.channels = current.channels.filter((c) => c.id !== channelId);
    current.version = Number(current.version || 1) + 1;
    current.updated_at = new Date().toISOString();
    current.updated_by = actorRef;
    this.campusContent.set(key, current);
    this.recordAudit({
      actor_kind: "ADMIN",
      actor_ref: actorRef,
      action: "DELETE_CAMPUS_CHANNEL",
      resource_kind: "campus_channel",
      resource_ref: String(channelId || ""),
      outcome: "SUCCESS"
    });
    return this.getCampusContent(key, { includeDisabled: true });
  }

  upsertCampusClub(schoolId = "haut", clubInput = {}, actorRef = "admin") {
    const key = String(schoolId || "haut").toLowerCase();
    const current = this.getCampusContent(key, { includeDisabled: true });
    const nowIso = new Date().toISOString();
    const id = String(clubInput.id || `club_${Date.now()}`).trim();
    const existingIdx = current.clubs.findIndex((c) => c.id === id);
    const prev = existingIdx >= 0 ? current.clubs[existingIdx] : {};
    const rawCat = String(clubInput.category ?? prev.category ?? "VOLUNTEER_ORG").trim().toUpperCase();
    const category = CLUB_CATEGORY_LABELS[rawCat] ? rawCat : "VOLUNTEER_ORG";
    const highlightsRaw = clubInput.highlights !== undefined ? clubInput.highlights : prev.highlights || [];
    const highlights = Array.isArray(highlightsRaw)
      ? highlightsRaw.map((x) => String(x).trim()).filter(Boolean)
      : String(highlightsRaw || "")
          .split(/[,，、|/]/)
          .map((x) => x.trim())
          .filter(Boolean);
    const nextItem = {
      id,
      name: String(clubInput.name ?? prev.name ?? "").trim(),
      category,
      category_label: CLUB_CATEGORY_LABELS[category] || "志愿与组织",
      affiliated_unit: String(clubInput.affiliated_unit ?? clubInput.affiliatedUnit ?? prev.affiliated_unit ?? "校团委").trim() || "校团委",
      activity_venue: String(clubInput.activity_venue ?? clubInput.activityVenue ?? prev.activity_venue ?? "大学生活动中心").trim() || "大学生活动中心",
      summary: String(clubInput.summary ?? prev.summary ?? "").trim(),
      qq_group_number: String(clubInput.qq_group_number ?? clubInput.qqGroupNumber ?? prev.qq_group_number ?? "").trim(),
      highlights,
      enabled: clubInput.enabled !== undefined ? Boolean(clubInput.enabled) : prev.enabled !== false,
      pinned: clubInput.pinned !== undefined ? Boolean(clubInput.pinned) : Boolean(prev.pinned),
      sort_order: Number(clubInput.sort_order ?? clubInput.sortOrder ?? prev.sort_order ?? (current.clubs.length + 1) * 10) || 100,
      updated_at: nowIso
    };
    if (!nextItem.name) {
      throw new ContractError("BAD_REQUEST", "社团名称不能为空");
    }
    if (existingIdx >= 0) {
      current.clubs[existingIdx] = nextItem;
    } else {
      current.clubs.push(nextItem);
    }
    current.version = Number(current.version || 1) + 1;
    current.updated_at = nowIso;
    current.updated_by = actorRef;
    this.campusContent.set(key, current);
    this.recordAudit({
      actor_kind: "ADMIN",
      actor_ref: actorRef,
      action: "UPSERT_CAMPUS_CLUB",
      resource_kind: "campus_club",
      resource_ref: id,
      outcome: "SUCCESS",
      detail: { name: nextItem.name, qq_group_number: nextItem.qq_group_number, enabled: nextItem.enabled, pinned: nextItem.pinned }
    });
    return this.getCampusContent(key, { includeDisabled: true });
  }

  deleteCampusClub(schoolId = "haut", clubId, actorRef = "admin") {
    const key = String(schoolId || "haut").toLowerCase();
    const current = this.getCampusContent(key, { includeDisabled: true });
    current.clubs = current.clubs.filter((c) => c.id !== clubId);
    current.version = Number(current.version || 1) + 1;
    current.updated_at = new Date().toISOString();
    current.updated_by = actorRef;
    this.campusContent.set(key, current);
    this.recordAudit({
      actor_kind: "ADMIN",
      actor_ref: actorRef,
      action: "DELETE_CAMPUS_CLUB",
      resource_kind: "campus_club",
      resource_ref: String(clubId || ""),
      outcome: "SUCCESS"
    });
    return this.getCampusContent(key, { includeDisabled: true });
  }

  runMigrations() {
    const migrations = listMigrations();
    for (const m of migrations) {
      if (!m.upSql.includes("CREATE TABLE") && !m.upSql.includes("ALTER TABLE")) {
        throw new Error(`Invalid migration SQL in ${m.version}`);
      }
      if (!m.downSql) {
        throw new Error(`Missing rollback .down.sql for ${m.version}`);
      }
      this.appliedMigrations.add(m.version);
    }
    return Array.from(this.appliedMigrations);
  }

  rollbackLastMigration() {
    const list = Array.from(this.appliedMigrations);
    if (list.length === 0) return null;
    const last = list[list.length - 1];
    this.appliedMigrations.delete(last);
    return last;
  }

  findOrCreateCloudUser({
    issuer,
    subject,
    displayName = "XPEACH User",
    username = null,
    email = null,
    emailVerified = false,
    group = null,
    affCode = null,
    role = null,
    ssoCreatedAt = null,
    ssoLastLoginAt = null,
    ssoAccessToken = null,
    ssoRefreshToken = null,
    peachWallet = null
  }) {
    const existing = Array.from(this.users.values()).find(
      (u) => u.issuer === issuer && u.subject === subject
    );
    if (existing) {
      if (displayName) existing.display_name = displayName;
      if (username) existing.username = username;
      if (email) existing.email = email;
      if (emailVerified !== undefined) existing.email_verified = Boolean(emailVerified);
      if (group) existing.group = group;
      if (affCode) existing.aff_code = affCode;
      if (role) existing.role = role;
      if (ssoCreatedAt) existing.sso_created_at = ssoCreatedAt;
      if (ssoLastLoginAt) existing.sso_last_login_at = ssoLastLoginAt;
      if (ssoAccessToken) existing.sso_access_token = ssoAccessToken;
      if (ssoRefreshToken) existing.sso_refresh_token = ssoRefreshToken;
      if (peachWallet && typeof peachWallet === "object") {
        existing.peach_wallet = { ...(existing.peach_wallet || {}), ...peachWallet };
      }
      this._syncAdminRoleIfEligible(existing);
      this.saveSnapshot();
      return existing;
    }
    const id = crypto.randomUUID();
    const user = {
      id,
      issuer,
      subject,
      username: username || displayName || "XPEACH User",
      display_name: displayName,
      email: email || null,
      email_verified: Boolean(emailVerified),
      group: group || peachWallet?.group || "默认分组",
      aff_code: affCode || peachWallet?.affCode || null,
      role: role || "user",
      sso_created_at: ssoCreatedAt || new Date().toISOString(),
      sso_last_login_at: ssoLastLoginAt || new Date().toISOString(),
      sso_access_token: ssoAccessToken || null,
      sso_refresh_token: ssoRefreshToken || null,
      peach_wallet: peachWallet && typeof peachWallet === "object" ? { ...peachWallet } : null,
      status: "ACTIVE",
      created_at: new Date().toISOString()
    };
    this.users.set(id, user);
    if (!this.userRoles.has(id)) {
      this.userRoles.set(id, new Set(["USER"]));
    }
    this._syncAdminRoleIfEligible(user);
    this.saveSnapshot();
    return user;
  }

  _syncAdminRoleIfEligible(user) {
    if (!user) return;
    if (
      user.role === "admin" ||
      user.subject === "856f-cf51-b064-5d84"
    ) {
      const roles = this.userRoles.get(user.id) || new Set(["USER"]);
      roles.add("ADMIN");
      roles.add("OPERATOR");
      roles.add("FINANCE");
      roles.add("PLATFORM_OWNER");
      roles.add("OPERATIONS_ADMIN");
      roles.add("SCHOOL_OPERATOR");
      roles.add("FINANCE_OPERATOR");
      roles.add("SECURITY_AUDITOR");
      this.userRoles.set(user.id, roles);
    }
  }

  getUserRoles(cloudUserId) {
    const set = this.userRoles.get(cloudUserId);
    return set ? Array.from(set) : ["USER"];
  }

  setUserRoles(cloudUserId, roles) {
    this.userRoles.set(cloudUserId, new Set(["USER", ...(roles || [])]));
    this.saveSnapshot();
  }

  requireRole(authContext, requiredRoles) {
    if (!authContext || !authContext.cloudUserId) {
      throw new ContractError("CLOUD_AUTH_REQUIRED", "Authentication required");
    }
    const roles = authContext.roles || this.getUserRoles(authContext.cloudUserId);
    const allowed = requiredRoles.some((r) => roles.includes(r));
    if (!allowed) {
      throw new ContractError(
        "FORBIDDEN",
        `Insufficient RBAC role; required one of: ${requiredRoles.join(", ")}`
      );
    }
  }

  recordAudit({
    actor_kind = "SYSTEM",
    actor_ref = "system",
    action,
    resource_kind,
    resource_ref,
    outcome = "SUCCESS",
    detail = null
  }) {
    const entry = {
      id: crypto.randomUUID(),
      actor_kind,
      actor_ref,
      action,
      resource_kind,
      resource_ref,
      outcome,
      detail: detail ? redactSensitiveFields(detail) : null,
      created_at: new Date().toISOString()
    };
    this.auditEvents.push(entry);
    this.saveSnapshot();
    return entry;
  }

  addNotification({ cloudUserId, category, title, body }) {
    const id = crypto.randomUUID();
    const n = {
      id,
      cloud_user_id: cloudUserId,
      category,
      title,
      body,
      read_at: null,
      created_at: new Date().toISOString()
    };
    this.notifications.set(id, n);
    this.saveSnapshot();
    return n;
  }

  haltAllUserPlansAndBindings(cloudUserId, reason = "CONSENT_WITHDRAWN", nowMs = Date.now()) {
    const ts = new Date(nowMs).toISOString();
    const cancelledJobIds = [];

    for (const b of this.schoolBindings.values()) {
      if (b.cloud_user_id === cloudUserId && !b.revoked_at) {
        b.revoked_at = ts;
        b.status = "REVOKED";
        if (b.credential_ref && this.encryptedCredentials.has(b.credential_ref)) {
          this.encryptedCredentials.get(b.credential_ref).revoked_at = ts;
        }
      }
    }

    for (const c of this.consents.values()) {
      if (c.cloud_user_id === cloudUserId && !c.withdrawn_at) {
        c.withdrawn_at = ts;
      }
    }

    for (const p of this.reservationPlans.values()) {
      if (p.cloud_user_id === cloudUserId && p.enabled) {
        p.enabled = false;
      }
    }

    for (const j of this.reservationJobs.values()) {
      if (
        j.cloud_user_id === cloudUserId &&
        !["CONFIRMED", "FAILED", "CANCELLED", "EXPIRED", "REVOKED"].includes(j.state)
      ) {
        j.state = "CANCELLED";
        j.state_version += 1;
        j.last_error_code = reason;
        cancelledJobIds.push(j.id);
      }
    }

    this.recordAudit({
      actor_kind: "USER",
      actor_ref: cloudUserId,
      action: "HALT_ALL_PLANS_AND_BINDINGS",
      resource_kind: "cloud_user",
      resource_ref: cloudUserId,
      outcome: reason,
      detail: { cancelled_job_ids: cancelledJobIds }
    });

    return { cancelledJobIds };
  }

  revokeSchoolBindingCascade(cloudUserId, bindingId, reason = "BINDING_REVOKED", nowMs = Date.now()) {
    const binding = this.schoolBindings.get(bindingId);
    if (!binding || binding.cloud_user_id !== cloudUserId) {
      throw new ContractError("NOT_FOUND", "School binding not found");
    }
    const ts = new Date(nowMs).toISOString();
    binding.revoked_at = ts;
    binding.status = "REVOKED";
    if (binding.credential_ref && this.encryptedCredentials.has(binding.credential_ref)) {
      this.encryptedCredentials.get(binding.credential_ref).revoked_at = ts;
    }

    const cancelledJobIds = [];
    for (const p of this.reservationPlans.values()) {
      if (p.school_binding_id === bindingId) {
        p.enabled = false;
      }
    }
    for (const j of this.reservationJobs.values()) {
      if (
        j.school_binding_id === bindingId &&
        !["CONFIRMED", "FAILED", "CANCELLED", "EXPIRED", "REVOKED"].includes(j.state)
      ) {
        j.state = "CANCELLED";
        j.state_version += 1;
        j.last_error_code = reason;
        cancelledJobIds.push(j.id);
      }
    }

    this.recordAudit({
      actor_kind: "USER",
      actor_ref: cloudUserId,
      action: "REVOKE_SCHOOL_BINDING",
      resource_kind: "school_binding",
      resource_ref: bindingId,
      outcome: reason,
      detail: { cancelled_job_ids: cancelledJobIds }
    });

    return { binding, cancelledJobIds };
  }
}
