/* ============================================================
 *  services/menu-service.js
 *  ------------------------------------------------------------
 *  منطق المنيو: قراءة ملف Excel/CSV → تطبيع البيانات → نشرها في Firestore.
 *  الخدمة بترجع نتايج فقط — من غير أي لمس للواجهة (DOM).
 * ============================================================ */

import { parseSpreadsheet } from './excel-service.js';

/* أسماء الأعمدة المقبولة (عربي/إنجليزي) */
const HEADER_MAP = {
  item: ['item', 'items', 'item name', 'itemname', 'name', 'الايتم', 'الآيتم', 'الصنف', 'اسم الصنف', 'المنيو'],
  category: ['category', 'cat', 'section', 'التصنيف', 'القسم', 'النوع'],
  price: ['price', 'cost', 'amount', 'السعر', 'السعر(ج.م)', 'السعر (ج.م)', 'السعر(£)', 'price '],
  available: ['available', 'active', 'enabled', 'on', 'yes', 'no', 'متاح', 'متاح؟', 'مفعّل', 'معتمد']
};

/** يطابق عنوان العمود مع اسم الحقل المعروف */
function matchHeader(header) {
  var h = String(header || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!h) return '';
  for (var key in HEADER_MAP) {
    var list = HEADER_MAP[key];
    for (var i = 0; i < list.length; i++) {
      var l = list[i].toLowerCase();
      if (h === l || h.indexOf(l) === 0 || h.indexOf(l) >= 0) return key;
    }
  }
  return '';
}

function truthy_(v) {
  var s = String(v == null ? '' : v).trim().toLowerCase();
  if (!s) return true;                 /* فاضي = متاح (الافتراضي) */
  /* القيم اللي معناها "غير متاح" */
  var neg = ['0', 'false', 'no', 'n', 'off', 'لا', 'لأ', 'م', 'غير', 'غير متاح', 'موقوف', 'مغلوب'];
  for (var i = 0; i < neg.length; i++) {
    if (s === neg[i] || s.indexOf(neg[i]) === 0) return false;
  }
  return true;
}

/**
 * يحوّل صفوف الملف إلى أصناف منيو منظّمة.
 * @returns {items, columns, skipped}
 */
export function rowsToMenuItems(headers, rows) {
  var map = {}, used = {};
  (headers || []).forEach(function (h, idx) {
    var key = matchHeader(h);
    if (key && !used[key]) { map[key] = idx; used[key] = 1; }
  });
  if (map.item === undefined) {
    throw new Error('الملف مفيهوش عمود اسم الصنف. لازم يكون فيه عمود باسم "الصنف" أو "Item".');
  }
  var items = [], skipped = 0;
  (rows || []).forEach(function (r) {
    var name = String(r[map.item] == null ? '' : r[map.item]).trim();
    if (!name) { skipped++; return; }
    var cat = map.category !== undefined ? String(r[map.category] == null ? '' : r[map.category]).trim() : '';
    var priceRaw = map.price !== undefined ? r[map.price] : null;
    var price = null;
    if (priceRaw !== null && priceRaw !== undefined && String(priceRaw).trim() !== '') {
      var n = Number(String(priceRaw).replace(/[^\d.\-]/g, ''));
      if (isFinite(n) && n >= 0) price = n;
    }
    var avail = map.available !== undefined ? truthy_(r[map.available]) : true;
    items.push({ item: name, category: cat, price: price, available: avail });
  });
  return { items: items, columns: map, skipped: skipped };
}

/**
 * خدمة المنيو.
 * @param fs  خدمة Firestore (عشان الكتابة + الصلاحيات)
 */
export function createMenuService(fs, db) {

  /**
   * استيراد منيو من ملف:
   * @param file        File من <input type="file">
   * @param restaurant brandId
   * @param branchKeys branchId[] (فرع واحد أو كل الفروع)
   * @returns ملخص + البيانات المنشورة
   */
  async function importFromFile(file, restaurant, branchKeys) {
    if (!file) throw new Error('اختار ملف Excel الأول.');
    if (!restaurant) throw new Error('اختار المطعم (البراند) الأول.');
    if (!branchKeys || !branchKeys.length) throw new Error('اختار فرع واحد على الأقل.');

    var parsed = await parseSpreadsheet(file);
    var mapped = rowsToMenuItems(parsed.headers, parsed.rows);
    if (!mapped.items.length) throw new Error('مفيش أصناف صالحة في الملف.');

    /* الكتابة عن طريق خدمة Firestore (الصلاحيات والجلسة بيتحققوا جواها) */
    var res = await fs.importMenuItems(restaurant, branchKeys, mapped.items);
    return {
      ok: true,
      file: file.name,
      sheet: parsed.sheet,
      total: mapped.items.length,
      skipped: mapped.skipped,
      branches: res.branches,
      written: res.written,
      data: res.data
    };
  }

  return {
    importFromFile: importFromFile,
    rowsToMenuItems: rowsToMenuItems
  };
}
