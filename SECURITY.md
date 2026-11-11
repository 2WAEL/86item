# SECURITY — داشبورد الايتمات الموقوفة (Standalone Firebase)

نموذج التهديد (Threat Model) وطرق الحماية المطبّقة في المشروع.

---

## 1) إيه هو «سر» وإيه مش «سر»؟

| البند | سر؟ | ليه |
|---|---|---|
| `apiKey` / `authDomain` / `projectId` / `appId` (إعدادات Firebase Web) | ❌ **مش سر** | مطلوبة في المتصفح لكل تطبيق Firebase Web. بتحدد المشروع بس، ومش بتفوّض أي عملية. الحماية الحقيقية هي **Authentication + Firestore Rules**. |
| كلمات سر المستخدمين | ✅ سر | مخزّنة في **Firebase Authentication** (مش في Firestore ولا في الكود) — والتطبيق مش بيقراها أو يعرضها. |
| Service Account JSON / Private Key / Admin SDK | ✅ **سر خطير** | لو اتسرّب = تحكم كامل في المشروع. **ممنوع** يبقى في الـ frontend. |
| توكنز GitHub / Stripe / Slack / AWS | ✅ سر | ممنوعة في الـ frontend. |

**قاعدة عملية:** أي حاجة لو حد سرقها تقدر تعمل حاجة في الحساب → **ممنوعة نهائيًا** من الـ frontend.
الـ `apiKey` لوحده مايعملش حاجة من غير جلسة Auth صالحة + Rules تسمح.

### فحص آلي
```bash
node scripts/check-no-secrets.mjs
```
بيفحص كل ملفات `public/` و `scripts/` ويطير الـ CI لو لقى مفتاح خاص.
كمان في GitHub Actions: `.github/workflows/security-scan.yml`.

---

## 2) طبقات الحماية المطبّقة

### (أ) Firebase Authentication — **قائمة معتمدين (Allow-list)**
- **مفيش تسجيل ذاتي خالص**: التطبيق مش فيه `createUserWithEmailAndPassword` خالص.
  الحساب الجديد بيتعمل من **⚙️ إدارة المستخدمين** (الأدمن) + حساب Firebase Auth بنفس الإيميل.
- **بوابة الدخول**: فورًا بعد `signInWithEmailAndPassword` بيتشيك على collection `users`:
  - الإيميل **مش موجود** → رفض + `signOut()` + «عذراً، هذا البريد غير مسجل أو بانتظار موافقة الإدارة».
  - الإيميل **موجود بس `active == false`** → رفض + `signOut()` + «حسابك موقوف».
  - الإيميل **موجود ومفعّل** → توجيه للوحة التحكم حسب الدور (`management` / `branch` / `agent`) والفروع.
- دخول بـ **Email + Password** بس · الجلسة في `sessionStorage` · `setPersistence(auth, browserSessionPersistence)`.
- **إعادة تأكيد الهوية** للعمليات الحرجة (مسح كل الداتا / حذف يوزر / حذف فرع / حذف مطعم / تغيير باسورد) عبر `reauthenticateWithCredential` — يعني لازم الباسورد يتأكد حتى لو الجلسة مفتوحة.
- كلمات السر **مش بتتحفظ في Firestore** إطلاقًا — Firestore فيه الملف الشخصي بس (دور/فروع/مطعم/تفعيل).

### (ب) طبقة الخدمات (`public/services/`)
كل اتصال Firebase + منطق الصلاحيات + معالجة Excel في **خدمات مستقلة**:
`firebase-service` (تهيئة) · `auth-service` (المصادقة + البوابة) · `firestore-service` (البيانات) ·
`rbac-service` (الصلاحيات والعزل) · `excel-service` (Excel) · `menu-service` (النيو).
**قيد أساسي: مفيش أي لمس للواجهة (DOM) في أي ملف خدمة** — مفيش `document.getElementById`
ولا `innerHTML` ولا تغيير HTML/CSS. الخدمة بترجع بيانات/وعود بس.
الواجهة (`index.html`) مسؤولة عن الرسم + Event Listeners + استدعاء الخدمات.

### (ج) Firestore Security Rules (`firestore.rules`)
الكل محسوب بالـ Rules (مش بس في الـ UI):

