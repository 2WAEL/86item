/**
 * ============================================================
 *  داشبورد الايتمات الموقوفة  —  Code.gs  (كود السيرفر)
 *  يتركب جوه نفس الـ Google Sheet:  Extensions ▸ Apps Script
 *
 *  هيكل الشيت المتوقع:
 *   - شيتات الفروع: DOKKI / ZAMALEK / MERRYLAND / ELSAHEL (بيتكشفوا لوحدهم)
 *     صف 3 = هيدرز، والداتا من صف 4:
 *     A=Date  B=Day  C=Item Name  D=Stop Time  E=Start Time
 *     F=Duration (=MOD(E-D,1))  G=Reason  H=Reason BRANCH
 *     I=Brand  J=Branch (بتتسجل مع كل إيقاف — وبتترحّل تلقائيًا للصفوف القديمة)
 *   - شيت DATA: عمود A = الأسباب (من A2)، عمود B = الايتمات (من B2)
 *
 *  تحديثات النسخة الحالية:
 *   1) كل الأوقات (السيرفر + الشيتات + السجلات + الحسابات) بصيغة h:mm:ss
 *      والشيتات بتتعرض h:mm:ss AM/PM والمدة [h]:mm:ss.
 *   2) قاعدة البيانات الوحيدة هي Google Sheets — كل القراءة/الكتابة/التخزين
 *      بتمر عبر Apps Script (SpreadsheetApp) مباشرة، بدون أي اتصال بقاعدة
 *      بيانات خارجية.
 *   3) الحفاظ على الجلسات / الأدوار التشغيلية الثلاثة / صلاحية مدير النظام / الكاش / LockService.
 *   4) يوزر الايجينت والفروع: بيشوفوا شيفت العمل بس — من 9:00 الصبح لحد 5:00 الفجر
 *      اليوم اللي بعده (20 ساعة)، وقبل 9 الصبح بيشوفوا شيفت أمس لحد 5 الصبح.
 *      مفيش أي بيانات بتاريخ/وقت بعد "دلوقتي". التقارير الكاملة للمانجمنت زي ما هي.
 *   5) إدارة أصناف المنيو وأسباب الإيقاف بنطاق مطعم/فرع، مع إخفاء مستقل لكل فرع
 *      ودون تغيير فروع المطعم الأخرى.
 *   6) أوقات التحضير والتوصيل: قيمة ثابتة لكل فرع بالدقايق في شيت BRANCH_TIMES
 *      (تاريخي: كل تعديل صف عشان مقارنة الشهور)، بتظهر للايجينت والدسباتشر،
 *      وريبورت للمانجمنت (ملخص + مقارنة شهور + تفصيلي) مع تصدير Excel بس (.xlsx).
 *   7) أوقات العمل لكل فرع (فتح/قفل) في شيت BRANCH_HOURS (مخفي) — قابلة للتعديل
 *      من لوحة التحكم. شيفت العرض للايجينت/الدسباتشر بقى لكل فرع على حدة:
 *      من وقت الفتح لحد وقت القفل (ولو القفل بعد نص الليل الشيفت بيمتد لليوم اللي بعده)،
 *      والتقليب بيحصل عند وقت فتح الفرع — مش عند 12 منتصف الليل.
 *   8) إضافة فرع جديد ديناميكيًا من الداشبورد (اسم + أوقات عمل + تحضير/توصيل
 *      + يوزر دسباتشر اختياري) من غير أي تعديل في الكود.
 *   9) تصدير شامل لـ Excel (.xlsx): السجل، الملخص، الأسباب، مقارنة الشهور،
 *      الأيتمات الأكثر وقفًا، الأوقات وتغييراتها، إعدادات الفروع، والأداء اليومي.
 *  10) تنبيه صوتي عند تغيير أوقات التحضير/التوصيل (نفس نظام صوت الإيقاف).
 *  11) مسح كل سجلات الفروع من ⚙ (مانجمنت فقط) بباسورد الأدمن + تأكيد مزدوج،
 *      مع الحفاظ على DATA والمستخدمين والأوقات وهياكل الشيتات.
 *  12) كل الإضافات/الحذف الحساسة محمية بصلاحية مدير النظام المخزنة في USERS؛
 *      وحساب admin القديم يظل مديراً تلقائياً للتوافق.
 * ============================================================
 */

var CONFIG = {
  TZ: 'Africa/Cairo',          // توقيت "الآن" (الوقف/التشغيل الجديد)
  ADMIN_USER: 'admin',         // حساب البذرة القديم، يظل مدير نظام للتوافق
  DATA_SHEET: 'DATA',
  HEADER_ROW: 3,
  FIRST_ROW: 4,
  COLS: 10,                    // A:J — I=Brand و J=Branch (بيانات صريحة مع كل إيقاف)
  REASON_COL: 1,               // DATA!A
  ITEM_COL: 2,                 // DATA!B
  DV_ITEM_ROWS: 600,           // أقل عدد صفوف لقايمة الايتمات (بتكبر تلقائيًا مع DATA)
  DV_REASON_ROWS: 100,         // أقل عدد صفوف لقايمة الأسباب (بتكبر تلقائيًا مع DATA)
  CACHE_TTL: 300,              // ثواني
  CACHE_CHUNK: 30000,          // حجم القطعة في الكاش (حروف)
  DEFAULT_CLOSE: '03:00:00',   // وقت القفل لو مقدرناش نقراه من عنوان الشيت
  // لو وقت القفل اتقرأ غلط من عنوان الشيت، اكتبه هنا يدوي: { DOKKI: '04:30:00' }
  CLOSE_OVERRIDE: {},
  CLOSE_FALLBACK: { DOKKI: '04:30:00', ZAMALEK: '03:30:00', MERRYLAND: '03:30:00', ELSAHEL: '02:00:00' },
  USERS_SHEET: 'USERS',        // شيت اليوزرات (بيتعمل لوحده ومخفي)
  TIMES_SHEET: 'BRANCH_TIMES', // شيت أوقات التحضير والتوصيل لكل فرع (مخفي)
  HOURS_SHEET: 'BRANCH_HOURS', // شيت أوقات العمل (فتح/قفل) لكل فرع (مخفي)
  AUDIT_SHEET: 'AUDIT_LOG',    // سجل العمليات الحساسة (مخفي + محمي)
  ARCHIVE_SHEET: 'DELETED_ARCHIVE', // أرشيف البيانات المحذوفة (مخفي + محمي)
  MAX_TEXT: 600,               // أقصى طول لأي اسم/نص قصير (مفيش حد عملي على اسم الايتم/السبب)
  MAX_AUDIT_ROWS: 5000,        // بعد كده بيتقص أقدم صفوف السجل
  RATE_DELETE: 10,             // أقصى عمليات حذف في الساعة لكل مستخدم
  RATE_WRITE: 150,             // أقصى عمليات كتابة في الساعة لكل مستخدم
  RATE_READ: 900,              // أقصى عمليات قراءة في الساعة لكل مستخدم
  SESSION_TTL: 21600,          // مدة الجلسة بالثواني (6 ساعات — أقصى حد في الكاش)
  MAX_FAILS: 5,                // محاولات دخول غلط قبل القفل المؤقت
  FAIL_LOCK: 600,              // مدة القفل المؤقت بالثواني
  SHIFT_START_HOUR: 9,         // نافذة العرض للايجينت/الدسباتشر: من 9:00 صباحًا
  SHIFT_HOURS: 20,              // لحد 5:00 الفجر اليوم اللي بعده (9 ص + 20 ساعة)
  // ---- v14: عزل إعدادات الفروع + المنيو والأسباب + المواعيد اليومية + الإشعارات ----
  RESTAURANTS_SHEET: 'RESTAURANTS',
  BRANCHES_SHEET: 'BRANCHES',
  MENU_SHEET: 'MENU',
  REASONS_SHEET: 'REASONS',
  DAILY_SHEET: 'BRANCH_DAILY_HOURS',
  NOTIF_SHEET: 'NOTIFICATIONS',
  NOTIF_READ_SHEET: 'NOTIF_READ',
  SHIFT_SHEET: 'SHIFT_ROLLOVER',
  ERROR_SHEET: 'ERROR_LOG',
  REST_DEFAULT: 'MAIN',        // المطعم الافتراضي للبيانات القديمة
  RATE_POLL: 3600,             // الاستطلاع اللحظي (كل 4 ثواني) قراءة فقط
  ROLLOVER_GRACE_MIN: 5,       // دقايق السماح بعد وقت القفل قبل الإغلاق
  MAX_NOTIF_ROWS: 3000,
  MAX_ERROR_ROWS: 800,
  DETAIL_MAX: 1200
};
var UNSPEC = 'غير محدد';
var ROLE_MGMT = 'management', ROLE_BRANCH = 'branch', ROLE_AGENT = 'agent';

/**
 * بيانات البذرة — من غير أي باسورد في الكود.
 * الباسورد بيتقرأ من Script Properties بالاسم: SEED_PASS_<username> (مثال: SEED_PASS_admin).
 * لو مش موجود، setupUsers بيولّد باسورد عشوائي 12 حرف ويطبعه مرة واحدة في الـ Logger.
 * ⚠ ممنوع منعًا باتًا كتابة أي باسورد/مفتاح داخل هذا الملف.
 */
var SEED_USERS = [
  { username: 'admin',     role: 'management', branch: '' },
  { username: 'dokki',     role: 'branch',     branch: 'DOKKI' },
  { username: 'zamalek',   role: 'branch',     branch: 'ZAMALEK' },
  { username: 'merryland', role: 'branch',     branch: 'MERRYLAND' },
  { username: 'elsahel',   role: 'branch',     branch: 'ELSAHEL' },
  { username: 'agent',     role: 'agent',      branch: '' }
];

/** فتح الصفحة */
function doGet() {
  try {
    protectSystemSheets_();          // best-effort: تأمين شيتات النظام عند كل فتح
  } catch (e) {}
  try {
    return HtmlService.createHtmlOutputFromFile('Index')
      .setTitle('داشبورد الايتمات الموقوفة')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  } catch (e) {
    return HtmlService.createHtmlOutput(
      '<!doctype html><meta charset="utf-8"><div style="font-family:Tahoma,Arial;direction:rtl;padding:32px;color:#8B0000">' +
      'تعذر فتح التطبيق. جرّب تحديث الصفحة، ولو المشكلة استمرت كلّم المسؤول.</div>'
    );
  }
}

/* ============================================================
 *  أدوات مساعدة
 * ============================================================ */

function pad2_(n) { return (n < 10 ? '0' : '') + n; }

/** تنظيف الاسم: مسافات زيادة / رموز مخفية / محارف تحكم */
function normName_(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ')                       // محارف تحكم (CR/LF/TAB/NUL)
    .replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\u00A0]/g, ' ')   // مخفية / اتجاه النص
    .replace(/\s+/g, ' ')
    .trim();
}

/** مفتاح مقارنة (بدون فروق مسافات/حروف كبيرة) */
function keyOf_(s) { return normName_(s).toLowerCase(); }

/* ============================================================
 *  تعقيم المدخلات + التحقق منها (Input Validation / Sanitization)
 *  كل نص جاي من المتصفح بيمر من هنا قبل أي كتابة في الشيت.
 * ============================================================ */

/** نص آمن: تنظيف + حد أقصى للطول */
function cleanText_(s, max) {
  var v = normName_(s);
  if (max && v.length > max) v = v.slice(0, max);
  return v;
}

/** نص هيتكتب في الشيت: منع Formula Injection (= + - @ في أول الخلية) */
function sheetSafe_(s) {
  var v = String(s === null || s === undefined ? '' : s);
  return /^[=+\-@]/.test(v) ? "'" + v : v;
}

/** تحقق إلزامي من نص: بيرمي رسالة عربية واضحة (مفيش تفاصيل تقنية) */
/** تحقق من رقم في مدى */
function assertInt_(v, label, min, max) {
  var n = numFrom_(v);
  if (n === null || !isFinite(n)) throw new Error(label + ' لازم يكون رقم.');
  n = Math.round(n);
  if (n < min || n > max) throw new Error(label + ' لازم يكون من ' + min + ' لـ ' + max + '.');
  return n;
}

/** مفتاح كاش قصير وآمن (بدل نص طويل/حساس) */
function hashKey_(s) {
  try {
    var d = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(s), Utilities.Charset.UTF_8);
    return d.slice(0, 12).map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
  } catch (e) {
    return String(s).replace(/[^A-Za-z0-9]/g, '').slice(0, 40);
  }
}

/* ============================================================
 *  معالجة الأخطاء الآمنة (Secure Error Handling)
 *  - التفاصيل التقنية تروح للـ Logger/الأدمن بس
 *  - المستخدم بيشوف رسالة عربية عامة + كود مرجعي قصير
 * ============================================================ */
var TECH_ERR_RE = /(eyJ[A-Za-z0-9_\-\.]{10,}|https?:\/\/|select\s|insert\s|update\s|delete\s+from|sql|syntax error|exception|typeerror|referenceerror|cannot read|is not a function|is not defined|at\s+[A-Za-z_$][\w$]*\s*\(|\.gs:\d+|stack|spreadsheetapp|cacheService|urlfetchapp)/i;

function errCode_(raw) {
  try {
    var d = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(raw), Utilities.Charset.UTF_8);
    return d.slice(0, 3).map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('').toUpperCase();
  } catch (e) { return 'E000'; }
}

/** هل الرسالة خطأ عمل متوقع (تحقق/اختيار ناقص) وليست خطأ تقني؟ */
function isBusinessMessage_(s) {
  s = String(s || '').trim();
  return !!s && s.length <= 240 && /[\u0600-\u06FF]/.test(s) && !TECH_ERR_RE.test(s);
}

/** الرسالة اللي بتوصل للمتصفح — مفيش أي تفاصيل عن الجداول/الخدمات/المفاتيح */
function publicMsg_(raw) {
  var s = String(raw || '').replace(/^Error:\s*/, '').trim();
  if (s === 'SESSION_EXPIRED') return 'انتهت الجلسة، سجّل دخول تاني.';
  if (s === 'RATE_LIMIT') return 'محاولات كتير في وقت قصير. استنى شوية وجرّب تاني.';
  if (s === 'UNKNOWN_ACTION') return 'العملية غير معروفة.';
  if (isBusinessMessage_(s)) return s;                                  // رسائل العمل العربية آمنة
  return 'حصل خطأ غير متوقع. جرّب تاني، ولو استمر كلّم المسؤول. (كود: ' + errCode_(s) + ')';
}

/**
 * تنقية أي نص خطأ من الأسرار قبل ما يظهر أو يتسجل:
 * - JWT / API keys / الباسوردات
 * - التوكنز الطويلة
 */
function scrubSecrets_(s) {
  var out = String(s === null || s === undefined ? '' : s);
  out = out
    .replace(/eyJ[A-Za-z0-9_\-\.]{10,}/g, '***')                              // JWT / API keys
    .replace(/\b(sb|sk|pk|api[_-]?key|apikey|token|secret|password|passwd|pwd)\b\s*[:=]\s*["']?[^\s"'&,;}]+/gi, '$1=***')
    .replace(/\b[A-Za-z0-9_\-]{32,}\b/g, '***');                              // توكنز/مفاتيح طويلة
  return out.substring(0, 500);
}

/**
 * بيسجل التفاصيل الكاملة (رسالة + سبب + Stack) في ERROR_LOG ويرجّعها للواجهة
 * بشكل منظم — مع تنقية أي أسرار قبل العرض أو التسجيل.
 */
function publicErr_(e, action, user) {
  var raw = (e && e.message) ? String(e.message) : String(e || '');
  if (raw.indexOf(ERR_MARK) === 0) return e;                 // متغلّف قبل كده
  var safe = scrubSecrets_(raw);
  var business = isBusinessMessage_(safe);                   // تحقق/اختيار ناقص — مش خطأ تقني
  var stack = '';
  try { stack = scrubSecrets_(String((e && e.stack) || '').split('\n').slice(0, 12).join('\n')); } catch (_) {}
  var code = business ? '' : errCode_(safe + '|' + (action || ''));
  var payload = {
    ok: false,
    kind: business ? 'validation' : 'error',
    business: business,
    code: code,
    action: String(action || 'api'),
    message: publicMsg_(safe),
    detail: business ? '' : safe.slice(0, CONFIG.DETAIL_MAX || 1200),
    stack: business ? '' : stack.slice(0, 2000),
    cause: (!business && e && e.cause) ? scrubSecrets_(String(e.cause)).slice(0, 500) : '',
    at: nowIso_(),
    user: (user && user.username) ? user.username : ''
  };
  if (business) return new Error(ERR_MARK + JSON.stringify(payload));

  // الأخطاء التقنية فقط هي اللي تتسجل في ERROR_LOG / AUDIT / Console
  try { logError_(payload.action, user, code, payload.message, safe, stack); } catch (_) {}
  try { audit_(user || null, 'ERROR', payload.action, { code: code, detail: cleanText_(safe, 300) }, 'ERROR', code); } catch (_) {}
  return new Error(ERR_MARK + JSON.stringify(payload));
}

/** غلاف لأي دالة حساسة: مفيش تفاصيل تقنية هتتسرب للمتصفح */
function guard_(action, fn) {
  try {
    return fn();
  } catch (e) {
    if (e && (e.message === 'SESSION_EXPIRED' || e.message === 'RATE_LIMIT' || e.message === 'UNKNOWN_ACTION')) throw e;
    throw publicErr_(e, action);
  }
}

/* ============================================================
 *  Rate Limiting — حماية من التخمين/الإساءة
 * ============================================================ */
function rateLimit_(key, max, windowSec) {
  var c = CacheService.getScriptCache();
  var k = 'rl_' + hashKey_(key);
  var n = parseInt(c.get(k) || '0', 10);
  if (n >= max) throw new Error('RATE_LIMIT');
  try { c.put(k, String(n + 1), windowSec); } catch (e) {}
}

/* ============================================================
 *  سجل العمليات (Audit Log) + أرشيف الحذف
 * ============================================================ */
function getAuditSheet_(create) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(CONFIG.AUDIT_SHEET);
  if (!sh && create) {
    sh = ss.insertSheet(CONFIG.AUDIT_SHEET);
    sh.getRange(1, 1, 1, 8).setValues([['Timestamp', 'Actor', 'Role', 'Action', 'Target', 'Details', 'Result', 'Ref']]);
    sh.getRange(1, 1, 1, 8).setFontWeight('bold');
    sh.getRange(2, 1, Math.max(sh.getMaxRows() - 1, 1), 1).setNumberFormat('yyyy-mm-dd hh:mm:ss');
    sh.setFrozenRows(1);
    try { sh.hideSheet(); } catch (e) {}
    protectSheet_(sh, 'AUDIT_LOG — للسكربت بس');
  }
  return sh;
}

function getArchiveSheet_(create) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(CONFIG.ARCHIVE_SHEET);
  if (!sh && create) {
    sh = ss.insertSheet(CONFIG.ARCHIVE_SHEET);
    sh.getRange(1, 1, 1, 10).setValues([['ArchiveID', 'Timestamp', 'Actor', 'Branch', 'Rows', 'OpenRows', 'Users', 'Checksum', 'ChunkNo', 'Payload']]);
    sh.getRange(1, 1, 1, 10).setFontWeight('bold');
    sh.getRange(2, 1, Math.max(sh.getMaxRows() - 1, 1), 2).setNumberFormat('@');
    sh.getRange(2, 10, Math.max(sh.getMaxRows() - 1, 1), 1).setNumberFormat('@');
    sh.setFrozenRows(1);
    try { sh.hideSheet(); } catch (e) {}
    protectSheet_(sh, 'DELETED_ARCHIVE — للسكربت بس');
  }
  return sh;
}

/** تقييد شيتات النظام: مفيش تعديل يدوي من غير مالك السكربت */
function protectSheet_(sh, desc) {
  if (!sh) return;
  try {
    var ps = sh.getProtections(SpreadsheetApp.ProtectionType.SHEET);
    var p = ps && ps.length ? ps[0] : sh.protect();
    p.setDescription(desc || 'نظام — تعديل من السكربت فقط');
    p.setWarningOnly(false);
    try {
      var me = Session.getEffectiveUser();
      p.getEditors().forEach(function (u) { try { p.removeEditor(u); } catch (e) {} });
      if (me && me.getEmail()) { try { p.addEditor(me); } catch (e) {} }
    } catch (e2) {}
  } catch (e) { /* الحماية best-effort — مش هتوقف التطبيق */ }
}

function protectSystemSheets_() {
  [CONFIG.USERS_SHEET, CONFIG.HOURS_SHEET, CONFIG.TIMES_SHEET, CONFIG.AUDIT_SHEET, CONFIG.ARCHIVE_SHEET].forEach(function (n) {
    try { protectSheet_(SpreadsheetApp.getActiveSpreadsheet().getSheetByName(n), n + ' — نظام'); } catch (e) {}
  });
}

function trimAudit_(sh) {
  try {
    var max = CONFIG.MAX_AUDIT_ROWS || 5000;
    var n = sh.getLastRow() - 1;
    if (n > max) sh.deleteRows(2, n - max);
  } catch (e) {}
}

/** تسجيل عملية — best-effort ومينفعش يوقف العملية الأصلية */
function audit_(user, action, target, details, result, ref) {
  try {
    var sh = getAuditSheet_(true);
    var det = details == null ? '' : (typeof details === 'string' ? details : JSON.stringify(details));
    sh.appendRow([
      new Date(),
      sheetSafe_(cleanText_((user && user.username) || '—', 60)),
      sheetSafe_((user && user.role) || '—'),
      sheetSafe_(cleanText_(action, 60)),
      sheetSafe_(cleanText_(target || '', 120)),
      sheetSafe_(cleanText_(det, 900)),
      sheetSafe_(cleanText_(result || 'OK', 20)),
      sheetSafe_(cleanText_(ref || '', 80))
    ]);
    trimAudit_(sh);
  } catch (e) { /* best-effort */ }
}

function readAudit_(limit) {
  var sh = getAuditSheet_(false);
  if (!sh) return [];
  var n = sh.getLastRow() - 1;
  if (n < 1) return [];
  var take = Math.max(1, Math.min(parseInt(limit, 10) || 200, 1000, n));
  var rng = sh.getRange(n - take + 2, 1, take, 8);
  var v = rng.getValues(), d = rng.getDisplayValues(), out = [];
  for (var i = take - 1; i >= 0; i--) {
    out.push({
      at: d[i][0] || '', by: normName_(v[i][1]), role: normName_(v[i][2]),
      action: normName_(v[i][3]), target: normName_(v[i][4]),
      details: normName_(v[i][5]), result: normName_(v[i][6]), ref: normName_(v[i][7])
    });
  }
  return out;
}

function isActiveRestaurant_(id) {
  return readRestaurants_(false).some(function (r) {
    return r.active && keyOf_(r.id) === keyOf_(id);
  });
}

/* ============================================================
 *  إصدارات الجلسات: تغيير الباسورد/تعطيل/حذف يوزر يلغي جلساته فورًا
 * ============================================================ */
function userVer_(username) {
  try { return CacheService.getScriptCache().get('uver_' + hashKey_(keyOf_(username))) || ''; } catch (e) { return ''; }
}
function bumpUserVer_(username) {
  var v = '';
  try {
    v = Utilities.getUuid();
    CacheService.getScriptCache().put('uver_' + hashKey_(keyOf_(username)), v, CONFIG.SESSION_TTL);
  } catch (e) {}
  return v;
}

/** تحويل الأرقام العربية-الهندية لأرقام عادية */
function arDigits_(s) {
  return String(s).replace(/[\u0660-\u0669]/g, function (d) { return String(d.charCodeAt(0) - 0x0660); });
}

/** ثواني منذ بداية اليوم → h:mm:ss  (مثال: 4:07:09) */
function fmtHMS_(totalSeconds) {
  var t = Math.round(Number(totalSeconds) || 0);
  if (!isFinite(t) || t < 0) t = 0;
  var h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return h + ':' + pad2_(m) + ':' + pad2_(s);
}

function timeText_(totalSeconds) {
  var t = Math.round(Number(totalSeconds) || 0);
  if (!isFinite(t) || t < 0) t = 0;
  return pad2_(Math.floor(t / 3600) % 24) + ':' +
    pad2_(Math.floor((t % 3600) / 60)) + ':' + pad2_(t % 60);
}

/** استخراج الوقت من نص الخلية → ثواني من بداية اليوم (أو null) */
function parseSeconds_(s) {
  if (s === null || s === undefined) return null;
  if (s instanceof Date && !isNaN(s.getTime())) {
    try { s = Utilities.formatDate(s, CONFIG.TZ, 'H:mm:ss'); }
    catch (e) { s = s.getHours() + ':' + pad2_(s.getMinutes()) + ':' + pad2_(s.getSeconds()); }
  } else if (typeof s === 'number' && isFinite(s)) {
    if (s >= 0 && s < 1) return Math.round(s * 86400) % 86400;
    if (s >= 0 && s < 86400) return Math.round(s);
    return null;
  }
  s = arDigits_(normName_(s));
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

/** مفتاح التاريخ yyyy-MM-dd من قيمة الخلية */
function dateKey_(v, disp, tz) {
  if (Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v.getTime())) {
    return Utilities.formatDate(v, tz, 'yyyy-MM-dd');
  }
  var s = normName_(arDigits_((disp === undefined || disp === '') ? v : disp));
  var m = s.match(/(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/);
  if (m) return m[1] + '-' + pad2_(+m[2]) + '-' + pad2_(+m[3]);
  m = s.match(/(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})/);        // يوم/شهر/سنة
  if (m) return m[3] + '-' + pad2_(+m[2]) + '-' + pad2_(+m[1]);
  return '';
}

