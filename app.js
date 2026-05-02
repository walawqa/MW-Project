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
let inboxItems = {};
let inboxUnsubscribe = null;
let chatUnsubscribe = null;
let chatProjectId = null;

// ============================================================
// LIST COLUMN CONFIG (per user, saved to Firestore)
// ============================================================
const LIST_COLUMNS_DEFAULT = [
  { id: 'checkbox',  label: '',        width: 52,  visible: true,  resizable: false },
  { id: 'title',     label: 'Nazwa zadania',width: 200,visible: true,  resizable: false, flex: true },
  { id: 'desc',      label: 'Opis',         width: 250, visible: false, resizable: false },
  { id: 'assignee',  label: 'Osoba',        width: 190, visible: true,  resizable: false },
  { id: 'status',    label: 'Sekcja',      width: 100, visible: true,  resizable: false },
  { id: 'due',       label: 'Termin',       width: 75,  visible: true,  resizable: false },
  { id: 'priority',  label: 'Priorytet',    width: 90,  visible: true,  resizable: false },
  { id: 'created',   label: 'Utworzono',    width: 95, visible: false, resizable: false },
];
// projectColumnConfigs: { [projectId]: [...columns] } — per project per user
let projectColumnConfigs = {};
let listColSaveTimeout = null;
let listSortCol = 'due';
let listSortDir = 'asc';

function getListColumns(projectId) {
  const pid = projectId || currentProjectId;
  const saved = pid ? projectColumnConfigs[pid] : null;
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
    const saved = snap.data()?.projectColumnConfigs;
    if (saved && typeof saved === 'object') {
      Object.keys(saved).forEach(pid => {
        const arr = saved[pid];
        if (!Array.isArray(arr)) return;
        const normalized = arr
          .map(s => {
            const def = LIST_COLUMNS_DEFAULT.find(d => d.id === s.id);
            if (!def) return null;
            return { id: s.id, width: def.width, visible: s.visible ?? def.visible };
          })
          .filter(Boolean);
        LIST_COLUMNS_DEFAULT.forEach(def => {
          if (!normalized.find(c => c.id === def.id))
            normalized.push({ id: def.id, width: def.width, visible: def.visible });
        });
        projectColumnConfigs[pid] = normalized;
      });
    }
  } catch(e) {}
}

function saveListColumnConfig(cols, projectId) {
  const pid = projectId || currentProjectId;
  if (!pid) return;
  projectColumnConfigs[pid] = cols.map(c => ({ id: c.id, width: c.width, visible: c.visible }));
  clearTimeout(listColSaveTimeout);
  listColSaveTimeout = setTimeout(async () => {
    if (!currentUser) return;
    try {
      await updateDoc(doc(db, 'users', currentUser.uid), {
        ['projectColumnConfigs.' + pid]: projectColumnConfigs[pid]
      });
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
  return { high: 'Wysoki', medium: 'Średni', low: 'Niski' }[p] || 'Niski';
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
  // Po 1.4s litery są na miejscu — dodaj klasę explode (rozpad)
  setTimeout(() => {
    overlay.classList.add('explode');
    // Po animacji rozpadu (0.55s) ukryj overlay
    setTimeout(() => {
      overlay.style.transition = 'opacity .2s ease';
      overlay.style.opacity = '0';
      setTimeout(() => { overlay.style.display = 'none'; }, 200);
    }, 500);
  }, 1400);
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
    showToast('Konto utworzone!', 'success');
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
  if (inboxUnsubscribe) { inboxUnsubscribe(); inboxUnsubscribe = null; }
  if (chatUnsubscribe) { chatUnsubscribe(); chatUnsubscribe = null; }
  chatProjectId = null;
  projectListeners = {};
  taskListeners = {};
  projects = {};
  tasks = {};
  inboxItems = {};
  collapsedSections = {};
  listColumnConfig = null;
}

// ============================================================
// NAVIGATION
// ============================================================
function navigateTo(view, extraData) {
  document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));

  // Wyczyść podświetlenie projektu w sidebarze gdy wychodzimy z widoku projektu
  if (view !== 'project') {
    currentProjectId = null;
    document.querySelectorAll('.sidebar-project-item').forEach(el => el.classList.remove('active'));

  }

  // Blokuj scroll #main-content w widoku projektu — list-table-wrap scrolluje samodzielnie
  const mc = document.getElementById('main-content');
  if (mc) mc.classList.toggle('project-view-active', view === 'project');

  const viewEl = $(`view-${view}`);
  if (viewEl) viewEl.classList.remove('hidden');

  const navEl = document.querySelector(`[data-view="${view}"]`);
  if (navEl) navEl.classList.add('active');

  if (view === 'dashboard') renderDashboard();
  if (view === 'projects') renderProjectsView();
  if (view === 'calendar') renderFullCalendar();
  if (view === 'statistics') renderStatistics();
  if (view === 'notes') renderNotes();
  if (view === 'inbox') renderInbox();
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
  const photoURL = currentUser.photoURL || '';
  $('user-name-sidebar').textContent = name;
  $('user-email-sidebar').textContent = email;
  const sidebarAvatar = $('user-avatar-sidebar');
  if (photoURL) {
    sidebarAvatar.style.backgroundImage = `url(${photoURL})`;
    sidebarAvatar.style.backgroundSize = 'cover';
    sidebarAvatar.style.backgroundPosition = 'center';
    sidebarAvatar.textContent = '';
  } else {
    sidebarAvatar.style.backgroundImage = '';
    sidebarAvatar.textContent = getInitials(name);
  }
  const commentAvatar = $('comment-avatar');
  if (commentAvatar) {
    if (photoURL) {
      commentAvatar.style.backgroundImage = `url(${photoURL})`;
      commentAvatar.style.backgroundSize = 'cover';
      commentAvatar.style.backgroundPosition = 'center';
      commentAvatar.textContent = '';
    } else {
      commentAvatar.style.backgroundImage = '';
      commentAvatar.textContent = getInitials(name);
    }
  }
  const dashAvatar = $('dash-user-avatar');
  if (dashAvatar) {
    if (photoURL) {
      dashAvatar.style.backgroundImage = `url(${photoURL})`;
      dashAvatar.style.backgroundSize = 'cover';
      dashAvatar.style.backgroundPosition = 'center';
      dashAvatar.textContent = '';
    } else {
      dashAvatar.style.backgroundImage = '';
      dashAvatar.textContent = getInitials(name);
    }
  }
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

function subscribeToPersonalTasks() {
  if (taskListeners['__personal__']) return;
  const q = query(
    collection(db, 'tasks'),
    where('projectId', '==', null),
    where('createdBy', '==', currentUser.uid)
  );
  const unsub = onSnapshot(q, snap => {
    if (!tasks['__personal__']) tasks['__personal__'] = {};
    snap.docChanges().forEach(change => {
      if (change.type === 'removed') {
        delete tasks['__personal__'][change.doc.id];
      } else {
        tasks['__personal__'][change.doc.id] = { id: change.doc.id, ...change.doc.data() };
      }
    });
    if (document.querySelector('#view-dashboard:not(.hidden)')) {
      renderDashboardStats();
      renderDashboardTasks();
    }
  });
  taskListeners['__personal__'] = unsub;
}

async function createPersonalTask(title, dueDate, priority) {
  const taskRef = await addDoc(collection(db, 'tasks'), {
    projectId: null,
    columnId: null,
    title,
    status: 'open',
    desc: '',
    priority: priority || 'medium',
    dueDate: dueDate || null,
    assigneeId: currentUser.uid,
    assigneeName: currentUser.displayName || 'Użytkownik',
    checklist: [], attachments: [], comments: [],
    history: [{ action: 'Zadanie utworzone', by: currentUser.displayName || 'Użytkownik', at: new Date().toISOString() }],
    createdAt: serverTimestamp(),
    createdBy: currentUser.uid,
    createdByName: currentUser.displayName || 'Użytkownik'
  });
  return taskRef.id;
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
  try {
    // Verify ownership client-side first for a clear error message
    const proj = projects[projectId];
    const isOwner =
      proj?.ownerId === currentUser.uid ||
      (proj?.members || []).some(m => m.uid === currentUser.uid && m.role === 'owner');
    if (!isOwner) { showToast('Brak uprawnień – tylko właściciel może usunąć projekt', 'error'); return; }

    // Delete all tasks
    const tSnap = await getDocs(query(collection(db, 'tasks'), where('projectId', '==', projectId)));
    for (const td of tSnap.docs) await deleteDoc(doc(db, 'tasks', td.id));
    // Delete project messages
    try {
      const msgSnap = await getDocs(query(collection(db, 'projectMessages'), where('projectId', '==', projectId)));
      for (const md of msgSnap.docs) await deleteDoc(doc(db, 'projectMessages', md.id));
    } catch(e) {}
    // Delete the project itself
    await deleteDoc(doc(db, 'projects', projectId));
    showToast('Projekt usunięty', 'success');
    if (currentProjectId === projectId) currentProjectId = null;
    navigateTo('projects');
  } catch(e) {
    console.error('deleteProject error:', e);
    showToast('Nie udało się usunąć projektu: ' + (e.message || e.code || e), 'error');
  }
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
  const autoAssign = localStorage.getItem('mw_auto_assign') === 'true';
  const assigneeId   = autoAssign ? (currentUser?.uid || null) : null;
  const assigneeName = autoAssign ? (currentUser?.displayName || null) : null;
  const taskRef = await addDoc(collection(db, 'tasks'), {
    projectId, columnId, title,
    status: 'open',
    desc: '', priority: 'medium', dueDate: null,
    assigneeId, assigneeName,
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
// ── Sidebar project order (saved per user in localStorage) ───────────
function getSidebarOrder() {
  try { return JSON.parse(localStorage.getItem('mw_sidebar_order') || '[]'); } catch { return []; }
}
function saveSidebarOrder(ids) {
  localStorage.setItem('mw_sidebar_order', JSON.stringify(ids));
}
function getSortedSidebarProjects() {
  const active = Object.values(projects).filter(p => !p.archived);
  const order  = getSidebarOrder();
  if (!order.length) return active;
  const inOrder   = order.map(id => active.find(p => p.id === id)).filter(Boolean);
  const remainder = active.filter(p => !order.includes(p.id));
  return [...inOrder, ...remainder];
}

function renderSidebarProjects() {
  const list = $('sidebar-project-list');
  const sorted = getSortedSidebarProjects();

  list.innerHTML = sorted.map(p => `
    <div class="sidebar-project-item ${currentProjectId === p.id ? 'active' : ''}" data-id="${p.id}" draggable="true">
      <span class="sidebar-drag-handle" title="Przeciągnij aby zmienić kolejność">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="10" height="10"><circle cx="9" cy="5" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="9" cy="19" r="1"/><circle cx="15" cy="5" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="19" r="1"/></svg>
      </span>
      <div class="proj-color-dot" style="background:${p.color || '#6B7C5C'}"></div>
      <span class="sidebar-proj-name">${p.name}</span>
    </div>
  `).join('');

  // ── Click to open ─────────────────────────────────────────────────────
  list.querySelectorAll('.sidebar-project-item').forEach(el => {
    el.addEventListener('click', e => {
      if (e.target.closest('.sidebar-drag-handle')) return;
      navigateTo('project', el.dataset.id);
    });
  });

  // ── Drag & Drop ───────────────────────────────────────────────────────
  let dragId = null;
  let indicator = null;

  function removeIndicator() {
    indicator?.remove();
    indicator = null;
  }

  function createIndicator(refEl, before) {
    removeIndicator();
    indicator = document.createElement('div');
    indicator.className = 'sidebar-drop-indicator';
    if (before) refEl.parentNode.insertBefore(indicator, refEl);
    else        refEl.parentNode.insertBefore(indicator, refEl.nextSibling);
  }

  list.querySelectorAll('.sidebar-project-item').forEach(item => {
    item.addEventListener('dragstart', e => {
      dragId = item.dataset.id;
      item.classList.add('sidebar-dragging');
      e.dataTransfer.effectAllowed = 'move';
    });

    item.addEventListener('dragend', () => {
      item.classList.remove('sidebar-dragging');
      removeIndicator();
      dragId = null;
    });

    item.addEventListener('dragover', e => {
      e.preventDefault();
      if (!dragId || item.dataset.id === dragId) return;
      const rect   = item.getBoundingClientRect();
      const before = e.clientY < rect.top + rect.height / 2;
      createIndicator(item, before);
    });

    item.addEventListener('dragleave', e => {
      if (!item.contains(e.relatedTarget)) removeIndicator();
    });

    item.addEventListener('drop', e => {
      e.preventDefault();
      if (!dragId || item.dataset.id === dragId) return;
      removeIndicator();

      const sorted2 = getSortedSidebarProjects();
      const ids     = sorted2.map(p => p.id);
      const from    = ids.indexOf(dragId);
      const to      = ids.indexOf(item.dataset.id);
      if (from === -1 || to === -1) return;

      const rect   = item.getBoundingClientRect();
      const before = e.clientY < rect.top + rect.height / 2;
      ids.splice(from, 1);
      const insertAt = before ? ids.indexOf(item.dataset.id) : ids.indexOf(item.dataset.id) + 1;
      ids.splice(insertAt, 0, dragId);

      saveSidebarOrder(ids);
      renderSidebarProjects();
    });
  });

  // ── Touch DnD (iOS) ───────────────────────────────────────────────────
  if (window.matchMedia('(hover:none) and (pointer:coarse)').matches) {
    let touchDragId = null, touchClone = null;

    list.querySelectorAll('.sidebar-drag-handle').forEach(handle => {
      const item = handle.closest('.sidebar-project-item');

      handle.addEventListener('touchstart', e => {
        touchDragId = item.dataset.id;
        item.classList.add('sidebar-dragging');
        const rect = item.getBoundingClientRect();
        touchClone = item.cloneNode(true);
        touchClone.style.cssText = `position:fixed;top:${rect.top}px;left:${rect.left}px;width:${rect.width}px;opacity:.8;pointer-events:none;z-index:9999;background:var(--surface);border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.2);`;
        document.body.appendChild(touchClone);
        e.preventDefault();
      }, { passive: false });

      handle.addEventListener('touchmove', e => {
        if (!touchClone) return;
        e.preventDefault();
        const t = e.touches[0];
        touchClone.style.top = (t.clientY - 18) + 'px';
        touchClone.style.display = 'none';
        const el = document.elementFromPoint(t.clientX, t.clientY);
        touchClone.style.display = '';
        const targetItem = el?.closest('.sidebar-project-item');
        if (targetItem && targetItem.dataset.id !== touchDragId) {
          const rect   = targetItem.getBoundingClientRect();
          const before = t.clientY < rect.top + rect.height / 2;
          createIndicator(targetItem, before);
        } else {
          removeIndicator();
        }
      }, { passive: false });

      handle.addEventListener('touchend', e => {
        if (!touchDragId) return;
        e.preventDefault();
        const t = e.changedTouches[0];
        touchClone?.remove(); touchClone = null;
        item.classList.remove('sidebar-dragging');
        removeIndicator();

        const el = document.elementFromPoint(t.clientX, t.clientY);
        const targetItem = el?.closest('.sidebar-project-item');
        if (targetItem && targetItem.dataset.id !== touchDragId) {
          const sorted2 = getSortedSidebarProjects();
          const ids     = sorted2.map(p => p.id);
          const from    = ids.indexOf(touchDragId);
          const to      = ids.indexOf(targetItem.dataset.id);
          if (from !== -1 && to !== -1) {
            const rect   = targetItem.getBoundingClientRect();
            const before = t.clientY < rect.top + rect.height / 2;
            ids.splice(from, 1);
            const insertAt = before ? ids.indexOf(targetItem.dataset.id) : ids.indexOf(targetItem.dataset.id) + 1;
            ids.splice(insertAt, 0, touchDragId);
            saveSidebarOrder(ids);
            renderSidebarProjects();
          }
        }
        touchDragId = null;
      }, { passive: false });
    });
  }
}

// ============================================================
// DASHBOARD
// ============================================================
function renderDashboard() {
  renderDashboardStats();
  renderDashboardTasks();
  renderDashboardProjects();
  renderMiniCalendar();
  initDashboardTabs();
}

function renderDashboardStats() {
  const myTasks = getAllProjectTasks().filter(t => t.assigneeId === currentUser.uid);
  const done = myTasks.filter(t => isTaskDone(t));
  const active = myTasks.filter(t => !isTaskDone(t));
  $('qs-done').textContent = done.length;
  $('qs-projects').textContent = Object.values(projects).filter(p => !p.archived).length;
  const myTasksEl = $('qs-my-tasks');
  if (myTasksEl) myTasksEl.textContent = active.length;
  // avatar
  const av = $('dash-user-avatar');
  if (av && currentUser?.displayName) av.textContent = currentUser.displayName.charAt(0).toUpperCase();
}

function renderDashboardTasks() {
  const allTasks = getAllProjectTasks().filter(t => t.assigneeId === currentUser.uid);
  const today = new Date(); today.setHours(0,0,0,0);

  // Nadchodzące: niezakończone (termin dziś lub w przyszłości, lub bez terminu)
  const upcoming = allTasks
    .filter(t => {
      if (isTaskDone(t)) return false;
      if (t.dueDate) {
        const d = new Date(t.dueDate); d.setHours(0,0,0,0);
        if (d < today) return false; // zaległe trafiają do innej zakładki
      }
      return true;
    })
    .sort((a, b) => {
      if (a.dueDate && b.dueDate) return new Date(a.dueDate) - new Date(b.dueDate);
      if (a.dueDate) return -1; if (b.dueDate) return 1; return 0;
    });

  // Zaległe: niezakończone z terminem w przeszłości
  const overdue = allTasks
    .filter(t => {
      if (isTaskDone(t)) return false;
      if (!t.dueDate) return false;
      const d = new Date(t.dueDate); d.setHours(0,0,0,0);
      return d < today;
    })
    .sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));

  // Ukończone
  const done = allTasks
    .filter(t => isTaskDone(t))
    .sort((a, b) => (b.updatedAt?.seconds || 0) - (a.updatedAt?.seconds || 0));

  const renderList = (listId, items, emptyMsg) => {
    const list = $(listId);
    if (!list) return;
    if (!items.length) {
      list.innerHTML = `<div class="empty-state"><p>${emptyMsg}</p></div>`;
      return;
    }
    list.innerHTML = items.map(t => taskFeedItem(t)).join('');
    list.querySelectorAll('.task-feed-item').forEach(el => {
      el.addEventListener('click', () => openTaskModal(el.dataset.id, el.dataset.project));
    });
    list.querySelectorAll('.feed-check-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const task = getTaskById(btn.dataset.id);
        if (!task) return;
        const newStatus = isTaskDone(task) ? 'open' : 'done';
        try {
          await updateTask(btn.dataset.id, { status: newStatus }, { action: newStatus === 'done' ? 'Oznaczono jako zakończone' : 'Przywrócono jako otwarte' });
        } catch(err) { showToast('Nie udało się zmienić statusu', 'error'); }
      });
    });
  };

  // Wszystkie aktywne: zaległe najpierw, potem nadchodzące (bez ukończonych)
  const all = [
    ...overdue,
    ...upcoming,
  ];

  renderList('all-list',      all,      'Brak aktywnych zadań');
  renderList('upcoming-list', upcoming, 'Brak nadchodzących zadań');
  renderList('overdue-list',  overdue,  'Brak zaległych zadań');
  renderList('done-list',     done,     'Brak ukończonych zadań');
}

