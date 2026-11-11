/* ============================================================
 *  services/excel-service.js
 *  ------------------------------------------------------------
 *  كل منطق ملفات Excel (بناء + قراءة) في خدمة واحدة.
 *  الخدمة بترجع **بيانات/Bytes** فقط — من غير أي لمس للواجهة (DOM).
 *  مفيش أي مكتبة خارجية: كاتب ZIP/XLSX وقرّاء XLSX/CSV مكتوبين يدويًا.
 * ============================================================ */

/* ============================================================
 *  1) كاتب XLSX (تصدير)
 * ============================================================ */

var CRC_T = null;
function crcTable_() {
  if (CRC_T) return CRC_T;
  CRC_T = new Uint32Array(256);
  for (var n = 0; n < 256; n++) {
    var c = n;
    for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    CRC_T[n] = c >>> 0;
  }
  return CRC_T;
}
function crc32_(buf) {
  var t = crcTable_(), c = 0xFFFFFFFF;
  for (var i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function zipStore_(files) {
  var enc = new TextEncoder(), parts = [], central = [];
  function u16(n) { return [n & 255, (n >>> 8) & 255]; }
  function u32(n) { return [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]; }
  var DOS_DATE = 20513;   /* 2020-01-01 */
  var offset = 0;
  files.forEach(function (f) {
    var name = enc.encode(f.name), data = f.data, crc = crc32_(data);
    /* Local file header + البيانات */
    var local = new Uint8Array([].concat(
      [0x50, 0x4B, 0x03, 0x04], u16(20), u16(0), u16(0), u16(0), u16(DOS_DATE),
      u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0),
      Array.from(name), Array.from(data)
    ));
    parts.push(local);
    /* Central directory header (لازم يبقى bytes صافية — مش أرقام مختلطة) */
    central.push(new Uint8Array([].concat(
      [0x50, 0x4B, 0x01, 0x02], u16(20), u16(20), u16(0), u16(0), u16(0), u16(DOS_DATE),
      u32(crc), u32(data.length), u32(data.length), u16(name.length),
      u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset),
      Array.from(name)
    )));
    offset += local.length;
  });
  var cdSize = central.reduce(function (s, a) { return s + a.length; }, 0);
  var end = new Uint8Array([].concat(
    [0x50, 0x4B, 0x05, 0x06], u16(0), u16(0), u16(files.length), u16(files.length),
    u32(cdSize), u32(offset), u16(0)
  ));
  var all = parts.concat(central, [end]);
  var total = all.reduce(function (s, a) { return s + a.length; }, 0);
  var out = new Uint8Array(total), pos = 0;
  all.forEach(function (a) { out.set(a, pos); pos += a.length; });
  return new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

export function xmlEsc_(s) {
  return String(s == null ? '' : s).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
    .replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]; });
}
export function colLetter_(n) {
  var s = ''; n++;
  while (n > 0) { var m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}
/** حماية من حقن الصيغ في Excel: أي نص بيبدأ بـ = + - @ بيتحوّل لنص عادي */
export function xlsxSafe_(v) {
  var s = String(v == null ? '' : v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return s;
}
export function sheetName_(s) {
  var n = String(s || 'Sheet').replace(/[\[\]\*\?\/\\:]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 31);
  return n || 'Sheet';
}
export function xlsxSheetXml_(rows) {
  var maxc = 0;
  rows.forEach(function (r) { if (r.length > maxc) maxc = r.length; });
  var widths = [];
  for (var c = 0; c < maxc; c++) {
    var w = 8;
    rows.slice(0, 120).forEach(function (r) { var v = r[c]; if (v == null) return; var len = String(v).length; if (len > w) w = len; });
    widths.push(Math.min(45, Math.max(10, w + 2)));
  }
  var cols = '';
  for (var c2 = 0; c2 < widths.length; c2++) cols += '<col min="' + (c2 + 1) + '" max="' + (c2 + 1) + '" width="' + widths[c2] + '" customWidth="1"/>';
  var out = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + '<sheetViews><sheetView rightToLeft="1" workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
    + (cols ? '<cols>' + cols + '</cols>' : '')
    + '<sheetData>';
  rows.forEach(function (r, ri) {
    out += '<row r="' + (ri + 1) + '">';
    for (var ci = 0; ci < r.length; ci++) {
      var v = r[ci];
      if (v === null || v === undefined || v === '') continue;
      var ref = colLetter_(ci) + (ri + 1), st = ri === 0 ? ' s="1"' : '';
      if (typeof v === 'number' && isFinite(v)) out += '<c r="' + ref + '"' + st + '><v>' + v + '</v></c>';
      else out += '<c r="' + ref + '"' + st + ' t="inlineStr"><is><t xml:space="preserve">' + xmlEsc_(xlsxSafe_(v)) + '</t></is></c>';
    }
    out += '</row>';
  });
  return out + '</sheetData></worksheet>';
}

/** يبني ملف .xlsx من مصفوفة sheets: [{name, rows:[[...],[...]]}] */
export function buildXlsxBlob_(sheets) {
  var enc = new TextEncoder(), files = [], names = [], used = {};
  sheets.forEach(function (s) {
    var base = sheetName_(s.name), nm = base, k = 2;
    while (used[nm.toLowerCase()]) { nm = (base.slice(0, 28) + ' ' + (k++)).slice(0, 31); }
    used[nm.toLowerCase()] = 1; names.push(nm);
  });
  var ct = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
    + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>';
  sheets.forEach(function (s, i) { ct += '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'; });
  ct += '</Types>';
  files.push({ name: '[Content_Types].xml', data: enc.encode(ct) });
  files.push({
    name: '_rels/.rels', data: enc.encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>')
  });
  var wbSheets = '';
  names.forEach(function (n, i) { wbSheets += '<sheet name="' + xmlEsc_(n) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>'; });
  files.push({
    name: 'xl/workbook.xml', data: enc.encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
      + '<sheets>' + wbSheets + '</sheets></workbook>')
  });
  var rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">';
  names.forEach(function (n, i) { rels += '<Relationship Id="rId' + (i + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>'; });
  rels += '<Relationship Id="rId' + (names.length + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>';
  files.push({ name: 'xl/_rels/workbook.xml.rels', data: enc.encode(rels) });
  files.push({
    name: 'xl/styles.xml', data: enc.encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
      + '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>'
      + '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>'
      + '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
      + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
      + '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
      + '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>'
      + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>')
  });
  sheets.forEach(function (s, i) {
    files.push({ name: 'xl/worksheets/sheet' + (i + 1) + '.xml', data: enc.encode(xlsxSheetXml_(s.rows || [])) });
  });
  return zipStore_(files);
}

/* ============================================================
 *  2) قارئ ملفات Excel/CSV (للاستيراد) — بدون أي مكتبة خارجية
 * ============================================================ */

/** يحوّل حرف العمود لرقم: A=0, B=1, ... AA=26 */
function colIndex_(ref) {
  var m = /^([A-Z]+)/.exec(String(ref || '').toUpperCase());
  if (!m) return 0;
  var n = 0, letters = m[1];
  for (var i = 0; i < letters.length; i++) n = n * 26 + (letters.charCodeAt(i) - 64);
  return n - 1;
}

/** يقرأ ZIP (xlsx) — بيستخدم DecompressionStream (مدمج في المتصفح) */
async function unzip_(buffer) {
  var bytes = new Uint8Array(buffer);
  var view = new DataView(bytes.buffer);
  /* آخر central directory */
  var eocd = -1;
  for (var i = bytes.length - 22; i >= 0 && i > bytes.length - 66000; i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('الملف مش ZIP صالح.');
  var count = view.getUint16(eocd + 10, true);
  var cdOff = view.getUint32(eocd + 16, true);
  var pos = cdOff, out = {};
  for (var n = 0; n < count; n++) {
    if (view.getUint32(pos, true) !== 0x02014b50) break;
    var method = view.getUint16(pos + 10, true);
    var compSize = view.getUint32(pos + 20, true);
    var nameLen = view.getUint16(pos + 28, true);
    var extraLen = view.getUint16(pos + 30, true);
    var cmtLen = view.getUint16(pos + 32, true);
    var localOff = view.getUint32(pos + 42, true);
    var name = new TextDecoder().decode(bytes.subarray(pos + 46, pos + 46 + nameLen));
    /* local header */
    var lNameLen = view.getUint16(localOff + 26, true);
    var lExtraLen = view.getUint16(localOff + 28, true);
    var dataStart = localOff + 30 + lNameLen + lExtraLen;
    var raw = bytes.subarray(dataStart, dataStart + compSize);
    if (method === 0) {
      out[name] = raw;
    } else if (method === 8) {
      var ds = new DecompressionStream('deflate-raw');
      var stream = new Blob([raw]).stream().pipeThrough(ds);
      out[name] = new Uint8Array(await new Response(stream).arrayBuffer());
    }
    pos += 46 + nameLen + extraLen + cmtLen;
  }
  return out;
}

function decodeXml_(bytes) {
  return new TextDecoder('utf-8').decode(bytes);
}

/** يحوّل XML شيت (sharedStrings + sheet) لصفوف */
function sheetRows_(zip, sheetName) {
  var decoder = new TextDecoder('utf-8');
  var shared = [];
  if (zip['xl/sharedStrings.xml']) {
    var ss = decodeXml_(zip['xl/sharedStrings.xml']);
    var items = ss.match(/<si[\s\S]*?<\/si>/g) || [];
    shared = items.map(function (si) {
      var texts = si.match(/<t[^>]*>([\s\S]*?)<\/t>/g) || [];
      return texts.map(function (t) {
        return t.replace(/<[^>]+>/g, '')
          .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
          .replace(/&apos;/g, "'").replace(/&#(\d+);/g, function (m, d) { return String.fromCharCode(+d); })
          .replace(/&amp;/g, '&');
      }).join('');
    });
  }
  var xml = zip[sheetName] ? decodeXml_(zip[sheetName]) : '';
  var rowsXml = xml.match(/<row[\s\S]*?<\/row>/g) || [];
  var out = [];
  rowsXml.forEach(function (r) {
    var cells = r.match(/<c[\s\S]*?(?:\/>|<\/c>)/g) || [];
    var row = [];
    cells.forEach(function (c) {
      var ref = (/r="([A-Z]+\d+)"/.exec(c) || [])[1] || '';
      var idx = ref ? colIndex_(ref) : row.length;
      var t = (/t="([^"]+)"/.exec(c) || [])[1] || '';
      var val = '';
      if (t === 'inlineStr') {
        val = (c.match(/<t[^>]*>([\s\S]*?)<\/t>/) || [])[1] || '';
      } else {
        var v = (/<v>([\s\S]*?)<\/v>/.exec(c) || [])[1];
        if (t === 's') val = shared[parseInt(v, 10)] || '';
        else val = v === undefined ? '' : v;
      }
      val = String(val)
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'").replace(/&#(\d+);/g, function (m, d) { return String.fromCharCode(+d); })
        .replace(/&amp;/g, '&');
      row[idx] = val;
    });
    for (var i = 0; i < row.length; i++) if (row[i] === undefined) row[i] = '';
    out.push(row);
  });
  return out;
}

/** CSV → صفوف */
function csvRows_(text) {
  var rows = [], row = [], cur = '', q = false, i = 0;
  var s = String(text || '').replace(/^\uFEFF/, '');
  while (i < s.length) {
    var ch = s[i];
    if (q) {
      if (ch === '"') {
        if (s[i + 1] === '"') { cur += '"'; i += 2; continue; }
        q = false; i++; continue;
      }
      cur += ch; i++; continue;
    }
    if (ch === '"') { q = true; i++; continue; }
    if (ch === ',') { row.push(cur); cur = ''; i++; continue; }
    if (ch === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; i++; continue; }
    if (ch === '\r') { i++; continue; }
    cur += ch; i++;
  }
  row.push(cur); rows.push(row);
  return rows.filter(function (r) { return r.some(function (c) { return String(c).trim() !== ''; }); });
}

/**
 * يقرأ ملف Excel/CSV ويرجّع {headers, rows, sheet}
 * - headers: أول صف (العناوين)
 * - rows: باقي الصفوف كمصفوفات قيم
 */
export async function parseSpreadsheet(file) {
  var name = String(file.name || '').toLowerCase();
  var buf = await file.arrayBuffer();
  if (name.endsWith('.csv') || name.endsWith('.txt')) {
    var rows = csvRows_(new TextDecoder('utf-8').decode(buf));
    return { headers: rows[0] || [], rows: rows.slice(1), sheet: 'CSV' };
  }
  /* XLSX */
  var zip = await unzip_(buf);
  /* أول شيت بالترتيب */
  var sheetPath = Object.keys(zip).filter(function (k) { return /^xl\/worksheets\/sheet\d+\.xml$/.test(k); })
    .sort(function (a, b) {
      return (+a.match(/(\d+)/)[1]) - (+b.match(/(\d+)/)[1]);
    })[0];
  if (!sheetPath) throw new Error('الملف ده مش Excel صالح (أو تالف).');
  var all = sheetRows_(zip, sheetPath);
  if (!all.length) throw new Error('الملف فاضي.');
  return { headers: all[0], rows: all.slice(1), sheet: sheetPath };
}
