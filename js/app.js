/* ==========================================================================
   LearnLog — app logic
   Everything runs client-side. No network calls, no accounts.
   ========================================================================== */

const STATUS = { WANT: "want", LEARNING: "learning", CAN: "can" };
const STATUS_LABEL = { want: "Want to Learn", learning: "Learning", can: "Can Do" };
const STATUS_SHORT = { want: "Want", learning: "Learning", can: "Can Do" };

// Keep in sync with CACHE_VERSION in sw.js when shipping an update — there's
// no build step to do this automatically.
const APP_VERSION = "learnlog-v5";

const CATEGORY_ICON_OPTIONS = ["🏷️", "🤸", "🤾", "🏃", "🚵", "📷", "🎬", "🏍️", "🎨", "🎯", "⭐", "🎵", "🏊", "🧗"];

const state = {
  skills: [],
  categories: [],
  settings: {
    theme: "dark",
    sortMode: { want: "manual", learning: "manual", can: "manual" },
    lastBackupAt: null,
  },
  page: "home",
  activeTab: STATUS.LEARNING,
  searchQuery: "",
  searchCategory: null, // null = all
  searchFavoritesOnly: false,
  editingSkillId: null, // null = adding new
  editingMedia: null, // { blob, mime, kind } staged in the skill form
  actionSkillId: null, // skill targeted by the status-change sheet
  detailSkillId: null,
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

// Light haptic tap on supported devices (Android Chrome). iOS Safari does not
// expose the Vibration API to web pages, so this is a safe no-op there.
function haptic(pattern = 10) {
  try {
    if (navigator.vibrate) navigator.vibrate(pattern);
  } catch (e) {
    /* ignore */
  }
}

let dragState = null; // active pointer-drag session, see initDragHandle()
let openSwipeCard = null; // { wrap, card, close } — the card currently revealed by a swipe, if any
let deferredInstallPrompt = null; // captured beforeinstallprompt event, Android/Chrome only

/* ---------------------------------------------------------------------- */
/* Bootstrapping                                                            */
/* ---------------------------------------------------------------------- */

async function init() {
  registerServiceWorker();
  wireStaticEvents();
  wireInstallPrompt();

  // Permanently remove anything that's been in Recently Deleted past the
  // retention window before we load and render.
  await LearnLogDB.purgeExpiredDeletedSkills();

  const [skills, categories, theme, sortMode, lastBackupAt] = await Promise.all([
    LearnLogDB.getAllSkills(),
    LearnLogDB.getAllCategories(),
    LearnLogDB.getSetting("theme", "dark"),
    LearnLogDB.getSetting("sortMode", { want: "manual", learning: "manual", can: "manual" }),
    LearnLogDB.getSetting("lastBackupAt", null),
  ]);

  state.skills = skills;
  state.categories = categories;
  state.settings.theme = theme;
  state.settings.sortMode = sortMode;
  state.settings.lastBackupAt = lastBackupAt;

  applyTheme(theme);
  renderAll();
  renderBackupHint();
  renderDeletedList();
}

function registerServiceWorker() {
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./sw.js").catch((err) => {
        console.warn("Service worker registration failed:", err);
      });
    });
  }
}

// Android/Chrome only: the browser fires beforeinstallprompt when it decides
// the app is installable, and we capture it instead of letting the browser
// show its own mini-infobar, so we can show it via our own on-brand banner
// on the Home page instead. iOS Safari never fires this event — there, the
// banner just stays hidden and users install via Share > Add to Home Screen
// (as explained in the README), which needs no JS hook at all.
function wireInstallPrompt() {
  const banner = $id("installBanner");
  if (!banner) return;

  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    banner.classList.remove("hidden");
  });

  window.addEventListener("appinstalled", () => {
    deferredInstallPrompt = null;
    banner.classList.add("hidden");
  });

  $id("installBtn")?.addEventListener("click", async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    banner.classList.add("hidden");
  });

  $id("installDismissBtn")?.addEventListener("click", () => {
    banner.classList.add("hidden");
  });
}

/* ---------------------------------------------------------------------- */
/* Theme                                                                    */
/* ---------------------------------------------------------------------- */

const systemDarkQuery = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;

function resolveTheme(pref) {
  if (pref === "auto") return systemDarkQuery && !systemDarkQuery.matches ? "light" : "dark";
  return pref;
}

