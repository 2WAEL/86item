/* ============================================================
 *  services/auth-service.js
 *  ------------------------------------------------------------
 *  كل عمليات Firebase Authentication + بوابة القائمة المعتمدة.
 *  الخدمة دي بترجع بيانات/نتايج فقط — من غير أي لمس للواجهة (DOM).
 * ============================================================ */

import {
  signInWithEmailAndPassword, signOut, onAuthStateChanged,
  updatePassword, sendPasswordResetEmail,
  EmailAuthProvider, reauthenticateWithCredential
} from "https://www.gstatic.com/firebasejs/13.2.0/firebase-auth.js";
import { AUTH_EMAIL_DOMAIN } from './firebase-service.js';

export const AUTH_ERRORS = {
  'auth/invalid-credential': 'اسم المستخدم أو كلمة السر غلط.',
  'auth/user-not-found': 'اسم المستخدم أو كلمة السر غلط.',
  'auth/wrong-password': 'اسم المستخدم أو كلمة السر غلط.',
  'auth/invalid-email': 'الإيميل مش صالح.',
  'auth/email-already-in-use': 'الحساب ده موجود بالفعل.',
  'auth/weak-password': 'كلمة السر ضعيفة — لازم 6 حروف على الأقل.',
  'auth/too-many-requests': 'محاولات كتير في وقت قصير. استنى شوية وجرّب تاني.',
  'auth/network-request-failed': 'تعذر الاتصال بالإنترنت. حاول تاني.',
  'auth/user-disabled': 'الحساب ده موقوف. كلّم مدير النظام.',
  'auth/operation-not-allowed': 'تسجيل الدخول بالإيميل مش مفعّل. من Firebase Console: Authentication ▸ Sign-in method ▸ Email/Password ▸ Enable.',
  'auth/configuration-not-found': 'Firebase Authentication مش مهيّأ في المشروع. فعّل Email/Password من الـ Console.',
  'auth/popup-closed-by-user': 'تم إغلاق النافذة.',
  'auth/captcha-check-failed': 'فشل التحقق. حاول تاني.',
  /* أخطاء Firestore (صلاحيات القواعد) */
  'permission-denied': 'قواعد Firestore بتمنع العملية. انشر القواعد المحدثة: firebase deploy --only firestore:rules (والمجموعة المسموحة لازم فيها allow read, write).',
  'unavailable': 'تعذر الوصول لقاعدة البيانات دلوقتي. اتأكد من الاتصال وحاول تاني.',
  'failed-precondition': 'العملية اترفضت من قاعدة البيانات. حدّث الصفحة وحاول تاني.',
  'unauthenticated': 'انتهت الجلسة. سجّل دخول تاني.'
};

/** رسالة عربية جاهزة لخطأ Firebase Auth */
export function authErrorMessage(e) {
  var code = (e && e.code) ? String(e.code) : '';
  if (AUTH_ERRORS[code]) return AUTH_ERRORS[code];
  var raw = (e && e.message) ? String(e.message) : '';
  if (raw && /[\u0600-\u06FF]/.test(raw)) return raw;
  return 'تعذر تسجيل الدخول. حاول تاني.';
}

/** يحوّل اللي بيكتبه المستخدم لإيميل صالح (اسم بس → دومين المشروع) */
export function authEmail(input, domain) {
  var v = String(input || '').trim().toLowerCase();
  if (!v) return '';
  if (v.indexOf('@') >= 0) return v;
  return v + '@' + (domain || AUTH_EMAIL_DOMAIN);
}

/**
 * خدمة المصادقة.
 * @param auth  Firebase Auth instance
 * @param fs    خدمة Firestore (للبحث عن الملف الشخصي المعتمد)
 */
export function createAuthService(auth, fs) {

  /** خروج من Firebase Auth (أو لقطة من حالة المصادقة) */
  async function signOutSafe() {
    try { await signOut(auth); } catch (e) { /* ignore */ }
  }

  /** خروج كامل: تسجيل العملية في السجل + إنهاء جلسة Firebase Auth */
  async function logout() {
    if (fs && typeof fs.logout === 'function') {
      try { await fs.logout(); } catch (e) { /* ignore */ }
    }
    await signOutSafe();
  }

  /**
   * تسجيل الدخول:
   *  1) signInWithEmailAndPassword فقط (مفيش إنشاء حساب تلقائي خالص)
   *  2) التحقق فورًا: الإيميل لازم يكون في قائمة users ومفعّل
   *  3) لو غير معتمد → signOut + رسالة واضحة
   */
  async function login(username, password) {
    var email = authEmail(username);
    if (!email) throw new Error('اكتب اسم المستخدم وكلمة السر.');
    var cred;
    try {
      cred = await signInWithEmailAndPassword(auth, email, String(password || ''));
    } catch (e) {
      throw new Error(authErrorMessage(e));
    }
    var res = await fs.adoptAuthenticatedUser(cred && cred.user ? cred.user : null, username);
    if (!res || res.blocked) {
      await signOutSafe();
      return {
        ok: false, blocked: true,
        message: (res && res.message) || 'عذراً، هذا البريد غير مسجل أو بانتظار موافقة الإدارة.'
      };
    }
    return res;
  }

  /** استعادة جلسة موجودة (بعد تحديث الصفحة) */
  async function restore() {
    try {
      if (auth && typeof auth.authStateReady === 'function') {
        try { await auth.authStateReady(); } catch (e) { }
      }
      var user = auth && auth.currentUser ? auth.currentUser : null;
      if (!user) return false;
      return await fs.restoreSession(user);
    } catch (e) { return false; }
  }

  /** حالة المصادقة (يتنادى لما تتغير) */
  function onAuthChange(cb) {
    if (!auth) return function () { };
    return onAuthStateChanged(auth, function (user) {
      try { cb(user || null); } catch (e) { }
    });
  }

  /** تغيير باسورد الحساب الحالي */
  async function changeMyPassword(newPass) {
    var user = auth && auth.currentUser;
    if (!user) throw new Error('جلسة غير صالحة. سجّل دخول تاني.');
    if (String(newPass || '').length < 6) throw new Error('كلمة السر لازم 6 حروف/أرقام على الأقل.');
    try {
      await updatePassword(user, String(newPass));
    } catch (e) {
      throw new Error(authErrorMessage(e));
    }
    return { ok: true };
  }

  /** إعادة تأكيد الهوية بكلمة السر (للعمليات الحرجة) */
  async function reauthenticate(password) {
    var user = auth && auth.currentUser;
    if (!user) throw new Error('جلسة غير صالحة. سجّل دخول تاني.');
    if (!String(password || '')) throw new Error('كلمة السر غلط.');
    try {
      var cred = EmailAuthProvider.credential(user.email, String(password));
      await reauthenticateWithCredential(user, cred);
      return true;
    } catch (e) {
      throw new Error('كلمة السر غلط.');
    }
  }

  /**
   * إرسال إيميل "اضبط كلمة السر" (best-effort).
   * بيشتغل بس لو كان حساب Firebase Auth موجود بالفعل.
   */
  async function sendPasswordReset(email) {
    try {
      await sendPasswordResetEmail(auth, String(email || ''));
      return { ok: true };
    } catch (e) {
      return { ok: false, code: (e && e.code) || '' };
    }
  }

  return {
    auth: auth,
    login: login,
    logout: logout,
    restore: restore,
    onAuthChange: onAuthChange,
    changeMyPassword: changeMyPassword,
    reauthenticate: reauthenticate,
    sendPasswordReset: sendPasswordReset,
    emailFor: authEmail
  };
}
