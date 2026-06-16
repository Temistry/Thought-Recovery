import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.48.1';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

type RequestBody = { noteId?: string };
type NoteRow = {
  id: string;
  raw_text: string;
  ai_title: string | null;
  ai_summary: string | null;
  ai_tags: string[] | null;
  source_type: string;
  parent_note_id: string | null;
  routing_status: string | null;
  is_pinned: boolean | null;
  created_at: string;
};
type RouteDecision = {
  action: 'append_to_existing' | 'create_new_thread';
  target_note_id?: string | null;
  confidence: number;
  reason: string;
  title?: string;
  summary?: string;
  tags?: string[];
};

type ParagraphIntent = {
  text: string;
  lifeDomain: string;
  topic: string;
  intent: string;
  outputPurpose: string;
  userRole: string;
  evidenceType: string;
  confidence: number;
};

type OrganizedThought = {
  title: string;
  summary: string;
  tags: string[];
  intent: string;
  problem: string;
  situation: string;
  reusePurpose: string;
  decisionAxis: string;
  emotion: string;
  lifeArea: string;
  memoryType: string;
  lifeDomain: string;
  topic: string;
  outputPurpose: string;
  userRole: string;
  evidenceType: string;
  paragraphIntents: ParagraphIntent[];
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const openAiKey = Deno.env.get('OPENAI_API_KEY');
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY');
    const authHeader = req.headers.get('Authorization');

    if (!openAiKey || !supabaseUrl || !supabaseAnonKey || !authHeader) {
      return json({ error: 'Missing server configuration or auth header' }, 500);
    }

    const { noteId } = (await req.json()) as RequestBody;
    if (!noteId) return json({ error: 'noteId is required' }, 400);

    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: incoming, error: incomingError } = await supabase
      .from('notes')
      .select('id, raw_text, ai_title, ai_summary, ai_tags, source_type, parent_note_id, routing_status, is_pinned, created_at')
      .eq('id', noteId)
      .single();

    if (incomingError || !incoming) return json({ error: 'Note not found or not allowed' }, 404);

    const incomingNote = incoming as NoteRow;
    await supabase.from('notes').update({ routing_status: 'routing' }).eq('id', noteId);

    if (incomingNote.parent_note_id) {
      return json({ ok: true, action: 'already_attached', note: incomingNote });
    }

    const { data: candidatesData, error: candidatesError } = await supabase
      .from('notes')
      .select('id, raw_text, ai_title, ai_summary, ai_tags, source_type, parent_note_id, routing_status, is_pinned, created_at')
      .is('parent_note_id', null)
      .eq('is_pinned', false)
      .neq('id', noteId)
      .order('updated_at', { ascending: false })
      .limit(8);

    if (candidatesError) return json({ error: `Candidate fetch failed: ${candidatesError.message}` }, 500);

    const candidates = (candidatesData ?? []) as NoteRow[];
    const organizedIncoming = await organizeThought(openAiKey, incomingNote.raw_text, incomingNote.source_type);

    if (candidates.length === 0) {
      const updated = await updateNote(supabase, noteId, {
        ai_title: organizedIncoming.title,
        ai_summary: organizedIncoming.summary,
        ai_tags: organizedIncoming.tags,
        ...buildThoughtProfilePatch(organizedIncoming),
        ai_thread_reason: '첫 번째 생각이라 새 피드 카드로 유지했습니다.',
        ai_thread_confidence: 1,
        routing_status: 'routed',
      });
      return json({ ok: true, action: 'create_new_thread', note: updated, decision: { confidence: 1 } });
    }

    const decision = await decideRoute(openAiKey, incomingNote, candidates, organizedIncoming);

    if (decision.action === 'append_to_existing' && decision.target_note_id) {
      const target = candidates.find((candidate) => candidate.id === decision.target_note_id);
      if (!target) throw new Error('AI selected a target that is not in candidates');

      const merged = normalizeOrganizedThought(
        {
          title: decision.title,
          summary: decision.summary,
          tags: decision.tags,
        },
        `${target.ai_summary ?? target.raw_text}\n${incomingNote.raw_text}`,
      );

      const { error: childUpdateError } = await supabase
        .from('notes')
        .update({
          parent_note_id: target.id,
          ai_title: organizedIncoming.title,
          ai_summary: organizedIncoming.summary,
          ai_tags: organizedIncoming.tags,
          ...buildThoughtProfilePatch(organizedIncoming),
          ai_thread_reason: decision.reason,
          ai_thread_confidence: decision.confidence,
          routing_status: 'routed',
        })
        .eq('id', incomingNote.id);

      if (childUpdateError) throw new Error(`Child note update failed: ${childUpdateError.message}`);

      const parent = await updateNote(supabase, target.id, {
        ai_title: merged.title,
        ai_summary: merged.summary,
        ai_tags: merged.tags,
        ...buildThoughtProfilePatch(merged),
        ai_thread_reason: `새 원문을 이어붙임: ${decision.reason}`,
        ai_thread_confidence: decision.confidence,
        routing_status: 'routed',
      });

      return json({ ok: true, action: 'append_to_existing', note: parent, attached_note_id: incomingNote.id, decision });
    }

    const updated = await updateNote(supabase, noteId, {
      ai_title: organizedIncoming.title,
      ai_summary: organizedIncoming.summary,
      ai_tags: organizedIncoming.tags,
      ...buildThoughtProfilePatch(organizedIncoming),
      ai_thread_reason: decision.reason || '기존 생각과 분리해 새 피드 카드로 유지했습니다.',
      ai_thread_confidence: decision.confidence,
      routing_status: 'routed',
    });

    return json({ ok: true, action: 'create_new_thread', note: updated, decision });
  } catch (error) {
    // Best-effort failure status update cannot be done safely here without duplicating auth setup.
    return json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
});

