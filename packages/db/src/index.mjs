import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  ContractError,
  DEFAULT_RESERVATION_PRICE_MICROPEACH,
  DEFAULT_SCHOOL_ID,
  redactSensitiveFields
} from "../../contracts/src/index.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = path.resolve(__dirname, "../migrations");

// SSO tenant membership role -> cloud backend role mapping (owner > admin > member).
// owner carries PLATFORM_OWNER (highest privilege); admin gets the operational set only.
const SSO_OWNER_ROLES = Object.freeze([
  "ADMIN", "OPERATOR", "FINANCE", "PLATFORM_OWNER",
  "OPERATIONS_ADMIN", "SCHOOL_OPERATOR", "FINANCE_OPERATOR", "SECURITY_AUDITOR"
]);
const SSO_ADMIN_ROLES = Object.freeze(SSO_OWNER_ROLES.filter((r) => r !== "PLATFORM_OWNER"));
const EMPTY_ROLE_SET = Object.freeze([]);

const CLUB_CATEGORY_LABELS = {
  TECH_INNOVATION: "科技创新",
  ACADEMIC_CULTURE: "学术文化",
  ART_PERFORMANCE: "文艺展演",
  SPORTS_FITNESS: "体育竞技",
  VOLUNTEER_ORG: "志愿与组织"
};

const COMPETITION_CATEGORY_LABELS = {
  ALGO_PROGRAMMING: "算法与程序设计",
  ELECTRONICS_ROBO: "电子与机器人硬件",
  MATH_MODELING: "数学建模与数据分析",
  INNOVATION_ENTREPRENEURSHIP: "创新创业",
  CYBER_SECURITY_AI: "网安与人工智能",
  DIGITAL_MEDIA_ART: "数媒创意与外语综合"
};

export function createDefaultHautCompetitions(nowIso = new Date().toISOString()) {
  return [
    {
      id: "comp_lanqiao",
      title: "蓝桥杯全国软件和信息技术专业人才大赛",
      short_title: "蓝桥杯",
      tier_badge: "教育部白名单 A 类赛事",
      category: "ALGO_PROGRAMMING",
      category_label: "算法与程序设计",
      recommended_major_tracks: ["CS_AI_SOFTWARE", "EE_AUTOMATION_IOT", "MATH_PHYSICS_CIVIL"],
      interest_tags: ["算法编程", "单片机/EDA", "大厂笔试", "保研/综测加分"],
      organizer: "工业和信息化部人才交流中心",
      haut_host_college: "信息科学与工程学院 / 人工智能与大数据学院",
      registration_window: "每年 10月–12月报名 · 次年 4月省赛 / 6月国赛",
      team_mode: "个人赛（软件类 C/C++/Java/Python · 电子类单片机/EDA）",
      difficulty_label: "入门友好 · 个人参赛",
      beginner_friendly: true,
      summary: "面向高校学生的个人编程与电子设计赛事，设 C/C++、Java、Python、Web 及单片机赛道，适合低年级学生参赛练习。",
      skill_roadmap: "掌握一门编程语言 (C++/Python/Java) → 熟悉基础数据结构、搜索与贪心算法 → 学习动态规划与图论基础并练习历年真题",
      official_website_url: "https://dasai.lanqiao.cn",
      partner_club_id: "club_partner_computer_service",
      partner_club_name: "计算机服务社",
      partner_club_qq: "1043885481",
      enabled: true,
      pinned: true,
      sort_order: 10,
      updated_at: nowIso
    },
    {
      id: "comp_nuedc",
      title: "全国大学生电子设计竞赛 (NUEDC)",
      short_title: "全国电赛",
      tier_badge: "教育部白名单 A 类赛事",
      category: "ELECTRONICS_ROBO",
      category_label: "电子与机器人硬件",
      recommended_major_tracks: ["EE_AUTOMATION_IOT", "MECH_VEHICLE_ROBO", "CS_AI_SOFTWARE"],
      interest_tags: ["STM32/嵌入式", "PCB硬件设计", "电源与信号调理", "视觉控制"],
      organizer: "教育部高等教育司 / 工业和信息化部人事教育司",
      haut_host_college: "电气工程学院 / 信息科学与工程学院",
      registration_window: "每年 5月–6月报名 · 8月四天三夜集中竞赛",
      team_mode: "3人组队（硬件电路 + 嵌入式控制 + 信号算法/报告）",
      difficulty_label: "较高难度 · 需实验室集训",
      beginner_friendly: false,
      summary: "电子信息、电气与自动化领域的国家级学科竞赛，采用全国统一命题、四天三夜制作实物的赛制，考察硬件电路与嵌入式开发能力。",
      skill_roadmap: "学习 STM32 单片机与 EDA 电路设计 → 掌握 PID 控制、运放电路与传感器驱动 → 参与社团日常训练与暑期集训",
      official_website_url: "https://nuedc-training.com.cn",
      partner_club_id: "club_partner_hardware_alliance",
      partner_club_name: "硬件技术联盟",
      partner_club_qq: "789860526",
      enabled: true,
      pinned: true,
      sort_order: 12,
      updated_at: nowIso
    },
    {
      id: "comp_cumcm",
      title: "高教社杯全国大学生数学建模竞赛",
      short_title: "全国数模国赛",
      tier_badge: "教育部白名单 A 类赛事",
      category: "MATH_MODELING",
      category_label: "数学建模与数据分析",
      recommended_major_tracks: ["ALL_MAJORS", "MATH_PHYSICS_CIVIL", "CS_AI_SOFTWARE", "EE_AUTOMATION_IOT", "ECON_MGMT_FINANCE"],
      interest_tags: ["MATLAB/Python", "数据分析与优化", "LaTeX排版", "保研/综测加分"],
      organizer: "中国工业与应用数学学会 (CSIAM)",
      haut_host_college: "理学院",
      registration_window: "每年 6月–8月校内选拔培训 · 9月上旬三天三夜正赛",
      team_mode: "3人组队（数学建模 + MATLAB/Python 编程 + 论文写作）",
      difficulty_label: "入门友好 · 适合跨专业组队",
      beginner_friendly: true,
      summary: "覆盖各专业的基础学科竞赛，通过建立数学模型与计算机仿真解决实际问题，锻炼数据分析与论文写作能力。",
      skill_roadmap: "组建建模、编程与写作团队 → 掌握常见评价、预测与优化模型 → 熟悉 MATLAB/Python 编程与论文排版",
      official_website_url: "https://www.mcm.edu.cn",
      partner_club_id: "club_partner_computer_service",
      partner_club_name: "计算机服务社",
      partner_club_qq: "1043885481",
      enabled: true,
      pinned: true,
      sort_order: 14,
      updated_at: nowIso
    },
    {
      id: "comp_cyds",
      title: "中国国际大学生创新大赛（原“互联网+”）",
      short_title: "中国国际大学生创新大赛",
      tier_badge: "教育部白名单顶尖双创赛事",
      category: "INNOVATION_ENTREPRENEURSHIP",
      category_label: "创新创业",
      recommended_major_tracks: ["ALL_MAJORS", "FOOD_BIO_CHEM_MAT", "CS_AI_SOFTWARE", "ECON_MGMT_FINANCE", "MECH_VEHICLE_ROBO"],
      interest_tags: ["双创赛事", "粮油食品赛道", "商业计划书", "路演答辩"],
      organizer: "教育部等十二部委联合主办",
      haut_host_college: "创新创业学院 / 教务处",
      registration_window: "每年 4月–6月校赛网评 · 7月–8月省赛 · 10月全国总决赛",
      team_mode: "3–15人跨学科组队（技术研发 + 商业模式 + 财务法务 + 路演PPT）",
      difficulty_label: "全专业可参加",
      beginner_friendly: true,
      summary: "综合性大学生创新创业赛事（含高教主赛道、红旅赛道与产业命题赛道），可结合粮油食品、智能装备、信息技术等学科方向组队参赛。",
      skill_roadmap: "结合科研课题或学科特色确定选题 → 撰写商业计划书 (BP) → 准备专利、软著或应用证明及路演材料",
      official_website_url: "https://cy.ncss.cn",
      partner_club_id: "",
      partner_club_name: "",
      partner_club_qq: "",
      enabled: true,
      pinned: true,
      sort_order: 16,
      updated_at: nowIso
    },
    {
      id: "comp_icpc_ccpc",
      title: "ICPC 国际大学生程序设计竞赛 & CCPC 中国大学生程序设计竞赛",
      short_title: "ICPC / CCPC 算法赛",
      tier_badge: "教育部白名单顶尖赛事",
      category: "ALGO_PROGRAMMING",
      category_label: "算法与程序设计",
      recommended_major_tracks: ["CS_AI_SOFTWARE", "MATH_PHYSICS_CIVIL"],
      interest_tags: ["ACM集训", "算法程序设计", "团队协作", "名企研发认可"],
      organizer: "ICPC 国际大学生程序设计竞赛基金会 / CCPC 组委会",
      haut_host_college: "信息科学与工程学院",
      registration_window: "每年 3月–5月省赛/邀请赛 · 9月–11月网络赛与区域赛",
      team_mode: "3人组队（共用 1 台电脑限时 5 小时完成算法题）",
      difficulty_label: "高难度 · 需长期算法训练",
      beginner_friendly: false,
      summary: "国际通用的大学生算法与程序设计竞赛，重点考察算法设计与编程实现能力，受高校与软件研发企业认可。",
      skill_roadmap: "在线题库入门练习 → 系统学习高级数据结构（线段树/树状数组/并查集） → 图论网络流、数论与博弈论 → 3 人组队模拟训练",
      official_website_url: "https://ccpc.io",
      partner_club_id: "club_partner_computer_service",
      partner_club_name: "计算机服务社",
      partner_club_qq: "1043885481",
      enabled: true,
      pinned: false,
      sort_order: 20,
      updated_at: nowIso
    },
    {
      id: "comp_smartcar",
      title: "全国大学生智能汽车竞赛",
      short_title: "智能汽车竞赛",
      tier_badge: "教育部白名单 A 类赛事",
      category: "ELECTRONICS_ROBO",
      category_label: "电子与机器人硬件",
      recommended_major_tracks: ["EE_AUTOMATION_IOT", "MECH_VEHICLE_ROBO", "CS_AI_SOFTWARE"],
      interest_tags: ["自动控制", "PID控制算法", "嵌入式硬件", "机器视觉"],
      organizer: "中国自动化学会",
      haut_host_college: "电气工程学院 / 机电工程学院",
      registration_window: "每年 11月发布赛题 → 次年 7月分赛区赛 / 8月全国总决赛",
      team_mode: "3–5人组队（机械车模调校 + 硬件驱动板 + 视觉/电磁循迹控制）",
      difficulty_label: "进阶实践 · 软硬件结合",
      beginner_friendly: true,
      summary: "以智能车为载体的工程实践赛事，涵盖电磁循迹、视觉识别、平衡控制等组别，综合考察机械、硬件与控制算法。",
      skill_roadmap: "学习 C 语言与微控制器 PWM/编码器驱动 → 设计电机驱动与电源稳压 PCB → 图像赛道提取与串级 PID 闭环调参",
      official_website_url: "https://smartcar.cdstm.cn",
      partner_club_id: "club_partner_hardware_alliance",
      partner_club_name: "硬件技术联盟",
      partner_club_qq: "789860526",
      enabled: true,
      pinned: false,
      sort_order: 22,
      updated_at: nowIso
    },
    {
      id: "comp_robomaster",
      title: "全国大学生机器人大赛 (RoboMaster / ROBOCON)",
      short_title: "RoboMaster 机器人赛",
      tier_badge: "教育部白名单 A 类赛事",
      category: "ELECTRONICS_ROBO",
      category_label: "电子与机器人硬件",
      recommended_major_tracks: ["MECH_VEHICLE_ROBO", "EE_AUTOMATION_IOT", "CS_AI_SOFTWARE"],
      interest_tags: ["机器人设计", "SolidWorks机械", "ROS2/机器视觉", "电控开发"],
      organizer: "共青团中央 / 全国学联",
      haut_host_college: "机电工程学院 / 电气工程学院",
      registration_window: "每年 9月–10月招新与赛季注册 · 次年 5月区域赛 / 8月全国赛",
      team_mode: "战队协作（机械结构 + 嵌入式电控 + 机器视觉算法 + 战队运营）",
      difficulty_label: "较高难度 · 多学科团队协作",
      beginner_friendly: true,
      summary: "综合性机器人工程竞赛，融合机械结构设计、嵌入式电控与机器视觉算法，适合多专业学生组队参与。",
      skill_roadmap: "按方向分工学习：机械组掌握 SolidWorks 三维建模；电控组掌握 FreeRTOS 与 CAN 总线控制；算法组掌握相机标定与视觉识别",
      official_website_url: "https://www.robomaster.com",
      partner_club_id: "club_partner_hardware_alliance",
      partner_club_name: "硬件技术联盟",
      partner_club_qq: "789860526",
      enabled: true,
      pinned: false,
      sort_order: 24,
      updated_at: nowIso
    },
    {
      id: "comp_tiaozhanbei",
      title: "“挑战杯”全国大学生课外学术科技作品竞赛与创业计划竞赛",
      short_title: "“挑战杯”双创赛",
      tier_badge: "教育部白名单顶尖双创赛事",
      category: "INNOVATION_ENTREPRENEURSHIP",
      category_label: "创新创业",
      recommended_major_tracks: ["ALL_MAJORS", "FOOD_BIO_CHEM_MAT", "MECH_VEHICLE_ROBO", "CS_AI_SOFTWARE", "ECON_MGMT_FINANCE"],
      interest_tags: ["学术科技", "科技发明制作", "社会调研报告", "创新创业"],
      organizer: "共青团中央 / 中国科协 / 教育部 / 全国学联",
      haut_host_college: "校团委",
      registration_window: "每年 11月–次年3月校赛立项 · 5月省赛 · 10月全国终审决赛",
      team_mode: "3–10人组队（大挑：学术科技发明制作/哲学社科调查；小挑：创业计划）",
      difficulty_label: "学术科技与社会调研",
      beginner_friendly: true,
      summary: "全国性大学生课外学术科技与创业竞赛，奇数年举办学术科技作品竞赛（大挑），偶数年举办创业计划竞赛（小挑），适合各专业学生参加。",
      skill_roadmap: "参与导师课题组或大创项目 → 理工科侧重实物样机与论文专利，人文经管侧重实地调研与分析报告",
      official_website_url: "https://www.tiaozhanbei.net",
      partner_club_id: "",
      partner_club_name: "",
      partner_club_qq: "",
      enabled: true,
      pinned: false,
      sort_order: 26,
      updated_at: nowIso
    },
    {
      id: "comp_ciscn",
      title: "全国大学生信息安全竞赛 (CISCN)",
      short_title: "全国信息安全竞赛",
      tier_badge: "教育部白名单 A 类赛事",
      category: "CYBER_SECURITY_AI",
      category_label: "网安与人工智能",
      recommended_major_tracks: ["CS_AI_SOFTWARE", "EE_AUTOMATION_IOT"],
      interest_tags: ["CTF解题", "Web渗透与逆向", "密码学", "安全创新作品"],
      organizer: "教育部高等学校网络空间安全专业教学指导委员会",
      haut_host_college: "信息科学与工程学院",
      registration_window: "每年 3月–4月报名 · 5月分区赛 · 7月全国总决赛",
      team_mode: "4人组队（创新实践能力赛 CTF 解题/AWD 攻防 · 安全作品赛）",
      difficulty_label: "进阶难度 · 网络安全实践",
      beginner_friendly: false,
      summary: "网络空间安全领域的国家级赛事，设 CTF 攻防赛与信息安全作品赛两个方向，考察漏洞分析、逆向工程、密码学与安全开发。",
      skill_roadmap: "学习 Linux 与计算机网络协议 → 选定 Web 渗透、逆向工程、二进制安全或密码学方向 → 结合在线靶场持续练习",
      official_website_url: "https://www.ciscn.cn",
      partner_club_id: "club_partner_computer_service",
      partner_club_name: "计算机服务社",
      partner_club_qq: "1043885481",
      enabled: true,
      pinned: false,
      sort_order: 28,
      updated_at: nowIso
    },
    {
      id: "comp_jsjds_4c",
      title: "中国大学生计算机设计大赛 (4C)",
      short_title: "计算机设计大赛",
      tier_badge: "教育部白名单 A 类赛事",
      category: "CYBER_SECURITY_AI",
      category_label: "网安与人工智能",
      recommended_major_tracks: ["CS_AI_SOFTWARE", "DESIGN_MEDIA_FOREIGN", "EE_AUTOMATION_IOT", "ALL_MAJORS"],
      interest_tags: ["软件与小程序", "人工智能应用", "数据可视化", "数字媒体设计"],
      organizer: "教育部高等学校计算机类专业教学指导委员会等",
      haut_host_college: "人工智能与大数据学院 / 信息科学与工程学院",
      registration_window: "每年 3月–4月校赛选拔 · 5月省赛 · 7月–8月全国总决赛",
      team_mode: "1–5人组队（软件应用开发 / 人工智能应用 / 信息可视化 / 数媒动漫游戏）",
      difficulty_label: "入门友好 · 提交作品参赛",
      beginner_friendly: true,
      summary: "面向各专业学生的作品类计算机竞赛，通过提交软件、小程序、人工智能应用、数据可视化或数字媒体作品参赛。",
      skill_roadmap: "确定选题方向 → 完成前后端/移动端开发或数字媒体设计 → 录制演示视频并撰写设计说明书",
      official_website_url: "https://jsjds.blcu.edu.cn",
      partner_club_id: "club_partner_computer_service",
      partner_club_name: "计算机服务社",
      partner_club_qq: "1043885481",
      enabled: true,
      pinned: false,
      sort_order: 30,
      updated_at: nowIso
    },
    {
      id: "comp_umic",
      title: "全国大学生机械创新设计大赛",
      short_title: "全国机械创新大赛",
      tier_badge: "教育部白名单 A 类赛事",
      category: "ELECTRONICS_ROBO",
      category_label: "电子与机器人硬件",
      recommended_major_tracks: ["MECH_VEHICLE_ROBO", "EE_AUTOMATION_IOT"],
      interest_tags: ["机械结构创新", "SolidWorks/UG", "机电一体化", "实物样机"],
      organizer: "全国大学生机械创新设计大赛组委会",
      haut_host_college: "机电工程学院",
      registration_window: "每两年一届（奇数年发布主题，偶数年 4月省赛 / 7月国赛）",
      team_mode: "3–5人组队（机构创新设计 + 力学仿真 + 样机加工装配）",
      difficulty_label: "进阶难度 · 机械工程实践",
      beginner_friendly: true,
      summary: "机械工程领域的全国性学科竞赛，围绕农业机械、仿生机械与智能装备等主题，考察机构设计、三维建模仿真与样机制作。",
      skill_roadmap: "掌握机械原理与机械设计基础 → 使用 SolidWorks/UG 进行三维建模、运动仿真与有限元分析 → 联合电控同学完成样机加工调试",
      official_website_url: "https://umic.ckcest.cn",
      partner_club_id: "club_partner_hardware_alliance",
      partner_club_name: "硬件技术联盟",
      partner_club_qq: "789860526",
      enabled: true,
      pinned: false,
      sort_order: 32,
      updated_at: nowIso
    },
    {
      id: "comp_3chuang",
      title: "全国大学生电子商务“创新、创意及创业”挑战赛（三创赛）",
      short_title: "电子商务“三创赛”",
      tier_badge: "教育部白名单 A 类赛事",
      category: "INNOVATION_ENTREPRENEURSHIP",
      category_label: "创新创业",
      recommended_major_tracks: ["ECON_MGMT_FINANCE", "CS_AI_SOFTWARE", "FOOD_BIO_CHEM_MAT", "DESIGN_MEDIA_FOREIGN", "ALL_MAJORS"],
      interest_tags: ["电商策划", "乡村振兴", "新媒体运营", "跨专业组队"],
      organizer: "全国电子商务产教融合创新联盟",
      haut_host_college: "经济贸易学院 / 管理学院",
      registration_window: "每年 10月–12月官网注册报名 · 次年 3月–4月校赛 / 5月省赛 / 7月国赛",
      team_mode: "3–5人组队（常规赛 + 跨境电商/乡村振兴/产学用实战赛）",
      difficulty_label: "入门友好 · 适合跨专业组队",
      beginner_friendly: true,
      summary: "面向经管、工科及文科学生的全国性电子商务竞赛，涵盖商业策划、跨境电商、助农电商与数字经济等方向。",
      skill_roadmap: "在官网完成团队报名 → 结合农产品电商、品牌营销或数字化应用选定方向 → 完善市场调研、财务模型与运营材料",
      official_website_url: "https://www.3chuang.net",
      partner_club_id: "",
      partner_club_name: "",
      partner_club_qq: "",
      enabled: true,
      pinned: false,
      sort_order: 34,
      updated_at: nowIso
    },
    {
      id: "comp_sun_ada",
      title: "全国大学生广告艺术大赛（大广赛）",
      short_title: "全国大广赛",
      tier_badge: "教育部白名单 A 类赛事",
      category: "DIGITAL_MEDIA_ART",
      category_label: "数媒创意与外语综合",
      recommended_major_tracks: ["DESIGN_MEDIA_FOREIGN", "ECON_MGMT_FINANCE", "ALL_MAJORS"],
      interest_tags: ["海报/插画", "二维/三维动画", "短视频拍摄", "品牌广告策划"],
      organizer: "中国高等教育学会广告教育专业委员会",
      haut_host_college: "设计艺术学院 / 新闻与传播学院",
      registration_window: "每年 3月–5月企业命题发布与创作 · 6月省赛 · 8月全国评审",
      team_mode: "1–3人（平面/文案/UI）或 1–5人（视频/动画/广播/策划案）",
      difficulty_label: "入门友好 · 视觉与创意设计",
      beginner_friendly: true,
      summary: "艺术设计、新闻传播与数字媒体领域的全国性竞赛，围绕企业命题开展平面设计、动画、短视频、策划案与文案创作。",
      skill_roadmap: "阅读当季企业命题要求 → 提炼创意方案 → 使用设计或剪辑软件完成平面、动画或视频作品",
      official_website_url: "https://www.sun-ada.net",
      partner_club_id: "club_partner_chiyekong_acg",
      partner_club_name: "炽夜空动漫社",
      partner_club_qq: "314623763",
      enabled: true,
      pinned: false,
      sort_order: 36,
      updated_at: nowIso
    },
    {
      id: "comp_neccs",
      title: "全国大学生英语竞赛 (NECCS)",
      short_title: "全国大学生英语竞赛",
      tier_badge: "国家级学科综合赛事",
      category: "DIGITAL_MEDIA_ART",
      category_label: "数媒创意与外语综合",
      recommended_major_tracks: ["ALL_MAJORS", "DESIGN_MEDIA_FOREIGN", "ECON_MGMT_FINANCE"],
      interest_tags: ["英语综合能力", "四六级备考", "保研/综测加分", "个人赛"],
      organizer: "国际英语外语教师协会中国英语外语教师协会 / 高等学校大学外语教学研究会",
      haut_host_college: "外语学院",
      registration_window: "每年 2月–3月报名 · 4月中旬初赛 / 5月中旬全国决赛",
      team_mode: "个人赛（A类研究生 / B类英语专业 / C类非英语本科 / D类艺体类）",
      difficulty_label: "入门友好 · 按参赛比例评奖",
      beginner_friendly: true,
      summary: "全国统考的大学生英语综合能力竞赛（C类面向非英语专业本科生），按各校参赛人数比例评定奖项。",
      skill_roadmap: "巩固四六级词汇与阅读理解 → 练习赛题中的逻辑推理、改错、翻译与应用文写作 → 限时练习历年真题",
      official_website_url: "https://www.chinaneccs.cn",
      partner_club_id: "",
      partner_club_name: "",
      partner_club_qq: "",
      enabled: true,
      pinned: false,
      sort_order: 38,
      updated_at: nowIso
    }
  ];
}

