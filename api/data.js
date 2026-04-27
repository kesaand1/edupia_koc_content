// api/data.js — Vercel Function
// Đọc 2 Google Sheets: KOC content win + Viral posts

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const KEY       = process.env.GOOGLE_API_KEY;
  const KOC_ID    = process.env.KOC_SHEET_ID;
  const VIRAL_ID  = process.env.VIRAL_SHEET_ID;
  const KOC_TAB   = process.env.KOC_SHEET_NAME   || 'Sheet1';
  const VIRAL_TAB = process.env.VIRAL_SHEET_NAME  || 'Sheet1';

  if (!KEY || !KOC_ID || !VIRAL_ID) {
    return res.status(500).json({ error: 'Thiếu environment variables. Vào Vercel → Settings → Environment Variables.' });
  }

  async function fetchSheet(id, tab) {
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${encodeURIComponent(tab)}?key=${KEY}`;
    const r = await fetch(url);
    const j = await r.json();
    if (!r.ok) throw new Error(j.error?.message || `Lỗi đọc sheet ${tab}`);
    const rows = j.values || [];
    if (rows.length < 2) return [];
    const headers = rows[0].map(h => h.toLowerCase().trim());
    return rows.slice(1)
      .filter(r => r.some(c => (c || '').trim()))
      .map(r => { const o = {}; headers.forEach((h,i) => o[h] = (r[i]||'').trim()); return o; });
  }

  try {
    const [koc, viral] = await Promise.all([
      fetchSheet(KOC_ID, KOC_TAB),
      fetchSheet(VIRAL_ID, VIRAL_TAB),
    ]);
    return res.status(200).json({ koc, viral, kocTotal: koc.length, viralTotal: viral.length });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
