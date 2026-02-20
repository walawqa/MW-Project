// app.js
import {
  auth, db, storage,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  sendPasswordResetEmail,
  updatePassword,
  onAuthStateChanged,
  updateProfile,
  collection, doc, addDoc, setDoc, getDoc, getDocs,
  updateDoc, deleteDoc, onSnapshot, query, where, orderBy,
  serverTimestamp, arrayUnion, arrayRemove,
  ref, uploadBytes, getDownloadURL
} from './firebase.js';

// ============================================================
// STATE
// ============================================================
let currentUser = null;
let currentProjectId = null;
let currentProjectView = 'list';
let currentTaskId = null;
let currentNoteId = null;
let projects = {};
let tasks = {};
let notes = {};
let members = {};
let projectListeners = {};
let taskListeners = {};
let selectedProjColor = '#6B7C5C';
let selectedColColor = '#6B7C5C';
let editingProjectId = null;
let editingColumnId = null;
let miniCalDate = new Date();
let fullCalDate = new Date();
let projCalDate = new Date();
let confirmCallback = null;
let savedProjFilters = {};
let draggedTaskId = null;
let draggedColId = null;
let collapsedSections = {}; // { projectId: Set of collapsed colIds }
let collapsedSaveTimeout = null;

// ============================================================
// LIST COLUMN CONFIG (per user, saved to Firestore)
// ============================================================
const LIST_COLUMNS_DEFAULT = [
  { id: 'checkbox',  label: '',             width: 36,  visible: true,  resizable: false },
  { id: 'title',     label: 'Nazwa zadania',width: null,visible: true,  resizable: false, flex: true },
  { id: 'desc',      label: 'Opis',         width: 200, visible: false, resizable: false },
  { id: 'assignee',  label: 'Osoba',        width: 130, visible: true,  resizable: false },
  { id: 'status',    label: 'Status',       width: 100, visible: true,  resizable: false },
  { id: 'due',       label: 'Termin',       width: 90,  visible: true,  resizable: false },
  { id: 'priority',  label: 'Priorytet',    width: 90,  visible: true,  resizable: false },
  { id: 'created',   label: 'Utworzono',    width: 110, visible: false, resizable: false },
];
let listColumnConfig = null;
let listColSaveTimeout = null;
let listSortCol = 'due';   // default sort column
let listSortDir = 'asc';   // 'asc' | 'desc'

function getListColumns() {
  const saved = listColumnConfig;
  const base = LIST_COLUMNS_DEFAULT.map(def => {
    const s = saved ? saved.find(x => x.id === def.id) : null;
    return s ? { ...def, width: s.width ?? def.width, visible: s.visible ?? def.visible } : { ...def };
  });
  if (!saved) return base;
  return base.sort((a, b) => {
    const oa = saved.findIndex(x => x.id === a.id);
    const ob = saved.findIndex(x => x.id === b.id);
    if (oa === -1 && ob === -1) return 0;
    if (oa === -1) return 1;
    if (ob === -1) return -1;
    return oa - ob;
  });
}

async function loadListColumnConfig() {
  if (!currentUser) return;
  try {
    const snap = await getDoc(doc(db, 'users', currentUser.uid));
    const saved = snap.data()?.listColumnConfig;
    if (saved && Array.isArray(saved)) listColumnConfig = saved;
  } catch(e) {}
}

function saveListColumnConfig(cols) {
  listColumnConfig = cols.map(c => ({ id: c.id, width: c.width, visible: c.visible }));
  clearTimeout(listColSaveTimeout);
  listColSaveTimeout = setTimeout(async () => {
    if (!currentUser) return;
    try {
      await updateDoc(doc(db, 'users', currentUser.uid), { listColumnConfig: listColumnConfig });
    } catch(e) {}
  }, 600);
}

async function loadCollapsedSections() {
  if (!currentUser) return;
  try {
    const snap = await getDoc(doc(db, 'users', currentUser.uid));
    const data = snap.data()?.collapsedSections || {};
    // Convert plain objects back to Sets
    collapsedSections = {};
    for (const [pid, arr] of Object.entries(data)) {
      collapsedSections[pid] = new Set(Array.isArray(arr) ? arr : []);
    }
  } catch(e) {}
}

function saveCollapsedSections() {
  clearTimeout(collapsedSaveTimeout);
  collapsedSaveTimeout = setTimeout(async () => {
    if (!currentUser) return;
    try {
      // Convert Sets to arrays for Firestore
      const toSave = {};
      for (const [pid, set] of Object.entries(collapsedSections)) {
        toSave[pid] = [...set];
      }
      await updateDoc(doc(db, 'users', currentUser.uid), { collapsedSections: toSave });
    } catch(e) {}
  }, 600);
}

// ============================================================
// UTILS
// ============================================================
function $(id) { return document.getElementById(id); }
function showToast(msg, type = 'default') {
  const tc = $('toast-container');
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.textContent = msg;
  tc.appendChild(t);
  setTimeout(() => t.remove(), 3000);
}
function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  return d.toLocaleDateString('pl-PL', { day: 'numeric', month: 'short' });
}
function formatDateTime(ts) {
  if (!ts) return '';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleString('pl-PL', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}
function isOverdue(dateStr) {
  if (!dateStr) return false;
  return new Date(dateStr) < new Date(new Date().toDateString());
}

function isTaskDone(t) {
  // Nowy model: status zadania jest osobnym polem (nie zależy od kolumny)
  // Kompatybilność wstecz: jeśli stary task nie ma pola status, użyj heurystyki po nazwie kolumny.
  if (t?.status === 'done') return true;
  if (t?.status && t.status !== 'done') return false;

  const proj = projects[t.projectId];
  if (!proj) return false;
  const col = proj.columns?.find(c => c.id === t.columnId);
  const name = (col?.name || '').toLowerCase();
  return name.includes('gotow') || name.includes('zako') || name.includes('done');
}

function priorityRank(p){return ({high:0,medium:1,low:2}[p] ?? 2);} 

function getPriorityLabel(p) {
  return { high: '🔴 Wysoki', medium: '🟡 Średni', low: '🟢 Niski' }[p] || '🟢 Niski';
}
function getInitials(name) {
  if (!name) return 'U';
  return name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
}
function generateId() {
  return Math.random().toString(36).substr(2, 9);
}

function showConfirm(title, msg, cb) {
  $('confirm-title').textContent = title;
  $('confirm-message').textContent = msg;
  confirmCallback = cb;
  $('confirm-modal').classList.remove('hidden');
}

function openModal(id) {
  $(id).classList.remove('hidden');
}
function closeModal(id) {
  $(id).classList.add('hidden');
}

// ============================================================
// INTRO ANIMATION
// ============================================================
function runIntro() {
  const overlay = $('intro-overlay');
  setTimeout(() => {
    overlay.style.transition = 'opacity .5s ease';
    overlay.style.opacity = '0';
    setTimeout(() => {
      overlay.style.display = 'none';
    }, 500);
  }, 4000);
}

// ============================================================
// AUTH
// ============================================================
function showAuthScreen() {
  $('auth-screen').classList.remove('hidden');
  $('app').classList.add('hidden');
}
function showApp() {
  $('auth-screen').classList.add('hidden');
  $('app').classList.remove('hidden');
}

async function register() {
  const name = $('reg-name').value.trim();
  const email = $('reg-email').value.trim();
  const pw = $('reg-password').value;
  if (!name || !email || !pw) { showToast('Wypełnij wszystkie pola', 'error'); return; }
  try {
    const cred = await createUserWithEmailAndPassword(auth, email, pw);
    await updateProfile(cred.user, { displayName: name });
    await setDoc(doc(db, 'users', cred.user.uid), {
      name, email, createdAt: serverTimestamp()
    });
    showToast('Konto utworzone! Witaj 👋', 'success');
  } catch (e) {
    showToast(e.message, 'error');
  }
}

async function login() {
  const email = $('login-email').value.trim();
  const pw = $('login-password').value;
  if (!email || !pw) { showToast('Podaj email i hasło', 'error'); return; }
  try {
    await signInWithEmailAndPassword(auth, email, pw);
  } catch (e) {
    showToast('Nieprawidłowe dane logowania', 'error');
  }
}

async function forgotPassword() {
  const email = $('forgot-email').value.trim();
  if (!email) { showToast('Podaj email', 'error'); return; }
  try {
    await sendPasswordResetEmail(auth, email);
    showToast('Link do resetu hasła wysłany!', 'success');
    showLoginForm();
  } catch (e) {
    showToast(e.message, 'error');
  }
}

function showLoginForm() {
  $('login-form').classList.remove('hidden');
  $('register-form').classList.add('hidden');
  $('forgot-form').classList.add('hidden');
}
function showRegisterForm() {
  $('register-form').classList.remove('hidden');
  $('login-form').classList.add('hidden');
  $('forgot-form').classList.add('hidden');
}
function showForgotForm() {
  $('forgot-form').classList.remove('hidden');
  $('login-form').classList.add('hidden');
  $('register-form').classList.add('hidden');
}

async function logout() {
  await signOut(auth);
  Object.values(projectListeners).forEach(u => u());
  Object.values(taskListeners).forEach(u => u());
  projectListeners = {};
  taskListeners = {};
  projects = {};
  tasks = {};
  collapsedSections = {};
  listColumnConfig = null;
}

// ============================================================
// NAVIGATION
// ============================================================
function navigateTo(view, extraData) {
  document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));

  const viewEl = $(`view-${view}`);
  if (viewEl) viewEl.classList.remove('hidden');

  const navEl = document.querySelector(`[data-view="${view}"]`);
  if (navEl) navEl.classList.add('active');

  if (view === 'dashboard') renderDashboard();
  if (view === 'projects') renderProjectsView();
  if (view === 'calendar') renderFullCalendar();
  if (view === 'statistics') renderStatistics();
  if (view === 'notes') renderNotes();
  if (view === 'project' && extraData) openProject(extraData);
}

// ============================================================
// CLOCK & DATE
// ============================================================
function startClock() {
  function tick() {
    const now = new Date();
    const clockEl = $('header-clock');
    if (clockEl) {
      clockEl.textContent = now.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });
    }
    const dateEl = $('dashboard-date');
    if (dateEl) {
      dateEl.textContent = now.toLocaleDateString('pl-PL', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    }
    const greet = $('dashboard-greeting');
    if (greet) {
      const h = now.getHours();
      const name = currentUser?.displayName?.split(' ')[0] || '';
      greet.textContent = h < 12 ? `Dzień dobry, ${name}!` : h < 18 ? `Dobry wieczór, ${name}!` : `Dobranoc, ${name}!`;
    }
  }
  tick();
  setInterval(tick, 1000);
}

// ============================================================
// USER INFO
// ============================================================
function updateUserUI() {
  if (!currentUser) return;
  const name = currentUser.displayName || 'Użytkownik';
  const email = currentUser.email || '';
  $('user-name-sidebar').textContent = name;
  $('user-email-sidebar').textContent = email;
  $('user-avatar-sidebar').textContent = getInitials(name);
  $('comment-avatar').textContent = getInitials(name);
}

// ============================================================
// PROJECTS - FIRESTORE
// ============================================================
function subscribeToProjects() {
  if (!currentUser) return;

  const q = query(
    collection(db, 'projects'),
    where('memberIds', 'array-contains', currentUser.uid)
  );

  const unsub = onSnapshot(q, snap => {
    snap.docChanges().forEach(change => {
      const pid = change.doc.id;

      if (change.type === 'removed') {
        // Projekt usunięty / utrata dostępu
        delete projects[pid];
        delete tasks[pid];

        // Odetnij listener zadań, jeśli był podpięty
        if (taskListeners[pid]) {
          try { taskListeners[pid](); } catch(e) {}
          delete taskListeners[pid];
        }
        return;
      }

      // added / modified
      projects[pid] = { id: pid, ...change.doc.data() };

      // KLUCZOWE: od razu subskrybuj zadania dla projektu, żeby dashboard/statystyki działały po zalogowaniu
      subscribeToTasks(pid);
    });

    renderSidebarProjects();

    // Jeśli jesteśmy na projekcie – odśwież widoki projektu
    if (currentProjectId && projects[currentProjectId]) {
      renderProjectDashboard(currentProjectId);
      renderKanban(currentProjectId);
    }

    // Jeśli jesteśmy na dashboardzie – odśwież liczniki/kafelki (projekty mogły się załadować po taskach)
    if (document.querySelector('#view-dashboard:not(.hidden)')) {
      renderDashboardStats();
      renderUpcomingTasks();
      renderTodayTasks();
      renderMiniCalendar();
    }
  });

  projectListeners['projects'] = unsub;
}

