# داشبورد الايتمات الموقوفة — التشغيل على Firebase Hosting + Google Apps Script

التطبيق بقى **مش محتاج** `google.script.run` (اللي مش شغال بره بيئة Apps Script).
كل الطلبات بقت تروح بـ **fetch()** على رابط الـ **Web App** بتاع Google Apps Script.

```
┌──────────────────────────┐        fetch() POST (JSON)        ┌───────────────────────────┐
│  Firebase Hosting         │  ──────────────────────────────▶ │  Google Apps Script       │
│  public/index.html        │ ◀────────────────────────────── │  Web App (doPost)        │
│  (الواجهة الثابتة)       │        رد JSON                  │  Code.gs (next.js)        │
└──────────────────────────┘                                  └───────────────────────────┘
                                                                     │
                                                                     ▼
                                                            Google Sheets (الداتا)
```

---

## 1) تنشر الـ Web App (مرة واحدة)

من **Google Apps Script** (مشروع السكربت اللي فيه `next.js`):

1. **Deploy ▸ New deployment ▸ Web app**
2. الإعدادات:

| الحقل | القيمة |
|---|---|
| Execute as | **Me (أنت)** |
| Who has access | **Anyone** ← مهم جدًا |

3. اضغط **Deploy** واختار نسخة جديدة لو طلب منك (Version: New version).
4. انسخ رابط الـ Web App — شكله كده:

```
https://script.google.com/macros/s/AKfycbXXXXXXXXXXXXXXXXXXXX/exec
```

> ⚠️ **ليه "Anyone"؟** لو الخيار ده "Anyone with Google account" أو "Only myself"，
> المتصفح هيرجّع صفحة تسجيل دخول Google بدل JSON، والتطبيق هيقول:
> «رابط الـ Web App بيطلب تسجيل دخول Google».

---

## 2) تحط الرابط في الواجهة

افتح `public/index.html` وابحث عن:

```js
var GAS_WEB_APP_URL = '';   /* ← الصق هنا رابط الـ Web App */
```

الصق الرابط فيها:

```js
var GAS_WEB_APP_URL = 'https://script.google.com/macros/s/AKfycbXXXX/exec';
```

### (اختياري) تغيير الرابط من غير إعادة نشر

الرابط بيتحدد بالترتيب ده:

1. `?api=<url>` في عنوان الصفحة — للتجربة السريعة:
   ```
   https://<your-site>.web.app/index.html?api=https://script.google.com/macros/s/XXXX/exec
   ```
2. `localStorage['gas_api_url']` — من الكونسول:
   ```js
   gasSetApiUrl('https://script.google.com/macros/s/XXXX/exec');
   ```
3. `GAS_WEB_APP_URL` في الملف (الافتراضي الثابت).

---

## 3) ترفع ملفات الـ Apps Script

| الملف المحلي | اسم الملف في Apps Script | النوع |
|---|---|---|
| `public/next.js` | `Code.gs` | السيرفر (فيه `doPost` الجديد) |
| `public/index.html` | `Index` | الواجهة (لو هتفتحها من Apps Script مباشرة) |

> `doGet` لسه شغال زي ما هو، فالتطبيق يقدر يشتغل بالطريقتين:
> **من Apps Script** (HtmlService) أو **من Firebase Hosting** (fetch).

---

## 4) ترفع على Firebase Hosting

```bash
cd "C:\Users\Cairo\Desktop\86item"
firebase login
firebase deploy --only hosting
```

الملفات المنشورة: `public/index.html` و `public/next.js` (و `firebase.json` فيه إعادة توجيه
`** → /index.html`).

---

## 5) بروتوكول الاتصال (للمرجعية)

**الطلب** (POST على رابط الـ Web App):

```json
{ "action": "login", "args": ["admin", "secret"], "token": "" }
```

- `action`: اسم العملية (`login` / `logout` / `getDashboardData` / `pollState` / …)
- `args`: مصفوفة المعاملات
- `token`: توكن الجلسة (فاضي في حالة الدخول)

**الرد الناجح**:

```json
{ "ok": true, "result": { "token": "…", "data": { … } } }
```

**الرد بالخطأ**:

```json
{ "ok": false, "error": { "code": "SESSION_EXPIRED", "action": "api", "message": "…", "detail": "", "stack": "" } }
```

> الـ `body` بينزل كـ `text/plain` (مش `application/json`) عشان المتصفح يعمل
> **simple request** من غير preflight — ده المتوافق مع Apps Script.

---

## 6) مشاكل شائعة

| العَرَض | السبب | الحل |
|---|---|---|
| `google is not defined` | نسخة قديمة من الواجهة | تأكد إن الملف المنشور هو `public/index.html` الجديد (فيه `gasPost`)، وأعمل Deploy تاني. |
| «لم يتم ضبط رابط الـ Web App…» | `GAS_WEB_APP_URL` فاضي | الصق الرابط (أو استخدم `?api=` / `gasSetApiUrl`). |
| «رابط الـ Web App بيطلب تسجيل دخول Google» | صلاحية النشر مش "Anyone" | Deploy ▸ Edit ▸ Who has access ▸ Anyone. |
| «رد غير متوقع من السيرفر» | الرابط مش رابط Web App، أو فيه خطأ في `doPost` | اتأكد إن `next.js` اتحدّث في Apps Script وإنه اتنشر (New version). |
| `No such deployment` | النسخة اتشالت | انشر نسخة جديدة وخد الرابط الجديد. |
| الأيقونة/الخط مش ظاهرين | انقطاع في{CDN} | مش له علاقة بالـ backend. |

---

## 7) ملاحظات

- **الاستطلاع لسه شغال** زي ما هو: `pollState` كل 4 ثواني + تحديث كامل كل 60 ثانية.
  بس الطلب بقى HTTP عادي بدل `google.script.run`، وهو نفس العدد تقريبًا.
- **منع تراكم الطلبات**: لو طلب الاستطلاع لسه شغال، مش بيتبعت تاني.
- **انتهاء الجلسة**: السيرفر بيرجّع `code: SESSION_EXPIRED` → الواجهة بترجّعك لشاشة الدخول
  وبتمسح التوكن من `sessionStorage` (زي behavior النسخة القديمة).
- **كل الأخطاء** بتفضل تتسجّل في `ERROR_LOG` زي الأول، والأكواد المرجعية زي ما هي.