function renderDashboardProjects() {
  const grid = $('dash-projects-grid');
  if (!grid) return;
  const active = Object.values(projects).filter(p => !p.archived);
  if (!active.length) {
    grid.innerHTML = '<div class="empty-state"><p>Brak projektów</p></div>';
    return;
  }
  grid.innerHTML = active.map(p => `
    <div class="dash-proj-item" data-id="${p.id}">
      <div class="dash-proj-icon" style="background:${p.color || '#6B7C5C'}">
        <svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" width="16" height="16"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
      </div>
      <span class="dash-proj-name">${p.name}</span>
    </div>
  `).join('');
  grid.querySelectorAll('.dash-proj-item').forEach(el => {
    el.addEventListener('click', () => navigateTo('project', el.dataset.id));
  });
}

function initDashboardTabs() {
  const tabs = document.querySelectorAll('#view-dashboard .dash-tab');
  tabs.forEach(tab => {
    // remove old listeners by cloning
    const fresh = tab.cloneNode(true);
    tab.parentNode.replaceChild(fresh, tab);
  });
  document.querySelectorAll('#view-dashboard .dash-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('#view-dashboard .dash-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('#view-dashboard .dash-tab-panel').forEach(p => p.classList.add('hidden'));
      tab.classList.add('active');
      $('dash-tab-' + tab.dataset.tab)?.classList.remove('hidden');
    });
  });
}

function renderUpcomingTasks() { renderDashboardTasks(); }
function renderTodayTasks() { /* renderDashboardTasks covers today's tasks */ }

function taskFeedItem(t) {
  const overdue = isOverdue(t.dueDate);
  const doneTask = isTaskDone(t);
  const proj = projects[t.projectId];
  return `
    <div class="task-feed-item ${overdue ? 'overdue' : ''} ${doneTask ? 'done' : ''}" data-id="${t.id}" data-project="${t.projectId}">
      <button class="feed-check-btn ${doneTask ? 'checked' : ''}" data-id="${t.id}" data-project="${t.projectId}" title="${doneTask ? 'Przywróć zadanie' : 'Oznacz jako zakończone'}">
        ${doneTask ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" width="10" height="10"><polyline points="20 6 9 17 4 12"/></svg>` : ''}
      </button>
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

  // Task dates - tylko zadania bieżącego użytkownika
  const allMyTasks = getAllMyTasks();
  const taskDates = new Set(allMyTasks.filter(t => t.dueDate).map(t => new Date(t.dueDate).toDateString()));

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
  const overdue = projTasks.filter(t => !isTaskDone(t) && isOverdue(t.dueDate)).length;

  return `
    <div class="project-card" data-id="${p.id}" style="--proj-color:${p.color || '#6B7C5C'}">
      ${p.archived ? '<span class="archived-badge">Zarchiwizowany</span>' : ''}
      <div class="project-card-header">
        <div class="project-card-title">${p.name}</div>
        <div class="project-card-menu">
          <button class="btn-icon proj-menu-btn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/></svg></button>
          <div class="project-dropdown hidden">
            <button class="project-dropdown-item proj-edit-btn" data-id="${p.id}">Edytuj</button>
            ${p.archived
              ? `<button class="project-dropdown-item proj-restore-btn" data-id="${p.id}">Przywróć</button>`
              : `<button class="project-dropdown-item proj-archive-btn" data-id="${p.id}">Archiwizuj</button>`}
            <button class="project-dropdown-item danger proj-delete-btn" data-id="${p.id}">Usuń</button>
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
        <span>${p.deadline ? `<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' width='12' height='12'><rect x='3' y='4' width='18' height='18' rx='2'/><line x1='16' y1='2' x2='16' y2='6'/><line x1='8' y1='2' x2='8' y2='6'/><line x1='3' y1='10' x2='21' y2='10'/></svg> ` + formatDate(p.deadline) : ''}</span>
        ${overdue > 0 ? `<span style="color:#E74C3C;font-weight:500"><svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' width='12' height='12'><path d='M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z'/><line x1='12' y1='9' x2='12' y2='13'/><line x1='12' y1='17' x2='12.01' y2='17'/></svg> ${overdue} po terminie</span>` : ''}
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
  $('project-chat-view').classList.add('hidden');
  $('project-notes-view').classList.add('hidden');
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
  setProjectView(currentProjectView); // also calls toggleUniversalFilters(true)

  // Load saved filters
  if (savedProjFilters[projectId]) {
    const f = savedProjFilters[projectId];
    if (f.priority)              $('proj-filter-priority').value = f.priority;
    if (f.assignee)              $('proj-filter-assignee').value = f.assignee;
    if (f.search !== undefined)  $('proj-search').value          = f.search || '';
    if (f.showDone !== undefined) $('proj-show-done').checked    = f.showDone;
  } else {
    $('proj-filter-priority').value = 'all';
    $('proj-filter-assignee').value = 'all';
    $('proj-search').value = '';
    $('proj-show-done').checked = true;
  }

  renderProjectDashboard(projectId);
  renderKanban(projectId);
  renderProjectList(projectId);
  renderSidebarProjects();
  if (typeof populateMobileAssigneeChips === "function") populateMobileAssigneeChips(projectId);
}