/** رقم اليوم (عدد الأيام من 1970) لحساب الفرق بين تاريخين */
function dayNum_(key) {
  var p = key.split('-');
  return Math.round(Date.UTC(+p[0], +p[1] - 1, +p[2]) / 86400000);
}

/** "الآن" بتوقيت القاهرة — بالثواني */
function nowParts_() {
  var now = new Date();
  var key = Utilities.formatDate(now, CONFIG.TZ, 'yyyy-MM-dd');
  var hms = Utilities.formatDate(now, CONFIG.TZ, 'H:mm:ss');
  var sec = parseSeconds_(hms);
  if (sec === null) sec = 0;
  var p = key.split('-');
  var serial = Math.round((Date.UTC(+p[0], +p[1] - 1, +p[2]) - Date.UTC(1899, 11, 30)) / 86400000);
  return {
    key: key,
    hms: fmtHMS_(sec),
    hm: fmtHMS_(sec),
    min: Math.floor(sec / 60),
    sec: sec,
    serial: serial,
    fraction: sec / 86400
  };
}

/** تنفيذ كود جوه Lock عشان مفيش تعارض بين أكتر من مستخدم */
function withLock_(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw new Error('السيستم مشغول دلوقتي، جرّب تاني بعد لحظات.');
  try { return fn(); } finally { lock.releaseLock(); }
}

/* ---------------- الكاش (مقسّم لقطع لأن الحد 100KB للقيمة) ---------------- */

function cachePut_(key, obj) {
  try {
    var s = JSON.stringify(obj), size = CONFIG.CACHE_CHUNK;
    var parts = Math.ceil(s.length / size), map = {};
    for (var i = 0; i < parts; i++) map[key + '_' + i] = s.substr(i * size, size);
    map[key + '_n'] = String(parts);
    CacheService.getScriptCache().putAll(map, CONFIG.CACHE_TTL);
  } catch (e) { /* الكاش اختياري */ }
}

function cacheGet_(key) {
  try {
    var cache = CacheService.getScriptCache();
    var n = parseInt(cache.get(key + '_n') || '0', 10);
    if (!n) return null;
    var keys = [];
    for (var i = 0; i < n; i++) keys.push(key + '_' + i);
    var got = cache.getAll(keys), s = '';
    for (var j = 0; j < n; j++) {
      if (got[keys[j]] === undefined) return null;
      s += got[keys[j]];
    }
    return JSON.parse(s);
  } catch (e) { return null; }
}

function cacheClear_() {
  try {
    var cache = CacheService.getScriptCache();
    var n = parseInt(cache.get('dash_n') || '0', 10), keys = ['dash_n'];
    for (var i = 0; i < n; i++) keys.push('dash_' + i);
    cache.removeAll(keys);
  } catch (e) {}
}

/* ============================================================
 *  الشيتات
 * ============================================================ */

/** كل شيتات الفروع المسجلة (سجل BRANCHES) — العزل بيحصل بعد كده حسب المطعم */
function getBranchSheets_() {
  ensureTenancy_();
  return branchRecords_().map(function (r) { return r.sheet; });
}

/** كشف شيتات الفروع القديمة (قبل تعدد المطاعم) — بتتسجل تلقائي في BRANCHES */
function legacyBranchSheets_() {
  return SpreadsheetApp.getActiveSpreadsheet().getSheets().filter(function (sh) {
    if (isSystemSheet_(sh.getName())) return false;
    if (sh.isSheetHidden()) return false;
    if (sh.getLastRow() < CONFIG.HEADER_ROW) return false;
    var h = sh.getRange(CONFIG.HEADER_ROW, 1, 1, 7).getDisplayValues()[0]
      .map(function (x) { return String(x).toLowerCase(); });
    return /date/.test(h[0]) && /item/.test(h[2]) && /stop/.test(h[3]);
  });
}

/** قراءة قايمة (ايتمات/أسباب) من DATA مع تنظيف ومنع التكرار */
function readList_(sh, col) {
  var n = sh.getLastRow() - 1;
  if (n < 1) return [];
  var vals = sh.getRange(2, col, n, 1).getValues(), seen = {}, out = [];
  vals.forEach(function (r) {
    var v = normName_(r[0]);
    if (!v) return;
    var k = keyOf_(v);
    if (seen[k]) return;
    seen[k] = 1;
    out.push(v);
  });
  return out;
}

/** وقت قفل الفرع القديم (من عنوان الشيت A1 أو القايمة الافتراضية) — بالثواني */
function legacyClose_(sh) {
  var name = sh.getName(), sec = null;
  if (CONFIG.CLOSE_OVERRIDE[name]) {
    sec = parseSeconds_(CONFIG.CLOSE_OVERRIDE[name]);
  } else {
    var txt = '';
    try { txt = arDigits_(sh.getRange('A1').getDisplayValue()); } catch (e) {}
    var m, last = null, re = /(\d{1,2})\s*:\s*(\d{2})(?::(\d{2}))?/g;
    while ((m = re.exec(txt)) !== null) last = m;
    sec = last ? parseSeconds_(last[1] + ':' + last[2] + ':' + (last[3] || '0')) : null;
  }
  if (sec === null) sec = parseSeconds_(CONFIG.CLOSE_FALLBACK[name] || CONFIG.DEFAULT_CLOSE);
  if (sec === null) sec = 0;
  return { text: fmtHMS_(sec), sec: sec, min: Math.floor(sec / 60) };
}

/** وقت القفل المعتمد للفرع (BRANCH_HOURS ثم عنوان الشيت ثم الافتراضي) */

/* ============================================================
 *  قراءة الداتا للداشبورد
 * ============================================================ */

/** قراءة شيت فرع واحد (Batch: getValues مرة واحدة) */
function readBranch_(sh, tz, now, itemMap, reasonMap, hoursMap, rec) {
  try { ensureTimeFormats_(sh); } catch (e) {}   // توحيد h:mm:ss لكل الصفوف القديمة (مرة كل 6 ساعات)
  if (rec) { try { ensureBranchMetaColumns_(rec); } catch (e) {} }   // ترحيل I=Brand / J=Branch مرة واحدة
  var hi = rec ? dayHours_(rec, now.key) : hoursInfo_(sh, hoursMap);
  var close = { text: fmtHMS_(hi.closeSec), sec: hi.closeSec, min: Math.floor(hi.closeSec / 60) };
  var n = sh.getLastRow() - CONFIG.FIRST_ROW + 1;
  var rows = [], skipped = 0;
  if (n >= 1) {
    var rng = sh.getRange(CONFIG.FIRST_ROW, 1, n, CONFIG.COLS);
    var vals = rng.getValues(), disp = rng.getDisplayValues();
    for (var i = 0; i < n; i++) {
      var v = vals[i], d = disp[i];
      var item = normName_(v[2]);
      if (!item) continue;                                  // صف فاضي
      var dk = dateKey_(v[0], d[0], tz);
      var stop = parseSeconds_(d[3]);
      if (!dk || stop === null) { skipped++; continue; }    // صف ناقص (بدون تاريخ أو وقت إيقاف)
      var start = parseSeconds_(d[4]);
      var isOpen = (start === null), durSec = 0, rev = 0, atClose = 0;
      if (isOpen) {
        // لسه موقوف: المدة لحد "دلوقتي" — بالثواني
        durSec = Math.max(0, (dayNum_(now.key) * 86400 + now.sec) - (dayNum_(dk) * 86400 + stop));
      } else {
        // المدة بتعدّي نص الليل: (Start - Stop) mod 24h
        durSec = (start - stop + 86400) % 86400;
        if (durSec === 0) rev = 1;                          // نفس الوقتين → للمراجعة
        if (start === close.sec) atClose = 1;               // رجوع = وقت القفل (بيتحسب عادي)
      }
      var hours = durSec / 3600;
      var reason = normName_(v[6]);
      reason = reason ? (reasonMap[keyOf_(reason)] || reason) : UNSPEC;
      var note = normName_(v[7]);
      // "أسباب أخرى" + وصف الدسباتشر → بيتجمعوا في بند واحد في كل جداول الداشبورد
      var dispReason = (reason && isOtherReason_(reason) && note) ? (reason + ' - ' + note) : reason;
      item = itemMap[keyOf_(item)] || item;
      rows.push({
        d: dk, it: item,
        st: fmtHMS_(stop),                                  // h:mm:ss
        en: isOpen ? '' : fmtHMS_(start),                   // h:mm:ss
        stv: stop,                                          // ثواني (للترتيب)
        env: isOpen ? null : start,
        h: Math.round(hours * 100) / 100,
        du: fmtHMS_(durSec),                                // المدة h:mm:ss
        dsec: durSec,
        r: dispReason, n: note,
        o: isOpen ? 1 : 0, c: atClose, v: rev, x: CONFIG.FIRST_ROW + i
      });
    }
  }
  return {
    name: sh.getName(),
    open: fmtHMS_(hi.openSec), close: fmtHMS_(hi.closeSec),
    openSec: hi.openSec, closeSec: hi.closeSec, closed: !!hi.closed,
    rows: rows, skipped: skipped
  };
}

function buildData_() {
  ensureTenancy_();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var tz = ss.getSpreadsheetTimeZone();
  var now = nowParts_();
  var recs = branchRecords_();
  var restaurants = readRestaurants_(true);
  var restById = {};
  restaurants.forEach(function (r) { restById[keyOf_(r.id)] = r; });

  var hmap = hoursMap_();
  var itemMapsByRest = {}, reasonMapsByRest = {}, menusByRest = {}, reasonsByRest = {};
  var allItems = [], allReasons = [], seenI = {}, seenR = {};

  restaurants.forEach(function (r) {
    var its = menuItemNames_(r.id);
    menusByRest[r.id] = its.map(function (x) { return x.it; });
    var im = {};
    its.forEach(function (x) { im[keyOf_(x.it)] = x.it; });
    itemMapsByRest[r.id] = im;

    var rs = reasonsForRest_(r.id);
    reasonsByRest[r.id] = rs;
    var rm = {};
    rs.forEach(function (x) { rm[keyOf_(x)] = x; });
    reasonMapsByRest[r.id] = rm;

    menusByRest[r.id].forEach(function (n) { if (!seenI[keyOf_(n)]) { seenI[keyOf_(n)] = 1; allItems.push(n); } });
    rs.forEach(function (n) { if (!seenR[keyOf_(n)]) { seenR[keyOf_(n)] = 1; allReasons.push(n); } });
  });

  var branches = [], skipped = 0, menuMap = {}, reasonsByBranch = {};
  recs.forEach(function (rec) {
    var rid = rec.restaurant || CONFIG.REST_DEFAULT;
    var b = readBranch_(rec.sheet, tz, now, itemMapsByRest[rid] || {}, reasonMapsByRest[rid] || {}, hmap, rec);
    var si = shiftInfo_(rec, now);
    var rest = restById[keyOf_(rid)];
    b.key = rec.key;
    b.name = rec.name;
    b.restaurant = rid;
    b.restaurantName = rest ? rest.name : rid;
    b.closed = !si.openNow;
    b.shiftDay = si.day;
    b.shiftKey = si.key + '#' + shiftVersion_(rec.key);
    b.rolloverDue = !!si.due;
    b.shift = { day: si.day, openSec: si.openSec, closeSec: si.closeSec, startAbs: si.startAbs, endAbs: si.endAbs };
    skipped += b.skipped;
    menuMap[rec.key] = menuForBranch_(rid, rec.key);
    reasonsByBranch[rec.key] = reasonsForBranch_(rid, rec.key);
    branches.push(b);
  });

  return {
    generatedAt: now.key + ' ' + now.hms,
    now: now.key,
    nowSec: now.sec,
    branches: branches,
    restaurants: restaurants,
    items: allItems,
    reasons: allReasons,
    menus: menusByRest,
    reasonsByRest: reasonsByRest,
    reasonsByBranch: reasonsByBranch,
    menu: menuMap,
    times: readTimes_(),
    hours: readHours_(),
    daily: readDailyHoursRaw_(),
    shiftLog: recentShifts_(25),
    skipped: skipped
  };
}

/** بيبني الداتا من الشيتات ويخزنها في الكاش */
function freshPayload_() {
  var data = buildData_();
  cachePut_('dash', data);
  return data;
}

/** الداتا الكاملة (من الكاش أو من الشيتات) — داخلية، مبتتبعتش للمتصفح غير بعد الفلترة */
function fullData_(force) {
  if (!force) {
    var cached = cacheGet_('dash');
    if (cached) return cached;
  }
  return freshPayload_();
}

/** الدالة اللي بيناديها الداشبورد. force=true → تجاهل الكاش (للمانجمنت بس)
 *  restaurant (اختياري) = البراند المحدد → عزل الداتا من السيرفر نفسه. */
function getDashboardData(token, force, restaurant) {
  var user = auth_(token);
  return scopePayload_(fullData_(!!force && user.role === ROLE_MGMT), scopedPayloadUser_(user, restaurant));
}

/* ============================================================
 *  Data Validation + تنسيق الوقت في الشيتات
 * ============================================================ */

/** تنسيق الوقت الموحد في شيت فرع — بيتطبق مرة كل 6 ساعات */
function ensureTimeFormats_(sh) {
  var cache = CacheService.getScriptCache();
  var key = 'tf_' + sh.getName();
  if (cache.get(key) === '1') return;
  var rows = Math.max(sh.getMaxRows() - CONFIG.FIRST_ROW + 1, 1);
  sh.getRange(CONFIG.FIRST_ROW, 4, rows, 1).setNumberFormat('h:mm:ss AM/PM');
  sh.getRange(CONFIG.FIRST_ROW, 5, rows, 1).setNumberFormat('h:mm:ss AM/PM');
  sh.getRange(CONFIG.FIRST_ROW, 6, rows, 1).setNumberFormat('[h]:mm:ss');
  try { cache.put(key, '1', 21600); } catch (e) {}
}

/** اسم البراند الظاهر من الكود الداخلي (أي ID غير معروف يفضل زي ما هو) */
function brandNameFor_(id) {
  var k = keyOf_(id), name = normName_(id);
  readRestaurants_(false).some(function (r) {
    if (keyOf_(r.id) !== k) return false;
    name = r.name || r.id;
    return true;
  });
  return name;
}

/**
 * ترحيل مرة واحدة لكل شيت فرع:
 * يضمن عمودين I=Brand و J=Branch (بعرض كافي) ويكمّل الصفوف القديمة اللي اتسجلت قبل الإضافة.
 * بيتنفذ مرة كل 6 ساعات لكل شيت (كاش) عشان ميبطّأش القراءة.
 */
function ensureBranchMetaColumns_(rec) {
  if (!rec || !rec.sheet) return;
  var sh = rec.sheet;
  var cache = null, ck = 'bm1_' + sh.getName();
  try {
    cache = CacheService.getScriptCache();
    if (cache.get(ck) === '1') return;
  } catch (e) { cache = null; }

  if (sh.getMaxColumns() < CONFIG.COLS) {
    sh.insertColumnsAfter(sh.getMaxColumns(), CONFIG.COLS - sh.getMaxColumns());
  }
  var hdr = sh.getRange(CONFIG.HEADER_ROW, 9, 1, 2).getValues()[0];
  if (normName_(hdr[0]) !== 'Brand' || normName_(hdr[1]) !== 'Branch') {
    sh.getRange(CONFIG.HEADER_ROW, 9, 1, 2).setValues([['Brand', 'Branch']])
      .setFontWeight('bold').setBackground('#F5F2EB').setHorizontalAlignment('center');
  }

  var n = sh.getLastRow() - CONFIG.FIRST_ROW + 1;
  if (n >= 1) {
    var vals = sh.getRange(CONFIG.FIRST_ROW, 1, n, CONFIG.COLS).getValues();
    var brand = brandNameFor_(rec.restaurant), out = [], need = false;
    for (var i = 0; i < n; i++) {
      var item = normName_(vals[i][2]);
      var bi = normName_(vals[i][8]), br = normName_(vals[i][9]);
      if (item) {
        if (!bi) { bi = brand; need = true; }
        if (!br) { br = rec.name; need = true; }
      }
      out.push([bi, br]);
    }
    if (need) {
      sh.getRange(CONFIG.FIRST_ROW, 9, n, 2).setNumberFormat('@').setValues(out);
    }
  }
  try { if (cache) cache.put(ck, '1', 21600); } catch (e) {}
}

/** بيربط عمود الايتم (C) وعمود السبب (G) في كل فرع بقايمة مطعمه + يوحّد تنسيق الوقت */
function applyValidations_(restaurant) {
  ensureTenancy_();
  var rid = cleanText_(restaurant, 40);
  branchRecords_().forEach(function (rec) {
    if (rid && keyOf_(rec.restaurant) !== keyOf_(rid)) return;   // نطاق البراند فقط
    var sh = rec.sheet;
    var items = menuForBranch_(rec.restaurant, rec.key).map(function (x) { return x.it; }).slice(0, 500);
    var reasons = reasonsForBranch_(rec.restaurant, rec.key).slice(0, 300);
    var rows = Math.max(sh.getMaxRows() - CONFIG.FIRST_ROW + 1, 1);
    if (items.length) {
      sh.getRange(CONFIG.FIRST_ROW, 3, rows, 1).setDataValidation(
        SpreadsheetApp.newDataValidation().requireValueInList(items, true).setAllowInvalid(true).build());
    } else sh.getRange(CONFIG.FIRST_ROW, 3, rows, 1).setDataValidation(null);
    if (reasons.length) {
      sh.getRange(CONFIG.FIRST_ROW, 7, rows, 1).setDataValidation(
        SpreadsheetApp.newDataValidation().requireValueInList(reasons, true).setAllowInvalid(true).build());
    } else sh.getRange(CONFIG.FIRST_ROW, 7, rows, 1).setDataValidation(null);
    sh.getRange(CONFIG.FIRST_ROW, 4, rows, 1).setNumberFormat('h:mm:ss AM/PM');
    sh.getRange(CONFIG.FIRST_ROW, 5, rows, 1).setNumberFormat('h:mm:ss AM/PM');
    sh.getRange(CONFIG.FIRST_ROW, 6, rows, 1).setNumberFormat('[h]:mm:ss');
  });
}

/** زرار "تحديث قوائم الاختيار في الشيتات" (مانجمنت بس) — للبراند المحدد فقط */
function refreshLists(token, restaurant) {
  var user = auth_(token, [ROLE_MGMT]);
  var rid = resolveRestaurant_(user, restaurant);
  return withLock_(function () {
    applyValidations_(rid);
    cacheClear_();
    return { ok: true, restaurant: rid };
  });
}

/* ============================================================
 *  إضافة ايتم / ريزون
 * ============================================================ */

/** تحديث قوايم الاختيار في الفروع — لو فشل (كووتا/وقت) مينفعش يلغي نجاح الإضافة أو الحذف */
function safeApplyValidations_(restaurant) {
  try { applyValidations_(restaurant); }
  catch (e) {}
}

/** توجيه المطعم/البراند الحالي لليوزر (global admin يختار أي براند) */
function resolveRestaurant_(user, wanted) {
  ensureTenancy_();
  var list = readRestaurants_(false).filter(function (r) { return r.active; });
  var ids = list.map(function (r) { return r.id; });
  var w = cleanText_(wanted, 40);
  if (w) {
    if (keyOf_(w) === 'all') throw new Error('اختار براندًا محددًا — النطاق العام غير مسموح.');
    var hit = null;
    list.forEach(function (r) { if (keyOf_(r.id) === keyOf_(w)) hit = r.id; });
    if (!hit) throw new Error('المطعم "' + w + '" غير موجود.');
    if (!isGlobalUser_(user) && keyOf_(hit) !== keyOf_(user.restaurant)) throw new Error('مش مسموح بالوصول لمطعم تاني.');
    return hit;
  }
  if (user && user.restaurant) return user.restaurant;
  if (ids.indexOf(CONFIG.REST_DEFAULT) >= 0) return CONFIG.REST_DEFAULT;
  return ids[0] || CONFIG.REST_DEFAULT;
}

/** نسخة مقيّدة بالبراند للـ payload — للمانجمنت العام بدون التأثير على صلاحياته */
function scopedPayloadUser_(user, restaurant) {
  if (!isGlobalUser_(user) || !restaurant) return user;
  var rid = resolveRestaurant_(user, restaurant);
  var copy = {};
  Object.keys(user).forEach(function (k) { copy[k] = user[k]; });
  copy.restaurant = rid;
  copy.scopeRestaurant = true;
  return copy;
}

/** بناء الداتا بعد العملية — لو فشل بنرجّع null والمتصفح بيعمل تحديث لوحده (العملية تفضل ناجحة) */
function safePayload_(user) {
  try { return scopePayload_(freshPayload_(), user); }
  catch (e) {
    try { cacheClear_(); } catch (_) {}
    return null;
  }
}

/** إضافة صنف للفرع المحدد دون التأثير على بقية فروع المطعم. */
function addItem(token, name, restaurant, branch) {
  var user = requireAdmin_(auth_(token, [ROLE_MGMT]));
  var rid = resolveRestaurant_(user, restaurant);
  var allBranches = !branch || keyOf_(branch) === 'all';
  var rec = allBranches ? null : branchRecForUser_(user, branch, rid);
  if (!allBranches && !rec) throw new Error('اختار فرعًا تابعًا للمطعم المحدد.');
  name = cleanText_(name, CONFIG.MAX_TEXT).replace(/^[=+\-@]+/, '').trim();
  if (!name) throw new Error('اكتب اسم الصنف.');
  var exists = allBranches ? menuForRestaurant_(rid) : menuForBranch_(rid, rec.key);
  if (exists.some(function (item) { return keyOf_(item.it) === keyOf_(name); })) {
    return { ok: true, already: true, item: name, scope: allBranches ? 'all' : rec.key };
  }
  var result = saveMenuItem(token, {
    item: name, restaurant: rid, branch: allBranches ? '' : rec.key,
    scope: allBranches ? 'all' : 'branch', available: true
  });
  result.already = false;
  return result;
}

/** إضافة سبب مرتبط بالمطعم والفرع المحددين. */
function addReason(token, name, restaurant, branch) {
  var user = requireAdmin_(auth_(token, [ROLE_MGMT]));
  var rid = resolveRestaurant_(user, restaurant);
  var allBranches = !branch || keyOf_(branch) === 'all';
  var rec = allBranches ? null : branchRecForUser_(user, branch, rid);
  if (!allBranches && !rec) throw new Error('اختار فرعًا تابعًا للمطعم المحدد.');
  name = cleanText_(name, CONFIG.MAX_TEXT).replace(/^[=+\-@]+/, '').trim();
  if (!name) throw new Error('اكتب اسم السبب.');
  if (keyOf_(name) === keyOf_(UNSPEC)) throw new Error('"' + UNSPEC + '" مينفعش يتضاف كسبب.');

  var result = withLock_(function () {
    var sh = tblSheet_(CONFIG.REASONS_SHEET, REASON_HEADERS, true);
    var rows = readTable_(CONFIG.REASONS_SHEET, 6), scopedRow = 0, inherited = false;
    if (allBranches) {
      var matches = [], hasShared = false, already = false;
      rows.forEach(function (r, i) {
        if (keyOf_(r[0]) !== keyOf_(rid) || keyOf_(r[2]) !== keyOf_(name)) return;
        matches.push(i + 2);
        if (!normName_(r[1])) {
          hasShared = true;
          if (String(r[5]).toUpperCase() !== 'FALSE') already = true;
        }
      });
      matches.forEach(function (row) {
        sh.getRange(row, 4, 1, 3).setValues([[sheetSafe_(user.username), nowIso_(), true]]);
      });
      if (!hasShared) sh.appendRow([sheetSafe_(rid), '', sheetSafe_(name),
        sheetSafe_(user.username), nowIso_(), true]);
      return { already: already && !matches.some(function (row) {
        return String(rows[row - 2][5]).toUpperCase() === 'FALSE';
      }) };
    }
    rows.forEach(function (r, i) {
      if (keyOf_(r[0]) !== keyOf_(rid) || keyOf_(r[2]) !== keyOf_(name)) return;
      if (keyOf_(r[1]) === keyOf_(rec.key) || keyOf_(r[1]) === keyOf_(rec.name)) scopedRow = i + 2;
      else if (!normName_(r[1]) && String(r[5]).toUpperCase() !== 'FALSE') inherited = true;
    });
    if (scopedRow) {
      if (String(rows[scopedRow - 2][5]).toUpperCase() === 'FALSE') {
        sh.getRange(scopedRow, 4, 1, 3).setValues([[sheetSafe_(user.username), nowIso_(), true]]);
        return { already: false };
      }
      return { already: true };
    }
    if (!allBranches && inherited) return { already: true };
    sh.appendRow([sheetSafe_(rid), allBranches ? '' : sheetSafe_(rec.key), sheetSafe_(name),
      sheetSafe_(user.username), nowIso_(), true]);
    return { already: false };
  });
  safeApplyValidations_(rid);
  cacheClear_(); bumpLive_();
  audit_(user, 'REASON_ADD', rid + '/' + (allBranches ? 'ALL' : rec.key) + '/' + name, { already: result.already }, 'OK');
  return { ok: true, already: result.already, name: name,
    reasons: allBranches ? reasonsForAllBranches_(rid) : reasonsForBranch_(rid, rec.key) };
}