function subscribeToTasks(projectId) {
  if (taskListeners[projectId]) return;

  const q = query(
    collection(db, 'tasks'),
    where('projectId', '==', projectId)
  );

  const unsub = onSnapshot(q, snap => {
    if (!tasks[projectId]) tasks[projectId] = {};

    snap.docChanges().forEach(change => {
      if (change.type === 'removed') {
        delete tasks[projectId][change.doc.id];
      } else {
        tasks[projectId][change.doc.id] = { id: change.doc.id, ...change.doc.data() };
      }
    });

    // Jeśli jesteśmy na projekcie – odśwież
    if (currentProjectId === projectId) {
      renderProjectDashboard(projectId);
      renderKanban(projectId);
      renderProjectList(projectId);
    }

    // Dashboard zależy od zadań – odśwież tylko gdy dashboard jest widoczny
    if (document.querySelector('#view-dashboard:not(.hidden)')) {
      renderDashboardStats();
      renderUpcomingTasks();
      renderTodayTasks();
      renderMiniCalendar();
    } else {
      // minimum: liczniki w sidebar / projekty
      renderDashboardStats();
    }

    renderSidebarProjects();
  });

  taskListeners[projectId] = unsub;
}

async function createProject(name, desc, deadline, color) {
  const projRef = await addDoc(collection(db, 'projects'), {
    name, desc, deadline: deadline || null, color,
    ownerId: currentUser.uid,
    memberIds: [currentUser.uid],
    members: [{ uid: currentUser.uid, name: currentUser.displayName || 'Użytkownik', email: currentUser.email, role: 'owner' }],
    columns: [
      { id: generateId(), name: 'Do zrobienia', color: '#6B7C5C', order: 0 },
      { id: generateId(), name: 'W toku', color: '#8B7355', order: 1 },
      { id: generateId(), name: 'Gotowe', color: '#5C7B7C', order: 2 }
    ],
    archived: false,
    createdAt: serverTimestamp()
  });
  showToast('Projekt utworzony!', 'success');
  return projRef.id;
}

async function updateProject(projectId, data) {
  await updateDoc(doc(db, 'projects', projectId), data);
}

async function deleteProject(projectId) {
  // Delete all tasks
  const tSnap = await getDocs(query(collection(db, 'tasks'), where('projectId', '==', projectId)));
  for (const td of tSnap.docs) await deleteDoc(doc(db, 'tasks', td.id));
  await deleteDoc(doc(db, 'projects', projectId));
  showToast('Projekt usunięty', 'success');
  navigateTo('projects');
}

async function archiveProject(projectId) {
  await updateDoc(doc(db, 'projects', projectId), { archived: true });
  showToast('Projekt zarchiwizowany', 'success');
  if (currentProjectId === projectId) navigateTo('projects');
}

async function restoreProject(projectId) {
  await updateDoc(doc(db, 'projects', projectId), { archived: false });
  showToast('Projekt przywrócony', 'success');
}

// ============================================================
// TASKS - FIRESTORE
// ============================================================
async function createTask(projectId, columnId, title) {
  const taskRef = await addDoc(collection(db, 'tasks'), {
    projectId, columnId, title,
    status: 'open',
    desc: '', priority: 'medium', dueDate: null,
    assigneeId: null, assigneeName: null,
    checklist: [], attachments: [], comments: [],
    history: [{ action: 'Zadanie utworzone', by: currentUser.displayName || 'Użytkownik', at: new Date().toISOString() }],
    createdAt: serverTimestamp(),
    createdBy: currentUser.uid,
    createdByName: currentUser.displayName || 'Użytkownik'
  });
  return taskRef.id;
}

async function updateTask(taskId, data, historyEntry) {
  const updates = { ...data };
  if (historyEntry) {
    const taskData = Object.values(tasks).flatMap(pt => Object.values(pt)).find(t => t.id === taskId);
    const existing = taskData?.history || [];
    updates.history = [...existing, { ...historyEntry, by: currentUser.displayName || 'Użytkownik', at: new Date().toISOString() }];
  }
  await updateDoc(doc(db, 'tasks', taskId), updates);
}

async function deleteTask(taskId) {
  await deleteDoc(doc(db, 'tasks', taskId));
  showToast('Zadanie usunięte');
}

function getTaskById(taskId) {
  for (const projTasks of Object.values(tasks)) {
    if (projTasks[taskId]) return projTasks[taskId];
  }
  return null;
}

function getAllMyTasks() {
  const all = [];
  for (const projTasks of Object.values(tasks)) {
    for (const t of Object.values(projTasks)) {
      // Pokaż zadanie jeśli jest przypisane do mnie
      // LUB jeśli jestem właścicielem projektu i zadanie nie ma assignee
      const proj = projects[t.projectId];
      const iAmOwner = proj?.ownerId === currentUser.uid;
      if (t.assigneeId === currentUser.uid) {
        all.push(t);
      } else if (!t.assigneeId && iAmOwner) {
        all.push(t);
      }
    }
  }
  return all;
}

// Zwraca WSZYSTKIE zadania z projektów do których należę (do statystyk/kalendarza)
function getAllProjectTasks() {
  const all = [];
  for (const projTasks of Object.values(tasks)) {
    for (const t of Object.values(projTasks)) {
      all.push(t);
    }
  }
  return all;
}

// ============================================================
// SIDEBAR PROJECTS
// ============================================================
function renderSidebarProjects() {
  const list = $('sidebar-project-list');
  const active = Object.values(projects).filter(p => !p.archived);
  list.innerHTML = active.map(p => `
    <div class="sidebar-project-item ${currentProjectId === p.id ? 'active' : ''}" data-id="${p.id}">
      <div class="proj-color-dot" style="background:${p.color || '#6B7C5C'}"></div>
      ${p.name}
    </div>
  `).join('');
  list.querySelectorAll('.sidebar-project-item').forEach(el => {
    el.addEventListener('click', () => navigateTo('project', el.dataset.id));
  });
}

// ============================================================
// DASHBOARD
// ============================================================
function renderDashboard() {
  renderDashboardStats();
  renderUpcomingTasks();
  renderTodayTasks();
  renderMiniCalendar();
}

function renderDashboardStats() {
  const myTasks = getAllMyTasks();
  const overdue = myTasks.filter(t => isOverdue(t.dueDate));
  const done = myTasks.filter(t => isTaskDone(t));
  $('qs-tasks').textContent = myTasks.length;
  $('qs-overdue').textContent = overdue.length;
  $('qs-projects').textContent = Object.values(projects).filter(p => !p.archived).length;
  $('qs-done').textContent = done.length;
}

function renderUpcomingTasks() {
  const list = $('upcoming-list');

  // Nadchodzące = wszystkie zadania z terminem od jutra wzwyż (bez limitu 7 dni)
  const startTomorrow = new Date();
  startTomorrow.setHours(0, 0, 0, 0);
  startTomorrow.setDate(startTomorrow.getDate() + 1);

  const allTasks = getAllProjectTasks();
  const upcoming = allTasks
    .filter(t => {
      if (!t.dueDate) return false;
      const d = new Date(t.dueDate);
      if (isNaN(d.getTime())) return false;
      if (d < startTomorrow) return false; // jutro i dalej
      if (isTaskDone(t)) return false;
      return t.assigneeId === currentUser.uid || !t.assigneeId;
    })
    .sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));

  $('upcoming-count').textContent = upcoming.length;
  if (!upcoming.length) {
    list.innerHTML = '<div class="empty-state"><p>Brak nadchodzących zadań 🎉</p></div>';
    return;
  }
  list.innerHTML = upcoming.map(t => taskFeedItem(t)).join('');
  list.querySelectorAll('.task-feed-item').forEach(el => {
    el.addEventListener('click', () => openTaskModal(el.dataset.id, el.dataset.project));
  });
}


function renderTodayTasks() {
  const list = $('today-list');
  const today = new Date().toDateString();
  const allTasks = getAllProjectTasks();
  const todayTasks = allTasks.filter(t => {
    if (isTaskDone(t)) return false;
    if (!t.dueDate || new Date(t.dueDate).toDateString() !== today) return false;
    return t.assigneeId === currentUser.uid || !t.assigneeId;
  });
  if (!todayTasks.length) {
    list.innerHTML = '<div class="empty-state"><p>Brak zadań na dziś</p></div>';
    return;
  }
  list.innerHTML = todayTasks.map(t => taskFeedItem(t)).join('');
  list.querySelectorAll('.task-feed-item').forEach(el => {
    el.addEventListener('click', () => openTaskModal(el.dataset.id, el.dataset.project));
  });
}

function taskFeedItem(t) {
  const overdue = isOverdue(t.dueDate);
  const doneTask = isTaskDone(t);
  const proj = projects[t.projectId];
  return `
    <div class="task-feed-item ${overdue ? 'overdue' : ''} ${doneTask ? 'done' : ''}" data-id="${t.id}" data-project="${t.projectId}">
      <div class="priority-dot ${t.priority || 'medium'}"></div>
      <span class="task-feed-title">${t.title}</span>
      ${proj ? `<span class="task-feed-project">${proj.name}</span>` : ''}
      ${t.dueDate ? `<span class="task-feed-due ${overdue ? 'overdue' : ''}">${formatDate(t.dueDate)}</span>` : ''}
    </div>`;
}

// ============================================================
// MINI CALENDAR
// ============================================================
function renderMiniCalendar() {
  const title = $('mini-cal-title');
  const grid = $('mini-calendar');
  const y = miniCalDate.getFullYear(), m = miniCalDate.getMonth();
  title.textContent = miniCalDate.toLocaleDateString('pl-PL', { month: 'long', year: 'numeric' });

  const days = ['Pn', 'Wt', 'Śr', 'Cz', 'Pt', 'Sb', 'Nd'];
  let html = days.map(d => `<div class="mini-cal-day-header">${d}</div>`).join('');

  const first = new Date(y, m, 1);
  let startDay = first.getDay() - 1; if (startDay < 0) startDay = 6;
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const today = new Date().toDateString();

  // Task dates
  const allProjTasks = getAllProjectTasks();
  const taskDates = new Set(allProjTasks.filter(t => t.dueDate).map(t => new Date(t.dueDate).toDateString()));

  for (let i = 0; i < startDay; i++) {
    html += `<div class="mini-cal-day other-month"></div>`;
  }
  for (let d = 1; d <= daysInMonth; d++) {
    const date = new Date(y, m, d);
    const isToday = date.toDateString() === today;
    const hasTasks = taskDates.has(date.toDateString());
    html += `<div class="mini-cal-day ${isToday ? 'today' : ''} ${hasTasks ? 'has-tasks' : ''}">${d}</div>`;
  }

  grid.innerHTML = html;
}