function getFilteredTasks(projectId, opts = {}) {
  const projTasks = Object.values(tasks[projectId] || {});
  const priority  = $('proj-filter-priority')?.value || 'all';
  const assignee  = $('proj-filter-assignee')?.value || 'all';
  const search    = ($('proj-search')?.value || '').trim().toLowerCase();
  const showDone  = $('proj-show-done')?.checked ?? true;
  return projTasks.filter(t => {
    if (priority !== 'all' && t.priority !== priority) return false;
    if (assignee !== 'all' && t.assigneeId !== assignee) return false;
    if (!showDone && isTaskDone(t)) return false;
    if (search) {
      const hay = [(t.title||''), (t.desc||''), (t.assigneeName||'')].join(' ').toLowerCase();
      if (!hay.includes(search)) return false;
    }
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
            <button class="btn-icon edit-col-btn" data-col-id="${col.id}" title="Edytuj"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>
            <button class="btn-icon delete-col-btn" data-col-id="${col.id}" title="Usuń">Usuń</button>
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
        ${t.dueDate ? `<span class="task-due ${over ? 'overdue' : ''}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg> ${formatDate(t.dueDate)}</span>` : ''}
        ${t.priority === 'high' ? '<span class="task-card-prio-high">Wysoki</span>' : ''}
        ${t.assigneeName ? `<div class="task-card-assignee">${getInitials(t.assigneeName)}</div>` : ''}
        ${doneTask ? `<span class="task-done-badge"> Zakończone</span>` : ''}
        ${(t.attachments && t.attachments.length) ? `<span class="card-attach-badge" title="${t.attachments.length} załącznik(i)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="11" height="11"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg> ${t.attachments.length}</span>` : ''}
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
      <button class="btn-icon checklist-delete" data-idx="${idx}" style="font-size:.75rem">Usuń</button>
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
  if (!attachments || !attachments.length) {
    list.innerHTML = '<span style="font-size:.75rem;color:var(--text-light);">Brak załączników</span>';
    return;
  }
  list.innerHTML = attachments.map((a, i) => {
    const url = safeAttachUrl(a.url);
    const isImg = isImageFile(a.name);
    const sizeKb = a.size ? ` (${Math.round(a.size/1024)}KB)` : '';
    return `
      <div class="pnotes-attach-item ${isImg ? 'has-preview' : ''}" data-ai="${i}">
        ${isImg ? `<div class="pnotes-attach-preview"><img src="${url}" alt="${escHtml(a.name)}" loading="lazy" onerror="this.parentElement.style.display='none'"></div>` : ''}
        <span class="pnotes-attach-icon">${fileIcon(a.name)}</span>
        <span class="pnotes-attach-name" title="${escHtml(a.name)}">${escHtml(a.name)}${sizeKb}</span>
        <button class="pnotes-attach-preview-btn task-attach-preview" data-url="${url}" data-name="${escHtml(a.name)}" title="Podgląd"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg></button>
        <button class="pnotes-attach-download task-attach-download" data-url="${url}" data-name="${escHtml(a.name)}" title="Pobierz"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg></button>
        <button class="pnotes-attach-del task-attach-del" data-idx="${i}" title="Usuń">✕</button>
      </div>`;
  }).join('');

  list.querySelectorAll('.task-attach-preview').forEach(btn => {
    btn.addEventListener('click', () => openFilePreview(btn.dataset.url, btn.dataset.name));
  });
  list.querySelectorAll('.task-attach-download').forEach(btn => {
    btn.addEventListener('click', () => downloadAttachment(btn.dataset.url, btn.dataset.name));
  });
  list.querySelectorAll('.task-attach-del').forEach(btn => {
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
    setAutosaveIndicator('Zapisano', '#059669');
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

  // Powiadomienia do skrzynki dla oznaczonych użytkowników
  if (text) {
    await sendInboxNotifications(taskId, task?.title || 'Zadanie', task?.projectId || currentProjectId, text);
  }

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

  const btn = $('attachment-upload');
  if (btn) btn.disabled = true;

  try {
    const uploaded = await uploadFilesToStorage(Array.from(files), `tasks/${taskId}`);
    uploaded.forEach(f => attachments.push(f));
  } catch(e) {
    showToast('Błąd przesyłania: ' + e.message, 'error');
  }

  // Reset
  const input = $('attachment-upload');
  if (input) { input.value = ''; input.disabled = false; }

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

  const myTasks = getAllMyTasks();
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
function hideAllProjectPanels() {
  ['kanban-board','project-list-view','project-dashboard',
   'project-calendar-view','gantt-view','project-chat-view',
   'project-notes-view'].forEach(id => {
    $(id)?.classList.add('hidden');
  });
}

function toggleUniversalFilters(show) {
  const bar = $('proj-universal-filters');
  if (bar) bar.style.display = show ? '' : 'none';
}

function setActiveProjectTab(activeId) {
  ['project-view-kanban-btn','project-view-list-btn','project-calendar-btn','project-gantt-btn','project-chat-btn','project-notes-btn'].forEach(id => {
    $(id)?.classList.toggle('active', id === activeId);
  });
}

function setProjectView(view) {
  currentProjectView = view;
  setActiveProjectTab(view === 'list' ? 'project-view-list-btn' : 'project-view-kanban-btn');
  hideAllProjectPanels();
  $('project-dashboard').classList.remove('hidden');
  toggleUniversalFilters(true);

  if (view === 'list') {
    $('kanban-board').classList.add('hidden');
    $('project-list-view').classList.remove('hidden');
  } else {
    $('project-list-view').classList.add('hidden');
    $('kanban-board').classList.remove('hidden');
  }

  // Ustaw top paska filtrów = wysokość view-header
  requestAnimationFrame(() => {
    const viewHeader = document.querySelector('#view-project .view-header');
    const vh = viewHeader ? viewHeader.offsetHeight : 0;
    const filterBar = document.getElementById('proj-universal-filters');
    if (filterBar) filterBar.style.top = vh + 'px';
  });

  if (currentProjectId) renderProjectList(currentProjectId);
}

function renderProjectList(projectId) {
  const container = $('project-list-container');
  const viewEl = $('project-list-view');
  if (!container || !viewEl) return;

  // Zapamiętaj pozycję scrolla przed re-renderem
  const scrollWrap = container.querySelector('.list-table-wrap');
  const savedScrollTop = scrollWrap ? scrollWrap.scrollTop : 0;
  const savedScrollLeft = scrollWrap ? scrollWrap.scrollLeft : 0;

  const proj = projects[projectId];
  if (!proj) { container.innerHTML = ''; return; }

  let projTasks = getFilteredTasks(projectId);

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
  const listCols = getListColumns(projectId).filter(c => c.visible);

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
      ? 'padding:0;text-align:center;width:52px;'
      : c.id === 'title' ? 'padding-left:.5rem;' : '';
    const sortAttr = isSortable ? `data-sort-col="${c.id}"` : '';
    const resizeHandle = c.id !== 'checkbox'
      ? `<span class="th-resize-handle" data-resize-col="${c.id}" title="Przeciągnij aby zmienić szerokość"></span>`
      : '';
    return `<th class="list-th${isSortable ? ' list-th-sortable' : ''}" ${dragHandle} ${sortAttr} data-th-id="${c.id}" style="${style}position:relative;">
      <span class="th-label">${c.label}</span>${arrowIcon}${resizeHandle}
    </th>`;
  }).join('');

  // Build section rows
  const sectionsHtml = sections.map(sec => {
    const c = sec.col;
    const isCollapsed = collapsed.has(c.id);
    const buildRows = sec.tasks.length
      ? sec.tasks.map(t => projectListRow(t, c, c.id, listCols)).join('')
      : `<tr data-section-col="${c.id}"><td colspan="${listCols.length + 1}" style="padding:.55rem 1.25rem;font-size:.78rem;color:var(--text-light);">Brak zadań w tej sekcji</td></tr>`;



    return `
      <tr class="list-section-row" data-col="${c.id}">
        <td colspan="${listCols.length + 1}" style="padding:.5rem 1.25rem .35rem;background:var(--surface);border-bottom:1px solid var(--border);border-top:2px solid var(--border);">
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
  const allCols = getListColumns(projectId);
  const visibilityMenu = allCols
    .filter(c => c.id !== 'checkbox')
    .map(c => `<label class="col-vis-item"><input type="checkbox" data-vis-col="${c.id}" ${c.visible ? 'checked' : ''}> ${c.label}</label>`)
    .join('');

  // ── Mobile: render as cards instead of table ─────────────────────────
  if (window.innerWidth <= 768) {
    const mobileHtml = sections.map(sec => {
      const c = sec.col;
      const isCollapsed = collapsed.has(c.id);
      const rows = sec.tasks.length
        ? sec.tasks.map(t => {
            const done = isTaskDone(t);
            const over = isOverdue(t.dueDate) && !done;
            const pr = t.priority || 'medium';
            const prColor = { high:'#EF4444', medium:'#F59E0B', low:'#10B981' }[pr] || 'var(--text-light)';
            const dueStr = t.dueDate ? formatDate(t.dueDate) : '';
            const initials = t.assigneeName ? getInitials(t.assigneeName) : '';
            const avatarColors = ['#6B7C5C','#4A90D9','#E67E22','#9B59B6','#1ABC9C','#E74C3C'];
            let h = 0; for (let i=0;i<(t.assigneeName||'').length;i++) h=(t.assigneeName||'').charCodeAt(i)+((h<<5)-h);
            const avColor = avatarColors[Math.abs(h)%avatarColors.length];
            return `<div class="mlist-row ${done?'done':''}" data-id="${t.id}" data-section-col="${c.id}">
              <div class="mlist-check-wrap">
                <input class="mlist-checkbox list-checkbox" type="checkbox" data-id="${t.id}" ${done?'checked':''} />
              </div>
              <div class="mlist-content">
                <span class="mlist-title ${done?'done':''}">${escHtml(t.title||'(bez tytułu)')}</span>
                <div class="mlist-meta">
                  <span class="mlist-prio-dot" style="background:${prColor}"></span>
                  ${dueStr ? `<span class="mlist-due ${over?'overdue':''}">${over ? '' : ''}${dueStr}</span>` : ''}
                  ${initials ? `<span class="mlist-avatar" style="background:${avColor}">${initials}</span>` : ''}
                  ${(t.attachments && t.attachments.length) ? `<span class="card-attach-badge" title="${t.attachments.length} załącznik(i)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="11" height="11"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg> ${t.attachments.length}</span>` : ''}
                </div>
              </div>
              <div class="mlist-drag"><span class="list-drag-handle">⠿</span></div>
            </div>`;
          }).join('')
        : `<div class="mlist-empty">Brak zadań w tej sekcji</div>`;
      return `
        <div class="mlist-section" data-col="${c.id}">
          <div class="mlist-section-header" data-col="${c.id}">
            <button class="section-collapse-btn" data-col="${c.id}" style="background:none;border:none;cursor:pointer;display:flex;align-items:center;padding:.2rem;color:var(--text-muted);">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="13" height="13" style="transition:transform .2s;transform:rotate(${isCollapsed?'-90deg':'0deg'})"><polyline points="6 9 12 15 18 9"/></svg>
            </button>
            <span class="mlist-section-dot" style="background:${c.color||'#6B7C5C'}"></span>
            <span class="mlist-section-name">${escHtml(c.name)}</span>
            <span class="mlist-section-count">${sec.tasks.length}</span>
          </div>
          ${isCollapsed ? '' : rows}
        </div>`;
    }).join('');

    container.innerHTML = `<div class="mlist-wrap">${mobileHtml}</div>`;
    bindListTableInteractions(container, projectId, []);
    return;
  }
  // ─────────────────────────────────────────────────────────────────────

  // ── Frozen header pattern ──────────────────────────────────────
  // Dwa osobne elementy: header (nie scrolluje) + tabela (scrolluje).
  // Synchronizacja poziomego scrolla przez JS.
  const settingsBtnHtml = `<button class="list-col-settings-btn" id="list-col-settings-btn" title="Dostosuj kolumny"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></button>`;

  container.innerHTML = `
    <div class="list-frozen-header" id="list-frozen-header">
      <div class="list-frozen-header-inner" id="list-frozen-header-inner">
        <table class="list-frozen-header-table" style="table-layout:fixed;border-collapse:collapse;">
          <colgroup>${colgroupCols}<col style="width:36px;min-width:36px;"></colgroup>
          <thead>
            <tr id="list-frozen-header-row">
              ${headerCells}
              <th class="list-th list-col-settings-th" style="width:36px;min-width:36px;padding:0;text-align:center;">
                ${settingsBtnHtml}
              </th>
            </tr>
          </thead>
        </table>
      </div>
    </div>
    <div class="list-table-wrap" id="list-table-wrap">
      <table class="list-table" id="list-table" style="table-layout:fixed;width:100%;">
        <colgroup id="list-colgroup">${colgroupCols}<col style="width:36px;min-width:36px;"></colgroup>
        <thead class="list-thead-ghost">
          <tr id="list-header-row">
            ${headerCells}
            <th style="width:36px;min-width:36px;padding:0;"></th>
          </tr>
        </thead>
        <tbody>${sectionsHtml}</tbody>
      </table>
    </div>
  `;

  // ---- Event bindings ----
  bindListTableInteractions(container, projectId, listCols);

  // Przywróć scroll
  const newScrollWrap = container.querySelector('.list-table-wrap');
  if (newScrollWrap) {
    newScrollWrap.scrollTop = savedScrollTop;
    newScrollWrap.scrollLeft = savedScrollLeft;
  }

  // Frozen header: synchronizuj poziomy scroll + szerokości kolumn
  requestAnimationFrame(() => {
    const wrap        = document.getElementById('list-table-wrap');
    const headerInner = document.getElementById('list-frozen-header-inner');
    const headerTable = headerInner?.querySelector('table');
    const mainTable   = document.getElementById('list-table');
    if (!wrap || !headerTable || !mainTable) return;

    // Ustaw szerokość header table = szerokość głównej tabeli
    function syncHeaderWidth() {
      headerTable.style.width = mainTable.offsetWidth + 'px';
    }
    syncHeaderWidth();
    setTimeout(syncHeaderWidth, 150);

    // Synchronizuj poziomy scroll
    wrap.addEventListener('scroll', () => {
      headerInner.scrollLeft = wrap.scrollLeft;
    }, { passive: true });

    new ResizeObserver(syncHeaderWidth).observe(mainTable);
  });
}

function bindListTableInteractions(container, projectId, listCols) {
  // ── Mobile card list interactions ────────────────────────────────────
  container.querySelectorAll('.mlist-row').forEach(row => {
    row.addEventListener('click', e => {
      if (e.target.classList.contains('mlist-checkbox') || e.target.classList.contains('list-drag-handle')) return;
      openTaskModal(row.dataset.id, projectId);
    });
  });
  container.querySelectorAll('.mlist-checkbox').forEach(cb => {
    cb.addEventListener('click', async e => {
      e.stopPropagation();
      const taskId = cb.dataset.id;
      const newStatus = cb.checked ? 'done' : 'open';
      await updateTask(taskId, { status: newStatus }, { action: newStatus === 'done' ? 'Oznaczono jako zakończone' : 'Przywrócono' });
    });
  });
  // ─────────────────────────────────────────────────────────────────────

  // ── Drag & Drop między sekcjami ────────────────────────────────────────
  let listDragId   = null;  // id przeciąganego zadania
  let listDragFrom = null;  // colId sekcji źródłowej
  let dropIndicator = null; // aktywna linia drop-target

  function clearDropIndicators() {
    container.querySelectorAll('.list-drop-indicator').forEach(el => el.remove());
    container.querySelectorAll('.list-section-drop-target').forEach(el => el.classList.remove('list-section-drop-target'));
    dropIndicator = null;
  }

  function showRowIndicator(tr) {
    clearDropIndicators();
    const ind = document.createElement('tr');
    ind.className = 'list-drop-indicator';
    ind.innerHTML = `<td colspan="${listCols.length + 1}" style="padding:0;height:3px;background:var(--accent);border-radius:2px;pointer-events:none;"></td>`;
    tr.parentNode.insertBefore(ind, tr);
    dropIndicator = ind;
  }

  function showSectionIndicator(sectionTr) {
    clearDropIndicators();
    sectionTr.classList.add('list-section-drop-target');
  }

  // dragstart
  container.querySelectorAll('.list-row').forEach(tr => {
    tr.addEventListener('dragstart', e => {
      listDragId   = tr.dataset.id;
      listDragFrom = tr.dataset.sectionCol;
      tr.classList.add('list-row-dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', listDragId);
    });
    tr.addEventListener('dragend', () => {
      tr.classList.remove('list-row-dragging');
      clearDropIndicators();
      listDragId = null;
      listDragFrom = null;
    });
  });

  // dragover / drop on rows
  container.querySelectorAll('.list-row').forEach(tr => {
    tr.addEventListener('dragover', e => {
      e.preventDefault();
      if (!listDragId || tr.dataset.id === listDragId) return;
      e.dataTransfer.dropEffect = 'move';
      showRowIndicator(tr);
    });
    tr.addEventListener('drop', async e => {
      e.preventDefault();
      if (!listDragId || tr.dataset.id === listDragId) return;
      clearDropIndicators();
      const targetColId = tr.dataset.sectionCol;
      if (targetColId && targetColId !== listDragFrom) {
        const col = projects[projectId]?.columns?.find(c => c.id === targetColId);
        await updateTask(listDragId, { columnId: targetColId }, { action: `Przeniesiono do sekcji "${col?.name || targetColId}"` });
      }
    });
  });

  // dragover / drop on section header rows
  container.querySelectorAll('.list-section-row').forEach(secTr => {
    secTr.addEventListener('dragover', e => {
      e.preventDefault();
      if (!listDragId) return;
      e.dataTransfer.dropEffect = 'move';
      showSectionIndicator(secTr);
    });
    secTr.addEventListener('dragleave', e => {
      if (!secTr.contains(e.relatedTarget)) {
        secTr.classList.remove('list-section-drop-target');
      }
    });
    secTr.addEventListener('drop', async e => {
      e.preventDefault();
      clearDropIndicators();
      if (!listDragId) return;
      const targetColId = secTr.dataset.col;
      if (targetColId && targetColId !== listDragFrom) {
        const col = projects[projectId]?.columns?.find(c => c.id === targetColId);
        await updateTask(listDragId, { columnId: targetColId }, { action: `Przeniesiono do sekcji "${col?.name || targetColId}"` });
      }
    });
  });

  // Prevent drag from opening modal
  container.querySelectorAll('.list-drag-handle').forEach(el => {
    el.addEventListener('mousedown', e => e.stopPropagation());
  });

  // ── Touch DnD dla iOS (HTML5 drag nie działa na touch) ───────────────
  const isTouchDevice = () => window.matchMedia('(hover: none) and (pointer: coarse)').matches;
  if (isTouchDevice()) {
    let touchDragId = null, touchDragFrom = null, touchClone = null, touchIndicator = null;

    function removeTouchArtifacts() {
      touchClone?.remove(); touchClone = null;
      touchIndicator?.remove(); touchIndicator = null;
      container.querySelectorAll('.list-row-dragging').forEach(r => r.classList.remove('list-row-dragging'));
      container.querySelectorAll('.list-section-drop-target').forEach(r => r.classList.remove('list-section-drop-target'));
      touchDragId = null; touchDragFrom = null;
    }

    container.querySelectorAll('.list-drag-handle').forEach(handle => {
      handle.addEventListener('touchstart', e => {
        const tr = handle.closest('.list-row');
        if (!tr) return;
        touchDragId = tr.dataset.id;
        touchDragFrom = tr.dataset.sectionCol;
        tr.classList.add('list-row-dragging');
        // Klonuj wiersz jako drag-ghost
        const rect = tr.getBoundingClientRect();
        touchClone = tr.cloneNode(true);
        touchClone.style.cssText = `position:fixed;top:${rect.top}px;left:${rect.left}px;width:${rect.width}px;opacity:.8;pointer-events:none;z-index:9999;background:var(--surface);box-shadow:0 4px 20px rgba(0,0,0,.18);border-radius:8px;`;
        document.body.appendChild(touchClone);
        e.preventDefault();
      }, { passive: false });

      handle.addEventListener('touchmove', e => {
        if (!touchDragId || !touchClone) return;
        e.preventDefault();
        const t = e.touches[0];
        touchClone.style.top = (t.clientY - 20) + 'px';
        touchClone.style.left = touchClone.style.left;
        // Znajdź element pod palcem
        touchClone.style.display = 'none';
        const el = document.elementFromPoint(t.clientX, t.clientY);
        touchClone.style.display = '';
        if (!el) return;
        // Wyczyść poprzednie wskaźniki
        container.querySelectorAll('.list-section-drop-target').forEach(r => r.classList.remove('list-section-drop-target'));
        touchIndicator?.remove(); touchIndicator = null;
        // Sprawdź na co najeżdżamy
        const targetRow = el.closest('.list-row');
        const targetSec = el.closest('.list-section-row');
        if (targetRow && targetRow.dataset.id !== touchDragId) {
          touchIndicator = document.createElement('tr');
          touchIndicator.className = 'list-drop-indicator';
          touchIndicator.innerHTML = `<td colspan="99" style="padding:0;height:3px;background:var(--accent);"></td>`;
          targetRow.parentNode.insertBefore(touchIndicator, targetRow);
        } else if (targetSec) {
          targetSec.classList.add('list-section-drop-target');
        }
      }, { passive: false });

      handle.addEventListener('touchend', async e => {
        if (!touchDragId) return;
        e.preventDefault();
        const t = e.changedTouches[0];
        touchClone.style.display = 'none';
        const el = document.elementFromPoint(t.clientX, t.clientY);
        touchClone.style.display = '';
        if (el) {
          const targetRow = el.closest('.list-row');
          const targetSec = el.closest('.list-section-row');
          let targetColId = null;
          if (targetRow && targetRow.dataset.id !== touchDragId) targetColId = targetRow.dataset.sectionCol;
          else if (targetSec) targetColId = targetSec.dataset.col;
          if (targetColId && targetColId !== touchDragFrom) {
            const col = projects[currentProjectId]?.columns?.find(c => c.id === targetColId);
            await updateTask(touchDragId, { columnId: targetColId }, { action: `Przeniesiono do sekcji "${col?.name || targetColId}"` });
          }
        }
        removeTouchArtifacts();
      }, { passive: false });

      handle.addEventListener('touchcancel', removeTouchArtifacts, { passive: true });
    });
  }
  // ─────────────────────────────────────────────────────────────────────

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
      if (e.target.closest('.list-priority-cell')) return;
      if (e.target.closest('.list-assignee-cell')) return;
      if (e.target.closest('.list-due-cell')) return;
      // For title span: delay to distinguish single vs double click
      if (e.target.closest('.list-inline-title')) {
        clearTimeout(tr._clickTimer);
        tr._clickTimer = setTimeout(() => openTaskModal(tr.dataset.id, projectId), 220);
        return;
      }
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

  // ---- Inline: title double-click edit ----
  container.querySelectorAll('.list-inline-title').forEach(span => {
    span.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      // Cancel pending single-click timer on the parent row
      const tr = span.closest('.list-row');
      if (tr && tr._clickTimer) { clearTimeout(tr._clickTimer); tr._clickTimer = null; }
      const input = span.closest('.list-title-wrap').querySelector('.list-title-input');
      span.classList.add('hidden');
      input.classList.remove('hidden');
      input.focus();
      input.select();
    });
  });
  container.querySelectorAll('.list-title-input').forEach(input => {
    const saveTitle = async () => {
      const span = input.closest('.list-title-wrap').querySelector('.list-inline-title');
      const newVal = input.value.trim();
      if (newVal && newVal !== span.textContent) {
        try {
          await updateTask(input.dataset.id, { title: newVal }, { action: `Zmieniono nazwę na "${newVal}"` });
        } catch(err) { showToast('Nie udało się zmienić nazwy', 'error'); }
      }
      input.classList.add('hidden');
      span.classList.remove('hidden');
    };
    input.addEventListener('blur', saveTitle);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') input.blur();
      if (e.key === 'Escape') { input.value = input.dataset.originalValue || ''; input.blur(); }
    });
    input.addEventListener('click', e => e.stopPropagation());
  });

  // ---- Inline: due date click ----
  container.querySelectorAll('.list-due-cell').forEach(cell => {
    cell.addEventListener('click', (e) => {
      e.stopPropagation();
      const display = cell.querySelector('.list-due-display');
      const input = cell.querySelector('.list-due-input');
      display.classList.add('hidden');
      input.classList.remove('hidden');
      input.focus();
      input.showPicker?.();
    });
    const input = cell.querySelector('.list-due-input');
    if (!input) return;
    const saveDate = async () => {
      const display = cell.querySelector('.list-due-display');
      const newVal = input.value;
      try {
        await updateTask(input.dataset.id, { dueDate: newVal || null }, { action: newVal ? `Ustawiono termin: ${newVal}` : 'Usunięto termin' });
      } catch(err) { showToast('Nie udało się zmienić terminu', 'error'); }
      input.classList.add('hidden');
      display.classList.remove('hidden');
    };
    input.addEventListener('blur', saveDate);
    input.addEventListener('change', () => input.blur());
    input.addEventListener('click', e => e.stopPropagation());
  });

  // ---- Inline: priority dropdown ----
  container.querySelectorAll('.list-priority-cell').forEach(cell => {
    const btn = cell.querySelector('.list-pill-btn');
    const dropdown = cell.querySelector('.list-priority-dropdown');
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      // Close others
      container.querySelectorAll('.list-priority-dropdown').forEach(d => { if (d !== dropdown) d.classList.add('hidden'); });
      container.querySelectorAll('.list-assignee-dropdown').forEach(d => d.classList.add('hidden'));
      dropdown.classList.toggle('hidden');
    });
    dropdown.querySelectorAll('.list-priority-option').forEach(opt => {
      opt.addEventListener('click', async (e) => {
        e.stopPropagation();
        const newPr = opt.dataset.val;
        dropdown.classList.add('hidden');
        try {
          await updateTask(opt.dataset.id, { priority: newPr }, { action: `Zmieniono priorytet na "${newPr}"` });
        } catch(err) { showToast('Nie udało się zmienić priorytetu', 'error'); }
      });
    });
  });

  // ---- Inline: assignee avatar click -> dropdown ----
  container.querySelectorAll('.list-assignee-cell').forEach(cell => {
    cell.addEventListener('click', (e) => {
      e.stopPropagation();
      // Close other dropdowns
      container.querySelectorAll('.list-priority-dropdown').forEach(d => d.classList.add('hidden'));
      container.querySelectorAll('.list-assignee-dropdown').forEach(d => { if (!cell.contains(d)) d.classList.add('hidden'); });

      let dropdown = cell.querySelector('.list-assignee-dropdown');
      if (!dropdown) {
        // Build dropdown from project members
        const proj = projects[projectId];
        const members = proj?.members || [];
        dropdown = document.createElement('div');
        dropdown.className = 'list-assignee-dropdown';
        dropdown.innerHTML = `
          <div class="list-assignee-option" data-uid="" data-name="">
            <div class="list-avatar list-avatar-empty" style="width:22px;height:22px;">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="10" height="10"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/></svg>
            </div>
            <span>— Nieprzypisany —</span>
          </div>
          ${members.map(m => {
            const avatarColors = ['#6B7C5C','#4A90D9','#E67E22','#9B59B6','#1ABC9C','#E74C3C','#F39C12','#2ECC71'];
            let h = 0;
            for (let i = 0; i < (m.name||'').length; i++) h = (m.name||'').charCodeAt(i) + ((h << 5) - h);
            const color = avatarColors[Math.abs(h) % avatarColors.length];
            return `<div class="list-assignee-option" data-uid="${m.uid}" data-name="${m.name}">
              <div class="list-avatar" style="background:${color};width:22px;height:22px;">${getInitials(m.name)}</div>
              <span>${m.name}</span>
            </div>`;
          }).join('')}
        `;
        cell.appendChild(dropdown);
        dropdown.querySelectorAll('.list-assignee-option').forEach(opt => {
          opt.addEventListener('click', async (e) => {
            e.stopPropagation();
            const uid = opt.dataset.uid;
            const name = opt.dataset.name;
            dropdown.classList.add('hidden');
            try {
              await updateTask(cell.dataset.id, { assigneeId: uid || null, assigneeName: name || null }, { action: uid ? `Przypisano do "${name}"` : 'Usunięto przypisanie' });
            } catch(err) { showToast('Nie udało się zmienić osoby', 'error'); }
          });
        });
      }
      dropdown.classList.toggle('hidden');
    });
  });

  // Close dropdowns on outside click
  document.addEventListener('click', function closeInlineDropdowns() {
    container.querySelectorAll('.list-priority-dropdown, .list-assignee-dropdown').forEach(d => d.classList.add('hidden'));
  }, { once: true });
  // ── Settings dropdown (floating, outside table to avoid overflow clipping) ──
  const settingsBtn = $('list-col-settings-btn');
  if (settingsBtn) {
    // Build floating dropdown and append to body
    let visDropdown = document.getElementById('col-vis-dropdown-float');
    if (visDropdown) visDropdown.remove();
    const allColsNow = getListColumns(projectId);
    const menuHtml = allColsNow
      .filter(c => c.id !== 'checkbox')
      .map(c => `<label class="col-vis-item"><input type="checkbox" data-vis-col="${c.id}" ${c.visible ? 'checked' : ''}> ${c.label}</label>`)
      .join('');
    visDropdown = document.createElement('div');
    visDropdown.id = 'col-vis-dropdown-float';
    visDropdown.className = 'col-vis-dropdown hidden';
    visDropdown.style.cssText = 'position:fixed;z-index:9999;min-width:190px;';
    visDropdown.innerHTML = `<div class="col-vis-title">Widoczne kolumny</div>${menuHtml}`;
    document.body.appendChild(visDropdown);

    settingsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!visDropdown.classList.contains('hidden')) {
        visDropdown.classList.add('hidden');
        return;
      }
      // Position below the button
      const rect = settingsBtn.getBoundingClientRect();
      visDropdown.style.right = (window.innerWidth - rect.right) + 'px';
      visDropdown.style.top = (rect.bottom + 6) + 'px';
      visDropdown.style.left = 'auto';
      visDropdown.classList.remove('hidden');
    });

    visDropdown.querySelectorAll('input[data-vis-col]').forEach(cb => {
      cb.addEventListener('change', () => {
        const cols = getListColumns(projectId);
        const col = cols.find(c => c.id === cb.dataset.visCol);
        if (col) col.visible = cb.checked;
        saveListColumnConfig(cols, projectId);
        renderProjectList(projectId);
      });
    });

    document.addEventListener('click', function hideVis(e) {
      if (!e.target.closest('#col-vis-dropdown-float') && e.target !== settingsBtn && !settingsBtn.contains(e.target)) {
        visDropdown.classList.add('hidden');
        document.removeEventListener('click', hideVis);
      }
    });
  }

  // ── Column resize handles ──
  container.querySelectorAll('.th-resize-handle').forEach(handle => {
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const colId = handle.dataset.resizeCol;
      const th = handle.closest('th');
      const startX = e.clientX;
      const startW = th.offsetWidth;

      const onMove = (ev) => {
        const newW = Math.max(50, startW + ev.clientX - startX);
        // Update colgroup col width in real-time
        const colgroup = container.querySelector('#list-colgroup');
        if (colgroup) {
          const cols = getListColumns(projectId);
          const visIdx = cols.filter(c => c.visible).findIndex(c => c.id === colId);
          if (visIdx >= 0 && colgroup.children[visIdx]) {
            colgroup.children[visIdx].style.width = newW + 'px';
            colgroup.children[visIdx].style.minWidth = Math.min(newW, 60) + 'px';
          }
        }
      };

      const onUp = (ev) => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        const newW = Math.max(50, startW + ev.clientX - startX);
        const cols = getListColumns(projectId);
        const col = cols.find(c => c.id === colId);
        if (col) col.width = newW;
        saveListColumnConfig(cols, projectId);
      };

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  });



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
      const cols = getListColumns(projectId);
      const fromIdx = cols.findIndex(c => c.id === dragColId);
      const toIdx   = cols.findIndex(c => c.id === targetColId);
      if (fromIdx === -1 || toIdx === -1) return;
      const [moved] = cols.splice(fromIdx, 1);
      cols.splice(toIdx, 0, moved);
      saveListColumnConfig(cols, projectId);
      renderProjectList(projectId);
    });
  });
}

function projectListRow(t, col, sectionColId, listCols) {
  const doneTask = isTaskDone(t);
  const overdue  = isOverdue(t.dueDate) && !doneTask;
  const pr       = t.priority || 'medium';
  const prLabel  = getPriorityLabel(pr).replace(/^.. /, '');

  // Avatar color based on name hash
  const avatarColors = ['#6B7C5C','#4A90D9','#E67E22','#9B59B6','#1ABC9C','#E74C3C','#F39C12','#2ECC71'];
  function nameToColor(name) {
    if (!name) return '#6B7C5C';
    let h = 0;
    for (let i = 0; i < name.length; i++) h = name.charCodeAt(i) + ((h << 5) - h);
    return avatarColors[Math.abs(h) % avatarColors.length];
  }

  const cells = (listCols || getListColumns(currentProjectId).filter(c => c.visible)).map(c => {
    switch(c.id) {
      case 'checkbox':
        return `<td style="text-align:center;padding:0;width:52px;min-width:52px;">
          <div style="display:flex;align-items:center;justify-content:center;gap:2px;height:100%;padding:0 2px;">
            <span class="list-drag-handle" title="Przeciągnij aby przenieść">⠿</span>
            <input class="list-checkbox" type="checkbox" data-id="${t.id}" ${doneTask ? 'checked' : ''} />
          </div>
        </td>`;
      case 'desc':
        return `<td style="font-size:.73rem;color:var(--text-muted);overflow:hidden;white-space:nowrap;text-overflow:ellipsis;max-width:0;">${t.desc ? t.desc.slice(0, 120) : '—'}</td>`;
      case 'title':
        return `<td>
          <div class="list-title-wrap">
            <span class="list-title list-inline-title" data-id="${t.id}" title="Kliknij dwukrotnie, aby edytować">${t.title || '(bez tytułu)'}</span>
            <input class="list-title-input hidden" data-id="${t.id}" value="${(t.title || '').replace(/"/g,'&quot;')}" />
          </div>
        </td>`;
      case 'assignee': {
        const initials = t.assigneeName ? getInitials(t.assigneeName) : null;
        const color = nameToColor(t.assigneeName);
        return `<td>
          <div class="list-assignee-cell" data-id="${t.id}" title="${t.assigneeName || 'Przypisz osobę'}">
            ${initials
              ? `<div class="list-avatar" style="background:${color};">${initials}</div><span class="list-assignee-name">${t.assigneeName}</span>`
              : `<div class="list-avatar list-avatar-empty" title="Przypisz osobę">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="12" height="12"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/></svg>
                </div>`
            }
          </div>
        </td>`;
      }
      case 'status':
        return `<td style="font-size:.75rem;color:var(--text-muted);">${col?.name || '—'}</td>`;
      case 'due': {
        const dateVal = t.dueDate || '';
        const dateDisplay = t.dueDate ? formatDate(t.dueDate) : '—';
        return `<td>
          <div class="list-due-cell ${overdue ? 'overdue' : ''}" data-id="${t.id}">
            <span class="list-due-display">${dateDisplay}</span>
            <input class="list-due-input hidden" type="date" data-id="${t.id}" value="${dateVal}" />
          </div>
        </td>`;
      }
      case 'priority': {
        const prOptions = [
          { val: 'high',   label: 'Wysoki',  cls: 'high' },
          { val: 'medium', label: 'Średni',  cls: 'medium' },
          { val: 'low',    label: 'Niski',   cls: 'low' },
        ];
        return `<td>
          <div class="list-priority-cell" data-id="${t.id}">
            <span class="list-pill ${pr} list-pill-btn">${prLabel}</span>
            <div class="list-priority-dropdown hidden">
              ${prOptions.map(o => `<div class="list-priority-option ${o.val === pr ? 'active' : ''}" data-val="${o.val}" data-id="${t.id}"><span class="list-pill ${o.cls}">${o.label}</span></div>`).join('')}
            </div>
          </div>
        </td>`;
      }
      case 'created': {
        const cd = t.createdAt ? (t.createdAt.toDate ? t.createdAt.toDate() : new Date(t.createdAt)) : null;
        return `<td style="font-size:.73rem;color:var(--text-muted);">${cd ? cd.toLocaleDateString('pl-PL', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'}</td>`;
      }
      default:
        return `<td></td>`;
    }
  }).join('');

  return `<tr class="list-row ${doneTask ? 'done' : ''}" data-id="${t.id}" data-section-col="${sectionColId || ''}" draggable="true">${cells}<td style="width:36px;min-width:36px;"></td></tr>`;
}


// ============================================================
// PROJECT CALENDAR
// ============================================================
function renderProjectCalendar(projectId) {
  const proj = projects[projectId];
  if (!proj) return;
  const y = projCalDate.getFullYear(), m = projCalDate.getMonth();
  $('proj-cal-title').textContent = projCalDate.toLocaleDateString('pl-PL', { month: 'long', year: 'numeric' });
  const projTasks = getFilteredTasks(projectId);
  renderCalendarGrid('project-calendar-grid', y, m, projTasks, true);
}

// ============================================================
// OŚ CZASU (GANTT)
// ============================================================
// ── GANTT zoom state ─────────────────────────────────────────────────────
let ganttZoom = 'week'; // 'week' | 'month' | 'quarter'
const GANTT_DAY_W = { week: 40, month: 24, quarter: 14 };
const GANTT_ROW_H = 40;
const GANTT_SEC_H = 36;
const GANTT_HDR_H = 56; // month row + day row
const GANTT_LEFT_W = 220;
const PRIO_COLORS = { high:'#EF4444', medium:'#F59E0B', low:'#10B981' };
const PRIO_LABELS = { high:'Wysoki', medium:'Średni', low:'Niski', normal:'Normalny' };

function renderGantt(projectId) {
  if (!projectId) return;
  const proj = projects[projectId];
  const allTasks = Object.values(tasks[projectId] || {});

  // ── Populate filters ──────────────────────────────────────────────────
  const statusSel = $('gantt-filter-status');
  const assigneeSel = $('gantt-filter-assignee');
  if (statusSel.options.length <= 1) {
    (proj.columns || []).forEach(c => {
      const o = document.createElement('option');
      o.value = c.id; o.textContent = c.name;
      statusSel.appendChild(o);
    });
  }
  const members = [...new Set(allTasks.flatMap(t => t.assignees || []))];
  if (assigneeSel.options.length <= 1) {
    members.forEach(m => {
      const o = document.createElement('option');
      o.value = m; o.textContent = m;
      assigneeSel.appendChild(o);
    });
  }

  // ── Apply filters ─────────────────────────────────────────────────────
  const fStatus   = statusSel.value;
  const fPriority = $('gantt-filter-priority').value;
  const fAssignee = assigneeSel.value;

  let projTasks = allTasks.filter(t => t.dueDate);
  if (fStatus   !== 'all') projTasks = projTasks.filter(t => t.columnId === fStatus);
  if (fPriority !== 'all') projTasks = projTasks.filter(t => t.priority === fPriority);
  if (fAssignee !== 'all') projTasks = projTasks.filter(t => (t.assignees||[]).includes(fAssignee));

  const ganttMain  = $('gantt-main');
  const ganttEmpty = $('gantt-empty');

  if (!projTasks.length) {
    ganttMain.classList.add('hidden');
    ganttEmpty.classList.remove('hidden');
    return;
  }
  ganttMain.classList.remove('hidden');
  ganttEmpty.classList.add('hidden');

  // ── Date range ────────────────────────────────────────────────────────
  const today = new Date(); today.setHours(0,0,0,0);
  projTasks.sort((a,b) => new Date(a.dueDate) - new Date(b.dueDate));
  let rangeStart = new Date(Math.min(today.getTime(), new Date(projTasks[0].dueDate).getTime()));
  let rangeEnd   = new Date(projTasks[projTasks.length-1].dueDate);
  // Snap start to Monday
  const dow = rangeStart.getDay();
  rangeStart.setDate(rangeStart.getDate() - (dow === 0 ? 6 : dow - 1) - 7);
  rangeEnd.setDate(rangeEnd.getDate() + 21);
  const totalDays = Math.ceil((rangeEnd - rangeStart) / 86400000);
  const DAY_W = GANTT_DAY_W[ganttZoom];

  // ── Group tasks by column ─────────────────────────────────────────────
  const projCols = [...(proj.columns||[])].sort((a,b)=>(a.order||0)-(b.order||0));
  const colMap = {}; projCols.forEach(c => { colMap[c.id] = c; });
  const sections = {};
  projCols.forEach(c => { sections[c.id] = { name: c.name, tasks: [] }; });
  projTasks.forEach(t => {
    if (sections[t.columnId]) sections[t.columnId].tasks.push(t);
    else {
      if (!sections['__other']) sections['__other'] = { name: 'Pozostałe', tasks: [] };
      sections['__other'].tasks.push(t);
    }
  });
  const activeSections = Object.values(sections).filter(s => s.tasks.length);

  // ── Build header (month + day rows) ───────────────────────────────────
  const totalW = totalDays * DAY_W;
  let monthCells = '';
  {
    let cur = new Date(rangeStart);
    while (cur < rangeEnd) {
      const nextMonth = new Date(cur.getFullYear(), cur.getMonth()+1, 1);
      const end = nextMonth < rangeEnd ? nextMonth : rangeEnd;
      const days = Math.ceil((end - cur) / 86400000);
      monthCells += `<div class="gt2-month-cell" style="width:${days*DAY_W}px">${cur.toLocaleDateString('pl-PL',{month:'long',year:'numeric'})}</div>`;
      cur = nextMonth;
    }
  }
  let dayCells = '';
  for (let i = 0; i < totalDays; i++) {
    const d = new Date(rangeStart.getTime() + i*86400000);
    const isWeekend = d.getDay()===0 || d.getDay()===6;
    const isToday   = d.getTime() === today.getTime();
    const dayNum    = d.getDate();
    const dayName   = d.toLocaleDateString('pl-PL',{weekday:'short'}).slice(0,2);
    const cls = [isWeekend?'weekend':'', isToday?'today-hdr':''].filter(Boolean).join(' ');
    if (ganttZoom === 'week') {
      dayCells += `<div class="gt2-day-cell ${cls}" style="width:${DAY_W}px;height:28px;"><span>${dayNum}</span><span style="font-size:.55rem;opacity:.7">${dayName}</span></div>`;
    } else if (ganttZoom === 'month') {
      // Show number only on Mondays or 1st
      const show = d.getDay()===1 || dayNum===1;
      dayCells += `<div class="gt2-day-cell ${cls}" style="width:${DAY_W}px;height:28px;">${show?dayNum:''}</div>`;
    } else {
      // quarter — show week number on Mondays
      const show = d.getDay()===1 || dayNum===1;
      dayCells += `<div class="gt2-day-cell ${cls}" style="width:${DAY_W}px;height:28px;">${show&&dayNum===1?dayNum:''}</div>`;
    }
  }

  // ── Build left labels ─────────────────────────────────────────────────
  let leftRows = '';
  activeSections.forEach(sec => {
    leftRows += `<div class="gt2-section-lbl">${escHtml(sec.name)}</div>`;
    sec.tasks.forEach(t => {
      const prioColor = PRIO_COLORS[t.priority] || 'var(--text-light)';
      const done = t.status === 'done' || isTaskDone(t);
      leftRows += `<div class="gt2-task-lbl" data-tid="${t.id}" title="${escHtml(t.title)}">
        <span class="gt2-prio-dot" style="background:${prioColor}"></span>
        ${done ? '<span class="gt2-done-check"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="11" height="11"><polyline points="20 6 9 17 4 12"/></svg></span>' : ''}
        <span style="${done?'text-decoration:line-through;opacity:.6':''}">${escHtml(t.title)}</span>
      </div>`;
    });
  });

  // ── Build grid rows + bars ────────────────────────────────────────────
  const todayOffset = Math.floor((today - rangeStart)/86400000);
  let gridRows = '';
  let barRows  = '';

  // Weekend shading columns
  let weekendShades = '';
  for (let i=0;i<totalDays;i++) {
    const d = new Date(rangeStart.getTime()+i*86400000);
    if (d.getDay()===0||d.getDay()===6) weekendShades += `<div class="gt2-col-shade" style="left:${i*DAY_W}px;width:${DAY_W}px"></div>`;
  }

  activeSections.forEach(sec => {
    gridRows += `<div class="gt2-section-grid" style="width:${totalW}px"></div>`;
    barRows  += `<div class="gt2-section-grid" style="width:${totalW}px"></div>`;
    sec.tasks.forEach(t => {
      const due = new Date(t.dueDate); due.setHours(0,0,0,0);
      const start = t.startDate ? new Date(t.startDate) : null;
      if (start) start.setHours(0,0,0,0);
      const done = t.status==='done' || isTaskDone(t);
      const over = !done && isOverdue(t.dueDate);
      const color = over ? '#EF4444' : (PRIO_COLORS[t.priority]||'var(--accent)');

      let barLeft, barW;
      if (start && start < due) {
        barLeft = Math.max(0, Math.floor((start - rangeStart)/86400000)) * DAY_W;
        const barEnd = Math.ceil((due - rangeStart)/86400000) + 1;
        barW = Math.max(DAY_W, (barEnd - Math.max(0,Math.floor((start-rangeStart)/86400000))) * DAY_W);
      } else {
        // milestone — diamond
        const mOffset = Math.floor((due - rangeStart)/86400000);
        barLeft = mOffset * DAY_W + DAY_W/2 - 7;
        barW = 14;
      }

      gridRows += `<div class="gt2-task-row" style="width:${totalW}px"></div>`;
      barRows  += `<div class="gt2-task-row" style="width:${totalW}px">
        <div class="gt2-bar${done?' done':''}" style="left:${barLeft}px;width:${barW}px;background:${color}" data-tid="${t.id}" title="${escHtml(t.title)} — ${t.dueDate}">
          <span class="gt2-bar-lbl">${barW > 40 ? escHtml(t.title) : ''}</span>
        </div>
      </div>`;
    });
  });

  // ── Inject HTML ───────────────────────────────────────────────────────
  const hdrHeight = 56; // month(28) + day(28)
  $('gantt-corner').style.height = hdrHeight + 'px';

  $('gantt-timeline-header').innerHTML = `
    <div class="gt2-header-inner" style="width:${totalW}px">
      <div class="gt2-month-row">${monthCells}</div>
      <div class="gt2-day-row">${dayCells}</div>
    </div>`;

  $('gantt-left-rows').innerHTML = leftRows;

  $('gantt-timeline-body').innerHTML = `
    <div class="gt2-grid-wrap" style="width:${totalW}px;position:relative;">
      ${weekendShades}
      ${today >= rangeStart && today < rangeEnd ? `<div class="gt2-today-line" style="left:${todayOffset*DAY_W + DAY_W/2}px"></div>` : ''}
      ${barRows}
    </div>`;

  // ── Sync scroll ───────────────────────────────────────────────────────
  const bodyEl  = $('gantt-timeline-body');
  const hdrEl   = $('gantt-timeline-header');
  const leftEl  = $('gantt-left-rows');
  bodyEl.onscroll = () => {
    hdrEl.scrollLeft = bodyEl.scrollLeft;
    leftEl.scrollTop = bodyEl.scrollTop;
  };

  // ── Click on bar/label → open task ───────────────────────────────────
  $('gantt-timeline-body').querySelectorAll('[data-tid]').forEach(el => {
    el.addEventListener('click', () => openTask(el.dataset.tid, projectId));
  });
  $('gantt-left-rows').querySelectorAll('[data-tid]').forEach(el => {
    el.addEventListener('click', () => openTask(el.dataset.tid, projectId));
  });

  // ── Scroll to today ───────────────────────────────────────────────────
  const scrollToToday = () => {
    const todayPx = Math.max(0, todayOffset * DAY_W - bodyEl.clientWidth/2);
    bodyEl.scrollLeft = todayPx;
  };
  $('gantt-today-btn').onclick = scrollToToday;
  // Auto-scroll to today on first render
  setTimeout(scrollToToday, 50);
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
  const overdue = allTasks.filter(t => !isTaskDone(t) && isOverdue(t.dueDate)).length;
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
        <button class="btn-danger small" id="delete-note-btn">Usuń</button>
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
// INBOX
// ============================================================
function subscribeToInbox() {
  if (!currentUser) return;
  if (inboxUnsubscribe) { inboxUnsubscribe(); inboxUnsubscribe = null; }

  const q = query(
    collection(db, 'inbox'),
    where('toUid', '==', currentUser.uid)
  );

  inboxUnsubscribe = onSnapshot(q, snap => {
    const hiddenIds = new Set(JSON.parse(localStorage.getItem('inbox_hidden') || '[]'));
    inboxItems = {};
    snap.forEach(d => {
      if (!hiddenIds.has(d.id)) inboxItems[d.id] = { id: d.id, ...d.data() };
    });
    updateInboxBadge();
    if (document.querySelector('#view-inbox:not(.hidden)')) renderInbox();
  });
}

function updateInboxBadge() {
  const unread = Object.values(inboxItems).filter(i => !i.read).length;
  const badge = document.getElementById('inbox-badge');
  const countBadge = document.getElementById('inbox-count-badge');
  const tabBadge = document.getElementById('inbox-tab-badge');

  if (badge) {
    badge.textContent = unread;
    badge.classList.toggle('hidden', unread === 0);
  }
  if (countBadge) {
    countBadge.textContent = unread;
    countBadge.classList.toggle('hidden', unread === 0);
  }
  if (tabBadge) {
    tabBadge.classList.toggle('hidden', unread === 0);
  }
}

async function markInboxItemRead(docId) {
  try {
    await updateDoc(doc(db, 'inbox', docId), { read: true });
  } catch(e) {}
}

async function markAllInboxRead() {
  const unread = Object.values(inboxItems).filter(i => !i.read);
  await Promise.all(unread.map(i => updateDoc(doc(db, 'inbox', i.id), { read: true })));
  showToast('Wszystkie przeczytane', 'success');
}

async function sendInboxNotifications(taskId, taskTitle, projectId, commentText) {
  const proj = projects[projectId];
  if (!proj || !proj.members) return;

  // Find all @Mentioned members in comment text
  const mentionedUids = [];
  for (const member of proj.members) {
    if (member.uid === currentUser.uid) continue; // don't notify yourself
    // Check if member name appears as @mention (full name or first name)
    const firstName = member.name.split(' ')[0];
    if (
      commentText.includes('@' + member.name) ||
      commentText.includes('@' + firstName)
    ) {
      mentionedUids.push(member.uid);
    }
  }

  if (!mentionedUids.length) return;

  const projName = proj.name || '';
  await Promise.all(mentionedUids.map(uid =>
    addDoc(collection(db, 'inbox'), {
      toUid: uid,
      fromUid: currentUser.uid,
      fromName: currentUser.displayName || 'Użytkownik',
      taskId,
      taskTitle,
      projectId,
      projectName: projName,
      commentText,
      read: false,
      createdAt: serverTimestamp()
    })
  ));
}

function renderInbox() {
  const list = document.getElementById('inbox-list');
  if (!list) return;

  // Mark all visible as read when opening
  // Wyklucz lokalnie ukryte wiadomości
  const hidden = new Set(JSON.parse(localStorage.getItem('inbox_hidden') || '[]'));
  const items = Object.values(inboxItems).filter(i => !hidden.has(i.id)).sort((a, b) => {
    const ta = a.createdAt?.seconds || 0;
    const tb = b.createdAt?.seconds || 0;
    return tb - ta;
  });

  if (!items.length) {
    list.innerHTML = `<div class="empty-state">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="48" height="48"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>
      <p>Skrzynka jest pusta</p>
    </div>`;
    return;
  }

  list.innerHTML = items.map(item => {
    const time = item.createdAt ? formatDateTime(item.createdAt) : '';
    const proj = projects[item.projectId];
    const projColor = proj?.color || '#6B7C5C';
    const mentionHighlight = (item.commentText || '').replace(
      /@(\S+)/g,
      '<span class="comment-mention">@$1</span>'
    );
    const toggleBtn = item.read
      ? `<button class="inbox-toggle-read-btn" data-id="${item.id}" data-action="unread" title="Oznacz jako nieprzeczytane">
           <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>
           Nieprzeczytane
         </button>`
      : `<button class="inbox-toggle-read-btn read" data-id="${item.id}" data-action="read" title="Oznacz jako przeczytane">
           <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><polyline points="20 6 9 17 4 12"/></svg>
           Przeczytane
         </button>`;
    return `
      <div class="inbox-item ${item.read ? '' : 'unread'}" data-id="${item.id}" data-task-id="${item.taskId}" data-project-id="${item.projectId}">
        <div class="inbox-item-body">
          <div class="inbox-item-header">
            <span class="inbox-item-author">${item.fromName}</span>
            <span class="inbox-item-meta">wspomniał(a) Cię w zadaniu <strong>${item.taskTitle || 'zadanie'}</strong></span>
            <span class="inbox-item-time">${time}</span>
          </div>
          <div class="inbox-item-project">
            <span class="inbox-proj-dot" style="background:${projColor}"></span>
            ${item.projectName || ''}
          </div>
          <div class="inbox-item-comment">${mentionHighlight}</div>
          <div class="inbox-item-actions">
            ${toggleBtn}
            <button class="inbox-delete-btn" data-id="${item.id}" title="Usuń wiadomość">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>
              Usuń
            </button>
          </div>
        </div>
        ${!item.read ? '<div class="inbox-unread-dot"></div>' : ''}
      </div>`;
  }).join('');

  // Toggle read/unread buttons
  list.querySelectorAll('.inbox-toggle-read-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const docId = btn.dataset.id;
      const action = btn.dataset.action;
      try {
        await updateDoc(doc(db, 'inbox', docId), { read: action === 'read' });
      } catch(err) {}
    });
  });

  // Delete buttons
  list.querySelectorAll('.inbox-delete-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const docId = btn.dataset.id;
      // Usuń z lokalnego cache natychmiast
      delete inboxItems[docId];
      // Zapisz w localStorage żeby nie wróciła po przeładowaniu
      try {
        const hidden = JSON.parse(localStorage.getItem('inbox_hidden') || '[]');
        if (!hidden.includes(docId)) hidden.push(docId);
        localStorage.setItem('inbox_hidden', JSON.stringify(hidden));
      } catch(e) {}
      // Odśwież UI od razu
      renderInbox();
      updateInboxBadge();
      showToast('Wiadomość usunięta', 'success');
      // Spróbuj usunąć z Firestore w tle
      try { await deleteDoc(doc(db, 'inbox', docId)); } catch(e) {}
    });
  });

  // Click item body → open task, mark read
  list.querySelectorAll('.inbox-item').forEach(el => {
    el.addEventListener('click', async (e) => {
      if (e.target.closest('.inbox-toggle-read-btn') || e.target.closest('.inbox-delete-btn')) return;
      const docId = el.dataset.id;
      const taskId = el.dataset.taskId;
      const projectId = el.dataset.projectId;

      if (inboxItems[docId] && !inboxItems[docId].read) {
        markInboxItemRead(docId);
      }

      if (taskId && projectId) {
        navigateTo('project', projectId);
        let attempts = 0;
        const tryOpen = async () => {
          const task = getTaskById(taskId);
          if (task) {
            await openTaskModal(taskId, projectId);
          } else if (attempts++ < 20) {
            setTimeout(tryOpen, 200);
          }
        };
        tryOpen();
      }
    });
  });

  // Mark all read button
  document.getElementById('inbox-mark-all-read-btn')?.addEventListener('click', markAllInboxRead);
}