export function createDefaultHautCampusContent() {
  const nowIso = new Date().toISOString();
  return {
    school_id: "haut",
    version: 3,
    updated_at: nowIso,
    updated_by: "system",
    bulletin: {
      enabled: true,
      title: "合作社团与学科竞赛",
      content: "汇总校内合作社团招新群与常见学科竞赛信息，可按专业方向筛选赛事并查看官网。",
      tag: "社团与竞赛",
      action_url: ""
    },
    channels: [],
    clubs: [
      {
        id: "club_partner_chiyekong_acg",
        name: "炽夜空动漫社",
        category: "ART_PERFORMANCE",
        category_label: "文艺展演",
        affiliated_unit: "校团委社团管理部",
        activity_venue: "大学生活动中心",
        summary: "涵盖宅舞、Cosplay、配音、绘画与校园动漫文化节展演活动。",
        qq_group_number: "314623763",
        highlights: ["合作社团", "动漫文化节", "Cosplay/宅舞"],
        enabled: true,
        pinned: true,
        sort_order: 10,
        updated_at: nowIso
      },
      {
        id: "club_partner_hardware_alliance",
        name: "硬件技术联盟",
        category: "TECH_INNOVATION",
        category_label: "科技创新",
        affiliated_unit: "电气工程学院 / 人工智能与大数据学院",
        activity_venue: "莲花街校区创客空间",
        summary: "专注嵌入式开发、PCB 硬件设计、装机DIY与电子制作技术交流。",
        qq_group_number: "789860526",
        highlights: ["合作社团", "硬件开发", "装机DIY"],
        enabled: true,
        pinned: true,
        sort_order: 20,
        updated_at: nowIso
      },
      {
        id: "club_partner_computer_service",
        name: "计算机服务社",
        category: "TECH_INNOVATION",
        category_label: "科技创新",
        affiliated_unit: "信息科学与工程学院",
        activity_venue: "莲花街校区 学生宿舍F01 W111",
        campus_name: "莲花街校区",
        building_name: "学生宿舍F01",
        room_number: "W111",
        summary: "开展校园电脑义务义诊、系统重装、软硬件维护与计算机技术科普交流。",
        qq_group_number: "1043885481",
        highlights: ["合作社团", "电脑义诊", "技术互助"],
        enabled: true,
        pinned: true,
        sort_order: 30,
        updated_at: nowIso
      }
    ],
    competitions: createDefaultHautCompetitions(nowIso)
  };
}


