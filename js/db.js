/* ==========================================================================
   LearnLog — IndexedDB storage layer
   All app data (skills, categories, settings, photos/videos) lives entirely
   on-device in IndexedDB. Nothing is ever sent to a server.
   ========================================================================== */

const DB_NAME = "learnlog-db";
const DB_VERSION = 1;

const DEFAULT_CATEGORIES = [
  "Ground",
  "Trampoline",
  "Parkour",
  "Mountain Biking",
  "Photography",
  "Editing",
  "Dirt Bike",
  "Other",
];

const DEFAULT_ICON = "🏷️";

const DEFAULT_CATEGORY_ICONS = {
  Ground: "🤸",
  Trampoline: "🤾",
  Parkour: "🏃",
  "Mountain Biking": "🚵",
  Photography: "📷",
  Editing: "🎬",
  "Dirt Bike": "🏍️",
  Other: DEFAULT_ICON,
};

// How long a deleted skill stays recoverable in Settings > Recently Deleted
// before it's permanently purged.
const DELETED_RETENTION_MS = 24 * 60 * 60 * 1000; // 24 hours

let _dbPromise = null;

function openDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (event) => {
      const db = req.result;

      if (!db.objectStoreNames.contains("skills")) {
        const skills = db.createObjectStore("skills", { keyPath: "id", autoIncrement: true });
        skills.createIndex("status", "status", { unique: false });
        skills.createIndex("category", "category", { unique: false });
        skills.createIndex("order", "order", { unique: false });
      }

      if (!db.objectStoreNames.contains("categories")) {
        const categories = db.createObjectStore("categories", { keyPath: "id", autoIncrement: true });
        categories.createIndex("name", "name", { unique: true });
        categories.createIndex("order", "order", { unique: false });
      }

      if (!db.objectStoreNames.contains("settings")) {
        db.createObjectStore("settings", { keyPath: "key" });
      }

      // Seed default categories on first install.
      if (event.oldVersion < 1) {
        const tx = req.transaction;
        const categories = tx.objectStore("categories");
        DEFAULT_CATEGORIES.forEach((name, i) => {
          categories.add({ name, order: i, isDefault: true, icon: DEFAULT_CATEGORY_ICONS[name] || DEFAULT_ICON });
        });
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => console.warn("LearnLog DB upgrade blocked by another open tab.");
  });
  return _dbPromise;
}