// ============================================================
// PROJECTS VIEW
// ============================================================
function renderProjectsView(showArchived = false) {
  const grid = $('projects-grid');
  let projs = Object.values(projects).filter(p => showArchived ? p.archived : !p.archived);
  if (!projs.length) {
    grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1">
      <p>${showArchived ? 'Brak zarchiwizowanych projektów' : 'Brak projektów. Utwórz pierwszy!'}</p>
    </div>`;
    return;
  }
  grid.innerHTML = projs.map(p => projectCard(p)).join('');
  grid.querySelectorAll('.project-card').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('.project-card-menu')) return;
      navigateTo('project', el.dataset.id);
    });
  });
  grid.querySelectorAll('.proj-menu-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const dd = btn.nextElementSibling;
      document.querySelectorAll('.project-dropdown').forEach(d => { if (d !== dd) d.classList.add('hidden'); });
      dd.classList.toggle('hidden');
    });
  });
  grid.querySelectorAll('.proj-edit-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openEditProjectModal(btn.dataset.id);
    });
  });
  grid.querySelectorAll('.proj-archive-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      showConfirm('Archiwizuj projekt', 'Projekt zostanie zarchiwizowany. Możesz go przywrócić później.', () => archiveProject(btn.dataset.id));
    });
  });
  grid.querySelectorAll('.proj-restore-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      restoreProject(btn.dataset.id);
    });
  });
  grid.querySelectorAll('.proj-delete-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      showConfirm('Usuń projekt', 'Projekt i wszystkie zadania zostaną permanentnie usunięte!', () => deleteProject(btn.dataset.id));
    });
  });
}

function projectCard(p) {
  const projTasks = Object.values(tasks[p.id] || {});
  const total = projTasks.length;
  const done = projTasks.filter(t => isTaskDone(t)).length;
  const progress = total > 0 ? Math.round(done / total * 100) : 0;
  const overdue = projTasks.filter(t => isOverdue(t.dueDate)).length;

  return `
    <div class="project-card" data-id="${p.id}" style="--proj-color:${p.color || '#6B7C5C'}">
      ${p.archived ? '<span class="archived-badge">Zarchiwizowany</span>' : ''}
      <div class="project-card-header">
        <div class="project-card-title">${p.name}</div>
        <div class="project-card-menu">
          <button class="btn-icon proj-menu-btn">⋯</button>
          <div class="project-dropdown hidden">
            <button class="project-dropdown-item proj-edit-btn" data-id="${p.id}">✏️ Edytuj</button>
            ${p.archived
              ? `<button class="project-dropdown-item proj-restore-btn" data-id="${p.id}">♻️ Przywróć</button>`
              : `<button class="project-dropdown-item proj-archive-btn" data-id="${p.id}">📦 Archiwizuj</button>`}
            <button class="project-dropdown-item danger proj-delete-btn" data-id="${p.id}">🗑 Usuń</button>
          </div>
        </div>
      </div>
      <p class="project-card-desc">${p.desc || 'Brak opisu'}</p>
      <div class="project-progress">
        <div style="display:flex;justify-content:space-between;font-size:.78rem;color:var(--text-muted)">
          <span>${done}/${total} zadań</span>
          <span>${progress}%</span>
        </div>
        <div class="progress-bar"><div class="progress-fill" style="width:${progress}%"></div></div>
      </div>
      <div class="project-card-footer">
        <span>${p.deadline ? '📅 ' + formatDate(p.deadline) : ''}</span>
        ${overdue > 0 ? `<span style="color:#E74C3C;font-weight:500">⚠️ ${overdue} po terminie</span>` : ''}
        <div class="members">
          ${(p.members || []).slice(0, 3).map(m => `<div class="member-chip">${getInitials(m.name)}</div>`).join('')}
          ${(p.members || []).length > 3 ? `<div class="member-chip">+${p.members.length - 3}</div>` : ''}
        </div>
      </div>
    </div>`;
}

// ============================================================
// PROJECT VIEW
// ============================================================
function openProject(projectId) {
  currentProjectView = 'list';
  currentProjectId = projectId;
  const proj = projects[projectId];
  if (!proj) { navigateTo('projects'); return; }

  $('project-title-header').textContent = proj.name;
  $('project-status-badge').textContent = proj.archived ? 'Zarchiwizowany' : 'Aktywny';

  subscribeToTasks(projectId);

  // Hide sub-views
  $('project-calendar-view').classList.add('hidden');
  $('gantt-view').classList.add('hidden');
  // Widoki w projekcie: kanban / lista
  // Ustaw domyślny widok po wejściu w projekt
  currentProjectView = 'list';
  if (currentProjectView === 'list') {
    $('kanban-board').classList.add('hidden');
    $('project-list-view').classList.remove('hidden');
  } else {
    $('project-list-view').classList.add('hidden');
    $('kanban-board').classList.remove('hidden');
  }
  $('project-dashboard').classList.remove('hidden');
  // Ustaw aktywny przycisk widoku
  $('project-view-kanban-btn')?.classList.toggle('active', currentProjectView !== 'list');
  $('project-view-list-btn')?.classList.toggle('active', currentProjectView === 'list');
  // Dopnij widok (ustawia klasy i pokazuje właściwy layout)
  setProjectView(currentProjectView);

  // Load saved filters
  if (savedProjFilters[projectId]) {
    const f = savedProjFilters[projectId];
    if (f.priority) $('proj-filter-priority').value = f.priority;
    if (f.assignee) $('proj-filter-assignee').value = f.assignee;
  }

  renderProjectDashboard(projectId);
  renderKanban(projectId);
  renderProjectList(projectId);
  renderSidebarProjects();
}

function getFilteredTasks(projectId) {
  const projTasks = Object.values(tasks[projectId] || {});
  const priority = $('proj-filter-priority').value;
  const assignee = $('proj-filter-assignee').value;
  return projTasks.filter(t => {
    if (priority !== 'all' && t.priority !== priority) return false;
    if (assignee !== 'all' && t.assigneeId !== assignee) return false;
    return true;
  });
}

function renderProjectDashboard(projectId) {
  const proj = projects[projectId];
  if (!proj) return;

  $('proj-stat-cards').innerHTML = '';

  // Assignee filter
  const assigneeSelect = $('proj-filter-assignee');
  const currentVal = assigneeSelect.value;
  assigneeSelect.innerHTML = '<option value="all">Wszyscy</option>';
  (proj.members || []).forEach(m => {
    assigneeSelect.innerHTML += `<option value="${m.uid}">${m.name}</option>`;
  });
  assigneeSelect.value = currentVal || 'all';
}

// ============================================================
// KANBAN
// ============================================================
function renderKanban(projectId) {
  const proj = projects[projectId];
  if (!proj) return;
  const board = $('kanban-board');
  const filteredTasks = getFilteredTasks(projectId);

  const cols = [...(proj.columns || [])].sort((a, b) => a.order - b.order);

  board.innerHTML = cols.map(col => {
    const colTasks = filteredTasks.filter(t => t.columnId === col.id);
    return `
      <div class="kanban-column" data-col-id="${col.id}" draggable="false">
        <div class="column-header" style="background:${col.color || '#6B7C5C'}11">
          <div class="column-color-bar" style="--col-color:${col.color || '#6B7C5C'}"></div>
          <span class="column-title">${col.name}</span>
          <span class="column-count">${colTasks.length}</span>
          <div class="column-actions">
            <button class="btn-icon edit-col-btn" data-col-id="${col.id}" title="Edytuj">✏️</button>
            <button class="btn-icon delete-col-btn" data-col-id="${col.id}" title="Usuń">🗑</button>
          </div>
        </div>
        <div class="column-tasks" data-col-id="${col.id}">
          ${colTasks.map(t => taskCard(t)).join('')}
        </div>
        <button class="add-task-btn" data-col-id="${col.id}">
          <span>+</span> Dodaj zadanie
        </button>
      </div>`;
  }).join('') + `
    <div style="flex-shrink:0;width:4px"></div>`;

  // Event listeners
  board.querySelectorAll('.task-card').forEach(card => {
    card.addEventListener('click', () => openTaskModal(card.dataset.id, projectId));
    card.addEventListener('dragstart', e => {
      draggedTaskId = card.dataset.id;
      card.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    card.addEventListener('dragend', () => card.classList.remove('dragging'));
  });

  board.querySelectorAll('.column-tasks').forEach(ct => {
    ct.addEventListener('dragover', e => {
      e.preventDefault();
      ct.closest('.kanban-column').classList.add('drag-over');
    });
    ct.addEventListener('dragleave', () => {
      ct.closest('.kanban-column').classList.remove('drag-over');
    });
    ct.addEventListener('drop', async e => {
      e.preventDefault();
      ct.closest('.kanban-column').classList.remove('drag-over');
      if (draggedTaskId) {
        const newColId = ct.dataset.colId;
        const task = getTaskById(draggedTaskId);
        if (task && task.columnId !== newColId) {
          const col = proj.columns?.find(c => c.id === newColId);
          await updateTask(draggedTaskId, { columnId: newColId }, { action: `Przeniesiono do kolumny "${col?.name || newColId}"` });
        }
        draggedTaskId = null;
      }
    });
  });

  board.querySelectorAll('.add-task-btn').forEach(btn => {
    btn.addEventListener('click', () => openQuickAddTask(btn.dataset.colId, projectId));
  });

  board.querySelectorAll('.edit-col-btn').forEach(btn => {
    btn.addEventListener('click', e => { e.stopPropagation(); openEditColumnModal(btn.dataset.colId, projectId); });
  });

  board.querySelectorAll('.delete-col-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      showConfirm('Usuń kolumnę', 'Zadania w tej kolumnie nie zostaną usunięte, ale stracą przypisanie.', async () => {
        const newCols = proj.columns.filter(c => c.id !== btn.dataset.colId);
        await updateProject(projectId, { columns: newCols });
      });
    });
  });
}

function taskCard(t) {
  const checklist = t.checklist || [];
  const done = checklist.filter(c => c.done).length;
  const progress = checklist.length > 0 ? Math.round(done / checklist.length * 100) : 0;
  const over = isOverdue(t.dueDate);
  const doneTask = isTaskDone(t);

  return `
    <div class="task-card ${doneTask ? 'done' : ''}" draggable="true" data-id="${t.id}" data-priority="${t.priority || 'medium'}">
      <div class="task-card-title">${t.title}</div>
      <div class="task-card-meta">
        ${t.dueDate ? `<span class="task-due ${over ? 'overdue' : ''}">📅 ${formatDate(t.dueDate)}</span>` : ''}
        ${t.priority === 'high' ? '<span style="font-size:.72rem;color:#E74C3C">🔴 Wysoki</span>' : ''}
        ${t.assigneeName ? `<div class="task-card-assignee">${getInitials(t.assigneeName)}</div>` : ''}
        ${doneTask ? `<span class="task-done-badge"> Zakończone</span>` : ''}
      </div>
      ${checklist.length > 0 ? `
        <div class="task-checklist-progress">
          <div class="task-checklist-bar"><div class="task-checklist-fill" style="width:${progress}%"></div></div>
          <span>${done}/${checklist.length}</span>
        </div>` : ''}
    </div>`;
}

async function openQuickAddTask(colId, projectId) {
  const title = prompt('Tytuł zadania:');
  if (!title) return;
  await createTask(projectId, colId, title.trim());
}

// ============================================================
// COLUMN MODALS
// ============================================================
function openAddTaskConfirmModal() {
  const input = $('add-task-confirm-title');
  if (input) input.value = '';
  openModal('add-task-confirm-modal');
  setTimeout(() => input?.focus(), 80);
}

function openAddColumnModal(projectId) {
  editingColumnId = null;
  $('column-modal-title').textContent = 'Nowa kolumna';
  $('column-name-input').value = '';
  selectedColColor = '#6B7C5C';
  updateColorPicker('col-color-picker', selectedColColor);
  openModal('column-modal');
  $('save-column-btn').onclick = async () => {
    const name = $('column-name-input').value.trim();
    if (!name) { showToast('Podaj nazwę kolumny', 'error'); return; }
    const proj = projects[projectId];
    const newCol = { id: generateId(), name, color: selectedColColor, order: (proj.columns?.length || 0) };
    await updateProject(projectId, { columns: [...(proj.columns || []), newCol] });
    closeModal('column-modal');
  };
}

function openEditColumnModal(colId, projectId) {
  const proj = projects[projectId];
  const col = proj.columns?.find(c => c.id === colId);
  if (!col) return;
  editingColumnId = colId;
  $('column-modal-title').textContent = 'Edytuj kolumnę';
  $('column-name-input').value = col.name;
  selectedColColor = col.color || '#6B7C5C';
  updateColorPicker('col-color-picker', selectedColColor);
  openModal('column-modal');
  $('save-column-btn').onclick = async () => {
    const name = $('column-name-input').value.trim();
    if (!name) { showToast('Podaj nazwę kolumny', 'error'); return; }
    const newCols = proj.columns.map(c => c.id === colId ? { ...c, name, color: selectedColColor } : c);
    await updateProject(projectId, { columns: newCols });
    closeModal('column-modal');
  };
}

// ============================================================
// TASK MODAL
// ============================================================
async function openTaskModal(taskId, projectId) {
  currentTaskId = taskId;
  const task = getTaskById(taskId);
  if (!task) return;
  const proj = projects[task.projectId || projectId];

  // Fill fields
  $('task-title-input').value = task.title || '';
  $('task-id-badge').textContent = `#${taskId.slice(0, 6)}`;
  $('task-desc').value = task.desc || '';
  $('task-project-name').textContent = proj?.name || '—';
  $('task-priority-select').value = task.priority || 'medium';
  $('task-due-date').value = task.dueDate || '';

  // Task status (open/done)
  const stateSelect = $('task-state-select');
  if (stateSelect) stateSelect.value = task.status || 'open';

  // Status (columns)
  const statusSelect = $('task-status-select');
  statusSelect.innerHTML = '';
  (proj?.columns || []).forEach(c => {
    statusSelect.innerHTML += `<option value="${c.id}" ${task.columnId === c.id ? 'selected' : ''}>${c.name}</option>`;
  });

  // Assignee
  const assigneeSelect = $('task-assignee-select');
  assigneeSelect.innerHTML = '<option value="">— Nieprzypisany —</option>';
  (proj?.members || []).forEach(m => {
    assigneeSelect.innerHTML += `<option value="${m.uid}" ${task.assigneeId === m.uid ? 'selected' : ''}>${m.name}</option>`;
  });

  // Created at
  const createdEl = $('task-created-at');
  if (createdEl) {
    if (task.createdAt) {
      const d = task.createdAt.toDate ? task.createdAt.toDate() : new Date(task.createdAt);
      createdEl.textContent = d.toLocaleDateString('pl-PL', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    } else {
      createdEl.textContent = '—';
    }
  }

  const createdByEl = $('task-created-by');
  if (createdByEl) {
    createdByEl.textContent = task.createdByName || '—';
  }

  renderChecklist(task.checklist || []);
  renderAttachments(task.attachments || []);
  renderComments(task.comments || [], proj?.members || []);
  renderHistory(task.history || []);

  // Reset pending comment images
  commentPendingImages = [];
  renderCommentImagePreviews();

  openModal('task-modal');
}

function renderChecklist(items) {
  const container = $('checklist-container');
  const bar = $('checklist-progress-bar');
  const fill = $('checklist-progress-fill');
  if (!items.length) { container.innerHTML = ''; bar.classList.add('hidden'); return; }
  const done = items.filter(i => i.done).length;
  const progress = Math.round(done / items.length * 100);
  bar.classList.remove('hidden');
  fill.style.width = progress + '%';
  container.innerHTML = items.map((item, idx) => `
    <div class="checklist-item" data-idx="${idx}">
      <input type="checkbox" ${item.done ? 'checked' : ''} class="checklist-check" data-idx="${idx}" />
      <input class="checklist-item-text ${item.done ? 'done' : ''}" value="${item.text || ''}" data-idx="${idx}" />
      <button class="btn-icon checklist-delete" data-idx="${idx}" style="font-size:.75rem">✕</button>
    </div>
  `).join('');

  container.querySelectorAll('.checklist-check').forEach(cb => {
    cb.addEventListener('change', () => autoSaveTask());
  });
  container.querySelectorAll('.checklist-item-text').forEach(inp => {
    inp.addEventListener('input', () => autoSaveTask());
  });
  container.querySelectorAll('.checklist-delete').forEach(btn => {
    btn.addEventListener('click', () => {
      const checklist = getCurrentChecklist();
      checklist.splice(parseInt(btn.dataset.idx), 1);
      renderChecklist(checklist);
      autoSaveTask();
    });
  });
}

function getCurrentChecklist() {
  const items = [];
  document.querySelectorAll('.checklist-item').forEach(el => {
    items.push({
      text: el.querySelector('.checklist-item-text').value,
      done: el.querySelector('.checklist-check').checked
    });
  });
  return items;
}

function renderAttachments(attachments) {
  const list = $('attachments-list');
  if (!attachments.length) {
    list.innerHTML = '<span style="font-size:.75rem;color:var(--text-light);">Brak załączników</span>';
    return;
  }
  list.innerHTML = attachments.map((a, i) => {
    const isImage = a.type && a.type.startsWith('image/');
    const icon = isImage ? '🖼' : '📎';
    const sizeKb = a.size ? `<span style="font-size:.65rem;color:var(--text-light);"> (${Math.round(a.size/1024)}KB)</span>` : '';
    return `
      <div class="attachment-chip" style="display:flex;align-items:center;gap:.4rem;padding:.3rem .55rem;background:var(--bg-alt);border:1px solid var(--border);border-radius:var(--radius-sm);max-width:100%;margin-bottom:.3rem;">
        <span>${icon}</span>
        <a href="${a.url}" target="_blank" download="${a.name}" style="color:var(--text);text-decoration:none;font-size:.75rem;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0;" title="${a.name}">${a.name}</a>
        ${sizeKb}
        <button data-idx="${i}" class="attach-delete-btn" title="Usuń załącznik" style="background:none;border:none;cursor:pointer;color:var(--text-light);font-size:.78rem;padding:.1rem .25rem;border-radius:3px;line-height:1;flex-shrink:0;transition:color .15s;">✕</button>
      </div>`;
  }).join('');

  list.querySelectorAll('.attach-delete-btn').forEach(btn => {
    btn.addEventListener('mouseenter', () => btn.style.color = '#EF4444');
    btn.addEventListener('mouseleave', () => btn.style.color = 'var(--text-light)');
    btn.addEventListener('click', () => deleteAttachment(parseInt(btn.dataset.idx)));
  });
}

function renderComments(comments, members) {
  const list = $('comments-list');
  list.innerHTML = comments.map((c, idx) => {
    const text = (c.text || '').replace(/@(\w+)/g, '<span class="comment-mention">@$1</span>');
    const isOwn = !c.authorId || (currentUser && c.authorId === currentUser.uid);
    const imagesHtml = (c.images && c.images.length)
      ? `<div class="comment-images">${c.images.map(img => `
          <a href="${img.dataUrl}" target="_blank" class="comment-img-link">
            <img src="${img.dataUrl}" class="comment-img-inline" alt="${img.name || 'screenshot'}" title="Kliknij, aby powiększyć" />
          </a>`).join('')}</div>`
      : '';
    return `
      <div class="comment-item" data-idx="${idx}">
        <div class="user-avatar small">${getInitials(c.authorName)}</div>
        <div class="comment-bubble" style="flex:1;">
          <div style="display:flex;align-items:center;gap:.5rem;margin-bottom:.25rem;">
            <span class="comment-author">${c.authorName || 'Użytkownik'}</span>
            <span class="comment-time">${c.at ? new Date(c.at).toLocaleString('pl-PL') : ''}</span>
            ${isOwn ? `<button class="comment-delete-btn" data-idx="${idx}" title="Usuń komentarz" style="margin-left:auto;background:none;border:none;cursor:pointer;color:var(--text-light);font-size:.75rem;padding:.1rem .25rem;border-radius:3px;line-height:1;transition:color .15s ease;">✕</button>` : ''}
          </div>
          ${text ? `<div>${text}</div>` : ''}
          ${imagesHtml}
        </div>
      </div>`;
  }).join('');

  // Bind delete buttons
  list.querySelectorAll('.comment-delete-btn').forEach(btn => {
    btn.addEventListener('mouseenter', () => btn.style.color = '#EF4444');
    btn.addEventListener('mouseleave', () => btn.style.color = 'var(--text-light)');
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.idx);
      const task = getTaskById(currentTaskId);
      if (!task) return;
      const updated = [...(task.comments || [])];
      updated.splice(idx, 1);
      await updateTask(currentTaskId, { comments: updated }, null);
      const updatedTask = getTaskById(currentTaskId);
      const proj = projects[updatedTask?.projectId];
      renderComments(updated, proj?.members || []);
    });
  });
}

