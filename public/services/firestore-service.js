/* ============================================================
 *  Items Stoppage Dashboard — Firebase Firestore backend
 *  ------------------------------------------------------------
 *  This module replaces the Google Apps Script backend.
 *  It keeps the exact payload shape that the existing UI expects
 *  (D.me / D.branches / D.times / D.menu / D.reasons ...).
 *
 *  Firestore collections
 *  ---------------------
 *  restaurants      { id, name, active, createdAt }
 *  branches         { key, name, restaurant, active, openSec, closeSec,
 *                     days[7], ver, createdBy, createdAt }
 *  menu_items       { restaurant, branch ('' = all), item, itemKey,
 *                     category, price, available, active, seq, ... }
 *  reasons          { restaurant, branch ('' = all), name, nameKey,
 *                     enabled, seq, ... }
 *  item_stoppages   { date, item, itemKey, stopSec, startSec, reason, note,
 *                     restaurant, branch, branchName, open, seq, ... }
 *  branch_times     { branch, restaurant, prepMin, delMin, by, at, seq }
 *  users            { username, usernameKey, role, branch, restaurant,
 *                     isAdmin, active, salt, hash, ver, createdAt }
 *  audit_logs       { at, by, role, action, target, details, result, ref }
 *  notifications    { at, restaurant, branch, roles, targetUser, title,
 *                     body, kind, severity, ref, readBy[] }
 *  shift_log        { at, restaurant, branch, day, open, close, stops,
 *                     closed, actor, note }
 *  error_log        { at, action, by, role, code, message, detail, stack }
 * ============================================================ */

import {
  collection, doc, getDoc, getDocs, setDoc, addDoc, updateDoc, deleteDoc,
  onSnapshot, writeBatch, arrayUnion
} from "https://www.gstatic.com/firebasejs/13.2.0/firebase-firestore.js";
import {
  signOut, onAuthStateChanged, updatePassword, sendPasswordResetEmail,
  EmailAuthProvider, reauthenticateWithCredential
} from "https://www.gstatic.com/firebasejs/13.2.0/firebase-auth.js";
import {
  ROLES as RB_ROLES, isManagerProfile, isAdminUser, profileBranches,
  canAccessBranch, visibleBranches, visibleRestaurants, notificationVisible
} from './rbac-service.js';

const COL = {
  restaurants: 'restaurants',
  branches: 'branches',
  menu: 'menu_items',
  reasons: 'reasons',
  stops: 'item_stoppages',
  times: 'branch_times',
  users: 'users',
  audit: 'audit_logs',
  notif: 'notifications',
  shift: 'shift_log',
  errors: 'error_log',
  system: 'system',
  config: 'config'
};
/* المجموعات اللي التطبيق بيقرأ منها ويشترك فيها (نظام + إعدادات مش منهم) */
const ALL_COLS = Object.keys(COL).filter(function (k) { return k !== 'system' && k !== 'config'; })
  .map(function (k) { return COL[k]; });

const TZ = 'Africa/Cairo';
const UNSPEC = 'غير محدد';

const SESSION_MS = 6 * 60 * 60 * 1000;

/* ============================================================
 *  Helpers (ported from the Apps Script implementation)
 * ============================================================ */
function pad2(n) { return (n < 10 ? '0' : '') + n; }

function norm(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ')
    .replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\u00A0]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function keyOf(s) { return norm(s).toLowerCase(); }
function same(a, b) { return keyOf(a) === keyOf(b); }
function cleanText(s, max) {
  var v = norm(s).replace(/^[=+\-@]+/, '').trim();
  return max ? v.slice(0, max) : v;
}
function isOtherReason(r) { return /اخرى|أخرى/.test(String(r || '')); }
function arDigits(s) {
  return String(s).replace(/[\u0660-\u0669]/g, function (d) {
    return String(d.charCodeAt(0) - 0x0660);
  });
}
function fmtHMS(totalSeconds) {
  var t = Math.round(Number(totalSeconds) || 0);
  if (!isFinite(t) || t < 0) t = 0;
  var h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return h + ':' + pad2(m) + ':' + pad2(s);
}
function parseSec(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number' && isFinite(v)) {
    if (v >= 0 && v < 1) return Math.round(v * 86400) % 86400;
    if (v >= 0 && v < 86400) return Math.round(v);
    return null;
  }
  var s = arDigits(norm(v));
  if (!s) return null;
  var m = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm]|[صم])?$/);
  if (!m) return null;
  var h = parseInt(m[1], 10), mi = parseInt(m[2], 10), se = parseInt(m[3] || '0', 10), ap = m[4];
  if (mi > 59 || se > 59 || h > 23) return null;
  if (ap) {
    var a = ap.toLowerCase();
    if ((a === 'pm' || a === 'م') && h < 12) h += 12;
    if ((a === 'am' || a === 'ص') && h === 12) h = 0;
  }
  return (h % 24) * 3600 + mi * 60 + se;
}
function dayNum(key) {
  var p = String(key || '').split('-');
  if (p.length !== 3) return 0;
  return Math.round(Date.UTC(+p[0], +p[1] - 1, +p[2]) / 86400000);
}
function addDaysKey(key, n) {
  var p = key.split('-');
  var t = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2] + n));
  return t.getUTCFullYear() + '-' + pad2(t.getUTCMonth() + 1) + '-' + pad2(t.getUTCDate());
}
function weekdayOf(key) {
  var p = String(key || '').split('-');
  if (p.length !== 3) return new Date().getDay();
  return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2])).getUTCDay();
}
function nowParts() {
  var fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  });
  var p = {};
  fmt.formatToParts(new Date()).forEach(function (x) {
    if (x.type !== 'literal') p[x.type] = x.value;
  });
  var key = p.year + '-' + p.month + '-' + p.day;
  var sec = (+p.hour) * 3600 + (+p.minute) * 60 + (+p.second);
  return { key: key, hms: fmtHMS(sec), sec: sec, serial: dayNum(key) };
}
function nowIso() { var n = nowParts(); return n.key + ' ' + n.hms; }
function b64enc(s) {
  return btoa(unescape(encodeURIComponent(s)));
}
function b64dec(s) {
  return decodeURIComponent(escape(atob(s)));
}
function num(v) {
  if (v === null || v === undefined || v === '') return null;
  var n = Number(v);
  return isFinite(n) ? n : null;
}
function err(msg) { var e = new Error(msg); e.business = true; return e; }

/* ترجمة أخطاء Firestore لرسالة واضحة (أهمها صلاحيات القواعد) */
function fsError(e, where) {
  var code = (e && e.code) ? String(e.code) : '';
  var msg = (e && e.message) ? String(e.message) : '';
  if (code === 'permission-denied' || /insufficient permissions/i.test(msg)) {
    return err('قواعد Firestore بتمنع ' + (where || 'العملية') +
      '. انشر القواعد المحدثة: firebase deploy --only firestore:rules' +
      ' (وخلّي المجموعة المسموحة فيها allow read, write).');
  }
  if (code === 'unavailable' || /unavailable|deadline/i.test(msg)) {
    return err('تعذر الوصول لقاعدة البيانات دلوقتي. اتأكد من الاتصال وحاول تاني.');
  }
  if (code === 'not-found') return err('العنصر مش موجود في قاعدة البيانات.');
  if (code === 'failed-precondition') return err('العملية اترفضت من قاعدة البيانات. حدّث الصفحة وحاول تاني.');
  if (code === 'unauthenticated') return err('انتهت الجلسة. سجّل دخول تاني.');
  return null;
}

/* ============================================================
 *  Backend
 * ============================================================ */
/** خدمة طبقة البيانات (Firestore) — بترجع بيانات فقط، من غير أي لمس للواجهة */
export function createFirestoreService(db, opts) {
  return new FirestoreBackend(db, opts || {});
}

/* اسم قديم (متوافق) */
export const createBackend = createFirestoreService;

class FirestoreBackend {
  constructor(db, opts) {
    this.db = db;
    this.auth = opts.auth || null;                 /* Firebase Auth instance */
    this.emailDomain = opts.emailDomain || 'item-f8564.firebaseapp.com';
    this.authReady = opts.authReady || Promise.resolve(null);
    this.state = {};
    ALL_COLS.forEach(function (c) { this.state[c] = []; }, this);
    this.loaded = false;
    this._hydrating = null;
    this.rev = 0;
    this.session = null;
    this._subs = [];
    this._emitTimer = null;
    this._provider = null;
    this._cb = null;
    this._onErr = null;
    this._locks = {};
    this._pending = null;
  }

  /* ---------------- state ---------------- */
  /* قفل بسيط يمنع تداخل العمليات على نفس الحالة (سبع البذرة + القراءة + الاستماع)
     عشان ما يحصلش تكرار في الذاكرة (زي فرع مكرر في قايمة الفروع). */
  _withLock(key, fn) {
    var prev = this._locks[key] || Promise.resolve();
    var next = prev.then(fn, fn);
    this._locks[key] = next.then(function () { }, function () { });
    return next;
  }

  _sort(name) {
    var arr = this.state[name] || [];
    arr.sort(function (a, b) {
      var sa = a.seq != null ? a.seq : (Date.parse(a.createdAt) || Date.parse(a.at) || 0);
      var sb = b.seq != null ? b.seq : (Date.parse(b.createdAt) || Date.parse(b.at) || 0);
      if (sa !== sb) return sa - sb;
      return String(a.id).localeCompare(String(b.id));
    });
    return arr;
  }

  async hydrate(force) {
    if (this._hydrating) return this._hydrating;
    if (this.loaded && !force) return;
    var self = this;
    /* المجموعات بتتقرأ بالتوازي (مش واحدة ورا واحدة) عشان الدخول يكون فوري */
    this._hydrating = this._withLock('state', async function () {
      await self.authReady.catch(function () { });
      var lists = await Promise.all(ALL_COLS.map(function (name) {
        return getDocs(collection(self.db, name)).then(function (snap) {
          return { name: name, docs: snap.docs };
        }, function () {
          return { name: name, docs: [] };
        });
      }));
      lists.forEach(function (l) {
        self.state[l.name] = l.docs.map(function (d) {
          var o = d.data(); o.id = d.id; return o;
        });
        self._sort(l.name);
      });
      /* إعدادات الأدوار (config/roles) — المصدر الوحيد لتعريف الأدوار */
      try {
        var cfg = await getDoc(doc(self.db, COL.config, 'roles'));
        if (cfg.exists()) self._applyRoleConfig(cfg.data());
      } catch (e) { }
      self.loaded = true;
      self.rev++;
    });
    try { await this._hydrating; } finally { this._hydrating = null; }
  }

  async _reload(name) {
    var snap = await getDocs(collection(this.db, name));
    this.state[name] = snap.docs.map(function (d) { var o = d.data(); o.id = d.id; return o; });
    this._sort(name);
    this.rev++;
  }

  async _reloadMany(names) {
    for (var i = 0; i < names.length; i++) {
      var snap = await getDocs(collection(this.db, names[i]));
      this.state[names[i]] = snap.docs.map(function (d) { var o = d.data(); o.id = d.id; return o; });
      this._sort(names[i]);
    }
    this.rev++;
  }

  /* ============================================================
   *  الأدوار — بتقرأ من Firestore (config/roles)
   *  ------------------------------------------------------------
   *  مفيش قوائم أدوار/صلاحيات ثابتة في الكود: كل حاجة بتتبعت من
   *  مستند الإعدادات في Firestore. البذرة الأولى بس (مرة واحدة)
   *  بتعمل المستند ده لو مش موجود.
   * ============================================================ */

  /** بذرة تعريف الأدوار (مرة واحدة — بعدها كله بيانات) */
  async _seedRoleConfig(by) {
    var roles = [
      { key: 'management', label: 'مانجمنت', scope: 'all', view: 'management', grantAdmin: true, notify: true, actions: [], aliases: [] },
      { key: 'branch', label: 'ديسباتشر فرع', scope: 'branch', view: 'branch', grantAdmin: false, notify: true, actions: ['logStop', 'resumeStop'], aliases: ['dispatcher', 'dispatch'] },
      { key: 'agent', label: 'ايجينت (قراءة بس)', scope: 'branch', view: 'agent', grantAdmin: false, notify: false, actions: [], aliases: [] }
    ];
    var aliases = {};
    roles.forEach(function (r) { (r.aliases || []).forEach(function (a) { aliases[a] = r.key; }); });
    await setDoc(doc(this.db, COL.config, 'roles'), {
      roles: roles, aliases: aliases, at: nowIso(), by: by || 'system'
    });
    this._applyRoleConfig({ roles: roles, aliases: aliases });
    return { roles: roles, aliases: aliases };
  }

  /** خريطة الأدوار (من الكاش) — بتتحدّث مع المستند */
  _applyRoleConfig(data) {
    this._roleMap = {}; this._roleAliases = {};
    var list = (data && Array.isArray(data.roles)) ? data.roles : [];
    var self = this;
    list.forEach(function (r) { if (r && r.key) self._roleMap[r.key] = r; });
    var al = (data && data.aliases) ? data.aliases : {};
    Object.keys(al).forEach(function (k) { self._roleAliases[k] = al[k]; });
  }

  /** إعدادات الأدوار (للواجهة) — بتقرأ من Firestore */
  async getRoleConfig() {
    var u = this._requireManager();
    var snap = await getDoc(doc(this.db, COL.config, 'roles'));
    var data = snap.exists() ? snap.data() : null;
    if (!data || !Array.isArray(data.roles) || !data.roles.length) {
      /* المستند مش موجود: الأدمن العام يعمله (مرة واحدة) */
      if (!this.isGlobal(u)) return { roles: [], aliases: {} };
      data = await this._seedRoleConfig(u.username);
    }
    this._applyRoleConfig(data);
    return { roles: data.roles || [], aliases: data.aliases || {} };
  }

  /** دور اليوزر (من الخريطة) — الافتراضي: أقل صلاحية */
  _roleDef(roleKey) {
    var d = this._roleMap[roleKey];
    return d || { key: roleKey || '', label: roleKey || '', scope: 'branch', grantAdmin: false, aliases: [] };
  }

  /** نطاق الدور: 'all' (يشوف كل برانداته) أو 'branch' (فروعه بس) */
  _roleScope(profile) {
    return this._roleDef(profile && profile.role).scope === 'all' ? 'all' : 'branch';
  }

  /** يحوّل الاسم البديل (dispatcher) لاسم الدور الأساسي */
  _resolveRoleKey(input) {
    var k = String(input || '').trim();
    if (!k) return '';
    if (this._roleMap[k]) return k;
    var alias = this._roleAliases[k] || this._roleAliases[k.toLowerCase()];
    return alias || k;
  }

  /* ---------------- session (Firebase Authentication) ---------------- */
  isGlobal(u) {
    if (!u || u.isAdmin !== true) return false;
    /* صلاحية المدير النظامي من إعدادات الأدوار (مش اسم دور ثابت في الكود) */
    var def = this._roleDef(u.role);
    return def.grantAdmin === true || !this._roleMap[u.role];
  }