// `pref` is the user's stored preference: "dark" | "light" | "auto".
// The actual data-theme attribute always resolves to "dark" or "light".
function applyTheme(pref) {
  const resolved = resolveTheme(pref);
  document.documentElement.setAttribute("data-theme", resolved);
  const meta = $('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", resolved === "dark" ? "#0d0d0d" : "#faf9f7");
  $$("#themeSegmented button").forEach((b) => {
    const isActive = b.dataset.theme === pref;
    b.classList.toggle("active", isActive);
    b.setAttribute("aria-pressed", String(isActive));
  });
}

async function setTheme(pref) {
  state.settings.theme = pref;
  applyTheme(pref);
  await LearnLogDB.setSetting("theme", pref);
}

if (systemDarkQuery) {
  const onSystemThemeChange = () => {
    if (state.settings.theme === "auto") applyTheme("auto");
  };
  if (systemDarkQuery.addEventListener) systemDarkQuery.addEventListener("change", onSystemThemeChange);
  else if (systemDarkQuery.addListener) systemDarkQuery.addListener(onSystemThemeChange); // older Safari
}

/* ---------------------------------------------------------------------- */
/* Data helpers                                                             */
/* ---------------------------------------------------------------------- */

function categoryName(id) {
  const c = state.categories.find((c) => c.id === id);
  return c ? c.name : "Uncategorized";
}

function skillsByStatus(status) {
  return state.skills.filter((s) => s.status === status);
}

function sortSkills(skills, mode) {
  const copy = [...skills];
  if (mode === "alpha") {
    copy.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  } else {
    copy.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  }
  return copy;
}

async function refreshSkills() {
  state.skills = await LearnLogDB.getAllSkills();
}

async function refreshCategories() {
  state.categories = await LearnLogDB.getAllCategories();
}

/* ---------------------------------------------------------------------- */
/* Rendering — orchestration                                                */
/* ---------------------------------------------------------------------- */

function renderAll() {
  renderSummary();
  renderTabs();
  renderHomeList();
  renderSearchPage();
  renderCategoriesPage();
}

function renderSummary() {
  const learning = skillsByStatus(STATUS.LEARNING).length;
  const can = skillsByStatus(STATUS.CAN).length;
  $("#summaryLine").textContent = `${learning} learning · ${can} can do`;
}

function renderTabs() {
  $$(".tab").forEach((tab) => {
    const status = tab.dataset.status;
    const isActive = status === state.activeTab;
    tab.classList.toggle("active", isActive);
    tab.setAttribute("aria-selected", String(isActive));
    $(".tab-count", tab).textContent = skillsByStatus(status).length;
  });
}

/* ---------------------------------------------------------------------- */
/* Home page                                                                */
/* ---------------------------------------------------------------------- */

function renderHomeList() {
  const mode = state.settings.sortMode[state.activeTab] || "manual";
  $$("#sectionToolbar .sort-toggle button").forEach((b) => {
    const isActive = b.dataset.sort === mode;
    b.classList.toggle("active", isActive);
    b.setAttribute("aria-pressed", String(isActive));
  });

  const list = sortSkills(skillsByStatus(state.activeTab), mode);
  $("#sectionCount").textContent = `${list.length} ${list.length === 1 ? "skill" : "skills"}`;

  const container = $("#skillList");
  container.innerHTML = "";
  openSwipeCard = null;

  if (list.length === 0) {
    container.appendChild(emptyState(state.activeTab));
    return;
  }

  list.forEach((skill, idx) => {
    container.appendChild(buildSkillCard(skill, { manual: mode === "manual", idx, total: list.length }));
  });
}

function emptyState(status) {
  const el = document.createElement("div");
  el.className = "empty-state";
  const copy = {
    want: ["🌱", "Nothing on your list yet.", "Add a skill you'd like to learn someday."],
    learning: ["🧗", "Not learning anything right now.", "Move a skill here once you start practicing it."],
    can: ["✅", "No skills marked as Can Do yet.", "Once you've got something down, add it here."],
  }[status];
  el.innerHTML = `<span class="emoji">${copy[0]}</span><p>${copy[1]}<br>${copy[2]}</p>`;
  return el;
}

function buildSkillCard(skill, opts) {
  const wrap = document.createElement("div");
  wrap.className = "skill-card-wrap";
  wrap.dataset.id = skill.id;

  const deleteAction = document.createElement("button");
  deleteAction.type = "button";
  deleteAction.className = "card-delete-action";
  deleteAction.textContent = "Delete";
  deleteAction.dataset.action = "swipe-delete";
  deleteAction.setAttribute("aria-label", `Delete ${skill.name}`);

  const card = document.createElement("div");
  card.className = "skill-card";
  card.dataset.id = skill.id;

  let handle = null;
  if (opts.manual && opts.total > 1) {
    handle = document.createElement("button");
    handle.type = "button";
    handle.className = "drag-handle";
    handle.textContent = "⠿";
    handle.setAttribute("aria-label", `Reorder ${skill.name}. Use arrow keys to move up or down.`);
    handle.tabIndex = 0;
  }

  const thumb = document.createElement("div");
  thumb.className = "thumb";
  if (skill.media && skill.media.blob) {
    const url = URL.createObjectURL(skill.media.blob);
    if (skill.media.kind === "video") {
      thumb.innerHTML = `<video src="${url}" muted></video>`;
    } else {
      thumb.innerHTML = `<img src="${url}" alt="">`;
    }
  } else {
    const cat = state.categories.find((c) => c.id === skill.category);
    thumb.textContent = (cat && cat.icon) || LearnLogDB.DEFAULT_ICON;
  }

  const info = document.createElement("div");
  info.className = "info";
  info.innerHTML = `
    <div class="name-row">
      <span class="name">${escapeHTML(skill.name)}</span>
      <button class="star" data-action="toggle-fav" aria-label="Toggle favorite for ${escapeHTML(skill.name)}" aria-pressed="${!!skill.favorite}">${skill.favorite ? "★" : "☆"}</button>
    </div>
    <div class="category">${escapeHTML(categoryName(skill.category))}</div>
  `;

  const actions = document.createElement("div");
  actions.className = "card-actions";

  const statusBtn = document.createElement("button");
  statusBtn.className = "status-btn";
  statusBtn.dataset.action = "change-status";
  statusBtn.textContent = "Move ›";
  statusBtn.setAttribute("aria-label", `Change status for ${skill.name}`);
  actions.appendChild(statusBtn);

  if (handle) {
    card.append(handle, thumb, info, actions);
    attachDragHandle(handle, card, skill.id);
  } else {
    card.append(thumb, info, actions);
  }

  attachSwipeHandlers(wrap, card);
  wrap.append(deleteAction, card);
  return wrap;
}

/* ---------------------------------------------------------------------- */
/* Swipe-to-delete (pointer events)                                         */
/* ---------------------------------------------------------------------- */

function closeOpenSwipe() {
  if (openSwipeCard) openSwipeCard.close();
}

function attachSwipeHandlers(wrap, card) {
  const REVEAL = 84;
  let startX = 0;
  let startY = 0;
  let dx = 0;
  let tracking = false;
  let decided = false;
  let horizontal = false;
  let isOpen = false;

  const setOpen = (open) => {
    isOpen = open;
    card.style.transform = open ? `translateX(-${REVEAL}px)` : "";
    if (open) {
      if (openSwipeCard && openSwipeCard.card !== card) closeOpenSwipe();
      openSwipeCard = { wrap, card, close: () => setOpen(false) };
    } else if (openSwipeCard && openSwipeCard.card === card) {
      openSwipeCard = null;
    }
  };

  card.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".drag-handle")) return; // vertical reorder owns this gesture
    if (e.pointerType === "mouse" && e.button !== 0) return;
    startX = e.clientX;
    startY = e.clientY;
    dx = 0;
    tracking = true;
    decided = false;
  });

  card.addEventListener("pointermove", (e) => {
    if (!tracking) return;
    const rawDx = e.clientX - startX;
    const rawDy = e.clientY - startY;

    if (!decided) {
      if (Math.abs(rawDx) < 8 && Math.abs(rawDy) < 8) return; // not enough movement to tell yet
      decided = true;
      horizontal = Math.abs(rawDx) > Math.abs(rawDy);
      if (!horizontal) {
        tracking = false; // vertical intent — let the page scroll normally
        return;
      }
      card.classList.add("swiping");
    }
    if (!horizontal) return;
    e.preventDefault();
    const base = isOpen ? -REVEAL : 0;
    dx = Math.min(0, Math.max(-REVEAL - 24, base + rawDx));
    card.style.transform = `translateX(${dx}px)`;
  });

  const finish = () => {
    if (!tracking) return;
    tracking = false;
    card.classList.remove("swiping");
    if (decided && horizontal) {
      setOpen(dx < -REVEAL / 2);
    }
  };

  card.addEventListener("pointerup", finish);
  card.addEventListener("pointercancel", finish);
}