async function decideRoute(
  openAiKey: string,
  incoming: NoteRow,
  candidates: NoteRow[],
  organizedIncoming: OrganizedThought,
): Promise<RouteDecision> {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${openAiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: Deno.env.get('OPENAI_DEFAULT_MODEL') || 'gpt-5.4-mini',
      temperature: 0.15,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content:
            '너는 개인용 로컬 스레드 메모앱의 생각 라우터다. 새 원문 메모를 기존 생각 카드에 댓글처럼 붙일지, 새 생각 카드로 둘지 판단한다. 사업화/기획 컨설턴트처럼 키우지 말고, 사용자의 사고 흐름이 이어지는지만 본다. 반드시 JSON만 출력한다.',
        },
        {
          role: 'user',
          content: [
            '새 원문 메모:',
            incoming.raw_text,
            '',
            '새 메모 임시 정리:',
            `제목: ${organizedIncoming.title}`,
            `요약: ${organizedIncoming.summary}`,
            `태그: ${organizedIncoming.tags.join(', ')}`,
            '',
            '기존 메인 생각 후보:',
            ...candidates.map((candidate, index) => [
              `[${index + 1}] id=${candidate.id}`,
              `제목: ${candidate.ai_title ?? ''}`,
              `요약: ${candidate.ai_summary ?? candidate.raw_text}`,
              `태그: ${(candidate.ai_tags ?? []).join(', ')}`,
            ].join('\n')),
            '',
            '판단 기준:',
            '- 같은 주제의 사고 흐름을 이어가면 append_to_existing',
            '- 단어가 일부 겹쳐도 관점/문제가 다르면 create_new_thread',
            '- 확신이 낮으면 create_new_thread',
            '- append하는 경우 기존 메인 생각을 갱신할 title/summary/tags도 함께 제안',
            '',
            'JSON 형식:',
            '{',
            '  "action": "append_to_existing" | "create_new_thread",',
            '  "target_note_id": "append할 기존 후보 id 또는 null",',
            '  "confidence": 0.0~1.0,',
            '  "reason": "짧은 한국어 이유",',
            '  "title": "append 시 갱신할 메인 제목",',
            '  "summary": "append 시 갱신할 메인 요약",',
            '  "tags": ["append 시 갱신할 태그 3~5개. 하나의 대표 분류로 몰지 말고 주제/맥락/행동축을 나눌 것"]',
            '}',
          ].join('\n'),
        },
      ],
    }),
  });

  if (!response.ok) throw new Error(`OpenAI route failed (${response.status}): ${await response.text()}`);
  const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  const content = payload.choices?.[0]?.message?.content;
  if (!content) throw new Error('OpenAI route returned empty content');

  const parsed = JSON.parse(content) as Partial<RouteDecision>;
  const action = parsed.action === 'append_to_existing' ? 'append_to_existing' : 'create_new_thread';
  const confidence = clamp(Number(parsed.confidence ?? 0));

  if (action === 'append_to_existing' && confidence >= 0.72 && parsed.target_note_id) {
    return {
      action,
      target_note_id: String(parsed.target_note_id),
      confidence,
      reason: cleanText(parsed.reason) || '기존 생각과 자연스럽게 이어집니다.',
      title: cleanText(parsed.title),
      summary: cleanText(parsed.summary),
      tags: normalizeTags(Array.isArray(parsed.tags) ? parsed.tags.map(cleanText).filter(Boolean).slice(0, 5) : [], incoming.raw_text),
    };
  }

  return {
    action: 'create_new_thread',
    target_note_id: null,
    confidence,
    reason: cleanText(parsed.reason) || '기존 생각과 충분히 이어진다고 보기 어려워 새 생각으로 유지했습니다.',
  };
}