| القاعدة | الفايدة |
|---|---|
| `request.auth != null` على كل وصول | مفيش قراءة/كتابة لحد مش مسجّل دخول. |
| `active == true` شرط أساسي | لو الأدمن وقّف الحساب → يختفي كل وصوله فورًا. |
| فصل الأدوار | `management` (إدارة) / `branch` (فرعه بس) / `agent` (قراءة بس). |
| عزل الفروع | الديسباتشر يقرأ ويكتب فروعه (`branches[]`) بس — مش كل الفروع. |
| `audit_logs` / `error_log` | **العرض للأدمن بس** (الكتابة مفتوحة عشان التطبيق يسجّل). |
| `users` — إنشاء | حساب جديد لنفسه: `role=agent` + `active=false` + `isAdmin=false` → **ممنوع** أي حد يصعّد صلاحياته بنفسه. |
| `users` — تعديل | المانجمنت يعدّل غيره بس **من غير** إنه يدي `isAdmin`، وممنوع يصعّد نفسه. |
| `system/adminLock` | أول حساب في النظام بس ياخد رتبة «مدير النظام» — قفل بيتبنى مرة واحدة. |
| `match /{document=**} { allow read, write: if false; }` | **deny-by-default** — أي collection جديدة ممنوعة لحد ما تتفتح صراحةً. |

### (ج) حارس الجلسة في الواجهة (`index.html`)
- عند تحميل الصفحة: `FB.restore()` بيتأكد إن فيه جلسة Auth **و** ملف شخصي نشط، غير كده → رجوع فوري لشاشة الدخول.
- **كل 60 ثانية**: إعادة تحقق (`checkSession`) — لو الحساب اتوقّف من جهاز تاني، المستخدم يخرج فورًا.
- **رجوع التبويب للواجهة**: نفس التحقق (`visibilitychange`).
- `onAuthStateChanged`: لو الجلسة قفلت (تسجيل خروج من جهاز تاني) → رجوع لشاشة الدخول.
- عناصر الإدارة (⚙️) بتظهر حسب الدور، بس الحماية الحقيقية في الـ Rules.

### (د) منع الحقن (Input Sanitization)
- **الخادم**: تنظيف كل المدخلات (`norm`): حذف محارف التحكم والـ bidi، قصّ الطول، وإزالة `= + - @` في بداية النص (منع صيغ Excel).
- **تحقق صارم**: الإيميل لازم شكله صحيح (`name@example.com`)، اسم المستخدم حروف/أرقام إنجليزي (2–30)، الدور من قائمة محددة (whitelist)، الفرع لازم موجود فعلاً، والأرقام في المدى المسموح.
- **الواجهة**: كل القيم بتترندر بـ `esc()` (HTML escaping)، والتحقق بيتكرر في المتصفح قبل الإرسال وفي السيرفر بعده.
- **Excel**: `xlsxSafe()` بيمنع حقن الصيغ في ملفات التصدير (أي نص يبدأ بـ `= + - @` بيتحوّل لنص).

### (ه) App Check (اختياري — strongly recommended)
طبقة إضافية بتمنع أي عميل مش متصفح من استخدام المشروع حتى لو الـ API Key اتسرّب.
```js
// public/index.html
const APP_CHECK_SITE_KEY = '';   // ← مفتاح reCAPTCHA v3 من Console
```
بعد ما تحط المفتاح وتعمل Deploy، أي طلب من خارج المتصفح هيت rejecting.

---

## 3) إيه اللي **لسه** محتاج انتباه

| البند | التوصية |
|---|---|
| صلاحيات الـ Rules على Collections | راجعها قبل كل deploy جديد (أي collection جديدة محتاجة سطر صريح). |
| Firebase Console → Authentication | فعّل **Email/Password**، وخلي **Anonymous sign-in مقفول** (التطبيق مش بيحتاجه). |
| Firestore Rules | انشرها: `firebase deploy --only firestore:rules` |
| مستخدمين المنشور | راجع قائمة المستخدمين بانتظام، ووقّف اللي مش محتاجين (إيقاف = سحب كل وصوله فورًا). |
| App Check | فعّله — ده closes ثغرة "API Key مفتوح" بشكل كامل. |

---

## 4) تشغيل الفحوصات

```bash
node scripts/check-no-secrets.mjs    # فحص الأسرار في كود الواجهة
```

الأمر بيشتغل كمان تلقائي مع كل push على GitHub (workflow: Security Scan).

### اختبار القواعد (اختياري — محتاج Emulator)

```bash
firebase emulators:start --only firestore --project demo-test
node scripts/test-rules.mjs          # 31 حالة: تسجيل ذاتي، تصعيد صلاحيات، عزل فروع/براندات، deny-by-default
```

الاختبار بيتحقق من:
- زائر بدون تسجيل → كل وصول مرفوض.
- مستخدم مش في القائمة المعتمدة → كل وصول مرفوض.
- حساب موقوف → كل وصول مرفوض (غير ملفه الشخصي).
- ديسباتشر → فرعه بس (فروع/منيو/سجلات إيقاف) + سجلات الأخطاء/العمليات مرفوضة.
- **منع التسجيل الذاتي** + **منع تصعيد الصلاحيات** (نفسه لـ admin).
- الأدمن يشوف كل حاجة، والمانجمنت (مش مدير) **مش** يقدر يدي `isAdmin`.
- أي collection جديدة → مرفوضة (deny-by-default).
