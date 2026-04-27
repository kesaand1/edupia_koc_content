// api/generate.js — Tìm mẫu phù hợp từ Pinecone → Sinh content

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  const PINECONE_KEY  = process.env.PINECONE_API_KEY;
  const PINECONE_HOST = process.env.PINECONE_HOST;

  if (!ANTHROPIC_KEY || !PINECONE_KEY || !PINECONE_HOST) {
    return res.status(500).json({ error: 'Thiếu environment variables' });
  }

  let body;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body; }
  catch { return res.status(400).json({ error: 'Invalid JSON body' }); }

  const { kocInfo, link } = body;
  if (!kocInfo || !link) return res.status(400).json({ error: 'Thiếu kocInfo hoặc link' });

  try {
    // ── 1. Tạo embedding từ thông tin KOC ──
    const queryVec = pseudoEmbedding(kocInfo);

    // ── 2. Query Pinecone — lấy 5 mẫu KOC + 3 bài viral phù hợp nhất ──
    const [kocMatches, viralMatches] = await Promise.all([
      queryPinecone(queryVec, 'koc',   5, PINECONE_KEY, PINECONE_HOST),
      queryPinecone(queryVec, 'viral', 3, PINECONE_KEY, PINECONE_HOST),
    ]);

    // ── 3. Build DNA block ──
    let dnaBlock = '';

    if (kocMatches.length > 0) {
      dnaBlock += `\n\n═══ DNA #1 — ${kocMatches.length} MẪU KOC PHÙ HỢP NHẤT (tìm từ vector DB) ═══\n`;
      dnaBlock += `Học kỹ: cách mở đầu, cấu trúc cảm xúc, giọng điệu, chi tiết thật, CTA.\n`;
      dnaBlock += kocMatches.map((m, i) => {
        const md = m.metadata;
        return `\n[KOC-${i+1} | Score: ${(m.score*100).toFixed(0)}% | Trình độ: ${md.level||'—'} | ${md.grade||'—'}]\nThông tin KOC: ${md.info}\nContent đã dùng:\n${md.content}`;
      }).join('\n');
    }

    if (viralMatches.length > 0) {
      dnaBlock += `\n\n═══ DNA #2 — ${viralMatches.length} BÀI FACEBOOK VIRAL PHÙ HỢP ═══\n`;
      dnaBlock += `Học: hook mở đầu, cấu trúc câu chuyện thu hút, yếu tố tạo share.\n`;
      dnaBlock += viralMatches.map((m, i) => `\n[VIRAL-${i+1} | Score: ${(m.score*100).toFixed(0)}%]\n${m.metadata.content}`).join('\n');
    }

    if (!dnaBlock) {
      dnaBlock = '\n\n[Chưa có dữ liệu DNA — hệ thống sẽ viết dựa trên kiến thức chung]\n';
    }

    // ── 4. Gọi Claude để viết content ──
    const prompt = `Bạn là chuyên gia copywriter hàng đầu, chuyên viết Facebook viral cho phụ huynh Việt Nam về học tiếng Anh trẻ em với Edupia — lớp nhóm nhỏ 1-4 học sinh, chất lượng cao.
${dnaBlock}

═══ THÔNG TIN KOC MỚI ═══
${kocInfo}

Link đăng ký: ${link}

═══ NHIỆM VỤ ═══
Dựa vào DNA bên trên, viết 2 phiên bản content Facebook HOÀN TOÀN KHÁC NHAU.

PHÂN TÍCH TRƯỚC KHI VIẾT:
- Từ DNA KOC: học cách mở đầu, giọng điệu, chi tiết thật phù hợp với chân dung KOC này
- Từ DNA Viral: học hook, cấu trúc câu chuyện, yếu tố cảm xúc tạo share
- Từ thông tin KOC: xác định nỗi đau chính, kết quả nổi bật, angle tốt nhất

QUY TẮC BẮT BUỘC:
1. Câu MỞ ĐẦU: nghịch lý/bất ngờ cực mạnh — người lướt feed phải dừng lại. KHÔNG mở bằng "Con mình..." hay lời chào nhàm.
2. Chỉ nhắc "Edupia" đúng 1 lần. KHÔNG dùng "Edupia Pro".
3. KHÔNG đề cập lớp học, tuổi cụ thể của con trong bài.
4. Giọng phụ huynh Việt Nam đời thường: "mình", "con mình", "bé", không văn hoa, không quảng cáo lộ liễu.
5. Chi tiết thật: câu nói của con, tình huống cụ thể, cảm xúc thật.
6. CTA cuối: học bổng giảm học phí + miễn phí buổi học thử + app AI luyện nói + hội thoại thầy cô người nước ngoài. Link: ${link}
7. 3-5 hashtag phù hợp.

2 PHIÊN BẢN:
- "Cảm xúc & Câu chuyện": Hook nghịch lý → kể câu chuyện thật chi tiết → kết quả → CTA. 180-220 từ.
- "Viral hook & Ngắn gọn": Câu đầu cực sốc/hài → kể súc tích → CTA mạnh. 110-140 từ.

JSON hợp lệ, không markdown, không backtick:
{"versions":[{"label":"Cảm xúc & Câu chuyện","content":"..."},{"label":"Viral hook & Ngắn gọn","content":"..."}]}`;

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key':         ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type':      'application/json',
      },
      body: JSON.stringify({
        model:      'claude-sonnet-4-6',
        max_tokens: 3000,
        messages:   [{ role: 'user', content: prompt }],
      }),
    });

    // Log Claude response status for debugging
    if (!claudeRes.ok) {
      const errText = await claudeRes.text();
      throw new Error('Claude API lỗi ' + claudeRes.status + ': ' + errText.slice(0, 300));
    }

    const claudeData = await claudeRes.json();

    // Check for API-level errors
    if (claudeData.error) {
      throw new Error('Claude error: ' + claudeData.error.message);
    }

    const raw = (claudeData.content || []).map(b => b.text || '').join('');

    if (!raw) {
      throw new Error('Claude trả về rỗng. Stop reason: ' + claudeData.stop_reason + ' | Usage: ' + JSON.stringify(claudeData.usage));
    }

    // Robust JSON extraction
    let parsed;
    try {
      parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
    } catch(parseErr) {
      const match = raw.match(/\{[\s\S]*"versions"[\s\S]*\}/);
      if (match) {
        try { parsed = JSON.parse(match[0]); } catch(e2) { throw new Error('JSON parse thất bại: ' + raw.slice(0, 300)); }
      } else {
        throw new Error('Format JSON sai. Raw response: ' + raw.slice(0, 300));
      }
    }

    if (!parsed?.versions?.length) throw new Error('Thiếu versions. Parsed: ' + JSON.stringify(parsed).slice(0, 200));

    return res.status(200).json({
      versions:    parsed.versions,
      dnaUsed:     { koc: kocMatches.length, viral: viralMatches.length },
      topKocScore: kocMatches[0]?.score || 0,
    });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

// ── Query Pinecone ──
async function queryPinecone(vector, namespace, topK, pineconeKey, pineconeHost) {
  const res = await fetch(`${pineconeHost}/query`, {
    method: 'POST',
    headers: {
      'Api-Key':      pineconeKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      vector,
      topK,
      namespace,
      includeMetadata: true,
    }),
  });
  if (!res.ok) throw new Error(`Pinecone query error: ${await res.text()}`);
  const json = await res.json();
  return json.matches || [];
}

// Pseudo-embedding (cùng hàm với sync.js để vector space nhất quán)
function pseudoEmbedding(text) {
  const dim = 1024;
  const vec = new Array(dim).fill(0);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    vec[i % dim]     += Math.sin(code * (i + 1));
    vec[(i*7) % dim] += Math.cos(code * 0.1);
  }
  const norm = Math.sqrt(vec.reduce((s, v) => s + v*v, 0)) || 1;
  return vec.map(v => v / norm);
}
