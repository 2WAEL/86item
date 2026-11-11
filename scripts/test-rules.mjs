#!/usr/bin/env node
/**
 * اختبار قواعد Firestore المحصّنة (يشتغل على الـ Firestore Emulator)
 * ---------------------------------------------------------------
 * التشغيل:
 *   1) شغّل الـ emulator:
 *        firebase emulators:start --only firestore --project demo-test
 *   2) شغّل الاختبار:
 *        node scripts/test-rules.mjs
 *
 * التغطية: منع الوصول غير المصرّح، منع التسجيل الذاتي بدون اعتماد،
 * منع تصعيد الصلاحيات، عزل الفروع/البراندات، وصلاحيات config/roles.
 */

import { readFileSync } from 'node:fs';

const HOST = 'http://127.0.0.1:8080';
const PROJECT = 'demo-test';
const BASE = `${HOST}/v1/projects/${PROJECT}/databases/(default)/documents`;

async function req(method, path, { body, tok } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (tok) headers.Authorization = `Bearer ${tok}`;
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let data = null;
  try { data = await res.json(); } catch { }
  return { status: res.status, data };
}

/** توكن مزيف (JWT غير موقّع) — الـ emulator بيقرا الـ claims منه */
function token(uid, email, extra = {}) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64({
    sub: uid, user_id: uid, email, email_verified: true, ...extra
  })}.`;
}

function encodeValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return { integerValue: String(v) };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(encodeValue) } };
  if (typeof v === 'object') return { mapValue: { fields: encodeFields(v) } };
  return { stringValue: String(v) };
}
function encodeFields(obj) {
  const f = {};
  for (const k of Object.keys(obj || {})) f[k] = encodeValue(obj[k]);
  return f;
}

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = got === want;
  if (ok) { pass++; console.log(`  ✓ ${name} → ${got}`); }
  else { fail++; console.error(`  ✗ ${name} → متوقع ${want} واللي حصل ${got}`); }
}

const OWNER = 'owner';
const admin = token('uid-admin', 'admin@example.com');
const manager = token('uid-manager', 'manager@example.com');
const branchUser = token('uid-branch', 'branch@example.com');
const stranger = token('uid-stranger', 'stranger@example.com');
const inactive = token('uid-inactive', 'inactive@example.com');

async function seed() {
  const docs = [
    ['users', 'admin@example.com', { username: 'admin', email: 'admin@example.com', role: 'management', branch: '', branches: [], restaurant: 'MAIN', isAdmin: true, active: true, ver: 'v1' }],
    ['users', 'manager@example.com', { username: 'manager', email: 'manager@example.com', role: 'management', branch: '', branches: [], restaurant: 'MAIN', isAdmin: false, active: true, ver: 'v1' }],
    ['users', 'branch@example.com', { username: 'branch', email: 'branch@example.com', role: 'branch', branch: 'dokki', branches: ['dokki'], restaurant: 'MAIN', isAdmin: false, active: true, ver: 'v1' }],
    ['users', 'inactive@example.com', { username: 'inactive', email: 'inactive@example.com', role: 'branch', branch: 'dokki', branches: ['dokki'], restaurant: 'MAIN', isAdmin: false, active: false, ver: 'v1' }],
    ['branches', 'dokki', { key: 'dokki', name: 'DOKKI', restaurant: 'MAIN', active: true }],
    ['branches', 'zamalek', { key: 'zamalek', name: 'ZAMALEK', restaurant: 'MAIN', active: true }],
    ['branches', 'other', { key: 'other', name: 'OTHER', restaurant: 'R2', active: true }],
    ['menu_items', 'shared', { restaurant: 'MAIN', branch: '', item: 'برجر', active: true }],
    ['menu_items', 'm-dokki', { restaurant: 'MAIN', branch: 'dokki', item: 'كابتشينو', active: true }],
    ['menu_items', 'm-zamalek', { restaurant: 'MAIN', branch: 'zamalek', item: 'موكا', active: true }],
    ['audit_logs', 'a1', { at: 'now', action: 'X', result: 'OK' }],
    ['error_log', 'e1', { at: 'now', message: 'boom' }],
    ['notifications', 'n1', { at: 'now', restaurant: 'MAIN', branch: 'dokki', title: 'hi' }],
    ['config', 'roles', {
      roles: [
        { key: 'management', label: 'مانجمنت', scope: 'all', grantAdmin: true, notify: true, actions: [], aliases: [] },
        { key: 'branch', label: 'ديسباتشر فرع', scope: 'branch', grantAdmin: false, notify: true, actions: ['logStop', 'resumeStop'], aliases: ['dispatcher'] },
        { key: 'agent', label: 'ايجينت', scope: 'branch', grantAdmin: false, notify: false, actions: [], aliases: [] }
      ],
      aliases: { dispatcher: 'branch' }
    }]
  ];
  for (const [col, id, data] of docs) {
    await req('PATCH', `/${col}/${encodeURIComponent(id)}`, { body: { fields: encodeFields(data) }, tok: OWNER });
  }
}

async function run() {
  console.log('— تهيئة بيانات الاختبار —');
  await seed();

  console.log('\n— 1) زائر بدون تسجيل دخول —');
  check('قراءة users', (await req('GET', '/users/admin@example.com')).status, 403);
  check('كتابة users', (await req('POST', '/users', { body: { fields: {} } })).status, 403);
  check('قراءة branches', (await req('GET', '/branches/dokki')).status, 403);

  console.log('\n— 2) مستخدم مش مسجّل في القائمة المعتمدة —');
  check('قراءة branches', (await req('GET', '/branches/dokki', { tok: stranger })).status, 403);
  check('قراءة menu_items', (await req('GET', '/menu_items/m-dokki', { tok: stranger })).status, 403);
  check('كتابة item_stoppages', (await req('POST', '/item_stoppages', { body: { fields: encodeFields({ branch: 'dokki' }) }, tok: stranger })).status, 403);
  check('قراءة audit_logs', (await req('GET', '/audit_logs/a1', { tok: stranger })).status, 403);

  console.log('\n— 3) حساب مسجّل بس موقوف —');
  check('قراءة branches', (await req('GET', '/branches/dokki', { tok: inactive })).status, 403);
  check('قراءة ملفه الشخصي (مسموح)', (await req('GET', '/users/inactive@example.com', { tok: inactive })).status, 200);

  console.log('\n— 4) ديسباتشر فرع (dokki) — العزل —');
  check('قراءة فرعه', (await req('GET', '/branches/dokki', { tok: branchUser })).status, 200);
  check('قراءة فرع تاني', (await req('GET', '/branches/zamalek', { tok: branchUser })).status, 403);
  check('قراءة صنف مشترك', (await req('GET', '/menu_items/shared', { tok: branchUser })).status, 200);
  check('قراءة صنف فرعه', (await req('GET', '/menu_items/m-dokki', { tok: branchUser })).status, 200);
  check('قراءة صنف فرع تاني', (await req('GET', '/menu_items/m-zamalek', { tok: branchUser })).status, 403);
  check('تسجيل إيقاف في فرعه', (await req('POST', '/item_stoppages', { body: { fields: encodeFields({ branch: 'dokki' }) }, tok: branchUser })).status, 200);
  check('تسجيل إيقاف في فرع تاني', (await req('POST', '/item_stoppages', { body: { fields: encodeFields({ branch: 'zamalek' }) }, tok: branchUser })).status, 403);
  check('قراءة audit_logs', (await req('GET', '/audit_logs/a1', { tok: branchUser })).status, 403);
  check('قراءة error_log', (await req('GET', '/error_log/e1', { tok: branchUser })).status, 403);
  check('قراءة ملفه الشخصي', (await req('GET', '/users/branch@example.com', { tok: branchUser })).status, 200);
  check('قراءة ملف مستخدم تاني', (await req('GET', '/users/admin@example.com', { tok: branchUser })).status, 403);

  console.log('\n— 5) التسجيل الذاتي: مسموح بس موقوف + أقل صلاحية —');
  let sc = 0;
  const selfCreate = (over) => {
    const email = 'self' + (++sc) + '@example.com';
    const tok = token('uid-' + email, email);   /* كل حالة بإيميل مختلف = مستند جديد */
    return req('PATCH', '/users/' + encodeURIComponent(email), {
      body: {
        fields: encodeFields({
          username: 'self', email,
          role: 'agent', branches: [], branch: '', isAdmin: false, active: false, ...over
        })
      }, tok
    });
  };
  check('إنشاء ملفه موقوف (active=false)', (await selfCreate({})).status, 200);
  check('إنشاء ملفه مفعّل (active=true)', (await selfCreate({ active: true })).status, 403);
  check('إنشاء ملفه بصلاحية admin', (await selfCreate({ isAdmin: true })).status, 403);
  check('إنشاء ملفه بدور management', (await selfCreate({ role: 'management' })).status, 403);
  check('إنشاء ملفه بفروع', (await selfCreate({ branches: ['dokki'] })).status, 403);
  check('إنشاء ملف حد تاني', (await req('POST', '/users', {
    body: { fields: encodeFields({ username: 'x', email: 'x@example.com', role: 'agent', branches: [], isAdmin: false, active: false }) }, tok: stranger
  })).status, 403);

  console.log('\n— 6) الأدمن —');
  check('قراءة audit_logs', (await req('GET', '/audit_logs/a1', { tok: admin })).status, 200);
  check('قراءة error_log', (await req('GET', '/error_log/e1', { tok: admin })).status, 200);
  check('قراءة كل المستخدمين', (await req('GET', '/users/branch@example.com', { tok: admin })).status, 200);
  check('إنشاء حساب لغيره', (await req('POST', '/users', {
    body: { fields: encodeFields({ username: 'new1', email: 'new1@example.com', role: 'branch', branch: 'dokki', branches: ['dokki'], isAdmin: false, active: true }) }, tok: admin
  })).status, 200);
  check('اعتماد حساب موقوف (active=true)', (await req('PATCH', '/users/inactive@example.com', {
    body: { fields: encodeFields({ active: true }) }, tok: admin
  })).status, 200);

  console.log('\n— 7) مانجمنت (مش مدير نظام) —');
  check('إنشاء حساب لغيره (من غير isAdmin)', (await req('POST', '/users', {
    body: { fields: encodeFields({ username: 'new2', email: 'new2@example.com', role: 'branch', branch: 'dokki', branches: ['dokki'], isAdmin: false, active: true }) }, tok: manager
  })).status, 200);
  check('إنشاء حساب بـ isAdmin', (await req('POST', '/users', {
    body: { fields: encodeFields({ username: 'new3', email: 'new3@example.com', role: 'management', isAdmin: true, active: true }) }, tok: manager
  })).status, 403);
  check('قراءة audit_logs', (await req('GET', '/audit_logs/a1', { tok: manager })).status, 403);

  console.log('\n— 8) إعدادات الأدوار (config/roles) —');
  check('المانجمنت يقرأ الإعدادات', (await req('GET', '/config/roles', { tok: manager })).status, 200);
  check('الأدمن يقرأ الإعدادات', (await req('GET', '/config/roles', { tok: admin })).status, 200);
  check('الديسباتشر يقرأ الإعدادات', (await req('GET', '/config/roles', { tok: branchUser })).status, 403);
  check('الأدمن يعدّل الإعدادات', (await req('PATCH', '/config/roles', {
    body: { fields: encodeFields({ roles: [] }) }, tok: admin
  })).status, 200);
  check('المانجمنت العادي يعدّل الإعدادات', (await req('PATCH', '/config/roles', {
    body: { fields: encodeFields({ roles: [] }) }, tok: manager
  })).status, 403);

  console.log('\n— 9) collection جديدة غير مسموحة (deny-by-default) —');
  check('قراءة collection عشوائي', (await req('GET', '/some_new_collection/x', { tok: admin })).status, 403);
  check('كتابة collection عشوائي', (await req('POST', '/some_new_collection', { body: { fields: {} }, tok: admin })).status, 403);

  console.log(`\n${pass} نجح · ${fail} فشل`);
  if (fail) {
    console.error('\n✗ في اختبارات فشلت — راجع firestore.rules');
    process.exit(1);
  }
  console.log('✓ كل اختبارات القواعد نجحت');
}

run().catch((e) => { console.error(e); process.exit(1); });