  _require(roles) {
    var s = this.session;
    if (!s || !s.user) throw err('SESSION_EXPIRED');
    /* بنجيب آخر نسخة من اليوزر من Firestore: الإيقاف/تغيير الدور بيلغي الجلسة فورًا */
    var u = this._findUserByUid(s.uid) || this._findUser(s.user.username);
    if (!u || u.active === false) throw err('SESSION_EXPIRED');
    if (String(u.ver || '') !== String(s.ver || '')) throw err('SESSION_EXPIRED');
    s.user = u;
    /* لو اتحددت أدوار مطلوبة → نقارنها بإعدادات الأدوار (مش بقائمة ثابتة) */
    if (roles && roles.length) {
      var self = this;
      var allowed = roles.some(function (r) { return self._resolveRoleKey(r) === u.role; });
      if (!allowed) throw err('العملية دي مش متاحة لدور حسابك.');
    }
    return u;
  }

  /** المانجمنت (نطاق 'all' حسب إعدادات الأدوار) */
  _requireManager() {
    var u = this._require();
    if (this._roleScope(u) !== 'all') throw err('العملية دي مش متاحة لدور حسابك.');
    return u;
  }

  /** أي حساب نشط (مانجمنت أو ديسباتشر) */
  _requireAny() {
    return this._require();
  }

  /** الدور يقدر ينفذ عملية معيّنة؟ (من إعدادات الأدوار) */
  _roleCan(profile, action) {
    var def = this._roleDef(profile && profile.role);
    if (Array.isArray(def.actions) && def.actions.length) return def.actions.indexOf(action) >= 0;
    return this._roleScope(profile) === 'all';
  }

  /** الأدوار اللي بنبعتلها الإشعارات (من إعدادات الأدوار) */
  _notifyRoles() {
    var out = [];
    Object.keys(this._roleMap).forEach(function (k) {
      var d = this._roleMap[k];
      if (d && d.notify === true) out.push(k);
    }, this);
    return out.length ? out : Object.keys(this._roleMap);
  }

  /** الدور الافتراضي للفروع (أقل صلاحية تقدر تسجّل إيقاف) */
  _defaultScopedRole() {
    var keys = Object.keys(this._roleMap);
    for (var i = 0; i < keys.length; i++) {
      var d = this._roleMap[keys[i]];
      if (d && d.grantAdmin !== true && d.scope === 'branch') return d.key;
    }
    return keys.length ? keys[0] : '';
  }

  /* اليوزر بيتخزّن بزمن الـ uid بتاع Firebase Auth (اسم المستخدم أو الإيميل) */
  _findUser(username) {
    var k = keyOf(username);
    if (!k) return null;
    var local = k.split('@')[0];
    return this.state[COL.users].filter(function (u) {
      if (u.usernameKey === k || keyOf(u.username) === k || keyOf(u.email) === k) return true;
      var ul = keyOf(u.email || '').split('@')[0];
      return !!ul && ul === local;
    })[0] || null;
  }

  _findUserByUid(uid) {
    if (!uid) return null;
    return this.state[COL.users].filter(function (u) { return u.uid === uid; })[0] || null;
  }

  _randHex(bytes) {
    var a = new Uint8Array(bytes);
    crypto.getRandomValues(a);
    return Array.prototype.map.call(a, function (b) { return b.toString(16).padStart(2, '0'); }).join('');
  }

  _randomPass(n) {
    var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
    var a = new Uint32Array(n || 10);
    crypto.getRandomValues(a);
    var out = '';
    for (var i = 0; i < a.length; i++) out += chars[a[i] % chars.length];
    return out;
  }

  /* ------------------------------------------------------------------
   *  Firebase Authentication
   *  ------------------------------------------------------------------
   *  الدخول بيمشي عن طريق Firebase Auth (Email + Password) بالكامل.
   *  Firestore بيخزّن بس "الملف الشخصي" (الدور/الفرع/المطعم) من غير أي
   *  باسورد — كلمات السر كلها متmanageة من Firebase Auth.
   * ------------------------------------------------------------------ */

  /**
   * يتحقق إن الإيميل شكله صحيح (Firebase Auth بيرفض الحاجات الغلط،
   * لكن إحنا بنتحقق قبل كده عشان ندي رسالة واضحة ومنع المدخلات الغريبة).
   */
  _isValidEmail(v) {
    if (!v || v.length > 254) return false;
    /* يسمح بالحروف والأرقام والنقطة والشرطة والـ underscore والـ + قبل @ */
    if (!/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(v)) return false;
    if (v.indexOf('..') >= 0) return false;
    if (v.charAt(0) === '.' || v.charAt(v.length - 1) === '.') return false;
    return true;
  }

  /** يحوّل اللي بيكتبه المستخدم لإيميل صالح لـ Firebase Auth */
  _authEmail(input) {
    var v = cleanText(input, 120).toLowerCase();
    if (!v) return '';
    if (v.indexOf('@') >= 0) return v;
    return v + '@' + (this.emailDomain || 'item-f8564.firebaseapp.com');
  }

  /** اسم المستخدم المقروء (من غير جزء الدومين) */
  _displayName(email) {
    var v = String(email || '');
    var i = v.indexOf('@');
    return i > 0 ? v.slice(0, i) : v;
  }

  /** ترجمة أخطاء Firebase Auth لرسائل عربية واضحة */
  _authError(e) {
    var code = (e && e.code) ? String(e.code) : '';
    var msg = {
      'auth/invalid-credential': 'اسم المستخدم أو كلمة السر غلط.',
      'auth/user-not-found': 'اسم المستخدم أو كلمة السر غلط.',
      'auth/wrong-password': 'اسم المستخدم أو كلمة السر غلط.',
      'auth/invalid-email': 'الإيميل مش صالح.',
      'auth/email-already-in-use': 'الحساب ده موجود بالفعل.',
      'auth/weak-password': 'كلمة السر ضعيفة — لازم 6 حروف على الأقل.',
      'auth/too-many-requests': 'محاولات كتير. استنى شوية وجرّب تاني.',
      'auth/network-request-failed': 'تعذر الاتصال بالإنترنت. حاول تاني.',
      'auth/popup-closed-by-user': 'تم إغلاق النافذة.',
      'auth/user-disabled': 'الحساب ده موقوف. كلّم مدير النظام.',
      'auth/operation-not-allowed': 'تسجيل الدخول بالإيميل مش مفعّل. من Firebase Console: Authentication ▸ Sign-in method ▸ Email/Password ▸ Enable.',
      'auth/configuration-not-found': 'Firebase Authentication مش مهيّأ في المشروع. فعّل Email/Password من الـ Console.'
    }[code];
    if (msg) { var er = new Error(msg); er.business = true; er.code = code; return er; }
    var er2 = new Error('تعذر تسجيل الدخول. حاول تاني.');
    er2.business = true; er2.code = code;
    return er2;
  }

  /**
   * ⚠️ مفيش إنشاء تلقائي لحساب هنا (قيد أمني):
   *    الحسابات بتتعمل من ⚙️ إدارة المستخدمين فقط (الأدمن).
   *    أي إيميل مش موجود في "users" أو موقوف → يُرفض الدخول فورًا.
   */

  /**
   * استعادة الجلسة من Firestore (بعد تحديث الصفحة)
   * — بتلاقي الملف الشخصي بس؛ لو مش موجود/موقوف → false (مش مسموح بالدخول)
   */
  async restoreSession(fbUser) {
    try {
      var user = fbUser || (this.auth && this.auth.currentUser ? this.auth.currentUser : null);
      if (!user) return false;
      /* قراءة محدّثة للملفات الشخصية (لو اتوقّف الحساب من جهاز تاني لازم يطلع فورًا) */
      await this._reload(COL.users);
      var profile = this._findUserByUid(user.uid) || this._findUser(user.email);
      if (!profile || profile.active === false) return false;
      this.session = { user: profile, ver: profile.ver || '', uid: user.uid || '' };
      return true;
    } catch (e) { return false; }
  }

  /** إعادة تأكيد الهوية بكلمة السر (للعمليات الحساسة) — عن طريق خدمة المصادقة */
  async _reauth(password) {
    if (this.authService && typeof this.authService.reauthenticate === 'function') {
      return this.authService.reauthenticate(password);
    }
    throw err('خدمة المصادقة غير متاحة.');
  }

  /** تغيير باسورد الحساب الحالي (عن طريق خدمة المصادقة) */
  async changeMyPassword(newPass) {
    var u = this._require();
    if (!this.authService || typeof this.authService.changeMyPassword !== 'function') {
      throw err('خدمة المصادقة غير متاحة.');
    }
    await this.authService.changeMyPassword(newPass);
    await this._audit(u, 'PASSWORD_CHANGE', u.username, '', 'OK');
    return { ok: true };
  }

  /**
   * فحص سريع للصلاحية — بتستدعيه الواجهة كل دقيقة للتأكد إن
   * الحساب لسه نشط ولسه متاح (لو اتوقّف من جهاز تاني يخرج فورًا).
   */
  async checkSession() {
    var u = this._require();
    return {
      ok: true,
      username: u.username,
      role: u.role,
      isAdmin: !!u.isAdmin,
      branches: Array.isArray(u.branches) ? u.branches : [],
      restaurant: u.restaurant || ''
    };
  }

  _userContext(record) {
    var u = {
      username: record.username,
      role: record.role,
      branch: record.branch || '',
      branches: Array.isArray(record.branches) ? record.branches.slice() : [],
      restaurant: record.restaurant || '',
      isAdmin: !!record.isAdmin || keyOf(record.username) === 'admin'
    };
    /* لو الحساب مربوط بفرع واحد فقط (نسخة قديمة) → نحوله لقائمة */
    if (!u.branches.length && u.branch) u.branches = [u.branch];
    if (this._roleScope(u) === 'all') {
      if (!u.restaurant && !this.isGlobal(u)) {
        var act = this.state[COL.restaurants].filter(function (r) { return r.active !== false; });
        u.restaurant = (act[0] || this.state[COL.restaurants][0] || {}).id || '';
      }
      u.branches = [];
      return u;
    }
    if (this._roleScope(u) === 'branch') {
      if (!u.branches.length) throw err('الحساب غير مربوط بفرع. كلّم مدير النظام.');
      /* بنتحقق إن كل فرع موجود ونشط فعلاً */
      var self = this;
      var recs = [];
      for (var i = 0; i < u.branches.length; i++) {
        var rec = this._branchRecord(u.branches[i], u.restaurant || null);
        if (rec) recs.push(rec);
      }
      if (!recs.length) throw err('الحساب غير مربوط بفرع نشط.');
      u.branches = recs.map(function (r) { return r.key; });
      u.branch = u.branches[0];
      u.restaurant = recs[0].restaurant;
    }
    return u;
  }

  /**
   * تسجيل مستخدم جديد (Sign-up) — بينشئ ملفه الشخصي بحالة "موقوف"
   * ومن غير أي صلاحيات أو فروع، لحد ما الإدارة تعتمده.
   * (المصادقة نفسها بتتم في خدمة المصادقة)
   */
  async registerNewUser(fbUser, requestedName) {
    if (!fbUser || !fbUser.email) throw err('تعذر تحديد البريد. حاول تاني.');
    var email = String(fbUser.email).toLowerCase();
    if (!this._isValidEmail(email)) throw err('الإيميل مش صالح. استخدم إيميل صحيح زي name@example.com.');

    /* لو في ملف أصلاً → يبقى موجود، مفيش إنشاء تاني */
    var existing = this._findUser(email);
    if (existing) {
      await this._reload(COL.users);
      existing = this._findUser(email);
      if (!existing) throw err('في مشكلة في الحساب. كلّم مدير النظام.');
      if (existing.active === false) {
        return { ok: true, pending: true, message: 'حسابك بانتظار موافقة الإدارة. كلّم مدير النظام.' };
      }
      return { ok: true, pending: false, message: 'الحساب ده موجود بالفعل — سجّل دخول بكلمة السر.' };
    }

    /* الملف الجديد: موقوف + أقل صلاحية + من غير فروع */
    var name = norm(requestedName) || this._displayName(email);
    if (!/^[A-Za-z0-9_.-]{2,30}$/.test(name)) name = this._displayName(email);
    /* الدور الافتراضي = أقل صلاحية متاحة في الإعدادات */
    var def = this._leastPrivilegeRole();
    var data = {
      username: name, usernameKey: keyOf(email), email: email, uid: (fbUser && fbUser.uid) || '',
      role: def.key, branch: '', branches: [], restaurant: '', isAdmin: false,
      active: false, ver: this._randHex(8), createdAt: nowIso(), createdBy: 'signup', seq: Date.now()
    };
    await setDoc(doc(this.db, COL.users, keyOf(email)), data).catch(function (e) {
      throw fsError(e, 'إنشاء ملف الحساب') || e;
    });
    await this._reload(COL.users);
    await this._audit(null, 'SIGNUP', email, { role: def.key }, 'PENDING');
    return { ok: true, pending: true, message: 'تم إنشاء حسابك بنجاح. حسابك بانتظار موافقة الإدارة.' };
  }

  /** أقل دور متاح في الإعدادات (للحسابات الجديدة) */
  _leastPrivilegeRole() {
    var keys = Object.keys(this._roleMap);
    if (!keys.length) return { key: 'agent', label: 'agent', scope: 'branch', grantAdmin: false };
    /* أول دور مش grantAdmin */
    for (var i = 0; i < keys.length; i++) {
      var d = this._roleMap[keys[i]];
      if (d && d.grantAdmin !== true) return d;
    }
    return this._roleMap[keys[0]];
  }

  /**
   * استلام المستخدم اللي اتصادق عليه (المصادقة نفسها بتتم في الواجهة
   * عبر signInWithEmailAndPassword) وتجهيز الملف الشخصي + الداتا.
   *
   * ⚠️ مفيش أي إنشاء تلقائي لحساب هنا: الإيميل لازم يكون **مسجّل ومفعّل
   *   مسبقًا** في collection "users" (يعني معتمد من الأدمن).
   *   لو مش موجود أو موقوف → بنرجّع blocked + بنوقّع الخروج من Auth.
   *
   * بترجع:
   *   { ok:true, token, data }      → يكمّل للداشبورد
   *   { blocked:true, message }     → الحساب غير معتمد/موقوف (مفيش داتا)
   */
  async adoptAuthenticatedUser(fbUser, requestedName) {
    if (!fbUser) throw err('تعذر تسجيل الدخول. حاول تاني.');
    return this._withLock('login', () => this._adopt(fbUser, requestedName));
  }