function renderHistory(history) {
  const container = $('task-history');
  if (!history.length) { container.innerHTML = '<span style="color:var(--text-light);font-size:.8rem">Brak historii</span>'; return; }
  container.innerHTML = [...history].reverse().map(h => `
    <div class="history-item">
      <div class="history-dot"></div>
      <div>
        <span>${h.action}</span>
        <span style="color:var(--text-light)"> — ${h.by}</span>
      </div>
      <span class="history-time">${h.at ? new Date(h.at).toLocaleString('pl-PL') : ''}</span>
    </div>
  `).join('');
}

async function saveTask() {
  const taskId = currentTaskId;
  const task = getTaskById(taskId);
  if (!task || !taskId) return;

  const newTitle = $('task-title-input').value.trim();
  const newDesc = $('task-desc').value;
  const newPriority = $('task-priority-select').value;
  const newDueDate = $('task-due-date').value;
  const newColId = $('task-status-select').value;
  const newStatus = ($('task-state-select')?.value) || (task.status || 'open');
  const newAssigneeId = $('task-assignee-select').value;

  const proj = projects[task.projectId];
  const newAssigneeName = proj?.members?.find(m => m.uid === newAssigneeId)?.name || null;

  const history = [];
  if (task.title !== newTitle) history.push({ action: `Zmieniono tytuł z "${task.title}" na "${newTitle}"` });
  if (task.priority !== newPriority) history.push({ action: `Zmieniono priorytet na "${newPriority}"` });
  if (task.columnId !== newColId) {
    const col = proj?.columns?.find(c => c.id === newColId);
    history.push({ action: `Przeniesiono do "${col?.name || newColId}"` });
  }
  if ((task.status || 'open') !== newStatus) history.push({ action: `Zmieniono status zadania na "${newStatus === 'done' ? 'Zakończone' : 'Otwarte'}"` });
  if (task.dueDate !== newDueDate) history.push({ action: `Zmieniono termin na "${formatDate(newDueDate)}"` });
  if (task.assigneeId !== newAssigneeId) history.push({ action: `Przypisano do "${newAssigneeName || 'brak'}"` });

  const updates = {
    title: newTitle,
    desc: newDesc,
    priority: newPriority,
    dueDate: newDueDate || null,
    columnId: newColId,
    status: newStatus,
    assigneeId: newAssigneeId || null,
    assigneeName: newAssigneeName,
    checklist: getCurrentChecklist()
  };

  const existingHistory = task.history || [];
  const byEntry = h => ({ ...h, by: currentUser.displayName || 'Użytkownik', at: new Date().toISOString() });
  updates.history = [...existingHistory, ...history.map(byEntry)];

  await updateDoc(doc(db, 'tasks', taskId), updates);
  showToast('Zadanie zapisane', 'success');
  closeModal('task-modal');
}

let autoSaveTimeout = null;

function setAutosaveIndicator(text, color) {
  const el = $('autosave-indicator');
  if (el) { el.textContent = text; el.style.color = color || 'var(--text-light)'; }
}

async function autoSaveTask() {
  const taskId = currentTaskId;
  const task = getTaskById(taskId);
  if (!task || !taskId) return;

  setAutosaveIndicator('Zapisywanie…', 'var(--text-muted)');

  const newTitle = $('task-title-input').value.trim();
  const newDesc = $('task-desc').value;
  const newPriority = $('task-priority-select').value;
  const newDueDate = $('task-due-date').value;
  const newColId = $('task-status-select').value;
  const newStatus = ($('task-state-select')?.value) || (task.status || 'open');
  const newAssigneeId = $('task-assignee-select').value;

  const proj = projects[task.projectId];
  const newAssigneeName = proj?.members?.find(m => m.uid === newAssigneeId)?.name || null;

  const history = [];
  if (task.title !== newTitle) history.push({ action: `Zmieniono tytuł z "${task.title}" na "${newTitle}"` });
  if (task.priority !== newPriority) history.push({ action: `Zmieniono priorytet na "${newPriority}"` });
  if (task.columnId !== newColId) {
    const col = proj?.columns?.find(c => c.id === newColId);
    history.push({ action: `Przeniesiono do "${col?.name || newColId}"` });
  }
  if ((task.status || 'open') !== newStatus) history.push({ action: `Zmieniono status zadania na "${newStatus === 'done' ? 'Zakończone' : 'Otwarte'}"` });
  if (task.dueDate !== newDueDate) history.push({ action: `Zmieniono termin na "${formatDate(newDueDate)}"` });
  if (task.assigneeId !== newAssigneeId) history.push({ action: `Przypisano do "${newAssigneeName || 'brak'}"` });

  const updates = {
    title: newTitle || task.title,
    desc: newDesc,
    priority: newPriority,
    dueDate: newDueDate || null,
    columnId: newColId,
    status: newStatus,
    assigneeId: newAssigneeId || null,
    assigneeName: newAssigneeName,
    checklist: getCurrentChecklist()
  };

  if (history.length) {
    const existingHistory = task.history || [];
    const byEntry = h => ({ ...h, by: currentUser.displayName || 'Użytkownik', at: new Date().toISOString() });
    updates.history = [...existingHistory, ...history.map(byEntry)];
  }

  try {
    await updateDoc(doc(db, 'tasks', taskId), updates);
    setAutosaveIndicator('✓ Zapisano', '#059669');
    setTimeout(() => setAutosaveIndicator('', ''), 2000);
  } catch (e) {
    setAutosaveIndicator('Błąd zapisu', '#EF4444');
  }
}

function scheduleAutoSave() {
  clearTimeout(autoSaveTimeout);
  setAutosaveIndicator('Niezapisane zmiany…', 'var(--text-muted)');
  autoSaveTimeout = setTimeout(autoSaveTask, 1200);
}

