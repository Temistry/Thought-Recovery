import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.48.1';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

type RequestBody = {
  noteId?: string;
  audioPath?: string;
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
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const openAiKey = Deno.env.get('OPENAI_API_KEY');
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY');
    const authHeader = req.headers.get('Authorization');

    if (!openAiKey || !supabaseUrl || !supabaseAnonKey || !authHeader) {
      return json({ error: 'Missing server configuration or auth header' }, 500);
    }

    const { noteId, audioPath } = (await req.json()) as RequestBody;
    if (!noteId || !audioPath) {
      return json({ error: 'noteId and audioPath are required' }, 400);
    }

    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: note, error: noteFetchError } = await supabase
      .from('notes')
      .select('id, user_id')
      .eq('id', noteId)
      .single();

    if (noteFetchError || !note) {
      return json({ error: 'Note not found or not allowed' }, 404);
    }

    const { data: audioBlob, error: downloadError } = await supabase.storage
      .from('note-audio')
      .download(audioPath);

    if (downloadError || !audioBlob) {
      return await noteError(
        supabase,
        noteId,
        `Audio download failed: ${downloadError?.message ?? 'no audio blob'}`,
        audioPath,
      );
    }

    const form = new FormData();
    form.append('model', 'gpt-4o-mini-transcribe');
    form.append('language', 'ko');
    form.append('response_format', 'json');
    form.append(
      'prompt',
      '한국어 아이디어 메모 앱의 음성 입력입니다. 말투는 자연스럽게 보존하되, 가능한 한 정확히 전사해주세요.',
    );
    form.append('file', audioBlob, filenameFromPath(audioPath));

    const transcriptionResponse = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${openAiKey}` },
      body: form,
    });

    if (!transcriptionResponse.ok) {
      const errorText = await transcriptionResponse.text();
      return await noteError(
        supabase,
        noteId,
        `OpenAI transcription failed (${transcriptionResponse.status}): ${errorText}`,
        audioPath,
      );
    }

    const transcription = await transcriptionResponse.json() as { text?: string };
    const text = transcription.text?.trim();
    if (!text) {
      return await noteError(supabase, noteId, 'OpenAI transcription returned empty text', audioPath);
    }

    const organized = await organizeThought(openAiKey, text, 'voice');

    const { error: updateError } = await supabase
      .from('notes')
      .update({
        raw_text: text,
        ai_title: organized.title,
        ai_summary: organized.summary,
        ai_tags: organized.tags,
        intent: organized.intent,
        problem: organized.problem,
        situation: organized.situation,
        reusePurpose: organized.reusePurpose,
        decisionAxis: organized.decisionAxis,
        emotion: organized.emotion,
        lifeArea: organized.lifeArea,
        memoryType: organized.memoryType,
        lifeDomain: organized.lifeDomain,
        topic: organized.topic,
        outputPurpose: organized.outputPurpose,
        userRole: organized.userRole,
        evidenceType: organized.evidenceType,
        paragraphIntents: organized.paragraphIntents,
        audio_url: audioPath,
      })
      .eq('id', noteId);

    if (updateError) {
      return await noteError(supabase, noteId, `Note update failed: ${updateError.message}`, audioPath);
    }

    return json({ text, ai_title: organized.title, ai_summary: organized.summary, ai_tags: organized.tags, ...organized });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
});

async function noteError(
  supabase: ReturnType<typeof createClient>,
  noteId: string,
  message: string,
  audioPath?: string,
) {
  const safeMessage = message.length > 900 ? `${message.slice(0, 900)}...` : message;

  await supabase
    .from('notes')
    .update({
      ai_title: '음성 전사 실패',
      ai_summary: safeMessage,
      ...(audioPath ? { audio_url: audioPath } : {}),
    })
    .eq('id', noteId);

  // Return 200 so older Expo clients can reload the note and display ai_summary.
  return json({ ok: false, error: safeMessage });
}


async function organizeThought(openAiKey: string, rawText: string, sourceType: string): Promise<OrganizedThought> {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${openAiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: Deno.env.get('OPENAI_DEFAULT_MODEL') || 'gpt-5.4-mini',
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content:
            '너는 한국어 AI 메모 앱의 조용한 생각 정리 보조자다. 사용자의 생각을 과장하거나 기획서로 키우지 말고, 부담 없이 다시 발견하기 좋게 정리한다. 반드시 JSON만 출력한다.',
        },
        {
          role: 'user',
          content: [
            `입력 방식: ${sourceType}`,
            '아래 메모를 정리해줘.',
            '',
            rawText,
            '',
            'JSON 형식:',
            '{',
            '  "title": "28자 이내의 자연스러운 한국어 제목",',
            '  "summary": "1~2문장 핵심 요약. 사용자가 나중에 바로 이해할 수 있게",',
            '  "tags": ["3~5개의 짧은 한국어 태그. 하나의 대표 분류로 몰지 말고 주제/맥락/행동축을 나눌 것"]',
            '}',
          ].join('\n'),
        },
      ],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI organization failed (${response.status}): ${errorText}`);
  }

  const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  const content = payload.choices?.[0]?.message?.content;
  if (!content) throw new Error('OpenAI organization returned empty content');

  let parsed: Partial<OrganizedThought>;
  try {
    parsed = JSON.parse(content) as Partial<OrganizedThought>;
  } catch {
    throw new Error(`OpenAI organization returned invalid JSON: ${content.slice(0, 300)}`);
  }

  return normalizeOrganizedThought(parsed, rawText);
}