  async _adopt(fbUser, requestedName) {
    await this.hydrate(true);
    var email = String((fbUser && fbUser.email) || '').toLowerCase();
    if (!email) throw err('تعذر تحديد بريد الحساب. حاول تاني.');

    /* الملف الشخصي لازم يكون موجود (معتمد من الأدمن) */
    var profile = this._findUserByUid(fbUser.uid) || this._findUser(email);
    if (!profile) {
      this.session = null;
      return {
        ok: false, blocked: true,
        message: 'عذراً، هذا البريد غير مسجل أو بانتظار موافقة الإدارة. كلّم مدير النظام.'
      };
    }
    if (profile.active === false) {
      this.session = null;
      return {
        ok: false, blocked: true,
        message: 'حسابك موقوف. كلّم مدير النظام عشان يفعّله.'
      };
    }

    /* الحساب مسجّل ومفعّل → بنحدّث الـ uid (تسجيل مساعد) ونجهّز الجلسة */
    if (fbUser.uid && profile.uid !== fbUser.uid) {
      try {
        await updateDoc(doc(this.db, COL.users, profile.id), { uid: fbUser.uid, updatedAt: nowIso() });
        profile.uid = fbUser.uid;
      } catch (e) { /* القواعد ما سمحتش — مش مهم */ }
    }

    /* أول حساب في النظام → نعمل سبع البذرة (مطعم + فروع + أسباب + أوقات) */
    if (!this.state[COL.restaurants].length) {
      await this._seedDefaults(profile.username);
      await this._audit(profile, 'BOOTSTRAP_ADMIN', profile.username, { first: true }, 'OK');
    }

    this.session = { user: profile, ver: profile.ver || '', uid: fbUser.uid || '' };
    await this._audit(profile, 'LOGIN', profile.username, { restaurant: profile.restaurant || '' }, 'OK');
    return {
      ok: true,
      token: 'auth:' + (fbUser.uid || profile.username),
      username: profile.username,
      role: profile.role,
      branches: Array.isArray(profile.branches) ? profile.branches : [],
      data: this.scopedPayload('')
    };
  }

  async logout() {
    var u = this.session && this.session.user;
    if (u) await this._audit(u, 'LOGOUT', u.username, '', 'OK');
    this.session = null;
    this.stopWatch();
    try { await signOut(this.auth); } catch (e) { }
    return true;
  }

  async _seedDefaults(by) {
    /* البذرة بتتعمل مرة واحدة بس (قفل) وبعدها بنعمل مزامنة تامة من Firestore */
    return this._withLock('state', () => this._seedDefaultsLocked(by));
  }

  async _seedDefaultsLocked(by) {
    if (this.state[COL.restaurants].length) return;
    var restId = 'MAIN';
    var rest = { id: restId, name: 'المطعم الرئيسي', active: true, createdAt: nowIso(), createdBy: by, seq: Date.now() };
    await setDoc(doc(this.db, COL.restaurants, restId), rest).catch(function (e) {
      throw fsError(e, 'تهيئة البيانات الأساسية (المطاعم)') || e;
    });
    this.state[COL.restaurants].push(rest);

    var defs = [
      { name: 'DOKKI', close: '04:30:00' },
      { name: 'ZAMALEK', close: '03:30:00' },
      { name: 'MERRYLAND', close: '03:30:00' },
      { name: 'ELSAHEL', close: '02:00:00' }
    ];
    var base = Date.now();
    for (var i = 0; i < defs.length; i++) {
      var key = keyOf(defs[i].name).replace(/[^a-z0-9]+/g, '-');
      var b = {
        key: key, name: defs[i].name, restaurant: restId, active: true,
        openSec: 9 * 3600, closeSec: parseSec(defs[i].close) || 3 * 3600,
        days: null, ver: 1, createdAt: nowIso(), createdBy: by, seq: base + i
      };
      await setDoc(doc(this.db, COL.branches, key), b).catch(function (e) {
        throw fsError(e, 'تهيئة البيانات الأساسية (الفروع)') || e;
      });
      this.state[COL.branches].push(b);
      var t = {
        branch: key, restaurant: restId, prepMin: 10, delMin: 30,
        by: by, at: nowParts().key, createdAt: nowIso(), seq: base + i
      };
      var tr = await addDoc(collection(this.db, COL.times), t);
      t.id = tr.id; this.state[COL.times].push(t);
    }
    var reasons = ['نفاد الخام', 'عطل في المعدات', 'مشكلة جودة', 'أخرى'];
    for (var r = 0; r < reasons.length; r++) {
      var rr = {
        restaurant: restId, branch: '', name: reasons[r], nameKey: keyOf(reasons[r]),
        enabled: true, by: by, at: nowIso(), createdAt: nowIso(), seq: base + 100 + r
      };
      var rref = await addDoc(collection(this.db, COL.reasons), rr);
      rr.id = rref.id;
      this.state[COL.reasons].push(rr);
    }
    /* تعريف الأدوار (مستند الإعدادات) — كل حاجة بعدها بتقرأ منه */
    await this._seedRoleConfig(by);
    /* مزامنة تامة من Firestore عشان مفيش أي تكرار في الذاكرة */
    await this._reloadMany([COL.restaurants, COL.branches, COL.times, COL.reasons, COL.users]);
  }

  /* ---------------- scoping helpers ---------------- */
  resolveRestaurant(u, wanted) {
    if (!this.isGlobal(u)) return u.restaurant || '';
    if (wanted) {
      var hit = this.state[COL.restaurants].filter(function (r) { return same(r.id, wanted); })[0];
      if (hit) return hit.id;
    }
    var act = this.state[COL.restaurants].filter(function (r) { return r.active !== false; });
    return ((act[0] || this.state[COL.restaurants][0]) || {}).id || '';
  }

  brandName(rid) {
    var r = this.state[COL.restaurants].filter(function (x) { return same(x.id, rid); })[0];
    return r ? r.name : rid;
  }

  _branchRecord(branch, restaurant) {
    var k = keyOf(branch);
    if (!k) return null;
    var list = this.state[COL.branches].filter(function (b) {
      return b.active !== false && (keyOf(b.key) === k || keyOf(b.name) === k);
    });
    if (restaurant) list = list.filter(function (b) { return same(b.restaurant, restaurant); });
    return list[0] || null;
  }

  _allowedBranches(u, rid, scoped) {
    var self = this;
    /* العزل بيتحسب من خدمة الصلاحيات (rbac-service) — مصدر واحد للحقيقة */
    return this.state[COL.branches].filter(function (b) {
      if (b.active === false) return false;
      /* العزل بالبراند: يوزر غير عام بيشوف برانده بس */
      if (!self.isGlobal(u) || scoped) {
        if (!same(b.restaurant, rid)) return false;
      }
      /* العزل بالفرع: أي دور نطاقه 'branch' بيشوف فروعه بس (من إعدادات الأدوار) */
      if (self._roleScope(u) === 'branch') {
        return canAccessBranch(u, b.key) || canAccessBranch(u, b.name);
      }
      return true;
    });
  }

  /* ---------------- menu / reasons ---------------- */
  menuForBranch(rest, branchKey) {
    var rows = this._sort(COL.menu);
    var restKey = keyOf(rest), branch = keyOf(branchKey);
    var order = [], byKey = {};

    rows.forEach(function (r) {
      if (!same(r.restaurant, restKey) || norm(r.branch) || r.active === false) return;
      var k = keyOf(r.item);
      if (byKey[k]) return;
      byKey[k] = {
        it: r.item, cat: r.category || '', price: num(r.price),
        av: r.available === false ? 0 : 1, removed: false
      };
      order.push(k);
    });
    rows.forEach(function (r) {
      if (!same(r.restaurant, restKey) || keyOf(r.branch) !== branch) return;
      var k = keyOf(r.item), cur = byKey[k];
      if (r.active === false) { if (cur) cur.removed = true; return; }
      if (cur) {
        cur.av = r.available === false ? 0 : 1;
        if (num(r.price) !== null) cur.price = num(r.price);
        if (r.category) cur.cat = r.category;
        cur.removed = false;
      } else {
        byKey[k] = {
          it: r.item, cat: r.category || '', price: num(r.price),
          av: r.available === false ? 0 : 1, removed: false
        };
        order.push(k);
      }
    });
    var out = [];
    order.forEach(function (k) { if (!byKey[k].removed) out.push(byKey[k]); });
    return out;
  }

  menuForRestaurant(rest) {
    var seen = {}, out = [], self = this;
    this.state[COL.branches].forEach(function (b) {
      if (!same(b.restaurant, rest)) return;
      self.menuForBranch(rest, b.key).forEach(function (it) {
        var k = keyOf(it.it);
        if (seen[k]) return;
        seen[k] = 1; out.push(it);
      });
    });
    return out;
  }

  menuItemNames(rest) {
    var out = [], seen = {};
    this._sort(COL.menu).forEach(function (r) {
      if (!same(r.restaurant, rest) || norm(r.branch) || r.active === false) return;
      var k = keyOf(r.item);
      if (seen[k]) return;
      seen[k] = 1;
      out.push({ it: r.item, cat: r.category || '', price: num(r.price), av: r.available === false ? 0 : 1 });
    });
    return out;
  }

  reasonsForBranch(rest, branchKey) {
    var branch = keyOf(branchKey);
    var map = {}, order = [];
    this._sort(COL.reasons).forEach(function (r) {
      if (!same(r.restaurant, rest)) return;
      var reason = norm(r.name);
      if (!reason || keyOf(reason) === keyOf(UNSPEC)) return;
      var shared = !norm(r.branch);
      if (!shared && keyOf(r.branch) !== branch) return;
      var k = keyOf(reason), e = map[k];
      if (!e) { e = map[k] = { name: reason, shared: null, specific: null }; order.push(k); }
      var enabled = r.enabled !== false;
      if (shared) { if (e.shared === null) e.shared = enabled; }
      else e.specific = enabled;
    });
    return order.filter(function (k) {
      var e = map[k];
      return e.specific === null ? !!e.shared : e.specific;
    }).map(function (k) { return map[k].name; });
  }

  reasonsForRestaurant(rest) {
    var out = [], seen = {};
    this._sort(COL.reasons).forEach(function (r) {
      if (!same(r.restaurant, rest) || norm(r.branch) || r.enabled === false) return;
      var v = norm(r.name);
      if (!v || keyOf(v) === keyOf(UNSPEC)) return;
      var k = keyOf(v);
      if (seen[k]) return;
      seen[k] = 1; out.push(v);
    });
    return out;
  }

  reasonsForAllBranches(rest) {
    var out = [], seen = {}, self = this;
    this.state[COL.branches].forEach(function (b) {
      if (!same(b.restaurant, rest)) return;
      self.reasonsForBranch(rest, b.key).forEach(function (r) {
        var k = keyOf(r);
        if (seen[k]) return;
        seen[k] = 1; out.push(r);
      });
    });
    return out;
  }

  reasonsForRestaurantAll(rest) {
    var out = [], seen = {}, self = this;
    this.state[COL.branches].forEach(function (b) {
      if (!same(b.restaurant, rest)) return;
      self.reasonsForBranch(rest, b.key).forEach(function (r) {
        var k = keyOf(r);
        if (seen[k]) return;
        seen[k] = 1; out.push(r);
      });
    });
    return out;
  }

  /* ---------------- hours / shifts ---------------- */
  dayHours(branch, dateKey) {
    var base = {
      openSec: branch.openSec != null ? +branch.openSec : 9 * 3600,
      closeSec: branch.closeSec != null ? +branch.closeSec : 5 * 3600,
      closed: false
    };
    if (!Array.isArray(branch.days) || branch.days.length !== 7) return base;
    var d = branch.days[weekdayOf(dateKey || nowParts().key)];
    if (!d) return base;
    if (d.closed) return { openSec: base.openSec, closeSec: base.closeSec, closed: true };
    return {
      openSec: d.openSec != null ? +d.openSec : base.openSec,
      closeSec: d.closeSec != null ? +d.closeSec : base.closeSec,
      closed: false
    };
  }

  shiftInfo(branch, now) {
    now = now || nowParts();
    var nowAbs = dayNum(now.key) * 86400 + now.sec;
    var selected = null;
    for (var offset = 0; offset <= 6; offset++) {
      var dayKey = addDaysKey(now.key, -offset);
      var hours = this.dayHours(branch, dayKey);
      if (hours.closed) continue;
      var openAbs = dayNum(dayKey) * 86400 + hours.openSec;
      if (openAbs > nowAbs) continue;
      selected = { day: dayKey, startAbs: openAbs, hours: hours };
      break;
    }
    if (!selected) {
      var fb = this.dayHours(branch, now.key);
      return {
        day: now.key, startAbs: nowAbs, endAbs: nowAbs,
        openSec: fb.openSec, closeSec: fb.closeSec, closed: true,
        openNow: false, due: false, key: branch.key + '|' + now.key
      };
    }
    var span = (selected.hours.closeSec - selected.hours.openSec + 86400) % 86400;
    if (!span) span = 86400;
    var endAbs = selected.startAbs + span;
    return {
      day: selected.day, startAbs: selected.startAbs, endAbs: endAbs,
      openSec: selected.hours.openSec, closeSec: selected.hours.closeSec,
      closed: false, openNow: this.branchOpenAt(branch, now),
      due: nowAbs >= endAbs, key: branch.key + '|' + selected.day
    };
  }

  branchOpenAt(branch, now) {
    now = now || nowParts();
    var nowAbs = dayNum(now.key) * 86400 + now.sec;
    var open = false, self = this;
    [now.key, addDaysKey(now.key, -1)].forEach(function (dk) {
      var hours = self.dayHours(branch, dk);
      if (hours.closed) return;
      var start = dayNum(dk) * 86400 + hours.openSec;
      var span = (hours.closeSec - hours.openSec + 86400) % 86400;
      if (!span) span = 86400;
      if (nowAbs >= start && nowAbs < start + span) open = true;
    });
    return open;
  }

  _openStops(branchKey) {
    return this.state[COL.stops].filter(function (s) {
      return same(s.branch, branchKey) && s.open !== false && (s.startSec === null || s.startSec === undefined || s.startSec === '');
    });
  }

  /* ---------------- payload builders ---------------- */
  _buildBranchRowSet(b, rid, now) {
    var si = this.shiftInfo(b, now);
    var itemMap = {}, reasonMap = {}, self = this;
    this.menuForBranch(rid, b.key).forEach(function (x) { itemMap[keyOf(x.it)] = x.it; });
    this.reasonsForBranch(rid, b.key).forEach(function (r) { reasonMap[keyOf(r)] = r; });

    var rows = [], skipped = 0;
    this.state[COL.stops].forEach(function (s) {
      if (!same(s.branch, b.key) && !same(s.branch, b.name)) return;
      var dk = String(s.date || '');
      var stop = parseSec(s.stopSec);
      if (!dk || stop === null) { skipped++; return; }
      var start = (s.startSec === null || s.startSec === undefined || s.startSec === '') ? null : parseSec(s.startSec);
      var isOpen = start === null;
      var durSec = 0, rev = 0, atClose = 0;
      if (isOpen) {
        durSec = Math.max(0, (dayNum(now.key) * 86400 + now.sec) - (dayNum(dk) * 86400 + stop));
      } else {
        durSec = (start - stop + 86400) % 86400;
        if (durSec === 0) rev = 1;
        if (start === si.closeSec) atClose = 1;
      }
      var hours = durSec / 3600;
      var reason = norm(s.reason);
      reason = reason ? (reasonMap[keyOf(reason)] || reason) : UNSPEC;
      var note = norm(s.note);
      var dispReason = (reason && isOtherReason(reason) && note) ? (reason + ' - ' + note) : reason;
      var item = itemMap[keyOf(s.item)] || s.item;
      rows.push({
        d: dk, it: item,
        st: fmtHMS(stop),
        en: isOpen ? '' : fmtHMS(start),
        stv: stop, env: isOpen ? null : start,
        h: Math.round(hours * 100) / 100,
        du: fmtHMS(durSec), dsec: durSec,
        r: dispReason, n: note,
        o: isOpen ? 1 : 0, c: atClose, v: rev, x: s.id
      });
    });
    return { si: si, rows: rows, skipped: skipped };
  }