// ============================================================
// COMMENTS
// ============================================================

// Pending images state for comment form
let commentPendingImages = []; // array of { dataUrl, name }

function setupCommentImageInput() {
  const input = $('comment-image-input');
  if (!input) return;
  input.addEventListener('change', async (e) => {
    const files = Array.from(e.target.files || []);
    const MAX_SIZE = 1.5 * 1024 * 1024;
    for (const file of files) {
      if (file.size > MAX_SIZE) { showToast(`"${file.name}" za duży (max 1.5MB)`, 'error'); continue; }
      const dataUrl = await new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = ev => res(ev.target.result);
        r.onerror = rej;
        r.readAsDataURL(file);
      });
      commentPendingImages.push({ dataUrl, name: file.name });
    }
    input.value = '';
    renderCommentImagePreviews();
  });

  // Paste image from clipboard
  $('comment-input')?.addEventListener('paste', async (e) => {
    const items = Array.from(e.clipboardData?.items || []);
    const imageItems = items.filter(it => it.kind === 'file' && it.type.startsWith('image/'));
    if (!imageItems.length) return;
    e.preventDefault();
    for (const item of imageItems) {
      const file = item.getAsFile();
      if (!file) continue;
      const dataUrl = await new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = ev => res(ev.target.result);
        r.onerror = rej;
        r.readAsDataURL(file);
      });
      commentPendingImages.push({ dataUrl, name: 'screenshot.png' });
    }
    renderCommentImagePreviews();
  });
}

function renderCommentImagePreviews() {
  const wrap = $('comment-image-previews');
  if (!wrap) return;
  if (!commentPendingImages.length) { wrap.classList.add('hidden'); wrap.innerHTML = ''; return; }
  wrap.classList.remove('hidden');
  wrap.innerHTML = commentPendingImages.map((img, i) => `
    <div class="comment-img-thumb-wrap">
      <img src="${img.dataUrl}" class="comment-img-thumb" alt="${img.name}" title="${img.name}" />
      <button class="comment-img-remove" data-idx="${i}" title="Usuń">✕</button>
    </div>`).join('');
  wrap.querySelectorAll('.comment-img-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      commentPendingImages.splice(parseInt(btn.dataset.idx), 1);
      renderCommentImagePreviews();
    });
  });
}

async function submitComment() {
  const taskId = currentTaskId;
  const input = $('comment-input');
  const text = input.innerText.trim();
  if (!text && commentPendingImages.length === 0) return;

  const task = getTaskById(taskId);
  const newComment = {
    text,
    images: commentPendingImages.map(img => ({ dataUrl: img.dataUrl, name: img.name })),
    authorId: currentUser.uid,
    authorName: currentUser.displayName || 'Użytkownik',
    at: new Date().toISOString()
  };
  const comments = [...(task?.comments || []), newComment];

  await updateTask(taskId, { comments }, { action: 'Dodano komentarz' });

  // Reset
  input.innerText = '';
  commentPendingImages = [];
  renderCommentImagePreviews();

  // Re-render
  const updatedTask = getTaskById(taskId);
  const proj = projects[updatedTask?.projectId];
  renderComments(comments, proj?.members || []);
}

// Mention
function setupMentionDropdown() {
  const input = $('comment-input');
  const dropdown = $('mention-dropdown');
  input.addEventListener('input', () => {
    const text = input.innerText;
    const match = text.match(/@(\w*)$/);
    if (match) {
      const query = match[1].toLowerCase();
      const proj = projects[currentProjectId];
      const filtered = (proj?.members || []).filter(m => m.name.toLowerCase().includes(query));
      if (filtered.length > 0) {
        dropdown.innerHTML = filtered.map(m => `
          <div class="mention-item" data-name="${m.name}">
            <div class="user-avatar small">${getInitials(m.name)}</div>
            ${m.name}
          </div>`).join('');
        dropdown.classList.remove('hidden');
        dropdown.querySelectorAll('.mention-item').forEach(item => {
          item.addEventListener('click', () => {
            const t = input.innerText.replace(/@\w*$/, `@${item.dataset.name} `);
            input.innerText = t;
            dropdown.classList.add('hidden');
            const range = document.createRange();
            const sel = window.getSelection();
            range.selectNodeContents(input);
            range.collapse(false);
            sel.removeAllRanges();
            sel.addRange(range);
          });
        });
        return;
      }
    }
    dropdown.classList.add('hidden');
  });
}