// Tapping anywhere outside the currently-open swipe closes it.
document.addEventListener("pointerdown", (e) => {
  if (!openSwipeCard) return;
  if (!openSwipeCard.wrap.contains(e.target)) closeOpenSwipe();
});

function escapeHTML(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

/* Card interactions (event delegation) */
$id("skillList")?.addEventListener("click", onSkillListClick);
function $id(id) {
  return document.getElementById(id);
}

async function onSkillListClick(e) {
  const swipeDeleteBtn = e.target.closest('[data-action="swipe-delete"]');
  if (swipeDeleteBtn) {
    const wrap = swipeDeleteBtn.closest(".skill-card-wrap");
    const skill = state.skills.find((s) => s.id === Number(wrap?.dataset.id));
    if (skill) await deleteSkillWithUndo(skill);
    return;
  }

  const card = e.target.closest(".skill-card");
  if (!card) return;
  const id = Number(card.dataset.id);
  const actionEl = e.target.closest("[data-action]");
  const action = actionEl?.dataset.action;

  if (action === "drag-handle") return; // handled entirely via pointer/keyboard events
  if (action === "toggle-fav") {
    await toggleFavorite(id);
    return;
  }
  if (action === "change-status") {
    openStatusSheet(id);
    return;
  }
  openDetail(id);
}

async function toggleFavorite(id) {
  const skill = state.skills.find((s) => s.id === id);
  if (!skill) return;
  await LearnLogDB.updateSkill(id, { favorite: !skill.favorite });
  await refreshSkills();
  renderAll();
  refreshDetailIfOpen(id);
  haptic(10);
}

async function reorderSkill(id, direction) {
  const list = sortSkills(skillsByStatus(state.activeTab), "manual");
  const idx = list.findIndex((s) => s.id === id);
  const swapIdx = idx + direction;
  if (idx === -1 || swapIdx < 0 || swapIdx >= list.length) return;
  const a = list[idx];
  const b = list[swapIdx];
  const aOrder = a.order;
  const bOrder = b.order;
  await LearnLogDB.updateSkill(a.id, { order: bOrder });
  await LearnLogDB.updateSkill(b.id, { order: aOrder });
  await refreshSkills();
  renderAll();
  haptic(10);
  // Keep focus on the handle that was just moved so keyboard users don't lose their place.
  const movedHandle = $(`.skill-card[data-id="${a.id}"] .drag-handle`);
  movedHandle?.focus();
}

/* ---------------------------------------------------------------------- */
/* Manual drag-to-reorder (pointer events — works for touch, mouse, pen)    */
/* ---------------------------------------------------------------------- */

function attachDragHandle(handle, card, skillId) {
  handle.dataset.action = "drag-handle";

  handle.addEventListener("keydown", (e) => {
    if (e.key === "ArrowUp") {
      e.preventDefault();
      reorderSkill(skillId, -1);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      reorderSkill(skillId, 1);
    }
  });

  handle.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    e.preventDefault();
    startDrag(e, card, skillId);
  });
}

function startDrag(startEvent, card, skillId) {
  const container = $("#skillList");
  if (!container || dragState) return;

  const rect = card.getBoundingClientRect();
  const offsetY = startEvent.clientY - rect.top;

  const ghost = card.cloneNode(true);
  ghost.classList.add("drag-ghost");
  ghost.style.width = rect.width + "px";
  ghost.style.left = rect.left + "px";
  ghost.style.top = rect.top + "px";
  document.body.appendChild(ghost);
  card.classList.add("dragging");
  document.body.style.userSelect = "none";

  dragState = { skillId, card, ghost, offsetY, container };

  const onMove = (e) => {
    if (!dragState) return;
    const y = e.clientY;
    dragState.ghost.style.top = y - dragState.offsetY + "px";

    const siblings = Array.from(container.querySelectorAll(".skill-card:not(.dragging)"));
    let target = null;
    for (const sib of siblings) {
      const r = sib.getBoundingClientRect();
      if (y < r.top + r.height / 2) {
        target = sib;
        break;
      }
    }
    if (target) container.insertBefore(card, target);
    else container.appendChild(card);
  };

  const onUp = async () => {
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
    document.removeEventListener("pointercancel", onUp);
    ghost.remove();
    card.classList.remove("dragging");
    document.body.style.userSelect = "";
    dragState = null;

    const orderedIds = Array.from(container.querySelectorAll(".skill-card")).map((el) => Number(el.dataset.id));
    await Promise.all(orderedIds.map((id, idx) => LearnLogDB.updateSkill(id, { order: idx })));
    await refreshSkills();
    renderAll();
    haptic(15);
    $(`.skill-card[data-id="${skillId}"] .drag-handle`)?.focus();
  };

  document.addEventListener("pointermove", onMove);
  document.addEventListener("pointerup", onUp);
  document.addEventListener("pointercancel", onUp);
}

/* ---------------------------------------------------------------------- */
/* Status change sheet                                                      */
/* ---------------------------------------------------------------------- */

function openStatusSheet(skillId) {
  state.actionSkillId = skillId;
  const skill = state.skills.find((s) => s.id === skillId);
  const container = $("#statusOptions");
  container.innerHTML = "";
  Object.values(STATUS).forEach((status) => {
    const btn = document.createElement("button");
    btn.className = "action-sheet-option" + (skill.status === status ? " active" : "");
    btn.dataset.status = status;
    btn.textContent = STATUS_LABEL[status] + (skill.status === status ? "  (current)" : "");
    container.appendChild(btn);
  });
  openSheet("#statusSheet");
}

$id("statusOptions")?.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-status]");
  if (!btn) return;
  const status = btn.dataset.status;
  const id = state.actionSkillId;
  await LearnLogDB.updateSkill(id, { status, order: Date.now() });
  await refreshSkills();
  closeSheet("#statusSheet");
  renderAll();
  refreshDetailIfOpen(id);
  haptic(10);
  showToast(`Moved to ${STATUS_LABEL[status]}`);
});