  _scopeRows(u, rows, shift, now) {
    if (this._roleScope(u) === 'all') return rows;
    var nowBase = dayNum(now.key) * 86400 + now.sec;
    var filtered = rows.filter(function (r) {
      var ts = dayNum(r.d) * 86400 + (+r.stv || 0);
      if (ts > nowBase) return false;
      if (r.o) return true;
      if (shift) return ts >= shift.startAbs && ts <= shift.endAbs;
      return ts >= dayNum(now.key) * 86400;
    });
    if (this._roleScope(u) === 'branch' && !this._roleCan(u, 'write')) {
      filtered = filtered.map(function (r) {
        return { d: r.d, it: r.it, st: r.st, en: r.en, stv: r.stv, env: r.env, o: r.o };
      });
    }
    return filtered;
  }

  scopedPayload(wanted) {
    var u = this._require();
    var global = this.isGlobal(u);
    var scoped = global && !!wanted;
    var rid = this.resolveRestaurant(u, wanted);
    var now = nowParts();
    var self = this;
    var allowed = this._allowedBranches(u, rid, scoped);

    var branches = allowed.map(function (b) {
      var built = self._buildBranchRowSet(b, rid, now);
      var si = built.si;
      return {
        name: b.name, key: b.key, restaurant: b.restaurant, restaurantName: self.brandName(b.restaurant),
        open: fmtHMS(si.openSec), close: fmtHMS(si.closeSec),
        openSec: si.openSec, closeSec: si.closeSec,
        closed: !si.openNow, shiftDay: si.day,
        shiftKey: si.key + '#' + (b.ver || 0),
        rolloverDue: !!si.due,
        shift: { day: si.day, openSec: si.openSec, closeSec: si.closeSec, startAbs: si.startAbs, endAbs: si.endAbs },
        rows: self._scopeRows(u, built.rows, si, now),
        skipped: 0
      };
    });

    var allowedKeys = {};
    branches.forEach(function (b) { allowedKeys[b.key] = 1; });

    var menu = {};
    branches.forEach(function (b) { menu[b.key] = self.menuForBranch(rid, b.key); });

    var times = this.state[COL.times]
      .filter(function (t) {
        var rec = self._branchRecord(t.branch, t.restaurant);
        return !!(rec && allowedKeys[rec.key]);
      })
      .slice()
      .sort(function (a, b) { return String(a.at || '').localeCompare(String(b.at || '')); })
      .map(function (t) {
        var rec = self._branchRecord(t.branch, t.restaurant);
        return {
          b: rec ? rec.key : t.branch,
          prep: +t.prepMin || 0, del: +t.delMin || 0,
          by: t.by || '', at: t.at || ''
        };
      });

    var menuUnion = [], seenM = {};
    branches.forEach(function (b) {
      (menu[b.key] || []).forEach(function (it) {
        var k = keyOf(it.it);
        if (seenM[k]) return;
        seenM[k] = 1; menuUnion.push(it.it);
      });
    });

    var reasonsUnion = [], seenR = {};
    branches.forEach(function (b) {
      self.reasonsForBranch(rid, b.key).forEach(function (r) {
        var k = keyOf(r);
        if (seenR[k]) return;
        seenR[k] = 1; reasonsUnion.push(r);
      });
    });

    /* المطاعم: المدير العام يشوف الكل، غيره برانده بس (عزل البراندات) */
    var restaurants = visibleRestaurants(u, this.state[COL.restaurants])
      .map(function (r) { return { id: r.id, name: r.name, active: r.active !== false }; });

    return {
      generatedAt: now.key + ' ' + now.hms,
      now: now.key,
      nowSec: now.sec,
      me: {
        username: u.username || u.email, email: u.email || '', role: u.role, branch: u.branch,
        branches: Array.isArray(u.branches) ? u.branches : (u.branch ? [u.branch] : []),
        restaurant: u.restaurant || '', isAdmin: !!u.isAdmin
      },
      branches: branches,
      restaurants: restaurants,
      items: menuUnion,
      reasons: reasonsUnion,
      menus: (function () { var m = {}; restaurants.forEach(function (r) { m[r.id] = self.menuItemNames(r.id).map(function (x) { return x.it; }); }); return m; })(),
      reasonsByRest: (function () { var m = {}; restaurants.forEach(function (r) { m[r.id] = self.reasonsForRestaurant(r.id); }); return m; })(),
      reasonsByBranch: (function () { var m = {}; branches.forEach(function (b) { m[b.key] = self.reasonsForBranch(rid, b.key); }); return m; })(),
      menu: menu,
      times: times,
      hours: [],
      daily: [],
      shiftLog: [],
      roster: branches.map(function (b) {
        return { name: b.name, key: b.key, restaurant: b.restaurant, restaurantName: b.restaurantName };
      }),
      skipped: 0
    };
  }

  livePayload() {
    var u = this._require();
    var wanted = this._provider ? this._provider() : '';
    var global = this.isGlobal(u);
    var scoped = global && !!wanted;
    var rid = this.resolveRestaurant(u, wanted);
    var now = nowParts();
    var self = this;
    var allowed = this._allowedBranches(u, rid, scoped);

    var branches = allowed.map(function (b) {
      var si = self.shiftInfo(b, now);
      var stopped = self._openStops(b.key).map(function (s) { return s.item; });
      return {
        name: b.name, key: b.key,
        closed: !si.openNow,
        shiftDay: si.day,
        shiftKey: si.key + '#' + (b.ver || 0),
        openCount: stopped.length,
        stoppedItems: stopped
      };
    });
    var menu = {};
    allowed.forEach(function (b) { menu[b.key] = self.menuForBranch(rid, b.key); });
    var n = this._notifications(u, 100);
    return {
      rev: String(this.rev),
      notifications: n.items,
      unread: n.unread,
      menu: menu,
      branches: branches
    };
  }

  /* ---------------- notifications ---------------- */
  _notifVisible(n, u) {
    /* العزل كله في خدمة الصلاحيات (rbac-service):
       لا تسريب إشعارات بين براندات ولا بين فروع نفس البراند. */
    return notificationVisible(u, n);
  }

  _notifications(u, limitN) {
    var rows = this.state[COL.notif]
      .filter(function (n) { return this._notifVisible(n, u); }, this)
      .slice()
      .sort(function (a, b) { return String(b.at || '').localeCompare(String(a.at || '')); });
    var unread = rows.filter(function (n) {
      return !(Array.isArray(n.readBy) && n.readBy.indexOf(u.username) >= 0);
    }).length;
    var items = rows.slice(0, limitN || 100).map(function (n) {
      return {
        id: n.id, title: n.title || 'إشعار', body: n.body || '',
        at: n.at || '', read: Array.isArray(n.readBy) && n.readBy.indexOf(u.username) >= 0
      };
    });
    return { items: items, unread: unread };
  }

  async _notify(o) {
    var n = {
      at: nowIso(), restaurant: o.restaurant || '', branch: o.branch || '',
      roles: o.roles || [], targetUser: o.targetUser || '',
      title: o.title || 'إشعار', body: o.body || '',
      kind: o.kind || '', severity: o.severity || '', ref: o.ref || '',
      readBy: [], seq: Date.now() + Math.random()
    };
    var ref = await addDoc(collection(this.db, COL.notif), n);
    n.id = ref.id;
    /* مزامنة من Firestore (بدل push محلي) عشان ما يحصلش تكرار مع المستمع */
    await this._reload(COL.notif);
    this.rev++;
    this._emitSoon();
  }

  /* ---------------- audit / errors ---------------- */
  async _audit(user, action, target, details, result, ref) {
    var n = nowParts();
    var row = {
      at: n.key + ' ' + n.hms,
      by: user ? user.username : 'system',
      role: user ? user.role : 'system',
      action: action || '', target: String(target == null ? '' : target),
      details: typeof details === 'string' ? details : JSON.stringify(details || {}),
      result: result || 'OK', ref: String(ref == null ? '' : ref),
      seq: Date.now() + Math.random()
    };
    try {
      var r = await addDoc(collection(this.db, COL.audit), row);
      row.id = r.id;
      await this._reload(COL.audit);
    } catch (e) { /* السجل اختياري */ }
  }

  async _logError(u, action, code, message, detail, stack) {
    var n = nowParts();
    try {
      var r = await addDoc(collection(this.db, COL.errors), {
        at: n.key + ' ' + n.hms,
        action: action || '', by: u ? u.username : '', role: u ? u.role : '',
        code: code || '', message: message || '',
        detail: detail || '', stack: stack || '', seq: Date.now() + Math.random()
      });
      await this._reload(COL.errors);
    } catch (e) { }
  }

  /* ---------------- realtime ---------------- */
  _emitSoon() {
    if (this._emitTimer || !this._cb) return;
    var self = this;
    this._emitTimer = setTimeout(function () {
      self._emitTimer = null;
      self._emit();
    }, 80);
  }

  _emit() {
    if (!this._cb) return;
    var self = this;
    /* الحساب يتم تحت قفل الحالة، والواجهة بتتحدّث بره القفل (عشان ما يحصلش تداخل) */
    this._withLock('state', function () {
      if (!self._cb) return;
      try {
        self._pending = { data: self.scopedPayload(''), live: self.livePayload() };
      } catch (e) {
        self._pending = null;
        /* انتهاء الجلسة مش خطأ — الواجهة هتتعامل معاه */
        if (self._onErr && !/SESSION_EXPIRED/.test(String(e && e.message || ''))) self._onErr(e);
      }
    }).then(function () {
      var p = self._pending;
      self._pending = null;
      if (!p || !self._cb) return;
      try { self._cb(p.data, p.live); }
      catch (e) { if (self._onErr) self._onErr(e); }
    });
  }

  watch(cb, onErr, restaurantProvider) {
    this.stopWatch();
    this._cb = cb;
    this._onErr = onErr || null;
    this._provider = restaurantProvider || null;
    var self = this;
    var start = function () {
      ALL_COLS.forEach(function (name) {
        var un = onSnapshot(collection(self.db, name), function (snap) {
          /* التحديث من المستمع بيتعمل تحت قفل الحالة عشان ما يتداخلش مع سبع البذرة */
          self._withLock('state', function () {
            self.state[name] = snap.docs.map(function (d) { var o = d.data(); o.id = d.id; return o; });
            self._sort(name);
            self.loaded = true;
            self.rev++;
          });
          self._emitSoon();
        }, function (e) {
          if (self._onErr) self._onErr(e);
        });
        self._subs.push(un);
      });
      setTimeout(function () { self._emit(); }, 0);
    };
    this.hydrate().then(start).catch(function (e) {
      if (self._onErr) self._onErr(e);
    });
    return function () { self.stopWatch(); };
  }

  stopWatch() {
    this._subs.forEach(function (un) { try { un(); } catch (e) { } });
    this._subs = [];
    this._cb = null;
    this._provider = null;
    if (this._emitTimer) { clearTimeout(this._emitTimer); this._emitTimer = null; }
  }

  /* ============================================================
   *  ACTIONS
   * ============================================================ */

  async getDashboardData(force, restaurant) {
    var u = this._require();
    if (force) await this.hydrate(true);
    return this.scopedPayload(restaurant || '');
  }

  async pollState(since, restaurant) {
    var u = this._require();
    var wanted = restaurant || '';
    var global = this.isGlobal(u);
    var scoped = global && !!wanted;
    var rid = this.resolveRestaurant(u, wanted);
    var n = this._notifications(u, 100);
    if (String(since || '') === String(this.rev)) {
      return { unchanged: true, unread: n.unread, rev: String(this.rev) };
    }
    var oldProvider = this._provider;
    this._provider = function () { return wanted; };
    var live = this.livePayload();
    this._provider = oldProvider;
    return live;
  }

  async listNotifications(limitN) {
    var u = this._require();
    return this._notifications(u, limitN || 100);
  }

  async markNotificationsRead(ids) {
    var u = this._require();
    await this.hydrate();
    var wantedIds = Array.isArray(ids) ? ids : [];
    var all = !wantedIds.length;
    var rows = this.state[COL.notif].filter(function (n) {
      if (!this._notifVisible(n, u)) return false;
      if (Array.isArray(n.readBy) && n.readBy.indexOf(u.username) >= 0) return false;
      return all || wantedIds.indexOf(n.id) >= 0;
    }, this);
    for (var i = 0; i < rows.length; i += 400) {
      var batch = writeBatch(this.db);
      var self0 = this;
      rows.slice(i, i + 400).forEach(function (n) {
        batch.update(doc(self0.db, COL.notif, n.id), { readBy: arrayUnion(u.username) });
      });
      await batch.commit();
    }
    await this._reload(COL.notif);
    this.rev++;
    this._emitSoon();
    return this._notifications(u, 100);
  }