// ============================================================
// ATTACHMENTS
// ============================================================
async function uploadAttachment(files) {
  const taskId = currentTaskId;
  if (!taskId || !files.length) return;
  const task = getTaskById(taskId);
  const attachments = [...(task?.attachments || [])];
  const prevCount = attachments.length;

  const MAX_SIZE = 1.5 * 1024 * 1024; // 1.5MB — limit Firestore na dokument

  for (const file of files) {
    if (file.size > MAX_SIZE) {
      showToast(`"${file.name}" za duży (max 1.5MB)`, 'error');
      continue;
    }
    try {
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = e => resolve(e.target.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      attachments.push({ name: file.name, url: dataUrl, type: file.type, size: file.size });
    } catch (e) {
      showToast(`Błąd odczytu: ${file.name}`, 'error');
    }
  }

  // Reset — można dodać ten sam plik ponownie
  const input = $('attachment-upload');
  if (input) input.value = '';

  if (attachments.length === prevCount) return;

  await updateTask(taskId, { attachments }, { action: 'Dodano załącznik' });
  renderAttachments(attachments);
  showToast('Plik dodany!', 'success');
}

async function deleteAttachment(idx) {
  const taskId = currentTaskId;
  const task = getTaskById(taskId);
  if (!task) return;
  const attachments = [...(task.attachments || [])];
  const removed = attachments.splice(idx, 1)[0];
  await updateTask(taskId, { attachments }, { action: `Usunięto załącznik "${removed?.name}"` });
  renderAttachments(attachments);
  showToast('Załącznik usunięty', 'success');
}

// ============================================================
// FULL CALENDAR
// ============================================================
function renderFullCalendar() {
  const y = fullCalDate.getFullYear(), m = fullCalDate.getMonth();
  $('cal-title').textContent = fullCalDate.toLocaleDateString('pl-PL', { month: 'long', year: 'numeric' });

  const myTasks = getAllProjectTasks();
  renderCalendarGrid('full-calendar', y, m, myTasks, true);
}

function renderCalendarGrid(containerId, y, m, taskList, clickable) {
  const container = $(containerId);
  const days = ['Poniedziałek', 'Wtorek', 'Środa', 'Czwartek', 'Piątek', 'Sobota', 'Niedziela'];
  const today = new Date().toDateString();

  let html = `<div class="cal-grid">${days.map(d => `<div class="cal-day-header">${d}</div>`).join('')}`;

  const first = new Date(y, m, 1);
  let startDay = first.getDay() - 1; if (startDay < 0) startDay = 6;
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const prevDays = new Date(y, m, 0).getDate();

  for (let i = startDay - 1; i >= 0; i--) {
    html += `<div class="cal-day-cell other-month"><div class="cal-day-num">${prevDays - i}</div></div>`;
  }

  for (let d = 1; d <= daysInMonth; d++) {
    const date = new Date(y, m, d);
    const ds = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const dayTasks = taskList.filter(t => t.dueDate === ds);
    const isToday = date.toDateString() === today;
    html += `<div class="cal-day-cell ${isToday ? 'today' : ''}">
      <div class="cal-day-num">${d}</div>
      ${dayTasks.slice(0, 3).map(t => `<div class="cal-event" ${clickable ? `data-id="${t.id}" data-project="${t.projectId}"` : ''}>${t.title}</div>`).join('')}
      ${dayTasks.length > 3 ? `<div class="cal-event">+${dayTasks.length - 3} więcej</div>` : ''}
    </div>`;
  }

  const remaining = (7 - ((startDay + daysInMonth) % 7)) % 7;
  for (let i = 1; i <= remaining; i++) {
    html += `<div class="cal-day-cell other-month"><div class="cal-day-num">${i}</div></div>`;
  }

  html += '</div>';
  container.innerHTML = html;

  if (clickable) {
    container.querySelectorAll('.cal-event[data-id]').forEach(el => {
      el.addEventListener('click', () => openTaskModal(el.dataset.id, el.dataset.project));
    });
  }
}


// ============================================================
// PROJECT LIST VIEW (Asana-like)
// ============================================================
function setActiveProjectTab(activeId) {
  ['project-view-kanban-btn','project-view-list-btn','project-calendar-btn','project-gantt-btn'].forEach(id => {
    $(id)?.classList.toggle('active', id === activeId);
  });
}

function setProjectView(view) {
  currentProjectView = view;
  setActiveProjectTab(view === 'list' ? 'project-view-list-btn' : 'project-view-kanban-btn');
  if (view === 'list') {
    $('kanban-board').classList.add('hidden');
    $('project-list-view').classList.remove('hidden');
  } else {
    $('project-list-view').classList.add('hidden');
    $('kanban-board').classList.remove('hidden');
  }
  if (currentProjectId) renderProjectList(currentProjectId);
}

function renderProjectList(projectId) {
  const container = $('project-list-container');
  const viewEl = $('project-list-view');
  if (!container || !viewEl) return;

  const proj = projects[projectId];
  if (!proj) { container.innerHTML = ''; return; }

  const search = ($('project-list-search')?.value || '').trim().toLowerCase();
  const showDone = ($('project-list-show-done')?.checked ?? true);

  let projTasks = getFilteredTasks(projectId);
  if (!showDone) projTasks = projTasks.filter(t => !isTaskDone(t));
  if (search) {
    projTasks = projTasks.filter(t => {
      const title = (t.title || '').toLowerCase();
      const desc  = (t.desc || '').toLowerCase();
      const ass   = (t.assigneeName || '').toLowerCase();
      return title.includes(search) || desc.includes(search) || ass.includes(search);
    });
  }

  const dir = listSortDir === 'asc' ? 1 : -1;
  const byDue = (a, b) => {
    const da = a.dueDate ? new Date(a.dueDate) : null;
    const db2 = b.dueDate ? new Date(b.dueDate) : null;
    if (da && db2) return (da - db2) * dir;
    if (da && !db2) return -1;
    if (!da && db2) return 1;
    return String(a.title || '').localeCompare(String(b.title || ''), 'pl');
  };
  const byTitle    = (a, b) => String(a.title || '').localeCompare(String(b.title || ''), 'pl') * dir;
  const byAssignee = (a, b) => String(a.assigneeName || '').localeCompare(String(b.assigneeName || ''), 'pl') * dir;
  const byPriority = (a, b) => (priorityRank(a.priority) - priorityRank(b.priority)) * dir;
  const byStatus   = (a, b) => String(a.status || '').localeCompare(String(b.status || ''), 'pl') * dir;
  const byCreated  = (a, b) => {
    const ca = a.createdAt ? (a.createdAt.toDate ? a.createdAt.toDate() : new Date(a.createdAt)) : null;
    const cb = b.createdAt ? (b.createdAt.toDate ? b.createdAt.toDate() : new Date(b.createdAt)) : null;
    if (ca && cb) return (ca - cb) * dir;
    if (ca && !cb) return -1;
    if (!ca && cb) return 1;
    return 0;
  };

  if (listSortCol === 'title')         projTasks.sort(byTitle);
  else if (listSortCol === 'assignee') projTasks.sort(byAssignee);
  else if (listSortCol === 'priority') projTasks.sort(byPriority);
  else if (listSortCol === 'status')   projTasks.sort(byStatus);
  else if (listSortCol === 'created')  projTasks.sort(byCreated);
  else                                  projTasks.sort(byDue);

  const cols = [...(proj.columns || [])].sort((a, b) => a.order - b.order);
  const sections = cols.map(c => ({ col: c, tasks: projTasks.filter(t => t.columnId === c.id) }));
  const knownColIds = new Set(cols.map(c => c.id));
  const orphan = projTasks.filter(t => !knownColIds.has(t.columnId));
  if (orphan.length) sections.push({ col: { id: '__none__', name: 'Pozostałe', color: proj.color || '#6B7C5C' }, tasks: orphan });

  const collapsed = collapsedSections[projectId] || new Set();
  const listCols = getListColumns().filter(c => c.visible);

  // Build colgroup widths
  const colgroupCols = listCols.map(c => {
    if (c.flex) return `<col style="min-width:180px;">`;
    return `<col style="width:${c.width}px;min-width:${Math.min(c.width, 60)}px;">`;
  }).join('');

  // Build header cells
  const sortableIds = new Set(['title', 'assignee', 'status', 'due', 'priority', 'created']);
  const headerCells = listCols.map((c, i) => {
    const dragHandle = c.id !== 'checkbox'
      ? `draggable="true" data-drag-col="${c.id}"`
      : '';
    const isSortable = sortableIds.has(c.id);
    const isActive = listSortCol === c.id || (c.id === 'due' && listSortCol === 'due');
    const arrowIcon = isSortable
      ? `<span class="th-sort-icon${isActive ? ' th-sort-active' : ''}">${listSortDir === 'asc' && isActive ? '↑' : '↓'}</span>`
      : '';
    const style = c.id === 'checkbox'
      ? 'padding-left:1rem;text-align:center;'
      : c.id === 'title' ? 'padding-left:.5rem;' : '';
    const sortAttr = isSortable ? `data-sort-col="${c.id}"` : '';
    return `<th class="list-th${isSortable ? ' list-th-sortable' : ''}" ${dragHandle} ${sortAttr} data-th-id="${c.id}" style="${style}">
      <span class="th-label">${c.label}</span>${arrowIcon}
    </th>`;
  }).join('');

  // Build section rows
  const sectionsHtml = sections.map(sec => {
    const c = sec.col;
    const isCollapsed = collapsed.has(c.id);
    const buildRows = sec.tasks.length
      ? sec.tasks.map(t => projectListRow(t, c, c.id, listCols)).join('')
      : `<tr data-section-col="${c.id}"><td colspan="${listCols.length}" style="padding:.55rem 1.25rem;font-size:.78rem;color:var(--text-light);">Brak zadań w tej sekcji</td></tr>`;



    return `
      <tr class="list-section-row" data-col="${c.id}">
        <td colspan="${listCols.length}" style="padding:.5rem 1.25rem .35rem;background:var(--surface);border-bottom:1px solid var(--border);border-top:2px solid var(--border);">
          <div style="display:flex;align-items:center;gap:.4rem;">
            <button class="section-collapse-btn" data-col="${c.id}" title="${isCollapsed ? 'Rozwiń' : 'Zwiń'}" style="background:none;border:none;cursor:pointer;padding:.1rem;display:flex;align-items:center;color:var(--text-muted);transition:color .15s,transform .2s;">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="12" height="12" style="transition:transform .2s ease;transform:rotate(${isCollapsed ? '-90deg' : '0deg'})"><polyline points="6 9 12 15 18 9"/></svg>
            </button>
            <span style="width:8px;height:8px;border-radius:50%;background:${c.color || '#6B7C5C'};flex-shrink:0;display:inline-block;"></span>
            <span style="font-weight:700;font-size:.82rem;color:var(--text);">${c.name}</span>
            <span style="font-size:.65rem;color:var(--text-muted);background:var(--bg-alt);border:1px solid var(--border);padding:.02rem .35rem;border-radius:999px;font-weight:600;">${sec.tasks.length}</span>
          </div>
        </td>
      </tr>
      ${isCollapsed ? '' : buildRows}
    `;
  }).join('');

  // Column visibility toggle button (⚙)
  const allCols = getListColumns();
  const visibilityMenu = allCols
    .filter(c => c.id !== 'checkbox')
    .map(c => `<label class="col-vis-item"><input type="checkbox" data-vis-col="${c.id}" ${c.visible ? 'checked' : ''}> ${c.label}</label>`)
    .join('');

  container.innerHTML = `
    <div class="list-table-wrap">
      <div class="list-header-bar">
        <div class="list-col-settings-wrap">
          <button class="list-col-settings-btn" id="list-col-settings-btn" title="Dostosuj kolumny">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="15" height="15"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
          </button>
          <div class="col-vis-dropdown hidden" id="col-vis-dropdown">
            <div class="col-vis-title">Widoczne kolumny</div>
            ${visibilityMenu}
          </div>
        </div>
      </div>
      <div style="overflow-x:auto;">
        <table class="list-table" id="list-table" style="table-layout:fixed;width:100%;">
          <colgroup id="list-colgroup">${colgroupCols}</colgroup>
          <thead class="list-thead-sticky">
            <tr id="list-header-row">${headerCells}</tr>
          </thead>
          <tbody>${sectionsHtml}</tbody>
        </table>
      </div>
    </div>
  `;

  // ---- Event bindings ----
  bindListTableInteractions(container, projectId, listCols);
}

function bindListTableInteractions(container, projectId, listCols) {
  // Collapse toggle
  container.querySelectorAll('.section-collapse-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const colId = btn.dataset.col;
      if (!collapsedSections[projectId]) collapsedSections[projectId] = new Set();
      const set = collapsedSections[projectId];
      if (set.has(colId)) set.delete(colId); else set.add(colId);
      saveCollapsedSections();
      renderProjectList(projectId);
    });
  });

  // Row click -> open modal
  container.querySelectorAll('.list-row').forEach(tr => {
    tr.addEventListener('click', (e) => {
      if (e.target.classList?.contains('list-checkbox') || e.target.tagName === 'INPUT') return;
      openTaskModal(tr.dataset.id, projectId);
    });
  });

  // Checkbox toggle
  container.querySelectorAll('.list-checkbox').forEach(cb => {
    cb.addEventListener('click', async (e) => {
      e.stopPropagation();
      const taskId = cb.dataset.id;
      const newStatus = cb.checked ? 'done' : 'open';
      try {
        await updateTask(taskId, { status: newStatus }, { action: newStatus === 'done' ? 'Oznaczono jako zakończone' : 'Przywrócono jako otwarte' });
      } catch(err) { showToast('Nie udało się zmienić statusu', 'error'); }
    });
  });

  // Column visibility dropdown
  const settingsBtn = $('list-col-settings-btn');
  const visDropdown = $('col-vis-dropdown');
  if (settingsBtn && visDropdown) {
    settingsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      visDropdown.classList.toggle('hidden');
    });
    visDropdown.querySelectorAll('input[data-vis-col]').forEach(cb => {
      cb.addEventListener('change', () => {
        const cols = getListColumns();
        const col = cols.find(c => c.id === cb.dataset.visCol);
        if (col) col.visible = cb.checked;
        saveListColumnConfig(cols);
        renderProjectList(projectId);
      });
    });
    document.addEventListener('click', function hideVis(e) {
      if (!e.target.closest('.list-col-settings-wrap')) {
        visDropdown.classList.add('hidden');
        document.removeEventListener('click', hideVis);
      }
    });
  }



  // Column sort on click
  container.querySelectorAll('th[data-sort-col]').forEach(th => {
    th.addEventListener('click', (e) => {
      if (e.target.closest('[draggable]') && e.defaultPrevented) return;
      const col = th.dataset.sortCol;
      if (listSortCol === col) {
        listSortDir = listSortDir === 'asc' ? 'desc' : 'asc';
      } else {
        listSortCol = col;
        listSortDir = 'asc';
      }
      renderProjectList(projectId);
    });
  });

  // Column drag-to-reorder
  const headerRow = $('list-header-row');
  if (!headerRow) return;
  let dragColId = null;

  headerRow.querySelectorAll('th[data-drag-col]').forEach(th => {
    th.addEventListener('dragstart', (e) => {
      dragColId = th.dataset.dragCol;
      th.classList.add('col-dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    th.addEventListener('dragend', () => {
      th.classList.remove('col-dragging');
      headerRow.querySelectorAll('th').forEach(t => t.classList.remove('col-drag-over'));
      dragColId = null;
    });
    th.addEventListener('dragover', (e) => {
      if (!dragColId || dragColId === th.dataset.dragCol) return;
      e.preventDefault();
      headerRow.querySelectorAll('th').forEach(t => t.classList.remove('col-drag-over'));
      th.classList.add('col-drag-over');
    });
    th.addEventListener('drop', (e) => {
      e.preventDefault();
      const targetColId = th.dataset.dragCol;
      if (!dragColId || dragColId === targetColId) return;
      const cols = getListColumns();
      const fromIdx = cols.findIndex(c => c.id === dragColId);
      const toIdx   = cols.findIndex(c => c.id === targetColId);
      if (fromIdx === -1 || toIdx === -1) return;
      const [moved] = cols.splice(fromIdx, 1);
      cols.splice(toIdx, 0, moved);
      saveListColumnConfig(cols);
      renderProjectList(projectId);
    });
  });
}

function projectListRow(t, col, sectionColId, listCols) {
  const doneTask = isTaskDone(t);
  const overdue  = isOverdue(t.dueDate) && !doneTask;
  const pr       = t.priority || 'medium';
  const prLabel  = getPriorityLabel(pr).replace(/^.. /, '');

  const cells = (listCols || getListColumns().filter(c => c.visible)).map(c => {
    switch(c.id) {
      case 'checkbox':
        return `<td style="text-align:center;padding-left:.25rem;"><input class="list-checkbox" type="checkbox" data-id="${t.id}" ${doneTask ? 'checked' : ''} /></td>`;
      case 'desc':
        return `<td style="font-size:.73rem;color:var(--text-muted);overflow:hidden;white-space:nowrap;text-overflow:ellipsis;max-width:0;">${t.desc ? t.desc.slice(0, 120) : '—'}</td>`;
      case 'title':
        return `<td>
          <div class="list-title">${t.title || '(bez tytułu)'}</div>
          <div style="margin-top:.2rem;display:flex;gap:.35rem;flex-wrap:wrap">
            ${col ? `<span class="list-pill" title="Kolumna">${col.name}</span>` : ''}
            ${t.status === 'done' ? `<span class="list-pill" title="Status">Zakończone</span>` : ''}
          </div>
        </td>`;
      case 'assignee':
        return `<td style="font-size:.75rem;color:var(--text-muted);">${t.assigneeName || '—'}</td>`;
      case 'status':
        return `<td style="font-size:.75rem;color:var(--text-muted);">${col?.name || '—'}</td>`;
      case 'due':
        return `<td class="list-due ${overdue ? 'overdue' : ''}">${t.dueDate ? formatDate(t.dueDate) : '—'}</td>`;
      case 'priority':
        return `<td><span class="list-pill ${pr}">${prLabel}</span></td>`;
      case 'created': {
        const cd = t.createdAt ? (t.createdAt.toDate ? t.createdAt.toDate() : new Date(t.createdAt)) : null;
        return `<td style="font-size:.73rem;color:var(--text-muted);">${cd ? cd.toLocaleDateString('pl-PL', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'}</td>`;
      }
      default:
        return `<td></td>`;
    }
  }).join('');

  return `<tr class="list-row ${doneTask ? 'done' : ''}" data-id="${t.id}" ${sectionColId ? `data-section-col="${sectionColId}"` : ''}>${cells}</tr>`;
}


// ============================================================
// PROJECT CALENDAR
// ============================================================
function renderProjectCalendar(projectId) {
  const proj = projects[projectId];
  if (!proj) return;
  const y = projCalDate.getFullYear(), m = projCalDate.getMonth();
  $('proj-cal-title').textContent = projCalDate.toLocaleDateString('pl-PL', { month: 'long', year: 'numeric' });
  const projTasks = Object.values(tasks[projectId] || {});
  renderCalendarGrid('project-calendar-grid', y, m, projTasks, true);
}

// ============================================================
// GANTT
// ============================================================
function renderGantt(projectId) {
  const projTasks = Object.values(tasks[projectId] || {}).filter(t => t.dueDate);
  if (!projTasks.length) {
    $('gantt-container').innerHTML = '<div class="empty-state"><p>Brak zadań z terminem</p></div>';
    return;
  }

  projTasks.sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));
  const earliest = new Date(projTasks[0].dueDate);
  const latest = new Date(projTasks[projTasks.length - 1].dueDate);
  const totalDays = Math.max(Math.ceil((latest - earliest) / 86400000) + 7, 30);

  let headerCols = '';
  for (let i = 0; i <= totalDays; i++) {
    const d = new Date(earliest.getTime() + i * 86400000);
    headerCols += `<div class="gantt-day-header">${d.getDate()}</div>`;
  }

  let rows = projTasks.map(t => {
    const start = Math.floor((new Date(t.dueDate) - earliest) / 86400000);
    const left = (start / totalDays * 100).toFixed(2);
    const over = isOverdue(t.dueDate);
    return `
      <div class="gantt-row">
        <div class="gantt-task-name" title="${t.title}">${t.title}</div>
        <div class="gantt-bar-area">
          <div class="gantt-bar ${over ? 'overdue' : t.priority}" style="left:${left}%;width:${Math.max(3, 100 / totalDays).toFixed(2)}%"></div>
        </div>
      </div>`;
  }).join('');

  $('gantt-container').innerHTML = `
    <div class="gantt-chart">
      <div class="gantt-header">
        <div class="gantt-task-col-header">Zadanie</div>
        <div class="gantt-timeline-header">${headerCols}</div>
      </div>
      ${rows}
    </div>`;
}

