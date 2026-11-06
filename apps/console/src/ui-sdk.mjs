/**
 * ============================================================================
 * XPeach Web UI Component SDK (ui-sdk.mjs)
 * Standardized, zero-hardcoding UI primitives aligned 1:1 with Android's
 * `:core:designsystem` (`XPeachSdkComponents.kt` & `HautTheme.kt`).
 * ============================================================================
 */

export function cleanDisplayText(val, fallback = "") {
  if (val === null || val === undefined) return fallback;
  const trimmed = String(val).trim();
  if (!trimmed) return fallback;
  const lower = trimmed.toLowerCase();
  if (lower === "null" || lower === "undefined" || lower === "none" || lower === "nil") {
    return fallback;
  }
  const cleaned = trimmed
    .replace(/\s*·\s*null\b/gi, "")
    .replace(/\bnull\s*·\s*/gi, "")
    .trim();
  return cleaned || fallback;
}

export function escapeHtml(val) {
  return String(cleanDisplayText(val, ""))
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function xpeachBadge(text, tone = "neutral") {
  const safeText = escapeHtml(text);
  if (!safeText) return "";
  const toneClass =
    tone === "primary"
      ? "xp-badge--primary"
      : tone === "peach"
        ? "xp-badge--peach"
        : tone === "success"
          ? "xp-badge--success"
          : tone === "warning"
            ? "xp-badge--warning"
            : tone === "danger"
              ? "xp-badge--danger"
              : "";
  return `<span class="xp-badge ${toneClass}">${safeText}</span>`;
}

export function xpeachStatusDot(text, tone = "primary") {
  const safeText = escapeHtml(text);
  if (!safeText) return "";
  const toneClass =
    tone === "success"
      ? "xp-status-dot--success"
      : tone === "peach"
        ? "xp-status-dot--peach"
        : "";
  return `<span class="xp-status-dot ${toneClass}">${safeText}</span>`;
}

export function xpeachBentoTile({ label, value, hint, badge = "", valueId = "" }) {
  return `
    <div class="xp-bento-tile">
      <div class="xp-bento-top">
        <span class="xp-bento-label">${escapeHtml(label)}</span>
        ${badge}
      </div>
      <div class="xp-bento-value" ${valueId ? `id="${escapeHtml(valueId)}"` : ""}>${escapeHtml(value)}</div>
      <div class="xp-bento-hint">${escapeHtml(hint)}</div>
    </div>`;
}

export function xpeachEmptyState({
  icon = "✨",
  title,
  subtitle = "",
  actionLabel = "",
  actionHref = "",
  actionId = ""
}) {
  return `
    <div class="xp-empty-state">
      <div class="xp-empty-icon" aria-hidden="true">${escapeHtml(icon)}</div>
      <h3 class="xp-empty-title">${escapeHtml(title)}</h3>
      ${subtitle ? `<p class="xp-empty-subtitle">${escapeHtml(subtitle)}</p>` : ""}
      ${
        actionLabel && actionHref
          ? `<a class="xp-pill xp-pill--active" href="${escapeHtml(actionHref)}">${escapeHtml(actionLabel)}</a>`
          : actionLabel && actionId
            ? `<button type="button" class="xp-pill xp-pill--active" id="${escapeHtml(actionId)}">${escapeHtml(actionLabel)}</button>`
            : ""
      }
    </div>`;
}

export function xpeachBulletinHeroCard({ title, content, tag, version = 3, clubsCount = 3, competitionsCount = 14 }) {
  return `
    <section class="xp-card xp-card--accent" aria-label="社区云控公告">
      <div class="xp-entity-header">
        <div class="xp-icon-box" aria-hidden="true">📢</div>
        <div class="xp-entity-title-col">
          <div class="xp-badge-flow" style="justify-content: space-between;">
            ${tag ? xpeachStatusDot(tag, "primary") : ""}
            ${xpeachBadge(`云控 v${version} · ${clubsCount} 社团 · ${competitionsCount} 竞赛`, "primary")}
          </div>
          <h2 class="xp-entity-title">${escapeHtml(title)}</h2>
          ${content ? `<p class="xp-entity-summary" style="margin-top: 2px;">${escapeHtml(content)}</p>` : ""}
        </div>
      </div>
    </section>`;
}

const CLUB_CATEGORY_META = {
  TECH_INNOVATION: { label: "科技创新", icon: "💻", boxClass: "" },
  ART_PERFORMANCE: { label: "文艺展演", icon: "🎨", boxClass: "xp-icon-box--pink" },
  ACADEMIC_CULTURE: { label: "学术文化", icon: "📖", boxClass: "" },
  SPORTS_FITNESS: { label: "体育竞技", icon: "🏆", boxClass: "xp-icon-box--success" },
  VOLUNTEER_ORG: { label: "志愿与组织", icon: "🤝", boxClass: "xp-icon-box--peach" }
};

export function xpeachClubCard(club, { isAdmin = false } = {}) {
  const catKey = String(club.category || "TECH_INNOVATION").toUpperCase();
  const catMeta = CLUB_CATEGORY_META[catKey] || CLUB_CATEGORY_META.TECH_INNOVATION;
  const categoryLabel = cleanDisplayText(club.category_label, catMeta.label);
  const unitLabel = cleanDisplayText(club.affiliated_unit, "校团委社团管理部");
  const venueLabel = cleanDisplayText(club.activity_venue, "大学生活动中心");
  const qqGroup = cleanDisplayText(club.qq_group_number, "-");
  const highlights = Array.isArray(club.highlights) ? club.highlights.filter(Boolean) : [];
  const clubJsonAttr = escapeHtml(JSON.stringify(club));

  return `
    <article class="xp-card xp-card--interactive" data-club-card="${escapeHtml(club.id)}" data-club-category="${escapeHtml(catKey)}" data-club-search="${escapeHtml(`${club.name} ${categoryLabel} ${unitLabel} ${venueLabel} ${qqGroup} ${highlights.join(" ")}`.toLowerCase())}">
      <!-- Layer 1: Identity Header (Icon + Full-Width Title + Wrapping Badges) -->
      <div class="xp-entity-header">
        <div class="xp-icon-box ${catMeta.boxClass}" aria-hidden="true">${catMeta.icon}</div>
        <div class="xp-entity-title-col">
          <h3 class="xp-entity-title">${escapeHtml(club.name)}</h3>
          <div class="xp-badge-flow">
            ${club.pinned ? xpeachBadge("官方合作 · 置顶", "primary") : ""}
            ${xpeachBadge(categoryLabel, "peach")}
            ${xpeachBadge(unitLabel, "neutral")}
            ${
              isAdmin
                ? club.enabled !== false
                  ? xpeachBadge(`启用 · #${club.sort_order ?? 10}`, "success")
                  : xpeachBadge("已隐藏", "danger")
                : ""
            }
          </div>
        </div>
      </div>

      <!-- Layer 2: Unobstructed Full-Width Summary -->
      ${
        club.summary
          ? `<p class="xp-entity-summary">${escapeHtml(club.summary)}</p>`
          : ""
      }

      <!-- Layer 3: Highlight Tag Chips -->
      ${
        highlights.length > 0
          ? `<div class="xp-tag-flow">
              ${highlights.map((tag) => `<span class="xp-tag-chip">#${escapeHtml(tag)}</span>`).join("")}
            </div>`
          : ""
      }

      <!-- Layer 4: Recessed Venue & Official QQ Group Well -->
      <div class="xp-well" style="margin-top: 12px; display: flex; flex-direction: column; gap: 6px;">
        <div class="xp-meta-row">
          <span>📍 常规活动场地：</span>
          <strong>${escapeHtml(venueLabel)}</strong>
        </div>
        <div class="xp-meta-row">
          <span>💬 招新/交流 QQ 群：</span>
          <span class="xp-meta-highlight">${escapeHtml(qqGroup)}</span>
        </div>
      </div>

      <!-- Layer 5: Dedicated Action Bar -->
      <div class="xp-action-bar">
        ${
          isAdmin
            ? `<div class="xp-action-group">
                <button type="button" class="xp-pill xp-pill--compact" data-edit-club='${clubJsonAttr}'>编辑/改群号</button>
                <button type="button" class="xp-pill xp-pill--compact" data-toggle-pin-club='${clubJsonAttr}'>${club.pinned ? "取消置顶" : "置顶"}</button>
                <button type="button" class="xp-pill xp-pill--compact" data-toggle-enable-club='${clubJsonAttr}'>${club.enabled !== false ? "隐藏" : "启用"}</button>
                <button type="button" class="xp-pill xp-pill--compact" data-delete-club="${escapeHtml(club.id)}">删除</button>
              </div>`
            : `<span class="xp-status-dot xp-status-dot--success">官方认证社团</span>`
        }
        <div class="xp-action-group">
          <button type="button" class="xp-pill xp-pill--compact" data-copy-qq="${escapeHtml(qqGroup)}" data-copy-club-name="${escapeHtml(club.name)}">复制群号</button>
          <a class="xp-pill xp-pill--active xp-pill--compact" href="mqqapi://card/show_pslcard?src_type=internal&version=1&uin=${encodeURIComponent(qqGroup)}&card_type=group&source=qrcode" data-copy-qq="${escapeHtml(qqGroup)}" data-copy-club-name="${escapeHtml(club.name)}">一键加群</a>
        </div>
      </div>
    </article>`;
}

export function xpeachChannelCard(channel, { isAdmin = false } = {}) {
  const chJsonAttr = escapeHtml(JSON.stringify(channel));
  return `
    <article class="xp-card xp-card--interactive">
      <div class="xp-entity-header">
        <div class="xp-icon-box" aria-hidden="true">💬</div>
        <div class="xp-entity-title-col">
          <h3 class="xp-entity-title">${escapeHtml(channel.title)}</h3>
          <div class="xp-badge-flow">
            ${channel.pinned ? xpeachBadge("置顶频道", "primary") : ""}
            ${xpeachBadge(channel.tag_label || "频道", "peach")}
            ${
              isAdmin
                ? channel.enabled !== false
                  ? xpeachBadge(`启用 · #${channel.sort_order ?? 10}`, "success")
                  : xpeachBadge("已隐藏", "danger")
                : ""
            }
          </div>
        </div>
      </div>
      ${channel.subtitle ? `<p class="xp-entity-summary">${escapeHtml(channel.subtitle)}</p>` : ""}
      <div class="xp-well" style="margin-top: 10px;">
        <div class="xp-meta-row">
          <span>🔗 频道链接：</span>
          <code style="word-break: break-all;">${escapeHtml(channel.invite_url || "https://pd.qq.com")}</code>
        </div>
      </div>
      <div class="xp-action-bar">
        ${
          isAdmin
            ? `<div class="xp-action-group">
                <button type="button" class="xp-pill xp-pill--compact" data-edit-channel='${chJsonAttr}'>编辑</button>
                <button type="button" class="xp-pill xp-pill--compact" data-toggle-pin-channel='${chJsonAttr}'>${channel.pinned ? "取消置顶" : "置顶"}</button>
                <button type="button" class="xp-pill xp-pill--compact" data-toggle-enable-channel='${chJsonAttr}'>${channel.enabled !== false ? "隐藏" : "启用"}</button>
                <button type="button" class="xp-pill xp-pill--compact" data-delete-channel="${escapeHtml(channel.id)}">删除</button>
              </div>`
            : `<span></span>`
        }
        <a class="xp-pill xp-pill--active xp-pill--compact" href="${escapeHtml(channel.invite_url || "#")}" target="_blank" rel="noopener">进入频道</a>
      </div>
    </article>`;
}

const COMPETITION_CATEGORY_META = {
  ALGO_PROGRAMMING: { label: "算法与程序设计", icon: "💻", boxClass: "" },
  ELECTRONICS_ROBO: { label: "电子与机器人硬件", icon: "🤖", boxClass: "xp-icon-box--peach" },
  MATH_MODELING: { label: "数学建模与数据分析", icon: "📐", boxClass: "" },
  INNOVATION_ENTREPRENEURSHIP: { label: "创新创业与双创孵化", icon: "🚀", boxClass: "xp-icon-box--peach" },
  CYBER_SECURITY_AI: { label: "网安与人工智能", icon: "🛡️", boxClass: "xp-icon-box--success" },
  DIGITAL_MEDIA_ART: { label: "数媒创意与外语综合", icon: "🎨", boxClass: "xp-icon-box--pink" }
};

const MAJOR_TRACK_LABELS = {
  ALL_MAJORS: "全专业通用",
  CS_AI_SOFTWARE: "计算机/软件/人工智能",
  EE_AUTOMATION_IOT: "电气/自动化/通信物联",
  MECH_VEHICLE_ROBO: "机械/机电/智能制造",
  FOOD_BIO_CHEM_MAT: "粮油食品/生工/化工材料",
  ECON_MGMT_FINANCE: "经贸/管理/金融电商",
  DESIGN_MEDIA_FOREIGN: "设计艺术/新传/外语文法",
  MATH_PHYSICS_CIVIL: "数理统计/土木建筑"
};

export function xpeachCompetitionCard(comp, { isAdmin = false } = {}) {
  const catKey = String(comp.category || "INNOVATION_ENTREPRENEURSHIP").toUpperCase();
  const catMeta = COMPETITION_CATEGORY_META[catKey] || COMPETITION_CATEGORY_META.INNOVATION_ENTREPRENEURSHIP;
  const categoryLabel = cleanDisplayText(comp.category_label, catMeta.label);
  const tracks = Array.isArray(comp.recommended_major_tracks) && comp.recommended_major_tracks.length > 0
    ? comp.recommended_major_tracks
    : ["ALL_MAJORS"];
  const majorLabels = tracks.map((t) => MAJOR_TRACK_LABELS[t] || t).join(" · ");
  const tags = Array.isArray(comp.interest_tags) ? comp.interest_tags.filter(Boolean) : [];
  const compJsonAttr = escapeHtml(JSON.stringify(comp));
  const partnerClubName = cleanDisplayText(comp.partner_club_name, "");
  const partnerClubQq = cleanDisplayText(comp.partner_club_qq, "");
  const officialUrl = cleanDisplayText(comp.official_website_url, "https://cy.ncss.cn");

  return `
    <article class="xp-card xp-card--interactive" data-comp-card="${escapeHtml(comp.id)}" data-comp-category="${escapeHtml(catKey)}" data-comp-majors="${escapeHtml(tracks.join(","))}" data-comp-beginner="${comp.beginner_friendly !== false ? "true" : "false"}" data-comp-search="${escapeHtml(`${comp.title} ${comp.short_title || ""} ${comp.tier_badge || ""} ${categoryLabel} ${majorLabels} ${comp.organizer || ""} ${comp.haut_host_college || ""} ${comp.summary || ""} ${comp.skill_roadmap || ""} ${partnerClubName} ${tags.join(" ")}`.toLowerCase())}">
      <!-- Layer 1: Identity Header (Icon + Full-Width Title + Wrapping Badges) -->
      <div class="xp-entity-header">
        <div class="xp-icon-box ${catMeta.boxClass}" aria-hidden="true">${catMeta.icon}</div>
        <div class="xp-entity-title-col">
          <h3 class="xp-entity-title">${escapeHtml(comp.title)}</h3>
          <div class="xp-badge-flow">
            ${comp.pinned ? xpeachBadge("重点推荐", "primary") : ""}
            ${xpeachBadge(comp.tier_badge || "教育部白名单 A 类赛事", "peach")}
            ${xpeachBadge(comp.difficulty_label || (comp.beginner_friendly !== false ? "大一友好" : "进阶挑战"), comp.beginner_friendly !== false ? "success" : "neutral")}
            ${
              isAdmin
                ? comp.enabled !== false
                  ? xpeachBadge(`启用 · #${comp.sort_order ?? 10}`, "success")
                  : xpeachBadge("已隐藏", "danger")
                : ""
            }
          </div>
        </div>
      </div>

      <!-- Layer 2: Full-Width Competition Summary -->
      ${comp.summary ? `<p class="xp-entity-summary">${escapeHtml(comp.summary)}</p>` : ""}

      <!-- Layer 3: Interest & Capability Tag Chips -->
      ${
        tags.length > 0
          ? `<div class="xp-tag-flow">
              ${tags.map((tag) => `<span class="xp-tag-chip">#${escapeHtml(tag)}</span>`).join("")}
            </div>`
          : ""
      }

      <!-- Layer 4: Recessed Major Track, Roadmap, Schedule & Partner Club Well -->
      <div class="xp-well" style="margin-top: 12px; display: flex; flex-direction: column; gap: 6px;">
        <div class="xp-meta-row">
          <span>🎓 适合专业赛道：</span>
          <strong>${escapeHtml(majorLabels)}</strong>
        </div>
        ${
          comp.skill_roadmap
            ? `<div class="xp-meta-row" style="align-items: flex-start;">
                <span style="white-space: nowrap;">🧭 备赛成长路线：</span>
                <span>${escapeHtml(comp.skill_roadmap)}</span>
              </div>`
            : ""
        }
        <div class="xp-meta-row">
          <span>🗓️ 报名与赛制：</span>
          <span>${escapeHtml(comp.registration_window || "关注官网")} · ${escapeHtml(comp.team_mode || "团队/个人")}</span>
        </div>
        <div class="xp-meta-row">
          <span>🏛️ 校内组织：</span>
          <span>${escapeHtml(comp.haut_host_college || "创新创业学院")}（${escapeHtml(comp.organizer || "全国组委会")}）</span>
        </div>
        ${
          partnerClubName && partnerClubQq
            ? `<div class="xp-meta-row">
                <span>🤝 组队合作社团：</span>
                <span class="xp-meta-highlight">${escapeHtml(partnerClubName)}（QQ 群：${escapeHtml(partnerClubQq)}）</span>
              </div>`
            : ""
        }
        <div class="xp-meta-row">
          <span>🌐 赛事官网：</span>
          <a href="${escapeHtml(officialUrl)}" target="_blank" rel="noopener" class="xp-meta-highlight" style="text-decoration: none; word-break: break-all;">${escapeHtml(officialUrl)}</a>
        </div>
      </div>

      <!-- Layer 5: Dedicated Action Bar -->
      <div class="xp-action-bar">
        ${
          isAdmin
            ? `<div class="xp-action-group">
                <button type="button" class="xp-pill xp-pill--compact" data-edit-comp='${compJsonAttr}'>编辑赛事</button>
                <button type="button" class="xp-pill xp-pill--compact" data-toggle-pin-comp='${compJsonAttr}'>${comp.pinned ? "取消置顶" : "置顶"}</button>
                <button type="button" class="xp-pill xp-pill--compact" data-toggle-enable-comp='${compJsonAttr}'>${comp.enabled !== false ? "隐藏" : "启用"}</button>
                <button type="button" class="xp-pill xp-pill--compact" data-delete-comp="${escapeHtml(comp.id)}">删除</button>
              </div>`
            : `<button type="button" class="xp-pill xp-pill--compact" data-copy-url="${escapeHtml(officialUrl)}" data-copy-comp-name="${escapeHtml(comp.short_title || comp.title)}">复制官网链接</button>`
        }
        <div class="xp-action-group">
          ${
            partnerClubName && partnerClubQq
              ? `<a class="xp-pill xp-pill--compact" href="mqqapi://card/show_pslcard?src_type=internal&version=1&uin=${encodeURIComponent(partnerClubQq)}&card_type=group&source=qrcode" data-copy-qq="${escapeHtml(partnerClubQq)}" data-copy-club-name="${escapeHtml(partnerClubName)}">加社团群组队</a>`
              : ""
          }
          <a class="xp-pill xp-pill--active xp-pill--compact" href="${escapeHtml(officialUrl)}" target="_blank" rel="noopener">打开竞赛官网 ↗</a>
        </div>
      </div>
    </article>`;
}