  /* ---------------- stop / resume ---------------- */
  async logStop(restaurant, branch, item, reason, note, scope) {
    var u = this._requireAny();
    /* العملية مسموحة للدور بس حسب إعدادات الأدوار (actions) */
    if (!this._roleCan(u, 'logStop')) throw err('دور حسابك مش مسموح يسجّل إيقاف.');
    if (this._roleScope(u) === 'branch') {
      restaurant = u.restaurant; branch = u.branch; scope = 'branch';
    }
    item = cleanText(item, 600);
    reason = cleanText(reason, 600);
    note = cleanText(note, 300);
    scope = keyOf(scope) === 'all' ? 'all' : 'branch';

    if (!item) throw err('اختار الصنف الأول.');
    if (!reason) throw err('لازم تختار سبب الإيقاف من القايمة.');
    if (keyOf(reason) === keyOf(UNSPEC)) throw err('مينفعش "' + UNSPEC + '" — اختار سبب حقيقي من القايمة.');
    if (isOtherReason(reason) && !note) throw err('اكتب وصف السبب (أسباب أخرى) الأول.');
    if (scope === 'all' && !restaurant) throw err('اختار البراند الأول.');
    if (scope !== 'all' && !branch) throw err('اختار الفرع.');

    var rid = '';
    if (restaurant) rid = this.resolveRestaurant(u, restaurant);
    if (!rid) {
      var probe = this._branchRecord(branch);
      if (!probe) throw err('الفرع "' + branch + '" غير موجود.');
      rid = probe.restaurant;
    }

    var targets;
    if (scope === 'all') {
      targets = this.state[COL.branches].filter(function (b) {
        return b.active !== false && same(b.restaurant, rid);
      });
      if (!targets.length) throw err('مفيش فروع مسجلة للبراند "' + this.brandName(rid) + '".');
    } else {
      var rec = this._branchRecord(branch, rid);
      if (!rec) throw err('الفرع "' + branch + '" غير موجود أو مش تابع للبراند المحدد.');
      targets = [rec];
    }

    var now = nowParts();
    var results = [], applied = 0, firstRow = null;
    for (var i = 0; i < targets.length; i++) {
      var r = await this._appendStop(targets[i], item, reason, note, now, u);
      if (r.ok) { applied++; if (firstRow === null) firstRow = r.row; }
      results.push(r);
    }
    if (!applied) {
      var bad = results.filter(function (x) { return !x.ok; });
      var why = bad.length ? bad[0].error : 'تعذر تسجيل الإيقاف.';
      throw err((scope === 'all'
        ? 'مقدرناش نوقف "' + item + '" في أي فرع من "' + this.brandName(rid) + '": '
        : 'مقدرناش نوقف "' + item + '" في "' + branch + '": ') + why);
    }

    this.rev++;
    this._emitSoon();
    await this._audit(u, 'STOP', rid + '/' + (scope === 'all' ? 'ALL' : targets[0].key) + '/' + item, { reason: reason, applied: applied }, 'OK');
    await this._notify({
      title: '⏸ إيقاف صنف: ' + item,
      body: (scope === 'all' ? 'كل فروع ' + this.brandName(rid) : targets[0].name) + ' — ' + reason,
      restaurant: rid, branch: scope === 'all' ? '' : targets[0].key,
      roles: this._notifyRoles(), kind: 'stop', severity: 'danger', ref: firstRow || ''
    });

    return {
      ok: true, scope: scope, restaurant: rid, restaurantName: this.brandName(rid),
      branch: scope === 'branch' ? targets[0].name : '', item: item, reason: reason,
      time: now.hms, applied: applied, skipped: results.length - applied,
      results: results, row: firstRow, data: this.scopedPayload(rid)
    };
  }

  async _appendStop(b, item, reason, note, now, u) {
    var out = { branch: b.name, key: b.key, ok: false, error: '' };
    try {
      var si = this.shiftInfo(b, now);
      if (!si.openNow) { out.error = 'الفرع مقفول حاليًا حسب مواعيد العمل.'; return out; }
      var itemsOk = this.menuForBranch(b.restaurant, b.key).some(function (x) { return keyOf(x.it) === keyOf(item); });
      if (!itemsOk) { out.error = 'الصنف مش في منيو الفرع.'; return out; }
      var reasonsOk = this.reasonsForBranch(b.restaurant, b.key).some(function (x) { return keyOf(x) === keyOf(reason); });
      if (!reasonsOk) { out.error = 'السبب مش في قايمة الفرع.'; return out; }
      var exists = this._openStops(b.key).filter(function (s) { return keyOf(s.item) === keyOf(item); })[0];
      if (exists) { out.error = 'الصنف موقوف بالفعل — سجّل له تشغيل الأول.'; return out; }

      var data = {
        date: now.key, item: item, itemKey: keyOf(item),
        stopSec: now.sec, startSec: null, reason: reason, note: note,
        restaurant: b.restaurant, branch: b.key, branchName: b.name,
        open: true, by: u.username, createdAt: nowIso(), updatedAt: nowIso(),
        seq: Date.now() + Math.random()
      };
      var ref = await addDoc(collection(this.db, COL.stops), data);
      data.id = ref.id;
      await this._reload(COL.stops);
      out.ok = true; out.row = ref.id;
      return out;
    } catch (e) {
      out.error = e && e.message ? e.message : String(e);
      return out;
    }
  }

  async resumeStop(branch, row, item) {
    var u = this._requireAny();
    /* العملية مسموحة للدور بس حسب إعدادات الأدوار (actions) */
    if (!this._roleCan(u, 'resumeStop')) throw err('دور حسابك مش مسموح يشغّل ايتم.');
    if (this._roleScope(u) === 'branch') branch = u.branch;
    branch = cleanText(branch, 60);
    item = cleanText(item, 600);
    var b = this._branchRecord(branch);
    if (!b) throw err('الفرع "' + branch + '" غير موجود.');
    if (this._roleScope(u) === 'branch' && !same(u.branch, b.key) && !same(u.branch, b.name)) {
      throw err('مش مسموح بتشغيل ايتم في فرع تاني.');
    }
    var s = this.state[COL.stops].filter(function (x) { return x.id === row; })[0];
    if (!s) s = this._openStops(b.key).filter(function (x) { return keyOf(x.item) === keyOf(item); })[0];
    if (!s) throw err('الصف اتغيّر من ساعة ما فتحت الصفحة، حدّث الداتا وجرّب تاني.');
    if (keyOf(s.item) !== keyOf(item)) throw err('الصف اتغيّر من ساعة ما فتحت الصفحة، حدّث الداتا وجرّب تاني.');
    if (!(s.startSec === null || s.startSec === undefined || s.startSec === '')) throw err('الايتم ده اتسجل له تشغيل بالفعل.');

    var now = nowParts();
    var dur = (now.sec - (+s.stopSec || 0) + 86400) % 86400;
    await updateDoc(doc(this.db, COL.stops, s.id), {
      startSec: now.sec, open: false, durationSec: dur, updatedAt: nowIso(), updatedBy: u.username
    });
    await this._reload(COL.stops);
    this.rev++;
    this._emitSoon();
    await this._audit(u, 'RESUME', b.restaurant + '/' + b.key + '/' + item, { durationSec: dur }, 'OK');
    await this._notify({
      title: '▶ تشغيل صنف: ' + item,
      body: b.name + ' — رجع الساعة ' + fmtHMS(now.sec),
      restaurant: b.restaurant, branch: b.key,
      roles: this._notifyRoles(), kind: 'resume', severity: 'ok', ref: s.id
    });
    return { ok: true, time: now.hms, data: this.scopedPayload(b.restaurant) };
  }

  async getStopOptions(restaurant) {
    var u = this._requireAny();
    var rid = this.resolveRestaurant(u, restaurant);
    var now = nowParts();
    var self = this;
    var scoped = this.isGlobal(u) && !!restaurant;
    var allowed = this._allowedBranches(u, rid, scoped);

    var branches = allowed.map(function (b) {
      var si = self.shiftInfo(b, now);
      var stopped = [], seen = {};
      self._openStops(b.key).forEach(function (s) {
        var it = norm(s.item);
        if (!it || seen[keyOf(it)]) return;
        seen[keyOf(it)] = 1; stopped.push(it);
      });
      return {
        key: b.key, name: b.name, restaurant: b.restaurant,
        brandName: self.brandName(b.restaurant),
        closed: !si.openNow, open: fmtHMS(si.openSec), close: fmtHMS(si.closeSec),
        items: self.menuForBranch(b.restaurant, b.key).map(function (x) { return x.it; }),
        reasons: self.reasonsForBranch(b.restaurant, b.key),
        stopped: stopped
      };
    });

    var brands = this.state[COL.restaurants].filter(function (r) {
      return r.active !== false && (self.isGlobal(u) || same(r.id, rid));
    }).map(function (r) { return { id: r.id, name: r.name }; });

    return {
      ok: true, restaurant: rid, restaurantName: this.brandName(rid),
      brands: brands, branches: branches
    };
  }

  async clearAllData(password) {
    var u = this._requireManager();
    if (!this.isGlobal(u)) throw err('العملية دي متاحة لمدير النظام فقط.');
    await this._reauth(password);
    var target = this.isGlobal(u) ? null : this.resolveRestaurant(u, '');
    var allowed = this._allowedBranches(u, target || '', false);
    var keys = {};
    allowed.forEach(function (b) { keys[b.key] = 1; });
    var rows = this.state[COL.stops].filter(function (s) { return keys[s.branch]; });
    var counts = {};
    allowed.forEach(function (b) { counts[b.key] = 0; });
    rows.forEach(function (s) { counts[s.branch] = (counts[s.branch] || 0) + 1; });

    for (var i = 0; i < rows.length; i += 400) {
      var batch = writeBatch(this.db);
      var self1 = this;
      rows.slice(i, i + 400).forEach(function (s) { batch.delete(doc(self1.db, COL.stops, s.id)); });
      await batch.commit();
    }
    this.state[COL.stops] = this.state[COL.stops].filter(function (s) { return !keys[s.branch]; });
    this.rev++;
    this._emitSoon();
    await this._audit(u, 'DATA_CLEAR_ALL', 'ALL', { branches: allowed.length, rows: rows.length }, 'OK');
    return {
      ok: true,
      cleared: allowed.map(function (b) { return { branch: b.name, rows: counts[b.key] || 0 }; }),
      total: rows.length,
      data: this.scopedPayload(target || '')
    };
  }

  /* ---------------- users ---------------- */
  _usersPublic() {
    var u = this._require();
    var global = this.isGlobal(u);
    var self = this;
    return this.state[COL.users].filter(function (x) {
      return global || !x.restaurant || same(x.restaurant, u.restaurant);
    }).map(function (x) {
      var branch = x.branch || '';
      var list = Array.isArray(x.branches) ? x.branches.slice() : (branch ? [branch] : []);
      if (branch && self._roleScope(x) === 'branch') {
        var rec = self._branchRecord(branch, x.restaurant || null);
        if (rec) branch = rec.key;
      }
      list = list.map(function (k) {
        var r2 = self._branchRecord(k, x.restaurant || null);
        return r2 ? r2.key : k;
      });
      return {
        username: x.email || x.username, display: x.username || '',
        role: x.role, branch: branch, branches: list,
        active: x.active !== false, restaurant: x.restaurant || '',
        isAdmin: !!x.isAdmin
      };
    });
  }

  async listUsers() {
    this._requireManager();
    return this._usersPublic();
  }

  async saveUser(input) {
    var me = this._requireManager();
    var u = input || {};
    var rawName = cleanText(u.username, 120).replace(/\s+/g, '');
    if (!rawName) throw err('اكتب اسم المستخدم.');
    /* اسم المستخدم = إيميل Firebase Auth (لو بدون @ بنضيف دومين المشروع) */
    var email = this._authEmail(rawName);
    var display = this._displayName(email);
    if (!/^[A-Za-z0-9_.-]{2,30}$/.test(display)) throw err('اسم المستخدم لازم يكون حروف/أرقام إنجليزي (2–30).');
    /* الدور بيتقرأ من إعدادات الأدوار (config/roles) — مش قائمة ثابتة في الكود */
    if (!Object.keys(this._roleMap).length) { await this.getRoleConfig(); }
    var roleInput = cleanText(u.role, 40);
    var role = this._resolveRoleKey(roleInput);
    if (!role || !this._roleMap[role]) throw err('الدور المختار مش معروف. اتأكد من إعدادات الأدوار.');
    var restaurant = cleanText(u.restaurant, 40);
    if (!this.isGlobal(me)) restaurant = me.restaurant;
    if (this._roleScope({ role: role }) === 'all' && this.isGlobal(me) && !restaurant && u.isAdmin) restaurant = '';
    /* صلاحية "مدير النظام" من إعدادات الأدوار — المانجمنت العادي مش بيقدر يديها */
    var roleDef = this._roleDef(role);
    var isAdmin = roleDef.grantAdmin === true ? !!u.isAdmin : false;
    if (isAdmin && !this.isGlobal(me)) throw err('صلاحية مدير النظام متاحة لمدير النظام الحالي فقط.');
    var existing = this._findUser(email) || this._findUser(display);
    var password = String(u.password || '');
    if (existing && existing.usernameKey === keyOf(me.username) && (u.active === false)) {
      throw err('مينفعش توقف حسابك الحالي.');
    }
    /* تغيير باسورد الحساب الحالي بس (Firebase Auth) — الباقي بينشأ أول ما يسجل دخول */
    if (password && existing && same(existing.email || '', (this.auth && this.auth.currentUser ? this.auth.currentUser.email : ''))) {
      await this.changeMyPassword(password);
    } else if (password && !existing) {
      throw err('كلمة السر للمستخدم الجديد بتحدده هو أول ما يسجل دخول بإيميله.');
    }
    /* ممنوع تغيير إيميل حسابك الحالي */
    var myEmail = (this.auth && this.auth.currentUser) ? this.auth.currentUser.email : '';
    if (existing && same(existing.email || '', myEmail) && !same(existing.email || '', email)) {
      throw err('مينفعش تغيّر إيميل حسابك الحالي.');
    }

    /* الفروع: قائمة فروع (اختيار واحد أو "إضافة الكل" = كل فروع المطعم) */
    var branchList = [];
    if (this._roleScope({ role: role }) !== 'all') {
      var raw = u.branches;
      if (Array.isArray(raw)) branchList = raw.map(function (x) { return cleanText(x, 60); }).filter(Boolean);
      else if (cleanText(u.branch, 60) === 'all') branchList = ['all'];
      else branchList = [cleanText(u.branch, 60)];
      if (!branchList.length) throw err('اختار الفرع.');
      var restForBranches = restaurant || null;
      if (branchList.length === 1 && keyOf(branchList[0]) === 'all') {
        /* كل فروع المطعم المختار */
        var all = this.state[COL.branches].filter(function (b) {
          return b.active !== false && (!restForBranches || same(b.restaurant, restForBranches));
        });
        if (!all.length) throw err('المطعم المختار مفيهوش فروع.');
        branchList = all.map(function (b) { return b.key; });
        restaurant = all[0].restaurant;
      } else {
        var recs = [];
        for (var i = 0; i < branchList.length; i++) {
          var rec = this._branchRecord(branchList[i], restForBranches);
          if (!rec) throw err('الفرع غير موجود أو مش تابع للمطعم.');
          recs.push(rec);
        }
        branchList = recs.map(function (r) { return r.key; });
        restaurant = recs[0].restaurant;
      }
    }
    var branch = this._roleScope({ role: role }) === 'all' ? '' : (branchList[0] || '');

    var data = {
      username: display, usernameKey: keyOf(email), email: email,
      role: role, branch: branch, branches: branchList, restaurant: restaurant || '',
      isAdmin: isAdmin, active: u.active !== false,
      updatedAt: nowIso(), updatedBy: me.username
    };
    if (existing) {
      data.ver = existing.ver || this._randHex(8);
      data.createdAt = existing.createdAt || nowIso();
      await setDoc(doc(this.db, COL.users, existing.id), data, { merge: true });
    } else {
      data.ver = this._randHex(8);
      data.createdAt = nowIso();
      data.seq = Date.now();
      data.uid = '';
      /* معرّف ثابت للإيميل → مستحيل يتعمل يوزر بنفس الإيميل مرتين */
      await setDoc(doc(this.db, COL.users, keyOf(email)), data);
    }
    await this._reload(COL.users);
    /* لو اليوزر عدّل حسابه: الجلسة الحالية تفضل شغالة، وباقي الأجهزة تخرج (ver اتغير) */
    if (this.session && this.session.user && same(this.session.user.username, display)) {
      var fresh = this._findUser(email);
      if (fresh) { this.session.user = fresh; this.session.ver = fresh.ver || ''; }
    }
    /* يوزر جديد: نحاول نبعتله إيميل "اضبط كلمة السر" (best-effort) */
    var resetNote = '';
    if (!existing && this.authService && typeof this.authService.sendPasswordReset === 'function') {
      try {
        var rs = await this.authService.sendPasswordReset(email);
        resetNote = rs && rs.ok ? 'reset-sent' : 'no-auth-account';
      } catch (e) { resetNote = 'no-auth-account'; }
    }
    await this._audit(me, existing ? 'USER_UPDATE' : 'USER_CREATE', email, { role: role, active: data.active, reset: resetNote }, 'OK');
    var list = this._usersPublic();
    if (!existing) list.resetNote = resetNote;
    return list;
  }