export function createDefaultHautMomentsState(nowIso = new Date().toISOString()) {
  return {
    school_id: "haut",
    updated_at: nowIso,
    posts: [],
    book_listings: [],
    anti_lost_tags: [],
    isbn_catalog: []
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

export function simulateMigration0004OnCatalog(
  catalog,
  { direction = "up", currentSchema = "public" } = {}
) {
  const m0004 = listMigrations().find(
    (m) => m.version === "0004_cloud_users_status_check_forward"
  );
  if (!m0004) throw new Error("Missing 0004_cloud_users_status_check_forward migration");
  const sqlText = direction === "down" ? m0004.downSql : m0004.upSql;
  const regexMatch = sqlText.match(/~\*\s*'(\^CHECK[\s\S]*?\$)'/);
  if (!regexMatch) {
    throw new Error(`Migration 0004 (${direction}) missing anchored status-domain regex`);
  }
  const unescapedPattern = regexMatch[1].replace(/''/g, "'");
  const domainDefRegex = new RegExp(unescapedPattern, "i");
  const targetSchema = currentSchema || "public";

  const nextConstraints = catalog.constraints.map((c) => ({ ...c }));
  const nextRows = (catalog.rows || []).map((r) => ({ ...r }));

  if (direction === "down") {
    for (const row of nextRows) {
      if (
        row.schema === targetSchema &&
        row.table === "cloud_users" &&
        row.status === "DELETED"
      ) {
        row.status = "DELETION_REQUESTED";
      }
    }
  }

  const shouldDrop = (con) => {
    if (con.schema !== targetSchema) return false;
    if (con.table !== "cloud_users") return false;
    if (!["r", "p"].includes(con.relkind || "r")) return false;
    if (con.contype !== "c") return false;
    if (!Array.isArray(con.columns) || con.columns.length !== 1) return false;
    if (con.columns[0] !== "status") return false;
    const def = String(con.definition || "");
    if (
      !def.includes("'ACTIVE'") ||
      !def.includes("'DISABLED'") ||
      !def.includes("'DELETION_REQUESTED'")
    ) {
      return false;
    }
    const stripped = def.replace(/::(character varying|varchar|text)/gi, "");
    return domainDefRegex.test(stripped);
  };

  const surviving = nextConstraints.filter((c) => !shouldDrop(c));
  const duplicateName = surviving.find(
    (c) =>
      c.schema === targetSchema &&
      c.table === "cloud_users" &&
      c.name === "cloud_users_status_check"
  );
  if (duplicateName) {
    throw new Error(
      `Constraint name collision on ${targetSchema}.cloud_users.cloud_users_status_check`
    );
  }
  surviving.push({
    schema: targetSchema,
    table: "cloud_users",
    relkind: "r",
    contype: "c",
    name: "cloud_users_status_check",
    columns: ["status"],
    definition:
      direction === "down"
        ? "CHECK ((status = ANY (ARRAY['ACTIVE'::text, 'DISABLED'::text, 'DELETION_REQUESTED'::text])))"
        : "CHECK ((status = ANY (ARRAY['ACTIVE'::text, 'DISABLED'::text, 'DELETION_REQUESTED'::text, 'DELETED'::text])))"
  });

  return {
    constraints: surviving,
    rows: nextRows
  };
}

const DATA_DELETE_MAP_FIELDS = Object.freeze([
  "users", "userRoles", "userSsoRoles", "authTransactions", "exchangeTickets",
  "deviceSessions", "schoolIntegrations", "schoolBindings", "encryptedCredentials",
  "consents", "reservationPlans", "reservationJobs", "scheduleEvents",
  "schoolReservations", "reservationAttempts", "reservationOrders", "financeOperations",
  "refundRequests", "parcels", "parcelEvents", "parcelSourceConnections",
  "parcelSyncJobs", "pluginInstallations", "campusContent", "groups", "groupMembers",
  "groupInvites", "availabilityShares", "busyBlocks", "meetingPolls", "pollOptions",
  "pollVotes", "confirmedGroupEvents", "notifications", "priceQuotes", "idempotencyRecords"
]);
const DATA_DELETE_ARRAY_FIELDS = Object.freeze(["outboxEvents", "auditEvents"]);

function dataDeleteIsObject(value) {
  return value !== null && (typeof value === "object" || typeof value === "function");
}

function dataDeleteContainerKind(value) {
  if (!dataDeleteIsObject(value)) return null;
  if (Array.isArray(value)) return "array";
  if (value instanceof Map) return "map";
  if (value instanceof Set) return "set";
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null ? "object" : null;
}

function dataDeleteAssertDescriptorValue(value, key, descriptor) {
  if (!descriptor || !Object.hasOwn(descriptor, "value")) {
    throw new Error(
      "data-delete 原子候选包含访问器属性 " + String(key) + "；删号计算只接受纯数据对象图"
    );
  }
  return descriptor;
}

function cloneDataDeleteValue(value, liveToClone, cloneToLive) {
  if (!dataDeleteIsObject(value)) return value;
  const existing = liveToClone.get(value);
  if (existing) return existing;
  const kind = dataDeleteContainerKind(value);
  if (!kind) {
    throw new Error("data-delete 原子候选包含不可克隆的非纯数据对象；拒绝猜测删后世界");
  }

  let copy;
  if (kind === "array") copy = [];
  else if (kind === "map") copy = new Map();
  else if (kind === "set") copy = new Set();
  else copy = Object.create(Object.getPrototypeOf(value) ?? Object.prototype);
  liveToClone.set(value, copy);
  cloneToLive.set(copy, value);

  if (kind === "array") {
    for (const key of Reflect.ownKeys(value)) {
      if (key === "length") continue;
      const descriptor = dataDeleteAssertDescriptorValue(
        value,
        key,
        Reflect.getOwnPropertyDescriptor(value, key)
      );
      Reflect.defineProperty(copy, key, {
        ...descriptor,
        value: cloneDataDeleteValue(descriptor.value, liveToClone, cloneToLive)
      });
    }
    copy.length = value.length;
    return copy;
  }
  if (kind === "map") {
    for (const [key, item] of value.entries()) {
      copy.set(
        cloneDataDeleteValue(key, liveToClone, cloneToLive),
        cloneDataDeleteValue(item, liveToClone, cloneToLive)
      );
    }
    return copy;
  }
  if (kind === "set") {
    for (const item of value.values()) {
      copy.add(cloneDataDeleteValue(item, liveToClone, cloneToLive));
    }
    return copy;
  }
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = dataDeleteAssertDescriptorValue(
      value,
      key,
      Reflect.getOwnPropertyDescriptor(value, key)
    );
    Reflect.defineProperty(copy, key, {
      ...descriptor,
      value: cloneDataDeleteValue(descriptor.value, liveToClone, cloneToLive)
    });
  }
  return copy;
}

function syncDataDeleteArray(target, source, materialize) {
  const sourceKeys = new Set(Reflect.ownKeys(source));
  for (const key of Reflect.ownKeys(target)) {
    if (key !== "length" && !sourceKeys.has(key)) delete target[key];
  }
  for (const key of sourceKeys) {
    if (key === "length") continue;
    const descriptor = dataDeleteAssertDescriptorValue(
      source,
      key,
      Reflect.getOwnPropertyDescriptor(source, key)
    );
    target[key] = materialize(descriptor.value);
  }
  target.length = source.length;
}

function syncDataDeleteObject(target, source, materialize) {
  const sourceKeys = new Set(Reflect.ownKeys(source));
  for (const key of Reflect.ownKeys(target)) {
    if (!sourceKeys.has(key)) delete target[key];
  }
  for (const key of sourceKeys) {
    const descriptor = dataDeleteAssertDescriptorValue(
      source,
      key,
      Reflect.getOwnPropertyDescriptor(source, key)
    );
    target[key] = materialize(descriptor.value);
  }
}

function syncDataDeleteMap(target, source, materialize) {
  const nextEntries = [];
  for (const [key, item] of source.entries()) {
    nextEntries.push([materialize(key), materialize(item)]);
  }
  const nextKeys = new Set(nextEntries.map(([key]) => key));
  for (const key of Array.from(target.keys())) {
    if (!nextKeys.has(key)) target.delete(key);
  }
  for (const [key, item] of nextEntries) target.set(key, item);
}

function syncDataDeleteSet(target, source, materialize) {
  const nextItems = [];
  for (const item of source.values()) nextItems.push(materialize(item));
  const nextSet = new Set(nextItems);
  for (const item of Array.from(target.values())) {
    if (!nextSet.has(item)) target.delete(item);
  }
  for (const item of nextItems) target.add(item);
}

function materializeDataDeleteCandidate(value, cloneToLive, memo) {
  if (!dataDeleteIsObject(value)) return value;
  const existing = memo.get(value);
  if (existing) return existing;
  const kind = dataDeleteContainerKind(value);
  if (!kind) {
    throw new Error("data-delete 原子候选包含不可落地的非纯数据对象");
  }
  const liveCounterpart = cloneToLive.get(value);
  let target;
  if (liveCounterpart && dataDeleteContainerKind(liveCounterpart) === kind) {
    target = liveCounterpart;
  } else if (kind === "array") {
    target = [];
  } else if (kind === "map") {
    target = new Map();
  } else if (kind === "set") {
    target = new Set();
  } else {
    target = Object.create(Object.getPrototypeOf(value) ?? Object.prototype);
  }
  memo.set(value, target);

  if (kind === "array") {
    syncDataDeleteArray(target, value, (item) => materializeDataDeleteCandidate(item, cloneToLive, memo));
  } else if (kind === "map") {
    syncDataDeleteMap(target, value, (item) => materializeDataDeleteCandidate(item, cloneToLive, memo));
  } else if (kind === "set") {
    syncDataDeleteSet(target, value, (item) => materializeDataDeleteCandidate(item, cloneToLive, memo));
  } else {
    syncDataDeleteObject(target, value, (item) => materializeDataDeleteCandidate(item, cloneToLive, memo));
  }
  return target;
}

class DataDeleteAtomicTransition {
  constructor(store) {
    this.store = store;
    const replica = store._createDataDeleteReplica();
    this.staging = replica.staging;
    this.cloneToLive = replica.cloneToLive;
    this.closed = false;
  }

  discard() {
    this.closed = true;
  }

  _applyToLive() {
    const memo = new WeakMap();
    const materialize = (value) => materializeDataDeleteCandidate(value, this.cloneToLive, memo);
    for (const field of DATA_DELETE_MAP_FIELDS) {
      const next = materialize(this.staging[field]);
      if (this.store[field] !== next) this.store[field] = next;
    }
    for (const field of DATA_DELETE_ARRAY_FIELDS) {
      const next = materialize(this.staging[field]);
      if (this.store[field] !== next) this.store[field] = next;
    }
    this.store.momentsState = materialize(this.staging.momentsState);
    this.store._rebuildIndexes?.();
  }

  _applyCommittedMemoryState() {
    try {
      this._applyToLive();
    } catch (cause) {
      this.store.storageCommitUnknown = true;
      const err = new ContractError(
        "STORAGE_COMMIT_UNKNOWN",
        "删号快照已发布，但内存换态失败；禁止重试覆盖，需隔离核验",
        { durability: "UNKNOWN", retry_same_key: true }
      );
      err.commitPublished = true;
      err.memory_commit_error = cause?.message || "memory commit failed";
      throw err;
    }
  }

  commit() {
    if (this.closed) {
      throw new ContractError("INVALID_ARGUMENT", "data-delete atomic transition is already closed");
    }
    this.closed = true;
    if (this.store._snapshotFlushTimer) {
      clearTimeout(this.store._snapshotFlushTimer);
      this.store._snapshotFlushTimer = null;
    }
    try {
      this.store._flushSnapshotSync({ strict: true, stateSource: this.staging });
    } catch (err) {
      if (err?.commitPublished === true) {
        // The candidate may already be durable. Adopt the same candidate in
        // memory; STORAGE_COMMIT_UNKNOWN remains a durability fence rather
        // than a rollback signal.
        try {
          this._applyToLive();
        } catch (commitErr) {
          err.memory_commit_error = commitErr?.message || "memory commit failed";
        }
      }
      throw err;
    }
    this._applyCommittedMemoryState();
  }
}

export class CloudDatabaseStore {
  constructor({
    snapshotPath = null,
    requireDurableSnapshot =
      process.env.NODE_ENV === "production" || process.env.CLOUD_REQUIRE_DURABLE_SNAPSHOT === "1",
    pricingMicropeach = DEFAULT_RESERVATION_PRICE_MICROPEACH,
    adminSsoSubjects = null,
    snapshotFs = fs,
    onPersistStage = null
  } = {}) {
    this.snapshotPath = snapshotPath;
    this.snapshotFs = snapshotFs;
    this.onPersistStage = onPersistStage;
    this.storageCommitUnknown = false;
    this.requireDurableSnapshot = Boolean(requireDurableSnapshot);
    this.pricingMicropeach = pricingMicropeach;
    this.adminSsoSubjects = new Set(
      (
        adminSsoSubjects ??
        (process.env.CLOUD_ADMIN_SSO_SUBJECTS || "").split(",")
      ).map((s) => String(s).trim()).filter(Boolean)
    );
    this.appliedMigrations = new Set();

    // Identity & Sessions
    this.users = new Map(); // id -> user
    this.userRoles = new Map(); // userId -> Set<string> — manual grants only (setUserRoles / env allowlist)
    this.userSsoRoles = new Map(); // userId -> Set<string> — recomputed from latest SSO role claim each login
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
    this.reservationAttempts = new Map(); // attemptId -> persistent execution attempt

    // Finance & Outbox
    this.reservationOrders = new Map(); // orderId -> order
    this.financeOperations = new Map(); // eventKey -> operation
    this.refundRequests = new Map(); // refundRequestId -> immutable dual-approval request
    this.outboxEvents = [];

    // Parcel Hub
    this.parcels = new Map(); // parcelId -> parcel
    this.parcelEvents = new Map(); // parcelId -> events[]
    this.parcelSourceConnections = new Map(); // connectionId -> connection
    this.parcelSyncJobs = new Map(); // jobId -> sync job

    // Plugins
    this.pluginInstallations = new Map(); // `${userId}:${pluginId}` -> installation

    // Cloud-Controlled Campus Channels, Clubs & Dynamic Content
    this.campusContent = new Map();
    this.momentsState = createDefaultHautMomentsState(); // schoolId -> { school_id, version, updated_at, bulletin, channels, clubs }

    // Community Groups (W4-01): school-scoped groups, membership periods, invites
    this.groups = new Map(); // groupId -> group
    this.groupMembers = new Map(); // memberId -> membership-period record
    this.groupInvites = new Map(); // inviteId -> invite

    // Availability & time polls (W4-02): privacy-minimized blocks and collaboration state
    this.availabilityShares = new Map(); // memberId -> TTL-bounded share metadata/tombstone
    this.busyBlocks = new Map(); // busyBlockId -> quantized time block only (never title/reason)
    this.meetingPolls = new Map(); // pollId -> deadline-bound group time poll
    this.pollOptions = new Map(); // optionId -> quantized poll time window
    this.pollVotes = new Map(); // voteId -> one vote per (poll, membership period)
    this.confirmedGroupEvents = new Map(); // confirmedEventId -> terminal group event

    // Notifications, Audit, Idempotency
    this.notifications = new Map(); // notificationId -> notification
    this.auditEvents = [];
    this.priceQuotes = new Map();
    this.idempotencyRecords = new Map(); // `${scope}|${actor}|${key}` -> { requestHash, status, body }

    this._seedDefaults();
    this.runMigrations();
    this.recoverDurabilitySync({ startup: true });
    this._loadSnapshot();
    this._rebuildIndexes();
    this.migrateAndRecoverState();
  }

  _rebuildIndexes() {
    this._idxUserByIssuerSubject = new Map();
    for (const [id, u] of this.users) {
      if (u.issuer && u.subject) this._idxUserByIssuerSubject.set(`${u.issuer}|${u.subject}`, id);
    }
    this._idxSessionByRefreshHash = new Map();
    this._idxSessionIdsByFamily = new Map();
    for (const [id, s] of this.deviceSessions) this._indexDeviceSessionRecord(id, s);
    this._idxTxnByServerState = new Map();
    for (const [id, t] of this.authTransactions) {
      if (t.serverState) this._idxTxnByServerState.set(t.serverState, id);
    }
    this._idxOrderByJob = new Map();
    for (const [id, o] of this.reservationOrders) {
      if (o.job_id) this._idxOrderByJob.set(o.job_id, id);
    }
    this._idxEventIdsByJob = new Map();
    for (const [id, ev] of this.scheduleEvents) {
      this.indexScheduleEvent(id, ev);
    }
    this._idxIdsByUser = new Map();
    this._idxAttemptIdsByJob = new Map();
    for (const [id, att] of this.reservationAttempts) {
      this.indexReservationAttempt(id, att);
    }
    for (const name of ["schoolBindings", "reservationPlans", "reservationJobs", "reservationOrders", "consents", "notifications", "reservationAttempts", "refundRequests", "groupMembers"]) {
      const byUser = new Map();
      for (const [id, rec] of this[name]) {
        const uid = rec.cloud_user_id;
        if (!uid) continue;
        if (!byUser.has(uid)) byUser.set(uid, new Set());
        byUser.get(uid).add(id);
      }
      this._idxIdsByUser.set(name, byUser);
    }
  }

  _indexDeviceSessionRecord(id, s) {
    if (s.refresh_token_hash) this._idxSessionByRefreshHash.set(s.refresh_token_hash, id);
    if (s.family_id) {
      if (!this._idxSessionIdsByFamily.has(s.family_id)) this._idxSessionIdsByFamily.set(s.family_id, new Set());
      this._idxSessionIdsByFamily.get(s.family_id).add(id);
    }
  }

  indexDeviceSession(id, s) {
    this._indexDeviceSessionRecord(id, s);
  }

  unindexDeviceSession(id, s) {
    if (s?.refresh_token_hash) this._idxSessionByRefreshHash.delete(s.refresh_token_hash);
    if (s?.family_id) this._idxSessionIdsByFamily.get(s.family_id)?.delete(id);
  }

  indexAuthTransaction(id, t) {
    if (t?.serverState) this._idxTxnByServerState.set(t.serverState, id);
  }

  unindexAuthTransaction(id, t) {
    if (t?.serverState) this._idxTxnByServerState.delete(t.serverState);
  }

  indexReservationOrder(id, o) {
    if (o?.job_id) this._idxOrderByJob.set(o.job_id, id);
  }

  indexUserScoped(collectionName, id, cloudUserId) {
    const byUser = this._idxIdsByUser.get(collectionName);
    if (!byUser || !cloudUserId) return;
    if (!byUser.has(cloudUserId)) byUser.set(cloudUserId, new Set());
    byUser.get(cloudUserId).add(id);
  }

  indexReservationAttempt(id, att) {
    if (!this._idxAttemptIdsByJob) this._idxAttemptIdsByJob = new Map();
    if (!att?.job_id) return;
    if (!this._idxAttemptIdsByJob.has(att.job_id)) this._idxAttemptIdsByJob.set(att.job_id, new Set());
    this._idxAttemptIdsByJob.get(att.job_id).add(id);
  }

  attemptsForJob(jobId) {
    if (!this._idxAttemptIdsByJob) {
      return Array.from(this.reservationAttempts.values()).filter((a) => a.job_id === jobId);
    }
    const ids = this._idxAttemptIdsByJob.get(jobId);
    if (!ids) return [];
    const out = [];
    for (const id of ids) {
      const a = this.reservationAttempts.get(id);
      if (a) out.push(a);
    }
    return out;
  }

  indexScheduleEvent(id, ev) {
    if (!this._idxEventIdsByJob) this._idxEventIdsByJob = new Map();
    if (!ev?.job_id) return;
    if (!this._idxEventIdsByJob.has(ev.job_id)) this._idxEventIdsByJob.set(ev.job_id, new Set());
    this._idxEventIdsByJob.get(ev.job_id).add(id);
  }

  eventsForJob(jobId) {
    if (!this._idxEventIdsByJob) {
      return Array.from(this.scheduleEvents.values()).filter((e) => e.job_id === jobId);
    }
    const ids = this._idxEventIdsByJob.get(jobId);
    if (!ids) return [];
    const out = [];
    for (const id of ids) {
      const ev = this.scheduleEvents.get(id);
      if (ev) out.push(ev);
    }
    return out;
  }

  recordsForUser(collectionName, cloudUserId) {
    const byUser = this._idxIdsByUser?.get(collectionName);
    if (!byUser) {
      return Array.from(this[collectionName].values()).filter((r) => r.cloud_user_id === cloudUserId);
    }
    const ids = byUser.get(cloudUserId);
    if (!ids) return [];
    const coll = this[collectionName];
    const out = [];
    for (const id of ids) {
      const r = coll.get(id);
      if (r) out.push(r);
    }
    return out;
  }

  idsForUser(collectionName, cloudUserId) {
    return this._idxIdsByUser.get(collectionName)?.get(cloudUserId) || null;
  }

  getLatestActiveConsent(cloudUserId, schoolId = DEFAULT_SCHOOL_ID, expectedAuthVersion = null) {
    const cleanSchoolId = schoolId || DEFAULT_SCHOOL_ID;
    const matching = this.recordsForUser("consents", cloudUserId).filter(
      (c) =>
        c &&
        (c.school_id || DEFAULT_SCHOOL_ID) === cleanSchoolId &&
        !c.withdrawn_at &&
        (expectedAuthVersion == null || Number(c.auth_version || 1) === Number(expectedAuthVersion))
    );
    return matching.length > 0 ? matching[matching.length - 1] : null;
  }

  getPreferredActiveSchoolBinding(
    cloudUserId,
    schoolId = DEFAULT_SCHOOL_ID,
    { studentNo = null, authVersion = null, requireCredential = false, nowMs = Date.now() } = {}
  ) {
    const cleanSchoolId = schoolId || DEFAULT_SCHOOL_ID;
    const cleanStudentNo = studentNo != null ? String(studentNo).trim() : null;
    const matching = this.recordsForUser("schoolBindings", cloudUserId).filter(
      (b) =>
        b &&
        (b.school_id || DEFAULT_SCHOOL_ID) === cleanSchoolId &&
        !b.revoked_at &&
        b.status !== "REVOKED" &&
        (cleanStudentNo == null || String(b.student_no || "").trim() === cleanStudentNo) &&
        (authVersion == null || Number(b.auth_version || 1) === Number(authVersion)) &&
        (!requireCredential || Boolean(b.credential_ref))
    );
    if (matching.length === 0) return null;
    const healthy = matching.filter((b) => {
      if (b.credential_needs_reconfirmation) return false;
      if (!b.credential_ref) return !requireCredential;
      const rec = this.encryptedCredentials.get(b.credential_ref);
      if (!rec || rec.revoked_at || rec.binding_id !== b.id) return false;
      if (rec.expires_at) {
        const expMs = Date.parse(rec.expires_at);
        if (!Number.isFinite(expMs) || expMs <= nowMs) return false;
      }
      return true;
    });
    const pool = healthy.length > 0 ? healthy : matching;
    return pool[pool.length - 1];
  }

  clearIntegrityReconfirmForBindings(bindings) {
    const CLEARABLE = new Set([
      "INTEGRITY_MISMATCH",
      "SHARED_CREDENTIAL_REF",
      "MISMATCHED_RECORD_BINDING",
      "CREDENTIAL_REF_SHARED_DETECTED"
    ]);
    for (const b of bindings || []) {
      if (!b || !b.credential_needs_reconfirmation) continue;
      if (!b.credential_reconfirm_reason || !CLEARABLE.has(b.credential_reconfirm_reason)) continue;
      const rec = b.credential_ref ? this.encryptedCredentials.get(b.credential_ref) : null;
      if (rec && rec.binding_id === b.id && !rec.revoked_at) {
        b.credential_needs_reconfirmation = false;
        b.credential_reconfirm_reason = null;
      }
    }
  }

  _loadSnapshot() {
    if (!this.snapshotPath) return;
    try {
      if (!this.snapshotFs.existsSync(this.snapshotPath)) return;
      const raw = JSON.parse(this.snapshotFs.readFileSync(this.snapshotPath, "utf8"));
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
      if (Array.isArray(raw.userSsoRoles)) {
        for (const [k, arr] of raw.userSsoRoles) {
          this.userSsoRoles.set(k, new Set(Array.isArray(arr) ? arr : []));
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
      loadMap(this.reservationAttempts, raw.reservationAttempts);
      loadMap(this.reservationOrders, raw.reservationOrders);
      loadMap(this.financeOperations, raw.financeOperations);
      loadMap(this.refundRequests, raw.refundRequests);
      loadMap(this.parcels, raw.parcels);
      loadMap(this.parcelEvents, raw.parcelEvents);
      loadMap(this.parcelSourceConnections, raw.parcelSourceConnections);
      loadMap(this.parcelSyncJobs, raw.parcelSyncJobs);
      loadMap(this.pluginInstallations, raw.pluginInstallations);
      loadMap(this.schoolIntegrations, raw.schoolIntegrations);
      loadMap(this.campusContent, raw.campusContent);
      loadMap(this.groups, raw.groups);
      loadMap(this.groupMembers, raw.groupMembers);
      loadMap(this.groupInvites, raw.groupInvites);
      loadMap(this.availabilityShares, raw.availabilityShares);
      loadMap(this.busyBlocks, raw.busyBlocks);
      loadMap(this.meetingPolls, raw.meetingPolls);
      loadMap(this.pollOptions, raw.pollOptions);
      loadMap(this.pollVotes, raw.pollVotes);
      loadMap(this.confirmedGroupEvents, raw.confirmedGroupEvents);
      if (!this.campusContent.has("haut")) {
        this.campusContent.set("haut", createDefaultHautCampusContent());
      }
      loadMap(this.notifications, raw.notifications);
      // Restore durable idempotency receipts (R5-C2); absent in legacy
      // snapshots — replaying an old retry then falls back to first-create
      // semantics with payload-hash protection, never a silent duplicate.
      loadMap(this.idempotencyRecords, raw.idempotencyRecords);
      loadMap(this.priceQuotes, raw.priceQuotes);
      if (raw.momentsState && typeof raw.momentsState === "object") {
        this.momentsState = {
          ...createDefaultHautMomentsState(),
          ...raw.momentsState
        };
      }
      if (Array.isArray(raw.outboxEvents)) this.outboxEvents = raw.outboxEvents;
      if (Array.isArray(raw.auditEvents)) {
        this.auditEvents = raw.auditEvents.slice(-500);
      }
    } catch (err) {
      if (this.requireDurableSnapshot) {
        throw new ContractError(
          "STORAGE_PERSISTENCE_FAILED",
          `Failed to load durable snapshot at ${this.snapshotPath}: ${err?.message || "corrupt snapshot"}`
        );
      }
    }
  }

  _createDataDeleteReplica() {
    const liveToClone = new WeakMap();
    const cloneToLive = new WeakMap();
    const staging = Object.create(CloudDatabaseStore.prototype);
    staging.snapshotPath = null;
    staging.snapshotFs = this.snapshotFs;
    staging.onPersistStage = null;
    staging.storageCommitUnknown = false;
    staging.requireDurableSnapshot = false;
    staging.pricingMicropeach = this.pricingMicropeach;
    staging.adminSsoSubjects = new Set(this.adminSsoSubjects || []);
    staging.appliedMigrations = new Set(this.appliedMigrations || []);
    staging._snapshotFlushTimer = null;
    staging._snapshotTmpSeq = 0;
    staging._persistFaultInject = null;
    staging.lastPersistenceError = null;
    // Inner service methods still call saveSnapshot/flushSnapshotStrictSync as
    // part of their standalone contracts. The data-delete commit unit owns the
    // single durable flush, so those calls are inert inside the isolated copy.
    staging._commitUnitDepth = 1;
    staging._dataDeleteCommitUnitActive = false;
    for (const field of DATA_DELETE_MAP_FIELDS) {
      staging[field] = cloneDataDeleteValue(this[field], liveToClone, cloneToLive);
    }
    for (const field of DATA_DELETE_ARRAY_FIELDS) {
      staging[field] = cloneDataDeleteValue(this[field], liveToClone, cloneToLive);
    }
    staging.momentsState = cloneDataDeleteValue(this.momentsState, liveToClone, cloneToLive);
    staging._rebuildIndexes();
    return { staging, cloneToLive };
  }

  saveSnapshot() {
    if (this._commitUnitDepth > 0) return;
    this.assertStorageWritable();
    if (!this.snapshotPath) return;
    if (this._snapshotFlushTimer) return;
    this._snapshotFlushTimer = setTimeout(() => {
      this._snapshotFlushTimer = null;
      try { this._flushSnapshotSync({ strict: true }); } catch (err) {
        this.lastPersistenceError = err;
      }
    }, 200);
    this._snapshotFlushTimer.unref?.();
  }

  flushSnapshotSync() {
    if (this._commitUnitDepth > 0) return;
    if (this._snapshotFlushTimer) {
      clearTimeout(this._snapshotFlushTimer);
      this._snapshotFlushTimer = null;
    }
    this._flushSnapshotSync({ strict: false });
  }

  flushSnapshotStrictSync() {
    if (this._commitUnitDepth > 0) return;
    if (this._snapshotFlushTimer) {
      clearTimeout(this._snapshotFlushTimer);
      this._snapshotFlushTimer = null;
    }
    this._flushSnapshotSync({ strict: true });
  }

  // Data-delete专用原子提交单元。通用 copy-on-write overlay 已退役：
  // 先在隔离的纯数据副本中计算完整删后世界，再把该候选序列化为单次耐久
  // 提交；只有候选成功发布后才换 live 状态。发布前故障不触碰 live，发布后
  // 故障按 commit-unknown 采用同一候选，绝不制造第三种内存状态。
  runDataDeleteAtomicCommitUnit(fn) {
    if (typeof fn !== "function") {
      throw new ContractError("INVALID_ARGUMENT", "runDataDeleteAtomicCommitUnit requires a mutation function");
    }
    if (this._dataDeleteCommitUnitActive) {
      throw new ContractError(
        "CONFLICT",
        "nested data-delete atomic commit units are rejected before any mutation executes"
      );
    }
    this.assertStorageWritable();
    this._dataDeleteCommitUnitActive = true;
    let transition;
    try {
      transition = new DataDeleteAtomicTransition(this);
    } catch (err) {
      this._dataDeleteCommitUnitActive = false;
      throw err;
    }
    let result;
    try {
      result = fn(transition.staging);
    } catch (err) {
      transition.discard();
      this._dataDeleteCommitUnitActive = false;
      throw err;
    }
    if (result && typeof result.then === "function") {
      transition.discard();
      this._dataDeleteCommitUnitActive = false;
      try { result.then(() => {}, () => {}); } catch { /* thenable rejection is still isolated */ }
      throw new ContractError(
        "INVALID_ARGUMENT",
        "data-delete atomic mutations must be synchronous; nested or returned thenables are rejected"
      );
    }
    try {
      transition.commit();
      return result;
    } finally {
      this._dataDeleteCommitUnitActive = false;
    }
  }

  // Compatibility fence for the removed generic transaction overlay. It must
  // never execute caller code: an async continuation captured before removal
  // cannot be allowed to write into live state half-committed.
  runAtomicCommitUnit() {
    throw new ContractError(
      "INVALID_ARGUMENT",
      "generic copy-on-write atomic commit units are retired; use the dedicated data-delete atomic path"
    );
  }

  pruneAuthEphemera(nowMs = Date.now()) {
    for (const [k, t] of this.authTransactions) {
      if (t.status === "COMPLETED" || nowMs > t.expiresAtMs + 3600_000) {
        this.unindexAuthTransaction?.(k, t);
        this.authTransactions.delete(k);
      }
    }
    for (const [k, t] of this.exchangeTickets) {
      if (t.consumedAtMs !== null || nowMs > t.expiresAtMs) {
        this.exchangeTickets.delete(k);
      }
    }
    for (const [k, s] of this.deviceSessions) {
      if (new Date(s.expires_at).getTime() + 7 * 86400_000 < nowMs) {
        this.unindexDeviceSession?.(k, s);
        this.deviceSessions.delete(k);
      }
    }
  }

  _persistStage(stage) {
    this.onPersistStage?.(stage);
    if (this._persistFaultInject === stage) {
      const err = new Error(`测试注入存储故障：${stage}`);
      err.persistStage = stage;
      throw err;
    }
  }

  assertStorageWritable() {
    if (this.storageCommitUnknown) {
      throw new ContractError("STORAGE_COMMIT_UNKNOWN", "快照耐久性待核验，已暂停写入；请保留原幂等键和请求，稍后重试", {
        durability: "UNKNOWN", retry_same_key: true
      });
    }
  }

  _syncSnapshotDirectory(stage = "dir_fsync") {
    const io = this.snapshotFs;
    this._persistStage("dir_open");
    const fd = io.openSync(path.dirname(this.snapshotPath), "r");
    try {
      this._persistStage(stage);
      io.fsyncSync(fd);
    } finally { io.closeSync(fd); }
  }

  _validateCommitUnit(raw) {
    const plans = new Map(raw.reservationPlans || []);
    const jobs = new Map(raw.reservationJobs || []);
    const events = new Map(raw.scheduleEvents || []);
    const quotes = new Map(raw.priceQuotes || []);
    const consumed = new Set();
    for (const plan of plans.values()) {
      if (!plan.accepted_quote_id) continue;
      if (quotes.has(plan.accepted_quote_id) || consumed.has(plan.accepted_quote_id)) {
        throw new Error("报价消费与计划快照不一致");
      }
      consumed.add(plan.accepted_quote_id);
    }
    for (const [, receipt] of raw.idempotencyRecords || []) {
      // 其他业务的回执保持兼容；预约回执必须指向同一快照内的完整提交单元。
      const d = receipt.data;
      if (!d?.plan_id || !d?.job_id) continue;
      if (!plans.has(d.plan_id) || jobs.get(d.job_id)?.plan_id !== d.plan_id ||
          !Array.isArray(d.schedule_events) || d.schedule_events.some(e => events.get(e.id)?.job_id !== d.job_id)) {
        throw new Error("预约幂等回执与计划、任务、事件不一致");
      }
    }

    const groups = new Map(raw.groups || []);
    for (const [, member] of raw.groupMembers || []) {
      const group = groups.get(member?.group_id);
      if (!group || group.school_id !== member.school_id) {
        throw new Error("群组成员快照与学校作用域不一致");
      }
    }
    for (const [, invite] of raw.groupInvites || []) {
      const group = groups.get(invite?.group_id);
      if (!group || group.school_id !== invite.school_id) {
        throw new Error("群组邀请快照与学校作用域不一致");
      }
    }

    const members = new Map(raw.groupMembers || []);
    const shares = new Map(raw.availabilityShares || []);
    const polls = new Map(raw.meetingPolls || []);
    const options = new Map(raw.pollOptions || []);
    const quantized = (row) => {
      const start = Date.parse(row?.start_at);
      const end = Date.parse(row?.end_at);
      return Number.isFinite(start) && Number.isFinite(end) &&
        end > start && end - start >= 1_800_000 &&
        start % 1_800_000 === 0 && end % 1_800_000 === 0;
    };
    for (const [, share] of shares) {
      const member = members.get(share?.member_id);
      const group = groups.get(share?.group_id);
      if (!member || member.group_id !== share.group_id || member.school_id !== share.school_id) {
        throw new Error("忙闲共享快照与成员作用域不一致");
      }
      if (!group || group.school_id !== share.school_id) {
        throw new Error("忙闲共享快照与学校作用域不一致");
      }
    }
    let activeShareBlockCount = 0;
    for (const [, block] of raw.busyBlocks || []) {
      const share = shares.get(block?.member_id);
      if (!share || share.group_id !== block.group_id || share.school_id !== block.school_id) {
        throw new Error("忙闲块快照与共享作用域不一致");
      }
      if (!quantized(block)) {
        throw new Error("忙闲块快照违反 30 分钟量化约束");
      }
      if (share.status !== "ACTIVE") {
        throw new Error("撤回或过期忙闲共享仍保留原始时间块");
      }
      activeShareBlockCount += 1;
    }
    for (const [, poll] of polls) {
      const group = groups.get(poll?.group_id);
      if (!group || group.school_id !== poll.school_id) {
        throw new Error("投票快照与学校作用域不一致");
      }
    }
    for (const [, option] of options) {
      const poll = polls.get(option?.poll_id);
      if (!poll || !quantized(option)) {
        throw new Error("投票选项快照与投票或量化约束不一致");
      }
    }
    for (const [, vote] of raw.pollVotes || []) {
      const poll = polls.get(vote?.poll_id);
      const option = options.get(vote?.option_id);
      const member = members.get(vote?.member_id);
      if (!poll || poll.group_id !== vote.group_id || poll.school_id !== vote.school_id) {
        throw new Error("投票表决快照与投票作用域不一致");
      }
      if (!option || option.poll_id !== vote.poll_id) {
        throw new Error("投票表决快照与选项不一致");
      }
      if (!member || member.group_id !== vote.group_id || member.school_id !== vote.school_id) {
        throw new Error("投票表决快照与成员作用域不一致");
      }
    }
    for (const [, confirmed] of raw.confirmedGroupEvents || []) {
      const poll = polls.get(confirmed?.poll_id);
      const option = options.get(confirmed?.option_id);
      if (!poll || poll.group_id !== confirmed.group_id || poll.school_id !== confirmed.school_id) {
        throw new Error("确认事件快照与投票作用域不一致");
      }
      if (!option || option.poll_id !== confirmed.poll_id || !quantized(confirmed)) {
        throw new Error("确认事件快照与选项或量化约束不一致");
      }
    }
    void activeShareBlockCount;
  }

  recoverDurabilitySync({ startup = false } = {}) {
    if (!this.snapshotPath) return;
    const io = this.snapshotFs;
    const intentPath = `${this.snapshotPath}.intent`;
    if (!startup && !this.storageCommitUnknown) return;
    try {
      const intent = io.existsSync(intentPath) ? JSON.parse(io.readFileSync(intentPath, "utf8")) : null;
      const bytes = io.existsSync(this.snapshotPath) ? io.readFileSync(this.snapshotPath) : null;
      const digest = bytes ? crypto.createHash("sha256").update(bytes).digest("hex") : null;
      if (!startup && this._unknownSnapshotHash !== undefined && digest !== this._unknownSnapshotHash) {
        throw new Error("已发布快照在恢复前被替换或丢失");
      }
      if (intent && (intent.version !== 1 || !intent.nextHash ||
          (digest !== intent.nextHash && digest !== intent.previousHash))) {
        throw new Error("快照与提交意图摘要不符，必须隔离并人工核验");
      }
      if (bytes) {
        this._validateCommitUnit(JSON.parse(bytes.toString("utf8")));
        const fd = io.openSync(this.snapshotPath, "r");
        try { this._persistStage("recovery_file_fsync"); io.fsyncSync(fd); }
        finally { io.closeSync(fd); }
      }
      if (intent || bytes) this._syncSnapshotDirectory();
      if (intent) {
        io.unlinkSync(intentPath);
        this._syncSnapshotDirectory("intent_clear_fsync");
      }
      this.storageCommitUnknown = false;
      this._unknownSnapshotHash = undefined;
      this.lastPersistenceError = null;
    } catch (cause) {
      this.storageCommitUnknown = true;
      throw new ContractError("STORAGE_COMMIT_UNKNOWN", "无法确认快照耐久性，保持隔离；禁止换键重建或覆盖快照", {
        durability: "UNKNOWN", retry_same_key: true, reason: cause.message
      });
    }
  }

  _flushSnapshotSync({ strict = false, stateSource = null } = {}) {
    this.assertStorageWritable();
    const source = stateSource || this;
    if (!this.snapshotPath) {
      if (strict && this.requireDurableSnapshot) {
        throw new ContractError(
          "STORAGE_PERSISTENCE_FAILED",
          "Durable snapshotPath is required to persist state mutation (fail-closed)"
        );
      }
      if (!this.requireDurableSnapshot) {
        for (const p of source.reservationPlans.values()) {
          if (p?._stopPersistencePending) delete p._stopPersistencePending;
        }
        for (const j of source.reservationJobs.values()) {
          if (j?._stopPersistencePending) delete j._stopPersistencePending;
        }
      }
      return;
    }
    source.pruneAuthEphemera();
    let tmp = null;
    let published = false;
    let intentWritten = false;
    let previousHash = null;
    const io = this.snapshotFs;
    const intentPath = `${this.snapshotPath}.intent`;
    try {
      const dir = path.dirname(this.snapshotPath);
      if (!io.existsSync(dir)) {
        const missing = [];
        for (let cursor = dir; !io.existsSync(cursor); cursor = path.dirname(cursor)) {
          missing.push(cursor);
          if (path.dirname(cursor) === cursor) throw new Error("存储根目录不可用");
        }
        io.mkdirSync(dir, { recursive: true });
        // 新建目录本身也必须在各级父目录中耐久，不能只同步最深一层。
        for (const created of missing.reverse()) {
          const parentFd = io.openSync(path.dirname(created), "r");
          try { this._persistStage("mkdir_parent_fsync"); io.fsyncSync(parentFd); }
          finally { io.closeSync(parentFd); }
        }
      }
      const serializeRecord = ([k, v]) => {
        if (v && typeof v === "object" && "_stopPersistencePending" in v) {
          const { _stopPersistencePending, ...rest } = v;
          return [k, rest];
        }
        return [k, v];
      };
      const data = {
        storage_protocol: 2,
        users: Array.from(source.users.entries()),
        userRoles: Array.from(source.userRoles.entries()).map(([k, set]) => [k, Array.from(set)]),
        userSsoRoles: Array.from(source.userSsoRoles.entries()).map(([k, set]) => [k, Array.from(set)]),
        authTransactions: Array.from(source.authTransactions.entries()).slice(-200),
        exchangeTickets: Array.from(source.exchangeTickets.entries()).slice(-200),
        deviceSessions: Array.from(source.deviceSessions.entries()),
        schoolBindings: Array.from(source.schoolBindings.entries()),
        encryptedCredentials: Array.from(source.encryptedCredentials.entries()),
        consents: Array.from(source.consents.entries()),
        reservationPlans: Array.from(source.reservationPlans.entries()).map(serializeRecord),
        reservationJobs: Array.from(source.reservationJobs.entries()).map(serializeRecord),
        scheduleEvents: Array.from(source.scheduleEvents.entries()),
        schoolReservations: Array.from(source.schoolReservations.entries()),
        reservationAttempts: Array.from(source.reservationAttempts.entries()),
        reservationOrders: Array.from(source.reservationOrders.entries()),
        financeOperations: Array.from(source.financeOperations.entries()),
        refundRequests: Array.from(source.refundRequests.entries()),
        parcels: Array.from(source.parcels.entries()),
        parcelEvents: Array.from(source.parcelEvents.entries()),
        parcelSourceConnections: Array.from(source.parcelSourceConnections.entries()),
        parcelSyncJobs: Array.from(source.parcelSyncJobs.entries()),
        pluginInstallations: Array.from(source.pluginInstallations.entries()),
        schoolIntegrations: Array.from(source.schoolIntegrations.entries()),
        campusContent: Array.from(source.campusContent.entries()),
        groups: Array.from(source.groups.entries()),
        groupMembers: Array.from(source.groupMembers.entries()),
        groupInvites: Array.from(source.groupInvites.entries()),
        availabilityShares: Array.from(source.availabilityShares.entries()),
        busyBlocks: Array.from(source.busyBlocks.entries()),
        meetingPolls: Array.from(source.meetingPolls.entries()),
        pollOptions: Array.from(source.pollOptions.entries()),
        pollVotes: Array.from(source.pollVotes.entries()),
        confirmedGroupEvents: Array.from(source.confirmedGroupEvents.entries()),
        momentsState: source.momentsState,
        notifications: Array.from(source.notifications.entries()),
        // Durable idempotency receipts (R5-C2): a created plan must replay its
        // original result after restart — never a duplicate, never lost.
        idempotencyRecords: Array.from(source.idempotencyRecords.entries()),
        priceQuotes: Array.from(source.priceQuotes.entries()),
        outboxEvents: source.outboxEvents,
        auditEvents: source.auditEvents.slice(-500)
      };
      this._snapshotTmpSeq = (this._snapshotTmpSeq || 0) + 1;
      tmp = `${this.snapshotPath}.tmp.${process.pid}.${this._snapshotTmpSeq}`;
      const serialized = JSON.stringify(data);
      const nextHash = crypto.createHash("sha256").update(serialized).digest("hex");
      previousHash = io.existsSync(this.snapshotPath)
        ? crypto.createHash("sha256").update(io.readFileSync(this.snapshotPath)).digest("hex") : null;
      this._validateCommitUnit(data);
      let stage = "tmp_open";
      try {
        this._persistStage(stage);
        const fd = io.openSync(tmp, "wx", 0o600);
        try {
          stage = "tmp_write"; this._persistStage(stage);
          io.writeFileSync(fd, serialized, "utf8");
          stage = "tmp_fsync"; this._persistStage(stage); io.fsyncSync(fd);
        } finally { io.closeSync(fd); }
        // 意图先落盘，发布后任何失败均保留候选状态，不能回滚到旧内存。
        stage = "intent_write"; this._persistStage(stage);
        const intentFd = io.openSync(intentPath, "wx", 0o600);
        intentWritten = true;
        try {
          io.writeFileSync(intentFd, JSON.stringify({ version: 1, nextHash, previousHash }));
          stage = "intent_fsync"; this._persistStage(stage); io.fsyncSync(intentFd);
        } finally { io.closeSync(intentFd); }
        stage = "intent_dir_fsync";
        this._syncSnapshotDirectory(stage);
        stage = "rename"; this._persistStage(stage);
        io.renameSync(tmp, this.snapshotPath);
        published = true;
        this._unknownSnapshotHash = nextHash;
        stage = "post_rename"; this._persistStage(stage);
        stage = "dir_fsync"; this._syncSnapshotDirectory();
        stage = "verify_content"; this._persistStage(stage);
        if (crypto.createHash("sha256").update(io.readFileSync(this.snapshotPath)).digest("hex") !== nextHash) {
          throw new Error("已发布快照内容摘要不一致");
        }
        stage = "intent_clear"; this._persistStage(stage); io.unlinkSync(intentPath);
        stage = "intent_clear_fsync"; this._syncSnapshotDirectory(stage);
      } catch (err) { err.persistStage = err.persistStage || stage; throw err; }
      this._unknownSnapshotHash = undefined;
      for (const p of source.reservationPlans.values()) {
        if (p?._stopPersistencePending) delete p._stopPersistencePending;
      }
      for (const j of source.reservationJobs.values()) {
        if (j?._stopPersistencePending) delete j._stopPersistencePending;
      }
    } catch (err) {
      if (tmp) {
        try { if (io.existsSync(tmp)) io.unlinkSync(tmp); } catch { /* 孤立临时文件不参与恢复 */ }
      }
      if (!published && intentWritten) {
        try { io.unlinkSync(intentPath); this._syncSnapshotDirectory("intent_clear_fsync"); }
        catch { this.storageCommitUnknown = true; this._unknownSnapshotHash = previousHash; }
      }
      if (published) this.storageCommitUnknown = true;
      const ce = new ContractError(
        published ? "STORAGE_COMMIT_UNKNOWN" : "STORAGE_PERSISTENCE_FAILED",
        published ? "快照已发布，耐久性待核验；保留原幂等键重试" : `快照未发布：${err.message}`,
        { durability: published ? "UNKNOWN" : "NOT_COMMITTED", retry_same_key: true }
      );
      ce.persistStage = err.persistStage || null;
      ce.commitPublished = published;
      this.lastPersistenceError = ce;
      if (strict || published) throw ce;
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
    const key = String(schoolId || "haut").trim().toLowerCase();
    if (!/^[a-z0-9_-]{2,32}$/.test(key)) {
      throw new ContractError("BAD_REQUEST", `Invalid school_id: ${key}`);
    }
    if (!this.campusContent.has(key)) {
      if (!this.schoolIntegrations.has(key) && key !== "haut") {
        throw new ContractError("NOT_FOUND", `Campus content not found for school_id: ${key}`);
      }
      this.campusContent.set(key, {
        ...createDefaultHautCampusContent(),
        school_id: key
      });
    }
    const raw = this.campusContent.get(key);
    if (!Array.isArray(raw.competitions) || raw.competitions.length === 0) {
      raw.competitions = createDefaultHautCompetitions();
      raw.version = Math.max(Number(raw.version || 2), 3);
    }
    if (Array.isArray(raw.clubs)) {
      for (const cl of raw.clubs) {
        if (
          cl.id === "club_partner_computer_service" &&
          (!cl.activity_venue || /8号(教学)?楼/.test(String(cl.activity_venue)))
        ) {
          cl.activity_venue = "莲花街校区 学生宿舍F01 W111";
          cl.campus_name = "莲花街校区";
          cl.building_name = "学生宿舍F01";
          cl.room_number = "W111";
        }
      }
    }
    const officialChannels = raw.official_channels && typeof raw.official_channels === "object"
      ? raw.official_channels
      : {
          user_feedback_qq_group: "",
          user_feedback_channel_url: "https://github.com/yellowpeachxgp/day-in-school/issues",
          wechat_official_account_name: "",
          wechat_official_account_status: "PENDING"
        };
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
    const competitions = (Array.isArray(raw.competitions) ? raw.competitions : [])
      .filter((cp) => includeDisabled || cp.enabled !== false)
      .slice()
      .sort(sortFn);
    return {
      school_id: raw.school_id || key,
      version: Number(raw.version || 3),
      updated_at: raw.updated_at || new Date().toISOString(),
      updated_by: raw.updated_by || "system",
      bulletin: raw.bulletin || {
        enabled: false,
        title: "",
        content: "",
        tag: "云端同步",
        action_url: ""
      },
      official_channels: officialChannels,
      channels,
      clubs,
      competitions
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

  upsertCampusCompetition(schoolId = "haut", compInput = {}, actorRef = "admin") {
    const key = String(schoolId || "haut").toLowerCase();
    const current = this.getCampusContent(key, { includeDisabled: true });
    const nowIso = new Date().toISOString();
    const id = String(compInput.id || `comp_${Date.now()}`).trim();
    const existingIdx = current.competitions.findIndex((c) => c.id === id);
    const prev = existingIdx >= 0 ? current.competitions[existingIdx] : {};
    const rawCat = String(compInput.category ?? prev.category ?? "INNOVATION_ENTREPRENEURSHIP").trim().toUpperCase();
    const category = COMPETITION_CATEGORY_LABELS[rawCat] ? rawCat : "INNOVATION_ENTREPRENEURSHIP";
    const tracksRaw = compInput.recommended_major_tracks ?? compInput.recommendedMajorTracks ?? prev.recommended_major_tracks ?? ["ALL_MAJORS"];
    const recommended_major_tracks = Array.isArray(tracksRaw)
      ? tracksRaw.map((x) => String(x).trim().toUpperCase()).filter(Boolean)
      : String(tracksRaw || "ALL_MAJORS")
          .split(/[,，、|/]/)
          .map((x) => x.trim().toUpperCase())
          .filter(Boolean);
    const tagsRaw = compInput.interest_tags ?? compInput.interestTags ?? prev.interest_tags ?? [];
    const interest_tags = Array.isArray(tagsRaw)
      ? tagsRaw.map((x) => String(x).trim()).filter(Boolean)
      : String(tagsRaw || "")
          .split(/[,，、|/]/)
          .map((x) => x.trim())
          .filter(Boolean);

    const title = String(compInput.title ?? compInput.name ?? prev.title ?? "").trim();
    if (!title) {
      throw new ContractError("BAD_REQUEST", "竞赛名称不能为空");
    }
    const nextItem = {
      id,
      title,
      short_title: String(compInput.short_title ?? compInput.shortTitle ?? prev.short_title ?? title).trim() || title,
      tier_badge: String(compInput.tier_badge ?? compInput.tierBadge ?? prev.tier_badge ?? "教育部白名单 A 类赛事").trim() || "教育部白名单 A 类赛事",
      category,
      category_label: COMPETITION_CATEGORY_LABELS[category] || "创新创业与双创孵化",
      recommended_major_tracks: recommended_major_tracks.length > 0 ? recommended_major_tracks : ["ALL_MAJORS"],
      interest_tags,
      organizer: String(compInput.organizer ?? prev.organizer ?? "教育部/全国竞赛组委会").trim(),
      haut_host_college: String(compInput.haut_host_college ?? compInput.hautHostCollege ?? prev.haut_host_college ?? "创新创业学院").trim(),
      registration_window: String(compInput.registration_window ?? compInput.registrationWindow ?? prev.registration_window ?? "关注赛事官网通知").trim(),
      team_mode: String(compInput.team_mode ?? compInput.teamMode ?? prev.team_mode ?? "1–5人组队").trim(),
      difficulty_label: String(compInput.difficulty_label ?? compInput.difficultyLabel ?? prev.difficulty_label ?? "大一友好").trim(),
      beginner_friendly: compInput.beginner_friendly !== undefined ? Boolean(compInput.beginner_friendly) : prev.beginner_friendly !== false,
      summary: String(compInput.summary ?? prev.summary ?? "").trim(),
      skill_roadmap: String(compInput.skill_roadmap ?? compInput.skillRoadmap ?? prev.skill_roadmap ?? "").trim(),
      official_website_url: this.sanitizeSafeHttpsUrl(
        compInput.official_website_url ?? compInput.officialWebsiteUrl ?? prev.official_website_url ?? "",
        "https://cy.ncss.cn"
      ),
      partner_club_id: String(compInput.partner_club_id ?? compInput.partnerClubId ?? prev.partner_club_id ?? "").trim(),
      partner_club_name: String(compInput.partner_club_name ?? compInput.partnerClubName ?? prev.partner_club_name ?? "").trim(),
      partner_club_qq: String(compInput.partner_club_qq ?? compInput.partnerClubQq ?? prev.partner_club_qq ?? "").trim(),
      enabled: compInput.enabled !== undefined ? Boolean(compInput.enabled) : prev.enabled !== false,
      pinned: compInput.pinned !== undefined ? Boolean(compInput.pinned) : Boolean(prev.pinned),
      sort_order: Number(compInput.sort_order ?? compInput.sortOrder ?? prev.sort_order ?? (current.competitions.length + 1) * 10) || 100,
      updated_at: nowIso
    };
    if (existingIdx >= 0) {
      current.competitions[existingIdx] = nextItem;
    } else {
      current.competitions.push(nextItem);
    }
    current.version = Number(current.version || 2) + 1;
    current.updated_at = nowIso;
    current.updated_by = actorRef;
    this.campusContent.set(key, current);
    this.recordAudit({
      actor_kind: "ADMIN",
      actor_ref: actorRef,
      action: "UPSERT_CAMPUS_COMPETITION",
      resource_kind: "campus_competition",
      resource_ref: id,
      outcome: "SUCCESS",
      detail: { title: nextItem.title, official_website_url: nextItem.official_website_url }
    });
    return this.getCampusContent(key, { includeDisabled: true });
  }

  deleteCampusCompetition(schoolId = "haut", compId, actorRef = "admin") {
    const key = String(schoolId || "haut").toLowerCase();
    const current = this.getCampusContent(key, { includeDisabled: true });
    current.competitions = current.competitions.filter((c) => c.id !== compId);
    current.version = Number(current.version || 2) + 1;
    current.updated_at = new Date().toISOString();
    current.updated_by = actorRef;
    this.campusContent.set(key, current);
    this.recordAudit({
      actor_kind: "ADMIN",
      actor_ref: actorRef,
      action: "DELETE_CAMPUS_COMPETITION",
      resource_kind: "campus_competition",
      resource_ref: String(compId || ""),
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
    const existingId = this._idxUserByIssuerSubject?.get(`${issuer}|${subject}`);
    const existing = existingId ? this.users.get(existingId) : null;
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
    this._idxUserByIssuerSubject?.set(`${issuer}|${subject}`, id);
    if (!this.userRoles.has(id)) {
      this.userRoles.set(id, new Set(["USER"]));
    }
    this._syncAdminRoleIfEligible(user);
    this.saveSnapshot();
    return user;
  }

  _syncAdminRoleIfEligible(user) {
    if (!user) return;
    // SSO-derived roles are recomputed on every login from the fresh role claim so
    // tenant-side demotion takes effect on next sign-in (owner > admin > member).
    const role = String(user.role || "").toLowerCase();
    const mapped = role === "owner" ? SSO_OWNER_ROLES : role === "admin" ? SSO_ADMIN_ROLES : EMPTY_ROLE_SET;
    this.userSsoRoles.set(user.id, new Set(mapped));
    // Env subject allowlist is a manual break-glass grant, intentionally outside
    // the SSO recompute so it survives claim changes until the config is removed.
    if (this.adminSsoSubjects.has(user.subject)) {
      const roles = this.userRoles.get(user.id) || new Set(["USER"]);
      for (const r of SSO_OWNER_ROLES) roles.add(r);
      this.userRoles.set(user.id, roles);
    }
  }

  getUserRoles(cloudUserId) {
    const merged = new Set(this.userRoles.get(cloudUserId) || []);
    for (const r of this.userSsoRoles.get(cloudUserId) || []) merged.add(r);
    return merged.size ? Array.from(merged) : ["USER"];
  }

  hasAdminAccess(cloudUserId) {
    const merged = new Set(this.userRoles.get(cloudUserId) || []);
    for (const r of this.userSsoRoles.get(cloudUserId) || []) merged.add(r);
    return merged.has("ADMIN") || merged.has("PLATFORM_OWNER");
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
    if (this.auditEvents.length > 2000) {
      this.auditEvents.splice(0, this.auditEvents.length - 2000);
    }
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
    this.indexUserScoped?.("notifications", id, n.cloud_user_id);
    this.saveSnapshot();
    return n;
  }

  migrateAndRecoverState(nowMs = Date.now()) {
    const ts = new Date(nowMs).toISOString();
    let mutated = false;

    // 1. Recover in-flight attempts that crashed in DISPATCH_INTENT / DISPATCHED -> RESULT_UNKNOWN (never blind-retry!)
    for (const att of this.reservationAttempts.values()) {
      if (att.status === "DISPATCH_INTENT" || att.status === "DISPATCHED") {
        att.status = "RESULT_UNKNOWN";
        att.completed_at = att.completed_at || ts;
        mutated = true;
      }
    }

    // 1b. Detect — never propagate — shared/mismatched credential_ref across
    // same-student bindings. Each binding must own an independently encrypted
    // credential record whose AAD is bound to ITS OWN id: a ref pointing at a
    // record bound to another binding_id can never satisfy the access-permit
    // scope check at decrypt time. Copying the "best" ref across siblings (the
    // previous behaviour) silently granted the record owner's credential scope
    // and made cross-binding isolation unauditable. Non-owner holders are now
    // flagged credential_needs_reconfirmation for the controlled re-key tool /
    // user re-bind instead of being given a ref they cannot use.
    const refHolders = new Map(); // credential_ref -> [binding]
    for (const b of this.schoolBindings.values()) {
      if (!b || !b.credential_ref) continue;
      if (!refHolders.has(b.credential_ref)) refHolders.set(b.credential_ref, []);
      refHolders.get(b.credential_ref).push(b);
      const rec = this.encryptedCredentials.get(b.credential_ref);
      if (rec && rec.binding_id !== b.id && !b.credential_needs_reconfirmation) {
        b.credential_needs_reconfirmation = true;
        // Structured cause: the bug produced a credential_ref pointing at a
        // record bound to a DIFFERENT binding — an integrity defect, provably
        // re-keyable. Authorization reasons (risk/revoked/reverify) are set
        // elsewhere and must never be cleared by migration.
        b.credential_reconfirm_reason = "INTEGRITY_MISMATCH";
        mutated = true;
      }
    }
    for (const [ref, holders] of refHolders) {
      if (holders.length <= 1) continue;
      const rec = this.encryptedCredentials.get(ref);
      this.recordAudit({
        actor_kind: "SYSTEM",
        actor_ref: "migrateAndRecoverState",
        action: "CREDENTIAL_REF_SHARED_DETECTED",
        resource_kind: "encrypted_credential",
        resource_ref: ref,
        outcome: "NEEDS_RECONFIRMATION",
        detail: {
          binding_ids: holders.map((h) => h.id),
          record_binding_id: rec?.binding_id ?? null
        }
      });
    }

    // 2. Migrate legacy plans lacking verifiable authorization provenance -> NEEDS_RECONFIRMATION
    // Strictly forbid guessing auth_version or consent_id from current user/binding/consent state!
    for (const p of this.reservationPlans.values()) {
      const user = this.users.get(p.cloud_user_id);
      const userAuthVer = Number(user?.auth_version || 1);
      const bind = p.school_binding_id ? this.schoolBindings.get(p.school_binding_id) : null;
      const consent = p.consent_id ? this.consents.get(p.consent_id) : null;
      if (
        !p.student_no &&
        bind &&
        bind.cloud_user_id === p.cloud_user_id &&
        String(bind.student_no || "").trim()
      ) {
        p.student_no = String(bind.student_no).trim();
        mutated = true;
      }
      const hasVerifiableOrigin =
        Boolean(p.school_binding_id) &&
        Boolean(bind) &&
        !bind.revoked_at &&
        bind.status === "DELEGATED_ACTIVE" &&
        bind.cloud_user_id === p.cloud_user_id &&
        Boolean(String(bind.student_no || "").trim()) &&
        Boolean(p.consent_id) &&
        Boolean(consent) &&
        !consent.withdrawn_at &&
        consent.cloud_user_id === p.cloud_user_id &&
        (!bind.consent_id || bind.consent_id === consent.id) &&
        Number.isInteger(Number(p.auth_version)) &&
        Number(p.auth_version) > 0 &&
        Number(p.auth_version) === userAuthVer &&
        Number.isInteger(Number(bind.auth_version)) &&
        Number(bind.auth_version) === Number(p.auth_version) &&
        Number.isInteger(Number(consent.auth_version)) &&
        Number(consent.auth_version) === Number(p.auth_version);

      if (!hasVerifiableOrigin) {
        if (p.user_intent_state === "REVOKED" || p.user_intent_state === "STOP_REQUESTED") {
          if (p.enabled !== false) {
            p.enabled = false;
            mutated = true;
          }
        } else if (p.user_intent_state !== "NEEDS_RECONFIRMATION" || p.enabled !== false) {
          p.enabled = false;
          p.user_intent_state = "NEEDS_RECONFIRMATION";
          p.migration_status = "NEEDS_RECONFIRMATION";
          mutated = true;
        }
      } else if (!p.user_intent_state) {
        p.user_intent_state = p.enabled === false ? "STOP_REQUESTED" : "ACTIVE";
        mutated = true;
      }
    }

    // 2b. Realign active bindings whose consent_id was pinned to an earlier
    // un-withdrawn consent of the same (user, school, auth_version) onto the
    // canonical latest active consent so new plans pass _isJobAuthorizationCurrent.
    for (const b of this.schoolBindings.values()) {
      if (!b || b.revoked_at || b.status === "REVOKED") continue;
      const user = this.users.get(b.cloud_user_id);
      const userAuthVer = Number(user?.auth_version || 1);
      if (Number(b.auth_version || 1) !== userAuthVer) continue;
      const schoolId = b.school_id || DEFAULT_SCHOOL_ID;
      const latestConsent = this.getLatestActiveConsent(b.cloud_user_id, schoolId, userAuthVer);
      if (!latestConsent || b.consent_id === latestConsent.id) continue;
      const curConsent = b.consent_id ? this.consents.get(b.consent_id) : null;
      const isSupersededSameGenerationConsent =
        !curConsent ||
        (!curConsent.withdrawn_at &&
          curConsent.cloud_user_id === b.cloud_user_id &&
          (curConsent.school_id || DEFAULT_SCHOOL_ID) === schoolId &&
          Number(curConsent.auth_version || 1) === userAuthVer);
      if (!isSupersededSameGenerationConsent) continue;
      const hasEnabledPlanUsingCurrentConsent =
        Boolean(curConsent) &&
        Array.from(this.reservationPlans.values()).some(
          (p) =>
            p &&
            p.enabled === true &&
            p.school_binding_id === b.id &&
            p.consent_id === curConsent.id
        );
      if (!hasEnabledPlanUsingCurrentConsent) {
        b.consent_id = latestConsent.id;
        mutated = true;
      }
    }

    // 3. Backfill three-axis state on jobs and recover in-flight / legacy jobs
    for (const j of this.reservationJobs.values()) {
      const p = j.plan_id ? this.reservationPlans.get(j.plan_id) : null;
      const jBind =
        (j.school_binding_id && this.schoolBindings.get(j.school_binding_id)) ||
        (p?.school_binding_id && this.schoolBindings.get(p.school_binding_id)) ||
        null;
      const inferredSno = String(p?.student_no || jBind?.student_no || "").trim();
      if (!j.student_no && inferredSno) {
        j.student_no = inferredSno;
        mutated = true;
      }
      if (j.auth_version === undefined && p?.auth_version !== undefined) {
        j.auth_version = Number(p.auth_version);
        mutated = true;
      }
      const sr = this.schoolReservations.get(j.id);
      const jobAttempts = this.attemptsForJob(j.id);
      const hadDispatchedAttempt =
        jobAttempts.length > 0 ||
        Number(j.attempt_count || 0) > 0 ||
        j.external_execution_state === "DISPATCH_INTENT" ||
        j.external_execution_state === "RESULT_UNKNOWN" ||
        j.state === "EXECUTING" ||
        j.state === "RESULT_UNKNOWN";

      // Crash recovery: if job was left in EXECUTING or DISPATCH_INTENT, transition to RESULT_UNKNOWN
      if (j.state === "EXECUTING" || j.external_execution_state === "DISPATCH_INTENT") {
        j.state = "RESULT_UNKNOWN";
        j.external_execution_state = "RESULT_UNKNOWN";
        j.attempt_count = Math.max(Number(j.attempt_count || 0), 1);
        j.last_error_code = j.last_error_code || "CRASH_RECOVERY_RESULT_UNKNOWN";
        j.last_diagnostic_message =
          j.last_diagnostic_message || "进程恢复：预约请求可能已发出，已转入待核对状态（禁止盲目重发）";
        for (const ev of this.eventsForJob(j.id)) {
          if (ev.kind === "FIRE" && ev.generation === j.generation) {
            ev.status = "RESULT_UNKNOWN";
            ev.actual_at = ev.actual_at || ts;
          }
        }
        mutated = true;
      }

      const settledOrProtectedStates = [
        "CONFIRMED",
        "DELEGATION_STOPPED_SCHOOL_CONFIRMED",
        "SCHOOL_CANCELLED",
        "CANCEL_RESULT_UNKNOWN",
        "FAILED",
        "CANCELLED",
        "EXPIRED"
      ];

      if (p?.user_intent_state === "NEEDS_RECONFIRMATION") {
        if (
          hadDispatchedAttempt &&
          !settledOrProtectedStates.includes(j.state) &&
          j.user_intent_state !== "REVOKED" &&
          j.user_intent_state !== "STOP_REQUESTED"
        ) {
          j.state = "RESULT_UNKNOWN";
          j.user_intent_state = "NEEDS_RECONFIRMATION";
          j.external_execution_state = "RESULT_UNKNOWN";
          j.display_status = "RESULT_UNKNOWN";
          j.status_label = "结果待核对";
          mutated = true;
        } else if (
          !hadDispatchedAttempt &&
          ![...settledOrProtectedStates, "NEEDS_RECONFIRMATION"].includes(j.state) &&
          j.user_intent_state !== "REVOKED" &&
          j.user_intent_state !== "STOP_REQUESTED"
        ) {
          j.state = "NEEDS_RECONFIRMATION";
          j.user_intent_state = "NEEDS_RECONFIRMATION";
          j.external_execution_state = "NOT_DISPATCHED";
          j.display_status = "NEEDS_RECONFIRMATION";
          j.status_label = "待重新确认授权";
          j.last_diagnostic_message = "旧计划缺少可验证的授权版本来源，请重新确认授权后再启用";
          for (const ev of this.eventsForJob(j.id)) {
            if (ev.status === "ARMED") {
              ev.status = "SKIPPED_NEEDS_RECONFIRMATION";
              ev.actual_at = ts;
            }
          }
          mutated = true;
        }
      }

      if (!j.user_intent_state) {
        j.user_intent_state =
          j.state === "CANCELLED" || j.state === "REVOKED"
            ? j.last_error_code === "CONSENT_WITHDRAWN" || j.last_error_code === "BINDING_REVOKED"
              ? "REVOKED"
              : "STOP_REQUESTED"
            : "ACTIVE";
        mutated = true;
      }
      if (!j.external_execution_state) {
        j.external_execution_state =
          j.state === "CONFIRMED" ||
          j.state === "DELEGATION_STOPPED_SCHOOL_CONFIRMED" ||
          j.state === "CANCEL_RESULT_UNKNOWN" ||
          j.state === "SCHOOL_CANCELLED" ||
          sr?.official_status === "CONFIRMED" ||
          sr?.confirmed_official_status === "CONFIRMED" ||
          Boolean(sr?.external_booking_id)
            ? "SCHOOL_CONFIRMED"
            : j.state === "RESULT_UNKNOWN"
              ? "RESULT_UNKNOWN"
              : j.state === "FAILED"
                ? "SCHOOL_REJECTED"
                : "NOT_DISPATCHED";
        mutated = true;
      }
      if (
        j.school_cancellation_state === "CANCEL_IN_PROGRESS" ||
        sr?.school_cancellation_state === "CANCEL_IN_PROGRESS"
      ) {
        j.school_cancellation_state = "CANCEL_RESULT_UNKNOWN";
        j.state = "CANCEL_RESULT_UNKNOWN";
        this._preserveConfirmedEvidenceForUnknownCancel(sr, j);
        mutated = true;
      } else if (!j.school_cancellation_state) {
        j.school_cancellation_state =
          j.state === "SCHOOL_CANCELLED" ||
          sr?.official_status === "CANCELLED" ||
          sr?.official_status === "SCHOOL_CANCELLED" ||
          sr?.school_cancellation_state === "SCHOOL_CANCELLED"
            ? "SCHOOL_CANCELLED"
            : j.state === "CANCEL_RESULT_UNKNOWN" ||
                sr?.official_status === "CANCEL_RESULT_UNKNOWN" ||
                sr?.school_cancellation_state === "CANCEL_RESULT_UNKNOWN"
              ? "CANCEL_RESULT_UNKNOWN"
              : "NOT_REQUESTED";
        mutated = true;
      }
      if (
        j.school_cancellation_state === "CANCEL_RESULT_UNKNOWN" ||
        j.state === "CANCEL_RESULT_UNKNOWN" ||
        sr?.school_cancellation_state === "CANCEL_RESULT_UNKNOWN" ||
        sr?.official_status === "CANCEL_RESULT_UNKNOWN"
      ) {
        if (j.school_cancellation_state !== "SCHOOL_CANCELLED" && j.state !== "SCHOOL_CANCELLED") {
          if (j.school_cancellation_state !== "CANCEL_RESULT_UNKNOWN") {
            j.school_cancellation_state = "CANCEL_RESULT_UNKNOWN";
            mutated = true;
          }
          if (j.state !== "CANCEL_RESULT_UNKNOWN") {
            j.state = "CANCEL_RESULT_UNKNOWN";
            mutated = true;
          }
          if (
            sr &&
            (sr.official_status !== "CANCEL_RESULT_UNKNOWN" ||
              sr.school_cancellation_state !== "CANCEL_RESULT_UNKNOWN" ||
              !sr.confirmed_booking_evidence)
          ) {
            this._preserveConfirmedEvidenceForUnknownCancel(sr, j);
            mutated = true;
          }
        }
      }
      for (const att of jobAttempts) {
        if (att.external_execution_state === "DISPATCH_INTENT") {
          att.external_execution_state = "RESULT_UNKNOWN";
          att.updated_at = ts;
          mutated = true;
        }
      }
      const nextDisplay = this.computeJobDisplayStatus(j);
      const nextLabel = this.computeJobStatusLabel(j);
      if (j.display_status !== nextDisplay || j.status_label !== nextLabel) {
        j.display_status = nextDisplay;
        j.status_label = nextLabel;
        mutated = true;
      }
    }

    // 4. At-rest normalization of historical Moments posts & legacy "【私密联系发起人】" prefix comments
    if (this.momentsState && Array.isArray(this.momentsState.posts)) {
      for (const post of this.momentsState.posts) {
        if (!post || typeof post !== "object") continue;
        if (!Array.isArray(post.comments)) {
          post.comments = [];
          mutated = true;
        }
        if (!Array.isArray(post.contact_requests)) {
          post.contact_requests = [];
          mutated = true;
        }
        if (!Array.isArray(post.blocked_user_ids)) {
          post.blocked_user_ids = [];
          mutated = true;
        }
        for (const c of post.comments) {
          if (
            c &&
            typeof c === "object" &&
            String(c.content || "").trim().startsWith("【私密联系发起人】") &&
            c.is_private_to_initiator !== true
          ) {
            c.is_private_to_initiator = true;
            mutated = true;
          }
        }
      }
    }
    if (this.momentsState && Array.isArray(this.momentsState.anti_lost_tags)) {
      for (const tag of this.momentsState.anti_lost_tags) {
        if (!tag || typeof tag !== "object") continue;
        if (tag.contact_visibility !== "PUBLIC_WHEN_LOST" && tag.contact_visibility !== "PRIVATE") {
          tag.contact_visibility = "PRIVATE";
          mutated = true;
        }
        if (typeof tag.owner_declared_lost !== "boolean") {
          tag.owner_declared_lost = tag.status === "LOST";
          mutated = true;
        }
        if (tag.status === "FOUND_REPORTED" && tag.owner_declared_lost !== true) {
          tag.status = "NORMAL";
          mutated = true;
        }
      }
    }

    // 5. Legacy refund operations predating the dual-approval request model:
    // an in-flight/retryable REFUND op with no matching request record has no
    // recovery path — flag it for the read-only reconcile queue. Never
    // fabricate a request, never delete the op, never mint a new event key.
    for (const op of this.financeOperations.values()) {
      if (op.kind !== "REFUND") continue;
      if (!["IN_FLIGHT", "FAILED_RETRYABLE"].includes(op.status)) continue;
      const hasRequest =
        op.refund_request_id && this.refundRequests.get(op.refund_request_id);
      if (!hasRequest && !op.legacy_reconcile_required) {
        op.legacy_reconcile_required = true;
        mutated = true;
        this.recordAudit({
          actor_kind: "SYSTEM",
          actor_ref: "migrateAndRecoverState",
          action: "LEGACY_REFUND_NEEDS_RECONCILE",
          resource_kind: "reservation_order",
          resource_ref: op.order_id,
          outcome: "QUEUED_FOR_RECONCILE",
          detail: { event_key: op.event_key, status: op.status }
        });
      }
    }

    if (mutated) {
      this.saveSnapshot();
    }
  }

  computeJobDisplayStatus(job) {
    if (!job) return "UNKNOWN";
    const intent = job.user_intent_state || "ACTIVE";
    const exec = job.external_execution_state || "NOT_DISPATCHED";
    const cancel = job.school_cancellation_state || "NOT_REQUESTED";

    if (intent === "NEEDS_RECONFIRMATION" && exec === "NOT_DISPATCHED") {
      return "NEEDS_RECONFIRMATION";
    }
    if (cancel === "SCHOOL_CANCELLED" || job.state === "SCHOOL_CANCELLED") {
      return "SCHOOL_CANCELLED";
    }
    if (
      cancel === "CANCEL_RESULT_UNKNOWN" ||
      cancel === "CANCEL_IN_PROGRESS" ||
      job.state === "CANCEL_RESULT_UNKNOWN"
    ) {
      return "CANCEL_RESULT_UNKNOWN";
    }
    if ((intent === "REVOKED" || intent === "STOP_REQUESTED") && exec === "SCHOOL_CONFIRMED") {
      return "DELEGATION_STOPPED_SCHOOL_CONFIRMED";
    }
    if ((intent === "REVOKED" || intent === "STOP_REQUESTED") && (exec === "RESULT_UNKNOWN" || exec === "DISPATCH_INTENT")) {
      return "DELEGATION_STOPPED_RESULT_UNKNOWN";
    }
    if (intent === "REVOKED" || intent === "STOP_REQUESTED") {
      return "DELEGATION_STOPPED";
    }
    if (exec === "SCHOOL_CONFIRMED" || job.state === "CONFIRMED") {
      return "SCHOOL_CONFIRMED";
    }
    if (exec === "RESULT_UNKNOWN" || job.state === "RESULT_UNKNOWN") {
      return "RESULT_UNKNOWN";
    }
    if (exec === "SCHOOL_REJECTED" || job.state === "FAILED") {
      return "SCHOOL_REJECTED";
    }
    return job.state || "ARMED";
  }

  computeJobStatusLabel(job) {
    const ds = this.computeJobDisplayStatus(job);
    switch (ds) {
      case "NEEDS_RECONFIRMATION":
        return "待重新确认授权";
      case "SCHOOL_CANCELLED":
        return "学校已取消预约";
      case "CANCEL_RESULT_UNKNOWN":
        return "退座结果待核对";
      case "DELEGATION_STOPPED_SCHOOL_CONFIRMED":
        return "委托已停止，但学校预约已成功";
      case "DELEGATION_STOPPED_RESULT_UNKNOWN":
        return "委托已停止，结果待核对";
      case "DELEGATION_STOPPED":
        return "已停止委托";
      case "SCHOOL_CONFIRMED":
        return "学校预约成功";
      case "RESULT_UNKNOWN":
        return "结果待核对";
      case "SCHOOL_REJECTED":
        return "未抢到座位";
      case "SKIPPED_FINANCE":
        return "余额不足已跳过（未扣费）";
      case "SKIPPED_AUTH":
        return "授权失效已跳过（未扣费）";
      case "EXPIRED":
        return "已过预约窗口（未扣费）";
      case "CANCELLED":
      case "REVOKED":
        return "已停止委托";
      default:
        return "排队等待执行";
    }
  }

  syncJobDisplayStatus(job) {
    if (!job) return null;
    job.display_status = this.computeJobDisplayStatus(job);
    job.status_label = this.computeJobStatusLabel(job);
    return job;
  }

  createReservationAttempt(payload = {}) {
    const id = payload.id || crypto.randomUUID();
    const ts = payload.dispatch_intent_at || new Date().toISOString();
    const attempt = {
      id,
      job_id: payload.job_id,
      plan_id: payload.plan_id,
      cloud_user_id: payload.cloud_user_id,
      school_id: payload.school_id || DEFAULT_SCHOOL_ID,
      student_no: String(payload.student_no || "").trim(),
      binding_id: payload.binding_id,
      consent_id: payload.consent_id,
      auth_version: Number(payload.auth_version || 1),
      target_local_date: payload.target_local_date || "",
      slot_window: payload.slot_window || "",
      candidate_seat_id: String(payload.candidate_seat_id || "primary"),
      candidate_seat_name: String(payload.candidate_seat_name || ""),
      candidate_region_name: String(payload.candidate_region_name || ""),
      external_execution_state: payload.external_execution_state || "DISPATCH_INTENT",
      user_intent_state_at_dispatch: payload.user_intent_state_at_dispatch || "ACTIVE",
      user_intent_state_at_completion: payload.user_intent_state_at_completion || null,
      dispatch_intent_at: ts,
      completed_at: payload.completed_at || null,
      external_booking_id: payload.external_booking_id || null,
      raw_response_code: payload.raw_response_code || null,
      raw_response_msg: payload.raw_response_msg || null,
      readback_verified: Boolean(payload.readback_verified),
      readback_evidence: payload.readback_evidence || null,
      billing_order_id: payload.billing_order_id || null,
      billing_state: payload.billing_state || "NOT_BILLED",
      created_at: ts,
      updated_at: ts
    };
    this.reservationAttempts.set(id, attempt);
    this.indexReservationAttempt(id, attempt);
    this.indexUserScoped("reservationAttempts", id, attempt.cloud_user_id);
    return attempt;
  }

  updateReservationAttempt(attemptId, patch = {}) {
    const attempt = this.reservationAttempts.get(attemptId);
    if (!attempt) return null;
    Object.assign(attempt, patch, {
      updated_at: new Date().toISOString()
    });
    return attempt;
  }

  latestAttemptForJob(jobId) {
    const list = this.attemptsForJob(jobId);
    return list.length > 0 ? list[list.length - 1] : null;
  }

  _preserveConfirmedEvidenceForUnknownCancel(sr, job) {
    if (!sr) return;
    sr.confirmed_official_status = sr.confirmed_official_status || "CONFIRMED";
    sr.confirmed_booking_evidence = sr.confirmed_booking_evidence || {
      external_booking_id: sr.external_booking_id || job?.external_booking_id || null,
      seat_alias: sr.seat_alias || null,
      region_alias: sr.region_alias || null,
      evidence_sha256: sr.evidence_sha256 || null,
      verified_at: sr.verified_at || null,
      start_at: sr.start_at || job?.fire_at || null,
      end_at: sr.end_at || job?.expires_at || null
    };
    sr.official_status = "CANCEL_RESULT_UNKNOWN";
    sr.school_cancellation_state = "CANCEL_RESULT_UNKNOWN";
  }

  _applyRevocationToJob(j, reason, ts) {
    const sr = this.schoolReservations.get(j.id) || null;
    const execState = j.external_execution_state || "NOT_DISPATCHED";
    const hadConfirmedCancel =
      j.state === "SCHOOL_CANCELLED" ||
      j.school_cancellation_state === "SCHOOL_CANCELLED" ||
      sr?.school_cancellation_state === "SCHOOL_CANCELLED" ||
      sr?.official_status === "SCHOOL_CANCELLED" ||
      sr?.official_status === "CANCELLED";
    const hadUnknownCancel =
      !hadConfirmedCancel &&
      (j.state === "CANCEL_RESULT_UNKNOWN" ||
        j.school_cancellation_state === "CANCEL_RESULT_UNKNOWN" ||
        j.school_cancellation_state === "CANCEL_IN_PROGRESS" ||
        sr?.school_cancellation_state === "CANCEL_RESULT_UNKNOWN" ||
        sr?.school_cancellation_state === "CANCEL_IN_PROGRESS" ||
        sr?.official_status === "CANCEL_RESULT_UNKNOWN");
    const isInFlightOrDispatched =
      execState === "DISPATCH_INTENT" ||
      execState === "RESULT_UNKNOWN" ||
      j.state === "RESULT_UNKNOWN";
    const isAlreadyConfirmed =
      execState === "SCHOOL_CONFIRMED" ||
      j.state === "CONFIRMED" ||
      j.state === "DELEGATION_STOPPED_SCHOOL_CONFIRMED" ||
      hadConfirmedCancel ||
      hadUnknownCancel ||
      Boolean(sr?.external_booking_id);

    j.user_intent_state = "REVOKED";
    j.last_error_code = reason;

    if (isAlreadyConfirmed) {
      j.external_execution_state = "SCHOOL_CONFIRMED";
      if (hadConfirmedCancel) {
        j.school_cancellation_state = "SCHOOL_CANCELLED";
        j.state = "SCHOOL_CANCELLED";
        if (sr) {
          sr.confirmed_official_status = sr.confirmed_official_status || "CONFIRMED";
          sr.school_cancellation_state = "SCHOOL_CANCELLED";
          sr.official_status = "SCHOOL_CANCELLED";
        }
      } else if (hadUnknownCancel) {
        j.school_cancellation_state = "CANCEL_RESULT_UNKNOWN";
        j.state = "CANCEL_RESULT_UNKNOWN";
        this._preserveConfirmedEvidenceForUnknownCancel(sr, j);
      } else {
        j.school_cancellation_state = "MANUAL_ACTION_REQUIRED";
        if (sr) {
          sr.confirmed_official_status = sr.confirmed_official_status || "CONFIRMED";
          sr.school_cancellation_state = "MANUAL_ACTION_REQUIRED";
        }
      }
      j.display_status = this.computeJobDisplayStatus(j);
      j.status_label = this.computeJobStatusLabel(j);
      return false;
    }

    if (isInFlightOrDispatched) {
      // Request has already been dispatched! Do NOT mark state as CANCELLED or discard future return value;
      // mark user_intent_state = REVOKED, billing_state = HELD_PENDING_REVIEW, and school_cancellation_state = MANUAL_ACTION_REQUIRED.
      j.school_cancellation_state = "MANUAL_ACTION_REQUIRED";
      j.billing_state = "HELD_PENDING_REVIEW";
      if (j.state !== "EXECUTING") {
        j.state = "RESULT_UNKNOWN";
        j.external_execution_state = "RESULT_UNKNOWN";
      }
      j.state_version += 1;
      j.display_status = this.computeJobDisplayStatus(j);
      j.status_label = this.computeJobStatusLabel(j);
      return true;
    }

    // Not yet dispatched: safe to cancel immediately
    j.external_execution_state = "NOT_DISPATCHED";
    j.school_cancellation_state = "NOT_REQUESTED";
    j.state = "CANCELLED";
    j.state_version += 1;
    j.display_status = this.computeJobDisplayStatus(j);
    j.status_label = this.computeJobStatusLabel(j);
    return true;
  }

  haltAllUserPlansAndBindings(cloudUserId, reason = "CONSENT_WITHDRAWN", nowMs = Date.now()) {
    const ts = new Date(nowMs).toISOString();
    const cancelledJobIds = [];
    const affectedJobIdSet = new Set();

    const user = this.users.get(cloudUserId);
    if (user) {
      user.auth_version = Number(user.auth_version || 1) + 1;
      user._lastRevocationSeq = Number(user._lastRevocationSeq || 0) + 1;
    }

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
      if (p.cloud_user_id === cloudUserId) {
        p.enabled = false;
        p.user_intent_state = "REVOKED";
        p._stopPersistencePending = true;
      }
    }

    for (const j of this.reservationJobs.values()) {
      if (
        j.cloud_user_id === cloudUserId &&
        !["FAILED", "CANCELLED", "EXPIRED", "REVOKED"].includes(j.state)
      ) {
        j._stopPersistencePending = true;
        const affected = this._applyRevocationToJob(j, reason, ts);
        if (affected) {
          cancelledJobIds.push(j.id);
        }
        affectedJobIdSet.add(j.id);
      }
    }

    for (const ev of this.scheduleEvents.values()) {
      if (affectedJobIdSet.has(ev.job_id) && ev.status === "ARMED") {
        ev.status = "ABORTED_REVOKED";
        ev.actual_at = ts;
      }
    }

    this.recordAudit({
      actor_kind: "USER",
      actor_ref: cloudUserId,
      action: "HALT_ALL_PLANS_AND_BINDINGS",
      resource_kind: "user",
      resource_ref: cloudUserId,
      outcome: reason,
      detail: { cancelled_job_ids: cancelledJobIds }
    });

    this.flushSnapshotStrictSync();

    return { cancelledJobIds };
  }

  purgeUserMomentsData(cloudUserId, nowMs = Date.now()) {
    if (!cloudUserId || !this.momentsState) {
      return { removed_posts: 0, removed_books: 0, removed_tags: 0, scrubbed_comments: 0, scrubbed_requests: 0 };
    }
    const nowIso = new Date(nowMs).toISOString();
    let removedPosts = 0;
    let removedBooks = 0;
    let removedTags = 0;
    let scrubbedComments = 0;
    let scrubbedRequests = 0;

    if (Array.isArray(this.momentsState.posts)) {
      const beforePosts = this.momentsState.posts.length;
      this.momentsState.posts = this.momentsState.posts.filter(
        (p) => p && p.owner_cloud_user_id !== cloudUserId
      );
      removedPosts = beforePosts - this.momentsState.posts.length;

      for (const p of this.momentsState.posts) {
        if (Array.isArray(p.comments)) {
          const prevLen = p.comments.length;
          p.comments = p.comments.filter((c) => c && c.author_user_id !== cloudUserId);
          scrubbedComments += prevLen - p.comments.length;
        }
        if (Array.isArray(p.contact_requests)) {
          const prevReqLen = p.contact_requests.length;
          p.contact_requests = p.contact_requests.filter(
            (r) => r && r.sender_user_id !== cloudUserId
          );
          scrubbedRequests += prevReqLen - p.contact_requests.length;
        }
      }
    }

    if (Array.isArray(this.momentsState.book_listings)) {
      const beforeBooks = this.momentsState.book_listings.length;
      this.momentsState.book_listings = this.momentsState.book_listings.filter(
        (b) => b && b.owner_cloud_user_id !== cloudUserId
      );
      removedBooks = beforeBooks - this.momentsState.book_listings.length;
    }

    if (Array.isArray(this.momentsState.anti_lost_tags)) {
      const beforeTags = this.momentsState.anti_lost_tags.length;
      this.momentsState.anti_lost_tags = this.momentsState.anti_lost_tags.filter(
        (t) => t && t.owner_cloud_user_id !== cloudUserId
      );
      removedTags = beforeTags - this.momentsState.anti_lost_tags.length;
    }

    if (removedPosts || removedBooks || removedTags || scrubbedComments || scrubbedRequests) {
      this.momentsState.updated_at = nowIso;
      this.saveSnapshot();
    }
    return {
      removed_posts: removedPosts,
      removed_books: removedBooks,
      removed_tags: removedTags,
      scrubbed_comments: scrubbedComments,
      scrubbed_requests: scrubbedRequests
    };
  }

  revokeSchoolBindingCascade(cloudUserId, bindingId, reason = "BINDING_REVOKED", nowMs = Date.now()) {
    const binding = this.schoolBindings.get(bindingId);
    if (!binding || binding.cloud_user_id !== cloudUserId) {
      throw new ContractError("NOT_FOUND", "School binding not found");
    }
    const ts = new Date(nowMs).toISOString();
    const targetStudentNo = String(binding.student_no || "").trim();
    const affectedBindingIds = new Set([bindingId]);

    for (const b of this.schoolBindings.values()) {
      if (
        b.cloud_user_id === cloudUserId &&
        b.school_id === binding.school_id &&
        (b.id === bindingId ||
          (targetStudentNo && String(b.student_no || "").trim() === targetStudentNo))
      ) {
        affectedBindingIds.add(b.id);
        if (!b.revoked_at) {
          b.revoked_at = ts;
          b.status = "REVOKED";
        }
        if (b.credential_ref && this.encryptedCredentials.has(b.credential_ref)) {
          this.encryptedCredentials.get(b.credential_ref).revoked_at = ts;
        }
      }
    }
    binding.revoked_at = ts;
    binding.status = "REVOKED";
    if (binding.credential_ref && this.encryptedCredentials.has(binding.credential_ref)) {
      this.encryptedCredentials.get(binding.credential_ref).revoked_at = ts;
    }

    const user = this.users.get(cloudUserId);
    if (user) {
      user.auth_version = Number(user.auth_version || 1) + 1;
      if (reason !== "SCHOOL_IDENTITY_REBOUND") {
        user._lastRevocationSeq = Number(user._lastRevocationSeq || 0) + 1;
      }
    }

    const cancelledJobIds = [];
    const affectedJobIdSet = new Set();
    for (const p of this.reservationPlans.values()) {
      if (p.cloud_user_id === cloudUserId && affectedBindingIds.has(p.school_binding_id)) {
        p.enabled = false;
        p.user_intent_state = "REVOKED";
        p._stopPersistencePending = true;
      }
    }
    for (const j of this.reservationJobs.values()) {
      if (
        j.cloud_user_id === cloudUserId &&
        affectedBindingIds.has(j.school_binding_id) &&
        !["FAILED", "CANCELLED", "EXPIRED", "REVOKED"].includes(j.state)
      ) {
        j._stopPersistencePending = true;
        const affected = this._applyRevocationToJob(j, reason, ts);
        if (affected) {
          cancelledJobIds.push(j.id);
        }
        affectedJobIdSet.add(j.id);
      }
    }
    for (const ev of this.scheduleEvents.values()) {
      if (affectedJobIdSet.has(ev.job_id) && ev.status === "ARMED") {
        ev.status = "ABORTED_REVOKED";
        ev.actual_at = ts;
      }
    }

    this.recordAudit({
      actor_kind: "USER",
      actor_ref: cloudUserId,
      action: "REVOKE_SCHOOL_BINDING",
      resource_kind: "school_binding",
      resource_ref: bindingId,
      outcome: reason,
      detail: {
        affected_binding_ids: Array.from(affectedBindingIds),
        cancelled_job_ids: cancelledJobIds
      }
    });

    this.flushSnapshotStrictSync();

    return { binding, cancelledJobIds, affectedBindingIds: Array.from(affectedBindingIds) };
  }
}