/** بيقول هل السبب ده "أسباب أخرى" (محتاج وصف من الدسباتشر) */
function isOtherReason_(name) { return keyOf_(name).indexOf('اخرى') !== -1 || keyOf_(name).indexOf('أخرى') !== -1; }

/** حذف صنف من الفرع المحدد فقط. */
function deleteItem(token, name, restaurant, branch) {
  var user = requireAdmin_(auth_(token, [ROLE_MGMT]));
  var rid = resolveRestaurant_(user, restaurant);
  var allBranches = !branch || keyOf_(branch) === 'all';
  var rec = allBranches ? null : branchRecForUser_(user, branch, rid);
  if (!allBranches && !rec) throw new Error('اختار فرعًا تابعًا للمطعم المحدد.');
  return deleteMenuItem(token, rid, allBranches ? 'ALL' : rec.key, name);
}

/** إخفاء السبب في الفرع المحدد مع إبقاء المطاعم والفروع الأخرى دون تغيير. */
function deleteReason(token, name, restaurant, branch) {
  var user = requireAdmin_(auth_(token, [ROLE_MGMT]));
  var rid = resolveRestaurant_(user, restaurant), allBranches = !branch || keyOf_(branch) === 'all';
  var rec = allBranches ? null : branchRecForUser_(user, branch, rid);
  if (!allBranches && !rec) throw new Error('اختار فرعًا تابعًا للمطعم المحدد.');
  name = cleanText_(name, CONFIG.MAX_TEXT);
  if (!name) throw new Error('اختار السبب اللي عايز تحذفه.');

  var result = withLock_(function () {
    var sh = tblSheet_(CONFIG.REASONS_SHEET, REASON_HEADERS, true);
    var rows = readTable_(CONFIG.REASONS_SHEET, 6), row = 0, inherited = false;
    if (allBranches) {
      var removed = 0;
      rows.forEach(function (r, i) {
        if (keyOf_(r[0]) !== keyOf_(rid) || keyOf_(r[2]) !== keyOf_(name)) return;
        sh.getRange(i + 2, 6).setValue(false);
        sh.getRange(i + 2, 4, 1, 2).setValues([[sheetSafe_(user.username), nowIso_()]]);
        removed++;
      });
      return { missing: !removed };
    }
    rows.forEach(function (r, i) {
      if (keyOf_(r[0]) !== keyOf_(rid) || keyOf_(r[2]) !== keyOf_(name)) return;
      if (keyOf_(r[1]) === keyOf_(rec.key) || keyOf_(r[1]) === keyOf_(rec.name)) row = i + 2;
      else if (!normName_(r[1]) && String(r[5]).toUpperCase() !== 'FALSE') inherited = true;
    });
    if (!row && !inherited) return { missing: true };
    if (row && inherited) {
      sh.getRange(row, 6).setValue(false);
      sh.getRange(row, 4, 1, 2).setValues([[sheetSafe_(user.username), nowIso_()]]);
    } else if (row) {
      sh.deleteRow(row);
    } else {
      sh.appendRow([sheetSafe_(rid), sheetSafe_(rec.key), sheetSafe_(name),
        sheetSafe_(user.username), nowIso_(), false]);
    }
    return { missing: false };
  });
  safeApplyValidations_(rid);
  cacheClear_(); bumpLive_();
  audit_(user, 'REASON_DELETE', rid + '/' + (allBranches ? 'ALL' : rec.key) + '/' + name, { missing: result.missing }, 'OK');
  return { ok: true, missing: result.missing, name: name,
    reasons: allBranches ? reasonsForAllBranches_(rid) : reasonsForBranch_(rid, rec.key) };
}

function saveReason(token, info) {
  var user = requireAdmin_(auth_(token, [ROLE_MGMT]));
  info = info || {};
  var rid = resolveRestaurant_(user, info.restaurant);
  var allBranches = info.scope === 'all' || !info.branch || keyOf_(info.branch) === 'all';
  var rec = allBranches ? null : branchRecForUser_(user, info.branch, rid);
  if (!allBranches && !rec) throw new Error('اختار فرعًا تابعًا للمطعم المحدد.');
  var oldName = cleanText_(info.name, CONFIG.MAX_TEXT);
  var newName = cleanText_(info.newName, CONFIG.MAX_TEXT).replace(/^[=+\-@]+/, '').trim();
  if (!oldName || !newName) throw new Error('اسم السبب القديم والجديد مطلوبان.');
  if (keyOf_(newName) === keyOf_(UNSPEC)) throw new Error('"' + UNSPEC + '" مينفعش يتضاف كسبب.');

  withLock_(function () {
    var sh = tblSheet_(CONFIG.REASONS_SHEET, REASON_HEADERS, true);
    var rows = readTable_(CONFIG.REASONS_SHEET, 6), matches = [], duplicate = false;
    rows.forEach(function (r, i) {
      if (keyOf_(r[0]) !== keyOf_(rid)) return;
      var scope = normName_(r[1]), sameScope = allBranches ? true :
        (!scope || keyOf_(scope) === keyOf_(rec.key) || keyOf_(scope) === keyOf_(rec.name));
      if (keyOf_(r[2]) === keyOf_(oldName) && sameScope) matches.push(i + 2);
      if (keyOf_(r[2]) === keyOf_(newName) && sameScope) duplicate = true;
    });
    if (!matches.length) throw new Error('السبب غير موجود في النطاق المحدد.');
    if (keyOf_(oldName) !== keyOf_(newName) && duplicate) throw new Error('السبب الجديد موجود بالفعل في هذا النطاق.');

    if (allBranches) {
      var hasShared = matches.some(function (row) { return !normName_(rows[row - 2][1]); });
      matches.forEach(function (row) {
        sh.getRange(row, 3).setValue(sheetSafe_(newName));
        sh.getRange(row, 4, 1, 2).setValues([[sheetSafe_(user.username), nowIso_()]]);
        sh.getRange(row, 6).setValue(true);
      });
      if (!hasShared) sh.appendRow([sheetSafe_(rid), '', sheetSafe_(newName),
        sheetSafe_(user.username), nowIso_(), true]);
    } else {
      var rowToUpdate = matches.filter(function (row) {
        return keyOf_(rows[row - 2][1]) === keyOf_(rec.key) || keyOf_(rows[row - 2][1]) === keyOf_(rec.name);
      })[0];
      if (rowToUpdate) {
        sh.getRange(rowToUpdate, 3).setValue(sheetSafe_(newName));
        sh.getRange(rowToUpdate, 4, 1, 2).setValues([[sheetSafe_(user.username), nowIso_()]]);
      } else {
        sh.appendRow([sheetSafe_(rid), sheetSafe_(rec.key), sheetSafe_(oldName),
          sheetSafe_(user.username), nowIso_(), false]);
        sh.appendRow([sheetSafe_(rid), sheetSafe_(rec.key), sheetSafe_(newName),
          sheetSafe_(user.username), nowIso_(), true]);
      }
    }
  });
  safeApplyValidations_(rid); cacheClear_(); bumpLive_();
  audit_(user, 'REASON_RENAME', rid + '/' + (allBranches ? 'ALL' : rec.key), { from: oldName, to: newName }, 'OK');
  return { ok: true, name: newName,
    reasons: allBranches ? reasonsForAllBranches_(rid) : reasonsForBranch_(rid, rec.key) };
}

/**
 * مسح كل سجلات الوقف/الرجوع من شيتات الفروع.
 * - مانجمنت فقط + إعادة إدخال باسورد الأدمن (re-auth)
 * - بيمسح المحتوى بس ويحافظ على الهيدر والتنسيق وقوايم الاختيار
 * - USERS / BRANCH_TIMES / BRANCH_HOURS / DATA / السجل — مش بيتأثروا
 */
function clearAllData(token, password) {
  var user = requireAdmin_(reAuth_(token, password));
  rateLimit_('clearall:' + user.username, 3, 3600);      // عملية خطيرة: 3 مرات/ساعة بالكتير

  var result = withLock_(function () {
    var cleared = [], total = 0;
    scopedBranchRecs_(user).forEach(function (rec) {
      var sh = rec.sheet;
      try { ensureBranchMetaColumns_(rec); } catch (e) {}
      var last = sh.getLastRow();
      var rows = last - CONFIG.FIRST_ROW + 1;
      if (rows < 1) { cleared.push({ branch: rec.name, rows: 0 }); return; }
      // مسح المحتوى فقط (مش حذف الصفوف) عشان التنسيق والقوايم تفضل زي ما هي
      sh.getRange(CONFIG.FIRST_ROW, 1, rows, CONFIG.COLS).clearContent();
      cleared.push({ branch: rec.name, rows: rows });
      total += rows;
    });
    // التحديث النطاقي: الأدمن العام يحدّث الكل، والمقيّد يحدّث برانده فقط
    safeApplyValidations_(isGlobalUser_(user) ? null : ridFor_(user));
    return { cleared: cleared, total: total };
  });

  cacheClear_();
  audit_(user, 'DATA_CLEAR_ALL', 'ALL', { branches: result.cleared.length, rows: result.total }, 'OK');

  result.ok = true;
  result.data = safePayload_(user);
  return result;
}

/* ============================================================
 *  أوقات العمل (فتح/قفل) لكل فرع — شيت BRANCH_HOURS مخفي
 *  الشيفت = من وقت الفتح لحد وقت القفل. لو القفل بعد نص الليل
 *  الشيفت بيمتد لليوم اللي بعده، والتقليب عند وقت الفتح (مش 12 بالليل).
 * ============================================================ */

function getHoursSheet_(create) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(CONFIG.HOURS_SHEET);
  if (!sh && create) {
    sh = ss.insertSheet(CONFIG.HOURS_SHEET);
    sh.getRange(1, 1, 1, 5).setValues([['Branch', 'OpenTime', 'CloseTime', 'UpdatedBy', 'UpdatedAt']]);
    sh.getRange(1, 1, 1, 5).setFontWeight('bold');
    sh.getRange(2, 2, Math.max(sh.getMaxRows() - 1, 1), 2).setNumberFormat('@');
    sh.getRange(2, 5, Math.max(sh.getMaxRows() - 1, 1), 1).setNumberFormat('yyyy-mm-dd hh:mm:ss');
    sh.setFrozenRows(1);
    try { sh.hideSheet(); } catch (e) {}
    protectSheet_(sh, 'BRANCH_HOURS — نظام');
  }
  return sh;
}

/** كل صفوف أوقات العمل — آخر صف لكل فرع هو المعتمد */
function readHours_() {
  var sh = getHoursSheet_(false);
  if (!sh) return [];
  var n = sh.getLastRow() - 1;
  if (n < 1) return [];
  var tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  var rng = sh.getRange(2, 1, n, 5), v = rng.getValues(), d = rng.getDisplayValues();
  var out = [];
  for (var i = 0; i < n; i++) {
    var br = normName_(v[i][0]);
    if (!br) continue;
    var openSec = parseSeconds_(d[i][1]), closeSec = parseSeconds_(d[i][2]);
    if (openSec === null || closeSec === null) continue;
    out.push({
      b: br,
      openSec: openSec, closeSec: closeSec,
      open: fmtHMS_(openSec), close: fmtHMS_(closeSec),
      by: normName_(v[i][3]),
      at: dateKey_(v[i][4], d[i][4], tz)
    });
  }
  return out;
}

/** ماب سريع: مفتاح اسم الفرع → آخر أوقات مسجلة */
function hoursMap_() {
  var map = {};
  readHours_().forEach(function (h) { map[keyOf_(h.b)] = h; });
  return map;
}

/** الأوقات الأساسية لفرع: BRANCH_HOURS → عنوان الشيت → 9:00 ص/وقت القفل الافتراضي */
function hoursInfoBase_(sh, map) {
  var name = sh.getName();
  var rec = (map && map[keyOf_(name)]) || null;
  var openSec, closeSec;
  if (rec) {
    openSec = rec.openSec; closeSec = rec.closeSec;
  } else {
    var ci = legacyClose_(sh);
    openSec = (CONFIG.SHIFT_START_HOUR || 9) * 3600;
    closeSec = ci.sec;
  }
  return { openSec: openSec, closeSec: closeSec, open: fmtHMS_(openSec), close: fmtHMS_(closeSec), closed: false, source: 'base' };
}

/** أوقات العمل المعتمدة لفرع في يوم محدد: BRANCH_DAILY_HOURS → BRANCH_HOURS → الافتراضي */
function hoursInfo_(sh, map, dateKey) {
  var rec = branchRec_(sh.getName(), null);
  if (rec) {
    var d = dayHours_(rec, dateKey || nowParts_().key);
    return { openSec: d.openSec, closeSec: d.closeSec, open: fmtHMS_(d.openSec), close: fmtHMS_(d.closeSec), closed: !!d.closed, source: d.source };
  }
  return hoursInfoBase_(sh, map);
}

/** حفظ/تعديل أوقات عمل فرع (مانجمنت بس) — بيحدّث BRANCH_HOURS وعنوان الشيت */
function saveBranchHours(token, branch, open, close, restaurant) {
  var user = auth_(token, [ROLE_MGMT]);
  rateLimit_('hours:' + user.username, CONFIG.RATE_WRITE, 3600);
  branch = cleanText_(branch, 60);
  if (!branch) throw new Error('اختار الفرع الأول.');
  var rec = branchRecForUser_(user, branch, restaurant);
  if (!rec) throw new Error('الفرع "' + branch + '" غير موجود في المطعم المحدد.');
  branch = rec.name;
  var openSec = parseSeconds_(open), closeSec = parseSeconds_(close);
  if (openSec === null) throw new Error('وقت الفتح غير صحيح (مثال: 09:00).');
  if (closeSec === null) throw new Error('وقت القفل غير صحيح (مثال: 05:00).');
  if (openSec === closeSec) throw new Error('وقت الفتح ووقت القفل مينفعش يكونوا نفس الوقت.');

  withLock_(function () {
    var sh = rec.sheet;
    var actual = rec.name, branchKey = rec.key;
    var hs = getHoursSheet_(true);
    var n = hs.getLastRow() - 1, row = 0;
    if (n >= 1) {
      var names = hs.getRange(2, 1, n, 1).getDisplayValues();
      for (var i = 0; i < n; i++) if (keyOf_(names[i][0]) === keyOf_(branchKey)) row = 2 + i;
    }
    var vals = [sheetSafe_(branchKey), fmtHMS_(openSec), fmtHMS_(closeSec), sheetSafe_(user.username), new Date()];
    if (row) hs.getRange(row, 1, 1, 5).setValues([vals]);
    else hs.appendRow(vals);
    // تحديث عنوان الشيت (توافق مع أي قراءة قديمة لوقت القفل)
    try { sh.getRange('A1').setValue(sheetSafe_(actual + '  ' + fmtHMS_(openSec) + ' - ' + fmtHMS_(closeSec))); } catch (e) {}
  });

  cacheClear_();
  audit_(user, 'HOURS_UPDATE', branch, { open: fmtHMS_(openSec), close: fmtHMS_(closeSec) }, 'OK');
  var res = { ok: true, branch: branch, open: fmtHMS_(openSec), close: fmtHMS_(closeSec) };
  res.data = safePayload_(user);
  return res;
}

/** يوزر دسباتشر سريع للفرع الجديد — بيرجّع بيانات الدخول */
function quickBranchUser_(username, branch) {
  var sh = getUsersSheet_(true);
  var rec = branchRec_(branch, null);
  if (!rec) throw new Error('الفرع غير موجود أو غير فريد.');
  var salt = Utilities.getUuid(), pass = randomPass_(10);
  sh.appendRow([sheetSafe_(username), ROLE_BRANCH, sheetSafe_(branch), salt, hashPass_(salt, pass), true,
    Utilities.formatDate(new Date(), CONFIG.TZ, 'yyyy-MM-dd h:mm:ss a'), sheetSafe_(rec.restaurant), false]);
  usersCacheClear_();
  return { username: username, password: pass };
}

/**
 * إضافة فرع جديد بالكامل (مانجمنت بس):
 * شيت جديد + هيدرز + فورمات + أوقات عمل + أوقات تحضير/توصيل + (اختياري) يوزر دسباتشر.
 * info = { name, open, close, prep, del, createUser, username }
 */
function createBranch(token, info) {
  var user = requireAdmin_(auth_(token, [ROLE_MGMT]));
  rateLimit_('createbranch:' + user.username, CONFIG.RATE_WRITE, 3600);
  info = info || {};
  var name = cleanText_(info.name, 60);
  if (name.length < 2) throw new Error('اسم الفرع لازم يكون حرفين على الأقل.');
  if (name.length > 60) throw new Error('اسم الفرع طويل جدا (الحد 60 حرف).');
  if (/[\[\]\*\?\/\\:]/.test(name)) throw new Error('اسم الفرع مينفعش يكون فيه الرموز [ ] * ? / \\ :');
  var restId = resolveRestaurant_(user, info.restaurant || info.rest);
  if (isSystemSheet_(name)) throw new Error('الاسم "' + name + '" محجوز لشيت نظام.');

  var openSec = parseSeconds_(info.open), closeSec = parseSeconds_(info.close);
  if (openSec === null) throw new Error('وقت الفتح غير صحيح (مثال: 09:00).');
  if (closeSec === null) throw new Error('وقت القفل غير صحيح (مثال: 05:00).');
  if (openSec === closeSec) throw new Error('وقت الفتح ووقت القفل مينفعش يكونوا نفس الوقت.');

  var prep = numFrom_(info.prep), del = numFrom_(info.del);
  prep = (prep === null ? 0 : Math.round(prep));
  del = (del === null ? 0 : Math.round(del));
  if (prep < 0 || prep > 600) throw new Error('وقت التحضير لازم يكون من 0 لـ 600 دقيقة.');
  if (del < 0 || del > 600) throw new Error('وقت التوصيل لازم يكون من 0 لـ 600 دقيقة.');

  var wantUser = !!info.createUser;
  var uname = cleanText_(info.username, 30);
  if (wantUser && uname && !/^[A-Za-z0-9_.\-]{3,30}$/.test(uname)) {
    throw new Error('اسم مستخدم الدسباتشر 3-30 حرف إنجليزي/أرقام (مسموح . _ -).');
  }

  var res = withLock_(function () {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheetName = branchSheetName_(restId, name);
    if (ss.getSheetByName(sheetName)) throw new Error('في شيت بنفس الاسم "' + sheetName + '" بالفعل.');
    branchRecords_().forEach(function (b) {
      if (keyOf_(b.restaurant) !== keyOf_(restId)) return;
      if (keyOf_(b.name) === keyOf_(name) || keyOf_(b.key) === keyOf_(name)) throw new Error('الفرع "' + name + '" موجود بالفعل في المطعم ده.');
    });

    var sh = ss.insertSheet(sheetName);
    sh.getRange('A1').setValue(sheetSafe_(name + '  ' + fmtHMS_(openSec) + ' - ' + fmtHMS_(closeSec)));
    var hdr = ['Date', 'Day', 'Item Name', 'Stop Time', 'Start Time', 'Duration', 'Reason', 'Reason BRANCH', 'Brand', 'Branch'];
    sh.getRange(CONFIG.HEADER_ROW, 1, 1, CONFIG.COLS).setValues([hdr]);
    sh.getRange(CONFIG.HEADER_ROW, 1, 1, CONFIG.COLS).setFontWeight('bold').setBackground('#F5F2EB');
    sh.getRange(CONFIG.HEADER_ROW, 9, 1, 2).setHorizontalAlignment('center');
    sh.setFrozenRows(CONFIG.HEADER_ROW);

    var rows = Math.max(sh.getMaxRows() - CONFIG.FIRST_ROW + 1, 1);
    sh.getRange(CONFIG.FIRST_ROW, 1, rows, 1).setNumberFormat('dd/mm/yyyy');
    sh.getRange(CONFIG.FIRST_ROW, 2, rows, 1).setNumberFormat('dddd');
    sh.getRange(CONFIG.FIRST_ROW, 4, rows, 2).setNumberFormat('h:mm:ss AM/PM');
    sh.getRange(CONFIG.FIRST_ROW, 6, rows, 1).setNumberFormat('[h]:mm:ss');
    sh.getRange(CONFIG.FIRST_ROW, 9, rows, 2).setNumberFormat('@');

    getHoursSheet_(true).appendRow([sheetSafe_(sheetName), fmtHMS_(openSec), fmtHMS_(closeSec), sheetSafe_(user.username), new Date()]);
    getTimesSheet_(true).appendRow([sheetSafe_(sheetName), prep, del, sheetSafe_(user.username), new Date()]);
    registerBranch_(restId, name, sheetName, user);
    safeApplyValidations_(restId);

    return { ok: true, name: name, key: sheetName, restaurant: restId, open: fmtHMS_(openSec), close: fmtHMS_(closeSec), prep: prep, del: del };
  });

  // يوزر الدسباتشر (اختياري) — لو فشل مبيعطّلش إنشاء الفرع
  if (wantUser) {
    try {
      var ukeys = {};
      readUsers_().forEach(function (u) { ukeys[keyOf_(u.username)] = 1; });
      var taken = !!(uname && ukeys[keyOf_(uname)]);
      if (!uname) {
        var base = 'branch', i = 1;
        while (ukeys[keyOf_(base + i)]) i++;
        uname = base + i;
      }
      if (taken) throw new Error('اسم المستخدم "' + uname + '" مستخدم بالفعل.');
      res.user = withLock_(function () { return quickBranchUser_(uname, res.key || name); });
    } catch (e) {
      res.userError = publicMsg_(e && e.message ? e.message : e);
    }
  }

  cacheClear_();
  audit_(user, 'BRANCH_CREATE', name, { open: res.open, close: res.close, prep: prep, del: del, user: res.user ? res.user.username : '' }, 'OK');
  res.data = safePayload_(user);
  return res;
}

/* ============================================================
 *  الحذف الآمن للفروع (Secure Branch Deletion)
 *  - تأكيد صريح: اسم الفرع + كلمة سر المدير + موافقة
 *  - منع الحذف لو فيه سجلات تشغيل (إلا لو اختار أرشفة + حذف)
 *  - أرشفة كاملة (مضغوطة + Checksum) قبل الحذف
 *  - Cascading: BRANCH_HOURS + BRANCH_TIMES + يوزرات الفرع (تعطيل)
 *  - Audit Log لكل عملية
 * ============================================================ */

function sha256Hex_(s) {
  try {
    var d = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(s), Utilities.Charset.UTF_8);
    return d.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
  } catch (e) { return ''; }
}

/** ضغط + Base64 + Checksum لأي JSON (عشان الأرشيف ميكبرش الشيت) */
function packArchive_(obj) {
  var json = JSON.stringify(obj);
  var b64 = '';
  try {
    var gz = Utilities.gzip(Utilities.newBlob(json, 'application/json'));
    b64 = Utilities.base64Encode(gz.getBytes());
  } catch (e) {
    b64 = Utilities.base64Encode(json, Utilities.Charset.UTF_8);
  }
  return { checksum: sha256Hex_(json), payload: b64, bytes: json.length };
}

/** معلومات الفرع قبل الحذف — بتظهر في نافذة التأكيد */
function branchDeleteInfo(token, name, restaurant) {
  var user = auth_(token, [ROLE_MGMT]);
  name = cleanText_(name, 60);
  if (!name) throw new Error('اختار الفرع.');
  return guard_('branchDeleteInfo', function () {
    var rec0 = branchRecForUser_(user, name, restaurant);
    if (!rec0) throw new Error('الفرع "' + name + '" غير موجود في المطعم المحدد.');
    name = rec0.name;
    var sh = rec0.sheet;
    var rows = Math.max(0, sh.getLastRow() - CONFIG.FIRST_ROW + 1);
    var openRows = 0;
    if (rows > 0) {
      var vals = sh.getRange(CONFIG.FIRST_ROW, 4, rows, 2).getValues();   // D + E
      vals.forEach(function (r) {
        if (String(r[1]).trim() === '' && String(r[0]).trim() !== '') openRows++;
      });
    }
    var users = readUsers_().filter(function (u) {
      return (keyOf_(u.branch) === keyOf_(rec0.key) || keyOf_(u.branch) === keyOf_(rec0.name)) &&
        (!u.restaurant || keyOf_(u.restaurant) === keyOf_(rec0.restaurant));
    })
      .map(function (u) { return { username: u.username, role: u.role, active: u.active }; });
    var timesCount = readTimes_().filter(function (t) { return keyOf_(t.b) === keyOf_(rec0.key); }).length;
    var hoursCount = readHours_().filter(function (h) { return keyOf_(h.b) === keyOf_(rec0.key); }).length;
    return {
      ok: true, name: sh.getName(), restaurant: rec0.restaurant,
      branches: getBranchSheets_().length,
      rows: rows, openRows: openRows, users: users,
      timesRows: timesCount, hoursRows: hoursCount,
      blocked: rows > 0
    };
  });
}