async function organizeThought(openAiKey: string, rawText: string, sourceType: string): Promise<OrganizedThought> {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${openAiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: Deno.env.get('OPENAI_DEFAULT_MODEL') || 'gpt-5.4-mini',
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: '너는 개인용 로컬 스레드 메모앱의 생각 정리 보조자다. 남에게 보여줄 기획서가 아니라, 사용자가 나중에 자신의 생각 흐름을 이어받기 좋은 형태로 정리한다. 반드시 JSON만 출력한다.' },
        { role: 'user', content: `입력 방식: ${sourceType}\n원문:\n${rawText}\n\nJSON: { "title": "28자 이내 생각형 제목", "summary": "1~2문장 현재 생각 요약", "tags": ["3~5개 짧은 태그. 주제/맥락/행동축을 나눌 것"] }` },
      ],
    }),
  });
  if (!response.ok) throw new Error(`OpenAI organization failed (${response.status}): ${await response.text()}`);
  const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  const content = payload.choices?.[0]?.message?.content;
  if (!content) throw new Error('OpenAI organization returned empty content');
  return normalizeOrganizedThought(JSON.parse(content) as Partial<OrganizedThought>, rawText);
}

function normalizeOrganizedThought(input: Partial<OrganizedThought>, rawText: string): OrganizedThought {
  const title = cleanText(input.title) || makeDraftTitle(rawText);
  const summary = cleanText(input.summary) || makeDraftSummary(rawText);
  const tags = normalizeTags(Array.isArray(input.tags) ? input.tags.map(cleanText).filter(Boolean).slice(0, 5) : [], rawText);
  const paragraphIntents = normalizeParagraphIntents(input.paragraphIntents, rawText);
  const primary = paragraphIntents[0];
  return {
    title: title.length > 40 ? `${title.slice(0, 40)}...` : title,
    summary: summary.length > 240 ? `${summary.slice(0, 240)}...` : summary,
    tags,
    intent: cleanText(input.intent) || primary.intent,
    problem: cleanText(input.problem) || primary.topic,
    situation: cleanText(input.situation) || '생각을 기록한 상황',
    reusePurpose: cleanText(input.reusePurpose) || primary.outputPurpose,
    decisionAxis: cleanText(input.decisionAxis) || primary.outputPurpose,
    emotion: cleanText(input.emotion) || '중립',
    lifeArea: cleanText(input.lifeArea) || primary.lifeDomain,
    memoryType: cleanText(input.memoryType) || primary.evidenceType,
    lifeDomain: cleanText(input.lifeDomain) || primary.lifeDomain,
    topic: cleanText(input.topic) || primary.topic,
    outputPurpose: cleanText(input.outputPurpose) || primary.outputPurpose,
    userRole: cleanText(input.userRole) || primary.userRole,
    evidenceType: cleanText(input.evidenceType) || primary.evidenceType,
    paragraphIntents,
  };
}

