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
  "consents", "operationsSchoolGrants", "reservationPlans", "reservationJobs", "scheduleEvents",
  "schoolReservations", "reservationAttempts", "reservationOrders", "financeOperations",
  "refundRequests", "parcels", "parcelEvents", "parcelSourceConnections",
  "parcelSyncJobs", "installedPlugins", "pluginPublishers", "pluginVersions",
  "pluginInstallations", "pluginPermissionGrants", "pluginStorageEntries",
  "pluginCacheEntries", "pluginRuntimeStates", "campusContent", "groups", "groupMembers",
  "groupInvites", "availabilityShares", "busyBlocks", "meetingPolls", "pollOptions",
  "pollVotes", "confirmedGroupEvents", "ledgerEntries", "ledgerBalanceRevisions", "settlements",
  "dutyRotas", "dutyTasks", "dutySwaps", "repairTickets", "repairTicketRevisions", "repairReviews",
  "notifications", "priceQuotes", "idempotencyRecords", "campusGraphPlaces", "placeReports",
  "placeReportFlags", "placeStatusSubscriptions", "placeStatusAggregates",
  "syncUserStates", "syncDevices", "syncBlobs", "syncMutations", "syncBlobAntiResurrection",
  "syncCursors", "syncTransferUsage", "syncRateWindows", "contentPackSubmissions",
  "contentPackReviews", "contentPackVersions", "contentPackRateWindows"
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
    onPersistStage = null,
    onSyncCiphertextSweepEvent = null,
    syncCiphertextSweepRetryBaseMs = 500
  } = {}) {
    this.snapshotPath = snapshotPath;
    this.snapshotFs = snapshotFs;
    this.onPersistStage = onPersistStage;
    this.onSyncCiphertextSweepEvent = onSyncCiphertextSweepEvent;
    this.syncCiphertextSweepRetryBaseMs = Math.max(25, Number(syncCiphertextSweepRetryBaseMs) || 500);
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
    this.operationsSchoolGrants = new Map(); // grantId -> explicit per-school operations authorization
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

    // Plugins (W6-01a SQL 0011 durable model mirrored by the snapshot store)
    this.installedPlugins = new Map(); // plugin_id -> legacy 0002 signed registry root row
    this.pluginPublishers = new Map(); // publisherId -> trusted publisher/public key metadata
    this.pluginVersions = new Map(); // `${pluginId}@${version}` -> signed immutable version record
    this.pluginInstallations = new Map(); // `${userId}:${schoolId}:${pluginId}` -> installation
    this.pluginPermissionGrants = new Map(); // `${installationId}:${permission}` -> grant/revocation row
    this.pluginStorageEntries = new Map(); // `${installationId}:${namespace}:${key}` -> scoped storage row
    this.pluginCacheEntries = new Map(); // `${installationId}:${namespace}:${key}` -> disposable cache row
    this.pluginRuntimeStates = new Map(); // pluginId -> failure/kill-switch runtime state

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

    // Ledger & dorm collaboration (W4-03): append-only integer-fen postings,
    // settlement acknowledgements, deterministic duty projections, swaps, and repairs.
    this.ledgerEntries = new Map(); // entryId -> immutable posting + deterministic shares
    this.ledgerBalanceRevisions = new Map(); // groupId -> monotonic balance revision row
    this.settlements = new Map(); // settlementId -> two-party out-of-band confirmation record
    this.dutyRotas = new Map(); // rotaId -> rotation schedule and generation cursor
    this.dutyTasks = new Map(); // taskId -> projected duty occurrence
    this.dutySwaps = new Map(); // swapId -> immutable swap/cover audit record
    this.repairTickets = new Map(); // repairId -> informal group repair coordination record
    this.repairTicketRevisions = new Map(); // revisionId -> immutable repair metadata edit audit row
    this.repairReviews = new Map(); // reviewId -> one-time reporter review

    // Place Status (W4-04): bootstrap Campus Graph snapshot, immutable user
    // observations, flags, subscriptions, and aggregate revision state.
    this.campusGraphPlaces = new Map(); // placeRef -> coarse graph entity
    this.placeReports = new Map(); // reportId -> immutable observation + moderation eligibility
    this.placeReportFlags = new Map(); // flagId -> review request
    this.placeStatusSubscriptions = new Map(); // subscriptionId -> caller-owned subscription
    this.placeStatusAggregates = new Map(); // school|placeRef|metric -> revision/state

    // Content package catalog (W5-02): immutable review/version metadata. Artifact
    // bytes are content-addressed sidecar media, never inline JSON snapshot strings.
    this.contentPackSubmissions = new Map(); // submissionId -> immutable candidate metadata + review lifecycle
    this.contentPackReviews = new Map(); // submissionId -> exactly one review decision row
    this.contentPackVersions = new Map(); // `${packId}@${version}` -> immutable published/retired version metadata
    this.contentPackRateWindows = new Map(); // `${cloudUserId}:${kind}:${windowStart}` -> fixed-window request count

    // E2EE sync (W4-11): ciphertext-only current blobs, metadata-only mutation
    // history, device-bound cursors, consent lifecycle state, quotas, and minimal
    // anti-resurrection markers.  No plaintext or key material is representable here.
    this.syncUserStates = new Map(); // cloudUserId -> per-user sequence/compaction/consent state
    this.syncDevices = new Map(); // `${cloudUserId}:${deviceId}` -> immutable device registration/revocation
    this.syncBlobs = new Map(); // `${cloudUserId}:${blobId}` -> current ciphertext or tombstone metadata
    this.syncMutations = new Map(); // `${cloudUserId}:${changeSequence}` -> metadata-only causal mutation row
    this.syncBlobAntiResurrection = new Map(); // `${cloudUserId}:${blobId}` -> permanent closed-id marker
    this.syncCursors = new Map(); // cursorId -> hashed opaque device-bound cursor
    this.syncTransferUsage = new Map(); // usageId -> rolling ingress/egress byte accounting row
    this.syncRateWindows = new Map(); // `${cloudUserId}:${kind}:${windowStart}` -> fixed-window rate counter

    // W4-11 review fix: ciphertext NEVER enters the monolithic JSON snapshot.
    // Content-addressed sidecar files (${snapshotPath}.ciphertext/<shard>/<sha256>.bin)
    // carry the bytes with their own write-fsync-rename-dirsync publish protocol, so
    // the V8 single-string ceiling of one JSON document can never cap sync below the
    // per-account quota.  In ephemeral mode (no snapshotPath) ciphertext stays in a
    // memory-sidecar map instead of the rows, keeping one code path in the service.
    this.syncCiphertextMemory = new Map(); // digest -> Buffer (ephemeral mode only)
    this.syncCiphertextDir = snapshotPath ? `${snapshotPath}.ciphertext` : null;
    this._syncCiphertextTmpSeq = 0;

    // W5-02 artifact bytes follow the same boundary as ciphertext: content-addressed
    // sidecar files in durable mode and memory-only media in ephemeral tests.
    this.contentPackArtifactMemory = new Map(); // digest -> Buffer (ephemeral mode only)
    this.contentPackArtifactDir = snapshotPath ? `${snapshotPath}.content-artifacts` : null;
    this._contentPackArtifactTmpSeq = 0;
    // Directory entries of deleted sidecar files are durable only after the
    // shard-directory fsync succeeds. If that fsync reports failure, the volatile
    // name may already be gone; remembering the shard is the only way a retry can
    // still flush the deletion instead of mistaking volatile absence for durable
    // erasure. The counters are operator-visible health, never payload data.
    this.syncCiphertextPendingDeleteFsync = new Set(); // shardDir -> deletion durability uncertain
    this.syncCiphertextSweepMetrics = {
      attempts: 0,
      successes: 0,
      failures: 0,
      consecutive_failures: 0,
      removed_total: 0,
      last_removed: 0,
      last_trigger: null,
      last_success_at: null,
      last_failure_at: null,
      last_failure_code: null,
      last_failure_message: null,
      retry_pending: false,
      retry_scheduled: false,
      next_retry_delay_ms: null,
      pending_delete_fsync_shards: 0
    };
    this._syncCiphertextSweepRetryTimer = null;

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
    for (const name of ["schoolBindings", "reservationPlans", "reservationJobs", "reservationOrders", "consents", "notifications", "reservationAttempts", "refundRequests", "groupMembers", "placeStatusSubscriptions", "syncDevices"]) {
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
      loadMap(this.operationsSchoolGrants, raw.operationsSchoolGrants);
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
      loadMap(this.installedPlugins, raw.installedPlugins);
      loadMap(this.pluginPublishers, raw.pluginPublishers);
      loadMap(this.pluginVersions, raw.pluginVersions);
      loadMap(this.pluginInstallations, raw.pluginInstallations);
      loadMap(this.pluginPermissionGrants, raw.pluginPermissionGrants);
      loadMap(this.pluginStorageEntries, raw.pluginStorageEntries);
      loadMap(this.pluginCacheEntries, raw.pluginCacheEntries);
      loadMap(this.pluginRuntimeStates, raw.pluginRuntimeStates);
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
      loadMap(this.ledgerEntries, raw.ledgerEntries);
      loadMap(this.ledgerBalanceRevisions, raw.ledgerBalanceRevisions);
      loadMap(this.settlements, raw.settlements);
      loadMap(this.dutyRotas, raw.dutyRotas);
      loadMap(this.dutyTasks, raw.dutyTasks);
      loadMap(this.dutySwaps, raw.dutySwaps);
      loadMap(this.repairTickets, raw.repairTickets);
      loadMap(this.repairTicketRevisions, raw.repairTicketRevisions);
      loadMap(this.repairReviews, raw.repairReviews);
      loadMap(this.campusGraphPlaces, raw.campusGraphPlaces);
      loadMap(this.placeReports, raw.placeReports);
      loadMap(this.placeReportFlags, raw.placeReportFlags);
      loadMap(this.placeStatusSubscriptions, raw.placeStatusSubscriptions);
      loadMap(this.placeStatusAggregates, raw.placeStatusAggregates);
      loadMap(this.syncUserStates, raw.syncUserStates);
      loadMap(this.syncDevices, raw.syncDevices);
      loadMap(this.syncBlobs, raw.syncBlobs);
      loadMap(this.syncMutations, raw.syncMutations);
      loadMap(this.syncBlobAntiResurrection, raw.syncBlobAntiResurrection);
      loadMap(this.syncCursors, raw.syncCursors);
      loadMap(this.syncTransferUsage, raw.syncTransferUsage);
      loadMap(this.syncRateWindows, raw.syncRateWindows);
      loadMap(this.contentPackSubmissions, raw.contentPackSubmissions);
      loadMap(this.contentPackReviews, raw.contentPackReviews);
      loadMap(this.contentPackVersions, raw.contentPackVersions);
      loadMap(this.contentPackRateWindows, raw.contentPackRateWindows);
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
      // W4-11 sidecar split: move any pre-split inline ciphertext out of the
      // JSON world, then fail closed if committed references are not durable.
      // Orphaned sidecar bytes (crashed/rolled-back uploads) are reclaimed
      // best-effort; a sweep failure never blocks startup and retries at the
      // next publish.
      this._migrateLegacyInlineSyncCiphertext();
      this._verifySyncCiphertextReferencesDurable();
      this._verifyContentPackArtifactReferencesDurable();
      try {
        this.sweepSyncCiphertextOrphans(this, { trigger: "startup" });
        this.sweepContentPackArtifactOrphans(this);
      } catch {
        // The sweep itself has already emitted metrics/logs and scheduled retry;
        // startup remains available while reclamation continues out-of-band.
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

  // ---- W4-11 E2EE ciphertext sidecar (content-addressed, crash-safe) ----

  _syncCiphertextFilePath(digest) {
    return path.join(this.syncCiphertextDir, digest.slice(0, 2), digest + ".bin");
  }

  // Persist one immutable ciphertext blob outside the JSON snapshot.  Content
  // addressing makes the write idempotent: the final name only ever appears
  // through an atomic rename of a fully fsynced temporary file, so a correct-size
  // file already present is by construction the same bytes.  Orphaned files
  // (written before a rolled-back or crashed commit) are harmless and reclaimed
  // by sweepSyncCiphertextOrphans; the reverse ordering hazard never exists
  // because this write always completes before the referencing snapshot publish.
  writeSyncCiphertextDurable(digest, bytes) {
    if (typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest)) {
      throw new ContractError("STORAGE_PERSISTENCE_FAILED", "sync ciphertext digest is not a lowercase sha256 hex");
    }
    const content = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    if (crypto.createHash("sha256").update(content).digest("hex") !== digest) {
      throw new ContractError("STORAGE_PERSISTENCE_FAILED", "sync ciphertext bytes do not match their content digest");
    }
    if (!this.syncCiphertextDir) {
      if (!this.syncCiphertextMemory.has(digest)) this.syncCiphertextMemory.set(digest, Buffer.from(content));
      return;
    }
    const io = this.snapshotFs;
    const finalPath = this._syncCiphertextFilePath(digest);
    try {
      const existing = io.statSync(finalPath, { throwIfNoEntry: false });
      if (existing) {
        if (existing.size === content.length) return; // content-addressed: already durable
        throw new Error("侧车密文尺寸与内容寻址冲突");
      }
      const shardDir = path.dirname(finalPath);
      if (!io.existsSync(shardDir)) {
        const missing = [];
        for (let cursor = shardDir; !io.existsSync(cursor); cursor = path.dirname(cursor)) {
          missing.push(cursor);
          if (path.dirname(cursor) === cursor) throw new Error("密文侧车存储根目录不可用");
        }
        io.mkdirSync(shardDir, { recursive: true });
        for (const created of missing.reverse()) {
          const parentFd = io.openSync(path.dirname(created), "r");
          try { io.fsyncSync(parentFd); }
          finally { io.closeSync(parentFd); }
        }
      }
      this._syncCiphertextTmpSeq = (this._syncCiphertextTmpSeq || 0) + 1;
      const tmpPath = finalPath + ".tmp." + process.pid + "." + this._syncCiphertextTmpSeq;
      const fd = io.openSync(tmpPath, "wx", 0o600);
      try {
        io.writeFileSync(fd, content);
        io.fsyncSync(fd);
      } finally { io.closeSync(fd); }
      io.renameSync(tmpPath, finalPath);
      this._fsyncSyncCiphertextShardDir(shardDir);
      // A successful shard directory fsync also makes any earlier deletion in
      // the same directory durable, even when that deletion had been waiting
      // for a sweep retry.
      this.syncCiphertextPendingDeleteFsync?.delete(shardDir);
    } catch (err) {
      if (err instanceof ContractError) throw err;
      throw new ContractError(
        "STORAGE_PERSISTENCE_FAILED",
        `E2EE 同步密文侧车写入失败：${err?.message || "unknown"}`,
        { retry_same_key: true }
      );
    }
  }

  // Read one ciphertext blob back, verifying integrity end-to-end.  Any missing
  // or corrupted sidecar content is a durability fault and fails closed — the
  // server must never silently substitute or truncate user ciphertext.
  readSyncCiphertextVerified(digest, expectedSizeBytes = null) {
    if (typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest)) {
      throw new ContractError("STORAGE_PERSISTENCE_FAILED", "sync ciphertext digest is not a lowercase sha256 hex");
    }
    let content = null;
    if (!this.syncCiphertextDir) {
      content = this.syncCiphertextMemory.get(digest) || null;
    } else {
      try {
        content = this.snapshotFs.readFileSync(this._syncCiphertextFilePath(digest));
      } catch {
        content = null;
      }
    }
    if (!content) {
      throw new ContractError(
        "STORAGE_PERSISTENCE_FAILED",
        "E2EE 同步密文侧车内容缺失，耐久状态须隔离核验",
        { ciphertext_sha256: digest }
      );
    }
    const sizeOk = expectedSizeBytes == null ? true : content.length === expectedSizeBytes;
    if (!sizeOk || crypto.createHash("sha256").update(content).digest("hex") !== digest) {
      throw new ContractError(
        "STORAGE_PERSISTENCE_FAILED",
        "E2EE 同步密文侧车内容摘要或尺寸不符，耐久状态须隔离核验",
        { ciphertext_sha256: digest }
      );
    }
    return content;
  }

  _syncCiphertextDigestReferences(source = this) {
    const digests = new Set();
    for (const row of source.syncBlobs?.values?.() || []) {
      if (
        row?.change_kind === "UPSERT" &&
        typeof row.ciphertext_sha256 === "string" &&
        /^[0-9a-f]{64}$/.test(row.ciphertext_sha256)
      ) {
        digests.add(row.ciphertext_sha256);
      }
    }
    return digests;
  }

  _fsyncSyncCiphertextShardDir(shardDir) {
    const io = this.snapshotFs;
    const fd = io.openSync(shardDir, "r");
    try { io.fsyncSync(fd); }
    finally { io.closeSync(fd); }
  }

  _scheduleSyncCiphertextSweepRetry() {
    const metrics = this.syncCiphertextSweepMetrics;
    if (!this.syncCiphertextDir || !metrics) return 0;
    if (this._syncCiphertextSweepRetryTimer) return metrics.next_retry_delay_ms || 0;
    const exponent = Math.min(Math.max(metrics.consecutive_failures - 1, 0), 5);
    const delayMs = Math.min(this.syncCiphertextSweepRetryBaseMs * (2 ** exponent), 30_000);
    metrics.retry_scheduled = true;
    metrics.next_retry_delay_ms = delayMs;
    this._syncCiphertextSweepRetryTimer = setTimeout(() => {
      this._syncCiphertextSweepRetryTimer = null;
      try {
        this.sweepSyncCiphertextOrphans(this, { trigger: "retry" });
      } catch {
        // The failure path has already emitted the structured event, updated
        // metrics, and scheduled the next backoff retry; the timer callback must
        // never turn that observable failure into an unhandled exception.
      }
    }, delayMs);
    this._syncCiphertextSweepRetryTimer.unref?.();
    return delayMs;
  }

  _recordSyncCiphertextSweepSuccess(trigger, removed) {
    const metrics = this.syncCiphertextSweepMetrics;
    if (!metrics) return;
    if (this._syncCiphertextSweepRetryTimer) {
      clearTimeout(this._syncCiphertextSweepRetryTimer);
      this._syncCiphertextSweepRetryTimer = null;
    }
    metrics.successes += 1;
    metrics.consecutive_failures = 0;
    metrics.removed_total += removed;
    metrics.last_removed = removed;
    metrics.last_success_at = new Date().toISOString();
    metrics.retry_pending = false;
    metrics.retry_scheduled = false;
    metrics.next_retry_delay_ms = null;
    metrics.pending_delete_fsync_shards = this.syncCiphertextPendingDeleteFsync?.size || 0;
  }

  _recordSyncCiphertextSweepFailure(err, trigger, removed) {
    const metrics = this.syncCiphertextSweepMetrics;
    if (!metrics) return;
    const nowIso = new Date().toISOString();
    // D16 applies to operational logs too: Node filesystem errors often embed
    // the configured snapshot path. Keep the actionable syscall/code but redact
    // all store-controlled path prefixes before recording or emitting anything.
    let message = String(err?.message || err || "unknown");
    const pathRedactions = [this.syncCiphertextDir, this.snapshotPath]
      .filter((value) => typeof value === "string" && value.length > 1)
      .sort((a, b) => b.length - a.length);
    for (const token of pathRedactions) {
      const label = token === this.syncCiphertextDir ? "<sync-ciphertext-dir>" : "<snapshot-path>";
      message = message.split(token).join(label);
    }
    message = message.slice(0, 240);
    metrics.failures += 1;
    metrics.consecutive_failures += 1;
    metrics.last_removed = removed;
    metrics.last_failure_at = nowIso;
    metrics.last_failure_code = err?.code || "SYNC_CIPHERTEXT_SWEEP_FAILED";
    metrics.last_failure_message = message;
    metrics.retry_pending = true;
    metrics.pending_delete_fsync_shards = this.syncCiphertextPendingDeleteFsync?.size || 0;
    const retryDelayMs = this._scheduleSyncCiphertextSweepRetry();
    metrics.pending_delete_fsync_shards = this.syncCiphertextPendingDeleteFsync?.size || 0;
    const event = {
      service: "sync-ciphertext-sweep",
      level: "error",
      timestamp: nowIso,
      trigger,
      error_code: metrics.last_failure_code,
      error_message: message,
      removed_before_failure: removed,
      pending_delete_fsync_shards: metrics.pending_delete_fsync_shards,
      metrics: {
        attempts: metrics.attempts,
        successes: metrics.successes,
        failures: metrics.failures,
        consecutive_failures: metrics.consecutive_failures,
        removed_total: metrics.removed_total
      },
      retry_pending: true,
      retry_scheduled: retryDelayMs > 0,
      retry_delay_ms: retryDelayMs || null
    };
    const sink = this.onSyncCiphertextSweepEvent;
    if (typeof sink === "function") {
      try {
        sink({ ...event });
        return;
      } catch (sinkErr) {
        event.event_sink_error = "event sink failed";
      }
    }
    console.error(JSON.stringify(event));
  }

  // Reclaim ciphertext bytes no live UPSERT row references anymore — tombstoned,
  // expired, purged, or orphaned by a rolled-back/crashed upload. Deletion only
  // ever runs after the referencing-removal snapshot is already published (or at
  // startup recovery), so a sweep can never strand a durable reference. Every
  // unlink is followed by a shard-directory fsync; failures are metered, emitted
  // as structured logs, and retried instead of being silently swallowed.
  sweepSyncCiphertextOrphans(source = this, { trigger = "manual" } = {}) {
    const metrics = this.syncCiphertextSweepMetrics;
    if (metrics) {
      metrics.attempts += 1;
      metrics.last_trigger = trigger;
    }
    const referenced = this._syncCiphertextDigestReferences(source);
    let removed = 0;
    try {
      if (!this.syncCiphertextDir) {
        for (const digest of Array.from(this.syncCiphertextMemory.keys())) {
          if (!referenced.has(digest)) {
            this.syncCiphertextMemory.delete(digest);
            removed += 1;
          }
        }
        this._recordSyncCiphertextSweepSuccess(trigger, removed);
        return removed;
      }
      const io = this.snapshotFs;
      if (!io.existsSync(this.syncCiphertextDir)) {
        this._recordSyncCiphertextSweepSuccess(trigger, removed);
        return removed;
      }

      // A previous unlink may have succeeded only in the volatile directory
      // view before its fsync failed. Flush those shards first even when the
      // file is already invisible here; volatile absence is not durable erasure.
      for (const shardDir of Array.from(this.syncCiphertextPendingDeleteFsync || [])) {
        this._fsyncSyncCiphertextShardDir(shardDir);
        this.syncCiphertextPendingDeleteFsync.delete(shardDir);
      }

      for (const shard of io.readdirSync(this.syncCiphertextDir)) {
        if (!/^[0-9a-f]{2}$/.test(shard)) continue;
        const shardDir = path.join(this.syncCiphertextDir, shard);
        // A shard read failure is a sweep failure and must surface through the
        // outer failure path; skipping it would silently strand ciphertext.
        const names = io.readdirSync(shardDir);
        for (const name of names) {
          const match = /^([0-9a-f]{64})\.bin$/.exec(name);
          const isOrphanBlob = match && !referenced.has(match[1]);
          const isTmpResidue = !match && name.includes(".tmp.");
          if (!isOrphanBlob && !isTmpResidue) continue;
          const filePath = path.join(shardDir, name);
          let unlinked = false;
          try {
            io.unlinkSync(filePath);
            unlinked = true;
          } catch (err) {
            if (err?.code !== "ENOENT") {
              // An unlink error can leave the entry state unknown. Remember the
              // shard for a directory-fsync retry instead of assuming either success
              // or failure; the next scan also retries the unlink if it still exists.
              this.syncCiphertextPendingDeleteFsync.add(shardDir);
              throw err;
            }
            // ENOENT still needs the same directory durability barrier: another
            // actor may have removed the volatile entry without making that removal
            // power-loss durable.
          }
          try {
            this._fsyncSyncCiphertextShardDir(shardDir);
            this.syncCiphertextPendingDeleteFsync.delete(shardDir);
          } catch (err) {
            this.syncCiphertextPendingDeleteFsync.add(shardDir);
            throw err;
          }
          if (unlinked) removed += 1;
        }
      }
      this._recordSyncCiphertextSweepSuccess(trigger, removed);
      return removed;
    } catch (err) {
      this._recordSyncCiphertextSweepFailure(err, trigger, removed);
      throw err;
    }
  }

  // Load-time upgrade path: snapshots written before the sidecar split still
  // carry ciphertext_base64 on current UPSERT rows.  Move those bytes into the
  // sidecar (verified) and strip them from memory so the next publish is clean.
  _migrateLegacyInlineSyncCiphertext() {
    for (const row of this.syncBlobs.values()) {
      if (!row || !Object.hasOwn(row, "ciphertext_base64")) continue;
      if (row.change_kind === "UPSERT" && typeof row.ciphertext_base64 === "string") {
        const bytes = Buffer.from(row.ciphertext_base64, "base64");
        const digest = crypto.createHash("sha256").update(bytes).digest("hex");
        if (digest !== row.ciphertext_sha256 || bytes.length !== row.ciphertext_size_bytes) {
          throw new Error("E2EE 同步遗留内联密文摘要或尺寸不一致");
        }
        this.writeSyncCiphertextDurable(row.ciphertext_sha256, bytes);
      }
      delete row.ciphertext_base64;
    }
    for (const row of this.syncMutations.values()) {
      if (row && Object.hasOwn(row, "ciphertext_base64")) delete row.ciphertext_base64;
      if (row && Object.hasOwn(row, "ciphertext")) delete row.ciphertext;
    }
  }

  // Fail-closed durability verification at load: every live UPSERT reference
  // must resolve to a sidecar file of exactly the committed size.  Content
  // hashing stays lazy at read time; existence+size here catches lost or
  // truncated media before the server starts accepting traffic again.
  _verifySyncCiphertextReferencesDurable() {
    if (!this.syncCiphertextDir) return;
    const io = this.snapshotFs;
    for (const row of this.syncBlobs.values()) {
      if (row?.change_kind !== "UPSERT") continue;
      const stat = io.statSync(this._syncCiphertextFilePath(row.ciphertext_sha256), { throwIfNoEntry: false });
      if (!stat) {
        throw new Error("E2EE 同步密文侧车文件缺失: " + row.ciphertext_sha256);
      }
      if (stat.size !== row.ciphertext_size_bytes) {
        throw new Error("E2EE 同步密文侧车尺寸不符: " + row.ciphertext_sha256);
      }
    }
  }

  // ---- W5-02 content package artifact sidecar (content-addressed, crash-safe) ----

  _contentPackArtifactFilePath(digest) {
    return path.join(this.contentPackArtifactDir, digest.slice(0, 2), digest + ".bin");
  }

  // Persist immutable artifact bytes outside the JSON snapshot.  The write is
  // content-addressed, fsynced, and atomically renamed before the referencing
  // metadata commit is allowed to publish; orphans from a rolled-back commit are
  // harmless and reclaimed by sweepContentPackArtifactOrphans.
  writeContentPackArtifactDurable(digest, bytes) {
    if (typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest)) {
      throw new ContractError("STORAGE_PERSISTENCE_FAILED", "content pack artifact digest is not lowercase sha256 hex");
    }
    const content = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    if (crypto.createHash("sha256").update(content).digest("hex") !== digest) {
      throw new ContractError("STORAGE_PERSISTENCE_FAILED", "content pack artifact bytes do not match their content digest");
    }
    if (!this.contentPackArtifactDir) {
      if (!this.contentPackArtifactMemory.has(digest)) this.contentPackArtifactMemory.set(digest, Buffer.from(content));
      return;
    }
    const io = this.snapshotFs;
    const finalPath = this._contentPackArtifactFilePath(digest);
    try {
      const existing = io.statSync(finalPath, { throwIfNoEntry: false });
      if (existing) {
        if (existing.size !== content.length) throw new Error("内容包 artifact 侧车尺寸与内容寻址冲突");
        const existingBytes = io.readFileSync(finalPath);
        if (crypto.createHash("sha256").update(existingBytes).digest("hex") !== digest) {
          throw new Error("内容包 artifact 侧车摘要与内容寻址冲突");
        }
        return;
      }
      const shardDir = path.dirname(finalPath);
      if (!io.existsSync(shardDir)) {
        const missing = [];
        for (let cursor = shardDir; !io.existsSync(cursor); cursor = path.dirname(cursor)) {
          missing.push(cursor);
          if (path.dirname(cursor) === cursor) throw new Error("内容包 artifact 侧车存储根目录不可用");
        }
        io.mkdirSync(shardDir, { recursive: true });
        for (const created of missing.reverse()) {
          const parentFd = io.openSync(path.dirname(created), "r");
          try { io.fsyncSync(parentFd); }
          finally { io.closeSync(parentFd); }
        }
      }
      this._contentPackArtifactTmpSeq = (this._contentPackArtifactTmpSeq || 0) + 1;
      const tmpPath = finalPath + ".tmp." + process.pid + "." + this._contentPackArtifactTmpSeq;
      const fd = io.openSync(tmpPath, "wx", 0o600);
      try {
        io.writeFileSync(fd, content);
        io.fsyncSync(fd);
      } finally { io.closeSync(fd); }
      io.renameSync(tmpPath, finalPath);
      const dirFd = io.openSync(shardDir, "r");
      try { io.fsyncSync(dirFd); }
      finally { io.closeSync(dirFd); }
    } catch (err) {
      if (err instanceof ContractError) throw err;
      throw new ContractError(
        "STORAGE_PERSISTENCE_FAILED",
        "内容包 artifact 侧车写入失败：" + (err?.message || "unknown"),
        { retry_same_key: true }
      );
    }
  }

  readContentPackArtifactVerified(digest, expectedSizeBytes = null) {
    if (typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest)) {
      throw new ContractError("STORAGE_PERSISTENCE_FAILED", "content pack artifact digest is not lowercase sha256 hex");
    }
    let content = null;
    if (!this.contentPackArtifactDir) {
      content = this.contentPackArtifactMemory.get(digest) || null;
    } else {
      try {
        content = this.snapshotFs.readFileSync(this._contentPackArtifactFilePath(digest));
      } catch {
        content = null;
      }
    }
    if (!content) {
      throw new ContractError(
        "STORAGE_PERSISTENCE_FAILED",
        "内容包 artifact 侧车内容缺失，耐久状态须隔离核验",
        { artifact_sha256: digest }
      );
    }
    const sizeOk = expectedSizeBytes == null ? true : content.length === expectedSizeBytes;
    if (!sizeOk || crypto.createHash("sha256").update(content).digest("hex") !== digest) {
      throw new ContractError(
        "STORAGE_PERSISTENCE_FAILED",
        "内容包 artifact 侧车内容摘要或尺寸不符，耐久状态须隔离核验",
        { artifact_sha256: digest }
      );
    }
    return content;
  }

  _contentPackArtifactDigestReferences(source = this) {
    const digests = new Set();
    const add = (value) => {
      if (typeof value === "string" && /^[0-9a-f]{64}$/.test(value)) digests.add(value);
    };
    for (const row of source.contentPackSubmissions?.values?.() || []) add(row?.artifact_sha256);
    for (const row of source.contentPackVersions?.values?.() || []) add(row?.artifact_sha256);
    return digests;
  }

  _verifyContentPackArtifactReferencesDurable() {
    if (!this.contentPackArtifactDir) return;
    const io = this.snapshotFs;
    const seen = new Set();
    for (const row of [...this.contentPackSubmissions.values(), ...this.contentPackVersions.values()]) {
      const digest = row?.artifact_sha256;
      if (!digest || seen.has(digest)) continue;
      seen.add(digest);
      const stat = io.statSync(this._contentPackArtifactFilePath(digest), { throwIfNoEntry: false });
      if (!stat) throw new Error("内容包 artifact 侧车文件缺失: " + digest);
      if (stat.size !== row.artifact_size_bytes) throw new Error("内容包 artifact 侧车尺寸不符: " + digest);
    }
  }

  // Reclaim artifact media no live submission/version row references.  This only
  // runs after metadata removal is durable (startup recovery or an explicit sweep),
  // so deletion can never strand a committed download reference.
  sweepContentPackArtifactOrphans(source = this) {
    const referenced = this._contentPackArtifactDigestReferences(source);
    let removed = 0;
    if (!this.contentPackArtifactDir) {
      for (const digest of Array.from(this.contentPackArtifactMemory.keys())) {
        if (!referenced.has(digest)) {
          this.contentPackArtifactMemory.delete(digest);
          removed += 1;
        }
      }
      return removed;
    }
    const io = this.snapshotFs;
    if (!io.existsSync(this.contentPackArtifactDir)) return 0;
    for (const shard of io.readdirSync(this.contentPackArtifactDir)) {
      if (!/^[0-9a-f]{2}$/.test(shard)) continue;
      const shardDir = path.join(this.contentPackArtifactDir, shard);
      let mutated = false;
      for (const name of io.readdirSync(shardDir)) {
        const match = /^([0-9a-f]{64})\.bin$/.exec(name);
        const isOrphan = match && !referenced.has(match[1]);
        const isTmp = !match && name.includes(".tmp.");
        if (!isOrphan && !isTmp) continue;
        io.unlinkSync(path.join(shardDir, name));
        mutated = true;
        if (isOrphan) removed += 1;
      }
      if (mutated) {
        const fd = io.openSync(shardDir, "r");
        try { io.fsyncSync(fd); }
        finally { io.closeSync(fd); }
      }
    }
    return removed;
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

  _validateCommitUnit(raw, { allowLegacyInlineCiphertext = false } = {}) {
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
    const finiteTime = (value) => Number.isFinite(Date.parse(value));
    for (const [, share] of shares) {
      const member = members.get(share?.member_id);
      const group = groups.get(share?.group_id);
      if (!member || member.group_id !== share.group_id || member.school_id !== share.school_id) {
        throw new Error("忙闲共享快照与成员作用域不一致");
      }
      if (!group || group.school_id !== share.school_id) {
        throw new Error("忙闲共享快照与学校作用域不一致");
      }
      if (!Number.isInteger(share?.revision) || share.revision < 1) {
        throw new Error("忙闲共享快照 revision 不是正整数");
      }
      if (!Number.isInteger(share?.ttl_seconds) || share.ttl_seconds < 1800 || share.ttl_seconds > 7776000) {
        throw new Error("忙闲共享快照 TTL 超出 30 分钟到 90 天边界");
      }
      if (!finiteTime(share?.expires_at)) {
        throw new Error("忙闲共享快照 expires_at 无效");
      }
      const shareShapeValid =
        (share?.status === "ACTIVE" && share.withdrawn_at == null && share.expired_at == null) ||
        (share?.status === "WITHDRAWN" && finiteTime(share.withdrawn_at) && share.expired_at == null) ||
        (share?.status === "EXPIRED" && finiteTime(share.expired_at) && share.withdrawn_at == null);
      if (!shareShapeValid) {
        throw new Error("忙闲共享快照状态时间戳形状不一致");
      }
    }
    const blocksByMember = new Map();
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
      if (!blocksByMember.has(block.member_id)) blocksByMember.set(block.member_id, []);
      blocksByMember.get(block.member_id).push(block);
    }
    for (const memberBlocks of blocksByMember.values()) {
      memberBlocks.sort((a, b) => Date.parse(a.start_at) - Date.parse(b.start_at) || Date.parse(a.end_at) - Date.parse(b.end_at));
      for (let index = 1; index < memberBlocks.length; index += 1) {
        if (Date.parse(memberBlocks[index].start_at) < Date.parse(memberBlocks[index - 1].end_at)) {
          throw new Error("忙闲块快照存在重叠时间窗");
        }
      }
    }
    for (const [, poll] of polls) {
      const group = groups.get(poll?.group_id);
      if (!group || group.school_id !== poll.school_id) {
        throw new Error("投票快照与学校作用域不一致");
      }
      if (typeof poll?.title !== "string" || poll.title.trim().length < 1 || poll.title.trim().length > 120) {
        throw new Error("投票快照标题无效");
      }
      if (!finiteTime(poll?.voting_deadline_at)) {
        throw new Error("投票快照截止时间无效");
      }
      const pollShapeValid =
        (poll?.status === "OPEN" && poll.closed_at == null && poll.confirmed_at == null && poll.confirmed_option_id == null && poll.confirmed_event_id == null) ||
        (poll?.status === "CLOSED" && finiteTime(poll.closed_at) && poll.confirmed_at == null && poll.confirmed_option_id == null && poll.confirmed_event_id == null) ||
        (poll?.status === "CONFIRMED" && finiteTime(poll.closed_at) && finiteTime(poll.confirmed_at) && typeof poll.confirmed_option_id === "string" && typeof poll.confirmed_event_id === "string");
      if (!pollShapeValid) {
        throw new Error("投票快照状态终态形状不一致");
      }
    }
    const optionWindows = new Set();
    const optionCountByPoll = new Map();
    for (const [, option] of options) {
      const poll = polls.get(option?.poll_id);
      if (!poll || !quantized(option)) {
        throw new Error("投票选项快照与投票或量化约束不一致");
      }
      if (!Number.isInteger(option?.position) || option.position < 0) {
        throw new Error("投票选项快照 position 无效");
      }
      const windowKey = option.poll_id + "|" + option.start_at + "|" + option.end_at;
      if (optionWindows.has(windowKey)) {
        throw new Error("投票选项快照存在重复时间窗");
      }
      optionWindows.add(windowKey);
      optionCountByPoll.set(option.poll_id, (optionCountByPoll.get(option.poll_id) || 0) + 1);
    }
    for (const [pollId] of polls) {
      const count = optionCountByPoll.get(pollId) || 0;
      if (count < 2 || count > 10) {
        throw new Error("投票快照选项数量不在 2..10 边界内");
      }
    }
    const voteMembers = new Set();
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
      const voteKey = vote.poll_id + "|" + vote.member_id;
      if (voteMembers.has(voteKey)) {
        throw new Error("投票表决快照违反单成员一票约束");
      }
      voteMembers.add(voteKey);
      if (finiteTime(vote?.created_at) && finiteTime(vote?.updated_at) && Date.parse(vote.updated_at) < Date.parse(vote.created_at)) {
        throw new Error("投票表决快照 updated_at 早于 created_at");
      }
    }
    const confirmedPolls = new Set();
    for (const [, confirmed] of raw.confirmedGroupEvents || []) {
      const poll = polls.get(confirmed?.poll_id);
      const option = options.get(confirmed?.option_id);
      if (!poll || poll.group_id !== confirmed.group_id || poll.school_id !== confirmed.school_id) {
        throw new Error("确认事件快照与投票作用域不一致");
      }
      if (!option || option.poll_id !== confirmed.poll_id || !quantized(confirmed)) {
        throw new Error("确认事件快照与选项或量化约束不一致");
      }
      if (confirmed?.status !== "CONFIRMED" || !finiteTime(confirmed.confirmed_at)) {
        throw new Error("确认事件快照不是有效终态");
      }
      if (confirmedPolls.has(confirmed.poll_id)) {
        throw new Error("确认事件快照违反单投票唯一终态约束");
      }
      confirmedPolls.add(confirmed.poll_id);
      if (
        poll.status !== "CONFIRMED" ||
        poll.confirmed_option_id !== confirmed.option_id ||
        poll.confirmed_event_id !== confirmed.id ||
        option.start_at !== confirmed.start_at ||
        option.end_at !== confirmed.end_at
      ) {
        throw new Error("确认事件快照与投票终态指针不一致");
      }
    }
    // W4-03 ledger/dorm collaboration snapshot invariants. Amounts are signed
    // integer fen encoded as exact safe integers or decimal strings for int64
    // edge values; BigInt is used here only for validation and is never persisted.
    const fenSnapshotValue = (value, label) => {
      if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
      if (typeof value === "string" && /^-?\d+$/.test(value)) return BigInt(value);
      throw new Error(label + " 不是精确整数分");
    };
    const ledgerRows = new Map(raw.ledgerEntries || []);
    const settlementRows = new Map(raw.settlements || []);
    const revisionRows = new Map(raw.ledgerBalanceRevisions || []);
    const rotaRows = new Map(raw.dutyRotas || []);
    const taskRows = new Map(raw.dutyTasks || []);
    const swapRows = new Map(raw.dutySwaps || []);
    const repairRows = new Map(raw.repairTickets || []);
    const repairRevisionRows = new Map(raw.repairTicketRevisions || []);
    const repairReviewRows = new Map(raw.repairReviews || []);
    for (const [, revision] of revisionRows) {
      const group = groups.get(revision?.group_id);
      if (!group || group.school_id !== revision.school_id) {
        throw new Error("账本余额 revision 快照与学校作用域不一致");
      }
      if (!Number.isSafeInteger(revision.balance_revision) || revision.balance_revision < 0) {
        throw new Error("账本余额 revision 不是非负安全整数");
      }
    }
    for (const [, entry] of ledgerRows) {
      const group = groups.get(entry?.group_id);
      if (!group || group.school_id !== entry.school_id) {
        throw new Error("账本条目快照与学校作用域不一致");
      }
      if (!["EXPENSE", "REFUND", "CORRECTION"].includes(entry.entry_kind)) {
        throw new Error("账本条目快照类型无效");
      }
      const amount = fenSnapshotValue(entry.amount_fen, "账本条目金额");
      if (amount === 0n) throw new Error("账本条目快照金额为零");
      const correctionShape =
        (entry.entry_kind === "CORRECTION" && typeof entry.corrects_entry_id === "string" && typeof entry.correction_reason === "string" && entry.correction_reason.length > 0) ||
        (entry.entry_kind !== "CORRECTION" && entry.corrects_entry_id == null && entry.correction_reason == null);
      if (!correctionShape) throw new Error("账本更正链快照形状不一致");
      if (entry.entry_kind === "CORRECTION") {
        const target = ledgerRows.get(entry.corrects_entry_id);
        if (!target || target.group_id !== entry.group_id || target.school_id !== entry.school_id) {
          throw new Error("账本更正链快照目标缺失或跨作用域");
        }
      }
      if (!Array.isArray(entry.shares) || entry.shares.length === 0) {
        throw new Error("账本条目快照缺少确定分摊");
      }
      const shareParticipants = new Set();
      let shareSum = 0n;
      for (const share of entry.shares) {
        if (shareParticipants.has(share?.participant_member_id)) {
          throw new Error("账本分摊快照存在重复参与人");
        }
        shareParticipants.add(share?.participant_member_id);
        shareSum += fenSnapshotValue(share?.amount_fen, "账本分摊金额");
      }
      if (shareSum !== amount) throw new Error("账本分摊快照不守恒");
    }
    for (const [, settlement] of settlementRows) {
      const group = groups.get(settlement?.group_id);
      if (!group || group.school_id !== settlement.school_id) {
        throw new Error("结算快照与学校作用域不一致");
      }
      if (settlement.debtor_member_id === settlement.creditor_member_id) {
        throw new Error("结算快照双方相同");
      }
      if (fenSnapshotValue(settlement.amount_fen, "结算金额") <= 0n) {
        throw new Error("结算快照金额不是正整数分");
      }
      const statusShape =
        (settlement.status === "PENDING_BOTH_CONFIRMATIONS" && settlement.debtor_confirmed_at == null && settlement.creditor_confirmed_at == null && settlement.confirmed_at == null && settlement.cancelled_at == null) ||
        (settlement.status === "PENDING_DEBTOR_CONFIRMATION" && settlement.debtor_confirmed_at == null && settlement.creditor_confirmed_at != null && settlement.confirmed_at == null && settlement.cancelled_at == null) ||
        (settlement.status === "PENDING_CREDITOR_CONFIRMATION" && settlement.debtor_confirmed_at != null && settlement.creditor_confirmed_at == null && settlement.confirmed_at == null && settlement.cancelled_at == null) ||
        (settlement.status === "CONFIRMED" && settlement.debtor_confirmed_at != null && settlement.creditor_confirmed_at != null && settlement.confirmed_at != null && settlement.cancelled_at == null) ||
        (settlement.status === "CANCELLED" && settlement.confirmed_at == null && settlement.cancelled_at != null && settlement.cancelled_by_member_id != null);
      if (!statusShape) throw new Error("结算快照双方确认状态形状不一致");
    }
    for (const [, rota] of rotaRows) {
      const group = groups.get(rota?.group_id);
      if (!group || group.school_id !== rota.school_id) {
        throw new Error("值日轮班快照与学校作用域不一致");
      }
      if (!Array.isArray(rota.rotation_member_ids) || rota.rotation_member_ids.length < 2 || new Set(rota.rotation_member_ids).size !== rota.rotation_member_ids.length) {
        throw new Error("值日轮班快照成员序列无效");
      }
      if (!["DAILY", "WEEKLY"].includes(rota.frequency) || !["ACTIVE", "PAUSED", "ARCHIVED"].includes(rota.status)) {
        throw new Error("值日轮班快照频率或状态无效");
      }
      if (rota.frequency === "WEEKLY" && (!Array.isArray(rota.days_of_week) || rota.days_of_week.length === 0)) {
        throw new Error("WEEKLY 值日轮班快照缺少星期集合");
      }
    }
    for (const [, task] of taskRows) {
      const rota = rotaRows.get(task?.rota_id);
      const group = groups.get(task?.group_id);
      if (!group || group.school_id !== task.school_id || !rota || rota.group_id !== task.group_id || rota.school_id !== task.school_id) {
        throw new Error("值日任务快照与轮班或学校作用域不一致");
      }
      const taskShape =
        (task.status === "PENDING" && task.completed_at == null && task.confirmed_at == null && task.skipped_at == null) ||
        (task.status === "COMPLETED" && task.completed_at != null && task.completed_by_member_id != null && task.confirmed_at == null && task.skipped_at == null) ||
        (task.status === "CONFIRMED" && task.completed_at != null && task.confirmed_at != null && task.confirmed_by_member_id != null && task.skipped_at == null) ||
        (task.status === "SKIPPED" && task.completed_at == null && task.confirmed_at == null && task.skip_reason != null && task.skipped_at != null && task.skipped_by_member_id != null);
      if (!taskShape) throw new Error("值日任务快照状态形状不一致");
    }
    for (const [, swap] of swapRows) {
      const rota = rotaRows.get(swap?.rota_id);
      const task = taskRows.get(swap?.duty_task_id);
      if (!rota || !task || task.rota_id !== swap.rota_id || rota.group_id !== swap.group_id || rota.school_id !== swap.school_id) {
        throw new Error("值日交换快照与轮班任务作用域不一致");
      }
      const swapShape =
        (swap.status === "PENDING" && swap.resolved_at == null && swap.resolved_by_member_id == null) ||
        (["ACCEPTED", "REJECTED", "CANCELLED"].includes(swap.status) && swap.resolved_at != null && swap.resolved_by_member_id != null);
      if (!swapShape) throw new Error("值日交换快照状态形状不一致");
    }
    for (const [, repair] of repairRows) {
      const group = groups.get(repair?.group_id);
      if (!group || group.school_id !== repair.school_id) {
        throw new Error("报修快照与学校作用域不一致");
      }
      if (!["OPEN", "TRIAGED", "IN_PROGRESS", "RESOLVED", "REJECTED", "CLOSED"].includes(repair.status)) {
        throw new Error("报修快照状态无效");
      }
      if (repair.official_work_order !== false) {
        throw new Error("报修快照错误声明为官方工单");
      }
      if ((repair.status === "CLOSED") !== (repair.closed_at != null) || (repair.status === "REJECTED") !== (repair.rejected_at != null)) {
        throw new Error("报修快照终态时间戳形状不一致");
      }
    }
    for (const [, revision] of repairRevisionRows) {
      const repair = repairRows.get(revision?.repair_id);
      if (!repair || repair.group_id !== revision.group_id || repair.school_id !== revision.school_id) {
        throw new Error("报修编辑审计快照与报修作用域不一致");
      }
    }
    const reviewedRepairs = new Set();
    for (const [, review] of repairReviewRows) {
      const repair = repairRows.get(review?.repair_id);
      if (!repair || repair.group_id !== review.group_id || repair.school_id !== review.school_id) {
        throw new Error("报修评价快照与报修作用域不一致");
      }
      if (reviewedRepairs.has(review.repair_id) || repair.review_id !== review.id) {
        throw new Error("报修评价快照违反一次性评价约束");
      }
      reviewedRepairs.add(review.repair_id);
      if (!Number.isInteger(review.rating) || review.rating < 1 || review.rating > 5) {
        throw new Error("报修评价快照评分越界");
      }
    }

    // W4-11 E2EE sync snapshot invariants: ciphertext may exist only on the
    // current UPSERT row; mutation history, cursors, devices, and anti-resurrection
    // markers are metadata-only.  These checks intentionally mirror SQL 0010's
    // shape constraints without ever attempting decryption or plaintext inference.
    const syncDevices = new Map(raw.syncDevices || []);
    const syncBlobs = new Map(raw.syncBlobs || []);
    const syncMutations = new Map(raw.syncMutations || []);
    const syncVectorValid = (vector) => {
      if (!Array.isArray(vector) || vector.length > 512) return false;
      const seen = new Set();
      for (const entry of vector) {
        if (!entry || typeof entry.device_id !== "string" || seen.has(entry.device_id)) return false;
        if (!Number.isSafeInteger(entry.counter) || entry.counter < 1 || entry.counter > 2147483647) return false;
        seen.add(entry.device_id);
      }
      return true;
    };
    const syncBucketSizes = new Set([1024, 4096, 16384, 65536, 262144, 1048576]);
    for (const [key, device] of syncDevices) {
      if (!device?.cloud_user_id || !device.device_id || key !== device.cloud_user_id + ":" + device.device_id) {
        throw new Error("E2EE 同步设备快照键或用户作用域不一致");
      }
      if (device.platform !== "ANDROID" || device.sync_protocol_version !== 1) {
        throw new Error("E2EE 同步设备快照协议形状无效");
      }
      const deviceShape =
        (device.status === "ACTIVE" && device.revoked_at == null && device.revocation_reason == null) ||
        (device.status === "REVOKED" && finiteTime(device.revoked_at) && typeof device.revocation_reason === "string");
      if (!deviceShape) throw new Error("E2EE 同步设备快照撤销状态形状不一致");
      if (!Number.isSafeInteger(device.acknowledged_cursor_position) || device.acknowledged_cursor_position < 0) {
        throw new Error("E2EE 同步设备快照 cursor 确认水位无效");
      }
    }
    // Post-split invariant: ciphertext bytes live only in the content-addressed
    // sidecar, never in the JSON commit unit.  Inline ciphertext is tolerated
    // exclusively while validating a pre-split snapshot during recovery
    // (allowLegacyInlineCiphertext); anything published by this build is strict.
    const validateSyncMutationShape = (row, isCurrentBlob) => {
      if (!row?.cloud_user_id || !row.blob_id || !syncVectorValid(row.version_vector)) return false;
      if (!Number.isSafeInteger(row.change_sequence) || row.change_sequence < 1) return false;
      if (!finiteTime(row.committed_at)) return false;
      const device = syncDevices.get(row.cloud_user_id + ":" + row.author_device_id);
      if (!device) return false;
      if (row.change_kind === "UPSERT") {
        if (!row.encryption || row.encryption.format !== "dis-sync-e2ee/v1" || row.encryption.cipher_suite !== "AES-256-GCM" || row.encryption.padding_scheme !== "DIS_SYNC_SIZE_BUCKETS_POW4_V1") return false;
        if (typeof row.ciphertext_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(row.ciphertext_sha256)) return false;
        if (!syncBucketSizes.has(row.ciphertext_size_bytes)) return false;
        if (Object.hasOwn(row, "ciphertext")) return false;
        if (Object.hasOwn(row, "ciphertext_base64")) {
          if (!isCurrentBlob || !allowLegacyInlineCiphertext || typeof row.ciphertext_base64 !== "string") return false;
          const decodedCiphertext = Buffer.from(row.ciphertext_base64, "base64");
          if (decodedCiphertext.length !== row.ciphertext_size_bytes) return false;
          if (crypto.createHash("sha256").update(decodedCiphertext).digest("hex") !== row.ciphertext_sha256) return false;
        }
        return true;
      }
      if (row.change_kind !== "TOMBSTONE") return false;
      return row.encryption === null && row.ciphertext_sha256 === null && row.ciphertext_size_bytes === null &&
        !Object.hasOwn(row, "ciphertext_base64") && !Object.hasOwn(row, "ciphertext");
    };
    const currentSequenceOwners = new Set();
    const mutationSequenceOwners = new Set();
    for (const [key, blob] of syncBlobs) {
      if (!blob?.cloud_user_id || !blob.blob_id || key !== blob.cloud_user_id + ":" + blob.blob_id) {
        throw new Error("E2EE 同步当前块快照键或用户作用域不一致");
      }
      if (!validateSyncMutationShape(blob, true)) throw new Error("E2EE 同步当前块快照不是合法密文桶或 tombstone");
      const seqOwner = blob.cloud_user_id + ":" + blob.change_sequence;
      if (currentSequenceOwners.has(seqOwner)) throw new Error("E2EE 同步当前块 change_sequence 快照重复");
      currentSequenceOwners.add(seqOwner);
    }
    for (const [key, mutation] of syncMutations) {
      if (!mutation?.cloud_user_id || key !== mutation.cloud_user_id + ":" + mutation.change_sequence) {
        throw new Error("E2EE 同步变更史快照键或序列不一致");
      }
      if (!validateSyncMutationShape(mutation, false)) throw new Error("E2EE 同步变更史快照含密文或元数据形状无效");
      const seqOwner = mutation.cloud_user_id + ":" + mutation.change_sequence;
      if (mutationSequenceOwners.has(seqOwner)) throw new Error("E2EE 同步变更史 change_sequence 快照重复");
      mutationSequenceOwners.add(seqOwner);
    }
    for (const [key, marker] of raw.syncBlobAntiResurrection || []) {
      if (!marker?.cloud_user_id || !marker.blob_id || key !== marker.cloud_user_id + ":" + marker.blob_id) {
        throw new Error("E2EE 防复活标记快照作用域不一致");
      }
      if (Object.hasOwn(marker, "ciphertext_base64") || Object.hasOwn(marker, "version_vector") || Object.hasOwn(marker, "encryption")) {
        throw new Error("E2EE 防复活标记快照不是最小元数据");
      }
    }
    for (const [, cursor] of raw.syncCursors || []) {
      if (!cursor?.cloud_user_id || !cursor.device_id || !syncDevices.has(cursor.cloud_user_id + ":" + cursor.device_id)) {
        throw new Error("E2EE cursor 快照未绑定已登记设备");
      }
      if (Object.hasOwn(cursor, "token") || Object.hasOwn(cursor, "token_base64") || typeof cursor.token_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(cursor.token_sha256)) {
        throw new Error("E2EE cursor 快照必须只保存 opaque token 摘要");
      }
      if (!Number.isSafeInteger(cursor.position) || !Number.isSafeInteger(cursor.scan_epoch) || cursor.position < 0 || cursor.position > cursor.scan_epoch) {
        throw new Error("E2EE cursor 快照位置越界");
      }
      if (!["FULL", "INCREMENTAL"].includes(cursor.scan_mode)) {
        throw new Error("E2EE cursor 快照缺少显式 scan mode");
      }
    }
    for (const [, usage] of raw.syncTransferUsage || []) {
      if (!usage?.cloud_user_id || !["INGRESS", "EGRESS"].includes(usage.direction) || !Number.isSafeInteger(usage.bytes) || usage.bytes <= 0 || !finiteTime(usage.occurred_at)) {
        throw new Error("E2EE 同步传输配额快照无效");
      }
    }

    const graphPlaces = new Map(raw.campusGraphPlaces || []);
    const placeReports = new Map(raw.placeReports || []);
    for (const [, report] of placeReports) {
      const place = graphPlaces.get(report?.place_ref);
      if (!place || place.school_id !== report.school_id || place.campus_id !== report.campus_id || place.place_type !== report.place_type) {
        throw new Error("地点状态报告快照与 Campus Graph 学校作用域不一致");
      }
    }
    for (const [, flag] of raw.placeReportFlags || []) {
      const report = placeReports.get(flag?.report_id);
      if (!report || report.school_id !== flag.school_id || report.place_ref !== flag.place_ref) {
        throw new Error("地点状态举报快照与报告作用域不一致");
      }
    }
    for (const [, subscription] of raw.placeStatusSubscriptions || []) {
      if (subscription?.target?.type === "PLACE" && !graphPlaces.has(subscription.target.place_ref)) {
        throw new Error("地点状态订阅快照引用了缺失的 Campus Graph 实体");
      }
    }

    // W5-02 content catalog snapshot invariants. Artifact bytes are sidecar-only;
    // metadata rows must never re-inline them into the monolithic JSON commit unit.
    const packSubmissions = new Map(raw.contentPackSubmissions || []);
    const packStatuses = new Set(["PENDING_REVIEW", "CHANGES_REQUESTED", "APPROVED", "REJECTED", "PUBLISHED"]);
    for (const [key, row] of packSubmissions) {
      if (!row?.submission_id || key !== row.submission_id || !packStatuses.has(row.status)) {
        throw new Error("内容包提交快照键或状态不一致");
      }
      if (Object.hasOwn(row, "artifact") || Object.hasOwn(row, "artifact_base64")) {
        throw new Error("内容包提交快照不得内联 artifact 字节");
      }
      if (typeof row.artifact_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(row.artifact_sha256) ||
          !Number.isSafeInteger(row.artifact_size_bytes) || row.artifact_size_bytes < 1 || row.artifact_size_bytes > 16777216) {
        throw new Error("内容包提交快照 artifact 摘要或尺寸无效");
      }
    }
    for (const [key, review] of raw.contentPackReviews || []) {
      const submission = packSubmissions.get(key);
      if (!submission || review?.submission_id !== key) {
        throw new Error("内容包审核快照与提交作用域不一致");
      }
      if (!["APPROVE", "REQUEST_CHANGES", "REJECT"].includes(review.action) ||
          review.reviewer_cloud_user_id === submission.submitter_cloud_user_id) {
        throw new Error("内容包审核快照违反动作或分权约束");
      }
      if ((review.action === "REQUEST_CHANGES" || review.action === "REJECT") && !review.review_note) {
        throw new Error("内容包审核快照缺少公开安全审核说明");
      }
    }
    for (const [key, version] of raw.contentPackVersions || []) {
      const expectedKey = String(version?.pack_id || "") + "@" + String(version?.version || "");
      if (!version?.pack_id || !version.version || key !== expectedKey) {
        throw new Error("内容包版本快照键不一致");
      }
      const submission = packSubmissions.get(version.submission_id);
      if (!submission || submission.status !== "PUBLISHED" ||
          submission.pack_id !== version.pack_id || submission.version !== version.version ||
          submission.artifact_sha256 !== version.artifact_sha256) {
        throw new Error("内容包版本快照与已发布提交不一致");
      }
      if (Object.hasOwn(version, "artifact") || Object.hasOwn(version, "artifact_base64")) {
        throw new Error("内容包版本快照不得内联 artifact 字节");
      }
      const lifecycleShape =
        (version.lifecycle_status === "PUBLISHED" && version.retired_at == null && version.retirement_reason == null) ||
        (version.lifecycle_status === "RETIRED" && finiteTime(version.retired_at) && typeof version.retirement_reason === "string");
      if (!lifecycleShape) throw new Error("内容包版本生命周期快照形状不一致");
    }
    for (const [key, row] of raw.contentPackRateWindows || []) {
      if (!row?.cloud_user_id || !["SUBMIT", "DOWNLOAD"].includes(row.operation_kind) ||
          key !== row.cloud_user_id + ":" + row.operation_kind + ":" + String(row.window_started_ms) ||
          !Number.isSafeInteger(row.request_count) || row.request_count < 0) {
        throw new Error("内容包速率窗口快照无效");
      }
    }
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
        this._validateCommitUnit(JSON.parse(bytes.toString("utf8")), { allowLegacyInlineCiphertext: true });
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
        operationsSchoolGrants: Array.from(source.operationsSchoolGrants.entries()),
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
        installedPlugins: Array.from(source.installedPlugins.entries()),
        pluginPublishers: Array.from(source.pluginPublishers.entries()),
        pluginVersions: Array.from(source.pluginVersions.entries()),
        pluginInstallations: Array.from(source.pluginInstallations.entries()),
        pluginPermissionGrants: Array.from(source.pluginPermissionGrants.entries()),
        pluginStorageEntries: Array.from(source.pluginStorageEntries.entries()),
        pluginCacheEntries: Array.from(source.pluginCacheEntries.entries()),
        pluginRuntimeStates: Array.from(source.pluginRuntimeStates.entries()),
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
        ledgerEntries: Array.from(source.ledgerEntries.entries()),
        ledgerBalanceRevisions: Array.from(source.ledgerBalanceRevisions.entries()),
        settlements: Array.from(source.settlements.entries()),
        dutyRotas: Array.from(source.dutyRotas.entries()),
        dutyTasks: Array.from(source.dutyTasks.entries()),
        dutySwaps: Array.from(source.dutySwaps.entries()),
        repairTickets: Array.from(source.repairTickets.entries()),
        repairTicketRevisions: Array.from(source.repairTicketRevisions.entries()),
        repairReviews: Array.from(source.repairReviews.entries()),
        campusGraphPlaces: Array.from(source.campusGraphPlaces.entries()),
        placeReports: Array.from(source.placeReports.entries()),
        placeReportFlags: Array.from(source.placeReportFlags.entries()),
        placeStatusSubscriptions: Array.from(source.placeStatusSubscriptions.entries()),
        placeStatusAggregates: Array.from(source.placeStatusAggregates.entries()),
        syncUserStates: Array.from(source.syncUserStates.entries()),
        syncDevices: Array.from(source.syncDevices.entries()),
        syncBlobs: Array.from(source.syncBlobs.entries()),
        syncMutations: Array.from(source.syncMutations.entries()),
        syncBlobAntiResurrection: Array.from(source.syncBlobAntiResurrection.entries()),
        syncCursors: Array.from(source.syncCursors.entries()),
        syncTransferUsage: Array.from(source.syncTransferUsage.entries()),
        syncRateWindows: Array.from(source.syncRateWindows.entries()),
        contentPackSubmissions: Array.from(source.contentPackSubmissions.entries()),
        contentPackReviews: Array.from(source.contentPackReviews.entries()),
        contentPackVersions: Array.from(source.contentPackVersions.entries()),
        contentPackRateWindows: Array.from(source.contentPackRateWindows.entries()),
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
      // W4-11 sidecar garbage collection: ciphertext bytes whose references this
      // commit removed (tombstone, expiry cleanup, erasure) or that a rolled-back
      // upload orphaned are reclaimed only now, after the publish is durable.
      // Best-effort — a sweep failure never invalidates the committed snapshot;
      // leftover orphans are retried after the next publish or at startup.
      try {
        this.sweepSyncCiphertextOrphans(source, { trigger: "post_publish" });
        this.sweepContentPackArtifactOrphans(source);
      } catch {
        // The committed snapshot stays valid; the sweep failure is visible in
        // metrics/logs and its backoff retry flushes pending delete fsyncs.
      }
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

  _requireOperationsGrantPart(value, field) {
    const clean = String(value || "").trim();
    if (!clean) throw new ContractError("BAD_REQUEST", field + " must not be empty");
    if (clean.length > 128) throw new ContractError("BAD_REQUEST", field + " exceeds maximum length 128");
    return clean;
  }

  grantOperationsSchoolScope(cloudUserId, schoolId, permission, { grantedByRef = "system", nowMs = Date.now() } = {}) {
    const userId = this._requireOperationsGrantPart(cloudUserId, "cloud_user_id");
    const scopedSchoolId = this._requireOperationsGrantPart(schoolId, "school_id");
    const scopedPermission = this._requireOperationsGrantPart(permission, "permission");
    const existing = Array.from(this.operationsSchoolGrants.values()).find((grant) =>
      grant.cloud_user_id === userId &&
      grant.school_id === scopedSchoolId &&
      grant.permission === scopedPermission &&
      grant.status === "ACTIVE" &&
      !grant.revoked_at
    );
    if (existing) return existing;
    const ts = new Date(nowMs).toISOString();
    const grant = {
      id: crypto.randomUUID(),
      cloud_user_id: userId,
      school_id: scopedSchoolId,
      permission: scopedPermission,
      status: "ACTIVE",
      granted_by_ref: this._requireOperationsGrantPart(grantedByRef, "granted_by_ref"),
      created_at: ts,
      updated_at: ts,
      revoked_at: null
    };
    this.operationsSchoolGrants.set(grant.id, grant);
    this.saveSnapshot();
    return grant;
  }

  revokeOperationsSchoolScope(cloudUserId, schoolId, permission, nowMs = Date.now()) {
    const userId = this._requireOperationsGrantPart(cloudUserId, "cloud_user_id");
    const scopedSchoolId = this._requireOperationsGrantPart(schoolId, "school_id");
    const scopedPermission = this._requireOperationsGrantPart(permission, "permission");
    const ts = new Date(nowMs).toISOString();
    let revoked = 0;
    for (const grant of this.operationsSchoolGrants.values()) {
      if (
        grant.cloud_user_id === userId &&
        grant.school_id === scopedSchoolId &&
        grant.permission === scopedPermission &&
        grant.status === "ACTIVE" &&
        !grant.revoked_at
      ) {
        grant.status = "REVOKED";
        grant.updated_at = ts;
        grant.revoked_at = ts;
        revoked += 1;
      }
    }
    if (revoked) this.saveSnapshot();
    return revoked;
  }

  revokeOperationsSchoolGrant(grantId, nowMs = Date.now()) {
    const grant = this.operationsSchoolGrants.get(grantId);
    if (!grant || grant.status !== "ACTIVE" || grant.revoked_at) return false;
    const ts = new Date(nowMs).toISOString();
    grant.status = "REVOKED";
    grant.updated_at = ts;
    grant.revoked_at = ts;
    this.saveSnapshot();
    return true;
  }

  hasOperationsSchoolScope(cloudUserId, schoolId, permission) {
    const userId = String(cloudUserId || "").trim();
    const scopedSchoolId = String(schoolId || "").trim();
    const scopedPermission = String(permission || "").trim();
    if (!userId || !scopedSchoolId || !scopedPermission) return false;
    return Array.from(this.operationsSchoolGrants.values()).some((grant) =>
      grant.cloud_user_id === userId &&
      grant.school_id === scopedSchoolId &&
      grant.permission === scopedPermission &&
      grant.status === "ACTIVE" &&
      !grant.revoked_at
    );
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

    const hasIndependentE2eeScope = (consent) => Boolean(
      consent?.purpose === "E2EE_CLOUD_SYNC" ||
      (Array.isArray(consent?.scope_list) && consent.scope_list.includes("E2EE_CLOUD_SYNC"))
    );
    // School delegation cascades must not sweep the independent user-scoped
    // E2EE consent domain into withdrawal.  Only genuinely account-global stop
    // flows may include it, and those flows start the sync retention lifecycle
    // in the same durable halt commit rather than stranding ciphertext.
    const includeIndependentE2ee = reason === "XPEACH_UNLINKED" || reason === "USER_DATA_DELETE";
    let withdrewE2eeConsent = false;
    for (const c of this.consents.values()) {
      if (c.cloud_user_id !== cloudUserId || c.withdrawn_at) continue;
      const e2eeConsent = hasIndependentE2eeScope(c);
      if (e2eeConsent && !includeIndependentE2ee) continue;
      c.withdrawn_at = ts;
      if (e2eeConsent) withdrewE2eeConsent = true;
    }

    if (includeIndependentE2ee && withdrewE2eeConsent) {
      const stillActiveE2ee = Array.from(this.consents.values()).some((c) => (
        c?.cloud_user_id === cloudUserId && !c.withdrawn_at && hasIndependentE2eeScope(c)
      ));
      if (!stillActiveE2ee) {
        let syncState = this.syncUserStates.get(cloudUserId);
        if (!syncState) {
          syncState = {
            cloud_user_id: cloudUserId,
            latest_change_sequence: 0,
            compaction_epoch: 0,
            consent_withdrawn_at: null,
            retention_expires_at: null,
            reauthorized_at: null,
            expired_cleanup_at: null,
            updated_at: ts
          };
          this.syncUserStates.set(cloudUserId, syncState);
        }
        if (!syncState.consent_withdrawn_at) {
          syncState.consent_withdrawn_at = ts;
          syncState.retention_expires_at = new Date(nowMs + 30 * 24 * 60 * 60 * 1000).toISOString();
          syncState.updated_at = ts;
        }
        for (const cursor of this.syncCursors.values()) {
          if (cursor.cloud_user_id === cloudUserId && !cursor.invalidated_at) cursor.invalidated_at = ts;
        }
        for (const device of this.syncDevices.values()) {
          if (device.cloud_user_id === cloudUserId) device.acknowledged_cursor_position = 0;
        }
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

  purgeUserPluginData(cloudUserId) {
    if (!cloudUserId) {
      return { removed_installations: 0, removed_permission_grants: 0, removed_storage_entries: 0, removed_cache_entries: 0 };
    }
    const installationIds = new Set();
    let removedInstallations = 0;
    for (const [key, installation] of Array.from(this.pluginInstallations.entries())) {
      const owner = installation?.cloud_user_id || installation?.user_id;
      if (owner !== cloudUserId) continue;
      if (installation?.installation_id) installationIds.add(installation.installation_id);
      this.pluginInstallations.delete(key);
      removedInstallations += 1;
    }
    let removedGrantRows = 0;
    for (const [key, row] of Array.from(this.pluginPermissionGrants.entries())) {
      if (!installationIds.has(row?.installation_id)) continue;
      this.pluginPermissionGrants.delete(key);
      removedGrantRows += 1;
    }
    let removedStorageEntries = 0;
    for (const [key, row] of Array.from(this.pluginStorageEntries.entries())) {
      if (!installationIds.has(row?.installation_id)) continue;
      this.pluginStorageEntries.delete(key);
      removedStorageEntries += 1;
    }
    let removedCacheEntries = 0;
    for (const [key, row] of Array.from(this.pluginCacheEntries.entries())) {
      if (!installationIds.has(row?.installation_id)) continue;
      this.pluginCacheEntries.delete(key);
      removedCacheEntries += 1;
    }
    const result = {
      removed_installations: removedInstallations,
      removed_permission_grants: removedGrantRows,
      removed_storage_entries: removedStorageEntries,
      removed_cache_entries: removedCacheEntries
    };
    if (removedInstallations || removedStorageEntries || removedCacheEntries) {
      this.recordAudit({
        actor_kind: "USER",
        actor_ref: cloudUserId,
        action: "PURGE_USER_PLUGIN_DATA",
        resource_kind: "user",
        resource_ref: cloudUserId,
        outcome: "SUCCESS",
        detail: result
      });
      this.saveSnapshot();
    }
    return result;
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
