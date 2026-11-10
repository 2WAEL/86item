#!/usr/bin/env node
/**
 * فحص ملفات الـ Frontend للأسرار (Secrets Scan)
 * ---------------------------------------------------------------
 * الفكرة: أي ملف بيتنشر للمتصفح لازم يبقى خالي من المفاتيح الخاصة.
 * الـ API Key بتاع Firebase Web **مش سر** (.public by design) — بيتشال
 * منه الفحص عمدًا. لكن أي مفتاح خاص (Service Account / Private Key /
 * GitHub Token / Stripe / AWS ...) = خطأ ويفصل الـ CI.
 *
 * التشغيل:
 *   node scripts/check-no-secrets.mjs
 *
 * ملاحظة: لو حبيت تفحص مكان تاني، عدّل SCAN_DIRS.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const SCAN_DIRS = ['public', 'scripts'];
const SCAN_EXT = /\.(js|mjs|html|css|json|md|txt)$/i;

/** أنماط أسرار حقيقية — لازم ما تظهرش في كود المتصفح */
const SECRET_PATTERNS = [
  { name: 'Private key (RSA/EC/OPENSSH/PGP)', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g },
  { name: 'Firebase Service Account JSON', re: /"type"\s*:\s*"service_account"/g },
  { name: 'Firebase Admin private key field', re: /"private_key"\s*:/g },
  { name: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}/g },
  { name: 'AWS Access Key ID', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'Slack token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { name: 'Stripe secret key', re: /\bsk_(?:live|test)_[A-Za-z0-9]{16,}/g },
  { name: 'Google API key (server-side)', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: 'JWT / long bearer token', re: /\bBearer\s+[A-Za-z0-9._-]{40,}/g },
  { name: 'Basic auth in URL', re: /\bhttps?:\/\/[^\/\s:@]+:[^\/\s:@]+@/g }
];

/** استثناءات معروفة وموثّقة (Firebase Web API Key — public by design) */
const ALLOW_LINES = [
  { re: /apiKey\s*:\s*['"][^'"]+['"]/, why: 'Firebase Web API Key — مفتاح عام للمتصفح (مش سر)' }
];

function walk(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const name of entries) {
    if (name === 'node_modules' || name === '.git' || name === '.firebase') continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (SCAN_EXT.test(name)) out.push(full);
  }
  return out;
}

const files = SCAN_DIRS.flatMap((d) => walk(join(ROOT, d)));
let problems = 0;
let allowed = 0;

for (const file of files) {
  const text = readFileSync(file, 'utf8');
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const { name, re } of SECRET_PATTERNS) {
      const g = new RegExp(re.source, re.flags);
      if (!g.test(line)) continue;
      const ok = ALLOW_LINES.find((a) => a.re.test(line));
      if (ok) { allowed++; continue; }
      problems++;
      console.error(`✗ ${relative(ROOT, file)}:${i + 1}  [${name}]`);
      console.error(`    ${line.trim().slice(0, 140)}`);
    }
  });
}

console.log(`فُحص ${files.length} ملف.`);
if (allowed) console.log(`ℹ ${allowed} حالة مسموحة (Firebase Web API Key — public by design).`);
if (problems) {
  console.error(`\n✗ لقينا ${problems} سر في كود الواجهة — شيلها فورًا!`);
  process.exit(1);
}
console.log('✓ مفيش أسرار في ملفات الـ Frontend.');