function buildThoughtProfilePatch(thought: OrganizedThought) {
  return {
    intent: thought.intent,
    problem: thought.problem,
    situation: thought.situation,
    reusePurpose: thought.reusePurpose,
    decisionAxis: thought.decisionAxis,
    emotion: thought.emotion,
    lifeArea: thought.lifeArea,
    memoryType: thought.memoryType,
    lifeDomain: thought.lifeDomain,
    topic: thought.topic,
    outputPurpose: thought.outputPurpose,
    userRole: thought.userRole,
    evidenceType: thought.evidenceType,
    paragraphIntents: thought.paragraphIntents,
  };
}

async function updateNote(supabase: ReturnType<typeof createClient>, noteId: string, patch: Record<string, unknown>) {
  const { data, error } = await supabase.from('notes').update(patch).eq('id', noteId).select('*').single();
  if (error) throw new Error(`Note update failed: ${error.message}`);
  return data;
}


function normalizeParagraphIntents(value: unknown, rawText: string): ParagraphIntent[] {
  const items = Array.isArray(value) ? value : [];
  const normalized = items.map((item) => normalizeParagraphIntent(item)).filter((item): item is ParagraphIntent => Boolean(item)).slice(0, 8);
  if (normalized.length) return normalized;
  return [{ text: rawText.trim().slice(0, 500), lifeDomain: inferLifeDomain(rawText), topic: inferTopic(rawText), intent: inferIntent(rawText), outputPurpose: inferOutputPurpose(rawText), userRole: inferUserRole(rawText), evidenceType: inferEvidenceType(rawText), confidence: 0.55 }];
}

function normalizeParagraphIntent(value: unknown): ParagraphIntent | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  const text = cleanText(item.text);
  if (!text) return null;
  return { text: text.slice(0, 500), lifeDomain: cleanText(item.lifeDomain) || inferLifeDomain(text), topic: cleanText(item.topic) || inferTopic(text), intent: cleanText(item.intent) || inferIntent(text), outputPurpose: cleanText(item.outputPurpose) || inferOutputPurpose(text), userRole: cleanText(item.userRole) || inferUserRole(text), evidenceType: cleanText(item.evidenceType) || inferEvidenceType(text), confidence: clamp(Number(item.confidence ?? 0.6)) };
}

