import { Note, ThoughtFingerprintSnapshot, ThoughtMeaningGroup, ThoughtPattern, ThoughtTerm, ThoughtTermContext } from './types';

const STOPWORDS = new Set([
  '나는', '내가', '제가', '우리', '이거', '그거', '저거', '그냥', '이제', '지금', '오늘', '내일', '어제',
  '그리고', '근데', '그러면', '그래서', '하지만', '아니면', '일단', '약간', '진짜', '정말', '너무',
  '있는', '없는', '있다', '없다', '한다', '하고', '하면', '해서', '해야', '되는', '되면', '같은', '이런', '그런', '저런',
  '사용자', '메모', '생각', '내용', '부분', '정도', '사람', '것들', '거나', '거나요', '입니다', '합니다', '했다', '됐다',
  'the', 'and', 'for', 'with', 'this', 'that', 'from', 'have', 'will', 'your', 'you', 'are', 'was', 'were', 'not', 'but',
]);

const MEANING_SEEDS: Array<{ label: string; terms: string[]; description: string }> = [
  {
    label: '망각된 생각의 회수',
    terms: ['회수', '꺼내기', '다시', '잊은', '잊었던', '놓친', '저장', '보관', '찾기', '검색'],
    description: '메모를 단순 저장이 아니라 나중에 다시 만나고 재사용하는 흐름으로 보는 경향',
  },
  {
    label: '기획 판단 시스템',
    terms: ['기획', '판단', '기준', '성공률', '구조', '검증', '리뷰', '결정', '선택지'],
    description: '아이디어를 감각이 아니라 판단 기준과 검증 가능한 구조로 바꾸려는 경향',
  },
  {
    label: '생각의 흐름과 성장',
    terms: ['흐름', '자라난', '확장', '반복', '방향', '전환', '이어', '질문', '결론'],
    description: '한 번의 요약보다 여러 기록이 시간에 따라 어떻게 변하는지 보려는 경향',
  },
  {
    label: '빠른 음성 기록 루프',
    terms: ['음성', '녹음', '전사', '요약', '말한', '빠르게', '자동', '질문'],
    description: '떠오른 생각을 입력 부담 없이 빠르게 남기고 AI가 정리하게 하려는 경향',
  },
  {
    label: '제품 습관과 핵심 루프',
    terms: ['루프', '습관', '매일', '사용', '제품', '핵심', '차별점', 'mvp', '시장'],
    description: '기능보다 사용자가 반복하게 되는 행동과 제품의 핵심 루프를 중시하는 경향',
  },
];

export function buildThoughtFingerprintSnapshot(notes: Note[], now = new Date().toISOString()): ThoughtFingerprintSnapshot {
  const activeNotes = notes
    .filter((note) => !note.deleted_at && hasReadableText(note))
    .sort((a, b) => getTime(a.created_at) - getTime(b.created_at));
  const termMap = new Map<string, ThoughtTerm>();
  const contextMap = new Map<string, ThoughtTermContext>();
  const recentCutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;

  for (const note of activeNotes) {
    const rawText = [note.ai_title, note.ai_summary, note.raw_text].filter(Boolean).join('\n');
    const terms = extractThoughtTerms(rawText);
    const uniqueTerms = Array.from(new Set(terms));

    for (const term of terms) {
      const normalizedTerm = normalizeTerm(term);
      const existing = termMap.get(normalizedTerm);
      const sourceNoteIds = existing?.sourceNoteIds ?? [];
      if (!sourceNoteIds.includes(note.id)) sourceNoteIds.push(note.id);
      const noteTime = getTime(note.created_at);
      termMap.set(normalizedTerm, {
        id: `term-${slugify(normalizedTerm)}`,
        term,
        normalizedTerm,
        count: (existing?.count ?? 0) + 1,
        recentCount30d: (existing?.recentCount30d ?? 0) + (noteTime >= recentCutoff ? 1 : 0),
        firstSeenAt: earlier(existing?.firstSeenAt, note.created_at),
        lastSeenAt: later(existing?.lastSeenAt, note.updated_at ?? note.created_at),
        sourceNoteIds,
      });
    }

    const sentence = pickContextSentence(rawText, uniqueTerms);
    for (const normalizedTerm of uniqueTerms.map(normalizeTerm).slice(0, 12)) {
      const key = `${normalizedTerm}:${note.id}`;
      contextMap.set(key, {
        id: `context-${slugify(normalizedTerm)}-${note.id}`,
        termId: `term-${slugify(normalizedTerm)}`,
        noteId: note.id,
        sentence,
        nearbyTerms: uniqueTerms.filter((term) => normalizeTerm(term) !== normalizedTerm).slice(0, 8),
        createdAt: note.created_at,
      });
    }
  }

  const terms = Array.from(termMap.values()).sort(compareTerms).slice(0, 80);
  const contexts = Array.from(contextMap.values()).slice(0, 240);
  const meaningGroups = buildMeaningGroups(terms, activeNotes, now);
  const patterns = buildThoughtPatterns(meaningGroups, terms, now);

  return {
    id: 'local-thought-fingerprint',
    generatedAt: now,
    terms,
    contexts,
    meaningGroups,
    patterns,
  };
}