function tx(db, storeNames, mode) {
  return db.transaction(storeNames, mode);
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(t) {
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

/* ---------------------------------------------------------------------- */
/* Skills                                                                   */
/* ---------------------------------------------------------------------- */

// By default, returns only active (non-deleted) skills — this is what every
// screen in the app renders from. Recently Deleted in Settings is the only
// place that asks for the deleted ones.
async function getAllSkills() {
  const db = await openDB();
  const t = tx(db, "skills", "readonly");
  const all = await reqToPromise(t.objectStore("skills").getAll());
  return all.filter((s) => !s.deletedAt);
}

async function getDeletedSkills() {
  const db = await openDB();
  const t = tx(db, "skills", "readonly");
  const all = await reqToPromise(t.objectStore("skills").getAll());
  return all.filter((s) => !!s.deletedAt).sort((a, b) => b.deletedAt - a.deletedAt);
}

async function getSkill(id) {
  const db = await openDB();
  const t = tx(db, "skills", "readonly");
  return reqToPromise(t.objectStore("skills").get(id));
}

async function addSkill(skill) {
  const db = await openDB();
  const t = tx(db, "skills", "readwrite");
  const store = t.objectStore("skills");
  const now = Date.now();
  const record = {
    name: skill.name,
    category: skill.category,
    status: skill.status,
    notes: skill.notes || "",
    favorite: !!skill.favorite,
    media: skill.media || null,
    order: typeof skill.order === "number" ? skill.order : now,
    createdAt: now,
    updatedAt: now,
  };
  const id = await reqToPromise(store.add(record));
  await txDone(t);
  return id;
}

async function updateSkill(id, changes) {
  const db = await openDB();
  const t = tx(db, "skills", "readwrite");
  const store = t.objectStore("skills");
  const existing = await reqToPromise(store.get(id));
  if (!existing) throw new Error("Skill not found");
  const updated = { ...existing, ...changes, id, updatedAt: Date.now() };
  await reqToPromise(store.put(updated));
  await txDone(t);
  return updated;
}

// Permanently removes a skill. Used internally by the purge routine and by
// "Delete forever" in Recently Deleted — everyday deletes go through
// softDeleteSkill() instead so they're recoverable.
async function deleteSkill(id) {
  const db = await openDB();
  const t = tx(db, "skills", "readwrite");
  await reqToPromise(t.objectStore("skills").delete(id));
  await txDone(t);
}

async function softDeleteSkill(id) {
  return updateSkill(id, { deletedAt: Date.now() });
}

async function restoreSkill(id) {
  const db = await openDB();
  const t = tx(db, "skills", "readwrite");
  const store = t.objectStore("skills");
  const existing = await reqToPromise(store.get(id));
  if (!existing) throw new Error("Skill not found");
  delete existing.deletedAt;
  existing.updatedAt = Date.now();
  await reqToPromise(store.put(existing));
  await txDone(t);
  return existing;
}

// Permanently removes anything that's been sitting in Recently Deleted
// longer than the retention window. Safe to call on every app launch.
async function purgeExpiredDeletedSkills() {
  const db = await openDB();
  const t = tx(db, "skills", "readwrite");
  const store = t.objectStore("skills");
  const all = await reqToPromise(store.getAll());
  const cutoff = Date.now() - DELETED_RETENTION_MS;
  let purged = 0;
  for (const s of all) {
    if (s.deletedAt && s.deletedAt < cutoff) {
      store.delete(s.id);
      purged++;
    }
  }
  await txDone(t);
  return purged;
}

/* ---------------------------------------------------------------------- */
/* Categories                                                               */
/* ---------------------------------------------------------------------- */

async function getAllCategories() {
  const db = await openDB();
  const t = tx(db, "categories", "readonly");
  const all = await reqToPromise(t.objectStore("categories").getAll());
  return all.sort((a, b) => a.order - b.order);
}

async function addCategory(name, icon) {
  name = name.trim();
  if (!name) throw new Error("Category name cannot be empty");
  const db = await openDB();
  const t = tx(db, "categories", "readwrite");
  const store = t.objectStore("categories");
  const all = await reqToPromise(store.getAll());
  if (all.some((c) => c.name.toLowerCase() === name.toLowerCase())) {
    throw new Error("A category with that name already exists");
  }
  const maxOrder = all.reduce((m, c) => Math.max(m, c.order || 0), -1);
  const id = await reqToPromise(
    store.add({ name, order: maxOrder + 1, isDefault: false, icon: icon || DEFAULT_ICON })
  );
  await txDone(t);
  return id;
}

async function renameCategory(id, name, icon) {
  name = name.trim();
  if (!name) throw new Error("Category name cannot be empty");
  const db = await openDB();
  const t = tx(db, "categories", "readwrite");
  const store = t.objectStore("categories");
  const all = await reqToPromise(store.getAll());
  if (all.some((c) => c.id !== id && c.name.toLowerCase() === name.toLowerCase())) {
    throw new Error("A category with that name already exists");
  }
  const existing = await reqToPromise(store.get(id));
  if (!existing) throw new Error("Category not found");
  existing.name = name;
  if (icon) existing.icon = icon;
  await reqToPromise(store.put(existing));
  await txDone(t);
  return existing;
}

// Re-adds any of the built-in categories that are missing (by name, case
// insensitive) — e.g. if one was renamed away or deleted. Never touches
// categories or skills that already exist. Returns how many were added.
async function restoreDefaultCategories() {
  const db = await openDB();
  const t = tx(db, "categories", "readwrite");
  const store = t.objectStore("categories");
  const all = await reqToPromise(store.getAll());
  const existingNames = new Set(all.map((c) => c.name.toLowerCase()));
  const maxOrder = all.reduce((m, c) => Math.max(m, c.order || 0), -1);
  let added = 0;
  DEFAULT_CATEGORIES.forEach((name, i) => {
    if (!existingNames.has(name.toLowerCase())) {
      store.add({ name, order: maxOrder + 1 + added, isDefault: true, icon: DEFAULT_CATEGORY_ICONS[name] || DEFAULT_ICON });
      added++;
    }
  });
  await txDone(t);
  return added;
}

// Deletes a category and reassigns any skills in it to the "Other" category
// (creating "Other" if it was somehow removed). Returns number of skills moved.
async function deleteCategory(id) {
  const db = await openDB();
  const categories = await getAllCategories();
  const target = categories.find((c) => c.id === id);
  if (!target) throw new Error("Category not found");

  let fallback = categories.find((c) => c.id !== id && c.name.toLowerCase() === "other");
  if (!fallback) {
    const fallbackId = await addCategory("Other");
    fallback = { id: fallbackId, name: "Other" };
  }

  const t = tx(db, ["skills", "categories"], "readwrite");
  const skillsStore = t.objectStore("skills");
  const catStore = t.objectStore("categories");

  const allSkills = await reqToPromise(skillsStore.getAll());
  const affected = allSkills.filter((s) => s.category === id);
  for (const s of affected) {
    s.category = fallback.id;
    s.updatedAt = Date.now();
    skillsStore.put(s);
  }
  catStore.delete(id);

  await txDone(t);
  return affected.length;
}

/* ---------------------------------------------------------------------- */
/* Settings                                                                 */
/* ---------------------------------------------------------------------- */

async function getSetting(key, defaultValue) {
  const db = await openDB();
  const t = tx(db, "settings", "readonly");
  const row = await reqToPromise(t.objectStore("settings").get(key));
  return row ? row.value : defaultValue;
}

async function setSetting(key, value) {
  const db = await openDB();
  const t = tx(db, "settings", "readwrite");
  await reqToPromise(t.objectStore("settings").put({ key, value }));
  await txDone(t);
}

async function getAllSettings() {
  const db = await openDB();
  const t = tx(db, "settings", "readonly");
  const rows = await reqToPromise(t.objectStore("settings").getAll());
  const map = {};
  rows.forEach((r) => (map[r.key] = r.value));
  return map;
}

/* ---------------------------------------------------------------------- */
/* Backup / restore                                                         */
/* ---------------------------------------------------------------------- */

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function dataURLToBlob(dataURL) {
  const res = await fetch(dataURL);
  return res.blob();
}

async function exportAllData() {
  const [skills, categories, settings] = await Promise.all([
    getAllSkills(),
    getAllCategories(),
    getAllSettings(),
  ]);

  const skillsOut = [];
  for (const s of skills) {
    let media = null;
    if (s.media && s.media.blob) {
      media = {
        mime: s.media.mime,
        kind: s.media.kind,
        dataURL: await blobToDataURL(s.media.blob),
      };
    }
    skillsOut.push({ ...s, media });
  }

  return {
    app: "LearnLog",
    backupVersion: 1,
    exportedAt: new Date().toISOString(),
    categories,
    skills: skillsOut,
    settings,
  };
}

// Fully replaces existing data with the contents of a backup file.
async function restoreAllData(data) {
  if (!data || !Array.isArray(data.skills) || !Array.isArray(data.categories)) {
    throw new Error("This file doesn't look like a valid LearnLog backup.");
  }

  // Resolve every photo/video back into a Blob *before* opening the write
  // transaction below. IndexedDB transactions auto-close if you await any
  // non-IDB async work (like fetch/FileReader) while they're open, so all
  // of that has to happen first.
  const preparedSkills = [];
  for (const s of data.skills) {
    let media = null;
    if (s.media && s.media.dataURL) {
      media = {
        mime: s.media.mime,
        kind: s.media.kind,
        blob: await dataURLToBlob(s.media.dataURL),
      };
    }
    const { id, ...rest } = s;
    preparedSkills.push({ ...rest, media, id });
  }

  const db = await openDB();
  const t = tx(db, ["skills", "categories", "settings"], "readwrite");
  const skillsStore = t.objectStore("skills");
  const catStore = t.objectStore("categories");
  const settingsStore = t.objectStore("settings");

  await Promise.all([
    reqToPromise(skillsStore.clear()),
    reqToPromise(catStore.clear()),
    reqToPromise(settingsStore.clear()),
  ]);

  for (const c of data.categories) {
    const { id, ...rest } = c;
    catStore.add({ ...rest, id });
  }

  for (const s of preparedSkills) {
    skillsStore.add(s);
  }

  if (data.settings) {
    Object.entries(data.settings).forEach(([key, value]) => {
      settingsStore.put({ key, value });
    });
  }

  await txDone(t);
}

window.LearnLogDB = {
  DEFAULT_CATEGORIES,
  DEFAULT_CATEGORY_ICONS,
  DEFAULT_ICON,
  getAllSkills,
  getDeletedSkills,
  getSkill,
  addSkill,
  updateSkill,
  deleteSkill,
  softDeleteSkill,
  restoreSkill,
  purgeExpiredDeletedSkills,
  getAllCategories,
  addCategory,
  renameCategory,
  deleteCategory,
  restoreDefaultCategories,
  getSetting,
  setSetting,
  getAllSettings,
  exportAllData,
  restoreAllData,
};
