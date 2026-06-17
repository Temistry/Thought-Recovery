const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

type SourceNote = {
  id: string;
  title?: string;
  rawText?: string;
  createdAt?: string;
};

type RequestBody = {
  flowId?: string;
  title?: string;
  notes?: SourceNote[];
};

type MergedThoughtDraft = {
  id: string;
  flowId: string;
  title: string;
  body: string;
  judgmentSummary: string[];
  sourceNoteIds: string[];
  createdAt: string;
  status: 'draft' | 'saved';
};

type OpenAIResponsesPayload = {
  output_text?: string;
  output?: Array<{
    content?: Array<{
      type?: string;
      text?: string;
    }>;
  }>;
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const openAiKey = Deno.env.get('OPENAI_API_KEY');
    const model = Deno.env.get('OPENAI_MERGED_DRAFT_MODEL') || 'gpt-5.4-mini';
    const fallbackModel = Deno.env.get('OPENAI_MERGED_DRAFT_FALLBACK_MODEL') || 'gpt-5.4-mini';
    const authHeader = req.headers.get('Authorization');

    if (!openAiKey || !authHeader) {
      return json({ error: 'Missing server configuration or auth header' }, 500);
    }

    const body = (await req.json()) as RequestBody;
    const flowId = cleanText(body.flowId);
    const flowTitle = cleanText(body.title) || '생각 정리 리포트';
    const notes = normalizeNotes(body.notes ?? []);

    if (!flowId) return json({ error: 'flowId is required' }, 400);
    if (notes.length < 2) return json({ error: 'At least 2 source notes are required' }, 400);

    const result = await generateDraft(openAiKey, model, fallbackModel, flowId, flowTitle, notes);
    return json({ ok: true, draft: result.draft, model: result.model, fallbackUsed: result.fallbackUsed });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
});

async function generateDraft(
  openAiKey: string,
  model: string,
  fallbackModel: string,
  flowId: string,
  flowTitle: string,
  notes: Required<SourceNote>[],
): Promise<{ draft: MergedThoughtDraft; model: string; fallbackUsed: boolean }> {
  const now = new Date().toISOString();
  const primary = await requestMergedDraft(openAiKey, model, flowId, flowTitle, notes, now);
  if ((!isCorruptedKoreanDraft(primary.draft) && !isUngroundedDraft(primary.draft, notes)) || model === fallbackModel) {
    return { ...primary, fallbackUsed: false };
  }

  const fallback = await requestMergedDraft(openAiKey, fallbackModel, flowId, flowTitle, notes, now);
  if (isCorruptedKoreanDraft(fallback.draft) || isUngroundedDraft(fallback.draft, notes)) {
    return { draft: buildExtractiveMergedDraft(flowId, flowTitle, notes, now), model: 'source-grounded-fallback', fallbackUsed: true };
  }
  return { ...fallback, fallbackUsed: true };
}

