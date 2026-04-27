// api/stats.js — Kiểm tra số lượng vectors đã học trong Pinecone

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const PINECONE_KEY  = process.env.PINECONE_API_KEY;
  const PINECONE_HOST = process.env.PINECONE_HOST;

  if (!PINECONE_KEY || !PINECONE_HOST) {
    return res.status(200).json({ koc: 0, viral: 0, ready: false });
  }

  try {
    const r = await fetch(`${PINECONE_HOST}/describe_index_stats`, {
      method: 'POST',
      headers: { 'Api-Key': PINECONE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const json = await r.json();
    const ns   = json.namespaces || {};
    return res.status(200).json({
      koc:   ns.koc?.vectorCount   || 0,
      viral: ns.viral?.vectorCount || 0,
      total: json.totalVectorCount || 0,
      ready: (json.totalVectorCount || 0) > 0,
    });
  } catch (e) {
    return res.status(200).json({ koc: 0, viral: 0, ready: false, error: e.message });
  }
}
