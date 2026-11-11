/* ============================================================
 *  services/rbac-service.js
 *  ------------------------------------------------------------
 *  منطق الصلاحيات والعزل (Role Based Access Control + Data Isolation).
 *  كل الدوال هنا **بترجع البيانات فقط** — من غير أي لمس للواجهة.
 *  أي حد عايز يغيّر صلاحية أو يوسّع видиته لازم يعدّل هنا بالظبط.
 * ============================================================ */

export const ROLES = {
  MGMT: 'management',   /* مانجمنت — إدارة عامة (حسب البراند) */
  BRANCH: 'branch',     /* ديسباتشر — فروع محدّدة */
  AGENT: 'agent'        /* ايجينت — قراءة بس */
};

export const ROLE_LABELS = {
  management: 'مانجمنت',
  branch: 'دسباتشر فرع',
  agent: 'ايجينت'
};

/** هل اليوزر مدير نظام (صلاحيات كاملة)؟ */
export function isAdminUser(profile) {
  return !!(profile && profile.isAdmin === true);
}

/** هل اليوزر مانجمنت (إدارة)؟ */
export function isManagerProfile(profile) {
  return !!(profile && profile.role === ROLES.MGMT && profile.active !== false);
}

/** هل الحساب نشط ومتاح؟ */
export function isActiveProfile(profile) {
  return !!(profile && profile.active !== false);
}

/** قائمة فروع اليوزر (فاضية للمانجمنت) */
export function profileBranches(profile) {
  if (!profile) return [];
  if (Array.isArray(profile.branches) && profile.branches.length) return profile.branches.slice();
  return profile.branch ? [profile.branch] : [];
}

/** هل اليوزر مخول بالفرع ده؟ (المانج먼트 = كل الفروع) */
export function canAccessBranch(profile, branchKey) {
  if (!profile || profile.active === false) return false;
  if (isManagerProfile(profile)) return true;
  var mine = profileBranches(profile).map(function (k) { return String(k).toLowerCase(); });
  return mine.indexOf(String(branchKey || '').toLowerCase()) >= 0;
}

/** الفروع المسموح بها للمستخدم (فلترة على مستوى البيانات) */
export function visibleBranches(profile, branches) {
  return (branches || []).filter(function (b) {
    return canAccessBranch(profile, b.key) || canAccessBranch(profile, b.name);
  });
}

/** المطاعم اللي اليوزر يشوفها (المدير العام = الكل، غيره = برانده بس) */
export function visibleRestaurants(profile, restaurants) {
  var list = restaurants || [];
  if (!profile) return [];
  var rid = String(profile.restaurant || '');
  if (!rid) return list;            /* مدير عام → كل البراندات */
  return list.filter(function (r) { return String(r.id) === rid; });
}

/** الإشعارات: فرع/براند محدد يوصل لصاحبه بس */
export function notificationVisible(profile, notif) {
  if (!profile || !notif) return false;
  if (profile.active === false) return false;
  var myRest = String(profile.restaurant || '').toLowerCase();
  var nRest = String(notif.restaurant || '').toLowerCase();
  var myUser = String(profile.username || '').toLowerCase();
  /* لو الإشعار لبراند معيّن → لازم يكون براند اليوزر (ما يشوفش براند تاني) */
  if (nRest && myRest && nRest !== myRest) return false;
  /* لو الإشعار لفرع معيّن → لازم يكون من فروع اليوزر */
  if (notif.branch) {
    if (!isManagerProfile(profile)) {
      var ok = profileBranches(profile).some(function (k) {
        return String(k).toLowerCase() === String(notif.branch).toLowerCase();
      });
      if (!ok) return false;
    }
  }
  /* لو الإشعار مربوط بدور معيّن */
  if (Array.isArray(notif.roles) && notif.roles.length && notif.roles.indexOf(profile.role) < 0) return false;
  /* لو الإشعار مربوط بشخص معيّن */
  if (notif.targetUser && String(notif.targetUser).toLowerCase() !== myUser) return false;
  return true;
}

/** سجلات الإيقاف: اليوزر يشوف فروعه بس */
export function visibleStops(profile, stops) {
  return (stops || []).filter(function (s) {
    return canAccessBranch(profile, s.branch);
  });
}

/** ملخص الدور → شاشة العرض */
export function dashboardViewFor(profile) {
  if (!profile) return 'login';
  if (profile.role === ROLES.MGMT) return 'management';
  if (profile.role === ROLES.BRANCH) return 'branch';
  return 'agent';
}