async function requestMergedDraft(
  openAiKey: string,
  model: string,
  flowId: string,
  flowTitle: string,
  notes: Required<SourceNote>[],
  now: string,
): Promise<{ draft: MergedThoughtDraft; model: string }> {
  if (!model.startsWith('gpt-5')) {
    return requestMergedDraftWithChatCompletions(openAiKey, model, flowId, flowTitle, notes, now);
  }

  const requestBody: Record<string, unknown> = {
    model,
    instructions:
      '당신은 흩어진 원본 메모를 문단별로 읽기 좋은 생각 정리 리포트로 만드는 편집자이다. 먼저 원본들이 같은 중심 문제/의도/재사용 목적을 공유하는지 검사하고, 공통축이 약한 메모는 억지로 본문에 넣지 않는다. 사용자의 입장을 단정하는 오피니언 글을 쓰지 말고, 원문에서 보이는 반복 주제와 생각의 흐름을 보수적으로 정리한다. 반드시 제공된 원본 데이터 안의 내용만 사용하되, 원문은 길게 직접 인용하지 말고 자연스럽게 재서술한다. 반드시 JSON만 출력한다.',
    text: {
      format: {
        type: 'json_schema',
        name: 'merged_thought_draft',
        strict: true,
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            title: { type: 'string' },
            body: { type: 'string' },
            judgmentSummary: {
              type: 'array',
              items: { type: 'string' },
              minItems: 1,
              maxItems: 5,
            },
          },
          required: ['title', 'body', 'judgmentSummary'],
        },
      },
    },
    input: buildPrompt(flowTitle, notes),
  };
  if (model.startsWith('gpt-5')) {
    requestBody.reasoning = { effort: 'high' };
  }

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${openAiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI merged draft failed (${response.status}): ${errorText}`);
  }

  const payload = await response.json() as OpenAIResponsesPayload;
  const content = extractResponseText(payload);
  if (!content) throw new Error('OpenAI merged draft returned empty content');

  let parsed: Partial<MergedThoughtDraft>;
  try {
    parsed = JSON.parse(stripJsonFence(content)) as Partial<MergedThoughtDraft>;
  } catch {
    throw new Error(`OpenAI merged draft returned invalid JSON: ${content.slice(0, 500)}`);
  }

  return { draft: normalizeDraft(parsed, flowId, flowTitle, notes, now), model };
}

async function requestMergedDraftWithChatCompletions(
  openAiKey: string,
  model: string,
  flowId: string,
  flowTitle: string,
  notes: Required<SourceNote>[],
  now: string,
): Promise<{ draft: MergedThoughtDraft; model: string }> {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${openAiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      temperature: 0.35,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content:
            '당신은 흩어진 원본 메모를 문단별로 읽기 좋은 생각 정리 리포트로 만드는 편집자이다. 먼저 원본들이 같은 중심 문제/의도/재사용 목적을 공유하는지 검사하고, 공통축이 약한 메모는 억지로 본문에 넣지 않는다. 사용자의 입장을 단정하는 오피니언 글을 쓰지 말고, 원문에서 보이는 반복 주제와 생각의 흐름을 보수적으로 정리한다. 반드시 제공된 원본 데이터 안의 내용만 사용하되, 원문은 길게 직접 인용하지 말고 자연스럽게 재서술한다. 반드시 JSON만 출력한다. 원문에 없는 사건, 심리, 시간, 인물, 사례를 만들지 않는다.',
        },
        {
          role: 'user',
          content: buildPrompt(flowTitle, notes),
        },
      ],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI merged draft fallback failed (${response.status}): ${errorText}`);
  }

  const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  const content = payload.choices?.[0]?.message?.content;
  if (!content) throw new Error('OpenAI merged draft fallback returned empty content');

  let parsed: Partial<MergedThoughtDraft>;
  try {
    parsed = JSON.parse(stripJsonFence(content)) as Partial<MergedThoughtDraft>;
  } catch {
    throw new Error(`OpenAI merged draft fallback returned invalid JSON: ${content.slice(0, 500)}`);
  }

  return { draft: normalizeDraft(parsed, flowId, flowTitle, notes, now), model };
}