/**
 * حذف فرع — info = { name, confirm, password, mode:'block'|'cascade', ack:true }
 * mode=block   : يرفض لو فيه أي سجل تشغيل (الأمان الافتراضي)
 * mode=cascade : يؤرشف كل حاجة بعدين يحذف (Cascading Deletes)
 */
function deleteBranch(token, info) {
  info = info || {};
  var user = requireAdmin_(reAuth_(token, info.password));                 // أدمن + كلمة السر
  var name = cleanText_(info.name, 60);
  if (!name) throw new Error('اختار الفرع.');
  if (!info.ack) throw new Error('لازم توافق على الحذف الأول.');
  if (keyOf_(cleanText_(info.confirm, 60)) !== keyOf_(name)) throw new Error('اكتب اسم الفرع بالظبط للتأكيد.');
  rateLimit_('delbranch:' + user.username, CONFIG.RATE_DELETE, 3600);

  var mode = String(info.mode || 'block').toLowerCase();
  if (mode !== 'block' && mode !== 'cascade') throw new Error('طريقة الحذف غير صحيحة.');

  var result = withLock_(function () {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var rec = branchRecForUser_(user, name, info.restaurant);
    if (!rec) throw new Error('الفرع غير موجود في المطعم المحدد.');
    var sh = rec.sheet;
    var actual = sh.getName();
    if (getBranchSheets_().length <= 1) throw new Error('مينفعش تحذف آخر فرع في النظام.');

    var lastRow = sh.getLastRow();
    var rowsCount = Math.max(0, lastRow - CONFIG.FIRST_ROW + 1);
    var rows = [];
    var openRows = 0;
    if (rowsCount > 0) {
      var rng = sh.getRange(CONFIG.FIRST_ROW, 1, rowsCount, CONFIG.COLS);
      var v = rng.getValues(), d = rng.getDisplayValues();
      for (var i = 0; i < rowsCount; i++) {
        if (!String(v[i][2] || '').trim()) continue;          // صف فاضي
        var isOpen = String(d[i][4] || '').trim() === '';
        if (isOpen) openRows++;
        rows.push({
          date: d[i][0], day: d[i][1], item: v[i][2],
          stop: d[i][3], start: d[i][4], duration: d[i][5],
          reason: v[i][6], note: v[i][7]
        });
      }
    }

    if (rows.length > 0 && mode !== 'cascade') {
      throw new Error('الفرع فيه ' + rows.length + ' سجل تشغيل (' + openRows + ' موقوف حاليًا). انقل البيانات الأول أو اختار "أرشفة وحذف".');
    }

    var users = readUsers_();
    var branchUsers = users.filter(function (u) {
      return (keyOf_(u.branch) === keyOf_(rec.key) || keyOf_(u.branch) === keyOf_(rec.name)) &&
        (!u.restaurant || keyOf_(u.restaurant) === keyOf_(rec.restaurant));
    });
    var hoursRows = readHours_().filter(function (h) { return keyOf_(h.b) === keyOf_(actual); });
    var timesRows = readTimes_().filter(function (t) { return keyOf_(t.b) === keyOf_(actual); });

    var archiveId = '';
    if (mode === 'cascade') {
      archiveId = 'ARC-' + Utilities.formatDate(new Date(), CONFIG.TZ, 'yyyyMMdd-HHmmss') + '-' + randomPass_(4).toUpperCase();
      var packed = packArchive_({
        version: 1,
        branch: actual,
        deletedAt: Utilities.formatDate(new Date(), CONFIG.TZ, 'yyyy-MM-dd HH:mm:ss'),
        deletedBy: user.username,
        rows: rows,
        hours: hoursRows,
        times: timesRows,
        users: branchUsers.map(function (u) { return { username: u.username, role: u.role, active: u.active }; })
      });

      // الكتابة على أجزاء (حد الخلية ~50 ألف حرف)
      var as = getArchiveSheet_(true);
      var CH = 45000, chunks = [];
      for (var p = 0; p < packed.payload.length; p += CH) chunks.push(packed.payload.slice(p, p + CH));
      if (!chunks.length) chunks.push('');
      chunks.forEach(function (chunk, idx) {
        as.appendRow([
          sheetSafe_(archiveId), new Date(), sheetSafe_(user.username), sheetSafe_(actual),
          rows.length, openRows, branchUsers.length, packed.checksum,
          (idx + 1) + '/' + chunks.length, sheetSafe_(chunk)
        ]);
      });
    }

    // 1) شيل تسجيل الفرع من السجل ثم احذف الشيت
    unregisterBranch_(actual);
    ss.deleteSheet(sh);

    // 2) Cascading: شيل صفوف BRANCH_HOURS / BRANCH_TIMES / المواعيد اليومية / تخصيصات المنيو
    removeBranchRows_(getHoursSheet_(false), actual);
    removeBranchRows_(getTimesSheet_(false), actual);
    removeBranchRows_(tblSheet_(CONFIG.DAILY_SHEET, DAILY_HEADERS, false), actual, 2);
    removeBranchRows_(tblSheet_(CONFIG.MENU_SHEET, MENU_HEADERS, false), actual, 2);
    removeBranchRows_(tblSheet_(CONFIG.REASONS_SHEET, REASON_HEADERS, false), actual, 2);
    DAILY_CACHE_ = { at: 0, rows: null };
    MENU_CACHE_ = { at: 0, rows: null };

    // 3) تعطيل يوزرات الفرع (مش حذفهم — عشان الـ Audit والرجوع)
    var deactivated = 0;
    if (branchUsers.length) {
      var ush = getUsersSheet_(false);
      branchUsers.forEach(function (u) {
        if (!u.active) return;
        ush.getRange(u.row, 6).setValue(false);
        bumpUserVer_(u.username);
        deactivated++;
      });
      usersCacheClear_();
    }

    return {
      ok: true, name: actual, archived: mode === 'cascade', archiveId: archiveId,
      rows: rows.length, openRows: openRows, usersDeactivated: deactivated
    };
  });

  cacheClear_();
  audit_(user, 'BRANCH_DELETE', result.name, {
    mode: mode, rows: result.rows, openRows: result.openRows,
    usersDeactivated: result.usersDeactivated, archiveId: result.archiveId
  }, 'OK', result.archiveId);
  result.data = safePayload_(user);
  return result;
}

/** شيل كل صفوف فرع معين من شيت (بيمشي من تحت لفوق) */
function removeBranchRows_(sh, branch, branchColumn) {
  if (!sh) return 0;
  var n = sh.getLastRow() - 1;
  if (n < 1) return 0;
  var col = branchColumn || 1;
  var names = sh.getRange(2, col, n, 1).getValues();
  var removed = 0;
  for (var i = n - 1; i >= 0; i--) {
    if (keyOf_(names[i][0]) === keyOf_(branch)) { sh.deleteRow(i + 2); removed++; }
  }
  return removed;
}

/* ============================================================
 *  أوقات التحضير والتوصيل — قيمة ثابتة لكل فرع (بالدقايق)
 *  شيت BRANCH_TIMES تاريخي: كل تعديل بيتسجل في صف، عشان نقدر
 *  نقارن بين الشهور ونعرف قيمة كل شهر وقتها.
 * ============================================================ */

function getTimesSheet_(create) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(CONFIG.TIMES_SHEET);
  if (!sh && create) {
    sh = ss.insertSheet(CONFIG.TIMES_SHEET);
    sh.getRange(1, 1, 1, 5).setValues([['Branch', 'PrepMin', 'DeliveryMin', 'UpdatedBy', 'UpdatedAt']]);
    sh.getRange(1, 1, 1, 5).setFontWeight('bold');
    sh.getRange(1, 5, Math.max(sh.getMaxRows() - 1, 1), 1).setNumberFormat('yyyy-mm-dd hh:mm:ss');
    sh.setFrozenRows(1);
    try { sh.hideSheet(); } catch (e) {}
    protectSheet_(sh, 'BRANCH_TIMES — نظام');
  }
  return sh;
}

/** رقم من خلية/قيمة (بيتعامل مع الأرقام العربية والمسافات) */
function numFrom_(v) {
  if (v === null || v === undefined || v === '') return null;
  var s = arDigits_(normName_(v)).replace(/[^\d.\-]/g, '');
  if (s === '' || s === '-' || s === '.') return null;
  var n = parseFloat(s);
  return isFinite(n) ? n : null;
}

/** كل تعديلات الأوقات مرتبة زمنيًا — العميل بيستنتج القيمة الحالية وقيمة أي شهر */
function readTimes_() {
  var sh = getTimesSheet_(false);
  if (!sh) return [];
  var n = sh.getLastRow() - 1;
  if (n < 1) return [];
  var tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  var rng = sh.getRange(2, 1, n, 5);
  var v = rng.getValues(), d = rng.getDisplayValues();
  var out = [];
  for (var i = 0; i < n; i++) {
    var br = normName_(v[i][0]);
    if (!br) continue;
    var prep = numFrom_(v[i][1]), del = numFrom_(v[i][2]);
    if (prep === null || del === null) continue;
    out.push({
      b: br,
      prep: Math.round(prep),
      del: Math.round(del),
      by: normName_(v[i][3]),
      at: dateKey_(v[i][4], d[i][4], tz)
    });
  }
  return out;
}

/** حفظ أوقات فرع: مانجمنت أي فرع — دسباتشر فرعه بس. بيرجّع القيمة + الداتا المحدثة */
function saveBranchTimes(token, branch, prepMin, delMin) {
  var user = auth_(token, [ROLE_MGMT, ROLE_BRANCH]);
  rateLimit_('times:' + user.username, CONFIG.RATE_WRITE, 3600);
  if (user.role === ROLE_BRANCH) branch = user.branch;
  branch = cleanText_(branch, 60);
  if (!branch) throw new Error('اختار الفرع الأول.');

  var prep = assertInt_(prepMin, 'وقت التحضير (بالدقايق)', 0, 600);
  var del = assertInt_(delMin, 'وقت التوصيل (بالدقايق)', 0, 600);

  var rec = branchRecForUser_(user, branch);
  if (!rec) throw new Error('الفرع "' + branch + '" غير موجود.');
  branch = rec.name;

  withLock_(function () {
    var sh = getTimesSheet_(true);
    var branchKey = rec.key, last = null;
    readTimes_().forEach(function (x) { if (keyOf_(x.b) === keyOf_(branchKey)) last = x; });
    if (last && last.prep === prep && last.del === del) return;   // نفس القيمة → مفيش صف جديد
    sh.appendRow([sheetSafe_(branchKey), prep, del, sheetSafe_(user.username), new Date()]);
  });

  cacheClear_();
  audit_(user, 'TIMES_UPDATE', rec.name, { restaurant: rec.restaurant, prep: prep, del: del }, 'OK');
  var result = { ok: true, branch: rec.name, prep: prep, del: del, total: prep + del };
  result.data = safePayload_(user);
  return result;
}

/* ============================================================
 *  تسجيل إيقاف / تشغيل
 * ============================================================ */

/**
 * خيارات شاشة الإيقاف: البراند ← فروعه ← أصنافه وأسبابه والموقوف حاليًا.
 * بترجّع البراندات المسموحة لليوزر فقط (عزل كامل)، وبتستخدم في القوائم المتسلسلة.
 */
function getStopOptions(token, restaurant) {
  var user = auth_(token, [ROLE_MGMT, ROLE_BRANCH]);
  ensureTenancy_();
  var rid = resolveRestaurant_(user, restaurant);
  var now = nowParts_();

  var branches = scopedBranchRecs_(user).filter(function (rec) {
    return keyOf_(rec.restaurant) === keyOf_(rid);
  }).map(function (rec) {
    var si = shiftInfo_(rec, now);
    var sh = rec.sheet, stopped = [], seen = {};
    var n = sh.getLastRow() - CONFIG.FIRST_ROW + 1;
    if (n >= 1) {
      var cde = sh.getRange(CONFIG.FIRST_ROW, 3, n, 3).getDisplayValues();
      for (var i = 0; i < n; i++) {
        var it = normName_(cde[i][0]);
        if (!it) continue;
        if (parseSeconds_(cde[i][2]) === null && parseSeconds_(cde[i][1]) !== null && !seen[keyOf_(it)]) {
          seen[keyOf_(it)] = 1;
          stopped.push(it);
        }
      }
    }
    return {
      key: rec.key, name: rec.name, restaurant: rec.restaurant,
      brandName: brandNameFor_(rec.restaurant),
      closed: !si.openNow, open: fmtHMS_(si.openSec), close: fmtHMS_(si.closeSec),
      items: menuForBranch_(rec.restaurant, rec.key).map(function (x) { return x.it; }),
      reasons: reasonsForBranch_(rec.restaurant, rec.key),
      stopped: stopped
    };
  });

  var brands = readRestaurants_(false).filter(function (r) {
    return r.active && (isGlobalUser_(user) || keyOf_(r.id) === keyOf_(ridFor_(user)));
  }).map(function (r) { return { id: r.id, name: r.name }; });

  return {
    ok: true, restaurant: rid, restaurantName: brandNameFor_(rid),
    brands: brands, now: now.key + ' ' + now.hms, branches: branches
  };
}

/**
 * تسجيل إيقاف صنف — الشكل الجديد:
 *   logStop(token, restaurant, branch, item, reason, note, scope)
 *   restaurant = كود البراند، scope = 'branch' لفرع واحد أو 'all' لكل فروع البراند.
 * ولسه بيدعم النداء القديم (token, branch, item, reason, note) للتوافق.
 */
function logStop(token, restaurant, branch, item, reason, note, scope) {
  var user = auth_(token, [ROLE_MGMT, ROLE_BRANCH]);
  if (arguments.length <= 5) {                    // نداء قديم: مفيش براند ولا نطاق
    var oldBranch = restaurant, oldItem = branch, oldReason = item, oldNote = reason;
    restaurant = ''; branch = oldBranch; item = oldItem; reason = oldReason; note = oldNote; scope = 'branch';
  }
  if (user.role === ROLE_BRANCH) {                // الدسباتشر مقدرش يختار براند/فرع/نطاق تاني
    restaurant = ridFor_(user);
    branch = user.branch;
    scope = 'branch';
  }
  return logStop_(user, restaurant, branch, item, reason, note, scope);
}

/**
 * تسجيل إيقاف صنف في فرع واحد أو كل فروع البراند دفعة واحدة.
 * كل فرع بيتحقق لوحده (مفتوح + الصنف في منيوه + السبب في قايمته + مش موقوف بالفعل)،
 * والفروع اللي مش متاحة بتتخطى مع سبب واضح بدل ما العملية كلها تفشل.
 */
function logStop_(user, restaurant, branch, item, reason, note, scope) {
  restaurant = cleanText_(restaurant, 40);
  branch = cleanText_(branch, 60);
  item = cleanText_(item, CONFIG.MAX_TEXT);
  reason = cleanText_(reason, CONFIG.MAX_TEXT);
  note = cleanText_(note, 300);
  scope = keyOf_(scope) === 'all' ? 'all' : 'branch';

  if (!item) throw new Error('اختار الصنف الأول.');
  if (!reason) throw new Error('لازم تختار سبب الإيقاف من القايمة.');
  if (keyOf_(reason) === keyOf_(UNSPEC)) throw new Error('مينفعش "' + UNSPEC + '" — اختار سبب حقيقي من القايمة.');
  if (isOtherReason_(reason) && !note) throw new Error('اكتب وصف السبب (أسباب أخرى) الأول.');
  if (/^[=+\-@]/.test(item) || /^[=+\-@]/.test(note)) throw new Error('النص مينفعش يبدأ بـ = + - @');
  if (scope === 'all' && !restaurant) throw new Error('اختار البراند الأول عشان نوقف الصنف في كل فروعه.');
  if (scope !== 'all' && !branch) throw new Error('اختار الفرع.');

  // تحديد البراند: من اللي اتبعت، أو من الفرع في النداء القديم
  var rid = '';
  if (restaurant) rid = resolveRestaurant_(user, restaurant);
  if (!rid) {
    var probe = branchRecForUser_(user, branch);
    if (!probe) throw new Error('الفرع "' + branch + '" غير موجود أو مش تابع للبراند.');
    rid = probe.restaurant;
  }

  var targets = [];
  if (scope === 'all') {
    targets = branchRecords_().filter(function (b) { return keyOf_(b.restaurant) === keyOf_(rid); });
    if (!targets.length) throw new Error('مفيش فروع مسجلة للبراند "' + brandNameFor_(rid) + '".');
  } else {
    var rec = branchRecForUser_(user, branch, rid);
    if (!rec) throw new Error('الفرع "' + branch + '" غير موجود أو مش تابع للبراند المحدد.');
    targets = [rec];
  }

  return withLock_(function () {
    var now = nowParts_();
    var results = [], applied = 0, firstRow = null;
    targets.forEach(function (r) {
      var res = appendStopRow_(r, item, reason, note, now);
      if (res.ok) { applied++; if (firstRow === null) firstRow = res.row; }
      results.push(res);
    });

    if (!applied) {
      var bad = results.filter(function (r) { return !r.ok; });
      var why = bad.length ? bad[0].error : 'تعذر تسجيل الإيقاف.';
      throw new Error((scope === 'all'
        ? 'مقدرناش نوقف "' + item + '" في أي فرع من "' + brandNameFor_(rid) + '": '
        : 'مقدرناش نوقف "' + item + '" في "' + branch + '": ') + why);
    }

    if (applied) SpreadsheetApp.flush();   // دفعة واحدة بعد كل الفروع
    bumpLive_();
    return {
      ok: true, scope: scope,
      restaurant: rid, restaurantName: brandNameFor_(rid),
      branch: scope === 'branch' ? targets[0].name : '',
      item: item, reason: reason, time: now.hms,
      applied: applied, skipped: results.length - applied,
      results: results, row: firstRow,
      data: safePayload_(user)
    };
  });
}

/**
 * كتابة صف إيقاف في شيت فرع واحد (A:J) — بترجع نتيجة واضحة بدل ما توقف العملية كلها.
 * I = البراند و J = الفرع بيتسجلوا صراحة مع كل عملية إيقاف.
 */
function appendStopRow_(rec, item, reason, note, now) {
  var out = { branch: rec.name, key: rec.key, ok: false, error: '' };
  try {
    ensureBranchMetaColumns_(rec);
    var si = shiftInfo_(rec, now);
    if (!si.openNow) { out.error = 'الفرع مقفول حاليًا حسب مواعيد العمل.'; return out; }

    var itemsOk = menuForBranch_(rec.restaurant, rec.key).some(function (x) { return keyOf_(x.it) === keyOf_(item); });
    if (!itemsOk) { out.error = 'الصنف مش في منيو الفرع.'; return out; }
    var reasonsOk = reasonsForBranch_(rec.restaurant, rec.key).some(function (x) { return keyOf_(x) === keyOf_(reason); });
    if (!reasonsOk) { out.error = 'السبب مش في قايمة الفرع.'; return out; }

    var sh = rec.sheet;
    // آخر صف فيه ايتم + هل الايتم ده موقوف بالفعل؟
    var n = sh.getLastRow() - CONFIG.FIRST_ROW + 1;
    var lastData = CONFIG.FIRST_ROW - 1;
    if (n >= 1) {
      var cde = sh.getRange(CONFIG.FIRST_ROW, 3, n, 3).getDisplayValues();
      for (var i = 0; i < n; i++) {
        var nm = normName_(cde[i][0]);
        if (!nm) continue;
        lastData = CONFIG.FIRST_ROW + i;
        if (keyOf_(nm) === keyOf_(item) && parseSeconds_(cde[i][2]) === null && parseSeconds_(cde[i][1]) !== null) {
          out.error = 'الصنف موقوف بالفعل (صف ' + (CONFIG.FIRST_ROW + i) + ') — سجّل له تشغيل الأول.';
          return out;
        }
      }
    }

    var row = lastData + 1;
    if (row > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), 50);
    // تثبيت الفورمات مباشرة — كل الأوقات h:mm:ss AM/PM والمدة [h]:mm:ss
    sh.getRange(row, 1).setNumberFormat('dd/mm/yyyy');
    sh.getRange(row, 2).setNumberFormat('dddd');
    sh.getRange(row, 4).setNumberFormat('h:mm:ss AM/PM');
    sh.getRange(row, 5).setNumberFormat('h:mm:ss AM/PM');
    sh.getRange(row, 6).setNumberFormat('[h]:mm:ss');
    sh.getRange(row, 1).setValue(now.serial);                       // A: تاريخ اليوم
    sh.getRange(row, 2).setFormula('=A' + row);                     // B: اليوم
    sh.getRange(row, 3).setValue(sheetSafe_(item));                // C: الايتم
    sh.getRange(row, 4).setValue(now.fraction);                     // D: وقت الإيقاف = الآن (بالثواني)
    sh.getRange(row, 5).clearContent();                             // E: فاضي = لسه موقوف
    sh.getRange(row, 6).setFormula('=IF(E' + row + '="","",MOD(E' + row + '-D' + row + ',1))');
    sh.getRange(row, 7).setValue(sheetSafe_(reason));               // G: السبب
    if (note) sh.getRange(row, 8).setValue(sheetSafe_(note));       // H: وصف الدسباتشر
    sh.getRange(row, 9).setNumberFormat('@').setValue(sheetSafe_(brandNameFor_(rec.restaurant)));  // I: البراند
    sh.getRange(row, 10).setNumberFormat('@').setValue(sheetSafe_(rec.name));                      // J: الفرع

    out.ok = true;
    out.row = row;
    return out;
  } catch (e) {
    out.error = publicMsg_(e && e.message ? e.message : e);
    return out;
  }
}

/** تسجيل تشغيل (مانجمنت: أي فرع — دسباتشر: فرعه بس) */
function resumeStop(token, branch, row, item) {
  var user = auth_(token, [ROLE_MGMT, ROLE_BRANCH]);
  if (user.role === ROLE_BRANCH) branch = user.branch;
  branch = cleanText_(branch, 60);
  item = cleanText_(item, CONFIG.MAX_TEXT);
  return resumeStop_(user, branch, row, item);
}

/** تسجيل تشغيل ايتم موقوف: بيكتب وقت الرجوع (E) = الآن والمدة بتتحسب لوحدها */
function resumeStop_(user, branch, row, item) {
  var rec = branchRecForUser_(user, branch);
  if (!rec) throw new Error('الفرع "' + branch + '" غير موجود أو مش تابع للمطعم.');
  if (user.role === ROLE_BRANCH && keyOf_(user.branch) !== keyOf_(rec.key) && keyOf_(user.branch) !== keyOf_(rec.name)) {
    throw new Error('مش مسموح بتشغيل ايتم في فرع تاني.');
  }
  try { ensureBranchMetaColumns_(rec); } catch (e) {}
  return withLock_(function () {
    var sh = rec.sheet;
    row = parseInt(row, 10);
    if (!(row >= CONFIG.FIRST_ROW && row <= sh.getLastRow())) throw new Error('رقم الصف غير صحيح، حدّث الداتا وجرّب تاني.');
    var disp = sh.getRange(row, 1, 1, CONFIG.COLS).getDisplayValues()[0];
    if (keyOf_(disp[2]) !== keyOf_(item)) throw new Error('الصف اتغيّر من ساعة ما فتحت الصفحة، حدّث الداتا وجرّب تاني.');
    if (parseSeconds_(disp[4]) !== null) throw new Error('الايتم ده اتسجل له تشغيل بالفعل.');

    var now = nowParts_();
    sh.getRange(row, 5).setNumberFormat('h:mm:ss AM/PM');
    sh.getRange(row, 5).setValue(now.fraction);
    sh.getRange(row, 6).setNumberFormat('[h]:mm:ss');
    sh.getRange(row, 6).setFormula('=IF(E' + row + '="","",MOD(E' + row + '-D' + row + ',1))');
    SpreadsheetApp.flush();

    bumpLive_();
    return { ok: true, time: now.hms, data: scopePayload_(freshPayload_(), user) };
  });
}

/* ============================================================
 *  اليوزرات والصلاحيات
 *  الأدوار:
 *   management = كل حاجة (التقارير + إضافة/حذف ايتم وريزون + إدارة اليوزرات + تسجيل إيقاف/تشغيل لأي فرع)
 *   branch     = دسباتشر فرع: يسجل إيقاف (يختار الايتم والسبب) ويشغّل الايتم — على فرعه بس
 *   agent      = قراءة فقط: الايتمات اللي وقفت واشتغلت (من غير ساعات ولا أسباب ولا تقارير)
 *
 *  كل دالة عامة بتتحقق من التوكن والدور على السيرفر.
 * ============================================================ */

function addDaysKey_(key, n) {
  var p = key.split('-'), t = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2] + n));
  return t.getUTCFullYear() + '-' + pad2_(t.getUTCMonth() + 1) + '-' + pad2_(t.getUTCDate());
}

