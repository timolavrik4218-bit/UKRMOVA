const SUPABASE_URL = "https://axuhkvmhwzusrkazcdvn.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF4dWhrdm1od3p1c3JrYXpjZHZuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE4MjIyMTAsImV4cCI6MjEwNzM5ODIxMH0.UmuHi8S-dyC8BAXI-H-yUspAJpGZBElvaIPJ6oVDyjw";
const ADMIN_EMAIL = "timo.lavrik4218@gmail.com";
const INACTIVITY_TIMEOUT_MS = 10 * 60 * 1000;
// Set this only for local demo mode. In production assign the role in Supabase SQL.
const DEMO_ADMIN_PHONE = "+380000000000";
const hasSupabase = window.supabase && !SUPABASE_URL.includes("YOUR_PROJECT") && !SUPABASE_ANON_KEY.includes("YOUR_ANON_KEY");
const client = hasSupabase ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true
  }
}) : null;
const demoUsersKey = "ukr-class-demo-users";
const cookieConsentKey = "ukr-class-cookie-consent";
let currentUser = null;
let inactivityTimer = null;
let adminWorkSubjectFilter = "all";
let adminWorkStudentFilter = "all";
let adminWorkThemeFilter = "all";
let publicWorkSubjectFilter = "all";
let publicWorkStudentFilter = "all";
let publicWorkThemeFilter = "all";
let publicWorksCache = [];
let adminWorksCache = [];
const subjectLabels = {
  all: "Усі",
  literature: "Українська література",
  language: "Українська мова",
  creative: "Проєкти",
  homework: "Домашнє завдання"
};
const $ = (selector) => document.querySelector(selector);