export function buildPromptPatternContext(patterns: ThoughtPattern[], limit = 3) {
  const selected = patterns
    .filter((pattern) => pattern.confidence >= 0.35 && pattern.sourceNoteIds.length >= 2)
    .sort((a, b) => b.confidence - a.confidence || b.sourceNoteIds.length - a.sourceNoteIds.length)
    .slice(0, limit);
  if (!selected.length) return '';

  return selected
    .map((pattern, index) => [
      `${index + 1}. ${pattern.title}`,
      `   요약: ${pattern.summary}`,
      `   근거 단어: ${pattern.evidenceTerms.slice(0, 8).join(', ')}`,
    ].join('\n'))
    .join('\n');
}

function extractThoughtTerms(text: string) {
  const normalized = text
    .replace(/[\u2018\u2019\u201C\u201D]/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[~!@#$%^&*()_+={}\[\]|\\:;"'<>,.?/`·…]/g, ' ');
  return Array.from(normalized.matchAll(/[가-힣A-Za-z0-9]{2,}/g))
    .map((match) => normalizeTerm(match[0]))
    .filter((term) => term.length >= 2 && term.length <= 20)
    .filter((term) => !STOPWORDS.has(term))
    .filter((term) => !/^\d+$/.test(term));
}

function buildMeaningGroups(terms: ThoughtTerm[], notes: Note[], now: string): ThoughtMeaningGroup[] {
  const groups: ThoughtMeaningGroup[] = [];
  const termsByValue = new Map(terms.map((term) => [term.normalizedTerm, term]));

  for (const seed of MEANING_SEEDS) {
    const matchedTerms = terms.filter((term) => seed.terms.some((seedTerm) => term.normalizedTerm.includes(seedTerm) || seedTerm.includes(term.normalizedTerm)));
    if (matchedTerms.length < 2) continue;
    const sourceNoteIds = unique(matchedTerms.flatMap((term) => term.sourceNoteIds));
    if (sourceNoteIds.length < 2) continue;
    const countSum = matchedTerms.reduce((sum, term) => sum + term.count, 0);
    groups.push({
      id: `meaning-${slugify(seed.label)}`,
      label: seed.label,
      terms: matchedTerms.map((term) => term.normalizedTerm).slice(0, 12),
      description: seed.description,
      sourceNoteIds,
      confidence: clamp(0.35 + matchedTerms.length * 0.08 + sourceNoteIds.length * 0.04 + Math.min(countSum, 20) * 0.01),
      updatedAt: now,
    });
  }

  const topTerms = terms.slice(0, 12).filter((term) => term.count >= 2 && !groups.some((group) => group.terms.includes(term.normalizedTerm)));
  for (const term of topTerms.slice(0, 3)) {
    const related = findRelatedTerms(term, termsByValue, notes).slice(0, 6);
    if (related.length < 2) continue;
    const relatedTerms = [term.normalizedTerm, ...related];
    const sourceNoteIds = unique(relatedTerms.flatMap((value) => termsByValue.get(value)?.sourceNoteIds ?? []));
    if (sourceNoteIds.length < 2) continue;
    groups.push({
      id: `meaning-${slugify(term.normalizedTerm)}`,
      label: `${term.normalizedTerm} 중심 반복 주제`,
      terms: relatedTerms,
      description: `${term.normalizedTerm} 주변에서 함께 반복되는 단어들이 만든 사용자 고유의 관심 묶음`,
      sourceNoteIds,
      confidence: clamp(0.32 + sourceNoteIds.length * 0.04 + relatedTerms.length * 0.05),
      updatedAt: now,
    });
  }

  return groups.sort((a, b) => b.confidence - a.confidence).slice(0, 8);
}

function buildThoughtPatterns(groups: ThoughtMeaningGroup[], terms: ThoughtTerm[], now: string): ThoughtPattern[] {
  const patterns = groups.map((group) => ({
    id: `pattern-${slugify(group.label)}`,
    title: patternTitle(group),
    summary: patternSummary(group),
    evidenceTerms: group.terms,
    sourceNoteIds: group.sourceNoteIds,
    confidence: group.confidence,
    lastUpdatedAt: now,
  }));

  if (!patterns.length && terms.length >= 3) {
    const topTerms = terms.slice(0, 6);
    patterns.push({
      id: 'pattern-repeated-vocabulary',
      title: '반복 어휘를 중심으로 생각을 다시 묶으려는 흐름',
      summary: `최근 메모에서 ${topTerms.slice(0, 4).map((term) => term.normalizedTerm).join(', ')} 같은 단어가 반복된다. 아직 강한 패턴으로 단정하지 말고, 리포트 생성 시 참고 단서로만 사용한다.`,
      evidenceTerms: topTerms.map((term) => term.normalizedTerm),
      sourceNoteIds: unique(topTerms.flatMap((term) => term.sourceNoteIds)),
      confidence: 0.34,
      lastUpdatedAt: now,
    });
  }

  return patterns.sort((a, b) => b.confidence - a.confidence).slice(0, 6);
}

function patternTitle(group: ThoughtMeaningGroup) {
  if (group.label === '망각된 생각의 회수') return '기록을 저장소가 아니라 회수 시스템으로 본다';
  if (group.label === '기획 판단 시스템') return '아이디어를 판단 가능한 구조로 바꾸려 한다';
  if (group.label === '생각의 흐름과 성장') return '생각을 한 번의 결론보다 자라는 흐름으로 본다';
  if (group.label === '빠른 음성 기록 루프') return '떠오른 생각을 빠르게 말하고 AI가 정리하게 하려 한다';
  if (group.label === '제품 습관과 핵심 루프') return '기능보다 반복 행동과 핵심 루프를 중시한다';
  return `${group.label}가 반복해서 드러난다`;
}

function patternSummary(group: ThoughtMeaningGroup) {
  return `${group.description}. 근거 단어는 ${group.terms.slice(0, 6).join(', ')}이며, ${group.sourceNoteIds.length}개 원문에서 반복된다. 단, 리포트 생성에서는 원문과 연결될 때만 참고해야 한다.`;
}

function findRelatedTerms(term: ThoughtTerm, termsByValue: Map<string, ThoughtTerm>, notes: Note[]) {
  const sourceSet = new Set(term.sourceNoteIds);
  const relatedScores = new Map<string, number>();
  for (const note of notes) {
    if (!sourceSet.has(note.id)) continue;
    const terms = unique(extractThoughtTerms([note.ai_title, note.ai_summary, note.raw_text].filter(Boolean).join('\n')));
    for (const candidate of terms) {
      if (candidate === term.normalizedTerm || !termsByValue.has(candidate)) continue;
      relatedScores.set(candidate, (relatedScores.get(candidate) ?? 0) + 1);
    }
  }
  return Array.from(relatedScores.entries())
    .sort((a, b) => b[1] - a[1] || (termsByValue.get(b[0])?.count ?? 0) - (termsByValue.get(a[0])?.count ?? 0))
    .map(([value]) => value);
}

function pickContextSentence(text: string, terms: string[]) {
  const sentences = text.split(/[.!?。！？\n]/).map((item) => item.trim()).filter(Boolean);
  const picked = sentences.find((sentence) => terms.some((term) => sentence.includes(term))) ?? sentences[0] ?? text.trim();
  return picked.length > 140 ? `${picked.slice(0, 140)}…` : picked;
}

function compareTerms(a: ThoughtTerm, b: ThoughtTerm) {
  return b.recentCount30d - a.recentCount30d || b.count - a.count || b.sourceNoteIds.length - a.sourceNoteIds.length || b.normalizedTerm.length - a.normalizedTerm.length;
}

function normalizeTerm(value: string) {
  return value.trim().toLowerCase().replace(/(으로|에서|에게|께서|부터|까지|처럼|보다|만큼|이라|라고|하고|이며|이면|인데|에는|에도|은|는|이|가|을|를|의|에|도|만|로|와|과)$/u, '');
}

function hasReadableText(note: Note) {
  return [note.raw_text, note.ai_title, note.ai_summary].some((value) => typeof value === 'string' && value.trim().length >= 2);
}

function earlier(current: string | undefined, next: string) {
  if (!current) return next;
  return getTime(current) <= getTime(next) ? current : next;
}

function later(current: string | undefined, next: string) {
  if (!current) return next;
  return getTime(current) >= getTime(next) ? current : next;
}

function getTime(value?: string | null) {
  const time = value ? new Date(value).getTime() : 0;
  return Number.isNaN(time) ? 0 : time;
}

function unique<T>(values: T[]) {
  return Array.from(new Set(values));
}

function clamp(value: number) {
  return Math.max(0, Math.min(0.95, value));
}

function slugify(value: string) {
  const slug = value.toLowerCase().replace(/[^가-힣a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return slug || 'item';
}