/** شيت اليوزرات، مع ترحيل عمود صلاحية مدير النظام للنسخ القديمة */
function getUsersSheet_(create) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(CONFIG.USERS_SHEET);
  if (!sh && create) {
    sh = ss.insertSheet(CONFIG.USERS_SHEET);
    sh.getRange(1, 1, 1, 9).setValues([['Username', 'Role', 'Branch', 'Salt', 'Hash', 'Active', 'Created', 'Restaurant', 'Admin']]);
    sh.setFrozenRows(1);
    sh.hideSheet();
    protectSheet_(sh, 'USERS — نظام');
  }
  if (sh) {
    if (sh.getMaxColumns() < 9) sh.insertColumnsAfter(sh.getMaxColumns(), 9 - sh.getMaxColumns());
    if (String(sh.getRange(1, 9).getValue()).trim() !== 'Admin') sh.getRange(1, 9).setValue('Admin');
  }
  return sh;
}

function readUsers_() {
  var sh = getUsersSheet_(false);
  if (!sh || sh.getLastRow() < 2) return [];
  var vals = sh.getRange(2, 1, sh.getLastRow() - 1, 9).getValues(), out = [];
  vals.forEach(function (r, i) {
    var name = normName_(r[0]);
    if (!name) return;
    out.push({
      row: i + 2, username: name, role: String(r[1]).trim(), branch: normName_(r[2]),
      salt: String(r[3]), hash: String(r[4]), active: String(r[5]).toUpperCase() === 'TRUE',
      restaurant: normName_(r[7]),
      isAdmin: String(r[8]).toUpperCase() === 'TRUE' || keyOf_(name) === keyOf_(CONFIG.ADMIN_USER)
    });
  });
  return out;
}

/** خريطة اليوزرات (بتتخزن في الكاش دقيقتين وبتتمسح عند أي تعديل) */
function usersMap_() {
  var cache = CacheService.getScriptCache(), raw = cache.get('users_map');
  if (raw) { try { return JSON.parse(raw); } catch (e) {} }
  var map = {};
  readUsers_().forEach(function (u) { map[keyOf_(u.username)] = u; });
  try { cache.put('users_map', JSON.stringify(map), 120); } catch (e) {}
  return map;
}
function usersCacheClear_() { try { CacheService.getScriptCache().remove('users_map'); } catch (e) {} }

function hashPass_(salt, pass) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + ':' + pass, Utilities.Charset.UTF_8);
  return bytes.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}

function safeEqual_(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  var d = 0;
  for (var i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

function randomPass_(n) {
  var alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  var hex = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, ''), out = '';
  for (var i = 0; i < n; i++) out += alphabet.charAt(parseInt(hex.substr(i * 2, 2), 16) % alphabet.length);
  return out;
}

/** تسجيل الدخول: بيرجّع توكن + الداتا المفلترة حسب الدور في نفس النداء */
function login(username, password) {
  ensureTenancy_();
  username = cleanText_(username, 60);
  password = String(password || '').slice(0, 200);
  if (!username || !password) throw new Error('اكتب اسم المستخدم وكلمة السر.');
  var cache = CacheService.getScriptCache();
  var fk = 'fail_' + hashKey_(keyOf_(username));
  if (parseInt(cache.get(fk) || '0', 10) >= CONFIG.MAX_FAILS) {
    throw new Error('محاولات كتير غلط. استنى ' + Math.round(CONFIG.FAIL_LOCK / 60) + ' دقايق وجرّب تاني.');
  }
  var u = usersMap_()[keyOf_(username)];
  var ok = !!(u && u.active && safeEqual_(hashPass_(u.salt, password), u.hash));
  if (!ok) {
    try { cache.put(fk, String(parseInt(cache.get(fk) || '0', 10) + 1), CONFIG.FAIL_LOCK); } catch (e) {}
    audit_(null, 'LOGIN_FAIL', username, '', 'FAIL');
    Utilities.sleep(500);
    throw new Error('اسم المستخدم أو كلمة السر غلط.');
  }
  try { cache.remove(fk); } catch (e) {}
  var token = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
  try {
    cache.put('sess_' + token, JSON.stringify({
      u: u.username, v: userVer_(u.username), iat: Date.now()
    }), CONFIG.SESSION_TTL);
  } catch (e) { throw new Error('تعذر بدء الجلسة، جرّب تاني.'); }
  var user = userContext_(u);
  audit_(user, 'LOGIN', u.username, { restaurant: user.restaurant || CONFIG.REST_DEFAULT }, 'OK');
  return { token: token, data: scopePayload_(fullData_(false), user) };
}

function logout(token) {
  try {
    if (token) {
      var raw = CacheService.getScriptCache().get('sess_' + String(token));
      if (raw) {
        var s = null; try { s = JSON.parse(raw); } catch (e) {}
        var u = s && usersMap_()[keyOf_(s.u)];
        audit_(u ? { username: u.username, role: u.role } : null, 'LOGOUT', (s && s.u) || '', '', 'OK');
      }
      CacheService.getScriptCache().remove('sess_' + String(token));
    }
  } catch (e) {}
  return true;
}

/** تحقق من التوكن + الدور + إصدار الجلسة. بيرجّع اليوزر أو بيرمي SESSION_EXPIRED */
function auth_(token, roles) {
  var cache = CacheService.getScriptCache();
  var t = token ? String(token) : '';
  if (!/^[a-f0-9]{32,80}$/i.test(t)) throw new Error('SESSION_EXPIRED');   // شكل التوكن
  var raw = t ? cache.get('sess_' + t) : null;
  if (!raw) throw new Error('SESSION_EXPIRED');
  var s;
  try { s = JSON.parse(raw); } catch (e) { throw new Error('SESSION_EXPIRED'); }
  var u = usersMap_()[keyOf_(s.u)];
  if (!u || !u.active) throw new Error('SESSION_EXPIRED');                  // اليوزر اتحذف أو اتوقف
  if (s.v !== undefined && String(s.v) !== String(userVer_(u.username))) {  // الباسورد اتغير / اليوزر اتعطل
    try { cache.remove('sess_' + t); } catch (e) {}
    throw new Error('SESSION_EXPIRED');
  }
  cache.put('sess_' + t, raw, CONFIG.SESSION_TTL);                          // تجديد الجلسة مع النشاط
  var user = userContext_(u);
  if (roles && roles.indexOf(user.role) === -1) throw new Error('يجب استخدام صلاحية admin لتنفيذ العملية دي.');
  return user;
}

/**
 * بوابة الصلاحيات الحساسة: تتطلب دور management وصلاحية مدير النظام المسجلة.
 */
function requireAdmin_(user) {
  if (!user || !user.isAdmin) {
    throw new Error('يجب استخدام صلاحية admin لتنفيذ العملية دي.');
  }
  return user;
}

/** تأكيد هوية إضافي قبل أي عملية حذف/تعديل حساس (Re-authentication) */
function reAuth_(token, password) {
  var user = auth_(token, [ROLE_MGMT]);
  password = String(password || '').slice(0, 200);
  if (!password) throw new Error('اكتب كلمة السر للتأكيد.');
  rateLimit_('reauth:' + user.username, 12, 600);
  var u = usersMap_()[keyOf_(user.username)];
  if (!u || !safeEqual_(hashPass_(u.salt, password), u.hash)) {
    audit_(user, 'REAUTH_FAIL', user.username, '', 'FAIL');
    throw new Error('كلمة السر غلط.');
  }
  return user;
}

/** سجل العمليات (مانجمنت بس) */
function getAuditLog(token, limit) {
  var user = auth_(token, [ROLE_MGMT]);
  if (!isGlobalUser_(user)) throw new Error('سجل العمليات متاح للأدمن العام فقط.');
  return { ok: true, entries: readAudit_(limit || 200) };
}

/** حساب الإدارة العام (كل المطاعم) أو حساب مقيّد بمطعم واحد */
function isGlobalUser_(user) {
  return !!(user && user.role === ROLE_MGMT && user.isAdmin);
}

function ridFor_(user) {
  if (user && user.restaurant) return user.restaurant;
  return CONFIG.REST_DEFAULT;
}

function userContext_(record) {
  var user = {
    username: record.username,
    role: record.role,
    branch: record.branch || '',
    restaurant: record.restaurant || '',
    isAdmin: !!record.isAdmin || keyOf_(record.username) === keyOf_(CONFIG.ADMIN_USER)
  };
  if (user.role === ROLE_MGMT) {
    if (!user.restaurant && !isGlobalUser_(user)) user.restaurant = CONFIG.REST_DEFAULT;
    if (!isGlobalUser_(user) && !isActiveRestaurant_(user.restaurant)) {
      throw new Error('المطعم المرتبط بالحساب غير نشط.');
    }
    return user;
  }
  if (user.role !== ROLE_BRANCH && user.role !== ROLE_AGENT) return user;
  if (!user.branch) throw new Error('الحساب غير مربوط بفرع.');
  var rec = branchRec_(user.branch, user.restaurant || null);
  if (!rec) throw new Error('الحساب غير مربوط بفرع نشط أو أن ربط المطعم غير صحيح.');
  if (!isActiveRestaurant_(rec.restaurant)) throw new Error('المطعم المرتبط بالحساب غير نشط.');
  user.branch = rec.key;
  user.restaurant = rec.restaurant;
  return user;
}

function branchRecForUser_(user, branch, restaurant) {
  var scope = isGlobalUser_(user)
    ? (restaurant ? resolveRestaurant_(user, restaurant) : null)
    : ridFor_(user);
  var rec = branchRec_(branch, scope);
  if (!rec) return null;
  if (!isGlobalUser_(user) && !isActiveRestaurant_(rec.restaurant)) return null;
  return rec;
}

function pickMenu_(menu, branches) {
  var out = {};
  if (!menu) return out;
  (branches || []).forEach(function (b) { if (menu[b.key]) out[b.key] = menu[b.key]; });
  return out;
}

/** فلترة أي قايمة مربوطة باسم فرع على الفروع المسموحة */
function scopedByBranch_(list, allowed, field) {
  var records = branchRecords_(), allow = {};
  (allowed || []).forEach(function (b) { allow[keyOf_(b.key)] = 1; });
  var out = [];
  (list || []).forEach(function (x) {
    var value = keyOf_(x[field]), exact = records.filter(function (b) { return keyOf_(b.key) === value; });
    var matches = exact.length ? exact : records.filter(function (b) { return keyOf_(b.name) === value; });
    if (matches.length !== 1 || !allow[keyOf_(matches[0].key)]) return;
    var copy = {};
    Object.keys(x).forEach(function (k) { copy[k] = x[k]; });
    copy[field] = matches[0].key;
    out.push(copy);
  });
  return out;
}

function scopeBranch_(b, rows) {
  return {
    name: b.name, key: b.key, restaurant: b.restaurant, restaurantName: b.restaurantName || '',
    open: b.open, close: b.close, openSec: b.openSec, closeSec: b.closeSec,
    closed: !!b.closed, shiftDay: b.shiftDay, shiftKey: b.shiftKey, rolloverDue: !!b.rolloverDue,
    shift: b.shift || null, rows: rows, skipped: 0
  };
}

/** بيفلتر الداتا حسب الدور + البراند — اللي مش مسموح يشوفه مبيوصلش للمتصفح أصلا */
function scopePayload_(full, user) {
  var me = { username: user.username, role: user.role, branch: user.branch, restaurant: user.restaurant || '', isAdmin: !!user.isAdmin };
  var global = isGlobalUser_(user) && !user.scopeRestaurant;
  var adminGlobal = isGlobalUser_(user);
  var nowSec = (full.nowSec === 0 || full.nowSec) ? +full.nowSec : parseSeconds_(String(full.generatedAt || '').replace(/^\d{4}-\d{2}-\d{2}\s*/, ''));
  if (nowSec === null || isNaN(nowSec)) nowSec = nowParts_().sec;
  var nowBase = dayNum_(full.now) * 86400 + nowSec;
  var rid = ridFor_(user);

  var allowed = (full.branches || []).filter(function (b) {
    if (global) return true;
    if (keyOf_(b.restaurant) !== keyOf_(rid)) return false;
    if (user.role === ROLE_BRANCH || user.role === ROLE_AGENT) {
      return !!user.branch && (keyOf_(b.key) === keyOf_(user.branch) || keyOf_(b.name) === keyOf_(user.branch));
    }
    return true;
  });

  var out = {
    generatedAt: full.generatedAt, now: full.now, me: me,
    times: scopedByBranch_(full.times, allowed, 'b'),
    hours: scopedByBranch_(full.hours, allowed, 'b'),
    daily: (full.daily || []).filter(function (d) {
      return allowed.some(function (b) { return keyOf_(b.key) === keyOf_(d.branch); });
    }),
    shiftLog: (full.shiftLog || []).filter(function (x) {
      return allowed.some(function (b) { return keyOf_(b.key) === keyOf_(x.branch) || keyOf_(b.name) === keyOf_(x.branch); });
    }).slice(0, 25),
    restaurants: (full.restaurants || []).filter(function (r) {
      return adminGlobal || keyOf_(r.id) === keyOf_(rid);
    }),
    reasonsByBranch: {},
    roster: allowed.map(function (b) {
      return { name: b.name, key: b.key, restaurant: b.restaurant, restaurantName: b.restaurantName };
    }),
    reasons: (full.reasonsByRest && full.reasonsByRest[rid]) || []
  };
  allowed.forEach(function (b) {
    out.reasonsByBranch[b.key] = (full.reasonsByBranch && full.reasonsByBranch[b.key]) ||
      reasonsForBranch_(b.restaurant, b.key);
  });
  out.reasonsByRest = {};
  Object.keys(full.reasonsByRest || {}).forEach(function (restaurant) {
    if (global || keyOf_(restaurant) === keyOf_(rid)) {
      out.reasonsByRest[restaurant] = full.reasonsByRest[restaurant];
    }
  });

  if (user.role === ROLE_MGMT) {
    out.branches = allowed.map(function (b) { return scopeBranch_(b, b.rows); });
    out.items = global ? (full.items || []) : ((full.menus && full.menus[rid]) || []);
    out.menu = pickMenu_(full.menu, allowed);
    out.skipped = global ? full.skipped : 0;
    return out;
  }

  var branches = allowed.map(function (b) {
    var win = b.shift || null;
    var rows = b.rows.filter(function (r) {
      var ts = dayNum_(r.d) * 86400 + (+r.stv || 0);
      if (ts > nowBase) return false;                 // مفيش بيانات مستقبلية
      if (r.o) return true;                           // الموقوف حاليا يفضل ظاهر لحد ما يتشغّل
      if (win) return ts >= win.startAbs && ts <= win.endAbs;
      return ts >= dayNum_(full.now) * 86400;
    }).map(function (r) {
      if (user.role === ROLE_AGENT) return { d: r.d, it: r.it, st: r.st, en: r.en, stv: r.stv, env: r.env, o: r.o };
      return {
        d: r.d, it: r.it, st: r.st, en: r.en, stv: r.stv, env: r.env,
        h: r.h, du: r.du, r: r.r, n: r.n, o: r.o, c: r.c, v: r.v, x: r.x
      };
    });
    return scopeBranch_(b, rows);
  });
  out.branches = branches;
  out.shift = branches.length ? branches[0].shift : null;    // توافق قديم
  out.menu = pickMenu_(full.menu, branches);
  out.items = user.role === ROLE_BRANCH
    ? ((out.menu[user.branch] || []).map(function (item) { return item.it; }))
    : [];
  out.skipped = 0;
  return out;
}

/* ---------------- إدارة اليوزرات (مانجمنت بس) ---------------- */

function listUsersPublic_() {
  return readUsers_().map(function (u) {
    var scoped;
    try { scoped = userContext_(u); }
    catch (e) { scoped = u; }
    return {
      username: scoped.username, role: scoped.role, branch: scoped.branch,
      active: u.active, restaurant: scoped.restaurant || '', isAdmin: !!u.isAdmin
    };
  });
}

function listUsers(token) {
  var user = auth_(token, [ROLE_MGMT]);
  if (isGlobalUser_(user)) return listUsersPublic_();
  var out = [];
  readUsers_().forEach(function (record) {
    try {
      var scoped = userContext_(record);
      if (keyOf_(scoped.restaurant) !== keyOf_(ridFor_(user))) return;
      out.push({
        username: scoped.username, role: scoped.role, branch: scoped.branch,
        active: record.active, restaurant: scoped.restaurant, isAdmin: !!record.isAdmin
      });
    } catch (e) {}
  });
  return out;
}

/** إضافة/تعديل يوزر. الباسورد اختياري عند التعديل (فاضي = من غير تغيير) */
function saveUser(token, u) {
  var me = requireAdmin_(auth_(token, [ROLE_MGMT]));
  u = u || {};
  var username = cleanText_(u.username, 30);
  if (!/^[A-Za-z0-9_.\-]{3,30}$/.test(username)) throw new Error('اسم المستخدم 3-30 حرف إنجليزي أو أرقام (مسموح . _ -).');
  var role = String(u.role || '');
  if ([ROLE_MGMT, ROLE_BRANCH, ROLE_AGENT].indexOf(role) === -1) throw new Error('الدور غير صحيح.');
  var isAdmin = u.isAdmin === true || keyOf_(username) === keyOf_(CONFIG.ADMIN_USER);
  if (isAdmin && role !== ROLE_MGMT) throw new Error('صلاحية مدير النظام متاحة لحسابات المانجمنت فقط.');
  var branch = cleanText_(u.branch, 60);
  var rest = cleanText_(u.restaurant, 40);
  if (role === ROLE_MGMT) branch = '';
  if (role !== ROLE_MGMT && !branch) throw new Error('اختار الفرع المرتبط بالحساب.');
  if (branch) {
    var brec = branchRec_(branch, rest || (isGlobalUser_(me) ? null : me.restaurant));
    if (!brec) throw new Error('الفرع "' + branch + '" غير موجود في المطعم المحدد.');
    branch = brec.key;
    rest = brec.restaurant;
  }
  if (!isGlobalUser_(me) && me.restaurant) {
    if (rest && keyOf_(rest) !== keyOf_(me.restaurant)) throw new Error('مش مسموح بإنشاء يوزر لمطعم تاني.');
    rest = me.restaurant;
  }
  if (role === ROLE_MGMT && !rest && !isAdmin) rest = CONFIG.REST_DEFAULT;
  if (rest && !readRestaurants_(false).some(function (r) { return r.active && keyOf_(r.id) === keyOf_(rest); })) {
    throw new Error('المطعم "' + rest + '" غير موجود.');
  }
  var pass = String(u.password || '').slice(0, 200);
  if (pass && pass.length < 6) throw new Error('كلمة السر لازم تكون 6 حروف/أرقام على الأقل.');
  var active = u.active !== false;

  var res = withLock_(function () {
    var sh = getUsersSheet_(true), users = readUsers_(), existing = null;
    users.forEach(function (x) { if (keyOf_(x.username) === keyOf_(username)) existing = x; });
    if (!existing && !pass) throw new Error('اكتب كلمة سر لليوزر الجديد (6 حروف/أرقام على الأقل).');

    var activeMgmt = users.filter(function (x) {
      return !(existing && x.row === existing.row) && x.role === ROLE_MGMT && x.active;
    }).length + ((role === ROLE_MGMT && active) ? 1 : 0);
    if (activeMgmt < 1) throw new Error('لازم يفضل مدير (management) نشط واحد على الأقل.');
    var activeAdmins = users.filter(function (x) {
      return !(existing && x.row === existing.row) && x.isAdmin && x.active;
    }).length + ((isAdmin && active) ? 1 : 0);
    if (activeAdmins < 1) throw new Error('لازم يفضل مدير نظام (Admin) نشط واحد على الأقل.');

    var salt = pass ? Utilities.getUuid() : existing.salt;
    var hash = pass ? hashPass_(salt, pass) : existing.hash;
    var name = existing ? existing.username : username;
    if (existing) {
      sh.getRange(existing.row, 1, 1, 6).setValues([[name, role, branch, salt, hash, active]]);
      sh.getRange(existing.row, 8).setValue(sheetSafe_(rest));
      sh.getRange(existing.row, 9).setValue(isAdmin);
    } else {
      sh.appendRow([name, role, branch, salt, hash, active, Utilities.formatDate(new Date(), CONFIG.TZ, 'yyyy-MM-dd h:mm:ss a'), sheetSafe_(rest), isAdmin]);
    }
    var changedAuthorization = !!(existing &&
      (existing.role !== role || existing.branch !== branch ||
       keyOf_(existing.restaurant) !== keyOf_(rest) || existing.isAdmin !== isAdmin));
    return {
      name: name, created: !existing, changedPass: !!pass, active: active,
      changedAuthorization: changedAuthorization
    };
  });

  // تغييرات كلمة السر أو الحالة أو الدور أو صلاحية المدير تلغي الجلسات القديمة.
  if (res.changedPass || !res.active || res.changedAuthorization) bumpUserVer_(res.name);
  usersCacheClear_();
  audit_(me, res.created ? 'USER_CREATE' : 'USER_UPDATE', res.name,
    { role: role, isAdmin: isAdmin, branch: branch, restaurant: rest, active: res.active, passwordChanged: res.changedPass }, 'OK');
  return listUsersPublic_();
}

/** حذف يوزر — بيتطلب كلمة سر المدير + تأكيد الاسم + بيتسجل في الـ Audit */
function deleteUser(token, username, password) {
  var me = requireAdmin_(reAuth_(token, password));                                  // أدمن + باسورد صحيح
  username = cleanText_(username, 30);
  if (!username) throw new Error('اختار اليوزر.');
  if (keyOf_(username) === keyOf_(me.username)) throw new Error('مينفعش تحذف نفسك.');
  rateLimit_('deluser:' + me.username, CONFIG.RATE_DELETE, 3600);

  var list = withLock_(function () {
    var users = readUsers_(), target = null;
    users.forEach(function (x) { if (keyOf_(x.username) === keyOf_(username)) target = x; });
    if (!target) throw new Error('اليوزر مش موجود.');
    var others = users.filter(function (x) { return x.row !== target.row && x.role === ROLE_MGMT && x.active; }).length;
    if (target.role === ROLE_MGMT && others < 1) throw new Error('لازم يفضل مدير نشط واحد على الأقل.');
    var otherAdmins = users.filter(function (x) { return x.row !== target.row && x.isAdmin && x.active; }).length;
    if (target.isAdmin && otherAdmins < 1) throw new Error('لازم يفضل مدير نظام (Admin) نشط واحد على الأقل.');
    getUsersSheet_(false).deleteRow(target.row);
    return target;
  });

  bumpUserVer_(list.username);                                        // إلغاء جلسات اليوزر المحذوف فورًا
  usersCacheClear_();
  audit_(me, 'USER_DELETE', list.username, { role: list.role, branch: list.branch }, 'OK');
  return listUsersPublic_();
}

/** بيعمل يوزر دسباتشر لكل فرع ملوش يوزر، بباسورد عشوائي بيظهر مرة واحدة بس (متخزن مشفّر) */
function createBranchUsers(token) {
  var me = requireAdmin_(auth_(token, [ROLE_MGMT]));
  var res = withLock_(function () {
    var sh = getUsersSheet_(true), users = readUsers_(), created = [], taken = {}, has = {};
    users.forEach(function (u) {
      taken[keyOf_(u.username)] = 1;
      if (u.role === ROLE_BRANCH) {
        try { has[keyOf_(userContext_(u).branch)] = 1; }
        catch (e) { has[keyOf_(u.branch)] = 1; }
      }
    });
    scopedBranchRecs_(me).forEach(function (b) {
      var bn = b.name;
      if (has[keyOf_(bn)]) return;
      var base = bn.toLowerCase().replace(/[^a-z0-9]/g, '') || 'branch', uname = base, k = 1;
      while (taken[uname]) { k++; uname = base + k; }
      taken[uname] = 1;
      var pass = randomPass_(10), salt = Utilities.getUuid();
      sh.appendRow([sheetSafe_(uname), ROLE_BRANCH, sheetSafe_(b.key), salt, hashPass_(salt, pass), true,
        Utilities.formatDate(new Date(), CONFIG.TZ, 'yyyy-MM-dd h:mm:ss a'), sheetSafe_(b.restaurant), false]);
      created.push({ username: uname, password: pass, branch: bn });
    });
    usersCacheClear_();
    return { created: created, users: listUsersPublic_() };
  });
  audit_(me, 'USER_BULK_CREATE', '', { created: res.created.map(function (c) { return c.username; }) }, 'OK');
  return res;
}

/**
 * عمليات الصيانة (تهيئة/فحص) متاحة من محرر Apps Script فقط.
 * ملاحظة: أي دالة top-level في Apps Script بتكون قابلة للنداء من المتصفح،
 * عشان كده بنرفضها إلا لو المستخدم الفعّال = مالك السكربت (تشغيل من المحرر)،
 * أو لو ALLOW_MAINTENANCE=true في Script Properties (للفتح المؤقت).
 */
function isEditorRun_() {
  try {
    var a = Session.getActiveUser(), e = Session.getEffectiveUser();
    var ae = (a && a.getEmail) ? String(a.getEmail()) : '';
    var ee = (e && e.getEmail) ? String(e.getEmail()) : '';
    return !!ae && !!ee && ae.toLowerCase() === ee.toLowerCase();
  } catch (err) { return false; }
}
function editorOnly_() {
  if (isEditorRun_()) return;
  var open = '';
  try { open = String(PropertiesService.getScriptProperties().getProperty('ALLOW_MAINTENANCE') || '').toLowerCase(); } catch (err) {}
  if (open === 'true') return;
  throw new Error('العملية دي متاحة من محرر Apps Script فقط.');
}

/**
 * تجهيز أول مدير — بتشغّلها مرة واحدة من المحرر (Run ▸ setupUsers).
 * بترفض تشتغل لو فيه مدير نشط بالفعل، وبترفض لو الباسورد فاضي.
 */
function setupUsers() {
  editorOnly_();
  ensureTenancy_();
  var sh = getUsersSheet_(true), have = {}, made = [], creds = [];
  readUsers_().forEach(function (u) { have[keyOf_(u.username)] = 1; });
  var props = PropertiesService.getScriptProperties();
  var stamp = Utilities.formatDate(new Date(), CONFIG.TZ, 'yyyy-MM-dd h:mm:ss a');
  SEED_USERS.forEach(function (u) {
    if (have[keyOf_(u.username)]) return;
    // الباسورد من Script Properties (SEED_PASS_<user>) — مفيش أي باسورد في الكود
    var fromProps = String(props.getProperty('SEED_PASS_' + u.username) || '').trim();
    var generated = !fromProps;
    var pass = fromProps || randomPass_(12);
    if (pass.length < 6) throw new Error('باسورد "' + u.username + '" لازم يكون 6 حروف/أرقام على الأقل.');
    var salt = Utilities.getUuid();
    var branch = u.branch || '', restaurant = '';
    if (u.role === ROLE_AGENT && !branch) {
      var defaultBranches = branchRecords_().filter(function (b) {
        return keyOf_(b.restaurant) === keyOf_(CONFIG.REST_DEFAULT);
      });
      branch = defaultBranches.length ? defaultBranches[0].key : '';
    }
    if (branch) {
      var rec = branchRec_(branch, null);
      if (!rec) throw new Error('لا يمكن إنشاء "' + u.username + '" قبل تسجيل الفرع "' + branch + '" في BRANCHES.');
      branch = rec.key;
      restaurant = rec.restaurant;
    }
    sh.appendRow([
      sheetSafe_(u.username), u.role, sheetSafe_(branch), salt, hashPass_(salt, pass), true, stamp,
      sheetSafe_(restaurant), keyOf_(u.username) === keyOf_(CONFIG.ADMIN_USER)
    ]);
    made.push(u.username);
    creds.push(u.username + ' / ' + pass + (generated ? '  (مولّد — غيّره بعد الدخول)' : ''));
  });
  usersCacheClear_();
  protectSystemSheets_();
  audit_({ username: 'system', role: 'system' }, 'SETUP_USERS', '', { created: made }, 'OK');
  var msg = made.length
    ? 'تم إنشاء: ' + made.join(', ') + '\n' + creds.join('\n') + '\n⚠ انسخ الباسوردات دلوقتي — مش هتظهر تاني.'
    : 'كل اليوزرات موجودة بالفعل — مفيش حاجة اتغيرت.';
  Logger.log(msg + '\nالشيت: ' + SpreadsheetApp.getActiveSpreadsheet().getName());
  return msg;
}

/** فحص سريع لإعدادات الأمان والبنية (من محرر Apps Script) — مفيش أي أسرار بتتطبع */
function securityCheck() {
  editorOnly_();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var branches = getBranchSheets_();
  var out = [];
  out.push('Backend: Google Sheets only (Apps Script)');
  out.push('External database connections: none');
  out.push('Spreadsheet: ' + ss.getName());
  out.push('Branch sheets: ' + branches.length + ' [' + branches.map(function (sh) { return sh.getName(); }).join(', ') + ']');
  out.push('DATA sheet: ' + !!ss.getSheetByName(CONFIG.DATA_SHEET));
  out.push('Audit sheet: ' + !!ss.getSheetByName(CONFIG.AUDIT_SHEET));
  out.push('Archive sheet: ' + !!ss.getSheetByName(CONFIG.ARCHIVE_SHEET));
  var users = readUsers_();
  out.push('Users: ' + users.length + ' | active managers: ' + users.filter(function (u) { return u.role === ROLE_MGMT && u.active; }).length);
  out.push('Seed with plaintext passwords: no');
  Logger.log(out.join('\n'));
  return out.join('\n');
}

/** تجهيز الحماية/الشيتات النظامية — شغّلها مرة من المحرر بعد النشر */
function setupSecurity() {
  editorOnly_();
  protectSystemSheets_();
  getAuditSheet_(true);
  getArchiveSheet_(true);
  audit_({ username: 'system', role: 'system' }, 'SETUP_SECURITY', '', 'protect+audit+archive', 'OK');
  var msg = 'تم تجهيز: حماية شيتات النظام + AUDIT_LOG + DELETED_ARCHIVE.';
  Logger.log(msg);
  return msg;
}

/** فحص حالة البنية والتخزين — Google Sheets فقط (للمحرر فقط) */
function testStatus() {
  editorOnly_();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var branches = getBranchSheets_();
  var now = nowParts_();
  var res = {
    backend: 'Google Sheets',
    externalDb: false,
    spreadsheet: ss.getName(),
    timeZone: ss.getSpreadsheetTimeZone(),
    dataSheet: !!ss.getSheetByName(CONFIG.DATA_SHEET),
    branchSheets: branches.map(function (sh) { return sh.getName(); }),
    users: readUsers_().length,
    generatedAt: now.key + ' ' + now.hms
  };
  Logger.log(JSON.stringify(res, null, 2));
  return res;
}
function testDbConnection() {
  // الاسم متسيّب للتوافق مع أي استدعاء قديم — مفيش قاعدة بيانات خارجية.
  return testStatus();
}
/** إعادة بناء الكاش من الشيتات (مزامنة أولية / بعد تعديل يدوي في الشيت) */
function runInitialSync() {
  editorOnly_();
  cacheClear_();
  var data = withLock_(function () { return freshPayload_(); });
  var res = {
    ok: true,
    backend: 'Google Sheets',
    branches: data.branches.length,
    rows: data.branches.reduce(function (n, b) { return n + b.rows.length; }, 0),
    items: data.items.length,
    reasons: data.reasons.length,
    generatedAt: data.generatedAt
  };
  Logger.log(JSON.stringify(res, null, 2));
  return res;
}

/* ============================================================
 *  بوابة الـ API الموحّدة (Secure API Gateway)
 *  - قايمة عمليات مسموحة فقط (Allow-list) — مفيش استدعاء عشوائي
 *  - تحقق صارم من الجلسة والدور قبل أي تنفيذ
 *  - حد أقصى لحجم المدخلات + Rate Limit لكل مستخدم
 *  - أي خطأ تقني بيتحوّل لرسالة عامة آمنة
 * ============================================================ */
function sanitizeArg_(v, depth) {
  if (depth > 3) return '';
  if (v === null || v === undefined) return v;
  var t = typeof v;
  if (t === 'string') return v.length > 600 ? v.slice(0, 600) : v;
  if (t === 'number' || t === 'boolean') return v;
  if (Array.isArray(v)) return v.slice(0, 50).map(function (x) { return sanitizeArg_(x, depth + 1); });
  if (t === 'object') {
    var o = {};
    Object.keys(v).slice(0, 40).forEach(function (k) {
      if (/^[A-Za-z0-9_\-]{1,40}$/.test(k)) o[k] = sanitizeArg_(v[k], depth + 1);
    });
    return o;
  }
  return '';
}

var API_SPEC = {
  getDashboardData: { fn: getDashboardData, roles: null, write: false, max: 2 },
  pollState: { fn: pollState, roles: null, write: false, max: 2, poll: true },
  refreshLists: { fn: refreshLists, roles: [ROLE_MGMT], write: true, max: 1 },

  addItem: { fn: addItem, roles: [ROLE_MGMT], write: true, max: 3 },
  addReason: { fn: addReason, roles: [ROLE_MGMT], write: true, max: 3 },
  deleteItem: { fn: deleteItem, roles: [ROLE_MGMT], write: true, max: 3 },
  deleteReason: { fn: deleteReason, roles: [ROLE_MGMT], write: true, max: 3 },
  saveReason: { fn: saveReason, roles: [ROLE_MGMT], write: true, max: 1 },
  clearAllData: { fn: clearAllData, roles: [ROLE_MGMT], write: true, max: 1 },

  logStop: { fn: logStop, roles: [ROLE_MGMT, ROLE_BRANCH], write: true, max: 7 },
  getStopOptions: { fn: getStopOptions, roles: [ROLE_MGMT, ROLE_BRANCH], write: false, max: 1 },
  resumeStop: { fn: resumeStop, roles: [ROLE_MGMT, ROLE_BRANCH], write: true, max: 3 },

  saveBranchTimes: { fn: saveBranchTimes, roles: [ROLE_MGMT, ROLE_BRANCH], write: true, max: 4 },
  saveBranchHours: { fn: saveBranchHours, roles: [ROLE_MGMT], write: true, max: 4 },
  createBranch: { fn: createBranch, roles: [ROLE_MGMT], write: true, max: 1 },
  branchDeleteInfo: { fn: branchDeleteInfo, roles: [ROLE_MGMT], write: false, max: 2 },
  deleteBranch: { fn: deleteBranch, roles: [ROLE_MGMT], write: true, max: 1 },
  getAuditLog: { fn: getAuditLog, roles: [ROLE_MGMT], write: false, max: 1 },
  getErrorLog: { fn: getErrorLog, roles: [ROLE_MGMT], write: false, max: 1 },

  listNotifications: { fn: listNotifications, roles: null, write: false, max: 1 },
  markNotificationsRead: { fn: markNotificationsRead, roles: null, write: false, max: 1 },

  listRestaurants: { fn: listRestaurants, roles: [ROLE_MGMT], write: false, max: 0 },
  saveRestaurant: { fn: saveRestaurant, roles: [ROLE_MGMT], write: true, max: 1 },
  deleteRestaurant: { fn: deleteRestaurant, roles: [ROLE_MGMT], write: true, max: 1 },

  listMenu: { fn: listMenu, roles: [ROLE_MGMT], write: false, max: 2 },
  saveMenuItem: { fn: saveMenuItem, roles: [ROLE_MGMT], write: true, max: 1 },
  deleteMenuItem: { fn: deleteMenuItem, roles: [ROLE_MGMT], write: true, max: 3 },
  setItemAvailability: { fn: setItemAvailability, roles: [ROLE_MGMT], write: true, max: 5 },
  listReasons: { fn: listReasons, roles: [ROLE_MGMT], write: false, max: 2 },

  getBranchDailyHours: { fn: getBranchDailyHours, roles: [ROLE_MGMT], write: false, max: 0 },
  saveBranchDailyHours: { fn: saveBranchDailyHours, roles: [ROLE_MGMT], write: true, max: 2 },
  runShiftRollover: { fn: runShiftRollover, roles: [ROLE_MGMT, ROLE_BRANCH], write: true, max: 3 },
  getShiftLog: { fn: getShiftLog, roles: [ROLE_MGMT, ROLE_BRANCH], write: false, max: 3 },

  listUsers: { fn: listUsers, roles: [ROLE_MGMT], write: false, max: 0 },
  saveUser: { fn: saveUser, roles: [ROLE_MGMT], write: true, max: 1 },
  deleteUser: { fn: deleteUser, roles: [ROLE_MGMT], write: true, max: 2 },
  createBranchUsers: { fn: createBranchUsers, roles: [ROLE_MGMT], write: true, max: 0 }
};

/**
 * نقطة الدخول الوحيدة لأي طلب من الواجهة.
 * apiCall(token, 'deleteBranch', [{...}])
 */
function apiCall(token, action, args) {
  action = String(action || '').replace(/[^A-Za-z0-9_]/g, '');
  var spec = API_SPEC[action];
  if (!spec) throw new Error('UNKNOWN_ACTION');
  if (!Array.isArray(args)) args = [];
  if (args.length > spec.max) throw new Error('UNKNOWN_ACTION');

  var user = auth_(token, spec.roles);                       // جلسة + دور قبل أي حاجة
  var limit = spec.poll ? (CONFIG.RATE_POLL || 3600) : (spec.write ? CONFIG.RATE_WRITE : CONFIG.RATE_READ);
  rateLimit_((spec.write ? 'w:' : 'r:') + action + ':' + user.username, limit, 3600);

  var clean = args.map(function (v) { return sanitizeArg_(v, 0); });
  // حد أقصى لحجم الطلب (منع الإساءة)
  try { if (JSON.stringify(clean).length > 40000) throw new Error('PAYLOAD_TOO_LARGE'); } catch (e) {
    if (e && e.message === 'PAYLOAD_TOO_LARGE') throw new Error(publicMsg_(e.message));
  }

  try {
    var result = spec.fn.apply(null, [token].concat(clean));
    /* أي عملية كتابة بتغيّر إصدار البث اللحظي → كل الأجهزة تشوف التحديث في الاستطلاع */
    if (spec.write) { try { bumpLive_(); } catch (_) {} }
    return result;
  } catch (e) {
    if (e && (e.message === 'SESSION_EXPIRED' || e.message === 'RATE_LIMIT')) throw e;
    throw publicErr_(e, action, user);
  }
}

/* ============================================================
 *  v14 — عزل إعدادات الفروع (المنيو / الأسباب / المواعيد / الإشعارات)
 * ============================================================ */

var ERR_MARK = '__ERRV2__';

var REST_HEADERS = ['RestaurantID', 'Name', 'Active', 'CreatedBy', 'CreatedAt'];
var BRANCH_HEADERS = ['BranchKey', 'Name', 'RestaurantID', 'SheetName', 'Active', 'CreatedBy', 'CreatedAt'];
var MENU_HEADERS = ['RestaurantID', 'Branch', 'Item', 'Category', 'Price', 'Available', 'UpdatedBy', 'UpdatedAt', 'Active'];
var REASON_HEADERS = ['RestaurantID', 'Branch', 'Reason', 'UpdatedBy', 'UpdatedAt', 'Enabled'];
var DAILY_HEADERS = ['RestaurantID', 'Branch', 'Weekday', 'Closed', 'OpenTime', 'CloseTime', 'UpdatedBy', 'UpdatedAt'];
var NOTIF_HEADERS = ['ID', 'CreatedAt', 'RestaurantID', 'Branch', 'Roles', 'TargetUser', 'Kind', 'Severity', 'Title', 'Body', 'Ref'];
var NOTIF_READ_HEADERS = ['NotificationID', 'Username', 'ReadAt'];
var SHIFT_HEADERS = ['ID', 'CreatedAt', 'RestaurantID', 'Branch', 'ShiftDay', 'OpenTime', 'CloseTime', 'Stops', 'ClosedItems', 'Actor', 'Note'];
var ERROR_HEADERS = ['At', 'Action', 'Actor', 'Role', 'Code', 'Message', 'Detail', 'Stack'];

function nowIso_() {
  try { return Utilities.formatDate(new Date(), CONFIG.TZ, 'yyyy-MM-dd HH:mm:ss'); } catch (e) { return String(new Date()); }
}

function isSystemSheet_(name) {
  var n = keyOf_(name);
  return [CONFIG.DATA_SHEET, CONFIG.USERS_SHEET, CONFIG.TIMES_SHEET, CONFIG.HOURS_SHEET,
    CONFIG.AUDIT_SHEET, CONFIG.ARCHIVE_SHEET, CONFIG.RESTAURANTS_SHEET, CONFIG.BRANCHES_SHEET,
    CONFIG.MENU_SHEET, CONFIG.REASONS_SHEET, CONFIG.DAILY_SHEET, CONFIG.NOTIF_SHEET,
    CONFIG.NOTIF_READ_SHEET, CONFIG.SHIFT_SHEET, CONFIG.ERROR_SHEET].some(function (x) { return keyOf_(x) === n; });
}

function tblSheet_(name, headers, create) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(name);
  if (!sh && create) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
    sh.getRange(1, 1, 1, headers.length).setFontWeight('bold');
    sh.setFrozenRows(1);
    try { sh.hideSheet(); } catch (e) {}
    protectSheet_(sh, name + ' — نظام');
  }
  return sh;
}

