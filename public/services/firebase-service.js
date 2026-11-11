/* ============================================================
 *  services/firebase-service.js
 *  ------------------------------------------------------------
 *  تهيئة Firebase (App + Auth + Firestore) في مكان واحد.
 *  الخدمة دي مسؤولة عن الاتصال فقط — من غير أي لمس للواجهة (DOM).
 * ============================================================ */

import { initializeApp } from "https://www.gstatic.com/firebasejs/13.2.0/firebase-app.js";
import { getAnalytics } from "https://www.gstatic.com/firebasejs/13.2.0/firebase-analytics.js";
import { getFirestore, connectFirestoreEmulator } from "https://www.gstatic.com/firebasejs/13.2.0/firebase-firestore.js";
import { getAuth, setPersistence, browserSessionPersistence, connectAuthEmulator } from "https://www.gstatic.com/firebasejs/13.2.0/firebase-auth.js";

/* إعدادات Firebase Web — عامة بالتصميم (مش سر):
   الحماية الحقيقية هي Firebase Authentication + Firestore Rules. */
export const firebaseConfig = {
  apiKey: "AIzaSyD1MFyE26r5GhQANTsTSpAdwsAiGC4zShs",
  authDomain: "item-f8564.firebaseapp.com",
  projectId: "item-f8564",
  storageBucket: "item-f8564.firebasestorage.app",
  messagingSenderId: "573297826644",
  appId: "1:573297826644:web:452247eda62f7c66e986c1",
  measurementId: "G-Q87D509P3Z"
};

/* نطاق البريد لو المستخدم كتب الاسم بس بدل الإيميل */
export const AUTH_EMAIL_DOMAIN = 'item-f8564.firebaseapp.com';

export const app = initializeApp(firebaseConfig);
try { getAnalytics(app); } catch (e) { /* Analytics اختياري */ }

export const db = getFirestore(app);
export const auth = getAuth(app);

/* ============================================================
 *  وضع التطوير (اختياري): ?emulator=1 في العنوان
 *  ------------------------------------------------------------
 *  يوصّل التطبيق بـ Firebase Emulator (محلي) بدل الإنتاج.
 *  بيشتغل بس لما تفتح الرابط بـ ?emulator=1 — في الإنتاج مفيش أي تأثير.
 * ============================================================ */
export const EMULATOR_MODE = (function () {
  try {
    var m = /[?&]emulator=([a-z]+)/.exec(location.search || '');
    return m ? m[1].toLowerCase() : '';
  } catch (e) { return ''; }
})();
if (EMULATOR_MODE === 'all' || EMULATOR_MODE === 'firestore') {
  try { connectFirestoreEmulator(db, '127.0.0.1', 8080); } catch (e) { }
}
if (EMULATOR_MODE === 'all' || EMULATOR_MODE === 'auth') {
  try { connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true }); } catch (e) { }
}
if (EMULATOR_MODE) {
  console.info('[emulator] متصل بـ:', EMULATOR_MODE);
}

/* الجلسة بتخزن في sessionStorage (بتنتهي لما يقفل التبويب) */
try { setPersistence(auth, browserSessionPersistence); } catch (e) { }

/* ============================================================
 *  App Check (اختياري) — بيمنع أي عميل مش متصفح من استخدام المشروع
 *  حتى لو الـ API Key اتسرّب. فعّله من Console وضع المفتاح هنا.
 *  سيبه فاضي = التطبيق بيشتغل عادي.
 * ============================================================ */
export const APP_CHECK_SITE_KEY = '';   // ← مفتاح reCAPTCHA v3 (اختياري)

if (APP_CHECK_SITE_KEY) {
  import('https://www.gstatic.com/firebasejs/13.2.0/firebase-app-check.js')
    .then(function (m) {
      return m.initializeAppCheck(app, {
        provider: new m.ReCaptchaV3Provider(APP_CHECK_SITE_KEY),
        isTokenAutoRefreshEnabled: true
      });
    })
    .catch(function (e) { console.warn('[AppCheck] تعذر التفعيل:', e && e.message); });
}