function showToast(message) {
  const toast = $("#toast"); toast.textContent = message; toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), 3200);
}
function setupCookieConsent() {
  if (localStorage.getItem(cookieConsentKey)) return;
  $("#cookie-banner").hidden = false;
  const saveConsent = (value) => {
    localStorage.setItem(cookieConsentKey, value);
    $("#cookie-banner").hidden = true;
  };
  $("#necessary-cookies").addEventListener("click", () => saveConsent("necessary"));
  $("#allow-cookies").addEventListener("click", () => saveConsent("all"));
}
function navigate(view) {
  document.querySelectorAll(".view").forEach((el) => el.classList.toggle("active", el.id === `${view}-view`));
  document.querySelectorAll(".nav-link").forEach((el) => el.classList.toggle("active", el.dataset.view === view));
  window.scrollTo({ top: 0, behavior: "smooth" });
}
function escapeHTML(value) {
  return String(value || "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[character]));
}
function todayISO() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}
function renderDailyLesson(lesson) {
  $("#daily-lesson").innerHTML = lesson
    ? `<span class="lesson-label">Тема на сьогодні</span><strong>${escapeHTML(lesson.topic)}</strong><small>Домашнє завдання</small><p>${escapeHTML(lesson.homework)}</p>`
    : "<strong>Сьогоднішню тему ще не додано</strong><span>Вчителька зможе опублікувати її в адмін-панелі.</span>";
}
async function loadDailyLesson() {
  if (!hasSupabase) return renderDailyLesson(null);
  const result = await client.from("daily_lessons").select("topic, homework").eq("lesson_date", todayISO()).eq("subject", "language").maybeSingle();
  if (result.error) return showToast("Не вдалося завантажити тему уроку.");
  renderDailyLesson(result.data);
}
async function saveDailyLesson(event) {
  event.preventDefault();
  if (!currentUser || currentUser.role !== "admin") return showToast("Тільки адміністратор може змінювати тему.");
  if (!hasSupabase) return showToast("Тему можна зберігати після підключення Supabase.");
  const result = await client.from("daily_lessons").upsert({
    lesson_date: todayISO(),
    subject: "language",
    topic: $("#lesson-topic").value.trim(),
    homework: $("#lesson-homework").value.trim(),
    updated_by: currentUser.id,
    updated_at: new Date().toISOString()
  }, { onConflict: "lesson_date" }).select("topic, homework").single();
  if (result.error) return showToast("Не вдалося зберегти тему уроку.");
  renderDailyLesson(result.data);
  $("#lesson-topic").value = "";
  $("#lesson-homework").value = "";
  showToast("Тему й домашнє завдання збережено.");
}
function detectMediaKind(file) {
  if (!file) return "document";
  if (file.type?.startsWith("image/")) return "image";
  if (file.type?.startsWith("video/")) return "video";
  if (file.type?.startsWith("audio/")) return "audio";
  if (/zip|rar|7z/.test(file.type || file.name)) return "archive";
  return "document";
}
function renderMediaPreview(media = []) {
  if (!media.length) return "";
  const preview = media.find((item) => ["image", "video"].includes(item.media_kind)) || media[0];
  if (!preview || !preview.public_url) {
    return `<div class="work-media media-file"><a href="${preview ? escapeHTML(preview.public_url || "#") : "#"}" target="_blank" rel="noreferrer">📎 ${escapeHTML(preview?.file_name || "Файл")}</a></div>`;
  }
  if (preview.media_kind === "image") {
    return `<div class="work-media"><img src="${escapeHTML(preview.public_url)}" alt="${escapeHTML(preview.file_name || "Зображення роботи")}" loading="lazy"></div>`;
  }
  if (preview.media_kind === "video") {
    return `<div class="work-media"><video src="${escapeHTML(preview.public_url)}" controls playsinline preload="metadata"></video></div>`;
  }
  return `<div class="work-media media-file"><a href="${escapeHTML(preview.public_url)}" target="_blank" rel="noreferrer">📎 ${escapeHTML(preview.file_name || "Файл")}</a></div>`;
}
function matchesSubjectFilter(filter, subject) {
  if (!filter || filter === "all") return true;
  if (filter === "homework") return ["language", "literature"].includes(subject);
  return subject === filter;
}
function renderWorks(works = []) {
  $("#works-grid").innerHTML = works.length ? works.map((work) => `<article class="work-card">${renderMediaPreview(work.media || [])}<span class="work-type">${escapeHTML(work.type)}</span><h3>${escapeHTML(work.title)}</h3><p>${escapeHTML(work.text)}</p>${work.author ? `<small>${escapeHTML(work.author)}</small>` : ""}${work.theme ? `<small class="work-theme">Тема: ${escapeHTML(work.theme)}</small>` : ""}<span class="work-arrow">↗</span></article>`).join("") : '<div class="empty-state"><strong>Поки що немає робіт</strong><span>Учнівські роботи з’являться тут після першої публікації.</span></div>';
}
function renderPublicWorks() {
  const filtered = publicWorksCache.filter((work) => {
    const subjectMatch = matchesSubjectFilter(publicWorkSubjectFilter, work.subject);
    const studentMatch = publicWorkStudentFilter === "all" || work.author_id === publicWorkStudentFilter;
    const themeMatch = publicWorkThemeFilter === "all" || work.theme === publicWorkThemeFilter;
    return subjectMatch && studentMatch && themeMatch;
  });
  renderWorks(filtered.map((work) => ({
    title: work.title,
    text: work.description,
    type: subjectLabels[work.subject] || "Робота",
    author: work.profiles?.full_name || "",
    media: work.work_media || [],
    subject: work.subject,
    author_id: work.author_id,
    theme: work.theme
  })));
}
function populatePublicWorkFilters(students = []) {
  const subjectSelect = $("#works-subject-filter");
  const studentSelect = $("#works-student-filter");
  const themeSelect = $("#works-theme-filter");
  if (!subjectSelect || !studentSelect || !themeSelect) return;
  const themes = [...new Set(publicWorksCache.map((work) => work.theme).filter(Boolean))].sort((a, b) => a.localeCompare(b, "uk"));
  themeSelect.innerHTML = '<option value="all">Усі теми</option>' + themes.map((theme) => `<option value="${escapeHTML(theme)}">${escapeHTML(theme)}</option>`).join("");
  subjectSelect.value = publicWorkSubjectFilter;
  studentSelect.innerHTML = '<option value="all">Усі учні</option>' + students.map((student) => `<option value="${escapeHTML(student.id)}">${escapeHTML(student.name)}</option>`).join("");
  studentSelect.value = publicWorkStudentFilter;
  themeSelect.value = themes.includes(publicWorkThemeFilter) ? publicWorkThemeFilter : "all";
  publicWorkThemeFilter = themeSelect.value;
}
function renderRegistrationCodes(codes = []) {
  $("#registration-codes-list").innerHTML = codes.length
    ? codes.map((code) => {
      const expires = code.expires_at ? new Date(code.expires_at).toLocaleString("uk-UA") : "без терміну";
      const state = !code.is_active ? "відкликаний" : code.used_count >= code.max_uses ? "використаний" : "активний";
      const revoke = code.is_active && code.used_count < code.max_uses ? `<button class="revoke-code" data-id="${escapeHTML(code.id)}">Відкликати</button>` : "";
      return `<div class="user-row"><span class="user-dot">#</span><div class="user-info"><b>${escapeHTML(code.label)}</b><small>${code.used_count}/${code.max_uses} використань · ${escapeHTML(expires)} · ${state}</small></div>${revoke}</div>`;
    }).join("")
    : "<p style=\"padding:24px;color:#777\">Кодів ще немає.</p>";
  document.querySelectorAll(".revoke-code").forEach((button) => button.addEventListener("click", async () => {
    const result = await client.rpc("admin_revoke_registration_code", { target_code_id: button.dataset.id });
    if (result.error) return showToast(`Не вдалося відкликати код: ${result.error.message}`);
    await loadRegistrationCodes();
    showToast("Код реєстрації відкликано.");
  }));
}
async function loadRegistrationCodes() {
  if (!hasSupabase || currentUser?.role !== "admin") return;
  const result = await client.from("registration_codes").select("id, label, max_uses, used_count, expires_at, is_active").order("created_at", { ascending: false });
  if (result.error) return showToast(`Не вдалося завантажити коди: ${result.error.message}`);
  renderRegistrationCodes(result.data);
}
async function createRegistrationCode(event) {
  event.preventDefault();
  if (!hasSupabase || currentUser?.role !== "admin") return showToast("Тільки адміністратор може створювати коди.");
  const label = $("#registration-code-label").value.trim();
  const maxUses = Number($("#registration-code-uses").value);
  const expiryValue = $("#registration-code-expires").value;
  const expiresAt = expiryValue ? new Date(expiryValue).toISOString() : null;
  const result = await client.rpc("create_registration_code", {
    p_label: label,
    p_expires_at: expiresAt,
    p_max_uses: maxUses
  });
  if (result.error) return showToast(`Не вдалося створити код: ${result.error.message}`);
  const generated = Array.isArray(result.data) ? result.data[0] : result.data;
  $("#generated-registration-code").textContent = generated.code;
  $("#generated-code-output").hidden = false;
  $("#registration-code-form").reset();
  await loadRegistrationCodes();
  showToast("Код створено. Збережіть його зараз — повторно показати код неможливо.");
}
async function loadWorks() {
  if (!hasSupabase) return renderWorks();
  const result = await client.from("works").select("id, author_id, title, description, subject, theme, profiles(full_name), work_media(file_name, public_url, media_kind)").eq("status", "published").order("created_at", { ascending: false });
  if (result.error) return showToast("Не вдалося завантажити роботи.");
  publicWorksCache = result.data.map((work) => ({
    id: work.id,
    author_id: work.author_id,
    title: work.title,
    description: work.description,
    subject: work.subject,
    theme: work.theme || "Інша тема",
    profiles: work.profiles,
    work_media: work.work_media || []
  }));
  const students = [...new Map(publicWorksCache.filter((work) => work.author_id).map((work) => [work.author_id, { id: work.author_id, name: work.profiles?.full_name || "Учень" }])).values()];
  populatePublicWorkFilters(students);
  renderPublicWorks();
}
async function uploadWorkFiles(workId, files) {
  if (!files.length) return [];
  const uploaded = [];
  for (const file of files) {
    const folderName = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const safeName = file.name.replace(/\s+/g, "-").replace(/[^a-zA-Z0-9_.-]/g, "");
    const path = `${currentUser.id}/${workId}/${folderName}-${safeName}`;
    const uploadResult = await client.storage.from("work-project-files").upload(path, file, {
      cacheControl: "3600",
      upsert: false,
      contentType: file.type || "application/octet-stream"
    });
    if (uploadResult.error) throw new Error(uploadResult.error.message);
    const publicUrl = client.storage.from("work-project-files").getPublicUrl(path).data.publicUrl;
    const record = await client.from("work_media").insert({
      work_id: workId,
      file_name: file.name,
      storage_path: path,
      public_url: publicUrl,
      mime_type: file.type || "application/octet-stream",
      file_size: file.size || 0,
      media_kind: detectMediaKind(file)
    });
    if (record.error) throw new Error(record.error.message);
    uploaded.push({ file_name: file.name, public_url: publicUrl, media_kind: detectMediaKind(file) });
  }
  return uploaded;
}
function openWorkForm() {
  if (!currentUser) return openAuth("login");
  if (currentUser.role !== "admin" && currentUser.identityStatus !== "verified") {
    return showToast("Додавати проєкти можна після підтвердження акаунта адміністратором.");
  }
  $("#auth-modal").hidden = false;
  $("#auth-content").innerHTML = `<p class="eyebrow">галерея класу</p><h2>Додати проєкт</h2><p>Після надсилання робота потрапить адміністратору на перевірку.</p><form id="work-form"><label for="work-title">Назва</label><input id="work-title" maxlength="120" required><label for="work-subject">Розділ</label><select id="work-subject" required><option value="literature">Українська література</option><option value="language">Українська мова</option><option value="creative">Творчість</option></select><label for="work-theme">Тема</label><input id="work-theme" list="work-theme-list" maxlength="80" placeholder="Наприклад: Літери та звуки" required><datalist id="work-theme-list">${[...new Set(publicWorksCache.map((work) => work.theme).filter(Boolean).concat(["Літери та звуки", "Речення", "Твори про рідну землю", "Підсумкова робота"]))].slice(0, 12).map((theme) => `<option value="${escapeHTML(theme)}"></option>`).join("")}</datalist><label for="work-description">Опис або текст роботи</label><textarea id="work-description" maxlength="2000" required></textarea><label for="work-files">Фото, відео або інші файли</label><input id="work-files" type="file" multiple accept="image/*,video/*,.pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.txt,.zip,.rar"><small class="helper-text">Можна завантажити кілька файлів: фото, відео, PDF, документи тощо.</small><button class="primary-button" type="submit">Надіслати на перевірку <span>→</span></button></form>`;
  $("#work-form").addEventListener("submit", submitWork);
}
async function submitWork(event) {
  event.preventDefault();
  if (!hasSupabase) return showToast("Надсилання проєктів доступне після підключення Supabase.");
  const files = Array.from($("#work-files").files || []);
  const workPayload = {
    author_id: currentUser.id,
    title: $("#work-title").value.trim(),
    description: $("#work-description").value.trim(),
    subject: $("#work-subject").value,
    theme: $("#work-theme").value.trim() || "Інша тема",
    status: "pending"
  };
  const result = await client.from("works").insert(workPayload).select("id").single();
  if (result.error) return showToast(`Не вдалося надіслати проєкт: ${result.error.message}`);
  try {
    if (files.length) {
      await uploadWorkFiles(result.data.id, files);
    }
    $("#auth-modal").hidden = true;
    showToast("Проєкт надіслано адміністратору на перевірку.");
  } catch (error) {
    showToast(`Проєкт збережено, але файли не завантажилися: ${error.message}`);
    $("#auth-modal").hidden = true;
  }
}
function renderAdminWorkFilters(users = []) {
  const subjectButtons = Object.entries(subjectLabels).map(([key, label]) => `<button class="admin-filter-pill ${adminWorkSubjectFilter === key ? "active" : ""}" data-admin-subject="${key}">${escapeHTML(label)}</button>`).join("");
  const studentButtons = [{ id: "all", name: "Усі учні" }, ...users.filter((user) => user.role !== "admin").map((user) => ({ id: user.id, name: user.name || user.email || "Учень" }))].map((student) => `<button class="admin-filter-pill ${adminWorkStudentFilter === student.id ? "active" : ""}" data-admin-student="${student.id}">${escapeHTML(student.name)}</button>`).join("");
  const themeButtons = [{ id: "all", name: "Усі теми" }, ...[...new Set((adminWorksCache || []).map((work) => work.theme).filter(Boolean))].sort((a, b) => a.localeCompare(b, "uk")).map((theme) => ({ id: theme, name: theme }))].map((theme) => `<button class="admin-filter-pill ${adminWorkThemeFilter === theme.id ? "active" : ""}" data-admin-theme="${escapeHTML(theme.id)}">${escapeHTML(theme.name)}</button>`).join("");
  $("#admin-subject-tabs").innerHTML = subjectButtons;
  $("#admin-student-tabs").innerHTML = studentButtons;
  $("#admin-theme-tabs").innerHTML = themeButtons;
  document.querySelectorAll("[data-admin-subject]").forEach((button) => button.addEventListener("click", () => {
    adminWorkSubjectFilter = button.dataset.adminSubject;
    renderAdminWorkFilters(users);
    renderAdminWorks(adminWorksCache, adminWorkSubjectFilter, adminWorkStudentFilter, adminWorkThemeFilter);
  }));
  document.querySelectorAll("[data-admin-student]").forEach((button) => button.addEventListener("click", () => {
    adminWorkStudentFilter = button.dataset.adminStudent;
    renderAdminWorkFilters(users);
    renderAdminWorks(adminWorksCache, adminWorkSubjectFilter, adminWorkStudentFilter, adminWorkThemeFilter);
  }));
  document.querySelectorAll("[data-admin-theme]").forEach((button) => button.addEventListener("click", () => {
    adminWorkThemeFilter = button.dataset.adminTheme;
    renderAdminWorkFilters(users);
    renderAdminWorks(adminWorksCache, adminWorkSubjectFilter, adminWorkStudentFilter, adminWorkThemeFilter);
  }));
}
function renderAdminWorks(works = [], subject = adminWorkSubjectFilter, studentId = adminWorkStudentFilter, theme = adminWorkThemeFilter) {
  const filteredWorks = works.filter((work) => {
    const subjectMatch = matchesSubjectFilter(subject, work.subject);
    const studentMatch = studentId === "all" || work.author_id === studentId;
    const themeMatch = theme === "all" || work.theme === theme;
    return subjectMatch && studentMatch && themeMatch;
  });
  $("#admin-works-list").innerHTML = filteredWorks.length ? filteredWorks.map((work) => {
    const author = work.profiles?.full_name || work.profiles?.email || "Невідомий учень";
    const statusNames = { pending: "на перевірці", published: "опубліковано", rejected: "відхилено" };
    const actions = work.status === "pending"
      ? `<button class="approve-work" data-id="${escapeHTML(work.id)}">Дозволити</button><button class="reject-work" data-id="${escapeHTML(work.id)}">Відхилити</button>`
      : `<button class="delete-work" data-id="${escapeHTML(work.id)}">Видалити</button>`;
    const mediaLinks = Array.isArray(work.work_media) && work.work_media.length
      ? `<div class="work-attachments">${work.work_media.map((item) => `<a href="${escapeHTML(item.public_url || "#")}" target="_blank" rel="noreferrer">${escapeHTML(item.file_name || "Файл")}</a>`).join("")}</div>`
      : "";
    return `<div class="admin-work-row"><div class="user-info"><b>${escapeHTML(work.title)}</b><small>${escapeHTML(author)} · ${subjectLabels[work.subject] || "Робота"} · ${escapeHTML(work.theme || "Інша тема")} · ${statusNames[work.status] || work.status}</small><p>${escapeHTML(work.description)}</p>${mediaLinks}</div><div class="admin-work-actions">${actions}</div></div>`;
  }).join("") : "<p style=\"padding:24px;color:#777\">За цим фільтром робіт немає.</p>";
  document.querySelectorAll(".approve-work, .reject-work").forEach((button) => button.addEventListener("click", () => moderateWork(button.dataset.id, button.classList.contains("approve-work") ? "published" : "rejected")));
  document.querySelectorAll(".delete-work").forEach((button) => button.addEventListener("click", () => deleteWork(button.dataset.id)));
}
async function loadAdminWorks() {
  if (!hasSupabase || currentUser?.role !== "admin") return;
  const result = await client.from("works").select("id, author_id, title, description, subject, theme, status, created_at, profiles(full_name, email), work_media(file_name, public_url, media_kind)").order("created_at", { ascending: false });
  if (result.error) return showToast(`Не вдалося завантажити проєкти: ${result.error.message}`);
  adminWorksCache = result.data.map((work) => ({ ...work, theme: work.theme || "Інша тема" }));
  renderAdminWorks(adminWorksCache, adminWorkSubjectFilter, adminWorkStudentFilter, adminWorkThemeFilter);
}
async function moderateWork(id, status) {
  const result = await client.from("works").update({ status }).eq("id", id);
  if (result.error) return showToast(`Не вдалося змінити статус: ${result.error.message}`);
  await loadAdminWorks();
  await loadWorks();
  showToast(status === "published" ? "Проєкт опубліковано." : "Проєкт відхилено.");
}
async function deleteWork(id) {
  if (!confirm("Видалити цей проєкт?")) return;
  const result = await client.from("works").delete().eq("id", id);
  if (result.error) return showToast(`Не вдалося видалити проєкт: ${result.error.message}`);
  await loadAdminWorks();
  await loadWorks();
  showToast("Проєкт видалено.");
}
function getDemoUsers() {
  return JSON.parse(localStorage.getItem(demoUsersKey) || "[]");
}
async function hashIdentity(value) {
  const bytes = new TextEncoder().encode(value.trim().toLocaleLowerCase("uk-UA"));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
function setCurrentUser(user) {
  currentUser = user;
  $("#admin-nav").hidden = true;
  $("#logout-button").hidden = !user;
  if (user) {
    startInactivityTimer();
    $("#avatar").textContent = (user.name || user.phone || "?").charAt(0).toUpperCase();
    if (user.role === "admin") $("#admin-nav").hidden = false;
  } else {
    stopInactivityTimer();
    $("#avatar").textContent = "?";
    navigate("home");
  }
}
function stopInactivityTimer() {
  if (inactivityTimer) clearTimeout(inactivityTimer);
  inactivityTimer = null;
}
function startInactivityTimer() {
  stopInactivityTimer();
  inactivityTimer = setTimeout(() => {
    signOut("Вас автоматично виведено після 10 хвилин бездіяльності.");
  }, INACTIVITY_TIMEOUT_MS);
}
function registerActivity() {
  if (currentUser) startInactivityTimer();
}
async function signOut(message = "Ви вийшли з акаунта.") {
  if (hasSupabase) {
    const result = await client.auth.signOut();
    if (result.error) return showToast(`Не вдалося вийти: ${result.error.message}`);
  }
  setCurrentUser(null);
  showToast(message);
}
async function signInWithGoogle(register = false) {
  if (!hasSupabase) return showToast("Вхід через Google доступний після підключення Supabase.");
  sessionStorage.setItem("google-auth-mode", register === "admin" ? "admin" : register ? "register" : "login");
  const result = await client.auth.signInWithOAuth({ provider: "google", options: { redirectTo: window.location.origin } });
  if (result.error) showToast("Не вдалося відкрити вхід через Google.");
}
function openIdentityClaim() {
  $("#auth-modal").hidden = false;
  $("#auth-content").innerHTML = `<p class="eyebrow">майже готово</p><h2>Код реєстрації</h2><p>Введіть код, який видав адміністратор. Він одноразовий або має обмежену кількість використань.</p><form id="identity-claim-form"><label for="identity-claim">Код реєстрації</label><input id="identity-claim" required minlength="4" maxlength="40" autocomplete="off"><button class="primary-button" type="submit">Завершити реєстрацію <span>→</span></button></form>`;
  $("#identity-claim-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const result = await client.rpc("claim_identity", { identity_hash: await hashIdentity($("#identity-claim").value) });
    if (result.error) return showToast("Цей шкільний код уже використано або він недійсний.");
    $("#auth-modal").hidden = true;
    await loadSupabaseUser((await client.auth.getUser()).data.user);
    showToast("Акаунт створено. Він очікує підтвердження адміністратором.");
  });
}
function openAuth(mode = "login") {
  const register = mode === "register";
  $("#auth-modal").hidden = false;
  $("#auth-content").innerHTML = `<p class="eyebrow">${register ? "новий учасник" : "повертаємося до класу"}</p><h2>${register ? "Створити акаунт" : "Увійти до класу"}</h2><p>${register ? "Отримайте одноразовий код на email. Для правила «одна людина — один акаунт» введіть унікальний шкільний код." : "Введіть email, щоб отримати код входу."}</p><form id="auth-form">${register ? '<label for="name">Ваше ім’я</label><input id="name" required maxlength="60" autocomplete="name"><label for="identity">Шкільний код учня</label><input id="identity" required minlength="4" maxlength="40" autocomplete="off"><small>Код має видати школа або вчителька.</small>' : ""}<label for="email">Email</label><input id="email" type="email" required placeholder="name@gmail.com" autocomplete="email"><button class="primary-button" type="submit">${register ? "Зареєструватися" : "Надіслати код"} <span>→</span></button></form><div class="auth-switch">${register ? "Вже є акаунт?" : "Вперше тут?"} <button id="switch-auth">${register ? "Увійти" : "Зареєструватися"}</button></div>`;
  $("#auth-form").addEventListener("submit", (event) => handleAuth(event, register));
  $("#switch-auth").addEventListener("click", () => openAuth(register ? "login" : "register"));
}
function openAdminAuth() {
  $("#auth-modal").hidden = false;
  $("#auth-content").innerHTML = `<p class="eyebrow">захищена зона</p><h2>Вхід адміністратора</h2><p>Ми надішлемо одноразовий код на email. Доступ відкриється лише для профілю з роллю admin.</p><form id="admin-auth-form"><label for="admin-email">Email</label><input id="admin-email" type="email" required autocomplete="email" value="timo.lavrik4218@gmail.com"><button class="primary-button" type="submit">Надіслати код <span>→</span></button></form>`;
  $("#admin-auth-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!hasSupabase) return showToast("Адмінський вхід доступний після підключення Supabase.");
    const email = $("#admin-email").value.trim().toLowerCase();
    const result = await client.auth.signInWithOtp({ email, options: { shouldCreateUser: false } });
    if (result.error) return showToast("Не вдалося надіслати код на email.");
    $("#auth-content").innerHTML = `<h2>Перевірте пошту</h2><p>Код надіслано на ${email}.</p><label for="admin-otp">Код підтвердження</label><input id="admin-otp" inputmode="numeric" autocomplete="one-time-code" maxlength="8" required><button class="primary-button" id="verify-admin-otp">Підтвердити <span>→</span></button>`;
    $("#verify-admin-otp").addEventListener("click", async () => {
      const verified = await client.auth.verifyOtp({ email, token: $("#admin-otp").value.trim(), type: "email" });
      if (verified.error) return showToast("Невірний або прострочений код.");
      await loadSupabaseUser(verified.data.user);
      if (currentUser?.role !== "admin") {
        await client.auth.signOut();
        currentUser = null;
        return showToast("Цей email не має прав адміністратора.");
      }
      $("#auth-modal").hidden = true;
      navigate("admin");
      showToast("Ви увійшли як адміністратор.");
    });
  });
}
async function handleAuth(event, register) {
  event.preventDefault();
  const email = $("#email").value.trim().toLowerCase();
  const identityHash = register ? await hashIdentity($("#identity").value) : null;
  if (hasSupabase) {
    const result = await client.auth.signInWithOtp({ email, options: { data: register ? { full_name: $("#name").value.trim() } : undefined } });
    if (result.error) return showToast(result.error.message);
    $("#auth-content").innerHTML = `<h2>Перевірте Gmail</h2><p>Ми надіслали одноразовий код на ${email}.</p><label for="otp">Код підтвердження</label><input id="otp" inputmode="numeric" maxlength="8"><button class="primary-button" id="verify-otp">Підтвердити <span>→</span></button>`;
    $("#verify-otp").addEventListener("click", async () => {
      const verified = await client.auth.verifyOtp({ email, token: $("#otp").value, type: "email" });
      if (verified.error) return showToast(verified.error.message);
      await loadSupabaseUser(verified.data.user); $("#auth-modal").hidden = true; showToast("Ви успішно увійшли!");
    });
    return;
  }
  const users = getDemoUsers();
  if (register && users.some((user) => user.email === email)) return showToast("Цей Gmail уже зареєстрований.");
  if (register && users.some((user) => user.identityHash === identityHash)) return showToast("Цей шкільний код уже використано. Одна людина може мати лише один акаунт.");
  const user = register ? { name: $("#name").value.trim(), email, identityHash, identityStatus: "pending", role: "student" } : users.find((item) => item.email === email);
  if (!user) return showToast("Акаунт із таким Gmail не знайдено.");
  if (register) { users.push(user); localStorage.setItem(demoUsersKey, JSON.stringify(users)); }
  setCurrentUser(user); $("#auth-modal").hidden = true; showToast(register ? "Акаунт створено в демо-режимі." : "Ви успішно увійшли.");
  renderAdmin();
}
async function loadSupabaseUser(authUser) {
  const { data, error } = await client.from("profiles").select("*").eq("id", authUser.id).single();
  if (error) return showToast(`Не вдалося завантажити профіль: ${error.message}`);
  if (!data) return showToast("Профіль для цього акаунта ще не створено в базі.");
  const email = data.email || authUser.email || "";
  setCurrentUser({ id: authUser.id, name: data.full_name, email, phone: data.phone, role: data.role, identityStatus: data.identity_status, identityHash: data.identity_key_hash });
  const isConfiguredAdmin = email.toLowerCase() === ADMIN_EMAIL;
  if (data.role !== "admin" && !isConfiguredAdmin && !data.identity_key_hash) return openIdentityClaim();
  if (data.role !== "admin" && !isConfiguredAdmin && data.identity_status !== "verified") showToast("Акаунт очікує перевірки шкільного коду адміністратором.");
  renderAdmin();
}
async function renderAdmin() {
  let users = getDemoUsers();
  if (hasSupabase && currentUser?.role === "admin") {
    const result = await client.from("profiles").select("*").order("created_at", { ascending: false });
    if (result.error) return showToast("Не вдалося завантажити список користувачів.");
    users = result.data.map((user) => ({ id: user.id, name: user.full_name, email: user.email, phone: user.phone, role: user.role, identityStatus: user.identity_status }));
  }
  $("#user-count").textContent = users.length || "0";
  $("#users-list").innerHTML = users.length ? users.map((user, index) => `<div class="user-row"><span class="user-dot">${user.name.charAt(0).toUpperCase()}</span><div class="user-info"><b>${user.name}</b><small>${user.email || user.phone || ""} · ${user.role === "admin" ? "адміністратор" : "учень"} · ${user.identityStatus === "verified" ? "особу підтверджено" : "очікує перевірки"}</small></div>${user.role !== "admin" ? `${user.identityStatus !== "verified" ? `<button class="verify-user" data-index="${index}">Підтвердити</button>` : ""}<button class="delete-user" data-index="${index}">Видалити</button>` : ""}</div>`).join("") : "<p style=\"padding:24px;color:#777\">Користувачів ще немає.</p>";
  document.querySelectorAll(".verify-user").forEach((button) => button.addEventListener("click", async () => {
    const selected = users[Number(button.dataset.index)];
    if (hasSupabase) {
      const result = await client.rpc("admin_verify_identity", { target_user_id: selected.id, approve: true });
      if (result.error) return showToast("Не вдалося підтвердити особу.");
    } else {
      const next = getDemoUsers(); next[Number(button.dataset.index)].identityStatus = "verified"; localStorage.setItem(demoUsersKey, JSON.stringify(next));
    }
    renderAdmin(); showToast("Особу підтверджено.");
  }));
  document.querySelectorAll(".delete-user").forEach((button) => button.addEventListener("click", () => {
    if (!confirm("Видалити цей акаунт?")) return;
    const selected = users[Number(button.dataset.index)];
    if (hasSupabase) {
      client.rpc("admin_delete_user", { target_user_id: selected.id }).then((result) => {
        if (result.error) return showToast("Не вдалося видалити акаунт.");
        renderAdmin(); showToast("Акаунт видалено.");
      });
      return;
    }
    const next = getDemoUsers(); next.splice(Number(button.dataset.index), 1); localStorage.setItem(demoUsersKey, JSON.stringify(next)); renderAdmin(); showToast("Акаунт видалено.");
  }));
  renderAdminWorkFilters(users);
  loadRegistrationCodes();
  loadAdminWorks();
}
document.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => {
  const view = button.dataset.view;
  if (view === "admin" && (!currentUser || currentUser.role !== "admin")) return openAdminAuth();
  navigate(view);
}));
$("#daily-lesson-form").addEventListener("submit", saveDailyLesson);
$("#registration-code-form").addEventListener("submit", createRegistrationCode);
$("#copy-registration-code").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($("#generated-registration-code").textContent);
  } catch (error) {
    return showToast("Не вдалося скопіювати код. Виділіть його та скопіюйте вручну.");
  }
  showToast("Код скопійовано.");
});
$("#works-subject-filter")?.addEventListener("change", (event) => {
  publicWorkSubjectFilter = event.target.value;
  renderPublicWorks();
});
$("#works-student-filter")?.addEventListener("change", (event) => {
  publicWorkStudentFilter = event.target.value;
  renderPublicWorks();
});
$("#works-theme-filter")?.addEventListener("change", (event) => {
  publicWorkThemeFilter = event.target.value;
  renderPublicWorks();
});
$("#clear-works-filters")?.addEventListener("click", () => {
  publicWorkSubjectFilter = "all";
  publicWorkStudentFilter = "all";
  publicWorkThemeFilter = "all";
  $("#works-subject-filter").value = "all";
  $("#works-student-filter").value = "all";
  $("#works-theme-filter").value = "all";
  renderPublicWorks();
});
$("#profile-button").addEventListener("click", () => currentUser ? showToast(`Ви увійшли як ${currentUser.name || "учасник"}.`) : openAuth("login"));
$("#logout-button").addEventListener("click", signOut);
$("#add-work").addEventListener("click", openWorkForm);
$(".close-modal").addEventListener("click", () => { $("#auth-modal").hidden = true; });
renderWorks(); renderAdmin(); loadWorks(); loadDailyLesson();
setupCookieConsent();
["pointerdown", "keydown", "mousemove", "scroll", "touchstart"].forEach((eventName) => {
  document.addEventListener(eventName, registerActivity, { passive: true });
});
if (hasSupabase) {
  client.auth.onAuthStateChange((event, session) => {
    if (event === "SIGNED_IN" && session && !currentUser) {
      setTimeout(() => loadSupabaseUser(session.user), 0);
    }
    if (event === "SIGNED_OUT") setCurrentUser(null);
  });
  client.auth.getSession().then(async ({ data }) => {
    if (!data.session) return;
    await loadSupabaseUser(data.session.user);
    const googleMode = sessionStorage.getItem("google-auth-mode");
    sessionStorage.removeItem("google-auth-mode");
    if (googleMode === "admin") {
      if (currentUser?.role !== "admin") {
        await client.auth.signOut();
        currentUser = null;
        return showToast("Цей Google-акаунт не має прав адміністратора.");
      }
      navigate("admin");
      showToast("Ви увійшли як адміністратор.");
    }
  });
}