function readTable_(name, cols) {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sh) return [];
  var n = sh.getLastRow();
  if (n < 2) return [];
  return sh.getRange(2, 1, n - 1, cols).getValues();
}

function appendRow_(name, headers, row) {
  var sh = tblSheet_(name, headers, true);
  sh.appendRow(row);
  return sh;
}

function trimRows_(name, max) {
  try {
    var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
    if (!sh) return;
    var n = sh.getLastRow() - 1;
    if (n > max) sh.deleteRows(2, n - max);
  } catch (e) {}
}

function removeRestaurantRows_(name, restaurant) {
  try {
    var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
    if (!sh) return 0;
    var rows = readTable_(name, 1), removed = 0;
    for (var i = rows.length - 1; i >= 0; i--) {
      if (keyOf_(rows[i][0]) === keyOf_(restaurant)) { sh.deleteRow(i + 2); removed++; }
    }
    return removed;
  } catch (e) { return 0; }
}

function ensureReasonBranchColumn_() {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.REASONS_SHEET);
  if (!sh) return;
  var width = Math.max(sh.getLastColumn(), 1);
  var headers = sh.getRange(1, 1, 1, width).getDisplayValues()[0];
  if (keyOf_(headers[1]) !== 'branch') {
    sh.insertColumnAfter(1);
    width++;
    headers = sh.getRange(1, 1, 1, width).getDisplayValues()[0];
  }
  if (keyOf_(headers[5]) !== 'enabled') sh.insertColumnAfter(Math.max(width, 5));
  sh.getRange(1, 1, 1, REASON_HEADERS.length).setValues([REASON_HEADERS]);
}

function ensureMenuActiveColumn_() {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.MENU_SHEET);
  if (!sh) return;
  sh.getRange(1, 1, 1, MENU_HEADERS.length).setValues([MENU_HEADERS]);
}

function bumpLive_() {
  try { CacheService.getScriptCache().put('live_rev', String(Date.now()), 21600); } catch (e) {}
}

function liveRev_() {
  try { return String(CacheService.getScriptCache().get('live_rev') || '0'); } catch (e) { return '0'; }
}

function bumpShift_(branchKey) {
  try { CacheService.getScriptCache().put('shiftv_' + hashKey_(keyOf_(branchKey)), String(Date.now()), 21600); } catch (e) {}
}

function shiftVersion_(branchKey) {
  try { return String(CacheService.getScriptCache().get('shiftv_' + hashKey_(keyOf_(branchKey))) || '0'); } catch (e) { return '0'; }
}

/* ---------------- المطاعم ---------------- */

var REST_CACHE_ = { at: 0, list: null };

function readRestaurants_(force) {
  var now = Date.now();
  if (!force && REST_CACHE_.list && now - REST_CACHE_.at < 30000) return REST_CACHE_.list;
  var out = [];
  readTable_(CONFIG.RESTAURANTS_SHEET, 5).forEach(function (r) {
    var id = normName_(r[0]);
    if (!id) return;
    out.push({
      id: id, name: normName_(r[1]) || id,
      active: String(r[2]).toUpperCase() !== 'FALSE',
      createdBy: normName_(r[3]), createdAt: normName_(r[4])
    });
  });
  REST_CACHE_ = { at: now, list: out };
  return out;
}

function ensureTenancy_() {
  var cache = CacheService.getScriptCache();
  if (cache.get('tenancy_v14') === '1') return;
  try {
    tblSheet_(CONFIG.RESTAURANTS_SHEET, REST_HEADERS, true);
    tblSheet_(CONFIG.BRANCHES_SHEET, BRANCH_HEADERS, true);
    tblSheet_(CONFIG.MENU_SHEET, MENU_HEADERS, true);
    tblSheet_(CONFIG.REASONS_SHEET, REASON_HEADERS, true);
    tblSheet_(CONFIG.DAILY_SHEET, DAILY_HEADERS, true);
    tblSheet_(CONFIG.NOTIF_SHEET, NOTIF_HEADERS, true);
    tblSheet_(CONFIG.NOTIF_READ_SHEET, NOTIF_READ_HEADERS, true);
    tblSheet_(CONFIG.SHIFT_SHEET, SHIFT_HEADERS, true);
    tblSheet_(CONFIG.ERROR_SHEET, ERROR_HEADERS, true);
    ensureMenuActiveColumn_();
    ensureReasonBranchColumn_();

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var rsh = ss.getSheetByName(CONFIG.RESTAURANTS_SHEET);
    if (rsh.getLastRow() < 2) {
      rsh.appendRow([CONFIG.REST_DEFAULT, 'المطعم الرئيسي', true, 'system', nowIso_()]);
    }

    var known = {};
    readTable_(CONFIG.BRANCHES_SHEET, 7).forEach(function (r) { known[keyOf_(r[0])] = 1; known[keyOf_(r[3])] = 1; });
    var bsh = ss.getSheetByName(CONFIG.BRANCHES_SHEET);
    legacyBranchSheets_().forEach(function (sh) {
      var nm = sh.getName();
      if (known[keyOf_(nm)]) return;
      bsh.appendRow([sheetSafe_(nm), sheetSafe_(nm), CONFIG.REST_DEFAULT, sheetSafe_(nm), true, 'system', nowIso_()]);
      known[keyOf_(nm)] = 1;
    });

    migrateLegacyLists_();
    cacheClear_();
    cache.put('tenancy_v14', '1', 900);
  } catch (e) {
    try { Logger.log('ensureTenancy_ failed: ' + e); } catch (_) {}
  }
}

/** ترحيل DATA القديم إلى منيو/أسباب المطعم الافتراضي (مرة واحدة) */
function migrateLegacyLists_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var dataSh = ss.getSheetByName(CONFIG.DATA_SHEET);
  if (!dataSh) return;

  var haveItem = {};
  readTable_(CONFIG.MENU_SHEET, 9).forEach(function (r) {
    if (keyOf_(r[0]) === keyOf_(CONFIG.REST_DEFAULT) && !normName_(r[1])) haveItem[keyOf_(r[2])] = 1;
  });
  var msh = ss.getSheetByName(CONFIG.MENU_SHEET);
  readList_(dataSh, CONFIG.ITEM_COL).forEach(function (it) {
    if (haveItem[keyOf_(it)]) return;
    msh.appendRow([CONFIG.REST_DEFAULT, '', sheetSafe_(it), '', '', true, 'system', nowIso_()]);
    haveItem[keyOf_(it)] = 1;
  });

  var haveReason = {};
  readTable_(CONFIG.REASONS_SHEET, 6).forEach(function (r) {
    if (keyOf_(r[0]) === keyOf_(CONFIG.REST_DEFAULT) && String(r[5]).toUpperCase() !== 'FALSE') {
      haveReason[keyOf_(r[2])] = 1;
    }
  });
  var rsh = ss.getSheetByName(CONFIG.REASONS_SHEET);
  readList_(dataSh, CONFIG.REASON_COL).forEach(function (rs) {
    if (keyOf_(rs) === keyOf_(UNSPEC) || haveReason[keyOf_(rs)]) return;
    rsh.appendRow([CONFIG.REST_DEFAULT, '', sheetSafe_(rs), 'system', nowIso_(), true]);
    haveReason[keyOf_(rs)] = 1;
  });
}

function listRestaurants(token) {
  var user = auth_(token, [ROLE_MGMT]);
  ensureTenancy_();
  var list = readRestaurants_(true).filter(function (r) {
    return isGlobalUser_(user) || keyOf_(r.id) === keyOf_(user.restaurant);
  });
  var branches = branchRecords_().filter(function (b) {
    return isGlobalUser_(user) || keyOf_(b.restaurant) === keyOf_(user.restaurant);
  }).map(function (b) { return { key: b.key, name: b.name, restaurant: b.restaurant }; });
  return { ok: true, restaurants: list, branches: branches, defaultRest: CONFIG.REST_DEFAULT };
}

function saveRestaurant(token, info) {
  var user = requireAdmin_(auth_(token, [ROLE_MGMT]));
  info = info || {};
  var name = cleanText_(info.name, 80);
  if (name.length < 2) throw new Error('اسم المطعم لازم يكون حرفين على الأقل.');
  var id = cleanText_(info.id, 40);
  if (!id) id = 'R' + String(Date.now()).slice(-8);
  if (!/^[A-Za-z0-9_\-]{2,40}$/.test(id)) throw new Error('كود المطعم حروف إنجليزي/أرقام وشرطة (2-40).');
  var active = info.active !== false;

  withLock_(function () {
    var sh = tblSheet_(CONFIG.RESTAURANTS_SHEET, REST_HEADERS, true);
    var rows = readTable_(CONFIG.RESTAURANTS_SHEET, 5), row = 0;
    rows.forEach(function (r, i) { if (keyOf_(r[0]) === keyOf_(id)) row = i + 2; });
    if (row) {
      sh.getRange(row, 1, 1, 3).setValues([[sheetSafe_(id), sheetSafe_(name), active]]);
    } else {
      var dup = false;
      rows.forEach(function (r) { if (keyOf_(r[1]) === keyOf_(name)) dup = true; });
      if (dup) throw new Error('في مطعم بنفس الاسم "' + name + '" بالفعل.');
      sh.appendRow([sheetSafe_(id), sheetSafe_(name), active, sheetSafe_(user.username), nowIso_()]);
    }
  });

  REST_CACHE_ = { at: 0, list: null };
  cacheClear_();
  bumpLive_();
  audit_(user, 'RESTAURANT_SAVE', id, { name: name, active: active }, 'OK');
  return listRestaurants(token);
}