function buildPrompt(flowTitle: string, notes: Required<SourceNote>[]) {
  const requiredTerms = extractRequiredTerms(flowTitle, notes);
  const noteBlock = notes
    .map((note, index) => [
      `메모 ${index + 1}`,
      `id: ${note.id}`,
      `title: ${note.title}`,
      `createdAt: ${note.createdAt}`,
      'rawText:',
      note.rawText,
    ].join('\n'))
    .join('\n\n---\n\n');

  return [
    `ThoughtFlow 제목: ${flowTitle}`,
    '',
    '다음 메모들은 한 사람이 여러 시점에 남긴 흩어진 생각이다.',
    '아래 원본 메모 내용만 사용한다. 원본에 없는 소재나 사건을 만들지 않는다.',
    '중요: 모든 메모를 반드시 같은 결론으로 합칠 필요는 없다. 먼저 같은 중심 문제/의도/재사용 목적을 공유하는 대표 원문 5~8개를 고르고, 나머지는 반복 패턴이나 보조 근거로만 반영한다.',
    '',
    '참고해야 할 원문 핵심어:',
    requiredTerms.join(', '),
    '',
    '수정 목표:',
    '- 결과물은 오피니언 선언문이 아니라 문단별 생각 정리 리포트다.',
    '- 사용자가 “나는 이렇게 생각한다”고 단정한 것처럼 쓰지 않는다.',
    '- 원문마다 다른 핵심 발견을 써야 한다. 어떤 카드에도 재사용 가능한 고정 철학 문장을 붙이지 않는다.',
    '- 사용자가 모호하게 말한 표현은 원문 근거를 바탕으로 구체적인 문제/대상/선택지/빈칸으로 번역한다.',
    '- 원문에서 반복해서 나온 주제, 생각의 흐름, 관점 변화, 다음 질문을 가독성 있게 정리한다.',
    '- 서로 무관한 생활 기록, 테스트, 오류, 개발 로그를 하나의 철학으로 억지 연결하면 실패다.',
    '- 화면의 주인공은 body 본문이다. body는 보고서처럼 제목 있는 문단으로 읽혀야 한다.',
    '',
    '작성 전 품질 게이트:',
    '1. 각 원본 메모가 같은 중심 질문/판단축/재사용 목적을 공유하는지 먼저 판단한다.',
    '2. 대표 원문 5~8개를 고르고, 공통축이 약한 원문은 보조 패턴으로만 다룬다.',
    '3. “전사 실패”, “쿼터 초과”, “테스트 중” 같은 상태/오류 메모는 생각 리포트의 근거로 쓰지 않는다.',
    '4. 서로 다른 주제의 메모를 “사실은 같은 고민”이라고 포장하지 않는다.',
    '5. 공통축이 약하면 짧고 보수적인 리포트로 작성한다.',
    '',
    '본문 구조:',
    '1. ## 핵심 요약: 반복해서 보이는 핵심 생각을 2~4문장으로 정리한다.',
    '2. ## 반복해서 나온 주제: 원문들이 건드린 문제/주제를 묶어 설명한다.',
    '3. ## 생각의 흐름: 처음 나온 관점, 이후 추가된 관점, 강화/변화된 부분을 설명한다.',
    '4. ## 근거가 된 원문: 직접 인용은 짧게만 하고, 어떤 원문 조각들이 근거인지 재서술한다.',
    '5. ## 다음에 이어볼 질문: 결론을 강요하지 말고 다음 사고 확장 질문을 제안한다.',
    '',
    '규칙:',
    '1. body 첫 문장은 원문 묶음마다 달라야 한다. “이 원문들에서 반복해서 보이는 것은...”, “메모를 쌓는 것보다...”, “잊힌 생각이 다시 돌아오는...” 같은 재사용 문구를 템플릿처럼 쓰지 않는다.',
    '2. “나는 이 문제에 대해 이렇게 생각하게 됐다”처럼 사용자의 결론을 확정하지 않는다.',
    '3. 첫 문장은 반드시 해당 원문에만 있는 구체 명사/대상/상황/선택지를 포함한다.',
    '4. 원문을 길게 직접 인용하지 않는다. 따옴표 안에 원문 문장을 20자 넘게 넣지 않는다.',
    '5. 각 원본 메모를 모두 소진하려 하지 말고, 같은 판단축에 기여하는 메모만 사용한다.',
    '6. 서로 중복되는 내용은 합치고, 충돌하는 내용은 생각 변화/미해결 쟁점으로 표현한다.',
    '7. 없는 사실을 새로 만들지 않는다. 단, 원문에서 비어 있는 부분은 “정해야 할 빈칸/가설/다음 질문”으로 표시한다.',
    '8. 문체는 담백하고 자연스럽게 쓴다.',
    '9. 원본 메모 5개 기준 body는 900~1,600자 정도로 작성한다. 원문이 짧거나 공통축이 약하면 더 짧아도 된다.',
    '',
    '출력은 JSON만 사용한다:',
    '{',
    '  "title": "생각 정리 리포트 제목",',
    '  "body": "문단별 생각 정리 리포트 본문",',
    '  "judgmentSummary": ["반복 주제 1", "생각 흐름 1", "다음 질문 1"]',
    '}',
    '',
    '작성 전 내부적으로 해야 할 일:',
    '- 원본 메모에서 주제/의도/재사용 목적/관점 변화를 먼저 분류한다.',
    '- 비슷한 카테고리의 원문만 중심 근거로 묶는다.',
    '- 출력에는 내부 분석을 쓰지 말고 최종 리포트만 JSON으로 쓴다.',
    '',
    '원본 메모:',
    noteBlock,
  ].join('\n');
}