  async createBranchUsers() {
    var me = this._requireManager();
    if (!this.isGlobal(me)) throw err('إنشاء يوزرات الفروع متاح لمدير النظام فقط.');
    var created = [], self = this;
    var branches = this.state[COL.branches].filter(function (b) { return b.active !== false; });
    for (var i = 0; i < branches.length; i++) {
      var b = branches[i];
      var has = this.state[COL.users].some(function (x) {
        return x.active !== false && (same(x.branch, b.key));
      });
      if (has) continue;
      var base = keyOf(b.name).replace(/[^a-z0-9]+/g, '') || ('branch' + i);
      var username = base.slice(0, 24), n = 1;
      while (this._findUser(username)) { username = (base.slice(0, 20) + (n++)); }
      var email = this._authEmail(username);
      var data = {
        username: username, usernameKey: keyOf(email), email: email, uid: '',
        role: this._defaultScopedRole(), branch: b.key, restaurant: b.restaurant,
        isAdmin: false, active: true, ver: this._randHex(8),
        createdAt: nowIso(), createdBy: me.username, seq: Date.now() + i
      };
      await setDoc(doc(this.db, COL.users, keyOf(email)), data);
      created.push({ branch: b.name, username: email, password: 'يتحدد أول ما يسجل دخول بإيميله' });
    }
    await this._reload(COL.users);
    await this._audit(me, 'CREATE_BRANCH_USERS', 'ALL', { created: created.length }, 'OK');
    return { ok: true, created: created, users: this._usersPublic() };
  }

  async deleteUser(username, password) {
    var me = this._requireManager();
    if (!this.isGlobal(me)) throw err('حذف المستخدمين متاح لمدير النظام فقط.');
    await this._reauth(password);
    var target = this._findUser(username);
    if (!target) throw err('المستخدم غير موجود.');
    if (same(target.username, me.username)) throw err('مينفعش تحذف حسابك الحالي.');
    var admins = this.state[COL.users].filter(function (x) { return x.active !== false && x.isAdmin; });
    if (target.isAdmin && admins.length <= 1) throw err('مينفعش تحذف آخر مدير نظام نشط.');
    await deleteDoc(doc(this.db, COL.users, target.id));
    this.state[COL.users] = this.state[COL.users].filter(function (x) { return x.id !== target.id; });
    await this._audit(me, 'USER_DELETE', target.username, { role: target.role }, 'OK');
    return this._usersPublic();
  }

  /* ---------------- audit / errors ---------------- */
  async getAuditLog(limitN) {
    var me = this._requireManager();
    if (!this.isGlobal(me)) throw err('سجل العمليات متاح للأدمن العام فقط.');
    await this.hydrate();
    var entries = this.state[COL.audit].slice()
      .sort(function (a, b) { return String(b.at || '').localeCompare(String(a.at || '')); })
      .slice(0, limitN || 200)
      .map(function (e) {
        return { at: e.at, by: e.by, role: e.role, action: e.action, target: e.target, details: e.details, result: e.result, ref: e.ref };
      });
    return { ok: true, entries: entries };
  }

  async getErrorLog(limitN) {
    this._requireManager();
    await this.hydrate();
    var entries = this.state[COL.errors].slice()
      .sort(function (a, b) { return String(b.at || '').localeCompare(String(a.at || '')); })
      .slice(0, limitN || 200)
      .map(function (e) {
        return { at: e.at, action: e.action, by: e.by, role: e.role, code: e.code, message: e.message, detail: e.detail, stack: e.stack };
      });
    return { ok: true, entries: entries };
  }

  /* ---------------- branches ---------------- */
  async branchDeleteInfo(name) {
    this._requireManager();
    var b = this._branchRecord(name);
    if (!b) return null;
    var rows = this.state[COL.stops].filter(function (s) { return same(s.branch, b.key); });
    var openRows = rows.filter(function (s) { return s.open !== false && (s.startSec === null || s.startSec === undefined || s.startSec === ''); });
    var users = this.state[COL.users].filter(function (u) { return same(u.branch, b.key); });
    var times = this.state[COL.times].filter(function (t) { return same(t.branch, b.key); });
    return {
      name: b.name, key: b.key, restaurant: b.restaurant,
      rows: rows.length, openRows: openRows.length,
      branches: this.state[COL.branches].filter(function (x) { return x.active !== false; }).length,
      users: users.map(function (u) { return { username: u.username, active: u.active !== false }; }),
      hoursRows: 0, timesRows: times.length
    };
  }

  async deleteBranch(info) {
    var me = this._requireManager();
    if (!this.isGlobal(me)) throw err('حذف الفروع متاح لمدير النظام فقط.');
    info = info || {};
    var b = this._branchRecord(info.name, info.restaurant || null);
    if (!b) throw err('الفرع غير موجود.');
    if (same(info.confirm, '') || !same(info.confirm, b.name)) throw err('اسم الفرع مش مطابق للتأكيد.');
    await this._reauth(info.password);
    if (!info.ack) throw err('لازم توافق على الحذف الأول.');
    var activeBranches = this.state[COL.branches].filter(function (x) { return x.active !== false; });
    if (activeBranches.length <= 1) throw err('مينفعش تحذف آخر فرع في النظام.');
    var rows = this.state[COL.stops].filter(function (s) { return same(s.branch, b.key); });
    if (info.mode !== 'cascade' && rows.length) {
      throw err('الفرع فيه ' + rows.length + ' سجل تشغيل. اختار الأرشفة الكاملة (Cascade) أو انقل السجلات الأول.');
    }
    var archiveId = 'ARCH-' + Date.now().toString(36).toUpperCase();
    if (rows.length) {
      for (var i = 0; i < rows.length; i += 400) {
        var batch = writeBatch(this.db);
        var self2 = this;
        rows.slice(i, i + 400).forEach(function (s) { batch.delete(doc(self2.db, COL.stops, s.id)); });
        await batch.commit();
      }
    }
    this.state[COL.stops] = this.state[COL.stops].filter(function (s) { return !same(s.branch, b.key); });

    var times = this.state[COL.times].filter(function (t) { return same(t.branch, b.key); });
    for (var j = 0; j < times.length; j++) await deleteDoc(doc(this.db, COL.times, times[j].id));
    this.state[COL.times] = this.state[COL.times].filter(function (t) { return !same(t.branch, b.key); });

    /* اليوزرات المرتبطة بالفرع: نشيله من قايمة فروعهم ونوقفهم */
    var users = this.state[COL.users].filter(function (u) {
      var list = Array.isArray(u.branches) ? u.branches : (u.branch ? [u.branch] : []);
      return list.some(function (k) { return same(k, b.key); });
    });
    for (var k = 0; k < users.length; k++) {
      var oldList = Array.isArray(users[k].branches) ? users[k].branches.slice() : (users[k].branch ? [users[k].branch] : []);
      var newList = oldList.filter(function (x) { return !same(x, b.key); });
      var patch = {
        branches: newList, branch: newList[0] || '',
        active: false, ver: this._randHex(8), updatedAt: nowIso()
      };
      await updateDoc(doc(this.db, COL.users, users[k].id), patch);
      users[k].branches = newList; users[k].branch = patch.branch;
      users[k].active = false;
    }

    await deleteDoc(doc(this.db, COL.branches, b.key));
    this.state[COL.branches] = this.state[COL.branches].filter(function (x) { return x.id !== b.key && x.key !== b.key; });
    this.rev++;
    this._emitSoon();
    await this._audit(me, 'BRANCH_DELETE', b.name, { mode: info.mode, rows: rows.length, archiveId: archiveId }, 'OK', archiveId);
    return {
      ok: true, name: b.name, key: b.key, archived: info.mode === 'cascade',
      archiveId: archiveId, rows: rows.length, openRows: rows.filter(function (s) { return s.open !== false; }).length,
      usersDeactivated: users.length, data: this.scopedPayload(b.restaurant)
    };
  }

  _branchKey(name, restaurant) {
    var dup = this.state[COL.branches].filter(function (b) {
      return same(b.restaurant, restaurant) && same(b.name, name);
    })[0];
    if (dup) throw err('يوجد فرع بنفس الاسم في هذا المطعم بالفعل.');
    var base = keyOf(name).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if (!base) base = 'branch-' + Date.now().toString(36);
    var key = base, n = 1;
    while (this.state[COL.branches].some(function (b) { return b.key === key; })) {
      key = base + '-' + (n++);
    }
    return key;
  }

  async createBranch(info) {
    var me = this._requireManager();
    if (!this.isGlobal(me)) throw err('إضافة الفروع متاح لمدير النظام فقط.');
    info = info || {};
    var name = cleanText(info.name, 60);
    if (!name) throw err('اكتب اسم الفرع.');
    var rid = this.resolveRestaurant(me, info.restaurant);
    if (!rid) throw err('اختار المطعم.');
    var openSec = parseSec(info.open); if (openSec === null) openSec = 9 * 3600;
    var closeSec = parseSec(info.close); if (closeSec === null) closeSec = 5 * 3600;
    if (openSec === closeSec) throw err('وقت الفتح ووقت القفل مينفعش يكونوا نفس الوقت.');
    var prep = Math.round(Number(info.prep));
    var del = Math.round(Number(info.del));
    if (!isFinite(prep) || prep < 0 || prep > 600) prep = 10;
    if (!isFinite(del) || del < 0 || del > 600) del = 30;
    var key = this._branchKey(name, rid);

    var b = {
      key: key, name: name, restaurant: rid, active: true,
      openSec: openSec, closeSec: closeSec, days: null, ver: 1,
      createdAt: nowIso(), createdBy: me.username, seq: Date.now()
    };
    await setDoc(doc(this.db, COL.branches, key), b);

    var t = {
      branch: key, restaurant: rid, prepMin: prep, delMin: del,
      by: me.username, at: nowParts().key, createdAt: nowIso(), seq: Date.now()
    };
    await addDoc(collection(this.db, COL.times), t);

    var userOut = null, userError = '';
    if (info.createUser) {
      try {
        var uname = cleanText(info.username, 30).replace(/\s+/g, '');
        if (!uname) uname = key.replace(/-/g, '').slice(0, 24);
        var uemail = this._authEmail(uname);
        if (this._findUser(uemail)) throw err('اسم المستخدم موجود بالفعل.');
        var data = {
          username: this._displayName(uemail), usernameKey: keyOf(uemail), email: uemail, uid: '',
          role: this._defaultScopedRole(), branch: key, restaurant: rid, isAdmin: false, active: true,
          ver: this._randHex(8), createdAt: nowIso(), createdBy: me.username, seq: Date.now()
        };
        await setDoc(doc(this.db, COL.users, keyOf(uemail)), data);
        userOut = { username: uemail, password: 'يتحدد أول ما يسجل دخول بإيميله' };
      } catch (e) { userError = e && e.message ? e.message : String(e); }
    }

    await this._reloadMany([COL.branches, COL.times, COL.users]);
    this.rev++;
    this._emitSoon();
    await this._audit(me, 'BRANCH_CREATE', name, { restaurant: rid, prep: prep, del: del }, 'OK');
    return {
      ok: true, name: name, key: key, open: fmtHMS(openSec), close: fmtHMS(closeSec),
      prep: prep, del: del, user: userOut, userError: userError,
      data: this.scopedPayload(rid)
    };
  }

  async saveBranchHours(branch, open, close, restaurant) {
    var me = this._requireAny();
    if (this._roleScope(me) === 'branch') branch = me.branch;
    var b = this._branchRecord(branch, restaurant || null);
    if (!b) throw err('الفرع غير موجود.');
    var o = parseSec(open), c = parseSec(close);
    if (o === null || c === null) throw err('حدد وقت الفتح ووقت القفل.');
    if (o === c) throw err('وقت الفتح ووقت القفل مينفعش يكونوا نفس الوقت.');
    await updateDoc(doc(this.db, COL.branches, b.key), {
      openSec: o, closeSec: c, days: null, ver: Date.now(), updatedAt: nowIso(), updatedBy: me.username
    });
    b.openSec = o; b.closeSec = c; b.days = null; b.ver = Date.now();
    await this._reload(COL.branches);
    this.rev++;
    this._emitSoon();
    await this._audit(me, 'HOURS_UPDATE', b.name, { open: fmtHMS(o), close: fmtHMS(c) }, 'OK');
    return { ok: true, name: b.name, key: b.key, open: fmtHMS(o), close: fmtHMS(c), data: this.scopedPayload(b.restaurant) };
  }

  async saveBranchTimes(branch, prepMin, delMin) {
    var me = this._requireAny();
    if (this._roleScope(me) === 'branch') branch = me.branch;
    var b = this._branchRecord(branch);
    if (!b) throw err('الفرع غير موجود.');
    var prep = Math.round(Number(prepMin)), del = Math.round(Number(delMin));
    if (!isFinite(prep) || prep < 0 || prep > 600) throw err('وقت التحضير لازم يكون من 0 لـ 600 دقيقة.');
    if (!isFinite(del) || del < 0 || del > 600) throw err('وقت التوصيل لازم يكون من 0 لـ 600 دقيقة.');
    var last = null;
    this.state[COL.times].forEach(function (t) { if (same(t.branch, b.key)) last = t; });
    if (last && +last.prepMin === prep && +last.delMin === del) {
      return { ok: true, branch: b.name, prep: prep, del: del, total: prep + del, data: this.scopedPayload(b.restaurant) };
    }
    var row = {
      branch: b.key, restaurant: b.restaurant, prepMin: prep, delMin: del,
      by: me.username, at: nowParts().key, createdAt: nowIso(), seq: Date.now()
    };
    await addDoc(collection(this.db, COL.times), row);
    await this._reload(COL.times);
    this.rev++;
    this._emitSoon();
    await this._audit(me, 'TIMES_UPDATE', b.name, { prep: prep, del: del }, 'OK');
    return { ok: true, branch: b.name, prep: prep, del: del, total: prep + del, data: this.scopedPayload(b.restaurant) };
  }