/* ---------------------------------------------------------------------- */
/* Skill detail sheet                                                       */
/* ---------------------------------------------------------------------- */

function openDetail(id) {
  const skill = state.skills.find((s) => s.id === id);
  if (!skill) return;
  state.detailSkillId = id;

  const mediaEl = $("#detailMedia");
  mediaEl.innerHTML = "";
  if (skill.media && skill.media.blob) {
    mediaEl.classList.remove("hidden");
    const url = URL.createObjectURL(skill.media.blob);
    mediaEl.innerHTML =
      skill.media.kind === "video"
        ? `<video src="${url}" controls playsinline></video>`
        : `<img src="${url}" alt="">`;
  } else {
    mediaEl.classList.add("hidden");
  }

  $("#detailName").textContent = skill.name;
  $("#detailStar").textContent = skill.favorite ? "★" : "☆";
  $("#detailStar").classList.toggle("active", skill.favorite);
  $("#detailStar").setAttribute("aria-pressed", String(!!skill.favorite));
  $("#detailCategory").textContent = categoryName(skill.category);
  $("#detailStatusBadge").textContent = STATUS_LABEL[skill.status];
  $("#detailStatusBadge").className = "status-badge " + skill.status;
  $("#detailNotes").textContent = skill.notes && skill.notes.trim() ? skill.notes : "No notes yet.";
  $("#detailNotes").style.opacity = skill.notes && skill.notes.trim() ? "1" : "0.6";

  openSheet("#detailSheet");
}

function refreshDetailIfOpen(id) {
  if (state.detailSkillId === id && $("#detailSheet").classList.contains("open")) {
    openDetail(id);
  }
}

$id("detailStar")?.addEventListener("click", () => toggleFavorite(state.detailSkillId));
$id("detailStatusBtn")?.addEventListener("click", () => openStatusSheet(state.detailSkillId));
$id("detailEditBtn")?.addEventListener("click", () => {
  closeSheet("#detailSheet");
  openSkillForm(state.detailSkillId);
});
// Soft-deletes a skill (it moves to Settings > Recently Deleted rather than
// vanishing outright) and shows an Undo toast. Undo and the Recently Deleted
// "Restore" button both just clear the same deletedAt flag, so either path
// brings back the exact same record — same id, same photo/video, same order.
async function deleteSkillWithUndo(skill) {
  await LearnLogDB.softDeleteSkill(skill.id);
  await refreshSkills();
  renderAll();
  renderDeletedList();
  haptic(20);
  showToast("Skill deleted", {
    actionLabel: "Undo",
    onAction: async () => {
      await LearnLogDB.restoreSkill(skill.id);
      await refreshSkills();
      renderAll();
      renderDeletedList();
      showToast("Skill restored");
    },
  });
}

$id("detailDeleteBtn")?.addEventListener("click", async () => {
  const skill = state.skills.find((s) => s.id === state.detailSkillId);
  const ok = await showConfirm({
    title: "Delete this skill?",
    message: `"${skill.name}" moves to Recently Deleted (Settings) for 24 hours before it's gone for good. You can undo this right away too.`,
    confirmLabel: "Delete",
    danger: true,
  });
  if (!ok) return;
  closeSheet("#detailSheet");
  await deleteSkillWithUndo(skill);
});

$id("detailDuplicateBtn")?.addEventListener("click", async () => {
  const skill = state.skills.find((s) => s.id === state.detailSkillId);
  if (!skill) return;
  const { id, createdAt, updatedAt, deletedAt, ...rest } = skill;
  rest.name = skill.name + " copy";
  rest.order = Date.now();
  const newId = await LearnLogDB.addSkill(rest);
  await refreshSkills();
  closeSheet("#detailSheet");
  renderAll();
  haptic(15);
  showToast("Skill duplicated");
  openSkillForm(newId);
});

$id("detailShareBtn")?.addEventListener("click", async () => {
  const skill = state.skills.find((s) => s.id === state.detailSkillId);
  if (!skill) return;
  const text = `${skill.name} — ${categoryName(skill.category)} (${STATUS_LABEL[skill.status]})${skill.notes ? "\n" + skill.notes : ""}`;
  try {
    if (navigator.share) {
      const shareData = { title: skill.name, text };
      if (skill.media && skill.media.blob && navigator.canShare) {
        const ext = skill.media.kind === "video" ? "mp4" : "jpg";
        const mime = skill.media.mime || (skill.media.kind === "video" ? "video/mp4" : "image/jpeg");
        const file = new File([skill.media.blob], `${skill.name.replace(/[^\w.-]+/g, "_")}.${ext}`, { type: mime });
        if (navigator.canShare({ files: [file] })) shareData.files = [file];
      }
      await navigator.share(shareData);
    } else if (navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      showToast("Copied to clipboard");
    } else {
      showToast("Sharing isn't supported on this browser");
    }
  } catch (err) {
    if (err.name !== "AbortError") showToast("Couldn't share");
  }
});

/* ---------------------------------------------------------------------- */
/* Add / edit skill form                                                    */
/* ---------------------------------------------------------------------- */

function populateCategorySelect(selectEl, selectedId) {
  selectEl.innerHTML = "";
  state.categories.forEach((c) => {
    const opt = document.createElement("option");
    opt.value = c.id;
    opt.textContent = c.name;
    if (c.id === selectedId) opt.selected = true;
    selectEl.appendChild(opt);
  });
}

function openSkillForm(editId) {
  state.editingSkillId = editId || null;
  state.editingMedia = undefined; // undefined = unchanged, null = removed, object = new

  const skill = editId ? state.skills.find((s) => s.id === editId) : null;

  $("#skillSheetTitle").textContent = skill ? "Edit Skill" : "Add Skill";
  $("#skillName").value = skill ? skill.name : "";
  populateCategorySelect($("#skillCategory"), skill ? skill.category : state.categories[0]?.id);
  setStatusPicker(skill ? skill.status : state.activeTab);
  $("#skillNotes").value = skill ? skill.notes || "" : "";
  setFavSwitch(skill ? !!skill.favorite : false);
  $("#skillDeleteBtn").classList.toggle("hidden", !skill);
  renderMediaPreview(skill && skill.media ? skill.media : null);

  openSheet("#skillSheet");
  if (!skill) setTimeout(() => $("#skillName").focus(), 250);
}