// ============================================================
// STATISTICS
// ============================================================
function renderStatistics() {
  const projFilter = $('stats-filter-project').value;
  const periodFilter = $('stats-filter-period').value;
  const sortBy = $('stats-sort').value;

  // Populate project select
  const projSelect = $('stats-filter-project');
  const prevVal = projSelect.value;
  projSelect.innerHTML = '<option value="all">Wszystkie projekty</option>';
  Object.values(projects).filter(p => !p.archived).forEach(p => {
    projSelect.innerHTML += `<option value="${p.id}">${p.name}</option>`;
  });
  projSelect.value = prevVal || 'all';

  let allTasks = getAllMyTasks();
  if (projFilter !== 'all') allTasks = allTasks.filter(t => t.projectId === projFilter);

  const now = new Date();
  if (periodFilter === 'week') {
    const weekAgo = new Date(now.getTime() - 7 * 86400000);
    allTasks = allTasks.filter(t => t.dueDate && new Date(t.dueDate) >= weekAgo);
  } else if (periodFilter === 'month') {
    const monthAgo = new Date(now.getTime() - 30 * 86400000);
    allTasks = allTasks.filter(t => t.dueDate && new Date(t.dueDate) >= monthAgo);
  }

  const total = allTasks.length;
  const overdue = allTasks.filter(t => isOverdue(t.dueDate)).length;
  const high = allTasks.filter(t => t.priority === 'high').length;

  let projStats = Object.values(projects).filter(p => !p.archived).map(p => {
    const pt = Object.values(tasks[p.id] || {});
    const done = pt.filter(t => isTaskDone(t)).length;
    return { proj: p, total: pt.length, done, progress: pt.length > 0 ? Math.round(done / pt.length * 100) : 0 };
  });

  if (sortBy === 'tasks') projStats.sort((a, b) => b.total - a.total);
  else if (sortBy === 'progress') projStats.sort((a, b) => b.progress - a.progress);
  else projStats.sort((a, b) => a.proj.name.localeCompare(b.proj.name));

  $('stats-content').innerHTML = `
    <div class="stats-overview">
      <div class="stat-card"><div class="stat-card-value">${total}</div><div class="stat-card-label">Moje zadania</div></div>
      <div class="stat-card"><div class="stat-card-value" style="color:#E74C3C">${overdue}</div><div class="stat-card-label">Po terminie</div></div>
      <div class="stat-card"><div class="stat-card-value" style="color:#E74C3C">${high}</div><div class="stat-card-label">Wysoki priorytet</div></div>
      <div class="stat-card"><div class="stat-card-value">${Object.values(projects).filter(p => !p.archived).length}</div><div class="stat-card-label">Aktywne projekty</div></div>
    </div>
    <div class="stats-projects-table">
      <h3>Projekty</h3>
      <table>
        <thead><tr><th>Projekt</th><th>Zadania</th><th>Ukończone</th><th>Postęp</th><th>Termin</th></tr></thead>
        <tbody>
          ${projStats.map(s => `
            <tr>
              <td><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${s.proj.color};margin-right:.5rem"></span>${s.proj.name}</td>
              <td>${s.total}</td>
              <td>${s.done}</td>
              <td>
                <div style="display:flex;align-items:center;gap:.5rem">
                  <div class="progress-bar" style="flex:1;min-width:60px"><div class="progress-fill" style="width:${s.progress}%"></div></div>
                  <span style="font-size:.8rem">${s.progress}%</span>
                </div>
              </td>
              <td>${s.proj.deadline ? formatDate(s.proj.deadline) : '—'}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

// ============================================================
// NOTES
// ============================================================
function subscribeToNotes() {
  if (!currentUser) return;
  const q = query(collection(db, 'notes'), where('userId', '==', currentUser.uid));
  onSnapshot(q, snap => {
    notes = {};
    snap.forEach(d => { notes[d.id] = { id: d.id, ...d.data() }; });
    if (document.querySelector('#view-notes:not(.hidden)')) renderNotes();
  });
}

function renderNotes() {
  const list = $('notes-list');
  const noteArr = Object.values(notes);
  // Sortuj lokalnie po updatedAt (bez indeksu Firestore)
  noteArr.sort((a, b) => {
    const ta = a.updatedAt?.toMillis ? a.updatedAt.toMillis() : (a.updatedAt?.seconds ? a.updatedAt.seconds*1000 : 0);
    const tb = b.updatedAt?.toMillis ? b.updatedAt.toMillis() : (b.updatedAt?.seconds ? b.updatedAt.seconds*1000 : 0);
    return tb - ta;
  });
  if (!noteArr.length) {
    list.innerHTML = '<div class="empty-state"><p>Brak notatek</p></div>';
    return;
  }
  list.innerHTML = noteArr.map(n => `
    <div class="note-list-item ${currentNoteId === n.id ? 'active' : ''}" data-id="${n.id}">
      <div class="note-list-title">${n.title || 'Bez tytułu'}</div>
      <div class="note-list-preview">${(n.body || '').slice(0, 60)}</div>
      <div class="note-list-date">${n.updatedAt ? new Date(n.updatedAt.toDate()).toLocaleDateString('pl-PL') : ''}</div>
    </div>`).join('');

  list.querySelectorAll('.note-list-item').forEach(el => {
    el.addEventListener('click', () => openNote(el.dataset.id));
  });

  if (currentNoteId && notes[currentNoteId]) openNote(currentNoteId, false);
}

let noteSaveTimeout = null;

function openNote(noteId, saveScroll = true) {
  currentNoteId = noteId;
  const note = notes[noteId];
  if (!note) return;

  document.querySelectorAll('.note-list-item').forEach(el => {
    el.classList.toggle('active', el.dataset.id === noteId);
  });

  const editor = $('note-editor');
  editor.innerHTML = `
    <div class="note-editor-content">
      <div class="note-editor-header">
        <input class="note-title-editable" id="note-title-edit" value="${note.title || ''}" placeholder="Tytuł notatki..." />
        <button class="btn-danger small" id="delete-note-btn">🗑 Usuń</button>
      </div>
      <textarea class="note-body-editable" id="note-body-edit" placeholder="Zacznij pisać...">${note.body || ''}</textarea>
      <div class="note-editor-footer">
        <span>Ostatnia edycja: ${note.updatedAt ? new Date(note.updatedAt.toDate()).toLocaleString('pl-PL') : 'teraz'}</span>
        <span>Autosave aktywny</span>
      </div>
    </div>`;

  $('note-title-edit').addEventListener('input', scheduleNoteSave);
  $('note-body-edit').addEventListener('input', scheduleNoteSave);
  $('delete-note-btn').addEventListener('click', () => {
    showConfirm('Usuń notatkę', 'Ta notatka zostanie permanentnie usunięta.', async () => {
      await deleteDoc(doc(db, 'notes', noteId));
      currentNoteId = null;
      $('note-editor').innerHTML = `<div class="note-editor-empty"><p>Wybierz notatkę lub utwórz nową</p></div>`;
    });
  });
}

function scheduleNoteSave() {
  clearTimeout(noteSaveTimeout);
  noteSaveTimeout = setTimeout(async () => {
    const noteId = currentNoteId;
    if (!noteId) return;
    const title = $('note-title-edit')?.value || '';
    const body = $('note-body-edit')?.value || '';
    await updateDoc(doc(db, 'notes', noteId), { title, body, updatedAt: serverTimestamp() });
  }, 800);
}

async function createNote(title) {
  const ref = await addDoc(collection(db, 'notes'), {
    userId: currentUser.uid,
    title: title || 'Nowa notatka',
    body: '',
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  });
  currentNoteId = ref.id;
  showToast('Notatka utworzona', 'success');
}

// ============================================================
// MEMBERS
// ============================================================
async function addMember(projectId, email) {
  // Find user by email
  const usersSnap = await getDocs(query(collection(db, 'users'), where('email', '==', email)));
  if (usersSnap.empty) { showToast('Nie znaleziono użytkownika z tym emailem', 'error'); return; }
  const userDoc = usersSnap.docs[0];
  const userData = userDoc.data();
  const proj = projects[projectId];
  if (proj.memberIds?.includes(userDoc.id)) { showToast('Użytkownik już jest członkiem', 'error'); return; }

  await updateDoc(doc(db, 'projects', projectId), {
    memberIds: arrayUnion(userDoc.id),
    members: arrayUnion({ uid: userDoc.id, name: userData.name, email: userData.email, role: 'member' })
  });
  showToast(`${userData.name} dodany do projektu`, 'success');
  renderMembersList(projectId);
}

function renderMembersList(projectId) {
  const proj = projects[projectId];
  const list = $('members-list');
  list.innerHTML = (proj?.members || []).map(m => `
    <div class="member-item">
      <div class="user-avatar small">${getInitials(m.name)}</div>
      <div class="member-name">${m.name}</div>
      <span class="member-role">${m.role === 'owner' ? '👑 Właściciel' : 'Członek'}</span>
      ${m.uid !== currentUser.uid ? `<span class="member-remove" data-uid="${m.uid}">✕</span>` : ''}
    </div>`).join('');

  list.querySelectorAll('.member-remove').forEach(btn => {
    btn.addEventListener('click', async () => {
      const uid = btn.dataset.uid;
      const member = proj.members.find(m => m.uid === uid);
      await updateDoc(doc(db, 'projects', projectId), {
        memberIds: arrayRemove(uid),
        members: arrayRemove(member)
      });
      renderMembersList(projectId);
    });
  });
}

// ============================================================
// PROJECT MODAL
// ============================================================
function openCreateProjectModal() {
  editingProjectId = null;
  $('project-modal-title').textContent = 'Nowy projekt';
  $('proj-name-input').value = '';
  $('proj-desc-input').value = '';
  $('proj-deadline-input').value = '';
  selectedProjColor = '#6B7C5C';
  updateColorPicker('proj-color-picker', selectedProjColor);
  openModal('project-modal');
}

function openEditProjectModal(projectId) {
  editingProjectId = projectId;
  const proj = projects[projectId];
  $('project-modal-title').textContent = 'Edytuj projekt';
  $('proj-name-input').value = proj.name || '';
  $('proj-desc-input').value = proj.desc || '';
  $('proj-deadline-input').value = proj.deadline || '';
  selectedProjColor = proj.color || '#6B7C5C';
  updateColorPicker('proj-color-picker', selectedProjColor);
  openModal('project-modal');
}

function updateColorPicker(pickerId, selectedColor) {
  // New button-based picker: update swatch + label
  const prefix = pickerId === 'proj-color-picker' ? 'proj' : 'col';
  const swatch = $(`${prefix}-color-swatch`);
  const label = $(`${prefix}-color-label`);
  const input = $(`${prefix}-color-input`);
  if (swatch) swatch.style.background = selectedColor;
  if (label) label.textContent = selectedColor;
  if (input) input.value = selectedColor;
}

async function saveProjectModal() {
  const name = $('proj-name-input').value.trim();
  const desc = $('proj-desc-input').value.trim();
  const deadline = $('proj-deadline-input').value;
  if (!name) { showToast('Podaj nazwę projektu', 'error'); return; }

  if (editingProjectId) {
    await updateProject(editingProjectId, { name, desc, deadline: deadline || null, color: selectedProjColor });
    showToast('Projekt zaktualizowany', 'success');
  } else {
    const id = await createProject(name, desc, deadline, selectedProjColor);
    subscribeToTasks(id);
  }
  closeModal('project-modal');
}

// ============================================================
// CHANGE PASSWORD MODAL
// ============================================================
async function changePassword() {
  const newPw = $('new-password-input').value;
  const confirmPw = $('confirm-password-input').value;
  if (newPw !== confirmPw) { showToast('Hasła nie są zgodne', 'error'); return; }
  if (newPw.length < 6) { showToast('Hasło musi mieć min. 6 znaków', 'error'); return; }
  try {
    await updatePassword(currentUser, newPw);
    showToast('Hasło zmienione!', 'success');
    closeModal('change-password-modal');
  } catch (e) {
    showToast('Błąd: ' + e.message, 'error');
  }
}

// ============================================================
// ARCHIVED PROJECTS
// ============================================================
let showingArchived = false;
function toggleArchivedView() {
  showingArchived = !showingArchived;
  $('show-archived-btn').textContent = showingArchived ? '← Aktywne' : 'Archiwum';
  renderProjectsView(showingArchived);
}

// ============================================================
// EVENT LISTENERS SETUP
// ============================================================
function setupEventListeners() {

  // Auth
  $('login-btn').addEventListener('click', login);
  $('register-btn').addEventListener('click', register);
  $('forgot-btn').addEventListener('click', forgotPassword);
  $('go-register').addEventListener('click', showRegisterForm);
  $('go-login').addEventListener('click', showLoginForm);
  $('forgot-link').addEventListener('click', showForgotForm);
  $('back-login').addEventListener('click', showLoginForm);
  $('logout-btn').addEventListener('click', logout);

  // Navigation
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', e => { e.preventDefault(); navigateTo(item.dataset.view); });
  });

  // Dashboard
  $('mini-prev').addEventListener('click', () => { miniCalDate.setMonth(miniCalDate.getMonth() - 1); renderMiniCalendar(); });
  $('mini-next').addEventListener('click', () => { miniCalDate.setMonth(miniCalDate.getMonth() + 1); renderMiniCalendar(); });

  // Calendar
  $('cal-prev').addEventListener('click', () => { fullCalDate.setMonth(fullCalDate.getMonth() - 1); renderFullCalendar(); });
  $('cal-next').addEventListener('click', () => { fullCalDate.setMonth(fullCalDate.getMonth() + 1); renderFullCalendar(); });

  // Projects
  $('create-project-btn').addEventListener('click', openCreateProjectModal);
  $('new-project-btn').addEventListener('click', openCreateProjectModal);
  $('show-archived-btn').addEventListener('click', toggleArchivedView);

  // Project modal
  $('save-project-btn').addEventListener('click', saveProjectModal);
  $('cancel-project-modal').addEventListener('click', () => closeModal('project-modal'));
  $('close-project-modal').addEventListener('click', () => closeModal('project-modal'));
  // Project modal - color picker
  const projColorBtn = $('proj-color-btn');
  const projColorInput = $('proj-color-input');
  if (projColorBtn && projColorInput) {
    projColorBtn.addEventListener('click', () => projColorInput.click());
    projColorInput.addEventListener('input', () => {
      selectedProjColor = projColorInput.value;
      updateColorPicker('proj-color-picker', selectedProjColor);
    });
  }

  // Column modal
  $('close-column-modal').addEventListener('click', () => closeModal('column-modal'));
  $('cancel-column-modal').addEventListener('click', () => closeModal('column-modal'));
  // Column modal - color picker
  const colColorBtn = $('col-color-btn');
  const colColorInput = $('col-color-input');
  if (colColorBtn && colColorInput) {
    colColorBtn.addEventListener('click', () => colColorInput.click());
    colColorInput.addEventListener('input', () => {
      selectedColColor = colColorInput.value;
      updateColorPicker('col-color-picker', selectedColColor);
    });
  }

  // Task modal
  $('close-task-modal').addEventListener('click', () => closeModal('task-modal'));
  $('task-modal-overlay').addEventListener('click', () => closeModal('task-modal'));

  // Autosave: pola tekstowe z debounce 1.2s
  $('task-title-input')?.addEventListener('input', scheduleAutoSave);
  $('task-desc')?.addEventListener('input', scheduleAutoSave);
  ['task-priority-select','task-status-select','task-state-select','task-assignee-select','task-due-date'].forEach(id => {
    $(id)?.addEventListener('change', autoSaveTask);
  });

  // Historia zmian — toggle (domyślnie zwinięta)
  $('history-toggle')?.addEventListener('click', () => {
    const wrap = $('task-history-wrap');
    const chevron = $('history-chevron');
    if (!wrap) return;
    const isOpen = wrap.style.display === 'block';
    wrap.style.display = isOpen ? 'none' : 'block';
    chevron.style.transform = isOpen ? 'rotate(-90deg)' : 'rotate(0deg)';
  });

  $('delete-task-btn').addEventListener('click', () => {
    showConfirm('Usuń zadanie', 'Zadanie zostanie permanentnie usunięte.', async () => {
      await deleteTask(currentTaskId);
      closeModal('task-modal');
    });
  });
  $('add-checklist-item-btn').addEventListener('click', () => {
    const checklist = getCurrentChecklist();
    checklist.push({ text: '', done: false });
    renderChecklist(checklist);
    const inputs = document.querySelectorAll('.checklist-item-text');
    if (inputs.length) inputs[inputs.length - 1].focus();
  });

  // Comments
  $('submit-comment-btn').addEventListener('click', submitComment);
  setupMentionDropdown();
  setupCommentImageInput();

  // Attachments
  $('attachment-upload').addEventListener('change', e => uploadAttachment(e.target.files));

  // Project page buttons
  $('back-to-projects').addEventListener('click', () => navigateTo('projects'));
  $('project-edit-btn').addEventListener('click', () => openEditProjectModal(currentProjectId));
  $('project-members-btn').addEventListener('click', () => {
    renderMembersList(currentProjectId);
    openModal('members-modal');
  });
  
  // Project view toggle (Kanban / Lista)
  $('project-view-kanban-btn')?.addEventListener('click', () => setProjectView('kanban'));
  $('project-view-list-btn')?.addEventListener('click', () => setProjectView('list'));
  $('project-list-search')?.addEventListener('input', () => currentProjectId && renderProjectList(currentProjectId));

  $('project-list-show-done')?.addEventListener('change', () => currentProjectId && renderProjectList(currentProjectId));

  // ---- Dodaj zadanie (split button) — jeden raz, nie w bindListTableInteractions ----
  $('list-add-task-global')?.addEventListener('click', () => {
    openAddTaskConfirmModal();
  });

  $('list-add-split-arrow')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const menu = $('list-add-split-menu');
    if (menu) menu.classList.toggle('hidden');
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.list-add-split-wrap')) {
      $('list-add-split-menu')?.classList.add('hidden');
    }
  });

  $('list-add-section-btn')?.addEventListener('click', () => {
    $('list-add-split-menu')?.classList.add('hidden');
    if (currentProjectId) openAddColumnModal(currentProjectId);
  });

  // Potwierdzenie dodania zadania
  $('add-task-confirm-overlay')?.addEventListener('click', () => closeModal('add-task-confirm-modal'));
  $('add-task-confirm-title')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('add-task-confirm-ok')?.click();
    if (e.key === 'Escape') closeModal('add-task-confirm-modal');
  });
  $('add-task-confirm-cancel')?.addEventListener('click', () => closeModal('add-task-confirm-modal'));
  $('add-task-confirm-ok')?.addEventListener('click', async () => {
    const titleInput = $('add-task-confirm-title');
    const title = titleInput?.value.trim() || 'Nowe zadanie';
    closeModal('add-task-confirm-modal');
    const proj = projects[currentProjectId];
    const cols = [...(proj?.columns || [])].sort((a, b) => a.order - b.order);
    const colId = cols[0]?.id;
    if (!colId) { showToast('Dodaj najpierw sekcję', 'error'); return; }
    try {
      const newId = await createTask(currentProjectId, colId, title);
      let attempts = 0;
      const tryOpen = async () => {
        if (getTaskById(newId)) { await openTaskModal(newId, currentProjectId); }
        else if (attempts++ < 10) { setTimeout(tryOpen, 150); }
      };
      tryOpen();
    } catch(e) {
      showToast('Nie udało się dodać zadania', 'error');
    }
  });