// ============================================================
// PROJECT CHAT (WIADOMOŚCI)
// ============================================================
function openProjectChat(projectId) {
  // Unsubscribe from previous chat if different project
  if (chatUnsubscribe && chatProjectId !== projectId) {
    chatUnsubscribe();
    chatUnsubscribe = null;
  }
  chatProjectId = projectId;

  // Update avatar
  const name = currentUser?.displayName || 'U';
  const avatarEl = $('chat-input-avatar');
  if (avatarEl) avatarEl.textContent = getInitials(name);

  // Reset input
  const input = $('chat-message-input');
  if (input) { input.value = ''; input.style.height = 'auto'; }

  // Subscribe to messages
  if (!chatUnsubscribe) {
    subscribeToChatMessages(projectId);
  }
}

function subscribeToChatMessages(projectId) {
  const q = query(
    collection(db, 'projectMessages'),
    where('projectId', '==', projectId),
    orderBy('createdAt', 'asc')
  );

  chatUnsubscribe = onSnapshot(q, snap => {
    const msgs = [];
    snap.forEach(d => msgs.push({ id: d.id, ...d.data() }));
    renderChatMessages(msgs);
  });
}

function renderChatMessages(messages) {
  const container = $('chat-messages');
  if (!container) return;

  if (!messages.length) {
    container.innerHTML = `<div class="chat-empty">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="40" height="40"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
      <p>Brak wiadomości. Zacznij rozmowę!</p>
    </div>`;
    return;
  }

  // Group by date
  let lastDate = null;
  let html = '';
  messages.forEach(msg => {
    const isMe = msg.senderId === currentUser?.uid;
    const ts = msg.createdAt?.toDate ? msg.createdAt.toDate() : new Date();
    const dateStr = ts.toLocaleDateString('pl-PL', { weekday: 'long', day: 'numeric', month: 'long' });
    const timeStr = ts.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });

    if (dateStr !== lastDate) {
      html += `<div class="chat-date-divider"><span>${dateStr}</span></div>`;
      lastDate = dateStr;
    }

    const initials = getInitials(msg.senderName || 'U');
    html += `
      <div class="chat-message-row ${isMe ? 'me' : 'other'}">
        ${!isMe ? `<div class="chat-msg-avatar">${initials}</div>` : ''}
        <div class="chat-msg-block">
          ${!isMe ? `<div class="chat-msg-name">${msg.senderName || 'Użytkownik'}</div>` : ''}
          <div class="chat-bubble ${isMe ? 'bubble-me' : 'bubble-other'}">
            <span class="chat-bubble-text">${escapeHtml(msg.text)}</span>
            <span class="chat-bubble-time">${timeStr}</span>
          </div>
        </div>
        ${isMe ? `<div class="chat-msg-avatar me">${initials}</div>` : ''}
      </div>`;
  });

  container.innerHTML = html;

  // Scroll to bottom
  const wrap = $('chat-messages-wrap');
  if (wrap) setTimeout(() => { wrap.scrollTop = wrap.scrollHeight; }, 50);
}