function setStatusPicker(status) {
  $$("#skillStatusPicker button").forEach((b) => b.classList.toggle("active", b.dataset.status === status));
}

function setFavSwitch(on) {
  const el = $("#skillFavoriteSwitch");
  el.classList.toggle("on", on);
  el.setAttribute("aria-checked", String(on));
}

$id("skillStatusPicker")?.addEventListener("click", (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  setStatusPicker(btn.dataset.status);
});

$id("skillFavoriteSwitch")?.addEventListener("click", () => {
  setFavSwitch(!$("#skillFavoriteSwitch").classList.contains("on"));
});

$id("skillFavoriteSwitch")?.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    setFavSwitch(!$("#skillFavoriteSwitch").classList.contains("on"));
  }
});

function renderMediaPreview(media) {
  const preview = $("#skillMediaPreview");
  preview.innerHTML = "";
  const effectiveMedia = state.editingMedia === undefined ? media : state.editingMedia;
  if (!effectiveMedia) {
    preview.classList.add("hidden");
    $("#skillMediaRemoveBtn").classList.add("hidden");
    return;
  }
  preview.classList.remove("hidden");
  $("#skillMediaRemoveBtn").classList.remove("hidden");
  const url = URL.createObjectURL(effectiveMedia.blob);
  preview.innerHTML =
    effectiveMedia.kind === "video" ? `<video src="${url}" controls playsinline></video>` : `<img src="${url}" alt="">`;
}

// Downscales/re-encodes a large photo before it ever touches IndexedDB, so a
// phone full of skill photos doesn't quietly eat device storage. Animated
// GIFs are left untouched (re-encoding would flatten the animation), and
// files that are already small are left alone too.
const MAX_PHOTO_DIMENSION = 1600;
const PHOTO_QUALITY = 0.82;
const SKIP_COMPRESSION_SIZE = 350 * 1024; // ~350KB

async function compressImageIfNeeded(file) {
  if (!file.type.startsWith("image/") || file.type === "image/gif" || file.type === "image/svg+xml") {
    return file;
  }
  if (file.size <= SKIP_COMPRESSION_SIZE) return file;

  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_PHOTO_DIMENSION / Math.max(bitmap.width, bitmap.height));
    if (scale >= 1) {
      bitmap.close?.();
      return file;
    }
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close?.();

    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", PHOTO_QUALITY));
    if (!blob || blob.size >= file.size) return file; // compression didn't help — keep original
    return blob;
  } catch (err) {
    console.warn("Photo compression skipped:", err);
    return file; // never block saving a skill just because compression failed
  }
}

async function handleMediaFileSelected(file) {
  if (!file) return;
  const kind = file.type.startsWith("video") ? "video" : "image";
  const blob = kind === "image" ? await compressImageIfNeeded(file) : file;
  state.editingMedia = { blob, mime: blob.type || file.type, kind };
  renderMediaPreview(null);
}

$id("skillMediaPicker")?.addEventListener("click", () => $("#skillMediaInput").click());
$id("skillCameraPicker")?.addEventListener("click", () => $("#skillCameraInput").click());

$id("skillMediaInput")?.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  await handleMediaFileSelected(file);
});

$id("skillCameraInput")?.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  await handleMediaFileSelected(file);
});

$id("skillMediaRemoveBtn")?.addEventListener("click", () => {
  state.editingMedia = null;
  renderMediaPreview(null);
});

$id("skillCancelBtn")?.addEventListener("click", () => closeSheet("#skillSheet"));
$id("skillSheetClose")?.addEventListener("click", () => closeSheet("#skillSheet"));

$id("skillDeleteBtn")?.addEventListener("click", async () => {
  const skill = state.skills.find((s) => s.id === state.editingSkillId);
  if (!skill) return;
  const ok = await showConfirm({
    title: "Delete this skill?",
    message: `"${skill.name}" moves to Recently Deleted (Settings) for 24 hours before it's gone for good. You can undo this right away too.`,
    confirmLabel: "Delete",
    danger: true,
  });
  if (!ok) return;
  closeSheet("#skillSheet");
  await deleteSkillWithUndo(skill);
});

$id("skillSaveBtn")?.addEventListener("click", async () => {
  const name = $("#skillName").value.trim();
  if (!name) {
    $("#skillName").focus();
    return;
  }
  const category = Number($("#skillCategory").value);
  const status = $("#skillStatusPicker button.active")?.dataset.status || STATUS.WANT;
  const notes = $("#skillNotes").value.trim();
  const favorite = $("#skillFavoriteSwitch").classList.contains("on");

  let mediaPayload;
  if (state.editingMedia === undefined) {
    mediaPayload = undefined; // don't touch existing media field
  } else {
    mediaPayload = state.editingMedia; // either null (removed) or new media object
  }

  try {
    if (state.editingSkillId) {
      const changes = { name, category, status, notes, favorite };
      if (mediaPayload !== undefined) changes.media = mediaPayload;
      await LearnLogDB.updateSkill(state.editingSkillId, changes);
      showToast("Skill updated");
    } else {
      await LearnLogDB.addSkill({
        name,
        category,
        status,
        notes,
        favorite,
        media: mediaPayload || null,
        order: Date.now(),
      });
      showToast("Skill added");
    }
    await refreshSkills();
    closeSheet("#skillSheet");
    renderAll();
    haptic(15);
  } catch (err) {
    showToast(err.message || "Something went wrong");
  }
});

$id("fabAdd")?.addEventListener("click", () => openSkillForm(null));

/* ---------------------------------------------------------------------- */
/* Search page                                                              */
/* ---------------------------------------------------------------------- */