function inferLifeDomain(text: string) {
  const t = text.toLowerCase();
  if (includesAny(t, ['팀장', '이사진', '상사', '회사', '직장', '보고', '회의', '어필', '임원'])) return '직장생활';
  if (includesAny(t, ['ux', 'ui', '뒤로가기', '제스처', '터치', '사용자 경험', '화면', '버튼', '앱'])) return '앱개발';
  if (includesAny(t, ['기획', 'mvp', 'v0.1', '제품 방향'])) return '앱기획';
  return '기타';
}
function inferTopic(text: string) {
  const t = text.toLowerCase();
  if (includesAny(t, ['어필', '팀장', '이사진', '상사']) && includesAny(t, ['ai', 'gpt', '온클로', 'openclaw', '헤르메스'])) return 'AI 활용 어필';
  if (includesAny(t, ['뒤로가기', '제스처', '스와이프'])) return '뒤로가기 UX';
  if (includesAny(t, ['녹음', '음성'])) return '녹음 입력 경험';
  return text.trim().replace(/\s+/g, ' ').slice(0, 28) || '임시 생각';
}
function inferOutputPurpose(text: string) {
  const t = text.toLowerCase();
  if (includesAny(t, ['보고', '팀장', '이사진', '상사', '어필', '회의'])) return '보고자료';
  if (includesAny(t, ['ux', 'ui', '뒤로가기', '제스처', '사용자 경험', '버튼', '화면'])) return 'UX 개선안';
  if (includesAny(t, ['기획', 'mvp', 'v0.1', '범위'])) return '기획메모';
  if (includesAny(t, ['개발했다', '구현', '코드', '배포', '버그'])) return '개발로그';
  return '생각메모';
}
function inferIntent(text: string) {
  const t = text.toLowerCase();
  if (includesAny(t, ['어필', '설득', '보고'])) return '설득';
  if (includesAny(t, ['불편', '문제', '아쉽'])) return '문제제기';
  if (includesAny(t, ['해야겠다', '바꿔야', '개선'])) return '개선제안';
  if (includesAny(t, ['개발했다', '했다', '완료'])) return '작업기록';
  return '기록';
}
function inferUserRole(text: string) {
  const t = text.toLowerCase();
  if (includesAny(t, ['팀장', '이사진', '상사', '회사', '직장', '보고', '어필'])) return '직장인';
  if (includesAny(t, ['ux', 'ui', '뒤로가기', '제스처', '사용자 경험', '기획'])) return '앱기획자';
  if (includesAny(t, ['개발', '코드', '구현', '버그', '서버'])) return '개발자';
  return '사용자';
}
function inferEvidenceType(text: string) {
  const t = text.toLowerCase();
  if (includesAny(t, ['해야겠다', '필요하다', '바꿔야', '개선'])) return '요구사항';
  if (includesAny(t, ['느낌', '체감', '불편', '좋다', '아쉽'])) return '사용자 체감';
  if (includesAny(t, ['했다', '개발했다', '구현했다', '완료'])) return '사실';
  return '관찰';
}
function includesAny(text: string, needles: string[]) { return needles.some((needle) => text.includes(needle)); }

function normalizeTags(tags: string[], rawText: string) {
  const text = rawText.toLowerCase();
  const inferred: string[] = [];
  if (text.includes('ui') || text.includes('ux') || text.includes('화면') || text.includes('사용자')) inferred.push('UX');
  if (text.includes('기획') || text.includes('mvp') || text.includes('범위') || text.includes('우선순위')) inferred.push('기획');
  if (text.includes('개발') || text.includes('코드') || text.includes('서버') || text.includes('배포') || text.includes('버그')) inferred.push('개발');
  if (text.includes('사업') || text.includes('수익') || text.includes('비즈니스')) inferred.push('사업');
  if (text.includes('마케팅') || text.includes('홍보') || text.includes('쇼츠') || text.includes('콘텐츠')) inferred.push('마케팅');
  if (text.includes('게임') || text.includes('통나무') || text.includes('스팀')) inferred.push('게임');
  if (text.includes('음성') || text.includes('녹음')) inferred.push('음성');
  return Array.from(new Set([...tags, ...inferred, '아이디어', '메모'].map((tag) => tag.trim()).filter(Boolean))).slice(0, 5);
}

function cleanText(value: unknown) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
}

function clamp(value: number) {
  if (Number.isNaN(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

function makeDraftTitle(text: string) {
  const cleaned = text.trim().replace(/\s+/g, ' ');
  return cleaned.length > 28 ? `${cleaned.slice(0, 28)}...` : cleaned || '새 생각';
}

function makeDraftSummary(text: string) {
  const cleaned = text.trim().replace(/\s+/g, ' ');
  return cleaned.length > 120 ? `${cleaned.slice(0, 120)}...` : cleaned;
}