function escapeHtml(str) {
  return (str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>');
}

async function sendChatMessage() {
  const input = $('chat-message-input');
  const text = input?.value.trim();
  if (!text || !chatProjectId || !currentUser) return;

  input.value = '';
  input.style.height = 'auto';

  try {
    await addDoc(collection(db, 'projectMessages'), {
      projectId: chatProjectId,
      senderId: currentUser.uid,
      senderName: currentUser.displayName || 'Użytkownik',
      text,
      createdAt: serverTimestamp()
    });
  } catch(e) {
    showToast('Nie udało się wysłać wiadomości', 'error');
    input.value = text;
  }
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
  // Always read the freshest snapshot from the projects map
  const proj = projects[projectId];
  const list = $('members-list');

  // Determine ownership: prefer ownerId field, fall back to role in members array
  // (handles older projects created before ownerId was introduced)
  const isOwner =
    proj?.ownerId === currentUser.uid ||
    (proj?.members || []).some(m => m.uid === currentUser.uid && m.role === 'owner');

  list.innerHTML = (proj?.members || []).map(m => {
    const roleLabel = m.role === 'owner' ? 'Właściciel' : 'Członek';

    // Remove button: only owner sees it, and only for other members (not self)
    const removeBtn = isOwner && m.uid !== currentUser.uid
      ? `<button class="member-remove" data-uid="${m.uid}" title="Usuń członka">Usuń</button>`
      : '';

    return `
    <div class="member-item">
      <div class="user-avatar small">${getInitials(m.name)}</div>
      <div class="member-name">${m.name}</div>
      <span class="member-role">${roleLabel}</span>
      ${removeBtn}
    </div>`;
  }).join('');

  list.querySelectorAll('.member-remove').forEach(btn => {
    btn.addEventListener('click', async () => {
      const uid = btn.dataset.uid;
      const currentProj = projects[projectId]; // fresh reference
      showConfirm('Usuń członka', 'Na pewno chcesz usunąć tego członka z projektu?', async () => {
        try {
          const updatedMembers = (currentProj?.members || []).filter(m => m.uid !== uid);
          await updateDoc(doc(db, 'projects', projectId), {
            memberIds: arrayRemove(uid),
            members: updatedMembers
          });
          showToast('Członek usunięty', 'success');
          renderMembersList(projectId);
        } catch(e) {
          console.error('removeMember error:', e);
          showToast('Nie udało się usunąć członka: ' + (e.message || e.code || e), 'error');
        }
      });
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
// PROFILE EDIT (display name + avatar)
// ============================================================
async function saveDisplayName() {
  const firstName = ($('settings-firstname-input')?.value || '').trim();
  const lastName = ($('settings-lastname-input')?.value || '').trim();
  if (!firstName) { showToast('Podaj imię', 'error'); return; }
  const newName = lastName ? firstName + ' ' + lastName : firstName;
  try {
    await updateProfile(currentUser, { displayName: newName });
    // Also update in Firestore users doc
    await updateDoc(doc(db, 'users', currentUser.uid), { name: newName, firstName, lastName });
    // Update project member entries (best-effort)
    for (const pid of Object.keys(projects)) {
      const proj = projects[pid];
      if (!proj?.members) continue;
      const idx = proj.members.findIndex(m => m.uid === currentUser.uid);
      if (idx !== -1) {
        const updatedMembers = [...proj.members];
        updatedMembers[idx] = { ...updatedMembers[idx], name: newName };
        updateDoc(doc(db, 'projects', pid), { members: updatedMembers }).catch(() => {});
      }
    }
    // Also update assigneeName on tasks assigned to this user (best-effort)
    for (const [pid, projTasks] of Object.entries(tasks)) {
      for (const [tid, task] of Object.entries(projTasks)) {
        if (task.assigneeId === currentUser.uid && task.assigneeName !== newName) {
          updateDoc(doc(db, 'tasks', tid), { assigneeName: newName }).catch(() => {});
        }
      }
    }
    updateUserUI();
    populateSettingsModal();
    showToast('Imię i nazwisko zaktualizowane!', 'success');
  } catch (e) {
    showToast('Błąd: ' + e.message, 'error');
  }
}

// ============================================================
// AVATAR CROP MODAL
// ============================================================
let _cropState = { img: null, zoom: 1, offsetX: 0, offsetY: 0, isDragging: false, startX: 0, startY: 0, startOffX: 0, startOffY: 0 };

function openAvatarCropModal(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    const dataURL = e.target.result;
    const cropImg = $('avatar-crop-img');
    const stage = $('avatar-crop-stage');
    const zoomSlider = $('avatar-crop-zoom');

    cropImg.onload = () => {
      const STAGE = 240;
      const nat = Math.min(cropImg.naturalWidth, cropImg.naturalHeight);
      const scale = STAGE / nat;
      _cropState.img = cropImg;
      _cropState.zoom = 1;
      // Center image
      const w = cropImg.naturalWidth * scale;
      const h = cropImg.naturalHeight * scale;
      _cropState.offsetX = (STAGE - w) / 2;
      _cropState.offsetY = (STAGE - h) / 2;
      _cropState._baseScale = scale;
      zoomSlider.value = 1;
      _applyAvatarCropTransform();
    };
    cropImg.src = dataURL;
    openModal('avatar-crop-modal');
  };
  reader.readAsDataURL(file);
}

function _applyAvatarCropTransform() {
  const img = $('avatar-crop-img');
  if (!img) return;
  const STAGE = 240;
  const scale = _cropState._baseScale * _cropState.zoom;
  const w = _cropState.img.naturalWidth * scale;
  const h = _cropState.img.naturalHeight * scale;
  // Clamp offsets so image fills the circle
  _cropState.offsetX = Math.min(0, Math.max(STAGE - w, _cropState.offsetX));
  _cropState.offsetY = Math.min(0, Math.max(STAGE - h, _cropState.offsetY));
  img.style.width = w + 'px';
  img.style.height = h + 'px';
  img.style.transform = `translate(${_cropState.offsetX}px, ${_cropState.offsetY}px)`;
}

function setupAvatarCropListeners() {
  const stage = $('avatar-crop-stage');
  const zoomSlider = $('avatar-crop-zoom');

  // Drag
  stage.addEventListener('mousedown', (e) => {
    _cropState.isDragging = true;
    _cropState.startX = e.clientX;
    _cropState.startY = e.clientY;
    _cropState.startOffX = _cropState.offsetX;
    _cropState.startOffY = _cropState.offsetY;
    stage.classList.add('dragging');
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!_cropState.isDragging) return;
    _cropState.offsetX = _cropState.startOffX + (e.clientX - _cropState.startX);
    _cropState.offsetY = _cropState.startOffY + (e.clientY - _cropState.startY);
    _applyAvatarCropTransform();
  });
  window.addEventListener('mouseup', () => {
    _cropState.isDragging = false;
    stage?.classList.remove('dragging');
  });
  // Touch drag
  stage.addEventListener('touchstart', (e) => {
    const t = e.touches[0];
    _cropState.isDragging = true;
    _cropState.startX = t.clientX;
    _cropState.startY = t.clientY;
    _cropState.startOffX = _cropState.offsetX;
    _cropState.startOffY = _cropState.offsetY;
    e.preventDefault();
  }, { passive: false });
  window.addEventListener('touchmove', (e) => {
    if (!_cropState.isDragging) return;
    const t = e.touches[0];
    _cropState.offsetX = _cropState.startOffX + (t.clientX - _cropState.startX);
    _cropState.offsetY = _cropState.startOffY + (t.clientY - _cropState.startY);
    _applyAvatarCropTransform();
  }, { passive: false });
  window.addEventListener('touchend', () => { _cropState.isDragging = false; });

  // Zoom slider
  zoomSlider.addEventListener('input', () => {
    const STAGE = 240;
    const prevZoom = _cropState.zoom;
    const newZoom = parseFloat(zoomSlider.value);
    // Keep center of stage anchored
    const cx = STAGE / 2;
    const cy = STAGE / 2;
    const scale = _cropState._baseScale;
    _cropState.offsetX = cx - (cx - _cropState.offsetX) * (newZoom / prevZoom);
    _cropState.offsetY = cy - (cy - _cropState.offsetY) * (newZoom / prevZoom);
    _cropState.zoom = newZoom;
    _applyAvatarCropTransform();
  });

  // Scroll to zoom
  stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -0.07 : 0.07;
    const newZoom = Math.min(3, Math.max(1, _cropState.zoom + delta));
    const STAGE = 240;
    const cx = STAGE / 2;
    const cy = STAGE / 2;
    const prevZoom = _cropState.zoom;
    _cropState.offsetX = cx - (cx - _cropState.offsetX) * (newZoom / prevZoom);
    _cropState.offsetY = cy - (cy - _cropState.offsetY) * (newZoom / prevZoom);
    _cropState.zoom = newZoom;
    zoomSlider.value = newZoom;
    _applyAvatarCropTransform();
  }, { passive: false });

  // Buttons
  $('avatar-crop-cancel')?.addEventListener('click', () => closeModal('avatar-crop-modal'));
  $('avatar-crop-close')?.addEventListener('click', () => closeModal('avatar-crop-modal'));
  $('avatar-crop-overlay')?.addEventListener('click', () => closeModal('avatar-crop-modal'));
  $('avatar-crop-save')?.addEventListener('click', saveCroppedAvatar);
}

async function saveCroppedAvatar() {
  const STAGE = 240;
  const canvas = document.createElement('canvas');
  canvas.width = STAGE;
  canvas.height = STAGE;
  const ctx = canvas.getContext('2d');
  // Draw circle clip
  ctx.beginPath();
  ctx.arc(STAGE/2, STAGE/2, STAGE/2, 0, Math.PI*2);
  ctx.closePath();
  ctx.clip();
  // Draw image with current transform
  const scale = _cropState._baseScale * _cropState.zoom;
  ctx.drawImage(_cropState.img, _cropState.offsetX, _cropState.offsetY,
    _cropState.img.naturalWidth * scale, _cropState.img.naturalHeight * scale);

  canvas.toBlob(async (blob) => {
    if (!blob) { showToast('Błąd generowania obrazu', 'error'); return; }
    closeModal('avatar-crop-modal');
    await uploadAvatarBlob(blob);
  }, 'image/jpeg', 0.92);
}

async function uploadAvatarBlob(blob) {
  if (!blob || !currentUser) return;
  const avatarEl = $('settings-user-avatar');
  if (avatarEl) avatarEl.classList.add('uploading');
  const saveBtn = $('avatar-crop-save');
  if (saveBtn) saveBtn.disabled = true;
  try {
    const storageRef = ref(storage, `avatars/${currentUser.uid}`);
    await uploadBytes(storageRef, blob, { contentType: 'image/jpeg' });
    const downloadURL = await getDownloadURL(storageRef);
    await updateProfile(currentUser, { photoURL: downloadURL });
    await updateDoc(doc(db, 'users', currentUser.uid), { photoURL: downloadURL });
    updateUserUI();
    populateSettingsModal();
    showToast('Zdjęcie profilowe zaktualizowane!', 'success');
  } catch (e) {
    // If CORS error – store as base64 in Firestore as fallback
    if (e.message?.includes('CORS') || e.code === 'storage/unknown') {
      try {
        const reader = new FileReader();
        reader.onload = async (ev) => {
          const dataURL = ev.target.result;
          await updateProfile(currentUser, { photoURL: dataURL });
          await updateDoc(doc(db, 'users', currentUser.uid), { photoURL: dataURL });
          updateUserUI();
          populateSettingsModal();
          showToast('Zdjęcie zapisane (lokalnie). Skonfiguruj CORS Firebase Storage dla pełnej obsługi.', 'success');
        };
        reader.readAsDataURL(blob);
      } catch (e2) {
        showToast('Błąd: ' + e2.message, 'error');
      }
    } else {
      showToast('Błąd przesyłania: ' + e.message, 'error');
    }
  } finally {
    if (avatarEl) avatarEl.classList.remove('uploading');
    if (saveBtn) saveBtn.disabled = false;
  }
}

async function populateSettingsModal() {
  if (!currentUser) return;
  const name = currentUser.displayName || 'Użytkownik';
  const email = currentUser.email || '';
  const photoURL = currentUser.photoURL || '';

  const nameEl = $('settings-user-name');
  const emailEl = $('settings-user-email');
  const avatarEl = $('settings-user-avatar');
  const imgEl = $('settings-avatar-img');
  const initialsEl = $('settings-avatar-initials');
  const nameInput = $('settings-displayname-input');
  const firstInput = $('settings-firstname-input');
  const lastInput = $('settings-lastname-input');

  if (nameEl) nameEl.textContent = name;
  if (emailEl) emailEl.textContent = email;
  if (nameInput) nameInput.value = name;

  // Load firstName / lastName from Firestore
  try {
    const snap = await getDoc(doc(db, 'users', currentUser.uid));
    const data = snap.data() || {};
    const firstName = data.firstName || '';
    const lastName = data.lastName || '';
    if (firstInput) firstInput.value = firstName;
    if (lastInput) lastInput.value = lastName;
    // Fallback: split displayName if no separate fields stored yet
    if (!firstName && !lastName && name && name !== 'Użytkownik') {
      const parts = name.split(' ');
      if (firstInput) firstInput.value = parts[0] || '';
      if (lastInput) lastInput.value = parts.slice(1).join(' ') || '';
    }
  } catch(e) {
    // fallback: split displayName
    const parts = name.split(' ');
    if (firstInput) firstInput.value = parts[0] || '';
    if (lastInput) lastInput.value = parts.slice(1).join(' ') || '';
  }

  if (avatarEl && imgEl && initialsEl) {
    if (photoURL) {
      imgEl.src = photoURL;
      imgEl.style.display = 'block';
      initialsEl.style.display = 'none';
    } else {
      imgEl.style.display = 'none';
      initialsEl.style.display = '';
      initialsEl.textContent = getInitials(name);
    }
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
  $('dash-new-project-btn')?.addEventListener('click', openCreateProjectModal);
  $('new-project-btn').addEventListener('click', openCreateProjectModal);
  $('show-archived-btn').addEventListener('click', toggleArchivedView);

  // Personal task (dashboard)
  function openPersonalTaskModal() {
    $('personal-task-title').value = '';
    $('personal-task-due').value = '';
    $('personal-task-priority').value = 'medium';
    openModal('add-personal-task-modal');
    setTimeout(() => $('personal-task-title')?.focus(), 80);
  }
  function closePersonalTaskModal() { closeModal('add-personal-task-modal'); }
  async function submitPersonalTask() {
    const title = $('personal-task-title')?.value?.trim();
    if (!title) { $('personal-task-title')?.focus(); return; }
    const dueDate = $('personal-task-due')?.value || null;
    const priority = $('personal-task-priority')?.value || 'medium';
    try {
      $('personal-task-ok').disabled = true;
      await createPersonalTask(title, dueDate, priority);
      closePersonalTaskModal();
      showToast('Zadanie dodane');
    } catch(err) {
      showToast('Nie udało się dodać zadania', 'error');
    } finally {
      $('personal-task-ok').disabled = false;
    }
  }
  $('dash-add-personal-task-btn')?.addEventListener('click', openPersonalTaskModal);
  $('personal-task-cancel')?.addEventListener('click', closePersonalTaskModal);
  $('add-personal-task-overlay')?.addEventListener('click', closePersonalTaskModal);
  $('personal-task-ok')?.addEventListener('click', submitPersonalTask);
  $('personal-task-title')?.addEventListener('keydown', e => { if (e.key === 'Enter') submitPersonalTask(); });

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
  const clearTaskUrl = () => { if (new URLSearchParams(location.search).get('task')) history.replaceState(null, '', location.origin + location.pathname); };
  $('close-task-modal').addEventListener('click', () => { closeModal('task-modal'); clearTaskUrl(); });
  $('task-modal-overlay').addEventListener('click', () => { closeModal('task-modal'); clearTaskUrl(); });

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

  // Copy task link
  $('copy-task-link-btn')?.addEventListener('click', () => {
    if (!currentTaskId) return;
    const url = `${location.origin}${location.pathname}?task=${currentTaskId}`;
    navigator.clipboard.writeText(url).then(() => showToast('Link skopiowany!', 'success')).catch(() => showToast('Nie udało się skopiować linku', 'error'));
  });

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
  // search now handled by applyAllFilters

  $('project-list-show-done')?.addEventListener('change', () => {
    if (currentProjectId) {
// showDone now handled by applyAllFilters
    }
  });

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
    hideAllProjectPanels();
    $('project-calendar-view').classList.remove('hidden');
    setActiveProjectTab('project-calendar-btn');
    toggleUniversalFilters(false);
    renderProjectCalendar(currentProjectId);
  });
  $('project-gantt-btn').addEventListener('click', () => {
    hideAllProjectPanels();
    $('gantt-view').classList.remove('hidden');
    setActiveProjectTab('project-gantt-btn');
    toggleUniversalFilters(false);
    // Reset gantt filter dropdowns
    ['gantt-filter-status','gantt-filter-priority','gantt-filter-assignee'].forEach(id => {
      const el = $(id);
      if (el) { el.innerHTML = el.options[0].outerHTML; el.value = 'all'; }
    });
    renderGantt(currentProjectId);
  });

  // Gantt zoom buttons
  document.querySelectorAll('.gantt-zoom-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      ganttZoom = btn.dataset.zoom;
      document.querySelectorAll('.gantt-zoom-btn').forEach(b => b.classList.toggle('active', b===btn));
      renderGantt(currentProjectId);
    });
  });

  // Gantt filters
  ['gantt-filter-status','gantt-filter-priority','gantt-filter-assignee'].forEach(id => {
    $(id)?.addEventListener('change', () => renderGantt(currentProjectId));
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
  $('project-chat-btn').addEventListener('click', () => {
    hideAllProjectPanels();
    $('project-chat-view').classList.remove('hidden');
    setActiveProjectTab('project-chat-btn');
    toggleUniversalFilters(false);
    openProjectChat(currentProjectId);
  });
  $('project-notes-btn').addEventListener('click', () => {
    hideAllProjectPanels();
    $('project-notes-view').classList.remove('hidden');
    setActiveProjectTab('project-notes-btn');
    toggleUniversalFilters(false);
    renderProjectNotes(currentProjectId);
  });
  $('proj-cal-prev').addEventListener('click', () => { projCalDate.setMonth(projCalDate.getMonth() - 1); renderProjectCalendar(currentProjectId); });
  $('proj-cal-next').addEventListener('click', () => { projCalDate.setMonth(projCalDate.getMonth() + 1); renderProjectCalendar(currentProjectId); });

  // Project filters
  // Universal filter listeners — apply to all views
  function applyAllFilters() {
    if (!currentProjectId) return;
    // Save to persistent storage
    if (!savedProjFilters[currentProjectId]) savedProjFilters[currentProjectId] = {};
    savedProjFilters[currentProjectId].priority  = $('proj-filter-priority').value;
    savedProjFilters[currentProjectId].assignee  = $('proj-filter-assignee').value;
    savedProjFilters[currentProjectId].search    = $('proj-search').value;
    savedProjFilters[currentProjectId].showDone  = $('proj-show-done').checked;
    try { localStorage.setItem('mw_proj_filters', JSON.stringify(savedProjFilters)); } catch(e) {}
    updateFilterDot?.();
    // Re-render active view
    renderKanban(currentProjectId);
    renderProjectList(currentProjectId);
    if (!$('project-calendar-view').classList.contains('hidden')) renderProjectCalendar(currentProjectId);
    if (!$('gantt-view').classList.contains('hidden')) renderGantt(currentProjectId);
  }

  $('proj-filter-priority').addEventListener('change', applyAllFilters);
  $('proj-filter-assignee').addEventListener('change', applyAllFilters);
  $('proj-search').addEventListener('input', applyAllFilters);
  $('proj-show-done').addEventListener('change', applyAllFilters);

  // ── Mobile filter bottom sheet ──────────────────────────────────────
  function updateFilterDot() {
    const hasFilters = $('proj-filter-priority').value !== 'all' ||
      $('proj-filter-assignee').value !== 'all' ||
      !$('proj-show-done').checked;
    const btn = $('proj-filter-mobile-btn');
    const dot = $('proj-filter-dot');
    if (btn) btn.classList.toggle('has-filters', hasFilters);
    if (dot) dot.classList.toggle('hidden', !hasFilters);
  }

  function openMobileFilterSheet() {
    const sheet = $('mobile-filter-sheet');
    if (!sheet) return;
    // Sync chips with current filter values
    const curPrio = $('proj-filter-priority').value;
    const curAss  = $('proj-filter-assignee').value;
    const curDone = $('proj-show-done').checked;
    sheet.querySelectorAll('#mf-priority-chips .mf-chip').forEach(c => {
      c.classList.toggle('active', c.dataset.val === curPrio);
    });
    sheet.querySelectorAll('#mf-assignee-chips .mf-chip').forEach(c => {
      c.classList.toggle('active', c.dataset.val === curAss);
    });
    const mfDone = $('mf-show-done');
    if (mfDone) mfDone.checked = curDone;
    sheet.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
  }

  function closeMobileFilterSheet() {
    $('mobile-filter-sheet')?.classList.add('hidden');
    document.body.style.overflow = '';
  }

  $('proj-filter-mobile-btn')?.addEventListener('click', openMobileFilterSheet);
  $('mobile-filter-backdrop')?.addEventListener('click', closeMobileFilterSheet);

  // Chip selection
  document.querySelectorAll('#mf-priority-chips .mf-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      chip.closest('.mobile-filter-chips').querySelectorAll('.mf-chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
    });
  });

  // Populate assignee chips when project opens
  function populateMobileAssigneeChips(projectId) {
    const proj = projects[projectId];
    if (!proj) return;
    const container = $('mf-assignee-chips');
    if (!container) return;
    const curVal = $('proj-filter-assignee').value;
    container.innerHTML = '<button class="mf-chip active" data-val="all">Wszyscy</button>';
    (proj.members || []).forEach(m => {
      const btn = document.createElement('button');
      btn.className = 'mf-chip' + (curVal === m.uid ? ' active' : '');
      btn.dataset.val = m.uid;
      btn.textContent = m.name;
      container.appendChild(btn);
    });
    container.querySelectorAll('.mf-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        chip.closest('.mobile-filter-chips').querySelectorAll('.mf-chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
      });
    });
  }

  // Apply button
  $('mobile-filter-apply')?.addEventListener('click', () => {
    const prio = document.querySelector('#mf-priority-chips .mf-chip.active')?.dataset.val || 'all';
    const ass  = document.querySelector('#mf-assignee-chips .mf-chip.active')?.dataset.val || 'all';
    const done = $('mf-show-done')?.checked ?? true;
    $('proj-filter-priority').value = prio;
    $('proj-filter-assignee').value = ass;
    $('proj-show-done').checked = done;
    $('mf-show-done').checked = done;
    closeMobileFilterSheet();
    applyAllFilters();
    updateFilterDot();
  });

  // Update dot whenever filters change
  const origApplyAllFilters = applyAllFilters;
  // Hook into applyAllFilters - updateFilterDot after each call
  document.addEventListener('filtersApplied', updateFilterDot);


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

  // Chat send
  $('chat-send-btn').addEventListener('click', sendChatMessage);
  $('chat-message-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChatMessage(); }
  });
  $('chat-message-input').addEventListener('input', function() {
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 120) + 'px';
  });

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

  // Settings modal
  $('open-settings-btn')?.addEventListener('click', () => {
    populateSettingsModal();
    openModal('settings-modal');
  });
  $('close-settings-modal')?.addEventListener('click', () => closeModal('settings-modal'));
  $('settings-modal-overlay')?.addEventListener('click', () => closeModal('settings-modal'));
  $('settings-logout-btn')?.addEventListener('click', () => {
    closeModal('settings-modal');
    logout();
  });
  $('open-change-pw-btn')?.addEventListener('click', () => {
    closeModal('settings-modal');
    $('new-password-input').value = '';
    $('confirm-password-input').value = '';
    openModal('change-password-modal');
  });
  // Save display name
  $('save-profile-btn')?.addEventListener('click', saveDisplayName);
  $('settings-firstname-input')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') saveDisplayName();
  });
  $('settings-lastname-input')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') saveDisplayName();
  });
  // Avatar click → file picker
  $('settings-user-avatar')?.addEventListener('click', () => {
    $('avatar-file-input')?.click();
  });
  $('avatar-file-input')?.addEventListener('change', e => {
    const file = e.target.files?.[0];
    if (file) openAvatarCropModal(file);
    e.target.value = '';
  });

  // Avatar crop modal
  setupAvatarCropListeners();

  // Change password
  $('close-change-pw-modal').addEventListener('click', () => closeModal('change-password-modal'));
  $('cancel-change-pw').addEventListener('click', () => closeModal('change-password-modal'));
  $('save-new-password-btn').addEventListener('click', changePassword);

  // User info click - REMOVED (no longer opens modal directly)
}