$('project-calendar-btn').addEventListener('click', () => {
    $('kanban-board').classList.add('hidden');
    $('project-list-view').classList.add('hidden');
    $('project-dashboard').classList.add('hidden');
    $('gantt-view').classList.add('hidden');
    $('project-calendar-view').classList.remove('hidden');
    setActiveProjectTab('project-calendar-btn');
    renderProjectCalendar(currentProjectId);
  });
  $('project-gantt-btn').addEventListener('click', () => {
    $('kanban-board').classList.add('hidden');
    $('project-list-view').classList.add('hidden');
    $('project-dashboard').classList.add('hidden');
    $('project-calendar-view').classList.add('hidden');
    $('gantt-view').classList.remove('hidden');
    setActiveProjectTab('project-gantt-btn');
    renderGantt(currentProjectId);
  });
  $('close-proj-cal').addEventListener('click', () => {
    $('project-calendar-view').classList.add('hidden');
    $('project-dashboard').classList.remove('hidden');
    setProjectView(currentProjectView);
  });
  $('close-gantt').addEventListener('click', () => {
    $('gantt-view').classList.add('hidden');
    $('project-dashboard').classList.remove('hidden');
    setProjectView(currentProjectView);
  });
  $('proj-cal-prev').addEventListener('click', () => { projCalDate.setMonth(projCalDate.getMonth() - 1); renderProjectCalendar(currentProjectId); });
  $('proj-cal-next').addEventListener('click', () => { projCalDate.setMonth(projCalDate.getMonth() + 1); renderProjectCalendar(currentProjectId); });

  // Project filters
  $('proj-filter-priority').addEventListener('change', () => { renderKanban(currentProjectId); renderProjectList(currentProjectId); });
  $('proj-filter-assignee').addEventListener('change', () => { renderKanban(currentProjectId); renderProjectList(currentProjectId); });


  // Members modal
  $('close-members-modal').addEventListener('click', () => closeModal('members-modal'));
  $('add-member-btn').addEventListener('click', () => {
    const email = $('member-email-input').value.trim();
    if (email) addMember(currentProjectId, email);
  });

  // Notes
  $('new-note-btn').addEventListener('click', () => openModal('note-modal'));
  $('close-note-modal').addEventListener('click', () => closeModal('note-modal'));
  $('cancel-note-modal').addEventListener('click', () => closeModal('note-modal'));
  $('save-note-modal-btn').addEventListener('click', async () => {
    const title = $('note-title-input').value.trim() || 'Nowa notatka';
    await createNote(title);
    closeModal('note-modal');
    navigateTo('notes');
  });

  // Statistics
  $('stats-filter-project').addEventListener('change', renderStatistics);
  $('stats-filter-period').addEventListener('change', renderStatistics);
  $('stats-sort').addEventListener('change', renderStatistics);

  // Confirm modal
  $('confirm-ok').addEventListener('click', () => {
    if (confirmCallback) confirmCallback();
    closeModal('confirm-modal');
    confirmCallback = null;
  });
  $('confirm-cancel').addEventListener('click', () => {
    closeModal('confirm-modal');
    confirmCallback = null;
  });

  // Close dropdowns on outside click
  document.addEventListener('click', e => {
    if (!e.target.closest('.project-card-menu')) {
      document.querySelectorAll('.project-dropdown').forEach(d => d.classList.add('hidden'));
    }
    if (!e.target.closest('.comment-input-wrap')) {
      $('mention-dropdown').classList.add('hidden');
    }
  });

  // Modals - close on overlay click
  document.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', () => {
      overlay.closest('.modal').classList.add('hidden');
    });
  });
  document.querySelectorAll('.modal-close').forEach(btn => {
    btn.addEventListener('click', () => {
      btn.closest('.modal').classList.add('hidden');
    });
  });

  // Change password
  $('close-change-pw-modal').addEventListener('click', () => closeModal('change-password-modal'));
  $('cancel-change-pw').addEventListener('click', () => closeModal('change-password-modal'));
  $('save-new-password-btn').addEventListener('click', changePassword);

  // User info click - show change password
  $('user-info-sidebar').addEventListener('click', () => {
    $('new-password-input').value = '';
    $('confirm-password-input').value = '';
    openModal('change-password-modal');
  });
}

// ============================================================
// INIT
// ============================================================
async function initApp() {
  runIntro();
  setupEventListeners();

  // Load saved filters
  try {
    const saved = localStorage.getItem('mw_proj_filters');
    if (saved) savedProjFilters = JSON.parse(saved);
  } catch(e) {}

  onAuthStateChanged(auth, async user => {
    if (user) {
      currentUser = user;
      updateUserUI();
      showApp();
      subscribeToProjects();
      subscribeToNotes();
      startClock();
      await loadCollapsedSections();
      await loadListColumnConfig();
      navigateTo('dashboard');
    } else {
      currentUser = null;
      showAuthScreen();
    }
  });
}

initApp();
