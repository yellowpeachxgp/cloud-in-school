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
  INNOVATION_ENTREPRENEURSHIP: "创新创业与双创孵化",
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
      interest_tags: ["算法编程", "单片机/EDA", "大厂笔试直通", "保研/综测加分"],
      organizer: "工业和信息化部人才交流中心",
      haut_host_college: "信息科学与工程学院 / 人工智能与大数据学院",
      registration_window: "每年 10月–12月报名 · 次年 4月省赛 / 6月国赛",
      team_mode: "个人赛（软件类 C/C++/Java/Python · 电子类单片机/EDA）",
      difficulty_label: "大一友好 · 零基础可冲省奖",
      beginner_friendly: true,
      summary: "国内参赛规模最大的个人编程与电子设计赛事，分 C/C++、Java、Python、Web 及单片机/嵌入式赛道，是理工科学生大一练手、斩获首个省级/国家级奖项的最佳跳板。",
      skill_roadmap: "掌握一门主力语言 (C++/Python/Java) → 熟悉数组、字符串、搜索 (BFS/DFS) 与贪心 → 攻克动态规划与图论基础 → 刷透近 5 年省赛真题",
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
      registration_window: "每年 5月–6月报名 · 8月四天三夜封闭极限竞赛",
      team_mode: "3人组队（硬件电路 + 嵌入式控制 + 信号算法/报告）",
      difficulty_label: "硬核工程 · 实验室实战集训",
      beginner_friendly: false,
      summary: "电子信息、电气工程与自动化专业含金量最高的国家级学科竞赛，采用全国统一命题、四天三夜半封闭制作实物的极限赛制，全面检验硬件电路与嵌入式系统功底。",
      skill_roadmap: "大一入门 STM32 单片机与立创 EDA 画板 → 掌握 PID 控制、运放电路与传感器驱动 → 参加硬件技术联盟日常实训与暑期集训",
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
      interest_tags: ["MATLAB/Python", "数据分析与优化", "LaTeX科研排版", "保研核心加分"],
      organizer: "中国工业与应用数学学会 (CSIAM)",
      haut_host_college: "理学院",
      registration_window: "每年 6月–8月校内选拔培训 · 9月上旬三天三夜正赛",
      team_mode: "3人组队（数学建模手 + MATLAB/Python 编程手 + 论文写作手）",
      difficulty_label: "大一/大二友好 · 跨专业组队首选",
      beginner_friendly: true,
      summary: "全国规模最大、覆盖全部专业的基础性学科竞赛，通过建立数学模型与计算机仿真解决工程、经济或社会实际问题，是保研加分与培养科研论文撰写能力的必修课。",
      skill_roadmap: "组建建模+编程+写作铁三角 → 掌握评价类(TOPSIS/熵权法)、预测类(时间序列/机器学习)、优化类(规划模型/启发式算法) → 熟练使用 MATLAB/Python 与 LaTeX 排版",
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
      category_label: "创新创业与双创孵化",
      recommended_major_tracks: ["ALL_MAJORS", "FOOD_BIO_CHEM_MAT", "CS_AI_SOFTWARE", "ECON_MGMT_FINANCE", "MECH_VEHICLE_ROBO"],
      interest_tags: ["双创最高奖", "粮油食品特色赛道", "商业计划书", "路演答辩"],
      organizer: "教育部等十二部委联合主办",
      haut_host_college: "创新创业学院 / 教务处",
      registration_window: "每年 4月–6月校赛网评 · 7月–8月省赛 · 10月全国总决赛",
      team_mode: "3–15人跨学科组队（技术研发 + 商业模式 + 财务法务 + 路演PPT）",
      difficulty_label: "大一友好 · 全专业皆可参与",
      beginner_friendly: true,
      summary: "教育部排名第一的国家级顶尖双创赛事（含高教主赛道、红旅赛道、产业命题赛道），河工大在智慧粮油、食品工程、智能装备与新材料等交叉领域极具冲金优势。",
      skill_roadmap: "结合导师科研课题或河工大粮油食品/智能制造学科优势 → 撰写真实落地的商业计划书(BP) → 准备专利/软著/企业应用证明与高水准路演 PPT",
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
      interest_tags: ["ACM集训", "算法巅峰", "团队极限编程", "名企免笔试"],
      organizer: "ICPC 国际大学生程序设计竞赛基金会 / CCPC 组委会",
      haut_host_college: "信息科学与工程学院",
      registration_window: "每年 3月–5月省赛/邀请赛 · 9月–11月网络赛与区域赛",
      team_mode: "3人组队（共用 1 台电脑限时 5 小时攻克 10–13 道算法题）",
      difficulty_label: "硬核算法 · 冲击名企与保研顶峰",
      beginner_friendly: false,
      summary: "全球含金量最高的大学生算法与程序设计巅峰赛事，代表高校计算机学科硬核编程实力，获奖选手深受字节、腾讯、华为等核心研发部门青睐。",
      skill_roadmap: "洛谷/Codeforces 入门刷题 → 系统学习高级数据结构（线段树/树状数组/并查集） → 图论网络流、数论与博弈论 → 3 人组队分工模拟赛",
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
      interest_tags: ["自动驾驶竞速", "PID控制算法", "嵌入式硬件", "机器视觉"],
      organizer: "中国自动化学会",
      haut_host_college: "电气工程学院 / 机电工程学院",
      registration_window: "每年 11月发布赛题 → 次年 7月分赛区赛 / 8月全国总决赛",
      team_mode: "3–5人组队（机械车模调校 + 硬件驱动板 + 视觉/电磁循迹控制）",
      difficulty_label: "进阶实战 · 软硬件全栈闭环",
      beginner_friendly: true,
      summary: "以竞速智能车为载体的综合工程探索赛事，涵盖电磁循迹、摄像头视觉识别、平衡控制、越野信标等组别，亲手打造一辆风驰电掣的微型自动驾驶赛车。",
      skill_roadmap: "学习 C 语言与微控制器 PWM/编码器驱动 → 自行设计电机驱动与电源稳压 PCB → 图像二值化赛道提取与串级 PID 转向/速度闭环调参",
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
      interest_tags: ["机甲大师", "SolidWorks机械", "ROS2/机器视觉", "电控开发"],
      organizer: "共青团中央 / 全国学联",
      haut_host_college: "机电工程学院 / 电气工程学院",
      registration_window: "每年 9月–10月招新与赛季注册 · 次年 5月区域赛 / 8月全国赛",
      team_mode: "战队协作（机械结构 + 嵌入式电控 + 机器视觉算法 + 战队运营）",
      difficulty_label: "硬核工程 · 多学科团队协同",
      beginner_friendly: true,
      summary: "专为青年工程师打造的机器人科创盛事，融合机械传动设计、嵌入式电控、OpenCV/深度学习装甲板识别与战术对抗，堪称工科生的热血赛场。",
      skill_roadmap: "按方向选修：机械组掌握 SolidWorks 三维建模；电控组掌握 FreeRTOS 与 CAN 总线电机控制；算法组掌握相机标定、PNP 解算与神经网络推理",
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
      category_label: "创新创业与双创孵化",
      recommended_major_tracks: ["ALL_MAJORS", "FOOD_BIO_CHEM_MAT", "MECH_VEHICLE_ROBO", "CS_AI_SOFTWARE", "ECON_MGMT_FINANCE"],
      interest_tags: ["学术奥林匹克", "科技发明制作", "社会调研报告", "团委核心赛事"],
      organizer: "共青团中央 / 中国科协 / 教育部 / 全国学联",
      haut_host_college: "校团委",
      registration_window: "每年 11月–次年3月校赛立项 · 5月省赛 · 10月全国终审决赛",
      team_mode: "3–10人组队（大挑：学术科技发明制作/哲学社科调查；小挑：创业计划）",
      difficulty_label: "进阶科研 · 学术与社会调研并重",
      beginner_friendly: true,
      summary: "被誉为当代大学生科技创新的“奥林匹克”盛会，奇数年举办课外学术科技作品竞赛（大挑），偶数年举办中国大学生创业计划竞赛（小挑），文理工商学子均可找到专属赛道。",
      skill_roadmap: "大一加入导师课题组或大创项目 → 理工科聚焦硬核实物样机与核心论文/专利，人文经管聚焦扎实的田野调查问卷与政策建议报告",
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
      interest_tags: ["CTF夺旗赛", "Web渗透与逆向", "密码学", "安全创新作品"],
      organizer: "教育部高等学校网络空间安全专业教学指导委员会",
      haut_host_college: "信息科学与工程学院",
      registration_window: "每年 3月–4月报名 · 5月分区赛 · 7月全国总决赛",
      team_mode: "4人组队（创新实践能力赛 CTF 解题/AWD 攻防 · 安全作品赛）",
      difficulty_label: "进阶挑战 · 网络攻防实战",
      beginner_friendly: false,
      summary: "网络空间安全与计算机领域权威国家级赛事，分为 CTF 夺旗攻防实战赛与信息安全作品赛两大方向，全面锤炼漏洞挖掘、逆向工程、密码学与安全系统研发能力。",
      skill_roadmap: "入门 Linux 与计算机网络协议 → 选定 Web 渗透、Reverse 逆向、Pwn 二进制漏洞或 Crypto 密码学方向 → 在 CTFHub/BUUCTF 靶场持续刷题实战",
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
      interest_tags: ["App/小程序开发", "AI大模型应用", "数据可视化", "数媒交互设计"],
      organizer: "教育部高等学校计算机类专业教学指导委员会等",
      haut_host_college: "人工智能与大数据学院 / 信息科学与工程学院",
      registration_window: "每年 3月–4月校赛选拔 · 5月省赛 · 7月–8月全国总决赛",
      team_mode: "1–5人组队（软件应用开发 / 人工智能应用 / 信息可视化 / 数媒动漫游戏）",
      difficulty_label: "大一友好 · 作品导向极易上手",
      beginner_friendly: true,
      summary: "面向全校各专业学生的作品类计算机大赛，不考限时算法题，而是提交完整软件、小程序、AI 应用、数据可视化或数媒动画作品，非常适合喜欢做项目的同学。",
      skill_roadmap: "确定实用选题（如校园工具、智慧农业/粮仓监测、中华传统文化数媒展示） → 完成前后端/移动端开发或交互设计 → 录制高清演示视频与设计说明书",
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
      difficulty_label: "进阶工程 · 机械学科王牌赛",
      beginner_friendly: true,
      summary: "国内机械工程领域最高水平的大学生学科竞赛，聚焦兴农机械、仿生机械、高性能智能装备等主题，要求完成从机构原理构思、三维建模仿真到全尺寸实物样机制作。",
      skill_roadmap: "学透机械原理与机械设计基础 → 熟练掌握 SolidWorks/UG 三维装配、运动仿真与 ANSYS 有限元分析 → 联合电控同学完成样机加工调试",
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
      category_label: "创新创业与双创孵化",
      recommended_major_tracks: ["ECON_MGMT_FINANCE", "CS_AI_SOFTWARE", "FOOD_BIO_CHEM_MAT", "DESIGN_MEDIA_FOREIGN", "ALL_MAJORS"],
      interest_tags: ["电商运营与实战", "乡村振兴助农", "新媒体营销", "零门槛双创"],
      organizer: "全国电子商务产教融合创新联盟",
      haut_host_college: "经济贸易学院 / 管理学院",
      registration_window: "每年 10月–12月官网注册报名 · 次年 3月–4月校赛 / 5月省赛 / 7月国赛",
      team_mode: "3–5人组队（常规赛 + 跨境电商/乡村振兴/产学用实战赛）",
      difficulty_label: "大一友好 · 经管与工科跨界首选",
      beginner_friendly: true,
      summary: "教育部白名单中对经贸、管理、营销与工科交叉最友好的全国性大赛，强调真实商业策划、跨境电商、直播助农与数字经济创新，大一新生即可快速组队参赛。",
      skill_roadmap: "年底前务必在官网完成团队注册 → 结合河南农产品/粮油品牌或校园数字化需求选定赛道 → 打磨市场调研数据、盈利模型与实战运营佐证材料",
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
      interest_tags: ["海报/IP插画", "二维/三维动画", "短视频拍摄", "品牌广告策划"],
      organizer: "中国高等教育学会广告教育专业委员会",
      haut_host_college: "设计艺术学院 / 新闻与传播学院",
      registration_window: "每年 3月–5月企业命题发布与创作 · 6月省赛 · 8月全国评审",
      team_mode: "1–3人（平面/文案/UI）或 1–5人（视频/动画/广播/策划案）",
      difficulty_label: "大一友好 · 创意与ACG爱好者天堂",
      beginner_friendly: true,
      summary: "文科、艺术设计与数字媒体领域规模最大的教育部白名单赛事，由知名品牌提供真实商业命题，涵盖平面设计、动画、短视频、互动H5、广播与广告语创作。",
      skill_roadmap: "下载当季企业命题策略单 → 针对品牌痛点提炼核心创意概念 → 运用 PS/AI/Blender/AE/PR 完成视觉、动画或视频成片，严守原创规范",
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
      interest_tags: ["英语综合能力", "四六级/考研神助攻", "保研外语加分", "个人赛"],
      organizer: "国际英语外语教师协会中国英语外语教师协会 / 高等学校大学外语教学研究会",
      haut_host_college: "外语学院",
      registration_window: "每年 2月–3月报名 · 4月中旬初赛 / 5月中旬全国决赛",
      team_mode: "个人赛（A类研究生 / B类英语专业 / C类非英语本科 / D类艺体类）",
      difficulty_label: "大一友好 · 按校内比例评奖",
      beginner_friendly: true,
      summary: "全国唯一统考的大学生英语综合能力竞赛（C类面向全校非英语专业本科生），按各校参赛人数比例直接评定全国特等奖及一、二、三等奖，获奖率高且保研综测高度认可。",
      skill_roadmap: "巩固四六级高频词汇与长难句阅读 → 针对性训练赛题特有的智力推理题(IQ)、篇章改错、英汉翻译与图表应用文写作 → 限时刷近 5 年真题卷",
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
      title: "河工大合作社团与学科竞赛云端直通车",
      content: "官方合作社团招新 QQ 群与教育部白名单学科竞赛指南已接入云端实时下发，支持按专业与兴趣匹配赛事、直达官网并一键呼起手机 QQ 加群组队。",
      tag: "云端实时同步",
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
        activity_venue: "莲花街校区 8号教学楼",
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
  constructor({ snapshotPath = null, pricingMicropeach = DEFAULT_RESERVATION_PRICE_MICROPEACH } = {}) {
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