function normalizeOrganizedThought(input: Partial<OrganizedThought>, rawText: string): OrganizedThought {
  const title = cleanText(input.title) || makeDraftTitle(rawText);
  const summary = cleanText(input.summary) || makeDraftSummary(rawText);
  const tags = normalizeTags(Array.isArray(input.tags)
    ? input.tags.map(cleanText).filter(Boolean).slice(0, 5)
    : [], rawText);
  const paragraphIntents = normalizeParagraphIntents(input.paragraphIntents, rawText);
  const primary = paragraphIntents[0];

  return {
    title: title.length > 40 ? `${title.slice(0, 40)}...` : title,
    summary: summary.length > 240 ? `${summary.slice(0, 240)}...` : summary,
    tags,
    intent: cleanText(input.intent) || primary.intent,
    problem: cleanText(input.problem) || primary.topic,
    situation: cleanText(input.situation) || '??? ??? ??',
    reusePurpose: cleanText(input.reusePurpose) || primary.outputPurpose,
    decisionAxis: cleanText(input.decisionAxis) || primary.outputPurpose,
    emotion: cleanText(input.emotion) || '??',
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


function normalizeParagraphIntents(value: unknown, rawText: string): ParagraphIntent[] {
  const items = Array.isArray(value) ? value : [];
  const normalized = items
    .map((item) => normalizeParagraphIntent(item))
    .filter((item): item is ParagraphIntent => Boolean(item))
    .slice(0, 8);
  if (normalized.length) return normalized;
  return [{
    text: rawText.trim().slice(0, 500),
    lifeDomain: inferLifeDomain(rawText),
    topic: inferTopic(rawText),
    intent: inferIntent(rawText),
    outputPurpose: inferOutputPurpose(rawText),
    userRole: inferUserRole(rawText),
    evidenceType: inferEvidenceType(rawText),
    confidence: 0.55,
  }];
}

function normalizeParagraphIntent(value: unknown): ParagraphIntent | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  const text = cleanText(item.text);
  if (!text) return null;
  return {
    text: text.slice(0, 500),
    lifeDomain: cleanText(item.lifeDomain) || inferLifeDomain(text),
    topic: cleanText(item.topic) || inferTopic(text),
    intent: cleanText(item.intent) || inferIntent(text),
    outputPurpose: cleanText(item.outputPurpose) || inferOutputPurpose(text),
    userRole: cleanText(item.userRole) || inferUserRole(text),
    evidenceType: cleanText(item.evidenceType) || inferEvidenceType(text),
    confidence: clamp(Number(item.confidence ?? 0.6)),
  };
}

function inferLifeDomain(text: string) {
  const t = text.toLowerCase();
  if (includesAny(t, ['??', '???', '??', '??', '??', '??', '??', '??', '??'])) return '????';
  if (includesAny(t, ['ux', 'ui', '????', '???', '??', '??? ??', '??', '??', '?'])) return '???';
  if (includesAny(t, ['??', 'mvp', 'v0.1', '?? ??'])) return '???';
  return '??';
}

function inferTopic(text: string) {
  const t = text.toLowerCase();
  if (includesAny(t, ['??', '??', '???', '??']) && includesAny(t, ['ai', 'gpt', '???', 'openclaw', '????'])) return 'AI ?? ??';
  if (includesAny(t, ['????', '???', '????'])) return '???? UX';
  if (includesAny(t, ['??', '??'])) return '?? ?? ??';
  return text.trim().replace(/\s+/g, ' ').slice(0, 28) || '?? ??';
}

function inferOutputPurpose(text: string) {
  const t = text.toLowerCase();
  if (includesAny(t, ['??', '??', '???', '??', '??', '??'])) return '????';
  if (includesAny(t, ['ux', 'ui', '????', '???', '??? ??', '??', '??'])) return 'UX ???';
  if (includesAny(t, ['??', 'mvp', 'v0.1', '??'])) return '????';
  if (includesAny(t, ['????', '??', '??', '??', '??'])) return '????';
  return '????';
}

function inferIntent(text: string) {
  const t = text.toLowerCase();
  if (includesAny(t, ['??', '??', '??'])) return '??';
  if (includesAny(t, ['??', '??', '??'])) return '????';
  if (includesAny(t, ['????', '???', '??'])) return '????';
  if (includesAny(t, ['????', '??', '??'])) return '????';
  return '??';
}

function inferUserRole(text: string) {
  const t = text.toLowerCase();
  if (includesAny(t, ['??', '???', '??', '??', '??', '??', '??'])) return '???';
  if (includesAny(t, ['ux', 'ui', '????', '???', '??? ??', '??'])) return '????';
  if (includesAny(t, ['??', '??', '??', '??', '??'])) return '???';
  return '???';
}

function inferEvidenceType(text: string) {
  const t = text.toLowerCase();
  if (includesAny(t, ['????', '????', '???', '??'])) return '????';
  if (includesAny(t, ['??', '??', '??', '??', '??'])) return '??? ??';
  if (includesAny(t, ['??', '????', '????', '??'])) return '??';
  return '??';
}

function includesAny(text: string, needles: string[]) {
  return needles.some((needle) => text.includes(needle));
}

function clamp(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

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

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function filenameFromPath(path: string) {
  return path.split('/').pop() || 'voice-note.m4a';
}

function makeDraftTitle(text: string) {
  const cleaned = text.trim().replace(/\s+/g, ' ');
  return cleaned.length > 28 ? `${cleaned.slice(0, 28)}...` : cleaned || '음성 아이디어';
}

function makeDraftSummary(text: string) {
  const cleaned = text.trim().replace(/\s+/g, ' ');
  return cleaned.length > 120 ? `${cleaned.slice(0, 120)}...` : cleaned;
}