// ============================================================
// INIT
// ============================================================
// ============================================================
// iOS / MOBILE INIT
// ============================================================
function isMobile() {
  return window.innerWidth <= 768;
}

function initMobile() {
  // Enforce mobile layout — hide sidebar, show tab bar
  function applyMobileLayout() {
    if (isMobile()) {
      const sidebar = document.getElementById('sidebar');
      if (sidebar) sidebar.style.display = 'none';
      const tabBar = document.getElementById('bottom-tab-bar');
      if (tabBar) tabBar.style.display = 'flex';
    }
  }
  applyMobileLayout();
  window.addEventListener('resize', applyMobileLayout, { passive: true });

  // 1. Dynamiczny --app-height (naprawia iOS 100vh bug z paskiem URL)
  function updateAppHeight() {
    const h = (window.visualViewport ? window.visualViewport.height : window.innerHeight);
    document.documentElement.style.setProperty('--app-height', h + 'px');
  }
  updateAppHeight();
  window.addEventListener('resize', updateAppHeight, { passive: true });
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', () => {
      updateAppHeight();
      // Wykrywanie klawiatury
      const keyboardH = window.innerHeight - window.visualViewport.height;
      const kh = Math.max(0, keyboardH);
      document.documentElement.style.setProperty('--keyboard-h', kh + 'px');
      document.body.classList.toggle('keyboard-open', kh > 150);
    }, { passive: true });
    window.visualViewport.addEventListener('scroll', updateAppHeight, { passive: true });
  }

  // 2. Wykryj PWA standalone
  const isStandalone = window.navigator.standalone === true ||
    window.matchMedia('(display-mode: standalone)').matches;
  if (isStandalone) document.body.classList.add('pwa-standalone');

  // 3. iOS rubber-band scroll prevention — only on fixed overlays
  // (nie blokujemy scroll na body - to by zablokowało scrollowanie treści)

  // 4. Poprawka iOS - inputs nie mogą być mniejsze niż 16px (zoom)
  // Już obsłużone w CSS, ale upewniamy się przez meta viewport

  // 5. Aktywny status-bar kolor dla PWA
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const themeEl = document.querySelector('meta[name="theme-color"]:not([media])');
  // Media-matched theme-color metas obsługują to automatycznie
}