function renderSearchPage() {
  const chipRow = $("#categoryChips");
  chipRow.innerHTML = "";

  const allChip = document.createElement("button");
  allChip.className = "chip" + (state.searchCategory === null ? " active" : "");
  allChip.textContent = "All";
  allChip.dataset.cat = "";
  chipRow.appendChild(allChip);

  const favChip = document.createElement("button");
  favChip.className = "chip" + (state.searchFavoritesOnly ? " active" : "");
  favChip.textContent = "★ Favorites";
  favChip.dataset.fav = "1";
  chipRow.appendChild(favChip);

  state.categories.forEach((c) => {
    const chip = document.createElement("button");
    chip.className = "chip" + (state.searchCategory === c.id ? " active" : "");
    chip.textContent = `${c.icon || LearnLogDB.DEFAULT_ICON} ${c.name}`;
    chip.dataset.cat = c.id;
    chipRow.appendChild(chip);
  });

  const q = state.searchQuery.trim().toLowerCase();
  let results = state.skills;
  if (state.searchCategory !== null) results = results.filter((s) => s.category === state.searchCategory);
  if (state.searchFavoritesOnly) results = results.filter((s) => s.favorite);
  if (q) results = results.filter((s) => s.name.toLowerCase().includes(q) || (s.notes || "").toLowerCase().includes(q));
  results = sortSkills(results, "alpha");

  const container = $("#searchResults");
  container.innerHTML = "";
  openSwipeCard = null;

  if (results.length === 0) {
    const el = document.createElement("div");
    el.className = "empty-state";
    el.innerHTML = `<span class="emoji">🔍</span><p>No skills found.</p>`;
    container.appendChild(el);
    return;
  }

  results.forEach((skill) => {
    const wrap = buildSkillCard(skill, { manual: false });
    const badge = document.createElement("span");
    badge.className = "status-badge " + skill.status;
    badge.textContent = STATUS_SHORT[skill.status];
    $(".info", wrap).appendChild(badge);
    container.appendChild(wrap);
  });
}

$id("searchInput")?.addEventListener("input", (e) => {
  state.searchQuery = e.target.value;
  renderSearchPage();
});

$id("categoryChips")?.addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (!chip) return;
  if (chip.dataset.fav) {
    state.searchFavoritesOnly = !state.searchFavoritesOnly;
    renderSearchPage();
    return;
  }
  state.searchCategory = chip.dataset.cat === "" ? null : Number(chip.dataset.cat);
  renderSearchPage();
});

// Search results share all the same card interactions (favorite, move,
// swipe-to-delete, open detail) as the Home list.
$id("searchResults")?.addEventListener("click", onSkillListClick);

/* ---------------------------------------------------------------------- */
/* Categories page                                                          */
/* ---------------------------------------------------------------------- */

function renderCategoriesPage() {
  const container = $("#categoryList");
  container.innerHTML = "";
  state.categories.forEach((c) => {
    const count = state.skills.filter((s) => s.category === c.id).length;
    const row = document.createElement("div");
    row.className = "cat-row";
    row.dataset.id = c.id;
    row.innerHTML = `
      <div class="cat-icon">${escapeHTML(c.icon || LearnLogDB.DEFAULT_ICON)}</div>
      <div class="cat-name">${escapeHTML(c.name)}</div>
      <div class="cat-count">${count}</div>
      <button class="icon-btn" data-action="rename" aria-label="Rename category">✎</button>
      <button class="icon-btn danger" data-action="delete" aria-label="Delete category">🗑</button>
    `;
    container.appendChild(row);
  });
}

$id("categoryList")?.addEventListener("click", async (e) => {
  const row = e.target.closest(".cat-row");
  if (!row) return;
  const id = Number(row.dataset.id);
  const action = e.target.closest("[data-action]")?.dataset.action;
  const category = state.categories.find((c) => c.id === id);

  if (action === "rename") {
    const result = await showPrompt({
      title: "Rename category",
      value: category.name,
      icon: category.icon || LearnLogDB.DEFAULT_ICON,
    });
    if (result === null) return;
    try {
      await LearnLogDB.renameCategory(id, result.name, result.icon);
      await refreshCategories();
      renderAll();
      showToast("Category renamed");
    } catch (err) {
      showToast(err.message);
    }
    return;
  }

  if (action === "delete") {
    const count = state.skills.filter((s) => s.category === id).length;
    const message =
      count > 0
        ? `"${category.name}" is used by ${count} skill${count === 1 ? "" : "s"}. They'll be moved to "Other" instead of being deleted.`
        : `Delete the "${category.name}" category?`;
    const ok = await showConfirm({ title: "Delete category?", message, confirmLabel: "Delete", danger: true });
    if (!ok) return;
    try {
      await LearnLogDB.deleteCategory(id);
      if (state.searchCategory === id) state.searchCategory = null;
      await Promise.all([refreshCategories(), refreshSkills()]);
      renderAll();
      showToast("Category deleted");
    } catch (err) {
      showToast(err.message);
    }
  }
});

$id("addCategoryBtn")?.addEventListener("click", async () => {
  const input = $("#newCategoryInput");
  const name = input.value.trim();
  if (!name) return;
  try {
    await LearnLogDB.addCategory(name);
    input.value = "";
    await refreshCategories();
    renderAll();
    showToast("Category added");
  } catch (err) {
    showToast(err.message);
  }
});

$id("newCategoryInput")?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") $id("addCategoryBtn").click();
});

$id("restoreDefaultsBtn")?.addEventListener("click", async () => {
  try {
    const added = await LearnLogDB.restoreDefaultCategories();
    await refreshCategories();
    renderAll();
    showToast(added > 0 ? `Restored ${added} default categor${added === 1 ? "y" : "ies"}` : "All default categories are already here");
  } catch (err) {
    showToast(err.message);
  }
});

/* ---------------------------------------------------------------------- */
/* Settings page — theme, backup & restore                                  */
/* ---------------------------------------------------------------------- */

$$("#themeSegmented button").forEach((btn) => {
  btn.addEventListener("click", () => setTheme(btn.dataset.theme));
});

// Shows when the last export happened, or a nudge if there's never been one.
// Purely informational — it doesn't affect whether the data is safe, just
// whether there's a backup file sitting somewhere outside the device.
function renderBackupHint() {
  const el = $id("backupHint");
  if (!el) return;
  if (!state.settings.lastBackupAt) {
    el.textContent = "You haven't backed up yet.";
    return;
  }
  const d = new Date(state.settings.lastBackupAt);
  const dateStr = d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  const timeStr = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  el.textContent = `Last backup: ${dateStr} at ${timeStr}`;
}

