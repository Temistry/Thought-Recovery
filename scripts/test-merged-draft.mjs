const url = `${process.env.EXPO_PUBLIC_SUPABASE_URL}/functions/v1/generate-merged-thought-draft`;
const key = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

const body = {
  flowId: 'test-flow',
  title: '잊은 생각을 다시 만나게 하는 앱',
  notes: [
    {
      id: '1',
      title: '메모 앱 방향',
      rawText: '나는 버려지는 아이디어가 없게 만드는 앱을 만들고 싶다. 잊혀진 메모를 다시 떠오르게 해주는 앱이다.',
      createdAt: '2026-06-10T11:06:00Z',
    },
    {
      id: '2',
      title: '세탁소 알림',
      rawText: '오늘 밤 11시 전까지 세탁소에 맡긴 옷을 찾아와야 한다고 말하면 메모가 아니라 일정과 태스크로 들어가야 한다.',
      createdAt: '2026-06-10T11:08:00Z',
    },
    {
      id: '3',
      title: '기획 반성',
      rawText: '말만 하고 기록을 안 하는 모습을 보며 화가 났는데 나도 문서 모양만 남겼지 제대로 된 기획은 없었다.',
      createdAt: '2026-06-02T02:30:00Z',
    },
  ],
};

const res = await fetch(url, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json; charset=utf-8',
    apikey: key,
    Authorization: `Bearer ${key}`,
  },
  body: JSON.stringify(body),
});

console.log(res.status);
const text = await res.text();
console.log(text.slice(0, 3500));