async function initApp() {
  initMobile();
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
      subscribeToPersonalTasks();
      subscribeToNotes();
      subscribeToInbox();
      startClock();
      await loadCollapsedSections();
      await loadListColumnConfig();
      navigateTo('dashboard');

      // Otwórz zadanie z URL ?task=ID
      const urlParams = new URLSearchParams(location.search);
      const taskIdFromUrl = urlParams.get('task');
      if (taskIdFromUrl) {
        let attempts = 0;
        const tryOpenFromUrl = async () => {
          const task = getTaskById(taskIdFromUrl);
          if (task) {
            await openTaskModal(taskIdFromUrl, task.projectId);
          } else if (attempts++ < 20) {
            setTimeout(tryOpenFromUrl, 200);
          } else {
            showToast('Nie znaleziono zadania z linku', 'error');
          }
        };
        tryOpenFromUrl();
      }
    } else {
      currentUser = null;
      showAuthScreen();
    }
  });
}

initApp();

// ============================================================
// PROJECT NOTES TAB — Meetings & Notes
// ============================================================

let currentPNotesTab = 'meetings';      // 'meetings' | 'notes'
let currentMeetingId = null;
let currentProjNoteId = null;
let projNoteSaveTimer = null;
let meetingNoteSaveTimer = null;

// --- State ---
let projectMeetings = {};   // { projectId: { meetingId: meetingObj } }
let projectPNotes = {};     // { projectId: { noteId: noteObj } }

// ---- RENDER ENTRY POINT ----
function renderProjectNotes(projectId) {
  if (!projectId) return;
  currentMeetingId = null;
  currentProjNoteId = null;

  // Sub-tab switcher
  $('pnotes-tab-meetings').addEventListener('click', () => switchPNotesTab('meetings'));
  $('pnotes-tab-notes').addEventListener('click', () => switchPNotesTab('notes'));
  $('pnotes-add-btn').addEventListener('click', () => {
    if (currentPNotesTab === 'meetings') openMeetingModal(null);
    else openProjNoteModal(null);
  });

  switchPNotesTab(currentPNotesTab);
  subscribeToProjectMeetings(projectId);
  subscribeToProjectPNotes(projectId);
}

function switchPNotesTab(tab) {
  currentPNotesTab = tab;
  $('pnotes-tab-meetings').classList.toggle('active', tab === 'meetings');
  $('pnotes-tab-notes').classList.toggle('active', tab === 'notes');
  $('pnotes-meetings-panel').classList.toggle('hidden', tab !== 'meetings');
  $('pnotes-notes-panel').classList.toggle('hidden', tab !== 'notes');
  $('pnotes-add-label').textContent = tab === 'meetings' ? 'Dodaj spotkanie' : 'Dodaj notatkę';
}

// ---- FIRESTORE SUBSCRIPTIONS ----
function subscribeToProjectMeetings(projectId) {
  const q = query(collection(db, 'projectMeetings'), where('projectId', '==', projectId), where('userId', '==', currentUser.uid));
  onSnapshot(q, snap => {
    if (!projectMeetings[projectId]) projectMeetings[projectId] = {};
    projectMeetings[projectId] = {};
    snap.forEach(d => { projectMeetings[projectId][d.id] = { id: d.id, ...d.data() }; });
    if (!$('project-notes-view').classList.contains('hidden')) renderMeetingsList(projectId);
  });
}

function subscribeToProjectPNotes(projectId) {
  const q = query(collection(db, 'projectNotes'), where('projectId', '==', projectId), where('userId', '==', currentUser.uid));
  onSnapshot(q, snap => {
    if (!projectPNotes[projectId]) projectPNotes[projectId] = {};
    projectPNotes[projectId] = {};
    snap.forEach(d => { projectPNotes[projectId][d.id] = { id: d.id, ...d.data() }; });
    if (!$('project-notes-view').classList.contains('hidden')) renderPNotesList(projectId);
  });
}