function deleteRestaurant(token, info) {
  info = info || {};
  var user = requireAdmin_(reAuth_(token, info.password));
  var id = cleanText_(info.id, 40);
  if (!id) throw new Error('اختار المطعم.');
  if (keyOf_(cleanText_(info.confirm, 60)) !== keyOf_(id)) throw new Error('اكتب كود المطعم بالظبط للتأكيد.');
  if (keyOf_(id) === keyOf_(CONFIG.REST_DEFAULT)) throw new Error('مينفعش تحذف المطعم الافتراضي.');
  var used = branchRecords_().filter(function (b) { return keyOf_(b.restaurant) === keyOf_(id); }).length;
  if (used) throw new Error('المطعم فيه ' + used + ' فرع — احذف الفروع الأول.');

  withLock_(function () {
    var sh = tblSheet_(CONFIG.RESTAURANTS_SHEET, REST_HEADERS, true);
    var rows = readTable_(CONFIG.RESTAURANTS_SHEET, 5);
    for (var i = rows.length - 1; i >= 0; i--) if (keyOf_(rows[i][0]) === keyOf_(id)) sh.deleteRow(i + 2);
    removeRestaurantRows_(CONFIG.MENU_SHEET, id);
    removeRestaurantRows_(CONFIG.REASONS_SHEET, id);
    removeRestaurantRows_(CONFIG.DAILY_SHEET, id);
  });

  REST_CACHE_ = { at: 0, list: null };
  MENU_CACHE_ = { at: 0, rows: null };
  cacheClear_();
  bumpLive_();
  audit_(user, 'RESTAURANT_DELETE', id, {}, 'OK');
  return listRestaurants(token);
}

/* ---------------- سجل الفروع (BRANCHES) ---------------- */

function branchRecords_() {
  ensureTenancy_();
  var ss = SpreadsheetApp.getActiveSpreadsheet(), out = [], seen = {};
  readTable_(CONFIG.BRANCHES_SHEET, 7).forEach(function (r) {
    var key = normName_(r[0]);
    if (!key) return;
    if (String(r[4]).toUpperCase() === 'FALSE') return;
    var sheetName = normName_(r[3]) || key;
    var sh = ss.getSheetByName(sheetName);
    if (!sh || seen[keyOf_(sh.getName())]) return;
    if (sh.getLastRow() < CONFIG.HEADER_ROW) return;
    seen[keyOf_(sh.getName())] = 1;
    out.push({
      key: key, name: normName_(r[1]) || key,
      restaurant: normName_(r[2]) || CONFIG.REST_DEFAULT,
      sheet: sh, sheetName: sh.getName()
    });
  });
  if (!out.length) {
    legacyBranchSheets_().forEach(function (sh) {
      if (seen[keyOf_(sh.getName())]) return;
      seen[keyOf_(sh.getName())] = 1;
      out.push({ key: sh.getName(), name: sh.getName(), restaurant: CONFIG.REST_DEFAULT, sheet: sh, sheetName: sh.getName() });
    });
  }
  return out;
}

function branchRec_(name, restaurant) {
  var list = branchRecords_(), k = keyOf_(name), hits = [], exact = [];
  list.forEach(function (b) {
    if (keyOf_(b.key) !== k && keyOf_(b.name) !== k && keyOf_(b.sheetName) !== k) return;
    if (restaurant && keyOf_(b.restaurant) !== keyOf_(restaurant)) return;
    hits.push(b);
    if (keyOf_(b.key) === k || keyOf_(b.sheetName) === k) exact.push(b);
  });
  if (exact.length === 1) return exact[0];
  if (exact.length > 1 || hits.length > 1) return null;
  return hits.length ? hits[0] : null;
}

function branchSheetName_(restaurant, name) {
  if (keyOf_(restaurant) === keyOf_(CONFIG.REST_DEFAULT)) return name;
  var prefix = normName_(restaurant).replace(/[\[\]\*\?\/\\:]/g, '').slice(0, 20);
  return (prefix + ' - ' + name).replace(/[\[\]\*\?\/\\:]/g, ' ').slice(0, 100);
}

function registerBranch_(restaurant, name, sheetName, user) {
  appendRow_(CONFIG.BRANCHES_SHEET, BRANCH_HEADERS, [
    sheetSafe_(sheetName), sheetSafe_(name), sheetSafe_(restaurant), sheetSafe_(sheetName), true,
    sheetSafe_((user && user.username) || 'system'), nowIso_()
  ]);
}

function unregisterBranch_(sheetName) {
  var sh = tblSheet_(CONFIG.BRANCHES_SHEET, BRANCH_HEADERS, true);
  var rows = readTable_(CONFIG.BRANCHES_SHEET, 7);
  for (var i = rows.length - 1; i >= 0; i--) {
    if (keyOf_(rows[i][0]) === keyOf_(sheetName) || keyOf_(rows[i][3]) === keyOf_(sheetName)) sh.deleteRow(i + 2);
  }
}

/* ---------------- المنيو والأسباب ---------------- */

var MENU_CACHE_ = { at: 0, rows: null };

function readMenuRaw_(force) {
  var now = Date.now();
  if (!force && MENU_CACHE_.rows && now - MENU_CACHE_.at < 15000) return MENU_CACHE_.rows;
  var out = [];
  readTable_(CONFIG.MENU_SHEET, 9).forEach(function (r) {
    var rest = normName_(r[0]);
    if (!rest) return;
    var item = normName_(r[2]);
    if (!item) return;
    out.push({
      rest: rest, branch: normName_(r[1]), item: item, cat: normName_(r[3]),
      price: numFrom_(r[4]), avail: String(r[5]).toUpperCase() !== 'FALSE',
      active: String(r[8]).toUpperCase() !== 'FALSE',
      by: normName_(r[6]), at: normName_(r[7])
    });
  });
  MENU_CACHE_ = { at: now, rows: out };
  return out;
}

function menuItemNames_(rest) {
  var out = [], seen = {};
  readMenuRaw_().forEach(function (r) {
    if (keyOf_(r.rest) !== keyOf_(rest)) return;
    if (r.branch || !r.active) return;
    if (seen[keyOf_(r.item)]) return;
    seen[keyOf_(r.item)] = 1;
    out.push({ it: r.item, cat: r.cat, price: r.price, av: r.avail ? 1 : 0 });
  });
  return out;
}

function menuForBranch_(rest, branchKey) {
  var rows = readMenuRaw_();
  var order = [], byKey = {}, branch = keyOf_(branchKey), restKey = keyOf_(rest);

  // 1) منيو البراند المشترك (Branch فاضي)
  rows.forEach(function (r) {
    if (keyOf_(r.rest) !== restKey || r.branch || !r.active) return;
    var k = keyOf_(r.item);
    if (byKey[k]) return;
    byKey[k] = { it: r.item, cat: r.cat, price: r.price, av: r.avail ? 1 : 0, removed: false };
    order.push(k);
  });

  // 2) تخصيص الفرع: override أو حذف للصنف المشترك
  rows.forEach(function (r) {
    if (keyOf_(r.rest) !== restKey || keyOf_(r.branch) !== branch) return;
    var k = keyOf_(r.item), cur = byKey[k];
    if (!r.active) {
      if (cur) cur.removed = true;
      return;
    }
    if (cur) {
      cur.av = r.avail ? 1 : 0;
      if (r.price !== null) cur.price = r.price;
      if (r.cat) cur.cat = r.cat;
      cur.removed = false;
    } else {
      byKey[k] = { it: r.item, cat: r.cat, price: r.price, av: r.avail ? 1 : 0, removed: false };
      order.push(k);
    }
  });

  var out = [];
  order.forEach(function (k) {
    var item = byKey[k];
    if (!item.removed) out.push({ it: item.it, cat: item.cat, price: item.price, av: item.av });
  });
  return out;
}

function menuForRestaurant_(rest) {
  var seen = {}, out = [];
  branchRecords_().forEach(function (b) {
    if (keyOf_(b.restaurant) !== keyOf_(rest)) return;
    menuForBranch_(rest, b.key).forEach(function (item) {
      var k = keyOf_(item.it);
      if (seen[k]) return;
      seen[k] = 1; out.push(item);
    });
  });
  return out;
}

function reasonsForRest_(rest) {
  var out = [], seen = {}, rows = readTable_(CONFIG.REASONS_SHEET, 6);
  rows.forEach(function (r) {
    if (keyOf_(r[0]) !== keyOf_(rest)) return;
    if (normName_(r[1])) return;
    if (String(r[5]).toUpperCase() === 'FALSE') return;
    var v = normName_(r[2]);
    if (!v || keyOf_(v) === keyOf_(UNSPEC)) return;
    if (seen[keyOf_(v)]) return;
    seen[keyOf_(v)] = 1;
    out.push(v);
  });
  if (!rows.some(function (r) { return keyOf_(r[0]) === keyOf_(rest); }) &&
      keyOf_(rest) === keyOf_(CONFIG.REST_DEFAULT)) {
    var dataSh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.DATA_SHEET);
    if (dataSh) out = readList_(dataSh, CONFIG.REASON_COL).filter(function (x) { return keyOf_(x) !== keyOf_(UNSPEC); });
  }
  return out;
}

function reasonsForAllBranches_(rest) {
  var out = [], seen = {};
  branchRecords_().forEach(function (b) {
    if (keyOf_(b.restaurant) !== keyOf_(rest)) return;
    reasonsForBranch_(rest, b.key).forEach(function (reason) {
      var k = keyOf_(reason);
      if (seen[k]) return;
      seen[k] = 1; out.push(reason);
    });
  });
  return out;
}

function reasonsForBranch_(rest, branch) {
  var restKey = keyOf_(rest), rec = branchRec_(branch, rest);
  var branchKey = rec ? keyOf_(rec.key) : keyOf_(branch);
  var branchName = rec ? keyOf_(rec.name) : branchKey;
  var rows = readTable_(CONFIG.REASONS_SHEET, 6);
  var hasRest = false, order = [], map = {};

  rows.forEach(function (r) {
    if (keyOf_(r[0]) !== restKey) return;
    hasRest = true;
    var reason = normName_(r[2]);
    if (!reason || keyOf_(reason) === keyOf_(UNSPEC)) return;
    var scope = normName_(r[1]);
    var shared = !scope;
    if (!shared && keyOf_(scope) !== branchKey && keyOf_(scope) !== branchName) return;
    var k = keyOf_(reason), entry = map[k];
    if (!entry) {
      entry = map[k] = { name: reason, shared: null, specific: null };
      order.push(k);
    }
    var enabled = String(r[5]).toUpperCase() !== 'FALSE';
    if (shared) {
      if (entry.shared === null) entry.shared = enabled;
    } else {
      entry.specific = enabled;                    // تخصيص الفرع يتغلّب على الإعداد المشترك
    }
  });

  if (!hasRest && restKey === keyOf_(CONFIG.REST_DEFAULT)) {
    var dataSh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.DATA_SHEET);
    if (dataSh) return readList_(dataSh, CONFIG.REASON_COL).filter(function (x) { return keyOf_(x) !== keyOf_(UNSPEC); });
  }

  return order.filter(function (k) {
    var entry = map[k];
    return entry.specific === null ? !!entry.shared : entry.specific;
  }).map(function (k) { return map[k].name; });
}

function listReasons(token, restaurant, branch) {
  var user = auth_(token, [ROLE_MGMT]);
  ensureTenancy_();
  var rid = resolveRestaurant_(user, restaurant);
  if (keyOf_(branch) === 'all') {
    return { ok: true, restaurant: rid, branch: 'ALL', reasons: reasonsForAllBranches_(rid) };
  }
  var rec = branchRecForUser_(user, branch, rid);
  if (!rec) throw new Error('اختار فرعًا تابعًا للمطعم المحدد.');
  return { ok: true, restaurant: rid, branch: rec.key, reasons: reasonsForBranch_(rid, rec.key) };
}

/* ---------------- مواعيد العمل اليومية لكل فرع ---------------- */

var DAILY_CACHE_ = { at: 0, rows: null };

function readDailyHoursRaw_(force) {
  var now = Date.now();
  if (!force && DAILY_CACHE_.rows && now - DAILY_CACHE_.at < 20000) return DAILY_CACHE_.rows;
  var out = [];
  readTable_(CONFIG.DAILY_SHEET, 8).forEach(function (r) {
    var rest = normName_(r[0]);
    var branch = normName_(r[1]);
    var wd = parseInt(r[2], 10);
    if (!rest || !branch || !(wd >= 0 && wd <= 6)) return;
    out.push({
      rest: rest, branch: branch, wd: wd,
      closed: String(r[3]).toUpperCase() === 'TRUE',
      openSec: parseSeconds_(r[4]), closeSec: parseSeconds_(r[5]),
      by: normName_(r[6]), at: normName_(r[7])
    });
  });
  DAILY_CACHE_ = { at: now, rows: out };
  return out;
}

function weekdayOf_(key) {
  var p = String(key || '').split('-');
  if (p.length !== 3) return new Date().getDay();
  return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2])).getUTCDay();
}

function dayHours_(rec, dateKey) {
  var wd = weekdayOf_(dateKey || nowParts_().key);
  var hit = null;
  readDailyHoursRaw_().forEach(function (r) {
    if (r.wd !== wd) return;
    if (keyOf_(r.rest) !== keyOf_(rec.restaurant)) return;
    if (keyOf_(r.branch) !== keyOf_(rec.key) && keyOf_(r.branch) !== keyOf_(rec.name)) return;
    hit = r;
  });
  if (hit) {
    var o = hit.openSec === null ? (CONFIG.SHIFT_START_HOUR || 9) * 3600 : hit.openSec;
    var c = hit.closeSec === null ? o : hit.closeSec;
    return { openSec: o, closeSec: c, closed: !!hit.closed, source: 'daily' };
  }
  var base = hoursInfoBase_(rec.sheet, hoursMap_());
  return { openSec: base.openSec, closeSec: base.closeSec, closed: false, source: 'base' };
}

function weekSchedule_(rec) {
  var rows = readDailyHoursRaw_(), base = hoursInfoBase_(rec.sheet, hoursMap_()), out = [];
  for (var wd = 0; wd < 7; wd++) {
    var hit = null;
    rows.forEach(function (r) {
      if (r.wd !== wd) return;
      if (keyOf_(r.rest) !== keyOf_(rec.restaurant)) return;
      if (keyOf_(r.branch) !== keyOf_(rec.key) && keyOf_(r.branch) !== keyOf_(rec.name)) return;
      hit = r;
    });
    if (hit) {
      out.push({
        wd: wd, closed: !!hit.closed,
        open: fmtHMS_(hit.openSec === null ? base.openSec : hit.openSec),
        close: fmtHMS_(hit.closeSec === null ? base.closeSec : hit.closeSec),
        source: 'daily'
      });
    } else {
      out.push({ wd: wd, closed: false, open: fmtHMS_(base.openSec), close: fmtHMS_(base.closeSec), source: 'base' });
    }
  }
  return out;
}

function scopedBranchRecs_(user) {
  return branchRecords_().filter(function (b) {
    if (isGlobalUser_(user)) return true;
    if (keyOf_(b.restaurant) !== keyOf_(ridFor_(user))) return false;
    if (user.role === ROLE_BRANCH || user.role === ROLE_AGENT) {
      return keyOf_(b.key) === keyOf_(user.branch) || keyOf_(b.name) === keyOf_(user.branch);
    }
    return true;
  });
}

function getBranchDailyHours(token) {
  var user = auth_(token, [ROLE_MGMT]);
  ensureTenancy_();
  var recs = scopedBranchRecs_(user);
  return {
    ok: true,
    branches: recs.map(function (b) {
      var base = hoursInfoBase_(b.sheet, hoursMap_());
      return {
        key: b.key, name: b.name, restaurant: b.restaurant, restaurantName: b.restaurantName,
        base: { open: fmtHMS_(base.openSec), close: fmtHMS_(base.closeSec) },
        days: weekSchedule_(b)
      };
    }),
    restaurants: readRestaurants_(false).filter(function (r) {
      return isGlobalUser_(user) || keyOf_(r.id) === keyOf_(ridFor_(user));
    })
  };
}

function saveBranchDailyHours(token, branch, days) {
  var user = auth_(token, [ROLE_MGMT]);
  var rec = branchRecForUser_(user, branch);
  if (!rec) throw new Error('الفرع غير موجود أو مش تابع للمطعم.');
  if (!Array.isArray(days) || days.length !== 7) throw new Error('لازم تبعت مواعيد 7 أيام.');
  var clean = [];
  for (var i = 0; i < 7; i++) {
    var d = days[i] || {};
    var closed = !!d.closed;
    var o = parseSeconds_(d.open), c = parseSeconds_(d.close);
    if (!closed) {
      if (o === null) throw new Error('وقت الفتح غير صحيح في يوم ' + (i + 1) + '.');
      if (c === null) throw new Error('وقت القفل غير صحيح في يوم ' + (i + 1) + '.');
      if (o === c) throw new Error('وقت الفتح والقفل مينفعش يكونوا نفس الوقت (يوم ' + (i + 1) + ').');
    }
    clean.push({ wd: i, closed: closed, o: o, c: c });
  }

  withLock_(function () {
    var sh = tblSheet_(CONFIG.DAILY_SHEET, DAILY_HEADERS, true);
    var rows = readTable_(CONFIG.DAILY_SHEET, 8);
    for (var i = rows.length - 1; i >= 0; i--) {
      if (keyOf_(rows[i][0]) !== keyOf_(rec.restaurant)) continue;
      if (keyOf_(rows[i][1]) !== keyOf_(rec.key) && keyOf_(rows[i][1]) !== keyOf_(rec.name)) continue;
      sh.deleteRow(i + 2);
    }
    var startRow = sh.getLastRow() + 1;
    if (startRow + clean.length - 1 > sh.getMaxRows()) {
      sh.insertRowsAfter(sh.getMaxRows(), startRow + clean.length - 1 - sh.getMaxRows());
    }
    sh.getRange(startRow, 5, clean.length, 2).setNumberFormat('@');
    var stamp = nowIso_();
    var values = clean.map(function (d) {
      return [sheetSafe_(rec.restaurant), sheetSafe_(rec.key), d.wd, d.closed,
        d.closed ? '' : timeText_(d.o), d.closed ? '' : timeText_(d.c), sheetSafe_(user.username), stamp];
    });
    sh.getRange(startRow, 1, values.length, 8).setValues(values);
  });

  DAILY_CACHE_ = { at: 0, rows: null };
  cacheClear_();
  bumpLive_();
  audit_(user, 'DAILY_HOURS_UPDATE', rec.name, { days: 7 }, 'OK');
  var res = { ok: true, branch: rec.name, days: weekSchedule_(rec) };
  res.data = safePayload_(user);
  return res;
}

/* ---------------- الشيفت + الإغلاق التلقائي ---------------- */

function shiftInfo_(rec, now) {
  now = now || nowParts_();
  var nowAbs = dayNum_(now.key) * 86400 + now.sec;
  var selected = null;
  for (var offset = 0; offset <= 6; offset++) {
    var dayKey = addDaysKey_(now.key, -offset);
    var hours = dayHours_(rec, dayKey);
    if (hours.closed) continue;
    var openAbs = dayNum_(dayKey) * 86400 + hours.openSec;
    if (openAbs > nowAbs) continue;
    selected = { day: dayKey, startAbs: openAbs, hours: hours };
    break;
  }
  if (!selected) {
    var fallback = dayHours_(rec, now.key);
    return {
      day: now.key, startAbs: nowAbs, endAbs: nowAbs,
      openSec: fallback.openSec, closeSec: fallback.closeSec, closed: true,
      openNow: false, due: false, key: rec.key + '|' + now.key
    };
  }
  var span = (selected.hours.closeSec - selected.hours.openSec + 86400) % 86400;
  if (!span) span = 86400;
  var endAbs = selected.startAbs + span;
  var nowOpen = branchOpenAt_(rec, now);
  return {
    day: selected.day, startAbs: selected.startAbs, endAbs: endAbs,
    openSec: selected.hours.openSec, closeSec: selected.hours.closeSec, closed: false,
    openNow: nowOpen, due: nowAbs >= endAbs,
    key: rec.key + '|' + selected.day
  };
}

function branchOpenAt_(rec, now) {
  now = now || nowParts_();
  var nowAbs = dayNum_(now.key) * 86400 + now.sec;
  var open = false;
  [now.key, addDaysKey_(now.key, -1)].forEach(function (dateKey) {
    var hours = dayHours_(rec, dateKey);
    if (hours.closed) return;
    var start = dayNum_(dateKey) * 86400 + hours.openSec;
    var span = (hours.closeSec - hours.openSec + 86400) % 86400;
    if (!span) span = 86400;
    if (nowAbs >= start && nowAbs < start + span) open = true;
  });
  return open;
}

function shiftLogRows_() {
  var out = [];
  readTable_(CONFIG.SHIFT_SHEET, 11).forEach(function (r) {
    var id = normName_(r[0]);
    if (!id) return;
    out.push({
      id: id, at: normName_(r[1]), rest: normName_(r[2]), branch: normName_(r[3]),
      day: normName_(r[4]), open: normName_(r[5]), close: normName_(r[6]),
      stops: parseInt(r[7], 10) || 0, closed: parseInt(r[8], 10) || 0,
      actor: normName_(r[9]), note: normName_(r[10])
    });
  });
  return out;
}

function recentShifts_(limit) {
  return shiftLogRows_().sort(function (a, b) { return a.at < b.at ? 1 : a.at > b.at ? -1 : 0; }).slice(0, Math.max(1, limit || 25));
}

function shiftDone_(branchKey, day, restaurant) {
  return shiftLogRows_().some(function (x) {
    return keyOf_(x.branch) === keyOf_(branchKey) && x.day === day &&
      (!restaurant || keyOf_(x.rest) === keyOf_(restaurant));
  });
}

function closeInstantForStop_(rec, rowDay, stopSec) {
  var stopAbs = dayNum_(rowDay) * 86400 + stopSec;
  var best = null;
  for (var off = -1; off <= 2; off++) {
    var d = addDaysKey_(rowDay, off);
    var hd = dayHours_(rec, d);
    if (hd.closed) continue;
    var openAbs = dayNum_(d) * 86400 + hd.openSec;
    var span = (hd.closeSec - hd.openSec + 86400) % 86400;
    if (!span) span = 86400;
    var endAbs = openAbs + span;
    if (endAbs >= stopAbs && (best === null || endAbs < best)) best = endAbs;
  }
  return best;
}

function systemUser_() { return { username: 'system', role: 'system', branch: '', restaurant: '' }; }

function rolloverOne_(rec, now, user, force) {
  var si = shiftInfo_(rec, now);
  if (!si.due && !force) return { branch: rec.name, key: rec.key, skipped: true, reason: 'لسه الشيفت شغال', close: fmtHMS_(si.closeSec) };
  if (shiftDone_(rec.key, si.day, rec.restaurant)) return { branch: rec.name, key: rec.key, skipped: true, reason: 'الشيفت اترحّل بالفعل', day: si.day };

  var sh = rec.sheet, closedCount = 0, stopsInShift = 0, openBefore = 0, toClose = [];
  var n = sh.getLastRow() - CONFIG.FIRST_ROW + 1;
  if (n >= 1) {
    var rng = sh.getRange(CONFIG.FIRST_ROW, 1, n, 5);
    var v = rng.getValues(), d = rng.getDisplayValues();
    for (var i = 0; i < n; i++) {
      var item = normName_(v[i][2]);
      if (!item) continue;
      var dk = dateKey_(v[i][0], d[i][0], CONFIG.TZ);
      var stopSec = parseSeconds_(d[i][3]);
      var isOpen = String(d[i][4]).trim() === '';
      if (isOpen) openBefore++;
      if (dk && stopSec !== null) {
        var stopAbs = dayNum_(dk) * 86400 + stopSec;
        if (stopAbs >= si.startAbs && stopAbs <= si.endAbs) stopsInShift++;
      }
      if (!isOpen) continue;
      // Close every open session in this branch, even when its date/time cells are malformed.
      if (!dk) dk = si.day;
      var closeAbs = stopSec === null ? null : closeInstantForStop_(rec, dk, stopSec);
      if (closeAbs === null) closeAbs = si.endAbs;
      var startSec = ((closeAbs % 86400) + 86400) % 86400;
      if (startSec === stopSec) startSec = (startSec + 1) % 86400;
      toClose.push({ row: CONFIG.FIRST_ROW + i, startSec: startSec });
    }
    var closeGroups = [];
    toClose.forEach(function (entry) {
      var group = closeGroups.length ? closeGroups[closeGroups.length - 1] : null;
      if (!group || entry.row !== group.start + group.rows.length) {
        group = { start: entry.row, rows: [] };
        closeGroups.push(group);
      }
      group.rows.push(entry);
    });
    var writeErrors = [];
    closeGroups.forEach(function (group) {
      var values = group.rows.map(function (entry) {
        return [entry.startSec / 86400, '=IF(E' + entry.row + '="","",MOD(E' + entry.row + '-D' + entry.row + ',1))'];
      });
      try {
        var outRange = sh.getRange(group.start, 5, group.rows.length, 2);
        outRange.setValues(values);
        sh.getRange(group.start, 5, group.rows.length, 1).setNumberFormat('h:mm:ss AM/PM');
        sh.getRange(group.start, 6, group.rows.length, 1).setNumberFormat('[h]:mm:ss');
        closedCount += group.rows.length;
      } catch (writeError) {
        writeErrors.push(String(writeError && writeError.message || writeError));
      }
    });
    if (closedCount) SpreadsheetApp.flush();
    if (writeErrors.length) throw new Error('تعذر إغلاق بعض الأصناف في ' + rec.name + ': ' + writeErrors.join(' | '));
  }

  var id = 'SH-' + Utilities.formatDate(new Date(), CONFIG.TZ, 'yyyyMMdd-HHmmss') + '-' + randomPass_(3).toUpperCase();
  appendRow_(CONFIG.SHIFT_SHEET, SHIFT_HEADERS, [
    sheetSafe_(id), nowIso_(), sheetSafe_(rec.restaurant), sheetSafe_(rec.key),
    sheetSafe_(si.day), fmtHMS_(si.openSec), fmtHMS_(si.closeSec),
    stopsInShift, closedCount, sheetSafe_((user && user.username) || 'system'),
    sheetSafe_(force ? 'إغلاق يدوي' : 'إغلاق تلقائي')
  ]);
  trimRows_(CONFIG.SHIFT_SHEET, 2000);
  bumpShift_(rec.key);
  audit_(user || systemUser_(), 'SHIFT_ROLLOVER', rec.name,
    { day: si.day, closed: closedCount, stops: stopsInShift, force: !!force }, 'OK', id);
  return { branch: rec.name, key: rec.key, ok: true, day: si.day, closed: closedCount, stops: stopsInShift, openBefore: openBefore, id: id };
}