$id("exportBtn")?.addEventListener("click", async () => {
  try {
    const data = await LearnLogDB.exportAllData();
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const stamp = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `learnlog-backup-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    state.settings.lastBackupAt = Date.now();
    await LearnLogDB.setSetting("lastBackupAt", state.settings.lastBackupAt);
    renderBackupHint();
    showToast("Backup exported");
  } catch (err) {
    showToast("Export failed: " + err.message);
  }
});

$id("importBtn")?.addEventListener("click", () => $id("importFile").click());

$id("importFile")?.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;

  // Parse the file *before* asking for confirmation, so the confirmation
  // dialog can show exactly what's in it rather than a generic warning.
  let data;
  try {
    const text = await file.text();
    data = JSON.parse(text);
    if (!data || !Array.isArray(data.skills) || !Array.isArray(data.categories)) {
      throw new Error("not a LearnLog backup");
    }
  } catch (err) {
    showToast("That doesn't look like a valid LearnLog backup file.");
    return;
  }

  const skillCount = data.skills.length;
  const categoryCount = data.categories.length;
  const mediaCount = data.skills.filter((s) => s.media && s.media.dataURL).length;
  const exportedDate = data.exportedAt ? new Date(data.exportedAt).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" }) : "an unknown date";

  const summaryHTML = `
    <div><strong>${skillCount}</strong> skill${skillCount === 1 ? "" : "s"}</div>
    <div><strong>${categoryCount}</strong> categor${categoryCount === 1 ? "y" : "ies"}</div>
    <div><strong>${mediaCount}</strong> with a photo or video</div>
    <div>Exported on <strong>${exportedDate}</strong></div>
  `;

  const ok = await showConfirm({
    title: "Restore from backup?",
    message: "This backup will replace everything currently in LearnLog — skills, categories, notes, and photos/videos. This can't be undone.",
    confirmLabel: "Restore",
    danger: true,
    warning: "Your current data will be overwritten.",
    summaryHTML,
  });
  if (!ok) return;

  try {
    await LearnLogDB.restoreAllData(data);
    const [skills, categories, theme, sortMode, lastBackupAt] = await Promise.all([
      LearnLogDB.getAllSkills(),
      LearnLogDB.getAllCategories(),
      LearnLogDB.getSetting("theme", "dark"),
      LearnLogDB.getSetting("sortMode", { want: "manual", learning: "manual", can: "manual" }),
      LearnLogDB.getSetting("lastBackupAt", null),
    ]);
    state.skills = skills;
    state.categories = categories;
    state.settings.theme = theme;
    state.settings.sortMode = sortMode;
    state.settings.lastBackupAt = lastBackupAt;
    applyTheme(theme);
    renderAll();
    renderBackupHint();
    renderDeletedList();
    showToast("Backup restored");
  } catch (err) {
    showToast("Restore failed: " + err.message);
  }
});

$id("shareListBtn")?.addEventListener("click", async () => {
  if (state.skills.length === 0) {
    showToast("Nothing to share yet");
    return;
  }
  const lines = [];
  [STATUS.WANT, STATUS.LEARNING, STATUS.CAN].forEach((status) => {
    const items = state.skills.filter((s) => s.status === status);
    if (items.length === 0) return;
    lines.push(`${STATUS_LABEL[status]}:`);
    items.forEach((s) => lines.push(`- ${s.name}${s.favorite ? " ★" : ""}`));
    lines.push("");
  });
  const text = `My LearnLog\n\n${lines.join("\n").trim()}`;
  try {
    if (navigator.share) {
      await navigator.share({ title: "My LearnLog", text });
    } else if (navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      showToast("Copied to clipboard");
    } else {
      showToast("Sharing isn't supported on this browser");
    }
  } catch (err) {
    if (err.name !== "AbortError") showToast("Couldn't share");
  }
});

/* ---------------------------------------------------------------------- */
/* Recently Deleted                                                          */
/* ---------------------------------------------------------------------- */

// A 24-hour safety net: soft-deleted skills show up here with a "Restore"
// button, using the exact same restoreSkill() primitive as the Undo toast.
async function renderDeletedList() {
  const listEl = $id("deletedList");
  const emptyEl = $id("deletedEmpty");
  if (!listEl || !emptyEl) return;

  const deleted = await LearnLogDB.getDeletedSkills();
  listEl.innerHTML = "";

  if (deleted.length === 0) {
    emptyEl.classList.remove("hidden");
    return;
  }
  emptyEl.classList.add("hidden");

  deleted.forEach((skill) => {
    const msLeft = Math.max(0, skill.deletedAt + 24 * 60 * 60 * 1000 - Date.now());
    const hoursLeft = Math.max(1, Math.ceil(msLeft / (60 * 60 * 1000)));
    const row = document.createElement("div");
    row.className = "deleted-row";
    row.dataset.id = skill.id;
    row.innerHTML = `
      <div class="info">
        <div class="name">${escapeHTML(skill.name)}</div>
        <div class="meta">${escapeHTML(categoryName(skill.category))} · gone in ${hoursLeft}h</div>
      </div>
      <button class="restore-btn" data-action="restore" aria-label="Restore ${escapeHTML(skill.name)}">Restore</button>
    `;
    listEl.appendChild(row);
  });
}

$id("deletedList")?.addEventListener("click", async (e) => {
  const btn = e.target.closest('[data-action="restore"]');
  if (!btn) return;
  const row = btn.closest(".deleted-row");
  const id = Number(row?.dataset.id);
  if (!id) return;
  await LearnLogDB.restoreSkill(id);
  await refreshSkills();
  renderAll();
  renderDeletedList();
  haptic(15);
  showToast("Skill restored");
});

/* ---------------------------------------------------------------------- */
/* Sort toggle (Home)                                                       */
/* ---------------------------------------------------------------------- */

$id("sectionToolbar")?.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-sort]");
  if (!btn) return;
  const mode = btn.dataset.sort;
  state.settings.sortMode[state.activeTab] = mode;
  await LearnLogDB.setSetting("sortMode", state.settings.sortMode);
  renderHomeList();
});

/* ---------------------------------------------------------------------- */
/* Navigation                                                               */
/* ---------------------------------------------------------------------- */

function showPage(page) {
  state.page = page;
  $$(".page").forEach((p) => p.classList.toggle("active", p.id === `page-${page}`));
  $$(".nav-btn").forEach((b) => {
    const isActive = b.dataset.page === page;
    b.classList.toggle("active", isActive);
    if (isActive) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  });
  if (page === "settings") {
    // Refresh on every visit so the backup hint and the Recently Deleted
    // countdown ("gone in Nh") never go stale while the app sits open.
    renderBackupHint();
    renderDeletedList();
  }
}

function wireStaticEvents() {
  $$(".nav-btn").forEach((btn) => btn.addEventListener("click", () => showPage(btn.dataset.page)));

  const versionEl = $id("versionText");
  if (versionEl) versionEl.textContent = "Version " + APP_VERSION;

  $$(".tab").forEach((tab) =>
    tab.addEventListener("click", () => {
      state.activeTab = tab.dataset.status;
      renderTabs();
      renderHomeList();
    })
  );

  $$("[data-close-sheet]").forEach((el) =>
    el.addEventListener("click", () => closeSheet("#" + el.closest(".overlay").id))
  );

  $$(".overlay").forEach((overlay) => {
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) closeSheet("#" + overlay.id);
    });
  });
}

/* ---------------------------------------------------------------------- */
/* Sheet / overlay helpers                                                  */
/* ---------------------------------------------------------------------- */

// A stack rather than a single variable, since a confirm/prompt sheet can
// open on top of an already-open sheet (e.g. "Delete skill?" over the skill
// detail sheet) — each close should hand focus back to whichever element
// was focused immediately before *that* sheet opened, not the very first one.
const focusStack = [];

function openSheet(selector) {
  const overlay = $(selector);
  overlay.classList.add("open");

  focusStack.push(document.activeElement);
  $id("appRoot")?.setAttribute("aria-hidden", "true");

  // Move focus into the sheet for screen reader / keyboard users.
  const focusable = overlay.querySelector(
    'input, textarea, select, button:not(.sheet-close), [tabindex]:not([tabindex="-1"])'
  );
  setTimeout(() => (focusable || overlay).focus?.(), 50);
}

function closeSheet(selector) {
  const overlay = $(selector);
  overlay.classList.remove("open");

  const previous = focusStack.pop();
  if (focusStack.length === 0) {
    $id("appRoot")?.removeAttribute("aria-hidden");
  }
  if (previous && document.contains(previous) && previous.offsetParent !== null) {
    previous.focus?.();
  }
}

// Escape closes whichever sheet is currently open.
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  const open = $(".overlay.open");
  if (open) closeSheet("#" + open.id);
});

/* ---------------------------------------------------------------------- */
/* Generic confirm dialog                                                   */
/* ---------------------------------------------------------------------- */

function showConfirm({ title, message, confirmLabel = "Confirm", danger = false, warning = null, summaryHTML = null }) {
  return new Promise((resolve) => {
    $("#confirmTitle").textContent = title;
    $("#confirmMessage").textContent = message;
    $("#confirmOkBtn").textContent = confirmLabel;
    $("#confirmOkBtn").className = "btn " + (danger ? "danger" : "primary");

    const summaryBox = $("#confirmSummary");
    if (summaryHTML) {
      summaryBox.innerHTML = summaryHTML;
      summaryBox.classList.remove("hidden");
    } else {
      summaryBox.classList.add("hidden");
    }

    const warnBox = $("#confirmWarning");
    if (warning) {
      warnBox.textContent = "⚠ " + warning;
      warnBox.classList.remove("hidden");
    } else {
      warnBox.classList.add("hidden");
    }

    const cleanup = (result) => {
      $id("confirmOkBtn").removeEventListener("click", onOk);
      $id("confirmCancelBtn").removeEventListener("click", onCancel);
      closeSheet("#confirmSheet");
      resolve(result);
    };
    const onOk = () => cleanup(true);
    const onCancel = () => cleanup(false);
    $id("confirmOkBtn").addEventListener("click", onOk);
    $id("confirmCancelBtn").addEventListener("click", onCancel);
    openSheet("#confirmSheet");
  });
}

/* ---------------------------------------------------------------------- */
/* Generic text + icon prompt (used for renaming categories)                */
/* ---------------------------------------------------------------------- */

// Resolves to { name, icon } on Save, or null on Cancel / empty name.
function showPrompt({ title, value = "", icon = null }) {
  return new Promise((resolve) => {
    $("#promptTitle").textContent = title;
    $("#promptInput").value = value;

    let selectedIcon = icon || CATEGORY_ICON_OPTIONS[0];
    const pickerEl = $("#promptIconPicker");
    pickerEl.innerHTML = "";
    CATEGORY_ICON_OPTIONS.forEach((ic) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = ic;
      btn.className = ic === selectedIcon ? "active" : "";
      btn.setAttribute("aria-label", `Use icon ${ic}`);
      btn.setAttribute("aria-pressed", String(ic === selectedIcon));
      btn.addEventListener("click", () => {
        selectedIcon = ic;
        $$("#promptIconPicker button").forEach((b) => {
          const active = b.textContent === ic;
          b.classList.toggle("active", active);
          b.setAttribute("aria-pressed", String(active));
        });
      });
      pickerEl.appendChild(btn);
    });

    const cleanup = (result) => {
      $id("promptOkBtn").removeEventListener("click", onOk);
      $id("promptCancelBtn").removeEventListener("click", onCancel);
      closeSheet("#promptSheet");
      resolve(result);
    };
    const onOk = () => {
      const name = $id("promptInput").value.trim();
      cleanup(name ? { name, icon: selectedIcon } : null);
    };
    const onCancel = () => cleanup(null);
    $id("promptOkBtn").addEventListener("click", onOk);
    $id("promptCancelBtn").addEventListener("click", onCancel);
    openSheet("#promptSheet");
    setTimeout(() => $id("promptInput").focus(), 250);
  });
}

/* ---------------------------------------------------------------------- */
/* Toast                                                                    */
/* ---------------------------------------------------------------------- */

let toastTimer = null;
let toastActionHandler = null;

// showToast("message") for a plain toast, or
// showToast("message", { actionLabel: "Undo", onAction: fn, duration: 5000 })
// for one with a tappable action. Only one toast (and one pending action) is
// ever active at a time — a new toast replaces whatever was showing.
function showToast(message, opts = {}) {
  const el = $("#toast");
  const actionBtn = $("#toastAction");

  $("#toastMsg").textContent = message;

  if (toastActionHandler) {
    actionBtn.removeEventListener("click", toastActionHandler);
    toastActionHandler = null;
  }

  if (opts.actionLabel && opts.onAction) {
    actionBtn.textContent = opts.actionLabel;
    actionBtn.classList.remove("hidden");
    toastActionHandler = () => {
      opts.onAction();
      clearTimeout(toastTimer);
      el.classList.remove("show");
    };
    actionBtn.addEventListener("click", toastActionHandler);
  } else {
    actionBtn.classList.add("hidden");
  }

  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), opts.duration || (opts.actionLabel ? 5000 : 2200));
}

/* ---------------------------------------------------------------------- */

document.addEventListener("DOMContentLoaded", init);