  /* ---------------- restaurants ---------------- */
  async listRestaurants() {
    var me = this._requireManager();
    await this.hydrate();
    var global = this.isGlobal(me);
    return {
      ok: true,
      restaurants: this.state[COL.restaurants].filter(function (r) { return global || same(r.id, me.restaurant); }).map(function (r) {
        return { id: r.id, name: r.name, active: r.active !== false };
      }),
      branches: this.state[COL.branches].map(function (b) {
        return { key: b.key, name: b.name, restaurant: b.restaurant };
      })
    };
  }

  async saveRestaurant(info) {
    var me = this._requireManager();
    if (!this.isGlobal(me)) throw err('إدارة المطاعم متاحة لمدير النظام فقط.');
    info = info || {};
    var name = cleanText(info.name, 80);
    if (!name) throw err('اكتب اسم المطعم.');
    var id = cleanText(info.id, 40) || ('R' + Date.now().toString(36).toUpperCase());
    var existing = this.state[COL.restaurants].filter(function (r) { return same(r.id, id); })[0];
    var row = {
      id: id, name: name, active: info.active !== false,
      createdAt: existing ? existing.createdAt : nowIso(),
      createdBy: existing ? existing.createdBy : me.username,
      seq: existing ? existing.seq : Date.now()
    };
    await setDoc(doc(this.db, COL.restaurants, id), row, { merge: true });
    await this._reload(COL.restaurants);
    this.rev++;
    this._emitSoon();
    await this._audit(me, existing ? 'RESTAURANT_UPDATE' : 'RESTAURANT_CREATE', id, { name: name }, 'OK');
    return { ok: true, restaurant: { id: id, name: name, active: row.active }, data: this.scopedPayload(id) };
  }

  async deleteRestaurant(info) {
    var me = this._requireManager();
    if (!this.isGlobal(me)) throw err('حذف المطاعم متاح لمدير النظام فقط.');
    info = info || {};
    var rid = cleanText(info.id, 40);
    if (!rid) throw err('مطعم غير صحيح.');
    if (!same(info.confirm, rid)) throw err('كود المطعم مش مطابق للتأكيد.');
    await this._reauth(info.password);
    var hasBranches = this.state[COL.branches].some(function (b) { return same(b.restaurant, rid); });
    if (hasBranches) throw err('لازم تحذف فروع المطعم الأول.');
    var self = this;
    var collections = [COL.menu, COL.reasons, COL.times];
    for (var ci = 0; ci < collections.length; ci++) {
      var name = collections[ci];
      var rows = this.state[name].filter(function (x) { return same(x.restaurant, rid); });
      for (var i = 0; i < rows.length; i += 400) {
        var batch = writeBatch(this.db);
        rows.slice(i, i + 400).forEach(function (x) { batch.delete(doc(self.db, name, x.id)); });
        await batch.commit();
      }
      this.state[name] = this.state[name].filter(function (x) { return !same(x.restaurant, rid); });
    }
    await deleteDoc(doc(this.db, COL.restaurants, rid));
    this.state[COL.restaurants] = this.state[COL.restaurants].filter(function (r) { return !same(r.id, rid); });
    this.rev++;
    this._emitSoon();
    await this._audit(me, 'RESTAURANT_DELETE', rid, '', 'OK');
    return { ok: true, data: this.scopedPayload('') };
  }

  /* ---------------- menu admin ---------------- */
  async listMenu(restaurant, branch) {
    var me = this._requireManager();
    await this.hydrate();
    var rid = this.resolveRestaurant(me, restaurant);
    var recs = this.state[COL.branches].filter(function (b) { return same(b.restaurant, rid); });
    if (!branch) throw err('اختار الفرع أو كل الفروع قبل عرض المنيو.');
    var self = this;
    var byBranch = {};
    recs.forEach(function (b) { byBranch[b.key] = self.menuForBranch(rid, b.key); });
    var allBranches = keyOf(branch) === 'all';
    var selected = allBranches ? null : this._branchRecord(branch, rid);
    if (!allBranches && !selected) throw err('الفرع غير موجود في المطعم المحدد.');
    return {
      ok: true, restaurant: rid,
      restaurants: this.state[COL.restaurants].filter(function (r) { return self.isGlobal(me) || same(r.id, me.restaurant); }),
      branches: recs.map(function (b) { return { key: b.key, name: b.name }; }),
      items: allBranches ? this.menuForRestaurant(rid) : (byBranch[selected.key] || []),
      scope: allBranches ? 'all' : selected.key,
      byBranch: byBranch, reasons: this.reasonsForRestaurant(rid)
    };
  }

  async saveMenuItem(info) {
    var me = this._requireManager();
    info = info || {};
    var rid = this.resolveRestaurant(me, info.restaurant);
    var allBranches = info.scope === 'all' || info.allBranches === true;
    var branchKey = cleanText(info.branch, 80);
    if (!allBranches) {
      var rec = this._branchRecord(branchKey, rid);
      if (!rec) throw err('اختار فرعًا تابعًا للمطعم المحدد.');
      branchKey = rec.key;
    }
    var item = cleanText(info.item, 600);
    if (!item) throw err('اكتب اسم الصنف.');
    var cat = cleanText(info.category, 60);
    var price = num(info.price);
    if (price !== null && (price < 0 || price > 100000)) throw err('السعر غير صحيح.');
    var avail = info.available !== false;
    var self = this;
    var targets = allBranches
      ? [''].concat(this.state[COL.branches].filter(function (b) { return same(b.restaurant, rid); }).map(function (b) { return b.key; }))
      : [branchKey];

    for (var i = 0; i < targets.length; i++) {
      var scopeBranch = targets[i];
      var existing = this.state[COL.menu].filter(function (r) {
        return same(r.restaurant, rid) && same(r.branch, scopeBranch) && keyOf(r.item) === keyOf(item);
      })[0];
      var row = {
        restaurant: rid, branch: scopeBranch, item: item, itemKey: keyOf(item),
        category: cat, price: price, available: avail, active: true,
        updatedBy: me.username, updatedAt: nowIso()
      };
      if (existing) {
        await setDoc(doc(this.db, COL.menu, existing.id), row, { merge: true });
      } else {
        row.seq = Date.now() + i;
        await addDoc(collection(this.db, COL.menu), row);
      }
    }
    await this._reload(COL.menu);
    this.rev++;
    this._emitSoon();
    await this._audit(me, 'MENU_SAVE', rid + '/' + (allBranches ? 'ALL' : branchKey) + '/' + item, { available: avail, price: price }, 'OK');
    return { ok: true, item: item, available: avail, scope: allBranches ? 'all' : branchKey, data: this.scopedPayload(rid) };
  }

  /**
   * استيراد منيو من ملف Excel (أو CSV) لفرع واحد أو كل فروع البراند.
   * @param restaurant  معرّف البراند (brandId)
   * @param branchKeys  قائمة مفاتيح الفروع (branchId)
   * @param items       [{item, category, price, available}]
   */
  async importMenuItems(restaurant, branchKeys, items) {
    var me = this._requireManager();
    if (!this.isGlobal(me)) throw err('استيراد المنيو متاح لمدير النظام فقط.');
    var rid = this.resolveRestaurant(me, restaurant);
    if (!rid) throw err('اختار المطعم (البراند) الأول.');
    if (!Array.isArray(branchKeys) || !branchKeys.length) throw err('اختار فرع واحد على الأقل.');
    if (!Array.isArray(items) || !items.length) throw err('الملف مفيهوش أصناف.');

    /* تنظيف + تحقق من كل صنف */
    var clean = [], seen = {};
    for (var i = 0; i < items.length; i++) {
      var it = items[i] || {};
      var name = cleanText(it.item, 200);
      if (!name) continue;
      var k = keyOf(name);
      if (seen[k]) continue;          /* تكرار في نفس الملف */
      seen[k] = 1;
      var price = num(it.price);
      clean.push({
        item: name,
        category: cleanText(it.category, 100),
        price: (price !== null && price >= 0) ? price : null,
        available: it.available !== false
      });
    }
    if (!clean.length) throw err('مفيش أصناف صالحة في الملف.');

    /* الفروع لازم تكون موجودة وتتبع البراند المختار */
    var self = this, recs = [];
    for (var b = 0; b < branchKeys.length; b++) {
      var rec = this._branchRecord(branchKeys[b], rid);
      if (!rec) throw err('في فرع مش موجود أو مش تابع للمطعم المختار.');
      recs.push(rec);
    }

    /* الكتابة: صنف واحد واحد (أو update لو موجود) */
    var written = 0;
    for (var bi = 0; bi < recs.length; bi++) {
      var branchKey = recs[bi].key;
      for (var ci = 0; ci < clean.length; ci++) {
        var item = clean[ci];
        var existing = this.state[COL.menu].filter(function (r) {
          return same(r.restaurant, rid) && same(r.branch, branchKey) && keyOf(r.item) === keyOf(item.item);
        })[0];
        var row = {
          restaurant: rid, branch: branchKey, item: item.item, itemKey: keyOf(item.item),
          category: item.category, price: item.price, available: item.available, active: true,
          updatedBy: me.username, updatedAt: nowIso()
        };
        if (existing) {
          await setDoc(doc(self.db, COL.menu, existing.id), row, { merge: true });
        } else {
          row.seq = Date.now() + ci;
          await addDoc(collection(self.db, COL.menu), row);
        }
        written++;
      }
    }
    await this._reload(COL.menu);
    this.rev++;
    this._emitSoon();
    await this._audit(me, 'MENU_IMPORT', rid + '/' + recs.map(function (r) { return r.key; }).join(','), {
      items: clean.length, branches: recs.length, written: written
    }, 'OK');
    return {
      ok: true, written: written, items: clean.length,
      branches: recs.map(function (r) { return { key: r.key, name: r.name }; }),
      restaurant: rid,
      data: this.scopedPayload(rid)
    };
  }

  async setItemAvailability(branch, item, available, scope, restaurant) {
    var me = this._requireManager();
    var rid = this.resolveRestaurant(me, restaurant);
    var allBranches = scope === 'all' || !branch || keyOf(branch) === 'all';
    var rec = allBranches ? null : this._branchRecord(branch, rid);
    if (!allBranches && !rec) throw err('الفرع غير موجود في المطعم المحدد.');
    item = cleanText(item, 600);
    if (!item) throw err('اختار الصنف.');
    var on = !(available === false || available === 0 || available === '0' || available === 'false');
    var self = this;
    var targets = allBranches
      ? [''].concat(this.state[COL.branches].filter(function (b) { return same(b.restaurant, rid); }).map(function (b) { return b.key; }))
      : [rec.key];

    for (var i = 0; i < targets.length; i++) {
      var scopeBranch = targets[i];
      var existing = this.state[COL.menu].filter(function (r) {
        return same(r.restaurant, rid) && same(r.branch, scopeBranch) && keyOf(r.item) === keyOf(item);
      })[0];
      if (existing) {
        await updateDoc(doc(this.db, COL.menu, existing.id), {
          available: on, active: true, updatedBy: me.username, updatedAt: nowIso()
        });
      } else {
        var base = this.state[COL.menu].filter(function (r) {
          return same(r.restaurant, rid) && !norm(r.branch) && keyOf(r.item) === keyOf(item);
        })[0];
        var row = {
          restaurant: rid, branch: scopeBranch, item: item, itemKey: keyOf(item),
          category: base ? base.category : '', price: base ? num(base.price) : null,
          available: on, active: true, updatedBy: me.username, updatedAt: nowIso(),
          seq: Date.now() + i
        };
        await addDoc(collection(this.db, COL.menu), row);
      }
    }
    await this._reload(COL.menu);
    this.rev++;
    this._emitSoon();
    await this._audit(me, 'MENU_AVAILABILITY', rid + '/' + (allBranches ? 'ALL' : rec.key) + '/' + item, { available: on }, 'OK');
    return { ok: true, item: item, available: on, scope: allBranches ? 'all' : rec.key, data: this.scopedPayload(rid) };
  }

  async deleteMenuItem(restaurant, branch, item) {
    var me = this._requireManager();
    if (!this.isGlobal(me)) throw err('حذف الأصناف متاح لمدير النظام فقط.');
    var rid = this.resolveRestaurant(me, restaurant);
    var branchKey = cleanText(branch, 80);
    var allBranches = !branchKey || keyOf(branchKey) === 'all';
    var rec = allBranches ? null : this._branchRecord(branchKey, rid);
    if (!allBranches && !rec) throw err('اختار فرعًا تابعًا للمطعم المحدد.');
    if (rec) branchKey = rec.key;
    item = cleanText(item, 600);
    if (!item) throw err('اختار الصنف.');
    var removed = false;
    var rows = this.state[COL.menu].filter(function (r) {
      return same(r.restaurant, rid) && keyOf(r.item) === keyOf(item);
    });
    if (allBranches) {
      for (var i = 0; i < rows.length; i++) {
        await deleteDoc(doc(this.db, COL.menu, rows[i].id));
        removed = true;
      }
    } else {
      var branchRow = rows.filter(function (r) { return same(r.branch, branchKey); })[0];
      var base = rows.filter(function (r) { return !norm(r.branch) && r.active !== false; })[0];
      if (!branchRow && !base) {
        // مفيش حاجة تتشال
      } else if (base) {
        var data = {
          restaurant: rid, branch: branchKey, item: item, itemKey: keyOf(item),
          category: branchRow ? branchRow.category : base.category,
          price: branchRow ? num(branchRow.price) : num(base.price),
          available: false, active: false,
          updatedBy: me.username, updatedAt: nowIso(),
          seq: branchRow ? branchRow.seq : Date.now()
        };
        if (branchRow) {
          await setDoc(doc(this.db, COL.menu, branchRow.id), data, { merge: true });
        } else {
          await addDoc(collection(this.db, COL.menu), data);
        }
        removed = true;
      } else if (branchRow) {
        await deleteDoc(doc(this.db, COL.menu, branchRow.id));
        removed = true;
      }
    }
    await this._reload(COL.menu);
    this.rev++;
    this._emitSoon();
    await this._audit(me, 'MENU_DELETE', rid + '/' + (allBranches ? 'ALL' : branchKey) + '/' + item, { removed: removed }, 'OK');
    return { ok: true, removed: removed ? 1 : 0, item: item, scope: allBranches ? 'all' : branchKey, data: this.scopedPayload(rid) };
  }

  /* ---------------- reasons admin ---------------- */
  async listReasons(restaurant, branch) {
    var me = this._requireManager();
    await this.hydrate();
    var rid = this.resolveRestaurant(me, restaurant);
    if (keyOf(branch) === 'all') {
      return { ok: true, restaurant: rid, branch: 'ALL', reasons: this.reasonsForAllBranches(rid) };
    }
    var rec = this._branchRecord(branch, rid);
    if (!rec) throw err('اختار فرعًا تابعًا للمطعم المحدد.');
    return { ok: true, restaurant: rid, branch: rec.key, reasons: this.reasonsForBranch(rid, rec.key) };
  }