function runShiftRollover(token, branch, force, restaurant) {
  var user = auth_(token, [ROLE_MGMT, ROLE_BRANCH]);
  var isForce = !!force && user.role === ROLE_MGMT;
  if (!branch && user.role === ROLE_MGMT) throw new Error('اختار الفرع المستهدف قبل تنفيذ الإغلاق.');

  var rid = user.role === ROLE_MGMT ? resolveRestaurant_(user, restaurant) : ridFor_(user);
  var rec = branchRecForUser_(user, branch || user.branch, rid);
  if (!rec) throw new Error('الفرع غير موجود أو غير تابع للبراند المحدد.');
  if (!isActiveRestaurant_(rec.restaurant)) throw new Error('المطعم المرتبط بالفرع غير نشط.');

  var now = nowParts_();
  var out = [];
  withLock_(function () {
    try { out.push(rolloverOne_(rec, now, user, isForce)); }
    catch (e) {
      var raw = String(e && e.message || e);
      out.push({ branch: rec.name, key: rec.key, ok: false, error: publicMsg_(raw) });
      if (!isBusinessMessage_(raw)) {
        try { logError_('runShiftRollover', user, errCode_(raw), raw, String((e && e.stack) || '')); } catch (_) {}
      }
    }
  });
  cacheClear_();
  bumpLive_();
  return { ok: true, restaurant: rid, at: now.key + ' ' + now.hms, results: out };
}

/**
 * الإغلاق التلقائي معطّل افتراضيًا — ممنوع أي إغلاق جماعي/عام.
 * لو المالك عايز إغلاق تلقائي لفرع واحد فقط، يضبط في Script Properties:
 *   ROLLOVER_AUTO_ENABLED = 1
 *   ROLLOVER_AUTO_BRANCH  = <اسم/كود الفرع>
 *   ROLLOVER_AUTO_RESTAURANT = <كود البراند> (اختياري لكن مستحسن للعزل)
 * وبكده كل تشغيل يعالج الفرع ده فقط، ومفيش أي لوب على كل الفروع.
 */
function autoRollover() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return { ok: false, reason: 'busy' };
  try {
    var props = PropertiesService.getScriptProperties();
    if (String(props.getProperty('ROLLOVER_AUTO_ENABLED') || '0') !== '1') {
      return { ok: true, disabled: true, reason: 'الإغلاق التلقائي معطّل — استخدم الإغلاق اليدوي للفرع المحدد.' };
    }
    var target = cleanText_(props.getProperty('ROLLOVER_AUTO_BRANCH'), 80);
    var autoRest = cleanText_(props.getProperty('ROLLOVER_AUTO_RESTAURANT'), 40);
    var rec = target ? branchRec_(target, autoRest || null) : null;
    if (!rec) return { ok: false, reason: 'ROLLOVER_AUTO_BRANCH غير محدد أو الفرع غير موجود.' };
    if (!isActiveRestaurant_(rec.restaurant)) return { ok: false, reason: 'المطعم المرتبط بالفرع غير نشط.' };

    var now = nowParts_();
    var si = shiftInfo_(rec, now);
    if (!si.due || shiftDone_(rec.key, si.day, rec.restaurant)) {
      return { ok: true, at: nowIso_(), results: [] };
    }
    var sys = systemUser_();
    var result;
    try { result = rolloverOne_(rec, now, sys, false); }
    catch (e) {
      var raw = String(e && e.message || e);
      result = { branch: rec.name, ok: false, error: publicMsg_(raw) };
      if (!isBusinessMessage_(raw)) {
        try { logError_('autoRollover', sys, errCode_(raw), raw, String((e && e.stack) || '')); } catch (_) {}
      }
    }
    cacheClear_();
    bumpLive_();
    return { ok: true, at: nowIso_(), results: [result] };
  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
}

function installRolloverTrigger() {
  editorOnly_();
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'autoRollover') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('autoRollover').timeBased().everyMinutes(1).create();
  var msg = 'تم تفعيل التريجر، لكنه لا يعمل إلا بعد ضبط ROLLOVER_AUTO_ENABLED=1 و ROLLOVER_AUTO_BRANCH لفرع واحد محدد.';
  Logger.log(msg);
  return msg;
}

function removeRolloverTrigger() {
  editorOnly_();
  var n = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'autoRollover') { ScriptApp.deleteTrigger(t); n++; }
  });
  return 'تم حذف ' + n + ' تريجر.';
}

function getShiftLog(token, limit, branch, restaurant) {
  var user = auth_(token, [ROLE_MGMT, ROLE_BRANCH]);
  var rid = restaurant ? resolveRestaurant_(user, restaurant) : (user.role === ROLE_MGMT ? '' : ridFor_(user));
  var selected = branch ? branchRecForUser_(user, branch, rid || null) : null;
  if (branch && !selected) throw new Error('الفرع غير موجود أو غير تابع لحسابك.');
  var rows = shiftLogRows_().filter(function (x) {
    if (selected && keyOf_(x.branch) !== keyOf_(selected.key)) return false;
    if (rid && keyOf_(x.rest) !== keyOf_(rid)) return false;
    if (isGlobalUser_(user)) return true;
    if (keyOf_(x.rest) !== keyOf_(user.restaurant)) return false;
    if (user.role === ROLE_BRANCH) return keyOf_(x.branch) === keyOf_(user.branch);
    return true;
  }).sort(function (a, b) { return a.at < b.at ? 1 : a.at > b.at ? -1 : 0; });
  return { ok: true, entries: rows.slice(0, Math.max(1, Math.min(limit || 100, 300))) };
}

/* ---------------- الإشعارات (توجيه صارم) ---------------- */

var NOTIF_CACHE_ = { at: 0, rows: null };

function notifRows_(force) {
  var now = Date.now();
  if (!force && NOTIF_CACHE_.rows && now - NOTIF_CACHE_.at < 10000) return NOTIF_CACHE_.rows;
  var out = [];
  readTable_(CONFIG.NOTIF_SHEET, 11).forEach(function (r) {
    var id = normName_(r[0]);
    if (!id) return;
    out.push({
      id: id, at: normName_(r[1]), rest: normName_(r[2]), branch: normName_(r[3]),
      roles: normName_(r[4]), target: normName_(r[5]), kind: normName_(r[6]),
      severity: normName_(r[7]) || 'info', title: normName_(r[8]), body: normName_(r[9]), ref: normName_(r[10])
    });
  });
  NOTIF_CACHE_ = { at: now, rows: out };
  return out;
}

function visibleNotif_(n, user) {
  var roles = String(n.roles || '').split(',').map(function (x) { return keyOf_(x); }).filter(function (x) { return !!x; });
  if (roles.length && roles.indexOf(keyOf_(user.role)) < 0) return false;
  if (n.target && keyOf_(n.target) !== keyOf_(user.username)) return false;
  if (n.rest && keyOf_(n.rest) !== 'all' && !isGlobalUser_(user) && keyOf_(n.rest) !== keyOf_(user.restaurant)) return false;
  if (user.role === ROLE_BRANCH) {
    if (!n.branch) return false;                    // حسابات الفرع مبتشوفش إشعارات عامة أو لفروع تانية
    return keyOf_(n.branch) === keyOf_(user.branch);
  }
  if (user.role === ROLE_AGENT) {
    if (user.branch && n.branch && keyOf_(n.branch) !== keyOf_(user.branch)) return false;
    return true;
  }
  if (user.role === ROLE_MGMT && !isGlobalUser_(user)) {
    if (n.rest && keyOf_(n.rest) !== keyOf_(user.restaurant)) return false;
  }
  return true;
}

function notifReadKey_(username) { return 'nread_' + hashKey_(keyOf_(username)); }

function readSet_(username) {
  var cache = CacheService.getScriptCache(), k = notifReadKey_(username);
  var raw = cache.get(k);
  if (raw) { try { return JSON.parse(raw); } catch (e) {} }
  var out = {};
  readTable_(CONFIG.NOTIF_READ_SHEET, 3).forEach(function (r) {
    if (keyOf_(r[1]) === keyOf_(username)) out[normName_(r[0])] = 1;
  });
  try { cache.put(k, JSON.stringify(out), 600); } catch (e) {}
  return out;
}

function listNotifications_(user, limit) {
  var read = readSet_(user.username);
  var visible = notifRows_(false).filter(function (n) { return visibleNotif_(n, user); });
  var unread = visible.filter(function (n) { return !read[n.id]; }).length;
  visible.sort(function (a, b) { return a.at < b.at ? 1 : a.at > b.at ? -1 : 0; });
  var max = Math.max(0, Math.min(parseInt(limit, 10) || 50, 100));
  return {
    ok: true, unread: unread, total: visible.length,
    items: max ? visible.slice(0, max).map(function (n) {
      return {
        id: n.id, at: n.at, kind: n.kind, severity: n.severity,
        title: n.title, body: n.body, ref: n.ref, read: !!read[n.id]
      };
    }) : []
  };
}

function listNotifications(token, limit) {
  var user = auth_(token);
  return listNotifications_(user, limit);
}

function markNotificationsRead(token, ids) {
  var user = auth_(token);
  ids = Array.isArray(ids) ? ids.slice(0, 100) : [];
  var valid = {};
  notifRows_(false).forEach(function (n) {
    if (visibleNotif_(n, user)) valid[n.id] = 1;
  });
  var targets = ids.length ? ids.filter(function (id) { return valid[String(id)]; }) :
    Object.keys(valid);
  if (targets.length) {
    var sh = tblSheet_(CONFIG.NOTIF_READ_SHEET, NOTIF_READ_HEADERS, true);
    var known = readSet_(user.username);
    var stamp = nowIso_();
    var rows = targets.filter(function (id) { return !known[id]; }).map(function (id) {
      return [sheetSafe_(id), sheetSafe_(user.username), stamp];
    });
    if (rows.length) {
      var first = sh.getLastRow() + 1;
      if (first + rows.length - 1 > sh.getMaxRows()) {
        sh.insertRowsAfter(sh.getMaxRows(), first + rows.length - 1 - sh.getMaxRows());
      }
      sh.getRange(first, 1, rows.length, 3).setValues(rows);
    }
    try { CacheService.getScriptCache().remove(notifReadKey_(user.username)); } catch (e) {}
  }
  return listNotifications_(user, 50);
}

function unreadCount_(user) {
  var read = readSet_(user.username);
  return notifRows_(false).filter(function (n) {
    return visibleNotif_(n, user) && !read[n.id];
  }).length;
}

/* ---------------- الاستطلاع اللحظي ---------------- */

function pollState(token, since, restaurant) {
  var base = auth_(token);
  var user = scopedPayloadUser_(base, restaurant);
  var rev = liveRev_();
  var now = nowParts_();
  var unread = unreadCount_(base);
  if (since && String(since) === String(rev)) {
    return { ok: true, unchanged: true, rev: rev, at: now.key + ' ' + now.hms, unread: unread };
  }
  var data = fullData_(false);
  var scoped = scopePayload_(data, user);
  return {
    ok: true, rev: rev, at: now.key + ' ' + now.hms, unread: unread,
    notifications: listNotifications_(base, 30).items,
    menu: scoped.menu || {},
    branches: (scoped.branches || []).map(function (b) {
      return {
        name: b.name, key: b.key, closed: !!b.closed, shiftDay: b.shiftDay, shiftKey: b.shiftKey,
        openCount: (b.rows || []).filter(function (r) { return r.o; }).length,
        stoppedItems: (b.rows || []).filter(function (r) { return r.o; }).map(function (r) { return r.it; })
      };
    }),
    generatedAt: scoped.generatedAt, now: scoped.now
  };
}

/* ---------------- سجل الأخطاء ---------------- */

var ERROR_CACHE_ = { at: 0, rows: null };

function logError_(action, user, code, message, detail, stack) {
  try {
    appendRow_(CONFIG.ERROR_SHEET, ERROR_HEADERS, [
      nowIso_(), sheetSafe_(action || 'api'), sheetSafe_((user && user.username) || '—'),
      sheetSafe_((user && user.role) || '—'), sheetSafe_(code || ''),
      sheetSafe_(cleanText_(message, 300)), sheetSafe_(cleanText_(detail, 900)), sheetSafe_(cleanText_(stack, 900))
    ]);
    trimRows_(CONFIG.ERROR_SHEET, CONFIG.MAX_ERROR_ROWS || 800);
    ERROR_CACHE_.at = 0;
  } catch (e) {}
}

function errorRows_(force) {
  var now = Date.now();
  if (!force && ERROR_CACHE_.rows && now - ERROR_CACHE_.at < 8000) return ERROR_CACHE_.rows;
  var out = [];
  readTable_(CONFIG.ERROR_SHEET, 8).forEach(function (r) {
    var at = normName_(r[0]);
    if (!at) return;
    out.push({
      at: at, action: normName_(r[1]), by: normName_(r[2]), role: normName_(r[3]),
      code: normName_(r[4]), message: normName_(r[5]), detail: normName_(r[6]), stack: normName_(r[7])
    });
  });
  out.sort(function (a, b) { return a.at < b.at ? 1 : a.at > b.at ? -1 : 0; });
  ERROR_CACHE_ = { at: now, rows: out };
  return out;
}

function getErrorLog(token, limit) {
  var user = auth_(token, [ROLE_MGMT]);
  if (!isGlobalUser_(user)) throw new Error('سجل الأخطاء متاح للأدمن العام فقط.');
  return { ok: true, entries: errorRows_(true).slice(0, Math.max(1, Math.min(limit || 100, 300))) };
}

/* ---------------- إدارة المنيو ---------------- */

function listMenu(token, restaurant, branch) {
  var user = auth_(token, [ROLE_MGMT]);
  ensureTenancy_();
  var rid = resolveRestaurant_(user, restaurant);
  var recs = branchRecords_().filter(function (b) { return keyOf_(b.restaurant) === keyOf_(rid); });
  if (!branch) throw new Error('اختار الفرع أو كل الفروع قبل عرض المنيو.');
  var byBranch = {};
  recs.forEach(function (b) { byBranch[b.key] = menuForBranch_(rid, b.key); });
  var allBranches = keyOf_(branch) === 'all';
  var selected = allBranches ? null : branchRecForUser_(user, branch, rid);
  if (!allBranches && !selected) throw new Error('الفرع غير موجود في المطعم المحدد.');
  return {
    ok: true, restaurant: rid,
    restaurants: readRestaurants_(false).filter(function (r) { return isGlobalUser_(user) || keyOf_(r.id) === keyOf_(user.restaurant); }),
    branches: recs.map(function (b) { return { key: b.key, name: b.name }; }),
    items: allBranches ? menuForRestaurant_(rid) : (byBranch[selected.key] || []),
    scope: allBranches ? 'all' : selected.key,
    byBranch: byBranch, reasons: reasonsForRest_(rid)
  };
}

function saveMenuItem(token, info) {
  var user = auth_(token, [ROLE_MGMT]);
  info = info || {};
  var rid = resolveRestaurant_(user, info.restaurant);
  var allBranches = info.scope === 'all' || info.allBranches === true;
  var branchKey = cleanText_(info.branch, 80);
  var rec = allBranches ? null : branchRecForUser_(user, branchKey, rid);
  if (!allBranches && !rec) throw new Error('اختار فرعًا تابعًا للمطعم المحدد.');
  if (rec) branchKey = rec.key;
  var item = cleanText_(info.item, CONFIG.MAX_TEXT).replace(/^[=+\-@]+/, '').trim();
  if (!item) throw new Error('اكتب اسم الصنف.');
  var cat = cleanText_(info.category, 60);
  var price = numFrom_(info.price);
  if (price !== null && (price < 0 || price > 100000)) throw new Error('السعر غير صحيح.');
  var avail = info.available !== false;

  withLock_(function () {
    var sh = tblSheet_(CONFIG.MENU_SHEET, MENU_HEADERS, true);
    var rows = readTable_(CONFIG.MENU_SHEET, 9), targets = allBranches
      ? branchRecords_().filter(function (b) { return keyOf_(b.restaurant) === keyOf_(rid); }).map(function (b) { return b.key; })
      : [branchKey];
    if (allBranches) targets.unshift('');
    targets.forEach(function (scopeBranch) {
      var row = 0;
      for (var i = 0; i < rows.length; i++) {
        if (keyOf_(rows[i][0]) === keyOf_(rid) && keyOf_(rows[i][1]) === keyOf_(scopeBranch) &&
            keyOf_(rows[i][2]) === keyOf_(item)) { row = i + 2; break; }
      }
      var vals = [sheetSafe_(rid), sheetSafe_(scopeBranch), sheetSafe_(item), sheetSafe_(cat),
        price === null ? '' : price, avail, sheetSafe_(user.username), nowIso_(), true];
      if (row) sh.getRange(row, 1, 1, 9).setValues([vals]);
      else {
        sh.appendRow(vals);
        rows.push(vals);
      }
    });
  });

  MENU_CACHE_ = { at: 0, rows: null };
  safeApplyValidations_(rid);
  cacheClear_();
  audit_(user, 'MENU_SAVE', rid + '/' + (allBranches ? 'ALL' : branchKey) + '/' + item, { available: avail, price: price }, 'OK');
  var res = { ok: true, item: item, available: avail, scope: allBranches ? 'all' : branchKey };
  res.data = safePayload_(user);
  return res;
}

function deleteMenuItem(token, restaurant, branch, item) {
  var user = requireAdmin_(auth_(token, [ROLE_MGMT]));
  var rid = resolveRestaurant_(user, restaurant);
  var branchKey = cleanText_(branch, 80);
  var allBranches = !branchKey || keyOf_(branchKey) === 'all';
  var rec = allBranches ? null : branchRecForUser_(user, branchKey, rid);
  if (!allBranches && !rec) throw new Error('اختار فرعًا تابعًا للمطعم المحدد.');
  if (rec) branchKey = rec.key;
  item = cleanText_(item, CONFIG.MAX_TEXT);
  if (!item) throw new Error('اختار الصنف.');
  var removed = false;
  withLock_(function () {
    var sh = tblSheet_(CONFIG.MENU_SHEET, MENU_HEADERS, true);
    var rows = readTable_(CONFIG.MENU_SHEET, 9), branchRow = 0, base = null;
    if (allBranches) {
      for (var j = rows.length - 1; j >= 0; j--) {
        if (keyOf_(rows[j][0]) !== keyOf_(rid) || keyOf_(rows[j][2]) !== keyOf_(item)) continue;
        sh.deleteRow(j + 2); removed = true;
      }
      return;
    }
    for (var i = 0; i < rows.length; i++) {
      if (keyOf_(rows[i][0]) !== keyOf_(rid) || keyOf_(rows[i][2]) !== keyOf_(item)) continue;
      if (keyOf_(rows[i][1]) === keyOf_(branchKey)) branchRow = i + 2;
      else if (!normName_(rows[i][1]) && String(rows[i][8]).toUpperCase() !== 'FALSE') base = rows[i];
    }
    if (!branchRow && !base) return;
    if (base) {
      var vals = [sheetSafe_(rid), sheetSafe_(branchKey), sheetSafe_(item),
        branchRow ? rows[branchRow - 2][3] : base[3], branchRow ? rows[branchRow - 2][4] : base[4],
        false, sheetSafe_(user.username), nowIso_(), false];
      if (branchRow) sh.getRange(branchRow, 1, 1, 9).setValues([vals]);
      else sh.appendRow(vals);
      removed = true;
    } else if (branchRow) {
      sh.deleteRow(branchRow);
      removed = true;
    }
  });
  MENU_CACHE_ = { at: 0, rows: null };
  safeApplyValidations_(rid);
  cacheClear_();
  audit_(user, 'MENU_DELETE', rid + '/' + (allBranches ? 'ALL' : branchKey) + '/' + item, { removed: removed }, 'OK');
  var res = { ok: true, removed: removed ? 1 : 0, item: item, scope: allBranches ? 'all' : branchKey };
  res.data = safePayload_(user);
  return res;
}

function setItemAvailability(token, branch, item, available, scope, restaurant) {
  var user = auth_(token, [ROLE_MGMT]);
  var rid = resolveRestaurant_(user, restaurant);
  var allBranches = scope === 'all' || !branch || keyOf_(branch) === 'all';
  var rec = allBranches ? null : branchRecForUser_(user, branch, rid);
  if (!allBranches && !rec) throw new Error('الفرع غير موجود في المطعم المحدد.');
  item = cleanText_(item, CONFIG.MAX_TEXT);
  if (!item) throw new Error('اختار الصنف.');
  var on = !(available === false || available === 0 || available === '0' || available === 'false');

  withLock_(function () {
    var sh = tblSheet_(CONFIG.MENU_SHEET, MENU_HEADERS, true);
    var rows = readTable_(CONFIG.MENU_SHEET, 9), row = 0, baseRow = 0, cat = '', price = '';
    for (var i = 0; i < rows.length; i++) {
      if (keyOf_(rows[i][0]) !== keyOf_(rid)) continue;
      if (keyOf_(rows[i][2]) !== keyOf_(item)) continue;
      if (!allBranches && keyOf_(rows[i][1]) === keyOf_(rec.key)) row = i + 2;
      else if (!normName_(rows[i][1]) && String(rows[i][8]).toUpperCase() !== 'FALSE') { baseRow = i + 2; cat = normName_(rows[i][3]); price = rows[i][4]; }
    }
    var meta = nowIso_();
    if (allBranches) {
      if (!baseRow) {
        var existingItem = rows.filter(function (r) {
          return keyOf_(r[0]) === keyOf_(rid) && keyOf_(r[2]) === keyOf_(item);
        })[0];
        if (!existingItem) throw new Error('الصنف "' + item + '" مش في منيو المطعم.');
        cat = normName_(existingItem[3]); price = existingItem[4];
      }
      var targets = branchRecords_().filter(function (b) { return keyOf_(b.restaurant) === keyOf_(rid); })
        .map(function (b) { return b.key; });
      targets.unshift('');
      targets.forEach(function (scopeBranch) {
        var existingRow = 0;
        rows.forEach(function (r, idx) {
          if (keyOf_(r[0]) === keyOf_(rid) && keyOf_(r[1]) === keyOf_(scopeBranch) &&
              keyOf_(r[2]) === keyOf_(item)) existingRow = idx + 2;
        });
        var values = [sheetSafe_(rid), sheetSafe_(scopeBranch), sheetSafe_(item), sheetSafe_(cat),
          price === null ? '' : price, on, sheetSafe_(user.username), meta, true];
        if (existingRow) sh.getRange(existingRow, 1, 1, 9).setValues([values]);
        else { sh.appendRow(values); rows.push(values); }
      });
    } else if (row) {
      sh.getRange(row, 6, 1, 4).setValues([[on, sheetSafe_(user.username), meta, true]]);
    } else {
      if (!baseRow) throw new Error('الصنف "' + item + '" مش في منيو المطعم.');
      sh.appendRow([sheetSafe_(rid), sheetSafe_(rec.key), sheetSafe_(item), sheetSafe_(cat),
        price === null ? '' : price, on, sheetSafe_(user.username), meta, true]);
    }
  });

  MENU_CACHE_ = { at: 0, rows: null };
  safeApplyValidations_(rid);
  cacheClear_();
  audit_(user, 'ITEM_AVAIL', rid + '/' + (allBranches ? 'ALL' : rec.key) + '/' + item, { available: on }, 'OK');
  var res = { ok: true, item: item, available: on, scope: allBranches ? 'all' : rec.key };
  res.data = safePayload_(user);
  return res;
}