function extractRequiredTerms(flowTitle: string, notes: Required<SourceNote>[]) {
  const stopwords = new Set([
    '나는', '내가', '이거', '그럼', '이제', '그냥', '그리고', '그런', '대한', '있는', '없는', '해야', '되는', '되면', '같은', '정말', '아니면', '처음', '지금', '자기가', '사용자', '메모',
  ]);
  const text = [flowTitle, ...notes.flatMap((note) => [note.title, note.rawText])].join(' ');
  const terms = Array.from(text.matchAll(/[가-힣A-Za-z0-9]{2,}/g))
    .map((match) => match[0])
    .filter((term) => !stopwords.has(term) && !/^\d+$/.test(term));
  const counts = new Map<string, number>();
  for (const term of terms) counts.set(term, (counts.get(term) ?? 0) + 1);
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .map(([term]) => term)
    .slice(0, 18);
}

function normalizeNotes(notes: SourceNote[]): Required<SourceNote>[] {
  return notes
    .map((note, index) => ({
      id: cleanText(note.id) || `note-${index + 1}`,
      title: cleanText(note.title) || `메모 ${index + 1}`,
      rawText: cleanRawText(note.rawText),
      createdAt: cleanText(note.createdAt) || new Date().toISOString(),
    }))
    .filter((note) => note.rawText.length > 0)
    .slice(0, 20);
}

function normalizeDraft(
  input: Partial<MergedThoughtDraft>,
  flowId: string,
  fallbackTitle: string,
  notes: Required<SourceNote>[],
  now: string,
): MergedThoughtDraft {
  const title = cleanText(input.title) || `${fallbackTitle} 정리 리포트`;
  const body = cleanBody(input.body) || makeFallbackBody(fallbackTitle, notes);
  const judgmentSummary = Array.isArray(input.judgmentSummary)
    ? input.judgmentSummary.map(cleanText).filter(Boolean).slice(0, 5)
    : [];

  return {
    id: `merged-draft-${flowId}-${Date.now()}`,
    flowId,
    title,
    body,
    judgmentSummary: judgmentSummary.length ? judgmentSummary : ['흩어진 원문에서 반복 주제와 생각의 흐름을 정리했다.'],
    sourceNoteIds: notes.map((note) => note.id),
    createdAt: now,
    status: 'draft',
  };
}

function makeFallbackBody(title: string, notes: Required<SourceNote>[]) {
  const sourceSketches = notes.slice(0, 5).map((note) => summarizeRawText(note.rawText));
  const firstSketch = sourceSketches[0] ?? title;
  return [
    `## 핵심 요약\n${makeFallbackCoreSummary(firstSketch, title)}`,
    '',
    `## 반복해서 나온 주제\n${makeFallbackRepeatedTheme(sourceSketches, title)}`,
    '',
    `## 생각의 흐름\n${makeFallbackFlowNarrative(sourceSketches, title)}\n\n## 다음에 이어볼 질문\n${makeFallbackNextQuestion(sourceSketches, title)}`,
  ].join('\n');
}