  async addReason(name, restaurant, branch) {
    var me = this._requireManager();
    if (!this.isGlobal(me)) throw err('إضافة الأسباب متاحة لمدير النظام فقط.');
    var rid = this.resolveRestaurant(me, restaurant);
    name = cleanText(name, 600);
    if (!name) throw err('اكتب اسم السبب.');
    var allBranches = keyOf(branch) === 'all';
    var scopeBranch = allBranches ? '' : this._branchRecord(branch, rid);
    if (!allBranches && !scopeBranch) throw err('اختار فرعًا تابعًا للمطعم المحدد.');
    var bkey = allBranches ? '' : scopeBranch.key;
    var existing = this.state[COL.reasons].filter(function (r) {
      return same(r.restaurant, rid) && same(r.branch, bkey) && keyOf(r.name) === keyOf(name);
    })[0];
    if (existing && existing.enabled !== false) {
      return { ok: true, already: true, reasons: allBranches ? this.reasonsForAllBranches(rid) : this.reasonsForBranch(rid, bkey) };
    }
    if (existing) {
      await updateDoc(doc(this.db, COL.reasons, existing.id), { enabled: true, updatedAt: nowIso(), updatedBy: me.username });
      existing.enabled = true;
    } else {
      var row = {
        restaurant: rid, branch: bkey, name: name, nameKey: keyOf(name),
        enabled: true, by: me.username, at: nowParts().key, createdAt: nowIso(),
        seq: Date.now()
      };
      await addDoc(collection(this.db, COL.reasons), row);
    }
    await this._reload(COL.reasons);
    this.rev++;
    this._emitSoon();
    await this._audit(me, 'REASON_ADD', rid + '/' + (bkey || 'ALL') + '/' + name, '', 'OK');
    return { ok: true, already: false, reasons: allBranches ? this.reasonsForAllBranches(rid) : this.reasonsForBranch(rid, bkey) };
  }

  async saveReason(info) {
    var me = this._requireManager();
    if (!this.isGlobal(me)) throw err('تعديل الأسباب متاح لمدير النظام فقط.');
    info = info || {};
    var rid = this.resolveRestaurant(me, info.restaurant);
    var oldName = cleanText(info.name, 600);
    var newName = cleanText(info.newName, 600);
    if (!newName) throw err('اكتب اسم السبب.');
    var allBranches = info.scope === 'all' || keyOf(info.branch) === 'all';
    var bkey = allBranches ? '' : (this._branchRecord(info.branch, rid) || {}).key || '';

    var rows = this.state[COL.reasons].filter(function (r) {
      return same(r.restaurant, rid) && keyOf(r.name) === keyOf(oldName) && (allBranches || keyOf(r.branch) === keyOf(bkey));
    });
    for (var i = 0; i < rows.length; i++) {
      await updateDoc(doc(this.db, COL.reasons, rows[i].id), {
        name: newName, nameKey: keyOf(newName), enabled: true,
        updatedAt: nowIso(), updatedBy: me.username
      });
    }
    // تحديث السجلات القديمة اللي استخدمت السبب
    var stops = this.state[COL.stops].filter(function (s) {
      return same(s.restaurant, rid) && keyOf(s.reason) === keyOf(oldName) && (allBranches || keyOf(s.branch) === keyOf(bkey));
    });
    for (var j = 0; j < stops.length; j++) {
      await updateDoc(doc(this.db, COL.stops, stops[j].id), { reason: newName, updatedAt: nowIso() });
    }
    await this._reloadMany([COL.reasons, COL.stops]);
    this.rev++;
    this._emitSoon();
    await this._audit(me, 'REASON_RENAME', rid + '/' + (bkey || 'ALL') + '/' + oldName, { to: newName, stops: stops.length }, 'OK');
    return { ok: true, name: newName, reasons: allBranches ? this.reasonsForAllBranches(rid) : this.reasonsForBranch(rid, bkey), data: this.scopedPayload(rid) };
  }

  async deleteReason(name, restaurant, branch) {
    var me = this._requireManager();
    if (!this.isGlobal(me)) throw err('حذف الأسباب متاح لمدير النظام فقط.');
    var rid = this.resolveRestaurant(me, restaurant);
    name = cleanText(name, 600);
    var allBranches = keyOf(branch) === 'all';
    var rec = allBranches ? null : this._branchRecord(branch, rid);
    var bkey = allBranches ? '' : rec.key;
    var rows = this.state[COL.reasons].filter(function (r) {
      return same(r.restaurant, rid) && keyOf(r.name) === keyOf(name) && (allBranches || keyOf(r.branch) === keyOf(bkey));
    });
    if (allBranches) {
      for (var i = 0; i < rows.length; i++) await deleteDoc(doc(this.db, COL.reasons, rows[i].id));
    } else {
      var shared = rows.filter(function (r) { return !norm(r.branch); })[0];
      var specific = rows.filter(function (r) { return same(r.branch, bkey); })[0];
      if (shared) {
        var data = {
          restaurant: rid, branch: bkey, name: name, nameKey: keyOf(name),
          enabled: false, by: me.username, at: nowParts().key,
          updatedAt: nowIso(), updatedBy: me.username,
          seq: specific ? specific.seq : Date.now()
        };
        if (specific) {
          await setDoc(doc(this.db, COL.reasons, specific.id), data, { merge: true });
        } else {
          await addDoc(collection(this.db, COL.reasons), data);
        }
      } else if (specific) {
        await deleteDoc(doc(this.db, COL.reasons, specific.id));
      }
    }
    await this._reload(COL.reasons);
    this.rev++;
    this._emitSoon();
    await this._audit(me, 'REASON_DELETE', rid + '/' + (bkey || 'ALL') + '/' + name, '', 'OK');
    return {
      ok: true,
      reasons: allBranches ? this.reasonsForAllBranches(rid) : this.reasonsForBranch(rid, bkey),
      data: this.scopedPayload(rid)
    };
  }

  /* ---------------- daily hours ---------------- */
  async getBranchDailyHours() {
    var me = this._requireManager();
    await this.hydrate();
    var self = this;
    var recs = this.state[COL.branches].filter(function (b) {
      if (self.isGlobal(me)) return true;
      return same(b.restaurant, me.restaurant);
    });
    return {
      ok: true,
      branches: recs.map(function (b) {
        var base = self.dayHours(b, nowParts().key);
        var days = [];
        for (var wd = 0; wd < 7; wd++) {
          var d = Array.isArray(b.days) && b.days.length === 7 ? b.days[wd] : null;
          if (d) {
            days.push({
              wd: wd, closed: !!d.closed,
              open: fmtHMS(d.closed ? base.openSec : (d.openSec != null ? d.openSec : base.openSec)),
              close: fmtHMS(d.closed ? base.closeSec : (d.closeSec != null ? d.closeSec : base.closeSec))
            });
          } else {
            days.push({ wd: wd, closed: false, open: fmtHMS(base.openSec), close: fmtHMS(base.closeSec) });
          }
        }
        return {
          key: b.key, name: b.name, restaurant: b.restaurant,
          restaurantName: self.brandName(b.restaurant),
          base: { open: fmtHMS(b.openSec != null ? b.openSec : 9 * 3600), close: fmtHMS(b.closeSec != null ? b.closeSec : 5 * 3600) },
          days: days
        };
      }),
      restaurants: this.state[COL.restaurants].filter(function (r) {
        return self.isGlobal(me) || same(r.id, me.restaurant);
      })
    };
  }

  async saveBranchDailyHours(branch, days) {
    var me = this._requireManager();
    var b = this._branchRecord(branch);
    if (!b) throw err('الفرع غير موجود أو مش تابع للمطعم.');
    if (!Array.isArray(days) || days.length !== 7) throw err('لازم تبعت مواعيد 7 أيام.');
    var clean = [];
    for (var i = 0; i < 7; i++) {
      var d = days[i] || {};
      var closed = !!d.closed;
      var o = parseSec(d.open), c = parseSec(d.close);
      if (!closed) {
        if (o === null) throw err('وقت الفتح غير صحيح في يوم ' + (i + 1) + '.');
        if (c === null) throw err('وقت القفل غير صحيح في يوم ' + (i + 1) + '.');
        if (o === c) throw err('وقت الفتح والقفل مينفعش يكونوا نفس الوقت (يوم ' + (i + 1) + ').');
      }
      clean.push({ closed: closed, openSec: o === null ? b.openSec : o, closeSec: c === null ? b.closeSec : c });
    }
    await updateDoc(doc(this.db, COL.branches, b.key), {
      days: clean, ver: Date.now(), updatedAt: nowIso(), updatedBy: me.username
    });
    b.days = clean; b.ver = Date.now();
    await this._reload(COL.branches);
    this.rev++;
    this._emitSoon();
    await this._audit(me, 'DAILY_HOURS_UPDATE', b.name, { days: 7 }, 'OK');
    var outDays = clean.map(function (x, wd) {
      return { wd: wd, closed: x.closed, open: fmtHMS(x.openSec), close: fmtHMS(x.closeSec) };
    });
    return { ok: true, branch: b.name, key: b.key, days: outDays, data: this.scopedPayload(b.restaurant) };
  }

  /* ---------------- shift rollover ---------------- */
  async getShiftLog(limitN, branch, restaurant) {
    this._requireManager();
    await this.hydrate();
    var entries = this.state[COL.shift].slice()
      .filter(function (x) {
        if (branch && !same(x.branch, branch)) return false;
        if (restaurant && !same(x.restaurant, restaurant)) return false;
        return true;
      })
      .sort(function (a, b) { return String(b.at || '').localeCompare(String(a.at || '')); })
      .slice(0, limitN || 50)
      .map(function (x) {
        return {
          at: x.at, branch: x.branchName || x.branch, day: x.day,
          open: x.open, close: x.close, stops: x.stops || 0,
          closed: x.closed || 0, actor: x.actor || '', note: x.note || ''
        };
      });
    return { ok: true, entries: entries };
  }

  async runShiftRollover(branch, force, restaurant) {
    var me = this._requireAny();
    if (this._roleScope(me) === 'branch') branch = me.branch;
    var b = this._branchRecord(branch, restaurant || null);
    if (!b) throw err('الفرع غير موجود.');
    var now = nowParts();
    var si = this.shiftInfo(b, now);
    var result = { ok: false, branch: b.name, key: b.key, closed: 0, stops: 0 };
    if (!si.openNow && !force) {
      result.skipped = true;
      result.reason = 'الفرع مقفول حاليًا حسب مواعيد العمل.';
      return { ok: false, results: [result], data: this.scopedPayload(b.restaurant) };
    }
    var open = this._openStops(b.key);
    var endSec = force ? now.sec : si.closeSec;
    for (var i = 0; i < open.length; i++) {
      var s = open[i];
      var dur = (endSec - (+s.stopSec || 0) + 86400) % 86400;
      await updateDoc(doc(this.db, COL.stops, s.id), {
        startSec: endSec, open: false, durationSec: dur,
        updatedAt: nowIso(), updatedBy: me.username
      });
      s.startSec = endSec; s.open = false; s.durationSec = dur;
    }
    var entry = {
      at: now.key + ' ' + now.hms, restaurant: b.restaurant, branch: b.key,
      branchName: b.name, day: si.day,
      open: fmtHMS(si.openSec), close: fmtHMS(si.closeSec),
      stops: open.length, closed: open.length, actor: me.username, note: '',
      createdAt: nowIso(), seq: Date.now()
    };
    await addDoc(collection(this.db, COL.shift), entry);
    await this._reloadMany([COL.shift, COL.stops]);

    await updateDoc(doc(this.db, COL.branches, b.key), { ver: Date.now() });
    b.ver = Date.now();
    this.rev++;
    this._emitSoon();
    await this._audit(me, 'SHIFT_ROLLOVER', b.name, { closed: open.length }, 'OK');
    result.ok = true; result.closed = open.length; result.stops = open.length;
    return { ok: true, results: [result], data: this.scopedPayload(b.restaurant) };
  }

  /* ---------------- misc / compatibility ---------------- */
  async addItem(name, restaurant, branch) {
    return this.saveMenuItem({
      item: name, restaurant: restaurant, branch: branch,
      scope: keyOf(branch) === 'all' ? 'all' : 'branch', available: true
    });
  }

  async deleteItem(name, restaurant, branch) {
    return this.deleteMenuItem(restaurant, branch, name);
  }

  /* ============================================================
   *  Dispatch
   * ============================================================ */
  async api(action, args, token) {
    args = args || [];
    if (!this.session && token) await this.restore(token);
    /* تسجيل الدخول نفسه بيتم في الواجهة عبر Firebase Auth — هنا خروج بس */
    if (action === 'logout') return this.logout();
    if (action === 'login') {
      var le = new Error('UNKNOWN_ACTION'); le.business = true; throw le;
    }
    if (!ACTIONS[action]) {
      var e = new Error('UNKNOWN_ACTION'); e.business = true; throw e;
    }
    if (!this.session) {
      var se = new Error('SESSION_EXPIRED'); throw se;
    }
    return this[ACTIONS[action]].apply(this, args);
  }
}

const ACTIONS = {
  getDashboardData: 'getDashboardData',
  pollState: 'pollState',
  listNotifications: 'listNotifications',
  markNotificationsRead: 'markNotificationsRead',
  logStop: 'logStop',
  resumeStop: 'resumeStop',
  getStopOptions: 'getStopOptions',
  clearAllData: 'clearAllData',
  listUsers: 'listUsers',
  getRoleConfig: 'getRoleConfig',
  registerNewUser: 'registerNewUser',
  saveUser: 'saveUser',
  changeMyPassword: 'changeMyPassword',
  createBranchUsers: 'createBranchUsers',
  deleteUser: 'deleteUser',
  getAuditLog: 'getAuditLog',
  getErrorLog: 'getErrorLog',
  checkSession: 'checkSession',
  branchDeleteInfo: 'branchDeleteInfo',
  deleteBranch: 'deleteBranch',
  createBranch: 'createBranch',
  listRestaurants: 'listRestaurants',
  saveRestaurant: 'saveRestaurant',
  deleteRestaurant: 'deleteRestaurant',
  listMenu: 'listMenu',
  saveMenuItem: 'saveMenuItem',
  importMenuItems: 'importMenuItems',
  setItemAvailability: 'setItemAvailability',
  deleteMenuItem: 'deleteMenuItem',
  listReasons: 'listReasons',
  saveReason: 'saveReason',
  addReason: 'addReason',
  deleteReason: 'deleteReason',
  saveBranchTimes: 'saveBranchTimes',
  saveBranchHours: 'saveBranchHours',
  getBranchDailyHours: 'getBranchDailyHours',
  saveBranchDailyHours: 'saveBranchDailyHours',
  runShiftRollover: 'runShiftRollover',
  getShiftLog: 'getShiftLog',
  addItem: 'addItem',
  deleteItem: 'deleteItem'
};

export const COLLECTIONS = COL;