// ---- MEETINGS LIST ----
function renderMeetingsList(projectId) {
  const container = $('pnotes-meetings-list');
  if (!container) return;
  const meetings = Object.values(projectMeetings[projectId] || {});
  meetings.sort((a, b) => {
    const da = a.date || ''; const db2 = b.date || '';
    return da < db2 ? 1 : -1;
  });
  if (!meetings.length) {
    container.innerHTML = `<div class="pnotes-empty">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="40" height="40"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
      <p>Brak spotkań.<br>Dodaj pierwsze!</p></div>`;
    return;
  }
  container.innerHTML = meetings.map(m => {
    const dateStr = m.date ? formatMeetingDate(m.date, m.time) : '';
    return `<div class="pnotes-meeting-item ${currentMeetingId === m.id ? 'active' : ''}" data-id="${m.id}">
      <div class="pnotes-meeting-item-title">${escHtml(m.title || 'Bez tytułu')}</div>
      ${dateStr ? `<div class="pnotes-meeting-item-date"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg> ${dateStr}</div>` : ''}
      <div class="pnotes-meeting-item-preview" style="display:flex;align-items:center;gap:.35rem;">${escHtml((m.description || '').slice(0, 60))}
        ${(m.attachments && m.attachments.length) ? `<span class="card-attach-badge" title="${m.attachments.length} załącznik(i)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="11" height="11"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg> ${m.attachments.length}</span>` : ''}
      </div>
    </div>`;
  }).join('');
  container.querySelectorAll('.pnotes-meeting-item').forEach(el => {
    el.addEventListener('click', () => openMeetingDetail(projectId, el.dataset.id));
  });
  if (currentMeetingId && projectMeetings[projectId]?.[currentMeetingId]) {
    openMeetingDetail(projectId, currentMeetingId);
  }
}

function formatMeetingDate(date, time) {
  if (!date) return '';
  const d = new Date(date + (time ? 'T' + time : ''));
  const opts = { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' };
  let str = d.toLocaleDateString('pl-PL', opts);
  if (time) str += ', ' + time;
  return str;
}

function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ---- MEETING DETAIL ----
function openMeetingDetail(projectId, meetingId) {
  currentMeetingId = meetingId;
  const m = (projectMeetings[projectId] || {})[meetingId];
  if (!m) return;

  // Update active in list
  document.querySelectorAll('.pnotes-meeting-item').forEach(el => {
    el.classList.toggle('active', el.dataset.id === meetingId);
  });

  const detailCol = $('pnotes-meeting-detail');
  const dateStr = m.date ? formatMeetingDate(m.date, m.time) : '';
  const attachHtml = renderAttachList(m.attachments || [], meetingId, 'meeting', projectId);

  detailCol.innerHTML = `
    <div class="pnotes-meeting-detail">
      <div class="pnotes-meeting-detail-header">
        <div style="flex:1;min-width:0;">
          <div class="pnotes-meeting-detail-title">${escHtml(m.title || 'Bez tytułu')}</div>
          <div class="pnotes-meeting-meta">
            ${dateStr ? `<span class="pnotes-meta-chip date"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg> ${dateStr}</span>` : ''}
            ${m.participants ? `<span class="pnotes-meta-chip people"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg> ${escHtml(m.participants)}</span>` : ''}
          </div>
        </div>
        <div class="pnotes-detail-actions">
          <button class="btn-secondary small" id="edit-meeting-btn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg> Edytuj</button>
          <button class="btn-danger small" id="delete-meeting-btn">Usuń</button>
        </div>
      </div>
      <div class="pnotes-meeting-body">
        ${m.description ? `<div>
          <div class="pnotes-section-label">Opis / Agenda</div>
          <div class="pnotes-desc-text">${escHtml(m.description)}</div>
        </div>` : ''}

        <div>
          <div class="pnotes-section-label">Notatki ze spotkania</div>
          <div class="pnotes-meeting-notes-area">
            <div class="pnotes-note-toolbar" id="meeting-note-toolbar">
              ${noteToolbarHtml('meeting-note-body')}
            </div>
            <div class="pnotes-note-editable" id="meeting-note-body" contenteditable="true"
              data-placeholder="Dodaj notatki ze spotkania..."
              data-meetingid="${meetingId}"
            >${m.notes || ''}</div>
          </div>
        </div>

        <div class="pnotes-attachments-section">
          <div class="pnotes-section-label">Załączniki</div>
          <label class="pnotes-attach-upload-btn" id="meeting-attach-label-${meetingId}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
            Dodaj załącznik
            <input type="file" id="meeting-attach-input-${meetingId}" multiple
              accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.png,.jpg,.jpeg,.gif,.zip"
              style="display:none;"/>
          </label>
          <div class="pnotes-attach-list" id="meeting-attach-list-${meetingId}">${attachHtml}</div>
          <div id="meeting-attach-progress-${meetingId}"></div>
        </div>
      </div>
    </div>`;

  // Toolbar buttons
  bindNoteToolbar('meeting-note-toolbar', 'meeting-note-body');

  // Auto-save notes
  $('meeting-note-body').addEventListener('input', () => {
    clearTimeout(meetingNoteSaveTimer);
    meetingNoteSaveTimer = setTimeout(async () => {
      const body = $('meeting-note-body')?.innerHTML || '';
      await updateDoc(doc(db, 'projectMeetings', meetingId), { notes: body, updatedAt: serverTimestamp() });
    }, 900);
  });

  // Edit button
  $('edit-meeting-btn').addEventListener('click', () => openMeetingModal(meetingId, projectId));

  // Delete button
  $('delete-meeting-btn').addEventListener('click', () => {
    showConfirm('Usuń spotkanie', 'Spotkanie zostanie permanentnie usunięte.', async () => {
      await deleteDoc(doc(db, 'projectMeetings', meetingId));
      currentMeetingId = null;
      detailCol.innerHTML = `<div class="pnotes-detail-empty">
        <p>Wybierz spotkanie aby zobaczyć szczegóły</p></div>`;
    });
  });

  // File upload
  const attachInput = $(`meeting-attach-input-${meetingId}`);
  if (attachInput) {
    attachInput.addEventListener('change', e => uploadMeetingFiles(e.target.files, meetingId, projectId));
  }

  // Delete attachment buttons
  bindAttachDeleteBtns(meetingId, 'meeting', projectId);
}

// ---- MEETING MODAL (Add / Edit) ----
let editingMeetingId = null;
let pendingMeetingFiles = [];

function openMeetingModal(meetingId, projectId) {
  editingMeetingId = meetingId;
  pendingMeetingFiles = [];
  const m = meetingId ? (projectMeetings[currentProjectId] || {})[meetingId] : null;
  $('meeting-modal-title').textContent = meetingId ? 'Edytuj spotkanie' : 'Nowe spotkanie';
  $('meeting-title-input').value = m?.title || '';
  $('meeting-date-input').value = m?.date || '';
  $('meeting-time-input').value = m?.time || '';
  $('meeting-participants-input').value = m?.participants || '';
  $('meeting-desc-input').value = m?.description || '';
  $('meeting-file-list').innerHTML = '';
  // Show existing attachments if editing
  if (m?.attachments?.length) {
    $('meeting-file-list').innerHTML = m.attachments.map(a =>
      `<span class="file-chip"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg> ${escHtml(a.name)}</span>`
    ).join('');
  }
  openModal('meeting-modal');
}

$('meeting-file-input').addEventListener('change', function() {
  pendingMeetingFiles = Array.from(this.files);
  const list = $('meeting-file-list');
  // Keep existing chips (from edit mode) and add new
  const newChips = pendingMeetingFiles.map((f, i) =>
    `<span class="file-chip">${fileIcon(f.name)} ${escHtml(f.name)}<span class="file-chip-del" data-fi="${i}">✕</span></span>`
  ).join('');
  // Preserve existing attachment chips (from edit mode, no del button)
  const existing = list.querySelectorAll('.file-chip:not(:has(.file-chip-del))');
  list.innerHTML = Array.from(existing).map(e => e.outerHTML).join('') + newChips;
  list.querySelectorAll('.file-chip-del').forEach(el => {
    el.addEventListener('click', () => {
      pendingMeetingFiles.splice(Number(el.dataset.fi), 1);
      el.closest('.file-chip').remove();
    });
  });
});

$('save-meeting-btn').addEventListener('click', async () => {
  const title = $('meeting-title-input').value.trim();
  if (!title) { $('meeting-title-input').focus(); return; }
  const data = {
    title,
    date: $('meeting-date-input').value,
    time: $('meeting-time-input').value,
    participants: $('meeting-participants-input').value.trim(),
    description: $('meeting-desc-input').value.trim(),
    projectId: currentProjectId,
    userId: currentUser.uid,
    updatedAt: serverTimestamp()
  };
  const btn = $('save-meeting-btn');
  btn.disabled = true; btn.textContent = 'Zapisuję...';
  let meetingAttachError = false;
  try {
    let docId = editingMeetingId;
    if (!docId) {
      data.createdAt = serverTimestamp();
      data.attachments = [];
      data.notes = '';
      const ref2 = await addDoc(collection(db, 'projectMeetings'), data);
      docId = ref2.id;
    } else {
      await updateDoc(doc(db, 'projectMeetings', docId), data);
    }
    // Upload new files — osobny try/catch, żeby błąd pliku nie blokował zapisu
    if (pendingMeetingFiles.length) {
      try {
        const existing = editingMeetingId ? ((projectMeetings[currentProjectId] || {})[docId]?.attachments || []) : [];
        const uploaded = await uploadFilesToStorage(pendingMeetingFiles, `meetings/${docId}`);
        await updateDoc(doc(db, 'projectMeetings', docId), { attachments: [...existing, ...uploaded] });
      } catch(uploadErr) {
        console.warn('Błąd uploadu załącznika:', uploadErr);
        meetingAttachError = true;
      }
    }
    currentMeetingId = docId;
    closeModal('meeting-modal');
    // Odśwież listę i otwórz detal spotkania po krótkim opóźnieniu
    // (żeby onSnapshot zdążył zaktualizować cache)
    setTimeout(() => {
      renderMeetingsList(currentProjectId);
      openMeetingDetail(currentProjectId, docId);
    }, 400);
    if (meetingAttachError) {
      showToast('Spotkanie zapisano, ale nie udało się przesłać załączników.', 'warning');
    }
  } catch(err) {
    showToast('Błąd zapisu spotkania: ' + err.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = 'Zapisz spotkanie';
  }
});

$('close-meeting-modal').addEventListener('click', () => closeModal('meeting-modal'));
$('cancel-meeting-modal').addEventListener('click', () => closeModal('meeting-modal'));

// ---- PROJECT NOTES LIST ----
function renderPNotesList(projectId) {
  const container = $('pnotes-notes-list');
  if (!container) return;
  const notes2 = Object.values(projectPNotes[projectId] || {});
  notes2.sort((a, b) => {
    const ta = a.updatedAt?.toMillis?.() || 0;
    const tb = b.updatedAt?.toMillis?.() || 0;
    return tb - ta;
  });
  const catLabels = { general: 'Ogólna', decision: 'Decyzja', idea: 'Pomysł', risk: 'Ryzyko', action: 'Do zrobienia' };
  if (!notes2.length) {
    container.innerHTML = `<div class="pnotes-empty">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="40" height="40"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14,2 14,8 20,8"/></svg>
      <p>Brak notatek.<br>Dodaj pierwszą!</p></div>`;
    return;
  }
  container.innerHTML = notes2.map(n => `
    <div class="pnotes-note-item ${currentProjNoteId === n.id ? 'active' : ''}" data-id="${n.id}">
      <div class="pnotes-note-item-title">${escHtml(n.title || 'Bez tytułu')}</div>
      <span class="pnotes-note-item-cat ${n.category || 'general'}">${catLabels[n.category] || 'Ogólna'}</span>
      <div class="pnotes-note-item-date" style="display:flex;align-items:center;gap:.35rem;">${n.updatedAt ? new Date(n.updatedAt.toDate()).toLocaleDateString('pl-PL') : ''}
        ${(n.attachments && n.attachments.length) ? `<span class="card-attach-badge" title="${n.attachments.length} załącznik(i)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="11" height="11"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg> ${n.attachments.length}</span>` : ''}
      </div>
    </div>`).join('');
  container.querySelectorAll('.pnotes-note-item').forEach(el => {
    el.addEventListener('click', () => openPNoteEditor(projectId, el.dataset.id));
  });
  if (currentProjNoteId && projectPNotes[projectId]?.[currentProjNoteId]) {
    openPNoteEditor(projectId, currentProjNoteId);
  }
}

// ---- PROJECT NOTE EDITOR ----
function openPNoteEditor(projectId, noteId) {
  currentProjNoteId = noteId;
  const n = (projectPNotes[projectId] || {})[noteId];
  if (!n) return;

  document.querySelectorAll('.pnotes-note-item').forEach(el => {
    el.classList.toggle('active', el.dataset.id === noteId);
  });

  const catLabels = { general: 'Ogólna', decision: 'Decyzja', idea: 'Pomysł', risk: 'Ryzyko', action: 'Do zrobienia' };
  const attachHtml = renderAttachList(n.attachments || [], noteId, 'projnote', projectId);

  const wrap = $('pnotes-note-editor-wrap');
  wrap.innerHTML = `
    <div class="pnotes-note-full-editor">
      <div class="pnotes-note-editor-header">
        <input class="pnotes-note-title-edit" id="pnote-title-edit" value="${escHtml(n.title || '')}" placeholder="Tytuł notatki..." />
        <span class="pnotes-note-item-cat ${n.category || 'general'}" style="flex-shrink:0;">${catLabels[n.category] || 'Ogólna'}</span>
        <button class="btn-danger small" id="delete-pnote-btn">Usuń</button>
      </div>
      <div class="pnotes-note-body-wrap">
        <div class="pnotes-note-toolbar" id="pnote-toolbar">
          ${noteToolbarHtml('pnote-body')}
        </div>
        <div class="pnotes-note-editable" id="pnote-body" contenteditable="true"
          data-placeholder="Zacznij pisać notatki..."
          style="flex:1;overflow-y:auto;"
        >${n.body || ''}</div>
      </div>
      <div class="pnotes-note-footer">
        <span>Ostatnia edycja: ${n.updatedAt ? new Date(n.updatedAt.toDate()).toLocaleString('pl-PL') : 'teraz'}</span>
        <div class="pnotes-note-footer-attach">
          <label class="pnotes-attach-upload-btn" style="padding:.25rem .6rem;font-size:.7rem;">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="11" height="11"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
            Załącz plik
            <input type="file" id="pnote-attach-input-${noteId}" multiple
              accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.png,.jpg,.jpeg,.gif,.zip"
              style="display:none;"/>
          </label>
          <div id="pnote-attach-progress-${noteId}"></div>
        </div>
      </div>
      <div class="pnotes-attach-list" id="pnote-attach-list-${noteId}" style="padding:.4rem .9rem .6rem;">${attachHtml}</div>
    </div>`;

  bindNoteToolbar('pnote-toolbar', 'pnote-body');

  // Auto-save title
  $('pnote-title-edit').addEventListener('input', schedulePNoteSave);
  $('pnote-body').addEventListener('input', schedulePNoteSave);

  function schedulePNoteSave() {
    clearTimeout(projNoteSaveTimer);
    projNoteSaveTimer = setTimeout(async () => {
      const title2 = $('pnote-title-edit')?.value || '';
      const body2 = $('pnote-body')?.innerHTML || '';
      await updateDoc(doc(db, 'projectNotes', noteId), { title: title2, body: body2, updatedAt: serverTimestamp() });
    }, 800);
  }

  // Delete note
  $('delete-pnote-btn').addEventListener('click', () => {
    showConfirm('Usuń notatkę', 'Notatka zostanie permanentnie usunięta.', async () => {
      await deleteDoc(doc(db, 'projectNotes', noteId));
      currentProjNoteId = null;
      wrap.innerHTML = `<div class="pnotes-detail-empty">
        <p>Wybierz notatkę lub utwórz nową</p></div>`;
    });
  });

  // File upload
  const attachInput = $(`pnote-attach-input-${noteId}`);
  if (attachInput) {
    attachInput.addEventListener('change', e => uploadPNoteFiles(e.target.files, noteId, projectId));
  }

  bindAttachDeleteBtns(noteId, 'projnote', projectId);
}

// ---- PROJECT NOTE MODAL ----
function openProjNoteModal() {
  $('proj-note-title-input').value = '';
  $('proj-note-category-input').value = 'general';
  openModal('proj-note-modal');
}

$('save-proj-note-btn').addEventListener('click', async () => {
  const title = $('proj-note-title-input').value.trim() || 'Nowa notatka';
  const ref2 = await addDoc(collection(db, 'projectNotes'), {
    title,
    category: $('proj-note-category-input').value,
    body: '',
    attachments: [],
    projectId: currentProjectId,
    userId: currentUser.uid,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  });
  closeModal('proj-note-modal');
  currentProjNoteId = ref2.id;
  switchPNotesTab('notes');
});
$('close-proj-note-modal').addEventListener('click', () => closeModal('proj-note-modal'));
$('cancel-proj-note-modal').addEventListener('click', () => closeModal('proj-note-modal'));

// ---- NOTE TOOLBAR ----
function noteToolbarHtml(targetId) {
  return `
    <button class="pnotes-toolbar-btn" title="Pogrubienie" data-cmd="bold" data-target="${targetId}"><b>B</b></button>
    <button class="pnotes-toolbar-btn" title="Kursywa" data-cmd="italic" data-target="${targetId}"><i>I</i></button>
    <button class="pnotes-toolbar-btn" title="Podkreślenie" data-cmd="underline" data-target="${targetId}"><u>U</u></button>
    <button class="pnotes-toolbar-btn" title="Przekreślenie" data-cmd="strikeThrough" data-target="${targetId}"><s>S</s></button>
    <span class="pnotes-toolbar-sep"></span>
    <button class="pnotes-toolbar-btn" title="Lista punktowana" data-cmd="insertUnorderedList" data-target="${targetId}">•≡</button>
    <button class="pnotes-toolbar-btn" title="Lista numerowana" data-cmd="insertOrderedList" data-target="${targetId}">1≡</button>
    <button class="pnotes-toolbar-btn" title="Cytat" data-cmd="formatBlock" data-value="blockquote" data-target="${targetId}">"</button>
    <span class="pnotes-toolbar-sep"></span>
    <button class="pnotes-toolbar-btn" title="Nagłówek" data-cmd="formatBlock" data-value="h3" data-target="${targetId}"><b>H</b></button>
    <button class="pnotes-toolbar-btn" title="Normalny tekst" data-cmd="formatBlock" data-value="p" data-target="${targetId}">¶</button>
    <span class="pnotes-toolbar-sep"></span>
    <button class="pnotes-toolbar-btn" title="Cofnij" data-cmd="undo" data-target="${targetId}">↩</button>
    <button class="pnotes-toolbar-btn" title="Ponów" data-cmd="redo" data-target="${targetId}">↪</button>`;
}

function bindNoteToolbar(toolbarId, bodyId) {
  const toolbar = $(toolbarId);
  if (!toolbar) return;
  toolbar.querySelectorAll('.pnotes-toolbar-btn').forEach(btn => {
    btn.addEventListener('mousedown', e => {
      e.preventDefault();
      const cmd = btn.dataset.cmd;
      const val = btn.dataset.value || null;
      $(bodyId)?.focus();
      document.execCommand(cmd, false, val);
    });
  });
}

// ---- FILE UTILITIES ----
function fileIcon(name) {
  const ext = name.split('.').pop().toLowerCase();
  if (['pdf'].includes(ext)) return '<span class="ftype-badge ftype-pdf">PDF</span>';
  if (['doc','docx'].includes(ext)) return '<span class="ftype-badge ftype-doc">DOC</span>';
  if (['xls','xlsx'].includes(ext)) return '<span class="ftype-badge ftype-xls">XLS</span>';
  if (['ppt','pptx'].includes(ext)) return '<span class="ftype-badge ftype-ppt">PPT</span>';
  if (['png','jpg','jpeg','gif','webp'].includes(ext)) return '<span class="ftype-badge ftype-img">IMG</span>';
  if (['zip','rar'].includes(ext)) return '<span class="ftype-badge ftype-zip">ZIP</span>';
  return '<span class="ftype-badge">FILE</span>';
}

function isImageFile(name) {
  return /\.(png|jpe?g|gif|webp|svg)$/i.test(name || '');
}

function safeAttachUrl(url) {
  if (!url) return '#';
  return url.startsWith('http') ? url : `https://${url}`;
}

function renderAttachList(attachments, docId, type, projectId) {
  if (!attachments?.length) return '';
  return attachments.map((a, i) => {
    const url = safeAttachUrl(a.url);
    const isImg = isImageFile(a.name);
    return `
    <div class="pnotes-attach-item ${isImg ? 'has-preview' : ''}" data-ai="${i}">
      ${isImg ? `<div class="pnotes-attach-preview"><img src="${url}" alt="${escHtml(a.name)}" loading="lazy" onerror="this.parentElement.style.display='none'"></div>` : ''}
      <span class="pnotes-attach-icon">${fileIcon(a.name)}</span>
      <span class="pnotes-attach-name" title="${escHtml(a.name)}">${escHtml(a.name)}</span>
      <button class="pnotes-attach-preview-btn" data-url="${url}" data-name="${escHtml(a.name)}" title="Podgląd"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg></button>
      <button class="pnotes-attach-download" data-url="${url}" data-name="${escHtml(a.name)}" title="Pobierz"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg></button>
      <span class="pnotes-attach-del" data-idx="${i}" data-docid="${docId}" data-type="${type}" data-projid="${projectId}" title="Usuń"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="12" height="12"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></span>
    </div>`;
  }).join('');
}

function isPdfFile(name) {
  return /\.pdf$/i.test(name || '');
}

function isOfficeFile(name) {
  return /\.(docx?|xlsx?|pptx?|odt|ods|odp|csv|txt|rtf)$/i.test(name || '');
}

function openFilePreview(url, name) {
  const modal = document.getElementById('file-preview-modal');
  const title = document.getElementById('file-preview-title');
  const body = document.getElementById('file-preview-body');
  const dlBtn = document.getElementById('file-preview-download');

  title.textContent = name;
  dlBtn.onclick = () => downloadAttachment(url, name);

  if (isImageFile(name)) {
    // Podgląd obrazka — bezpośrednio
    body.innerHTML = `<img src="${url}" alt="${name}" />`;
  } else if (isPdfFile(name)) {
    // Podgląd PDF — natywny iframe
    body.innerHTML = `<iframe src="${url}" title="${name}"></iframe>`;
  } else if (isOfficeFile(name)) {
    // Podgląd Word/Excel/PPT — przez Google Docs Viewer
    const viewerUrl = `https://docs.google.com/viewer?url=${encodeURIComponent(url)}&embedded=true`;
    body.innerHTML = `
      <div style="width:100%;height:100%;display:flex;flex-direction:column;gap:.5rem;padding:.5rem;">
        <div style="font-size:.72rem;color:var(--text-muted);text-align:center;padding:.3rem;">
          Podgląd przez Google Docs Viewer — pierwsze ładowanie może chwilę zająć
        </div>
        <iframe src="${viewerUrl}" title="${name}" style="flex:1;border:none;border-radius:var(--radius-xs);min-height:400px;"></iframe>
      </div>`;
  } else {
    body.innerHTML = `
      <div class="file-preview-nopreview">
        <div class="fp-icon">${fileIcon(name)}</div>
        <p>Podgląd niedostępny dla tego formatu.</p>
        <button class="btn-primary" onclick="downloadAttachment('${url}','${name}')">Pobierz plik</button>
      </div>`;
  }

  modal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

function closeFilePreview() {
  document.getElementById('file-preview-modal').classList.add('hidden');
  document.getElementById('file-preview-body').innerHTML = '';
  document.body.style.overflow = '';
}

async function downloadAttachment(url, name) {
  try {
    const res = await fetch(safeAttachUrl(url));
    if (!res.ok) throw new Error('Błąd pobierania');
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  } catch(e) {
    showToast('Nie udało się pobrać pliku: ' + e.message, 'error');
  }
}

function bindAttachDeleteBtns(docId, type, projectId) {
  const listId = type === 'meeting' ? `meeting-attach-list-${docId}` : `pnote-attach-list-${docId}`;
  const listEl = $(listId);
  if (!listEl) return;
  // Przycisk podglądu
  listEl.querySelectorAll('.pnotes-attach-preview-btn').forEach(btn => {
    btn.addEventListener('click', () => openFilePreview(btn.dataset.url, btn.dataset.name));
  });
  // Przycisk pobierania
  listEl.querySelectorAll('.pnotes-attach-download').forEach(btn => {
    btn.addEventListener('click', () => downloadAttachment(btn.dataset.url, btn.dataset.name));
  });
  // Przycisk usunięcia
  listEl.querySelectorAll('.pnotes-attach-del').forEach(btn => {
    btn.addEventListener('click', async () => {
      const idx = Number(btn.dataset.idx);
      const collName = type === 'meeting' ? 'projectMeetings' : 'projectNotes';
      const docRef = doc(db, collName, docId);
      const data = type === 'meeting'
        ? (projectMeetings[projectId] || {})[docId]
        : (projectPNotes[projectId] || {})[docId];
      const attachments = [...(data?.attachments || [])];
      attachments.splice(idx, 1);
      await updateDoc(docRef, { attachments });
      btn.closest('.pnotes-attach-item').remove();
    });
  });
}

// ── Cloudflare R2 upload ─────────────────────────────────────────────────
// Ustaw po wdrożeniu Workera na Cloudflare:
const CF_WORKER_URL = 'https://mw-storage.kontakt-e0f.workers.dev';
const CF_AUTH_TOKEN = 'Marcel155';

async function uploadFilesToStorage(files, path2) {
  const results = [];
  for (const file of files) {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('path', path2);
    const res = await fetch(`${CF_WORKER_URL}/upload`, {
      method: 'POST',
      headers: { 'X-Auth-Token': CF_AUTH_TOKEN },
      body: formData,
    });
    if (!res.ok) {
      const msg = await res.text();
      throw new Error(`Błąd uploadu (${res.status}): ${msg}`);
    }
    const data = await res.json();
    // Upewniamy się że URL ma https://
    const safeUrl = data.url.startsWith('http') ? data.url : `https://${data.url}`;
    results.push({ name: data.name, url: safeUrl, size: data.size, key: data.key });
  }
  return results;
}

async function deleteFileFromStorage(key) {
  if (!key) return;
  try {
    await fetch(`${CF_WORKER_URL}/delete?key=${encodeURIComponent(key)}`, {
      method: 'DELETE',
      headers: { 'X-Auth-Token': CF_AUTH_TOKEN },
    });
  } catch (e) {
    console.warn('Błąd usuwania pliku z R2:', e);
  }
}
// ─────────────────────────────────────────────────────────────────────────

async function uploadMeetingFiles(files, meetingId, projectId) {
  const progressEl = $(`meeting-attach-progress-${meetingId}`);
  if (progressEl) progressEl.innerHTML = `<div class="pnotes-upload-progress"><div class="pnotes-spinner"></div> Przesyłam pliki...</div>`;
  try {
    const uploaded = await uploadFilesToStorage(Array.from(files), `meetings/${meetingId}`);
    const existing = (projectMeetings[projectId] || {})[meetingId]?.attachments || [];
    await updateDoc(doc(db, 'projectMeetings', meetingId), { attachments: [...existing, ...uploaded] });
    if (progressEl) progressEl.innerHTML = '';
    // Re-open to refresh attachment list
    openMeetingDetail(projectId, meetingId);
  } catch(e) {
    if (progressEl) progressEl.innerHTML = `<span style="color:#e53e3e;font-size:.72rem;">Błąd przesyłania: ${e.message}</span>`;
  }
}

async function uploadPNoteFiles(files, noteId, projectId) {
  const progressEl = $(`pnote-attach-progress-${noteId}`);
  if (progressEl) progressEl.innerHTML = `<div class="pnotes-upload-progress"><div class="pnotes-spinner"></div> Przesyłam...</div>`;
  try {
    const uploaded = await uploadFilesToStorage(Array.from(files), `projnotes/${noteId}`);
    const existing = (projectPNotes[projectId] || {})[noteId]?.attachments || [];
    await updateDoc(doc(db, 'projectNotes', noteId), { attachments: [...existing, ...uploaded] });
    if (progressEl) progressEl.innerHTML = '';
    openPNoteEditor(projectId, noteId);
  } catch(e) {
    if (progressEl) progressEl.innerHTML = `<span style="color:#e53e3e;font-size:.72rem;">Błąd przesyłania: ${e.message}</span>`;
  }
}

// ── Lightbox podglądu pliku ──────────────────────────────────────────────
document.getElementById('file-preview-close')?.addEventListener('click', closeFilePreview);
document.getElementById('file-preview-backdrop')?.addEventListener('click', closeFilePreview);
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeFilePreview();
});