function cleanText(value: unknown) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
}

function cleanRawText(value: unknown) {
  return typeof value === 'string' ? value.trim().slice(0, 12000) : '';
}

function cleanBody(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function stripJsonFence(value: string) {
  return value.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
}

function isCorruptedKoreanDraft(draft: MergedThoughtDraft) {
  const text = `${draft.title}\n${draft.body}\n${draft.judgmentSummary.join('\n')}`;
  const hangulCount = (text.match(/[가-힣]/g) ?? []).length;
  const questionCount = (text.match(/\?/g) ?? []).length;
  if (text.length < 80) return false;
  return questionCount > 10 || (questionCount > 20 && hangulCount < 10);
}

function isUngroundedDraft(draft: MergedThoughtDraft, notes: Required<SourceNote>[]) {
  const requiredTerms = extractRequiredTerms('', notes).slice(0, 14);
  if (requiredTerms.length < 4) return false;
  const draftText = `${draft.title}\n${draft.body}\n${draft.judgmentSummary.join('\n')}`;
  const matched = requiredTerms.filter((term) => draftText.includes(term));
  const sourceCoverage = notes.filter((note) => noteHasVisibleAnchor(note, draftText)).length;
  return matched.length < Math.min(6, requiredTerms.length) || sourceCoverage < Math.min(2, notes.length);
}

function noteHasVisibleAnchor(note: Required<SourceNote>, draftText: string) {
  const titleTerms = Array.from(`${note.title} ${note.rawText}`.matchAll(/[가-힣A-Za-z0-9]{2,}/g))
    .map((match) => match[0])
    .filter((term) => !['메모', '나는', '내가', '하고', '하는', '있다', '없다', '된다', '해야', '같은', '그런', '이런'].includes(term))
    .slice(0, 10);
  return titleTerms.some((term) => draftText.includes(term));
}

function buildExtractiveMergedDraft(
  flowId: string,
  flowTitle: string,
  notes: Required<SourceNote>[],
  now: string,
): MergedThoughtDraft {
  const title = flowTitle || '생각 정리 리포트';
  const sourceSketches = notes.slice(0, 5).map((note) => summarizeRawText(note.rawText));
  const firstSketch = sourceSketches[0] ?? title;
  const body = [
    `## 핵심 요약\n${makeFallbackCoreSummary(firstSketch, title)}`,
    '',
    `## 반복해서 나온 주제\n${makeFallbackRepeatedTheme(sourceSketches, title)}`,
    '',
    `## 생각의 흐름\n${makeFallbackFlowNarrative(sourceSketches, title)}\n\n## 다음에 이어볼 질문\n${makeFallbackNextQuestion(sourceSketches, title)}`,
  ].join('\n\n');

  return {
    id: `merged-draft-${flowId}-${Date.now()}`,
    flowId,
    title,
    body,
    judgmentSummary: [
      `${title}에 관한 원문 조각을 기준으로 보수적으로 다시 정리했다.`,
      sourceSketches[0] ? `${shortenSentence(sourceSketches[0])}에서 출발한 흐름이다.` : `${title}을 다시 판단할 기준점이 남아 있다.`,
      makeFallbackNextQuestion(sourceSketches, title),
    ],
    sourceNoteIds: notes.map((note) => note.id),
    createdAt: now,
    status: 'draft',
  };
}

function makeFallbackCoreSummary(firstSketch: string, title: string) {
  return `${shortenSentence(firstSketch)} 이 원문들은 ${title}을 바로 결론내리기보다, 다시 판단할 재료를 남긴다.`;
}

function makeFallbackRepeatedTheme(sketches: string[], title: string) {
  const examples = sketches.slice(1, 4);
  if (examples.length >= 2) return `${examples.map(shortenSentence).join(' ')} 여러 원문이 같은 표현을 반복하기보다, ${title}을 서로 다른 장면에서 다시 꺼내고 있다.`;
  if (examples.length === 1) return `${shortenSentence(sketches[0] ?? title)}에 이어 ${shortenSentence(examples[0])}가 붙으면서, ${title}에 대한 확인 지점이 생겼다.`;
  return `${shortenSentence(sketches[0] ?? title)} 하나만으로는 결론을 만들기 어렵지만, 나중에 같은 주제를 비교할 기준점으로 남길 수 있다.`;
}

function makeFallbackFlowNarrative(sketches: string[], title: string) {
  const first = sketches[0] ?? title;
  const second = sketches.find((item) => item !== first) ?? title;
  const last = sketches[sketches.length - 1] ?? second;
  if (sketches.length >= 3) {
    return `첫 원문은 ${shortenSentence(first)} 쪽에서 출발하고, 이어진 원문은 ${shortenSentence(second)} 쪽으로 초점을 옮긴다. 마지막에는 ${shortenSentence(last)} 문제가 남아 있어, ${title}을 다시 판단할 재료가 된다.`;
  }
  if (sketches.length === 2) {
    return `두 원문은 각각 ${shortenSentence(first)}와 ${shortenSentence(second)}를 말한다. 표현은 다르지만 둘 다 ${title}과 이어져 있어 같은 묶음 안에서 비교해볼 만하다.`;
  }
  return `아직 긴 흐름보다는 ${shortenSentence(first)}라는 단일 신호에 가깝다. 다음 원문이 쌓이면 ${title} 관점에서 변화가 생겼는지 비교할 수 있다.`;
}

function makeFallbackNextQuestion(sketches: string[], title: string) {
  const text = sketches.join(' ').toLowerCase();
  if (text.includes('유지보수') || text.includes('운영') || text.includes('관리')) return '이 생각을 실제 유지보수 루틴으로 바꾸려면 가장 먼저 자동화하거나 점검해야 할 부분은 무엇일까?';
  if (/(^|[^a-z])ai([^a-z]|$)|인공지능|gpt/.test(text)) return 'AI가 맡을 일과 사람이 직접 판단해야 할 일을 어디서 나누는 게 좋을까?';
  if (text.includes('음성') || text.includes('녹음') || text.includes('전사')) return '음성으로 남긴 생각이 다시 쓸 수 있는 결과물이 되려면 어떤 정리 단계가 더 필요할까?';
  if (text.includes('ux') || text.includes('ui') || text.includes('화면') || text.includes('사용자')) return '사용자가 이 흐름을 더 자연스럽게 이해하려면 화면에서 무엇을 줄이거나 먼저 보여줘야 할까?';
  return `${title}을 다음 행동으로 바꾸려면 무엇을 먼저 확인해야 할까?`;
}

function shortenSentence(value: string) {
  const cleaned = value.trim().replace(/\s+/g, ' ');
  return cleaned.length > 48 ? `${cleaned.slice(0, 48)}...` : cleaned;
}

function summarizeRawText(value: string) {
  const cleaned = value.trim().replace(/\s+/g, ' ');
  if (cleaned.length <= 95) return cleaned;
  const firstSentence = cleaned.match(/^.{20,120}?[.!?。！？]/)?.[0];
  return (firstSentence ?? cleaned.slice(0, 95)).replace(/[“”"']/g, '').trim();
}

function extractResponseText(payload: OpenAIResponsesPayload) {
  if (typeof payload.output_text === 'string' && payload.output_text.trim()) {
    return payload.output_text;
  }
  for (const item of payload.output ?? []) {
    for (const content of item.content ?? []) {
      if (typeof content.text === 'string' && content.text.trim()) {
        return content.text;
      }
    }
  }
  return '';
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
