import { StatusBar } from 'expo-status-bar';
import { Audio, InterruptionModeAndroid, InterruptionModeIOS } from 'expo-av';
import type {
  ExpoSpeechRecognitionErrorEvent,
  ExpoSpeechRecognitionResultEvent,
} from 'expo-speech-recognition/build/ExpoSpeechRecognitionModule.types';
import * as Clipboard from 'expo-clipboard';
import * as FileSystem from 'expo-file-system/legacy';
import * as Haptics from 'expo-haptics';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { decode } from 'base64-arraybuffer';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  AppState,
  Alert,
  Animated,
  Dimensions,
  FlatList,
  KeyboardAvoidingView,
  NativeModules,
  PanResponder,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import type { GestureResponderEvent } from 'react-native';
import type { Session } from '@supabase/supabase-js';

import { createLocalNote, deleteLocalTrashNote, listCachedThoughtDrafts, listCachedThoughtFlows, listLocalNotes, listLocalTrashNotes, listRecentLocalNotes, moveLocalNoteToTrash, readCachedThoughtFingerprint, readLocalKeyValue, rebuildCachedThoughtFingerprint, replaceCachedThoughtFlows, replaceLocalNotes, restoreLocalTrashNote, saveCachedThoughtDraft, searchLocalNotes, updateLocalNote, writeLocalKeyValue } from './src/lib/localNotes';
import { buildPromptPatternContext } from './src/lib/thoughtFingerprint';
import { isSupabaseConfigured, supabase } from './src/lib/supabase';
import { Note, SourceType, ThoughtFingerprintSnapshot } from './src/types';

const AUDIO_BUCKET = 'note-audio';
const AnimatedPressable = Animated.createAnimatedComponent(Pressable);
const RETRIEVAL_FEEDBACK_KEY = 'idea-second-brain:retrieval-feedback';
const COPY_FEEDBACK_MS = 1400;
const ARCHIVE_PAGE_SIZE = 24;
const THOUGHT_FLOW_FINGERPRINT_KEY = 'idea-second-brain:thought-flow-fingerprint:v1';
const SCREEN_WIDTH = Dimensions.get('window').width;
const MAX_RECORDING_MS = 20 * 60 * 1000;

type SpeechRecognitionModule = typeof import('expo-speech-recognition/build/ExpoSpeechRecognitionModule').ExpoSpeechRecognitionModule;

declare const require: (moduleName: string) => { ExpoSpeechRecognitionModule: SpeechRecognitionModule };

let speechRecognitionModuleCache: SpeechRecognitionModule | null | undefined;

function getSpeechRecognitionModule() {
  if (speechRecognitionModuleCache !== undefined) return speechRecognitionModuleCache;

  if (!NativeModules.ExpoSpeechRecognition) {
    speechRecognitionModuleCache = null;
    return speechRecognitionModuleCache;
  }

  try {
    speechRecognitionModuleCache = require('expo-speech-recognition/build/ExpoSpeechRecognitionModule').ExpoSpeechRecognitionModule;
  } catch (error) {
    speechRecognitionModuleCache = null;
  }

  return speechRecognitionModuleCache;
}

async function setExclusiveAudioModeAsync(allowsRecordingIOS: boolean) {
  await Audio.setAudioModeAsync({
    allowsRecordingIOS,
    playsInSilentModeIOS: true,
    interruptionModeIOS: InterruptionModeIOS.DoNotMix,
    interruptionModeAndroid: InterruptionModeAndroid.DoNotMix,
    shouldDuckAndroid: false,
    playThroughEarpieceAndroid: false,
  });
}


type AppTab = 'today' | 'organized' | 'archive';
type VoiceJobStatus = 'saving' | 'uploading' | 'transcribing' | 'done' | 'failed';
type RetrievalFeedbackStatus = 'useful' | 'later' | 'hidden';
type RetrievalFeedbackMap = Record<string, { status: RetrievalFeedbackStatus; updatedAt: string; usedCount: number }>;
type ThoughtProfile = {
  id: string;
  rawText: string;
  title: string;
  summary: string;
  keywords: string[];
  intent: string;
  problem: string;
  situation: string;
  reusePurpose: string;
  decisionAxis: string;
  emotion: string;
  lifeArea: string;
  memoryType: string;
  createdAt: string;
  lastViewedAt?: string | null;
  lastSurfacedAt?: string | null;
  surfacedCount: number;
  usedCount: number;
  hiddenCount: number;
};
type NoteMeaning = ThoughtProfile;
type ConnectionScore = {
  semanticScore: number;
  keywordScore: number;
  intentScore: number;
  problemScore: number;
  reusePurposeScore: number;
  decisionAxisScore: number;
  recencyContextScore: number;
  userFeedbackScore: number;
  total: number;
};
type ConnectionCorpusContext = {
  documentCount: number;
  documentFrequency: Map<string, number>;
};
type RelatedCandidate = {
  note: Note;
  score: number;
  scoreBreakdown: ConnectionScore;
  reasons: string[];
  meaning: NoteMeaning;
};
type ThoughtFlowStatus = 'temporary' | 'saved' | 'expanded';
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
type ThoughtFlow = {
  id: string;
  status: ThoughtFlowStatus;
  title: string;
  noteIds: string[];
  notes: Note[];
  mergedDraft: MergedThoughtDraft;
  synthesis: string;
  sharedProblem: string;
  whyNow: string;
  nextQuestion: string;
  createdAt: string;
  updatedAt: string;
  sharedIntent?: string;
  sharedDecisionAxis?: string;
  confidenceScore?: number;
};
type RetrievalCandidate = {
  note: Note;
  section: 'today' | 'connected' | 'buried' | 'recent';
  surfaceReason: string;
  recentConnection?: string;
  useSuggestion: string;
  connectedNote?: Note;
  connectionReason?: string;
};
type VoiceJob = { status: VoiceJobStatus; message: string; error?: string };
type AudioPlaybackState = { noteId: string; positionMs: number; durationMs: number; loading: boolean; paused: boolean };
type CollectionSummary = {
  id: string;
  title: string;
  description: string;
  notes: Note[];
};
type ArchiveDateGroup = {
  key: string;
  title: string;
  notes: Note[];
};

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [authLoading, setAuthLoading] = useState(false);
  const [notes, setNotes] = useState<Note[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [recording, setRecording] = useState<Audio.Recording | null>(null);
  const [basicTranscriptionActive, setBasicTranscriptionActive] = useState(false);
  const [recordingElapsedMs, setRecordingElapsedMs] = useState(0);
  const [activeTab, setActiveTab] = useState<AppTab>('today');
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  const [selectedNoteOverride, setSelectedNoteOverride] = useState<Note | null>(null);
  const [selectedThoughtFlowId, setSelectedThoughtFlowId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [voiceJobs, setVoiceJobs] = useState<Record<string, VoiceJob>>({});
  const [audioPlayback, setAudioPlayback] = useState<AudioPlaybackState | null>(null);
  const [cachedThoughtFlows, setCachedThoughtFlows] = useState<ThoughtFlow[]>([]);
  const [archivePreviewNotes, setArchivePreviewNotes] = useState<Note[]>([]);
  const [archivePreviewLimit, setArchivePreviewLimit] = useState(ARCHIVE_PAGE_SIZE);
  const [archiveSearchResults, setArchiveSearchResults] = useState<Note[]>([]);
  const [trashNotes, setTrashNotes] = useState<Note[]>([]);
  const [showTrash, setShowTrash] = useState(false);
  const [showAccount, setShowAccount] = useState(false);
  const [retrievalFeedback, setRetrievalFeedback] = useState<RetrievalFeedbackMap>({});
  const [generatedDrafts, setGeneratedDrafts] = useState<Record<string, MergedThoughtDraft>>({});
  const [thoughtFingerprint, setThoughtFingerprint] = useState<ThoughtFingerprintSnapshot | null>(null);
  const [draftGenerationState, setDraftGenerationState] = useState<Record<string, { loading: boolean; error?: string }>>({});
  const [noteRewriteInFlightId, setNoteRewriteInFlightId] = useState<string | null>(null);
  const migrationInFlightRef = useRef(false);
  const routingInFlightRef = useRef(false);
  const recordingRef = useRef<Audio.Recording | null>(null);
  const stoppingRecordingRef = useRef(false);
  const basicTranscriptionRef = useRef({ active: false, transcript: '', audioUri: null as string | null, startedAt: 0 });
  const playbackSoundRef = useRef<Audio.Sound | null>(null);

  const cloudMode = isSupabaseConfigured && supabase !== null;
  const canUseCloud = cloudMode && !!session?.user;
  const userEmail = session?.user?.email ?? '';
  const userInitial = userEmail.trim().charAt(0).toUpperCase() || '나';
  const isCapturingVoice = !!recording || basicTranscriptionActive;

  const statusLabel = useMemo(() => {
    if (!cloudMode) return '로컬 테스트 중';
    if (!session) return '로그인이 필요합니다';
    return '내 생각이 조용히 정리되는 중';
  }, [cloudMode, session]);

  const feedNotes = useMemo(() => notes.filter((note) => !note.parent_note_id), [notes]);
  const activityNotes = useMemo(
    () => [...notes].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()),
    [notes],
  );
  const filteredNotes = useMemo(() => filterNotes(activityNotes, searchQuery), [activityNotes, searchQuery]);
  const archiveSourceNotes = searchQuery.trim() ? archiveSearchResults : (archivePreviewNotes.length ? archivePreviewNotes : filteredNotes);
  const archiveGroups = useMemo(() => groupNotesByDate(archiveSourceNotes), [archiveSourceNotes]);
  const thoughtFlowFingerprint = useMemo(() => computeThoughtFlowFingerprint(feedNotes, retrievalFeedback), [feedNotes, retrievalFeedback]);
  const retrievalSections = useMemo(() => buildRetrievalSections(feedNotes, retrievalFeedback), [feedNotes, retrievalFeedback]);
  const draftRestoredThoughtFlows = useMemo(
    () => buildThoughtFlowsFromDrafts(generatedDrafts, feedNotes),
    [generatedDrafts, feedNotes],
  );
  const visibleThoughtFlows = useMemo(
    () => mergeThoughtFlows(retrievalSections.thoughtFlows, mergeThoughtFlows(draftRestoredThoughtFlows, cachedThoughtFlows)),
    [retrievalSections.thoughtFlows, draftRestoredThoughtFlows, cachedThoughtFlows],
  );
  const visibleThoughtFlowsWithDrafts = useMemo(
    () => visibleThoughtFlows.map((flow) => generatedDrafts[flow.id] ? { ...flow, title: generatedDrafts[flow.id].title || flow.title, mergedDraft: generatedDrafts[flow.id] } : flow),
    [visibleThoughtFlows, generatedDrafts],
  );
  const selectedThoughtFlow = useMemo(() => {
    return visibleThoughtFlowsWithDrafts.find((item) => item.id === selectedThoughtFlowId)
      ?? cachedThoughtFlows.find((item) => item.id === selectedThoughtFlowId)
      ?? null;
  }, [visibleThoughtFlowsWithDrafts, cachedThoughtFlows, selectedThoughtFlowId]);
  const selectedNote = useMemo(
    () => selectedNoteOverride ?? notes.find((note) => note.id === selectedNoteId) ?? null,
    [notes, selectedNoteId, selectedNoteOverride],
  );
  const selectedNoteLogs = useMemo(() => {
    if (!selectedNote) return [];
    const rootId = selectedNote.parent_note_id ?? selectedNote.id;
    const root = notes.find((note) => note.id === rootId) ?? selectedNote;
    return [root, ...notes.filter((note) => note.parent_note_id === rootId)]
      .filter((note, index, all) => all.findIndex((item) => item.id === note.id) === index)
      .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  }, [notes, selectedNote]);

  const loadNotes = useCallback(async () => {
    setLoading(true);
    try {
      if (canUseCloud && supabase) {
        const { data, error } = await supabase
          .from('notes')
          .select('*')
          .order('created_at', { ascending: false });
        if (error) throw error;
        const activeRows = ((data ?? []) as Note[]).filter((note) => !note.deleted_at);
        setNotes(activeRows);
        void replaceLocalNotes(activeRows).catch(() => undefined);
      } else {
        setNotes(await listRecentLocalNotes(120));
      }
    } catch (error) {
      showError('메모를 불러오지 못했어요', error);
    } finally {
      setLoading(false);
    }
  }, [canUseCloud]);

  useEffect(() => {
    if (!supabase) {
      void loadNotes();
      return;
    }

    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: listener } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
    });

    return () => listener.subscription.unsubscribe();
  }, [loadNotes]);

  useEffect(() => {
    void loadNotes();
  }, [loadNotes, session?.user?.id]);

  useEffect(() => {
    let cancelled = false;
    readCachedThoughtFingerprint()
      .then((snapshot) => {
        if (!cancelled && snapshot) setThoughtFingerprint(snapshot);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    listCachedThoughtDrafts()
      .then((drafts) => {
        if (!cancelled) setGeneratedDrafts(drafts);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      rebuildCachedThoughtFingerprint(feedNotes)
        .then((snapshot) => {
          if (!cancelled) setThoughtFingerprint(snapshot);
        })
        .catch(() => undefined);
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [feedNotes]);

  useEffect(() => {
    let cancelled = false;
    if (activeTab !== 'organized') return;
    Promise.all([listCachedThoughtFlows(), readLocalKeyValue<string>(THOUGHT_FLOW_FINGERPRINT_KEY)])
      .then(([flows, storedFingerprint]) => {
        if (cancelled) return;
        if (storedFingerprint === thoughtFlowFingerprint && flows.length > 0) {
          setCachedThoughtFlows(flows as ThoughtFlow[]);
        }
      })
      .catch(() => {
        // SQLite cache is a fast preview; computed flows below remain the source of truth.
      });
    return () => {
      cancelled = true;
    };
  }, [activeTab, thoughtFlowFingerprint]);

  useEffect(() => {
    const nextFlows = mergeThoughtFlows(retrievalSections.thoughtFlows, mergeThoughtFlows(draftRestoredThoughtFlows, cachedThoughtFlows));
    if (nextFlows.length === 0) return;
    setCachedThoughtFlows(nextFlows);
    void Promise.all([
      replaceCachedThoughtFlows(nextFlows),
      writeLocalKeyValue(THOUGHT_FLOW_FINGERPRINT_KEY, thoughtFlowFingerprint),
    ]).catch(() => undefined);
  }, [retrievalSections.thoughtFlows, draftRestoredThoughtFlows, thoughtFlowFingerprint]);

  useEffect(() => {
    let cancelled = false;
    if (activeTab !== 'archive') return;
    if (searchQuery.trim()) {
      searchLocalNotes(searchQuery, 80).then((rows) => {
        if (!cancelled) setArchiveSearchResults(rows);
      }).catch(() => undefined);
      return () => { cancelled = true; };
    }
    listRecentLocalNotes(archivePreviewLimit).then((rows) => {
      if (!cancelled) setArchivePreviewNotes(rows);
    }).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [activeTab, searchQuery, archivePreviewLimit]);

  useEffect(() => {
    return () => {
      void playbackSoundRef.current?.unloadAsync();
    };
  }, []);


  useEffect(() => {
    void loadRetrievalFeedback();
  }, []);

  useEffect(() => {
    if (canUseCloud) {
      void migrateLocalNotesToCloud();
    }
  }, [canUseCloud, session?.user?.id]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'background' || nextState === 'inactive') {
        void routePendingNotes({ skipSelected: true });
      }
    });

    return () => subscription.remove();
  }, [notes, selectedNoteId, canUseCloud, session?.user?.id]);

  async function signInWithPassword() {
    if (!supabase) return;
    const cleanEmail = email.trim();
    if (!cleanEmail || !password) {
      Alert.alert('입력 필요', '이메일과 비밀번호를 입력해주세요.');
      return;
    }

    setAuthLoading(true);
    try {
      const { error } = await supabase.auth.signInWithPassword({
        email: cleanEmail,
        password,
      });
      if (error) throw error;
      setPassword('');
    } catch (error) {
      showError('로그인 실패', error);
    } finally {
      setAuthLoading(false);
    }
  }

  async function signUpWithPassword() {
    if (!supabase) return;
    const cleanEmail = email.trim();
    if (!cleanEmail || !password) {
      Alert.alert('입력 필요', '이메일과 비밀번호를 입력해주세요.');
      return;
    }
    if (password.length < 6) {
      Alert.alert('비밀번호 확인', '비밀번호는 6자 이상이어야 합니다.');
      return;
    }

    setAuthLoading(true);
    try {
      const { data, error } = await supabase.auth.signUp({
        email: cleanEmail,
        password,
      });
      if (error) throw error;
      if (!data.session) {
        Alert.alert('가입됨', 'Supabase에서 Confirm email이 켜져 있으면 바로 로그인되지 않습니다. Confirm email을 끄고 다시 로그인해주세요.');
      }
      setPassword('');
    } catch (error) {
      showError('계정 만들기 실패', error);
    } finally {
      setAuthLoading(false);
    }
  }

  async function migrateLocalNotesToCloud() {
    if (!supabase || !session?.user || migrationInFlightRef.current) return;
    migrationInFlightRef.current = true;

    try {
      const migrationKey = `idea-second-brain:migrated:${session.user.id}`;
      const alreadyMigrated = await AsyncStorage.getItem(migrationKey);
      if (alreadyMigrated) return;

      const localNotes = await listLocalNotes();
      if (localNotes.length === 0) {
        await AsyncStorage.setItem(migrationKey, new Date().toISOString());
        return;
      }

      const rows = localNotes.map((note) => ({
        user_id: session.user.id,
        raw_text: note.raw_text,
        source_type: note.source_type,
        audio_url: note.audio_url ?? null,
        ai_title: note.ai_title ?? makeDraftTitle(note.raw_text),
        ai_summary: note.ai_summary ?? makeDraftSummary(note.raw_text),
        ai_tags: note.ai_tags ?? [],
        created_at: note.created_at,
      }));

      const { error } = await supabase.from('notes').insert(rows);
      if (error) throw error;
      await AsyncStorage.setItem(migrationKey, new Date().toISOString());
      await loadNotes();
    } catch (error) {
      showError('로컬 메모 이전 실패', error);
    } finally {
      migrationInFlightRef.current = false;
    }
  }

  async function signOut() {
    if (!supabase) return;
    await supabase.auth.signOut();
    setNotes(await listRecentLocalNotes(120));
    setActiveTab('today');
    setSelectedNoteId(null);
    setShowAccount(false);
  }

  async function loadRetrievalFeedback() {
    try {
      const raw = await AsyncStorage.getItem(RETRIEVAL_FEEDBACK_KEY);
      setRetrievalFeedback(raw ? JSON.parse(raw) as RetrievalFeedbackMap : {});
    } catch {
      setRetrievalFeedback({});
    }
  }

  async function markRetrievalFeedback(noteId: string, status: RetrievalFeedbackStatus) {
    const next: RetrievalFeedbackMap = {
      ...retrievalFeedback,
      [noteId]: {
        status,
        updatedAt: new Date().toISOString(),
        usedCount: status === 'useful' ? (retrievalFeedback[noteId]?.usedCount ?? 0) + 1 : (retrievalFeedback[noteId]?.usedCount ?? 0),
      },
    };
    setRetrievalFeedback(next);
    await AsyncStorage.setItem(RETRIEVAL_FEEDBACK_KEY, JSON.stringify(next));
  }

  async function createNote(rawText: string, sourceType: SourceType, audioUrl?: string | null, audioDurationMs?: number | null): Promise<Note | null> {
    const trimmed = rawText.trim();
    if (!trimmed) return null;

    setSaving(true);
    try {
      if (canUseCloud && supabase) {
        const { data, error } = await supabase
          .from('notes')
          .insert({
            user_id: session.user.id,
            raw_text: trimmed,
            source_type: sourceType,
            audio_url: audioUrl && !isLocalAudioUri(audioUrl) ? audioUrl : null,
            ai_title: makeDraftTitle(trimmed),
            ai_summary: makeDraftSummary(trimmed),
            ai_tags: [],
            routing_status: 'pending_review',
          })
          .select('*')
          .single();
        if (error) throw error;
        const createdNote = {
          ...(data as Note),
          local_audio_url: audioUrl && isLocalAudioUri(audioUrl) ? audioUrl : (data as Note).local_audio_url ?? null,
          audio_duration_ms: audioDurationMs ?? (data as Note).audio_duration_ms ?? null,
        };
        setNotes((prev) => [createdNote, ...prev]);
        return createdNote;
      }

      const note = await createLocalNote(trimmed, sourceType, audioUrl, { audioDurationMs });
      setNotes((prev) => [note, ...prev]);
      return note;
    } catch (error) {
      if (sourceType === 'voice' || isNetworkRequestFailure(error)) {
        try {
          const localNote = await createLocalNote(trimmed, sourceType, audioUrl, { audioDurationMs });
          setNotes((prev) => [localNote, ...prev]);
          if (sourceType === 'voice') {
            setVoiceJob(
              localNote.id,
              'failed',
              '클라우드 저장 실패 · 원본은 보관됨',
              '네트워크가 안정되면 다시 시도할 수 있어요.',
            );
          }
          return localNote;
        } catch (localError) {
          showError('메모 저장 실패', localError);
          return null;
        }
      }

      showError('메모 저장 실패', error);
      return null;
    } finally {
      setSaving(false);
    }
  }

  async function toggleVoiceCapture() {
    if (isCapturingVoice) {
      if (basicTranscriptionRef.current.active) {
        await stopBasicTranscription();
        return;
      }
      await stopRecording();
      return;
    }

    await startBasicTranscription();
  }

  async function startRecording() {
    if (recordingRef.current || stoppingRecordingRef.current) return;
    try {
      const permission = await Audio.requestPermissionsAsync();
      if (!permission.granted) {
        Alert.alert('마이크 권한 필요', '음성 메모를 위해 마이크 권한을 허용해주세요.');
        return;
      }

      await setExclusiveAudioModeAsync(true);
      const result = await Audio.Recording.createAsync(Audio.RecordingOptionsPresets.HIGH_QUALITY);
      recordingRef.current = result.recording;
      setRecording(result.recording);
      setRecordingElapsedMs(0);
    } catch (error) {
      recordingRef.current = null;
      setRecording(null);
      setRecordingElapsedMs(0);
      showError('녹음 시작 실패', error);
    }
  }

  async function stopRecording() {
    const activeRecording = recordingRef.current ?? recording;
    if (!activeRecording || stoppingRecordingRef.current) return;
    stoppingRecordingRef.current = true;
    try {
      let durationMs = recordingElapsedMs;
      try {
        const currentStatus = await activeRecording.getStatusAsync();
        durationMs = currentStatus.durationMillis ?? durationMs;
      } catch {}
      await activeRecording.stopAndUnloadAsync();
      try {
        const finalStatus = await activeRecording.getStatusAsync();
        durationMs = finalStatus.durationMillis ?? durationMs;
      } catch {}
      const uri = activeRecording.getURI();
      recordingRef.current = null;
      setRecording(null);
      setRecordingElapsedMs(0);
      const note = await createNote('음성 메모를 저장하는 중입니다.', 'voice', uri, durationMs || null);
      if (note && uri && canUseCloud && canUploadVoiceNote(note)) {
        setVoiceJob(note.id, 'saving', '음성을 저장하는 중');
        await uploadAndTranscribeVoice(note.id, uri);
      } else if (note && !canUseCloud) {
        setNotes((prev) =>
          prev.map((item) =>
            item.id === note.id
              ? {
                  ...item,
                  ai_title: '음성 메모',
                  ai_summary: '클라우드 로그인 후 STT 전사를 사용할 수 있어요.',
                  ai_tags: ['음성'],
                }
              : item,
          ),
        );
      }
    } catch (error) {
      recordingRef.current = null;
      setRecording(null);
      setRecordingElapsedMs(0);
      showError('녹음 저장 실패', error);
    } finally {
      stoppingRecordingRef.current = false;
    }
  }

  async function startBasicTranscription() {
    if (basicTranscriptionRef.current.active || recordingRef.current || stoppingRecordingRef.current) return;
    const speechRecognition = getSpeechRecognitionModule();
    if (!speechRecognition) {
      await startRecording();
      return;
    }

    try {
      const available = speechRecognition.isRecognitionAvailable();
      if (!available) {
        Alert.alert('기본 전사 사용 불가', '이 기기에서 기본 음성 인식을 사용할 수 없어요. 기존 녹음 저장으로 진행합니다.');
        await startRecording();
        return;
      }

      const permission = await speechRecognition.requestPermissionsAsync();
      if (!permission.granted) {
        Alert.alert('음성 인식 권한 필요', '기본 전사를 위해 마이크와 음성 인식 권한을 허용해주세요.');
        return;
      }

      await stopOriginalAudio();
      basicTranscriptionRef.current = { active: true, transcript: '', audioUri: null, startedAt: Date.now() };
      setBasicTranscriptionActive(true);
      setRecordingElapsedMs(0);
      speechRecognition.start({
        lang: 'ko-KR',
        interimResults: true,
        continuous: true,
        addsPunctuation: true,
        iosTaskHint: 'dictation',
        recordingOptions: {
          persist: true,
          outputFileName: `basic-transcription-${Date.now()}.caf`,
        },
      });
    } catch (error) {
      basicTranscriptionRef.current = { active: false, transcript: '', audioUri: null, startedAt: 0 };
      setBasicTranscriptionActive(false);
      setRecordingElapsedMs(0);
      showError('기본 전사 시작 실패', error);
    }
  }

  async function stopBasicTranscription() {
    if (!basicTranscriptionRef.current.active || stoppingRecordingRef.current) return;
    stoppingRecordingRef.current = true;
    try {
      const speechRecognition = getSpeechRecognitionModule();
      if (speechRecognition) {
        speechRecognition.stop();
      } else {
        await finishBasicTranscriptionCapture();
      }
    } catch (error) {
      await finishBasicTranscriptionCapture();
    } finally {
      stoppingRecordingRef.current = false;
    }
  }

  async function finishBasicTranscriptionCapture(errorMessage?: string) {
    const current = basicTranscriptionRef.current;
    if (!current.active) return;

    const durationMs = current.startedAt ? Date.now() - current.startedAt : recordingElapsedMs;
    const transcript = current.transcript.trim();
    const audioUri = current.audioUri;
    basicTranscriptionRef.current = { active: false, transcript: '', audioUri: null, startedAt: 0 };
    setBasicTranscriptionActive(false);
    setRecordingElapsedMs(0);

    const rawText = transcript || (errorMessage ? '기본 전사에 실패했지만 음성은 저장했어요.' : '기본 전사 결과가 비어 있어요.');
    const note = await createNote(rawText, 'voice', audioUri, durationMs || null);
    if (!note) return;

    const basicPatch = transcript
      ? {
          ai_title: makeDraftTitle(transcript),
          ai_summary: 'iOS 기본 음성 인식으로 만든 기본 전사입니다.',
          ai_tags: inferTagsFromText(transcript, 'voice'),
        }
      : {
          ai_title: '기본 전사 확인 필요',
          ai_summary: errorMessage ?? '기본 전사 결과가 비어 있어요. 원본 음성을 듣고 직접 수정할 수 있습니다.',
          ai_tags: ['음성', '전사 확인'],
        };

    const updated = await updateLocalNote(note.id, basicPatch).catch(() => null);
    setNotes((prev) => prev.map((item) => (item.id === note.id ? { ...item, ...basicPatch, ...(updated ?? {}) } : item)));

    if (note && audioUri && canUseCloud && canUploadVoiceNote(note)) {
      setVoiceJob(note.id, 'transcribing', 'Pro AI 전사도 이어서 확인하는 중');
      await uploadAndTranscribeVoice(note.id, audioUri);
    }
  }

  useEffect(() => {
    const speechRecognition = getSpeechRecognitionModule();
    if (!speechRecognition) return undefined;

    const resultSubscription = speechRecognition.addListener('result', (event: ExpoSpeechRecognitionResultEvent) => {
      const transcript = event.results[0]?.transcript?.trim();
      if (!transcript) return;
      basicTranscriptionRef.current = { ...basicTranscriptionRef.current, transcript };
    });
    const audioEndSubscription = speechRecognition.addListener('audioend', (event: { uri: string | null }) => {
      if (event.uri) basicTranscriptionRef.current = { ...basicTranscriptionRef.current, audioUri: event.uri };
    });
    const errorSubscription = speechRecognition.addListener('error', (event: ExpoSpeechRecognitionErrorEvent) => {
      if (!basicTranscriptionRef.current.active) return;
      void finishBasicTranscriptionCapture(event.message || event.error);
    });
    const endSubscription = speechRecognition.addListener('end', () => {
      if (!basicTranscriptionRef.current.active) return;
      void finishBasicTranscriptionCapture();
    });

    return () => {
      resultSubscription.remove();
      audioEndSubscription.remove();
      errorSubscription.remove();
      endSubscription.remove();
    };
  }, [canUseCloud]);

  useEffect(() => {
    if (!recording && !basicTranscriptionActive) return;
    let cancelled = false;
    const timer = setInterval(() => {
      if (basicTranscriptionActive) {
        const startedAt = basicTranscriptionRef.current.startedAt;
        const durationMs = startedAt ? Date.now() - startedAt : 0;
        setRecordingElapsedMs(durationMs);
        if (durationMs >= MAX_RECORDING_MS) {
          void stopBasicTranscription();
        }
        return;
      }

      const current = recordingRef.current;
      if (!current || stoppingRecordingRef.current) return;
      current.getStatusAsync()
        .then((status) => {
          if (cancelled) return;
          const durationMs = status.durationMillis ?? 0;
          setRecordingElapsedMs(durationMs);
          if (durationMs >= MAX_RECORDING_MS) {
            void stopRecording();
          }
        })
        .catch(() => undefined);
    }, 300);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [recording, basicTranscriptionActive]);

  async function updateNoteText(noteId: string, nextText: string) {
    const trimmed = nextText.trim();
    if (!trimmed) {
      Alert.alert('내용 필요', '생각 원문을 비워둘 수는 없어요.');
      return;
    }

    setSaving(true);
    try {
      const current = notes.find((note) => note.id === noteId);
      const nextPatch = {
        raw_text: trimmed,
        ai_title: makeDraftTitle(trimmed),
        ai_summary: makeDraftSummary(trimmed),
        ai_tags: inferTagsFromText(trimmed, current?.source_type ?? 'text'),
      };

      if (canUseCloud && supabase) {
        const { data, error } = await supabase
          .from('notes')
          .update(nextPatch)
          .eq('id', noteId)
          .select('*')
          .single();
        if (error) throw error;
        const updated = data as Note;
        setNotes((prev) => prev.map((note) => (note.id === noteId ? updated : note)));
        await routeNote(noteId);
      } else {
        const updated = await updateLocalNote(noteId, nextPatch);
        setNotes((prev) => prev.map((note) => (note.id === noteId && updated ? updated : note)));
      }
    } catch (error) {
      showError('생각 수정 실패', error);
    } finally {
      setSaving(false);
    }
  }

  async function togglePinNote(noteId: string) {
    if (!supabase || !session?.user) return;
    const current = notes.find((note) => note.id === noteId);
    if (!current) return;

    setSaving(true);
    try {
      const { data, error } = await supabase
        .from('notes')
        .update({ is_pinned: !current.is_pinned })
        .eq('id', noteId)
        .select('*')
        .single();
      if (error) throw error;
      const updated = data as Note;
      setNotes((prev) => prev.map((note) => (note.id === noteId ? updated : note)));
    } catch (error) {
      showError('고정 상태 변경 실패', error);
    } finally {
      setSaving(false);
    }
  }

  async function detachLogNote(log: Note) {
    if (!supabase || !session?.user || !log.parent_note_id) return;

    setSaving(true);
    try {
      const { data, error } = await supabase
        .from('notes')
        .update({
          parent_note_id: null,
          ai_thread_reason: '사용자가 기존 생각에서 분리했습니다.',
          ai_thread_confidence: null,
          routing_status: 'routed',
          is_pinned: false,
        })
        .eq('id', log.id)
        .select('*')
        .single();
      if (error) throw error;
      const updated = data as Note;
      setNotes((prev) => prev.map((note) => (note.id === log.id ? updated : note)));
      await loadNotes();
    } catch (error) {
      showError('원문 분리 실패', error);
    } finally {
      setSaving(false);
    }
  }

  function requestDeleteNote(note: Note) {
    Alert.alert('휴지통으로 이동', '이 생각을 보관함에서 숨기고 휴지통으로 옮길까요?', [
      { text: '취소', style: 'cancel' },
      { text: '휴지통으로', style: 'destructive', onPress: () => void moveNoteToTrash(note) },
    ]);
  }

  async function moveNoteToTrash(noteToTrash: Note) {
    setSaving(true);
    try {
      const deletedAt = new Date().toISOString();
      const idsToTrash = new Set([
        noteToTrash.id,
        ...notes.filter((note) => note.parent_note_id === noteToTrash.id).map((note) => note.id),
      ]);
      const targetNotes = notes.filter((note) => idsToTrash.has(note.id));
      if (!targetNotes.some((note) => note.id === noteToTrash.id)) targetNotes.push(noteToTrash);
      const targetIds = Array.from(idsToTrash);

      if (canUseCloud && supabase) {
        const cloudIds = targetIds.filter((id) => !id.startsWith('local-'));
        if (cloudIds.length > 0) {
          const { data, error } = await supabase
            .from('notes')
            .update({ deleted_at: deletedAt })
            .in('id', cloudIds)
            .select('id');
          if (error) throw error;
          if (!data || data.length === 0) throw new Error('삭제할 메모를 찾지 못했어요. 잠시 후 다시 불러와서 확인해주세요.');
        }
      }

      await Promise.all(targetNotes.map((note) => moveLocalNoteToTrash({ ...note, deleted_at: deletedAt }).catch(() => undefined)));
      setNotes((prev) => prev.filter((note) => !idsToTrash.has(note.id)));
      setArchivePreviewNotes((prev) => prev.filter((note) => !idsToTrash.has(note.id)));
      setArchiveSearchResults((prev) => prev.filter((note) => !idsToTrash.has(note.id)));
      setSelectedNoteId(null);
      setSelectedNoteOverride(null);
      await loadNotes();
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
    } catch (error) {
      showError('휴지통 이동 실패', error);
    } finally {
      setSaving(false);
    }
  }

  async function openTrash() {
    const localTrash = await listLocalTrashNotes();
    if (canUseCloud && supabase) {
      const { data, error } = await supabase
        .from('notes')
        .select('*')
        .not('deleted_at', 'is', null)
        .order('deleted_at', { ascending: false });
      if (error) {
        showError('휴지통 불러오기 실패', error);
        setTrashNotes(localTrash);
        setShowTrash(true);
        return;
      }
      const merged = [...((data ?? []) as Note[]), ...localTrash]
        .filter((note, index, all) => all.findIndex((item) => item.id === note.id) === index);
      setTrashNotes(merged);
    } else {
      setTrashNotes(localTrash);
    }
    setShowTrash(true);
  }

  async function restoreTrashNote(noteId: string) {
    const target = trashNotes.find((note) => note.id === noteId);
    let restored = await restoreLocalTrashNote(noteId);

    if (canUseCloud && supabase && target && !noteId.startsWith('local-')) {
      const { data, error } = await supabase
        .from('notes')
        .update({ deleted_at: null })
        .eq('id', noteId)
        .select('*')
        .single();
      if (error) {
        showError('휴지통 복원 실패', error);
        return;
      }
      restored = data as Note;
      await deleteLocalTrashNote(noteId).catch(() => undefined);
    }

    if (!restored) return;
    setTrashNotes((prev) => prev.filter((note) => note.id !== noteId));
    setNotes((prev) => [restored, ...prev].filter((note, index, all) => all.findIndex((item) => item.id === note.id) === index));
    setArchivePreviewNotes((prev) => [restored, ...prev].filter((note, index, all) => all.findIndex((item) => item.id === note.id) === index).slice(0, archivePreviewLimit));
  }

  async function permanentlyDeleteTrashNote(noteId: string) {
    const targetIds = new Set([
      noteId,
      ...trashNotes.filter((note) => note.parent_note_id === noteId).map((note) => note.id),
    ]);
    const targets = trashNotes.filter((note) => targetIds.has(note.id));

    if (canUseCloud && supabase) {
      const cloudTargets = targets.filter((note) => !note.id.startsWith('local-'));
      const audioPaths = cloudTargets
        .map((note) => note.audio_url)
        .filter((value): value is string => !!value && !isLocalAudioUri(value) && !value.startsWith('http://') && !value.startsWith('https://'));
      if (audioPaths.length > 0) {
        const { error: storageError } = await supabase.storage.from(AUDIO_BUCKET).remove(audioPaths);
        if (storageError) throw storageError;
      }
      const cloudIds = cloudTargets.map((note) => note.id);
      if (cloudIds.length > 0) {
        const { error: deleteError } = await supabase.from('notes').delete().in('id', cloudIds);
        if (deleteError) throw deleteError;
      }
    }

    await Promise.all(Array.from(targetIds).map((id) => deleteLocalTrashNote(id).catch(() => undefined)));
    setTrashNotes((prev) => prev.filter((note) => !targetIds.has(note.id)));
  }

  function setVoiceJob(noteId: string, status: VoiceJobStatus, message: string, error?: string) {
    setVoiceJobs((prev) => ({ ...prev, [noteId]: { status, message, error } }));
  }

  async function retryVoiceTranscription(note: Note) {
    const audioRef = note.local_audio_url ?? note.audio_url;
    if (!audioRef) {
      Alert.alert('재시도 불가', '재시도할 음성 파일 정보가 없어요.');
      return;
    }
    if (!canUploadVoiceNote(note)) {
      Alert.alert('클라우드 저장 필요', '이 녹음은 기기에 안전하게 보관되어 있어요. 클라우드 동기화가 먼저 복구되면 AI 전사를 다시 시도할 수 있습니다.');
      return;
    }

    await uploadAndTranscribeVoice(note.id, audioRef);
  }

  async function resolvePlayableAudioUri(audioRef: string) {
    if (isLocalAudioUri(audioRef) || audioRef.startsWith('http://') || audioRef.startsWith('https://')) return audioRef;
    if (!supabase) return audioRef;
    const { data, error } = await supabase.storage.from(AUDIO_BUCKET).createSignedUrl(audioRef, 60 * 10);
    if (error) throw error;
    return data.signedUrl;
  }

  async function playOriginalAudio(note: Note) {
    const audioRef = note.local_audio_url ?? note.audio_url;
    if (!audioRef) {
      Alert.alert('재생 불가', '재생할 원본 음성 파일 정보가 없어요.');
      return;
    }

    try {
      if (audioPlayback?.noteId === note.id && playbackSoundRef.current && audioPlayback.paused) {
        await setExclusiveAudioModeAsync(false);
        await playbackSoundRef.current.playAsync();
        setAudioPlayback((prev) => (prev ? { ...prev, paused: false, loading: false } : prev));
        return;
      }

      await playbackSoundRef.current?.unloadAsync();
      playbackSoundRef.current = null;
      setAudioPlayback({ noteId: note.id, positionMs: 0, durationMs: note.audio_duration_ms ?? 0, loading: true, paused: false });
      await setExclusiveAudioModeAsync(false);
      const uri = await resolvePlayableAudioUri(audioRef);
      const { sound } = await Audio.Sound.createAsync({ uri }, { shouldPlay: true, progressUpdateIntervalMillis: 250 });
      playbackSoundRef.current = sound;
      sound.setOnPlaybackStatusUpdate((status) => {
        if (!status.isLoaded) return;
        setAudioPlayback({
          noteId: note.id,
          positionMs: status.positionMillis ?? 0,
          durationMs: status.durationMillis ?? note.audio_duration_ms ?? 0,
          loading: false,
          paused: !status.isPlaying && !status.didJustFinish,
        });
        if (status.didJustFinish) {
          void stopOriginalAudio();
        }
      });
    } catch (error) {
      setAudioPlayback(null);
      showError('원본 음성 재생 실패', error);
    }
  }

  async function pauseOriginalAudio() {
    if (!playbackSoundRef.current) return;
    await playbackSoundRef.current.pauseAsync();
    setAudioPlayback((prev) => (prev ? { ...prev, paused: true, loading: false } : prev));
  }

  async function stopOriginalAudio() {
    const sound = playbackSoundRef.current;
    playbackSoundRef.current = null;
    setAudioPlayback(null);
    if (sound) {
      await sound.stopAsync().catch(() => undefined);
      await sound.unloadAsync().catch(() => undefined);
    }
  }

  async function uploadAndTranscribeVoice(noteId: string, audioRef: string) {
    if (!supabase || !session?.user) return;

    let audioPath = audioRef;
    try {
      if (isLocalAudioUri(audioRef)) {
        setVoiceJob(noteId, 'uploading', '음성을 안전하게 저장하는 중');
        updateVoiceNoteProgress(noteId, {
          raw_text: '음성 메모를 업로드하는 중입니다.',
          ai_title: '음성 저장 중',
          ai_summary: '녹음 파일을 안전하게 보관하고 있어요.',
          ai_tags: ['음성'],
        });

        const extension = getAudioExtension(audioRef);
        audioPath = `${session.user.id}/${noteId}.${extension}`;
        const base64 = await FileSystem.readAsStringAsync(audioRef, {
          encoding: FileSystem.EncodingType.Base64,
        });
        const audioBuffer = decode(base64);

        const { error: uploadError } = await supabase.storage
          .from(AUDIO_BUCKET)
          .upload(audioPath, audioBuffer, {
            contentType: contentTypeForExtension(extension),
            upsert: true,
          });
        if (uploadError) throw uploadError;

        const { error: updateError } = await supabase.from('notes').update({ audio_url: audioPath }).eq('id', noteId);
        if (updateError) throw updateError;
      }

      setVoiceJob(noteId, 'transcribing', 'AI가 받아쓰는 중');
      updateVoiceNoteProgress(noteId, {
        raw_text: '음성 메모를 전사하는 중입니다.',
        ai_title: 'AI 받아쓰기 중',
        ai_summary: '잠시 후 원문과 요약으로 바뀝니다.',
        ai_tags: ['음성'],
        audio_url: audioPath,
      });

      const { data, error: functionError } = await supabase.functions.invoke('transcribe-note', {
        body: { noteId, audioPath },
      });
      if (functionError) {
        throw new Error(await describeFunctionError(functionError));
      }

      const result = data as { text?: string; ai_title?: string; ai_summary?: string; ai_tags?: string[]; error?: string } | null;
      if (result?.error) throw new Error(result.error);

      setVoiceJob(noteId, 'done', '전사 완료');
      setNotes((prev) =>
        prev.map((note) =>
          note.id === noteId
            ? {
                ...note,
                raw_text: result?.text ?? note.raw_text,
                ai_title: result?.ai_title ?? note.ai_title,
                ai_summary: result?.ai_summary ?? note.ai_summary,
                ai_tags: result?.ai_tags ?? note.ai_tags,
                audio_url: audioPath,
              }
            : note,
        ),
      );
      await loadNotes();
    } catch (error) {
      const message = describeUnknownError(error);
      setVoiceJob(noteId, 'failed', '전사 실패 · 다시 시도 가능', message);
      updateVoiceNoteProgress(noteId, {
        ai_title: '음성 전사 실패',
        ai_summary: '원본 음성은 보존했어요. 네트워크나 AI 응답 문제일 수 있으니 다시 시도해보세요.',
        ai_tags: ['음성', '재시도'],
        audio_url: audioPath,
      });
      showError('음성 전사 실패', error);
    }
  }

  function updateVoiceNoteProgress(noteId: string, patch: Partial<Note>) {
    setNotes((prev) => prev.map((note) => (note.id === noteId ? { ...note, ...patch } : note)));
  }


  async function routePendingNotes({ skipSelected }: { skipSelected: boolean }) {
    if (!canUseCloud || !supabase || !session?.user || routingInFlightRef.current) return;

    const pending = notes.filter(
      (note) =>
        note.routing_status === 'pending_review' &&
        !note.parent_note_id &&
        (!skipSelected || note.id !== selectedNoteId),
    );
    if (pending.length === 0) return;

    routingInFlightRef.current = true;
    try {
      for (const note of pending) {
        await routeNote(note.id, { quiet: true });
      }
    } finally {
      routingInFlightRef.current = false;
    }
  }

  function changeTab(nextTab: AppTab) {
    if (nextTab !== activeTab) void Haptics.selectionAsync().catch(() => undefined);
    setActiveTab(nextTab);
    setSelectedNoteId(null);
    if (nextTab !== 'today') {
      void routePendingNotes({ skipSelected: false });
    }
  }

  async function routeNote(noteId: string, options: { quiet?: boolean } = {}) {
    if (!supabase || !session?.user) return;

    try {
      const { data, error } = await supabase.functions.invoke('route-note', {
        body: { noteId },
      });
      if (error) {
        throw new Error(await describeFunctionError(error));
      }

      const result = data as {
        action?: 'append_to_existing' | 'create_new_thread' | 'already_attached';
        note?: Note;
        attached_note_id?: string;
        error?: string;
      } | null;
      if (result?.error) throw new Error(result.error);

      await loadNotes();
    } catch (error) {
      if (!options.quiet) {
        showError('생각 라우팅 실패', error);
      }
      await organizeNote(noteId);
    }
  }

  async function organizeNote(noteId: string) {
    if (!supabase || !session?.user) return;

    try {
      const { data, error } = await supabase.functions.invoke('organize-note', {
        body: { noteId },
      });
      if (error) {
        throw new Error(await describeFunctionError(error));
      }

      const result = data as { note?: Note; title?: string; summary?: string; tags?: string[]; error?: string } | null;
      if (result?.error) throw new Error(result.error);

      if (result?.note) {
        setNotes((prev) => prev.map((note) => (note.id === noteId ? result.note as Note : note)));
        return;
      }

      setNotes((prev) =>
        prev.map((note) =>
          note.id === noteId
            ? {
                ...note,
                ai_title: result?.title ?? note.ai_title,
                ai_summary: result?.summary ?? note.ai_summary,
                ai_tags: result?.tags ?? note.ai_tags,
              }
            : note,
        ),
      );
    } catch (error) {
      showError('AI 정리 실패', error);
    }
  }


  async function generateMergedThoughtDraft(flow: ThoughtFlow) {
    if (!supabase || !session?.user) {
      Alert.alert('로그인 필요', 'AI로 합친 메모 초안을 만들려면 클라우드 로그인이 필요합니다.');
      return;
    }

    setDraftGenerationState((prev) => ({ ...prev, [flow.id]: { loading: true } }));
    try {
      const sourceNotes = flow.notes.map((note) => ({
        id: note.id,
        title: note.ai_title || makeDraftTitle(note.raw_text),
        rawText: note.raw_text,
        createdAt: note.created_at,
      }));
      const latestFingerprint = thoughtFingerprint ?? await rebuildCachedThoughtFingerprint(feedNotes);
      const thoughtPatternContext = buildPromptPatternContext(latestFingerprint.patterns);
      const { data, error } = await supabase.functions.invoke('generate-merged-thought-draft', {
        body: {
          flowId: flow.id,
          title: flow.title,
          sourceNoteIds: sourceNotes.map((note) => note.id),
          notes: sourceNotes,
          thoughtPatternContext,
        },
      });
      if (error) {
        throw new Error(await describeFunctionError(error));
      }

      const result = data as { draft?: MergedThoughtDraft; error?: string } | null;
      if (result?.error) throw new Error(result.error);
      if (!result?.draft) throw new Error('합친 메모 초안 응답이 비어 있어요.');

      const draft = result.draft as MergedThoughtDraft;
      await saveCachedThoughtDraft(draft);
      setGeneratedDrafts((prev) => ({ ...prev, [flow.id]: draft }));
      const savedFlow = { ...flow, title: draft.title || flow.title, mergedDraft: draft, updatedAt: draft.createdAt || flow.updatedAt };
      setCachedThoughtFlows((prev) => mergeThoughtFlows([savedFlow], prev));
      await replaceCachedThoughtFlows(mergeThoughtFlows([savedFlow], cachedThoughtFlows));
      setDraftGenerationState((prev) => ({ ...prev, [flow.id]: { loading: false } }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setDraftGenerationState((prev) => ({ ...prev, [flow.id]: { loading: false, error: message } }));
      showError('합친 메모 초안 생성 실패', error);
    }
  }


  async function rewriteOriginalNote(note: Note) {
    if (!supabase || !session?.user) {
      Alert.alert('로그인 필요', 'AI로 원본 메모를 다시 정리하려면 클라우드 로그인이 필요합니다.');
      return;
    }
    setNoteRewriteInFlightId(note.id);
    try {
      await organizeNote(note.id);
    } finally {
      setNoteRewriteInFlightId(null);
    }
  }

  function renderLoginCard() {
    return (
      <View style={styles.card}>
        <Text style={styles.cardTitle}>내 생각 공간 열기</Text>
        <Text style={styles.helpText}>PC와 모바일에서 같은 생각 기록을 보려면 로그인해주세요.</Text>
        <TextInput
          style={styles.input}
          autoCapitalize="none"
          keyboardType="email-address"
          placeholder="email@example.com"
          value={email}
          onChangeText={setEmail}
        />
        <TextInput
          style={styles.input}
          secureTextEntry
          placeholder="비밀번호 6자 이상"
          value={password}
          onChangeText={setPassword}
        />
        <View style={styles.buttonRow}>
          <Pressable
            disabled={authLoading}
            style={[styles.primaryButton, authLoading && styles.disabledButton]}
            onPress={signInWithPassword}
          >
            <Text style={styles.primaryButtonText}>로그인</Text>
          </Pressable>
          <Pressable disabled={authLoading} style={styles.secondaryButton} onPress={signUpWithPassword}>
            <Text style={styles.secondaryButtonText}>새 계정</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  function renderToday() {
    const todayNotes = activityNotes.filter((note) => isSameLocalDay(note.created_at, new Date()));
    const thoughtFeedNotes = todayNotes.slice(0, 3);

    return (
      <ScrollView contentContainerStyle={styles.todayScrollContent}>
        <AppTopBar title="오늘" />
        <TodayRecorderCard
          recording={isCapturingVoice}
          saving={saving}
          recordingElapsedMs={recordingElapsedMs}
          maxRecordingMs={MAX_RECORDING_MS}
          onToggleRecording={toggleVoiceCapture}
        />

        <View style={styles.todayThoughtSection}>
          <View style={styles.todayThoughtHeader}>
            <Text style={styles.sectionTitle}>오늘 남긴 생각</Text>
            {todayNotes.length > 3 ? (
              <Pressable onPress={() => changeTab('archive')}>
                <Text style={styles.linkButtonText}>전체보기</Text>
              </Pressable>
            ) : null}
          </View>
          {thoughtFeedNotes.length ? (
            thoughtFeedNotes.map((note) => (
              <TodayThoughtMiniCard
                key={note.id}
                note={note}
                voiceJob={voiceJobs[note.id]}
                onPress={() => openNote(note)}
              />
            ))
          ) : (
            <View style={styles.todayEmptyCard}>
              <Text style={styles.todayEmptyTitle}>아직 남긴 생각이 없어요</Text>
              <Text style={styles.todayEmptyBody}>마이크를 누르고 첫 생각을 말해보세요.</Text>
            </View>
          )}
        </View>
      </ScrollView>
    );
  }

  function renderOrganized() {
    return (
      <ScrollView contentContainerStyle={styles.retrievalScrollContent}>
        <AppTopBar title="흐름" />
        <View style={styles.flowMapIntro}>
          <Text style={styles.flowMapIntroText}>생각들이 연결되며 흐름이 자라나요</Text>
        </View>

        <ThoughtFlowSection
          flows={visibleThoughtFlowsWithDrafts}
          onOpenFlow={openThoughtFlow}
          onOpenNote={openNote}
          onGenerateDraft={generateMergedThoughtDraft}
          generationState={draftGenerationState}
          emptyText="아직 자라난 생각을 만들 만큼 이어진 메모가 부족해요. 메모를 조금 더 남기면 생각 리포트가 생겨요."
        />
      </ScrollView>
    );
  }

  function maybeLoadMoreArchive(event: { nativeEvent: { layoutMeasurement: { height: number }; contentOffset: { y: number }; contentSize: { height: number } } }) {
    if (searchQuery.trim()) return;
    if (archivePreviewNotes.length < archivePreviewLimit) return;
    const { layoutMeasurement, contentOffset, contentSize } = event.nativeEvent;
    const distanceFromBottom = contentSize.height - (layoutMeasurement.height + contentOffset.y);
    if (distanceFromBottom < 360) {
      setArchivePreviewLimit((current) => (archivePreviewNotes.length >= current ? current + ARCHIVE_PAGE_SIZE : current));
    }
  }

  function renderArchive() {
    const visibleArchiveGroups = archiveGroups;
    if (searchQuery.trim()) {
      return (
        <View style={styles.tabContent}>
          <View style={styles.searchCard}>
            <TextInput
              style={styles.searchInput}
              placeholder="원본 생각 검색"
              value={searchQuery}
              onChangeText={setSearchQuery}
            />
          </View>
          <View style={styles.listHeader}>
            <View>
              <Text style={styles.sectionTitle}>검색 결과</Text>
              <Text style={styles.sectionHint}>{archiveSearchResults.length || filteredNotes.length}개를 찾았어요</Text>
            </View>
          </View>
          {renderNoteList(archiveSearchResults.length ? archiveSearchResults : filteredNotes, '검색 결과에 맞는 보관 메모가 없어요.')}
        </View>
      );
    }

    return (
      <ScrollView
        contentContainerStyle={styles.retrievalScrollContent}
        onScroll={maybeLoadMoreArchive}
        scrollEventThrottle={120}
      >
        <AppTopBar title="보관" rightIcon="…" onRightPress={openTrash} />
        <View style={styles.searchCardCompact}>
          <TextInput
            style={styles.searchInput}
            placeholder="원본 생각 검색"
            value={searchQuery}
            onChangeText={setSearchQuery}
          />
        </View>
        {renderArchiveGroups(visibleArchiveGroups, '아직 보관된 녹음이나 메모가 없어요.')}
        {session?.user ? (
          <Pressable style={styles.archiveAccountEntry} onPress={() => setShowAccount(true)}>
            <View>
              <Text style={styles.archiveAccountTitle}>계정과 데이터</Text>
              <Text style={styles.archiveAccountHint}>동기화 상태와 로그인 정보를 확인해요</Text>
            </View>
            <Text style={styles.archiveAccountArrow}>›</Text>
          </Pressable>
        ) : null}
      </ScrollView>
    );
  }

  function openNote(note: Note) {
    void Haptics.selectionAsync().catch(() => undefined);
    setSelectedNoteOverride(notes.some((item) => item.id === note.id) ? null : note);
    setSelectedNoteId(note.id);
  }

  function openThoughtFlow(flow: ThoughtFlow) {
    void Haptics.selectionAsync().catch(() => undefined);
    setCachedThoughtFlows((prev) => prev.some((item) => item.id === flow.id) ? prev : [flow, ...prev]);
    setSelectedNoteId(null);
    setSelectedNoteOverride(null);
    setSelectedThoughtFlowId(flow.id);
  }

  function closeThoughtFlowDetail() {
    void Haptics.selectionAsync().catch(() => undefined);
    setSelectedThoughtFlowId(null);
  }

  function closeNoteDetail() {
    void Haptics.selectionAsync().catch(() => undefined);
    setSelectedNoteId(null);
    setSelectedNoteOverride(null);
  }

  function renderArchiveGroups(groups: ArchiveDateGroup[], emptyText: string) {
    if (loading) return <ActivityIndicator style={styles.loader} />;
    if (!groups.length) return <Text style={styles.empty}>{emptyText}</Text>;

    return groups.map((group) => (
      <View key={group.key} style={styles.archiveDateGroup}>
        <View style={styles.archiveDateHeader}>
          <Text style={styles.archiveDateTitle}>{group.title}</Text>
          <Text style={styles.archiveDateCount}>{group.notes.length}개</Text>
        </View>
        {group.notes.map((note) => (
          <SwipeableArchiveNoteCard
            key={note.id}
            note={note}
            voiceJob={voiceJobs[note.id]}
            onOpen={() => openNote(note)}
            onRetryVoice={() => retryVoiceTranscription(note)}
            onTrash={() => moveNoteToTrash(note)}
          />
        ))}
      </View>
    ));
  }

  function renderNoteList(data: Note[], emptyText: string) {
    if (loading) return <ActivityIndicator style={styles.loader} />;

    return (
      <FlatList
        data={data}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.noteList}
        ListEmptyComponent={<Text style={styles.empty}>{emptyText}</Text>}
        renderItem={({ item }) => (
          <SwipeableArchiveNoteCard
            note={item}
            voiceJob={voiceJobs[item.id]}
            onOpen={() => openNote(item)}
            onRetryVoice={() => retryVoiceTranscription(item)}
            onTrash={() => moveNoteToTrash(item)}
          />
        )}
      />
    );
  }

  function renderTabContent(tab: AppTab = activeTab) {
    if (tab === 'organized') return renderOrganized();
    if (tab === 'archive') return renderArchive();
    return renderToday();
  }

  function renderPreviousScreenLayer() {
    return (
      <View pointerEvents="none" style={styles.previousScreenLayer}>
        <View style={styles.previousScreenContent}>{renderTabContent(activeTab)}</View>
      </View>
    );
  }

  function renderActiveTab() {
    if (showTrash) {
      return (
        <TrashScreen
          notes={trashNotes}
          onBack={() => setShowTrash(false)}
          onRestore={restoreTrashNote}
          onDeleteForever={(noteId) => {
            Alert.alert('영구 삭제', '이 메모를 완전히 삭제할까요?', [
              { text: '취소', style: 'cancel' },
              { text: '영구 삭제', style: 'destructive', onPress: () => void permanentlyDeleteTrashNote(noteId) },
            ]);
          }}
        />
      );
    }
    if (showAccount && session?.user) {
      return (
        <View style={styles.navigationStack}>
          {renderPreviousScreenLayer()}
          <AccountScreen
            email={userEmail}
            userId={session.user.id}
            onBack={() => setShowAccount(false)}
            onSignOut={signOut}
          />
        </View>
      );
    }
    if (selectedNote) {
      return (
        <View style={styles.navigationStack}>
          {renderPreviousScreenLayer()}
          <NoteDetail
            note={selectedNote}
            relatedNotes={findRelatedNotes(selectedNote, feedNotes)}
            sourceLogs={selectedNoteLogs}
            saving={saving}
            voiceJob={voiceJobs[selectedNote.id]}
            onBack={closeNoteDetail}
            onSave={updateNoteText}
            onDelete={requestDeleteNote}
            onTogglePin={togglePinNote}
            onDetachLog={detachLogNote}
            playback={audioPlayback?.noteId === selectedNote.id ? audioPlayback : null}
            onPlayVoice={playOriginalAudio}
            onPauseVoice={pauseOriginalAudio}
            onStopVoice={stopOriginalAudio}
            onRetryVoice={retryVoiceTranscription}
            onOpenRelated={openNote}
            onOpenRelatedThoughtFlow={openThoughtFlow}
            onRewriteNote={rewriteOriginalNote}
            rewriting={noteRewriteInFlightId === selectedNote.id}
          />
        </View>
      );
    }
    if (selectedThoughtFlow) {
      return (
        <View style={styles.navigationStack}>
          {renderPreviousScreenLayer()}
          <ThoughtFlowDetailScreen
            flow={selectedThoughtFlow}
            onBack={closeThoughtFlowDetail}
            onOpenNote={openNote}
            onRegenerateDraft={generateMergedThoughtDraft}
            generationState={draftGenerationState[selectedThoughtFlow.id]}
          />
        </View>
      );
    }
    return (
      <View style={styles.tabPagerViewport}>
        {renderTabContent(activeTab)}
      </View>
    );
  }

  const showAppChrome = !(cloudMode && !session);
  const showFloatingCapture = false;

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style="dark" />
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.select({ ios: 'padding', default: undefined })}
      >
        {cloudMode && !session ? (
          <View style={styles.header}>
            <Text style={styles.kicker}>Idea Second Brain</Text>
            <Text style={styles.title}>생각을 잃어버리지 않는 메모장</Text>
            <Text style={styles.status}>{statusLabel}</Text>
          </View>
        ) : null}

        {cloudMode && !session ? renderLoginCard() : renderActiveTab()}

        {showFloatingCapture ? (
          <FloatingCaptureBar
            recording={isCapturingVoice}
            saving={saving}
            onToggleRecording={toggleVoiceCapture}
          />
        ) : null}
        {(cloudMode && !session) || selectedNote || selectedThoughtFlow || showTrash || showAccount ? null : <BottomTabs activeTab={activeTab} onChange={changeTab} />}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}


function AccountScreen({
  email,
  userId,
  onBack,
  onSignOut,
}: {
  email: string;
  userId: string;
  onBack: () => void;
  onSignOut: () => void;
}) {
  const shortUserId = userId.length > 12 ? `${userId.slice(0, 8)}…${userId.slice(-4)}` : userId;
  const displayName = email ? email.split('@')[0] : '나';

  return (
    <View style={styles.accountSheetShell}>
      <Pressable accessibilityRole="button" accessibilityLabel="닫기" style={styles.accountCloseButton} onPress={onBack} hitSlop={10}>
        <Text style={styles.accountCloseText}>×</Text>
      </Pressable>
      <ScrollView contentContainerStyle={styles.accountSheetContent} showsVerticalScrollIndicator={false}>
        <View style={styles.accountProfileBlock}>
          <View style={styles.accountAvatarLarge}>
            <Text style={styles.accountAvatarText}>{email.trim().charAt(0).toUpperCase() || '나'}</Text>
          </View>
          <Text style={styles.accountDisplayName} numberOfLines={1}>{displayName}</Text>
        </View>

        <SettingsSection title="계정">
          <SettingsRow icon="✉" label="이메일" value={email} hideChevron />
          <SettingsRow icon="↔" label="동기화" value="켜짐" hideChevron />
          <SettingsRow icon="#" label="사용자 ID" value={shortUserId} hideChevron />
        </SettingsSection>

        <SettingsSection title="데이터">
          <SettingsRow icon="▱" label="원본 보관" value="보관 탭" hideChevron />
          <SettingsRow icon="▤" label="내보내기" value="메모 상세" hideChevron />
        </SettingsSection>

        <SettingsSection title="앱 정보">
          <SettingsRow icon="ⓘ" label="생각회수기" value="MVP" hideChevron />
        </SettingsSection>

        <Pressable style={styles.accountLogoutRow} onPress={onSignOut}>
          <Text style={styles.accountLogoutIcon}>↪</Text>
          <Text style={styles.accountLogoutText}>로그아웃</Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}

function SettingsSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={styles.settingsSectionBlock}>
      <Text style={styles.settingsSectionTitle}>{title}</Text>
      <View style={styles.settingsSectionCard}>{children}</View>
    </View>
  );
}

function SettingsRow({
  icon,
  label,
  value,
  hideChevron,
}: {
  icon: string;
  label: string;
  value?: string;
  hideChevron?: boolean;
}) {
  return (
    <Pressable style={styles.settingsRow} disabled={hideChevron}>
      <Text style={styles.settingsIcon}>{icon}</Text>
      <Text style={styles.settingsLabel} numberOfLines={1}>{label}</Text>
      {value ? <Text style={styles.settingsValue} numberOfLines={1}>{value}</Text> : null}
      {hideChevron ? null : <Text style={styles.settingsChevron}>›</Text>}
    </Pressable>
  );
}

function TrashScreen({
  notes,
  onBack,
  onRestore,
  onDeleteForever,
}: {
  notes: Note[];
  onBack: () => void;
  onRestore: (noteId: string) => void;
  onDeleteForever: (noteId: string) => void;
}) {
  return (
    <ScrollView contentContainerStyle={styles.detailContent}>
      <View style={styles.detailShell}>
        <AppBackButton onPress={onBack} label="보관으로" />
        <Text style={styles.sectionTitle}>휴지통</Text>
        <Text style={styles.sectionHint}>실수로 지운 생각을 복원하거나 완전히 삭제할 수 있어요.</Text>
        {notes.length ? notes.map((note) => (
          <View key={note.id} style={styles.trashNoteCard}>
            <Text style={styles.relatedTitle}>{note.ai_title || makeDraftTitle(note.raw_text)}</Text>
            <Text style={styles.noteSummary} numberOfLines={2}>{note.ai_summary || note.raw_text}</Text>
            <View style={styles.buttonRow}>
              <Pressable style={styles.secondaryButton} onPress={() => onRestore(note.id)}>
                <Text style={styles.secondaryButtonText}>복원</Text>
              </Pressable>
              <Pressable style={styles.dangerButton} onPress={() => onDeleteForever(note.id)}>
                <Text style={styles.dangerButtonText}>영구 삭제</Text>
              </Pressable>
            </View>
          </View>
        )) : <Text style={styles.empty}>휴지통이 비어 있어요.</Text>}
      </View>
    </ScrollView>
  );
}

function FloatingCaptureBar({
  recording,
  saving,
  onToggleRecording,
}: {
  recording: boolean;
  saving: boolean;
  onToggleRecording: () => void;
}) {
  return (
    <View pointerEvents="box-none" style={styles.floatingCaptureWrap}>
      <Pressable
        style={[styles.floatingMicButton, recording && styles.floatingMicButtonActive]}
        onPress={onToggleRecording}
        disabled={saving}
      >
        <Text style={styles.floatingMicIcon}>{recording ? '■' : '🎙️'}</Text>
      </Pressable>
      <Text style={[styles.captureHint, recording && styles.captureHintActive]}>
        {recording ? '듣는 중 · 다시 누르면 저장' : '생각을 말해보세요'}
      </Text>
    </View>
  );
}

function AppTopBar({
  title,
  leftIcon,
  rightIcon,
  onLeftPress,
  onRightPress,
}: {
  title: string;
  leftIcon?: string;
  rightIcon?: string;
  onLeftPress?: () => void;
  onRightPress?: () => void;
}) {
  function press(action?: () => void) {
    if (!action) return;
    void Haptics.selectionAsync().catch(() => undefined);
    action();
  }

  return (
    <View style={styles.appTopBar}>
      <Pressable style={styles.topIconButton} onPress={() => press(onLeftPress)} disabled={!onLeftPress} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
        <Text style={styles.topIconText}>{leftIcon ?? ''}</Text>
      </Pressable>
      <Text style={styles.appTopTitle}>{title}</Text>
      <Pressable style={styles.topIconButton} onPress={() => press(onRightPress)} disabled={!onRightPress} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
        <Text style={styles.topIconText}>{rightIcon ?? ''}</Text>
      </Pressable>
    </View>
  );
}

function SpringPressable({
  children,
  style,
  onPress,
  disabled,
  accessibilityLabel,
}: {
  children: ReactNode;
  style?: any;
  onPress?: () => void;
  disabled?: boolean;
  accessibilityLabel?: string;
}) {
  const scale = useRef(new Animated.Value(1)).current;

  function pressIn() {
    Animated.spring(scale, { toValue: 0.96, friction: 8, tension: 220, useNativeDriver: true }).start();
    void Haptics.selectionAsync().catch(() => undefined);
  }

  function pressOut() {
    Animated.spring(scale, { toValue: 1, friction: 5, tension: 180, useNativeDriver: true }).start();
  }

  return (
    <AnimatedPressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      disabled={disabled}
      style={[style, { transform: [{ scale }] }]}
      onPress={onPress}
      onPressIn={pressIn}
      onPressOut={pressOut}
    >
      {children}
    </AnimatedPressable>
  );
}

function TodayRecorderCard({
  recording,
  saving,
  recordingElapsedMs,
  maxRecordingMs,
  onToggleRecording,
}: {
  recording: boolean;
  saving: boolean;
  recordingElapsedMs: number;
  maxRecordingMs: number;
  onToggleRecording: () => void;
}) {
  const remainingMs = Math.max(0, maxRecordingMs - recordingElapsedMs);
  const progress = maxRecordingMs ? Math.min(1, recordingElapsedMs / maxRecordingMs) : 0;
  const heroTitle = recording ? '지금 말하는 중' : saving ? '생각을 받았어요' : '떠오른 생각을 그냥 말하세요';
  const heroHint = recording
    ? remainingMs <= 30 * 1000
      ? '곧 자동으로 정리돼요'
      : '끝내면 자동으로 정리돼요'
    : saving
      ? '정리는 뒤에서 이어갈게요. 바로 다음 생각을 말해도 돼요.'
      : '정리와 분류는 나중에 할게요.';

  return (
    <View style={[styles.todayRecorderCard, recording && styles.todayRecorderCardActive]}>
      <View style={styles.todayHeroCopy}>
        <Text style={styles.todayPromptPill}>{recording ? '녹음 중' : saving ? '정리 중' : '말하면 남아요'}</Text>
        <Text style={styles.todayHeroTitle}>{heroTitle}</Text>
        <Text style={styles.todayHeroHint}>{heroHint}</Text>
      </View>

      <Pressable
        style={[styles.todayMicButton, recording && styles.todayMicButtonActive, saving && styles.disabledButton]}
        onPress={onToggleRecording}
        disabled={saving}
        accessibilityRole="button"
        accessibilityLabel={recording ? '녹음 끝내기' : '생각 말하기'}
      >
        <View style={[styles.todayMicHaloOuter, recording && styles.todayMicHaloOuterActive]}>
          <View style={[styles.todayMicHaloInner, recording && styles.todayMicHaloInnerActive]}>
            <Text style={styles.todayMicIcon}>{recording ? '■' : '🎙️'}</Text>
          </View>
        </View>
      </Pressable>

      {recording ? (
        <>
          <Text style={styles.todayRecorderTimer}>{formatRecordingTime(recordingElapsedMs)}</Text>
          <View style={styles.todayWaveformRow}>
            {[8, 18, 13, 28, 12, 36, 14, 24, 11, 32, 15, 30].map((height, index) => (
              <View key={`${height}-${index}`} style={[styles.todayWaveformBar, { height }]} />
            ))}
          </View>
          <View style={styles.todayRecorderProgressTrack}>
            <View style={[styles.todayRecorderProgressFill, { width: `${Math.max(2, progress * 100)}%` }]} />
          </View>
        </>
      ) : null}

      <Text style={styles.todayRecorderSubtitle}>{recording ? '끝내기' : saving ? '정리 중...' : '탭해서 말하기'}</Text>
    </View>
  );
}

function BottomTabs({ activeTab, onChange }: { activeTab: AppTab; onChange: (tab: AppTab) => void }) {
  const tabs: Array<{ id: AppTab; label: string; icon: string }> = [
    { id: 'today', label: '오늘', icon: '✦' },
    { id: 'organized', label: '흐름', icon: '🌱' },
    { id: 'archive', label: '보관', icon: '▤' }
  ];

  return (
    <View style={styles.bottomTabs}>
      {tabs.map((tab) => {
        const isActive = activeTab === tab.id;
        return (
          <Pressable
            key={tab.id}
            style={[styles.tabButton, isActive && styles.tabButtonActive]}
            onPress={() => onChange(tab.id)}
          >
            <Text style={[styles.tabIcon, isActive && styles.tabTextActive]}>{tab.icon}</Text>
            <Text style={[styles.tabLabel, isActive && styles.tabTextActive]}>{tab.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function TodayThoughtMiniCard({ note, voiceJob, onPress }: { note: Note; voiceJob?: VoiceJob; onPress: () => void }) {
  const isProcessing = voiceJob ? ['saving', 'uploading', 'transcribing'].includes(voiceJob.status) : isProcessingVoiceNote(note);
  const isFailed = voiceJob?.status === 'failed' || isFailedVoiceNote(note);
  const statusLabel = isFailed ? '확인 필요' : isProcessing ? '정리 중...' : '정리됨';
  const title = isProcessing ? '방금 말한 생각' : note.ai_title || makeDraftTitle(note.raw_text);
  const preview = isProcessing ? (voiceJob?.message ?? '전사와 정리를 이어가는 중이에요') : note.ai_summary || makeDraftSummary(note.raw_text);

  return (
    <Pressable style={[styles.todayMiniCard, isProcessing && styles.todayMiniCardProcessing, isFailed && styles.failedCard]} onPress={onPress}>
      <View style={styles.todayMiniTopRow}>
        <Text style={[styles.todayMiniStatus, isProcessing && styles.todayMiniStatusProcessing]}>{statusLabel}</Text>
        <Text style={styles.todayMiniTime}>{formatDate(note.created_at)}</Text>
      </View>
      <Text style={styles.todayMiniTitle} numberOfLines={1}>{title}</Text>
      <Text style={styles.todayMiniPreview} numberOfLines={2}>{preview}</Text>
    </Pressable>
  );
}

function ArchiveOriginalNoteCard({ note, voiceJob, onPress, onRetryVoice }: { note: Note; voiceJob?: VoiceJob; onPress: () => void; onRetryVoice: () => void }) {
  const isProcessing = voiceJob ? ['saving', 'uploading', 'transcribing'].includes(voiceJob.status) : isProcessingVoiceNote(note);
  const isPersistedFailed = isFailedVoiceNote(note);
  const isFailed = voiceJob?.status === 'failed' || isPersistedFailed;
  const sourceLabel = note.source_type === 'voice' ? '음성' : '텍스트';
  const title = isProcessing ? '방금 말한 원본' : note.ai_title || makeDraftTitle(note.raw_text);
  const preview = isProcessing ? (voiceJob?.message ?? '전사와 정리를 이어가는 중이에요') : note.raw_text || note.ai_summary || '';

  return (
    <Pressable style={[styles.archiveOriginalCard, isProcessing && styles.todayMiniCardProcessing, isFailed && styles.failedCard]} onPress={onPress}>
      <View style={styles.archiveOriginalMetaRow}>
        <Text style={styles.archiveOriginalSource}>{note.source_type === 'voice' ? '🎙 ' : '✎ '}{sourceLabel}</Text>
        <Text style={styles.archiveOriginalDate}>{formatDate(note.created_at)}</Text>
      </View>
      <Text style={styles.archiveOriginalTitle} numberOfLines={1}>{title}</Text>
      <Text style={styles.archiveOriginalPreview} numberOfLines={2}>{preview}</Text>
      {(voiceJob && voiceJob.status !== 'done') || (!voiceJob && isPersistedFailed) ? (
        <View style={styles.voiceStatusBox}>
          <Text style={styles.voiceStatusText}>{voiceJob?.message ?? '전사 실패 · 다시 시도 가능'}</Text>
          {isFailed ? (
            <Pressable style={styles.retryButton} onPress={onRetryVoice}>
              <Text style={styles.retryButtonText}>다시</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </Pressable>
  );
}

function NoteCard({
  note,
  voiceJob,
  relatedCount,
  onPress,
  onRetryVoice,
}: {
  note: Note;
  voiceJob?: VoiceJob;
  relatedCount: number;
  onPress: () => void;
  onRetryVoice: () => void;
}) {
  const isProcessing = voiceJob ? ['saving', 'uploading', 'transcribing'].includes(voiceJob.status) : isProcessingVoiceNote(note);
  const isPersistedFailed = isFailedVoiceNote(note);
  const isFailed = voiceJob?.status === 'failed' || isPersistedFailed;
  const category = inferCategory(note);
  const replyCount = Math.max(0, (note.ai_thread_reason ? 1 : 0));

  return (
    <Pressable style={[styles.noteCard, isProcessing && styles.processingCard, isFailed && styles.failedCard]} onPress={onPress}>
      <View style={styles.noteMetaRow}>
        <View style={styles.noteMetaLeft}>
          <Text style={styles.noteType}>{note.source_type === 'voice' ? '🎙' : '✎'}</Text>
          <Text style={styles.singleCategory}>{category}</Text>
        </View>
        <Text style={styles.noteDate}>{formatDate(note.created_at)}</Text>
      </View>
      <Text style={styles.noteTitle} numberOfLines={2}>
        {note.ai_title || makeDraftTitle(note.raw_text)}
      </Text>
      <Text style={styles.noteSummary} numberOfLines={2}>
        {note.ai_summary || makeDraftSummary(note.raw_text)}
      </Text>
      {relatedCount > 0 ? (
        <View style={styles.rediscoveryPill}>
          <Text style={styles.rediscoveryPillText}>↔ 이전 생각 {relatedCount}개와 이어져요</Text>
        </View>
      ) : null}
      <View style={styles.compactMetaRow}>
        {note.audio_url ? <Text style={styles.iconMeta}>◉</Text> : null}
        {replyCount > 0 ? <Text style={styles.iconMeta}>💬 {replyCount}</Text> : null}
        <RoutingBadge note={note} compact />
      </View>
      {(voiceJob && voiceJob.status !== 'done') || (!voiceJob && isPersistedFailed) ? (
        <View style={styles.voiceStatusBox}>
          <Text style={styles.voiceStatusText}>{voiceJob?.message ?? '전사 실패 · 다시 시도 가능'}</Text>
          {isFailed ? (
            <Pressable style={styles.retryButton} onPress={onRetryVoice}>
              <Text style={styles.retryButtonText}>다시 전사</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </Pressable>
  );
}

function SwipeableArchiveNoteCard({
  note,
  voiceJob,
  onOpen,
  onRetryVoice,
  onTrash,
}: {
  note: Note;
  voiceJob?: VoiceJob;
  onOpen: () => void;
  onRetryVoice: () => void;
  onTrash: () => void;
}) {
  const translateX = useRef(new Animated.Value(0)).current;
  const [swiping, setSwiping] = useState(false);
  const deleteArmedRef = useRef(false);

  const reset = useCallback(() => {
    deleteArmedRef.current = false;
    setSwiping(false);
    Animated.spring(translateX, { toValue: 0, friction: 8, tension: 150, useNativeDriver: true }).start();
  }, [translateX]);

  const commitTrash = useCallback(() => {
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
    Animated.timing(translateX, { toValue: -SCREEN_WIDTH, duration: 160, useNativeDriver: true }).start(() => {
      onTrash();
      translateX.setValue(0);
      setSwiping(false);
      deleteArmedRef.current = false;
    });
  }, [onTrash, translateX]);

  const responder = useMemo(
    () => PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      onStartShouldSetPanResponderCapture: () => false,
      onMoveShouldSetPanResponder: (_event, gesture) => gesture.dx < -3 && Math.abs(gesture.dx) > Math.abs(gesture.dy) * 0.8,
      onMoveShouldSetPanResponderCapture: (_event, gesture) => gesture.dx < -3 && Math.abs(gesture.dx) > Math.abs(gesture.dy) * 0.8,
      onPanResponderTerminationRequest: () => false,
      onShouldBlockNativeResponder: () => true,
      onPanResponderGrant: () => {
        setSwiping(true);
        deleteArmedRef.current = false;
        translateX.stopAnimation();
      },
      onPanResponderMove: (_event, gesture) => {
        const raw = Math.min(0, gesture.dx);
        const deleteThreshold = SCREEN_WIDTH * 0.5;
        const maxFollowDistance = SCREEN_WIDTH * 0.62;
        const resisted = raw > -maxFollowDistance ? raw : -maxFollowDistance + (raw + maxFollowDistance) * 0.24;
        translateX.setValue(resisted);
        const crossedMiddle = Math.abs(raw) >= deleteThreshold;
        if (crossedMiddle && !deleteArmedRef.current) {
          deleteArmedRef.current = true;
          void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => undefined);
        } else if (!crossedMiddle && deleteArmedRef.current) {
          deleteArmedRef.current = false;
        }
      },
      onPanResponderRelease: () => {
        if (deleteArmedRef.current) commitTrash();
        else reset();
      },
      onPanResponderTerminate: reset,
    }),
    [commitTrash, reset, translateX],
  );

  return (
    <View style={styles.swipeArchiveShell} {...responder.panHandlers}>
      <View style={[styles.swipeTrashReveal, swiping && styles.swipeTrashRevealActive]} pointerEvents="none">
        <Text style={styles.swipeTrashIcon}>🗑</Text>
      </View>
      <Animated.View style={{ transform: [{ translateX }] }}>
        <ArchiveOriginalNoteCard
          note={note}
          voiceJob={voiceJob}
          onPress={onOpen}
          onRetryVoice={onRetryVoice}
        />
      </Animated.View>
    </View>
  );
}


function ThoughtFlowSection({
  flows,
  onOpenFlow,
  onOpenNote,
  onGenerateDraft,
  generationState,
  title = '',
  hint = '',
  emptyText,
}: {
  flows: ThoughtFlow[];
  onOpenFlow: (flow: ThoughtFlow) => void;
  onOpenNote: (note: Note) => void;
  onGenerateDraft: (flow: ThoughtFlow) => Promise<void>;
  generationState: Record<string, { loading: boolean; error?: string }>;
  title?: string;
  hint?: string;
  emptyText?: string;
}) {
  if (!flows.length) {
    if (!emptyText) return null;
    return (
      <View style={styles.retrievalSection}>
        {title || hint ? (
          <View style={styles.retrievalSectionHeader}>
            <View>
              {title ? <Text style={styles.sectionTitle}>{title}</Text> : null}
              {hint ? <Text style={styles.sectionHint}>{hint}</Text> : null}
            </View>
          </View>
        ) : null}
        <Text style={styles.retrievalEmptyInline}>{emptyText}</Text>
      </View>
    );
  }

  return (
    <View style={styles.retrievalSection}>
      {flows.map((flow) => (
        <ThoughtFlowCard
          key={flow.id}
          flow={flow}
          onOpenFlow={onOpenFlow}
          onOpenNote={onOpenNote}
          onGenerateDraft={onGenerateDraft}
          generationState={generationState[flow.id]}
        />
      ))}
    </View>
  );
}

function ThoughtFlowCard({
  flow,
  onOpenFlow,
  onGenerateDraft,
  generationState,
}: {
  flow: ThoughtFlow;
  onOpenFlow: (flow: ThoughtFlow) => void;
  onOpenNote: (note: Note) => void;
  onGenerateDraft: (flow: ThoughtFlow) => Promise<void>;
  generationState?: { loading: boolean; error?: string };
}) {
  const hasDraftBody = flow.mergedDraft.body.trim().length > 0;
  const summary = getThoughtReportSummary(flow);
  const statusLabel = hasDraftBody ? '정식 흐름' : '정리 전';

  function generateWithoutOpening(event: GestureResponderEvent) {
    event.stopPropagation();
    void Haptics.selectionAsync().catch(() => undefined);
    void onGenerateDraft(flow);
  }

  return (
    <SpringPressable style={[styles.thoughtReportCard, !hasDraftBody && styles.thoughtReportCardPending]} onPress={() => onOpenFlow(flow)} accessibilityLabel={`${flow.title} 흐름 열기`}>
      <View style={styles.thoughtReportHeader}>
        <View style={styles.thoughtReportHeaderText}>
          <View style={styles.flowStatusRow}>
            <Text style={[styles.flowStatusPill, hasDraftBody ? styles.flowStatusPillReady : styles.flowStatusPillPending]}>{statusLabel}</Text>
          </View>
          <Text style={styles.thoughtReportTitle} numberOfLines={2}>{flow.title}</Text>
        </View>
      </View>

      {hasDraftBody ? (
        <>
          <Text style={styles.thoughtReportSummary} numberOfLines={4}>{summary}</Text>
          <View style={styles.nextQuestionCard}>
            <Text style={styles.nextQuestionLabel}>다음 질문</Text>
            <Text style={styles.nextQuestionBody} numberOfLines={2}>{flow.nextQuestion}</Text>
          </View>
        </>
      ) : (
        <View style={styles.flowPendingBox}>
          <Text style={styles.flowPendingTitle}>아직 정리본이 없어요</Text>
          <Text style={styles.flowSectionHint}>버튼을 누르면 AI가 백그라운드에서 정리해서 이 흐름 안에 채워둘게요.</Text>
          <Pressable style={[styles.flowPrimaryButton, generationState?.loading && styles.disabledButton]} onPress={generateWithoutOpening} disabled={generationState?.loading}>
            <Text style={styles.primaryButtonText}>{generationState?.loading ? '정리 중...' : '생각 정리하기'}</Text>
          </Pressable>
          {generationState?.error ? <Text style={styles.voiceErrorText}>{generationState.error}</Text> : null}
        </View>
      )}
    </SpringPressable>
  );
}

function ReportStage({ label, body }: { label: string; body: string }) {
  return (
    <View style={styles.reportStageRow}>
      <Text style={styles.reportStageLabel}>{label}</Text>
      <Text style={styles.reportStageBody} numberOfLines={2}>{body}</Text>
    </View>
  );
}

function getThoughtReportSummary(flow: ThoughtFlow) {
  return flow.mergedDraft.body
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 20) ?? flow.mergedDraft.title;
}

function buildReadableThoughtReport(flow: ThoughtFlow) {
  const sortedNotes = [...flow.notes].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  const summaries = sortedNotes.map((note) => note.ai_summary || makeDraftSummary(note.raw_text)).filter(Boolean);
  const firstProblem = summaries[0] || flow.sharedProblem || flow.title;
  const repeatedConcern = flow.sharedProblem || summaries[1] || flow.synthesis;
  const currentConclusion = flow.mergedDraft?.judgmentSummary?.[0] || flow.sharedDecisionAxis || flow.synthesis;
  const summary = flow.mergedDraft?.body?.split('\n').find((line) => line.trim().length > 20)?.trim() || flow.synthesis;
  const firstDate = sortedNotes.length ? formatDate(sortedNotes[0].created_at) : formatDate(flow.createdAt);
  const latestDate = sortedNotes.length ? formatDate(sortedNotes[sortedNotes.length - 1].created_at) : formatDate(flow.updatedAt);
  return {
    summary,
    firstProblem,
    repeatedConcern,
    currentConclusion,
    sixW: [
      { label: '누가', value: '나의 반복 메모' },
      { label: '무엇을', value: flow.title },
      { label: '언제', value: firstDate === latestDate ? latestDate : `${firstDate} → ${latestDate}` },
      { label: '어디서', value: '음성/원문 메모' },
      { label: '왜', value: flow.sharedProblem || '반복해서 떠오른 문제' },
      { label: '어떻게', value: flow.nextQuestion },
    ],
  };
}

function ReadableReportBreakdown({ flow }: { flow: ThoughtFlow }) {
  const report = buildReadableThoughtReport(flow);
  return (
    <View style={styles.readableReportBox}>
      <View style={styles.thoughtReportTimeline}>
        <ReportStage label="처음" body={report.firstProblem} />
        <ReportStage label="반복" body={report.repeatedConcern} />
        <ReportStage label="현재" body={report.currentConclusion} />
      </View>
      <SixWAnswerPanel items={report.sixW} />
    </View>
  );
}

type SixWItem = { label: string; value: string };

function SixWAnswerPanel({ items, compact = false }: { items: SixWItem[]; compact?: boolean }) {
  const defaultLabel = items.find((item) => item.label === '왜')?.label ?? items[0]?.label ?? '';
  const [selectedLabel, setSelectedLabel] = useState(defaultLabel);
  const selected = items.find((item) => item.label === selectedLabel) ?? items[0];

  if (!selected) return null;

  return (
    <View style={[styles.sixWPanel, compact && styles.sixWPanelCompact]}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.sixWTabRow}
      >
        {items.map((item) => {
          const active = item.label === selected.label;
          return (
            <Pressable
              key={item.label}
              style={[styles.sixWTab, active && styles.sixWTabActive]}
              onPress={() => setSelectedLabel(item.label)}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
            >
              <Text style={[styles.sixWTabText, active && styles.sixWTabTextActive]}>{item.label}</Text>
            </Pressable>
          );
        })}
      </ScrollView>
      <View style={[styles.sixWAnswerCard, compact && styles.sixWAnswerCardCompact]}>
        <Text style={styles.sixWAnswerLabel}>{selected.label}</Text>
        <Text style={[styles.sixWAnswerValue, compact && styles.sixWAnswerValueCompact]}>{selected.value}</Text>
      </View>
    </View>
  );
}


function AppBackButton({ label, onPress, style }: { label: string; onPress: () => void; style?: any }) {
  function press() {
    void Haptics.selectionAsync().catch(() => undefined);
    onPress();
  }

  return (
    <Pressable style={[styles.backButton, style]} onPress={press} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
      <View style={styles.backButtonInner} pointerEvents="none">
        <Text style={styles.backChevron}>{'‹'}</Text>
        <Text style={styles.backButtonText} numberOfLines={1}>{label}</Text>
      </View>
    </Pressable>
  );
}

function useSwipeBack(onBack: () => void) {
  const translateX = useRef(new Animated.Value(0)).current;
  const progress = useRef(new Animated.Value(0)).current;
  const hapticTriggeredRef = useRef(false);

  const restore = useCallback(() => {
    Animated.parallel([
      Animated.spring(translateX, { toValue: 0, friction: 8, tension: 130, useNativeDriver: true }),
      Animated.spring(progress, { toValue: 0, friction: 8, tension: 130, useNativeDriver: true }),
    ]).start();
  }, [progress, translateX]);

  const settleBack = useCallback(() => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
    Animated.parallel([
      Animated.spring(translateX, { toValue: SCREEN_WIDTH, friction: 10, tension: 90, useNativeDriver: true }),
      Animated.timing(progress, { toValue: 1, duration: 120, useNativeDriver: true }),
    ]).start(() => onBack());
  }, [onBack, progress, translateX]);

  const responder = useMemo(
    () => PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponder: (event, gesture) => {
        const startX = event.nativeEvent.pageX - gesture.dx;
        return startX <= SCREEN_WIDTH * 0.56 && gesture.dx > 6 && Math.abs(gesture.dx) > Math.abs(gesture.dy) * 1.15;
      },
      onMoveShouldSetPanResponderCapture: (event, gesture) => {
        const startX = event.nativeEvent.pageX - gesture.dx;
        return startX <= SCREEN_WIDTH * 0.56 && gesture.dx > 8 && Math.abs(gesture.dx) > Math.abs(gesture.dy) * 1.2;
      },
      onPanResponderGrant: () => {
        hapticTriggeredRef.current = false;
        translateX.stopAnimation();
        progress.stopAnimation();
      },
      onPanResponderMove: (_event, gesture) => {
        const raw = Math.max(0, gesture.dx);
        if (!hapticTriggeredRef.current && (raw > 86 || gesture.vx > 0.42)) {
          hapticTriggeredRef.current = true;
          void Haptics.selectionAsync().catch(() => undefined);
        }
        const resisted = raw < 90 ? raw : 90 + (raw - 90) * 0.58;
        translateX.setValue(resisted);
        progress.setValue(Math.min(1, raw / 180));
      },
      onPanResponderRelease: (_event, gesture) => {
        const shouldBack = gesture.dx > 86 || gesture.vx > 0.42;
        if (shouldBack) settleBack();
        else restore();
      },
      onPanResponderTerminate: restore,
    }),
    [progress, restore, settleBack, translateX],
  );

  return {
    responder,
    animatedStyle: {
      transform: [{ translateX }],
      opacity: progress.interpolate({ inputRange: [0, 1], outputRange: [1, 0.96] }),
    },
  };
}


function ThoughtFlowDetailScreen({
  flow,
  onBack,
  onOpenNote,
  onRegenerateDraft,
  generationState,
}: {
  flow: ThoughtFlow;
  onBack: () => void;
  onOpenNote: (note: Note) => void;
  onRegenerateDraft: (flow: ThoughtFlow) => Promise<void>;
  generationState?: { loading: boolean; error?: string };
}) {
  const draft = flow.mergedDraft;
  const hasDraftBody = draft.body.trim().length > 0;
  const [isSaved, setIsSaved] = useState(hasDraftBody && (draft.status === 'saved' || flow.status === 'saved'));
  const [sourcesExpanded, setSourcesExpanded] = useState(false);
  const statusLabel = isSaved ? '저장된 흐름' : hasDraftBody ? '정식 흐름' : '정리 전';

  const swipeBack = useSwipeBack(onBack);

  useEffect(() => {
    setIsSaved(hasDraftBody && (draft.status === 'saved' || flow.status === 'saved'));
  }, [draft.id, draft.status, flow.status, hasDraftBody]);

  function saveDraft() {
    setIsSaved(true);
  }

  async function regenerateDraft() {
    await onRegenerateDraft(flow);
  }

  return (
    <Animated.View style={[styles.detailShell, swipeBack.animatedStyle]} {...swipeBack.responder.panHandlers}>
      <View style={styles.detailFixedTopBar}>
        <AppBackButton label="생각" onPress={onBack} />
        <Text style={styles.flowDetailStatus}>{statusLabel}</Text>
      </View>

      <ScrollView
        contentContainerStyle={styles.detailContent}
        contentInsetAdjustmentBehavior="never"
        scrollIndicatorInsets={{ bottom: 180 }}
      >
        <View style={styles.flowMergedHero}>
          <Text style={styles.flowMergedKicker}>{hasDraftBody ? 'AI 정리본' : '정리 전'}</Text>
          <CopyableText style={styles.detailTitle} copyValue={draft.title}>{draft.title}</CopyableText>
          {generationState?.loading ? (
            <View style={styles.draftLoadingBox}>
              <ActivityIndicator />
              <Text style={styles.flowSectionHint}>AI가 백그라운드에서 정리하고 있어요.</Text>
            </View>
          ) : null}
          {generationState?.error ? <Text style={styles.voiceErrorText}>{generationState.error}</Text> : null}
          {hasDraftBody ? (
            <View style={styles.flowDocumentBody}>
              {draft.judgmentSummary.length ? (
                <View style={styles.flowDocumentSection}>
                  <Text style={styles.flowDocumentHeading}>핵심 요약</Text>
                  {draft.judgmentSummary.slice(0, 3).map((item, index) => (
                    <Text key={`${item}-${index}`} style={styles.flowDocumentBullet}>• {item}</Text>
                  ))}
                </View>
              ) : null}
              <View style={styles.flowDocumentSection}>
                <Text style={styles.flowDocumentHeading}>생각의 흐름</Text>
                <CopyableText style={styles.mergedDraftBody} copyValue={draft.body}>{draft.body}</CopyableText>
              </View>
              <View style={styles.nextQuestionCard}>
                <Text style={styles.nextQuestionLabel}>다음에 이어볼 질문</Text>
                <Text style={styles.nextQuestionBody}>{flow.nextQuestion}</Text>
              </View>
            </View>
          ) : (
            <View style={styles.flowPendingBox}>
              <Text style={styles.flowPendingTitle}>아직 정리본이 없어요</Text>
              <Text style={styles.flowSectionHint}>버튼을 누르면 AI가 백그라운드에서 정리해서 이 안에 채워둘게요.</Text>
            </View>
          )}

          <View style={styles.compactActionRow}>
            {hasDraftBody ? (
              <Pressable style={[styles.primaryButton, isSaved && styles.savedPrimaryButton]} onPress={saveDraft}>
                <Text style={styles.primaryButtonText}>{isSaved ? '저장됨' : '저장하기'}</Text>
              </Pressable>
            ) : null}
            <Pressable style={[hasDraftBody ? styles.secondaryButton : styles.primaryButton, generationState?.loading && styles.disabledButton]} onPress={regenerateDraft} disabled={generationState?.loading}>
              <Text style={hasDraftBody ? styles.secondaryButtonText : styles.primaryButtonText}>{generationState?.loading ? '정리 중...' : hasDraftBody ? '다시 정리' : '생각 정리하기'}</Text>
            </Pressable>
          </View>
          {isSaved && hasDraftBody ? <Text style={styles.savedDraftHint}>이 흐름을 계속 볼 수 있게 저장해둘게요.</Text> : null}
        </View>

        <View style={styles.detailSection}>
          <Pressable style={styles.collapsedSourcePill} onPress={() => setSourcesExpanded((value) => !value)}>
            <Text style={styles.detailSectionTitle}>원문 보기</Text>
            <Text style={styles.expandReasonText}>{sourcesExpanded ? '접기' : '열기'}</Text>
          </Pressable>
          {sourcesExpanded ? (
            <View style={styles.analysisBox}>
              {flow.notes.map((note, index) => (
                <Pressable key={note.id} style={styles.flowSourceNoteCard} onPress={() => onOpenNote(note)}>
                  <Text style={styles.flowSourceNoteIndex}>{index + 1}</Text>
                  <View style={styles.flowSourceNoteBody}>
                    <Text style={styles.relatedTitle} numberOfLines={1}>{note.ai_title || makeDraftTitle(note.raw_text)}</Text>
                  </View>
                </Pressable>
              ))}
            </View>
          ) : null}
        </View>
      </ScrollView>
    </Animated.View>
  );
}

function RetrievalSection({
  title,
  hint,
  candidates,
  feedback,
  onOpen,
  onFeedback,
}: {
  title: string;
  hint: string;
  candidates: RetrievalCandidate[];
  feedback: RetrievalFeedbackMap;
  onOpen: (note: Note) => void;
  onFeedback: (noteId: string, status: RetrievalFeedbackStatus) => void;
}) {
  return (
    <View style={styles.retrievalSection}>
      <View style={styles.retrievalSectionHeader}>
        <View>
          <Text style={styles.sectionTitle}>{title}</Text>
          {hint ? <Text style={styles.sectionHint}>{hint}</Text> : null}
        </View>
      </View>
      {candidates.length ? (
        candidates.map((candidate) => (
          <RetrievalCard
            key={`${candidate.section}-${candidate.note.id}`}
            candidate={candidate}
            feedback={feedback[candidate.note.id]}
            onOpen={onOpen}
            onFeedback={onFeedback}
          />
        ))
      ) : (
        <Text style={styles.retrievalEmptyInline}>아직 회수할 생각이 부족해요. 샘플을 넣거나 메모를 더 남겨보세요.</Text>
      )}
    </View>
  );
}

function RetrievalCard({
  candidate,
  feedback,
  onOpen,
  onFeedback,
}: {
  candidate: RetrievalCandidate;
  feedback?: RetrievalFeedbackMap[string];
  onOpen: (note: Note) => void;
  onFeedback: (noteId: string, status: RetrievalFeedbackStatus) => void;
}) {
  const { note } = candidate;
  const [expanded, setExpanded] = useState(false);
  const feedbackLabel = feedback?.status === 'useful' ? `도움 됨 ${feedback.usedCount}회` : feedback?.status === 'later' ? '나중에 볼 생각' : null;
  const badges = getRetrievalBadges(candidate);
  const strength = getRetrievalStrength(candidate);
  const oneLine = getRetrievalOneLine(candidate);

  return (
    <View style={styles.retrievalCard}>
      <Pressable onPress={() => onOpen(note)} style={styles.retrievalCardPressArea}>
        <View style={styles.noteMetaRow}>
          <View style={styles.retrievalBadgeRow}>
            {badges.map((badge) => <Text key={badge} style={styles.connectionBadge}>{badge}</Text>)}
          </View>
          <Text style={styles.noteDate}>{formatDate(note.created_at)}</Text>
        </View>
        <CopyableText style={styles.noteTitle} copyValue={note.ai_title || makeDraftTitle(note.raw_text)}>{note.ai_title || makeDraftTitle(note.raw_text)}</CopyableText>
        <CopyableText style={styles.retrievalOneLine} copyValue={oneLine}>{oneLine}</CopyableText>
        <View style={styles.strengthRow}>
          <Text style={styles.strengthText}>{strength.label}</Text>
          <Text style={styles.strengthDots}>{strength.dots}</Text>
        </View>
        {feedbackLabel ? <Text style={styles.feedbackState}>{feedbackLabel}</Text> : null}
      </Pressable>
      <Pressable style={styles.expandReasonButtonLight} onPress={() => setExpanded((value) => !value)}>
        <Text style={styles.expandReasonTextLight}>{expanded ? '설명 접기' : '왜 이어졌나요?'}</Text>
      </Pressable>
      {expanded ? (
        <View style={styles.retrievalReasonBox}>
          <Text style={styles.retrievalReasonLabel}>왜 지금 보여주나요?</Text>
          <Text style={styles.retrievalReasonBody}>{candidate.surfaceReason}</Text>
          {candidate.recentConnection ? (
            <>
              <Text style={styles.retrievalReasonLabel}>최근 어떤 생각과 이어지나요?</Text>
              <Text style={styles.retrievalReasonBody}>{candidate.recentConnection}</Text>
            </>
          ) : null}
          <Text style={styles.retrievalReasonLabel}>지금 무엇에 써먹을 수 있나요?</Text>
          <Text style={styles.retrievalReasonBody}>{candidate.useSuggestion}</Text>
          {candidate.connectionReason ? <Text style={styles.connectionReason}>↔ {candidate.connectionReason}</Text> : null}
        </View>
      ) : null}
      <View style={styles.feedbackButtonRow}>
        <Pressable style={styles.feedbackButton} onPress={() => onFeedback(note.id, 'useful')}>
          <Text style={styles.feedbackButtonText}>지금 도움 됐어요</Text>
        </Pressable>
        <Pressable style={styles.feedbackButton} onPress={() => onFeedback(note.id, 'later')}>
          <Text style={styles.feedbackButtonText}>나중에 다시 볼래요</Text>
        </Pressable>
        <Pressable style={styles.feedbackButtonMuted} onPress={() => onFeedback(note.id, 'hidden')}>
          <Text style={styles.feedbackButtonMutedText}>오늘은 안 볼래요</Text>
        </Pressable>
      </View>
    </View>
  );
}

function getRetrievalBadges(candidate: RetrievalCandidate) {
  const badges: string[] = [];
  if (candidate.surfaceReason.includes('반복') || candidate.surfaceReason.includes('흐름')) badges.push('반복되는 고민');
  if (candidate.surfaceReason.includes('묻혀') || candidate.surfaceReason.includes('일 동안')) badges.push('오래 묻힌 생각');
  if (candidate.recentConnection) badges.push('같은 의도');
  if (candidate.connectionReason) badges.push('같은 주제');
  if (candidate.section === 'today') badges.push('지금 다시 볼 만함');
  if (candidate.section === 'connected') badges.push('강하게 이어짐');
  if (badges.length === 0) badges.push('같은 방향');
  return Array.from(new Set(badges)).slice(0, 3);
}

function getRetrievalStrength(candidate: RetrievalCandidate) {
  const score = (candidate.recentConnection ? 1 : 0) + (candidate.connectionReason ? 1 : 0) + (candidate.section === 'today' ? 1 : 0);
  if (score >= 3) return { label: '강하게 이어져요', dots: '●●●' };
  if (score === 2) return { label: '이어져요', dots: '●●○' };
  return { label: '살짝 이어져요', dots: '●○○' };
}

function getRetrievalOneLine(candidate: RetrievalCandidate) {
  const days = daysSince(candidate.note.created_at);
  if (candidate.section === 'buried' && days > 0) return `${days}일 만에 다시 떠오른 생각이에요.`;
  if (candidate.surfaceReason.includes('반복') || candidate.surfaceReason.includes('흐름')) return '비슷한 고민이 최근에도 이어졌어요.';
  if (candidate.section === 'connected') return '방금 생각과 같은 방향을 보고 있어요.';
  if (candidate.section === 'recent') return '최근 생각이라 바로 이어서 다듬기 좋아요.';
  return '이 생각은 지금 다시 볼 만해요.';
}

function RoutingBadge({ note, compact = false }: { note: Note; compact?: boolean }) {
  const label = routingLabel(note);
  if (!label) return null;
  return (
    <View style={[styles.routingBadge, compact && styles.routingBadgeCompact]}>
      <Text style={styles.routingBadgeText}>{label}</Text>
    </View>
  );
}

function routingLabel(note: Note) {
  if (note.routing_status === 'pending_review') return '…';
  if (note.routing_status === 'routing') return '◌';
  if (note.routing_status === 'route_failed') return '!';
  if (note.is_pinned) return '⌖';
  if (note.parent_note_id) return `↳${formatConfidence(note.ai_thread_confidence)}`;
  if (note.ai_thread_reason) return `↔${formatConfidence(note.ai_thread_confidence)}`;
  return null;
}

function formatConfidence(value?: number | null) {
  if (typeof value !== 'number') return '';
  return ` · ${Math.round(value * 100)}%`;
}

function NoteDetail({
  note,
  relatedNotes,
  sourceLogs,
  saving,
  voiceJob,
  onBack,
  onSave,
  onDelete,
  onTogglePin,
  onDetachLog,
  playback,
  onPlayVoice,
  onPauseVoice,
  onStopVoice,
  onRetryVoice,
  onOpenRelated,
  onOpenRelatedThoughtFlow,
  onRewriteNote,
  rewriting,
}: {
  note: Note;
  relatedNotes: Note[];
  sourceLogs: Note[];
  saving: boolean;
  voiceJob?: VoiceJob;
  playback: AudioPlaybackState | null;
  onPlayVoice: (note: Note) => Promise<void>;
  onPauseVoice: () => Promise<void>;
  onStopVoice: () => Promise<void>;
  onBack: () => void;
  onSave: (noteId: string, nextText: string) => Promise<void>;
  onDelete: (note: Note) => void;
  onTogglePin: (noteId: string) => Promise<void>;
  onDetachLog: (log: Note) => Promise<void>;
  onRetryVoice: (note: Note) => Promise<void>;
  onOpenRelated: (note: Note) => void;
  onOpenRelatedThoughtFlow: (flow: ThoughtFlow) => void;
  onRewriteNote: (note: Note) => Promise<void>;
  rewriting: boolean;
}) {
  const category = inferCategory(note);
  const questions = makeFollowUpQuestions(note);
  const [isEditing, setIsEditing] = useState(false);
  const [logsExpanded, setLogsExpanded] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [draftText, setDraftText] = useState(note.raw_text);
  const noteMeaning = inferMeaning(note);
  const relatedCandidates = useMemo(() => relatedNotes.map((related) => scoreRelatedNote(note, related)), [note, relatedNotes]);
  const relatedThoughtFlow = useMemo(() => relatedNotes.length ? buildRelatedThoughtFlow(note, relatedNotes) : null, [note, relatedNotes]);

  useEffect(() => {
    setDraftText(note.raw_text);
    setIsEditing(false);
  }, [note.id, note.raw_text]);

  async function saveEdit() {
    await onSave(note.id, draftText);
    setIsEditing(false);
  }

  async function exportNote() {
    const markdown = buildNoteExportMarkdown(note, sourceLogs, relatedNotes);
    const title = `${note.ai_title || makeDraftTitle(note.raw_text)}.md`;

    setExporting(true);
    try {
      if (Platform.OS === 'ios' && FileSystem.cacheDirectory) {
        const fileUri = `${FileSystem.cacheDirectory}${makeSafeFileName(note.ai_title || makeDraftTitle(note.raw_text))}.md`;
        await FileSystem.writeAsStringAsync(fileUri, markdown, { encoding: FileSystem.EncodingType.UTF8 });
        await Share.share({ title, url: fileUri });
      } else {
        await Share.share({ title, message: markdown });
      }
    } catch (error) {
      showError('내보내기 실패', error);
    } finally {
      setExporting(false);
    }
  }

  const swipeBack = useSwipeBack(onBack);


  return (
    <Animated.View style={[styles.detailShell, swipeBack.animatedStyle]} {...swipeBack.responder.panHandlers}>
      <View style={styles.detailFixedTopBar}>
        <AppBackButton label="보관" onPress={onBack} />
        <View style={styles.detailActionRow}>
          <Pressable style={styles.iconActionButton} onPress={() => onTogglePin(note.id)} disabled={saving}>
            <Text style={styles.iconActionText}>{note.is_pinned ? '⌖' : '⌑'}</Text>
          </Pressable>
          <Pressable style={styles.iconActionButton} onPress={() => onDelete(note)} disabled={saving}>
            <Text style={styles.iconActionText}>…</Text>
          </Pressable>
        </View>
      </View>

      <ScrollView
        contentContainerStyle={styles.detailContent}
        keyboardShouldPersistTaps="handled"
        contentInsetAdjustmentBehavior="never"
        scrollIndicatorInsets={{ bottom: 180 }}
      >
      <View style={styles.detailHero}>
        <Text style={styles.flowMergedKicker}>원본 생각</Text>
        <CopyableText style={styles.detailTitle} copyValue={note.ai_title || makeDraftTitle(note.raw_text)}>{note.ai_title || makeDraftTitle(note.raw_text)}</CopyableText>
        <View style={styles.noteMetaRow}>
          <View style={styles.noteMetaLeft}>
            <Text style={styles.noteType}>{note.source_type === 'voice' ? '🎙' : '✎'}</Text>
            <Text style={styles.singleCategory}>{category}</Text>
          </View>
          <Text style={styles.noteDate}>{formatDate(note.created_at)}</Text>
        </View>
        <View style={styles.noteHeroActionRow}>
          <Pressable
            style={[styles.noteRewriteButton, rewriting && styles.disabledButton]}
            onPress={() => onRewriteNote(note)}
            disabled={rewriting || saving}
          >
            <Text style={styles.noteRewriteButtonText}>{rewriting ? '정리 중...' : '원본 다시 정리하기'}</Text>
          </Pressable>
          <Pressable
            style={[styles.noteExportButton, exporting && styles.disabledButton]}
            onPress={exportNote}
            disabled={exporting}
          >
            <Text style={styles.noteExportButtonText}>{exporting ? '내보내는 중...' : '내보내기'}</Text>
          </Pressable>
        </View>
        <View style={styles.compactMetaRow}>
          {note.audio_url ? <Text style={styles.iconMeta}>◉</Text> : null}
          <RoutingBadge note={note} />
          <Text style={styles.iconMeta}>💬 {Math.max(0, sourceLogs.length - 1)}</Text>
          {relatedNotes.length ? <Text style={styles.iconMeta}>↔ {relatedNotes.length}</Text> : null}
        </View>
      </View>

      <NoteAudioBlock
        note={note}
        voiceJob={voiceJob}
        saving={saving}
        playback={playback}
        onPlayVoice={onPlayVoice}
        onPauseVoice={onPauseVoice}
        onStopVoice={onStopVoice}
        onRetryVoice={onRetryVoice}
      />

      <View style={styles.threadSection}>
        <View style={styles.threadHeaderRow}>
          <Text style={styles.threadHeaderIcon}>전사 원문</Text>
          <Pressable style={styles.iconActionButton} onPress={() => setLogsExpanded((value) => !value)}>
            <Text style={styles.iconActionText}>{logsExpanded ? '⌃' : `＋${Math.max(0, sourceLogs.length - 1)}`}</Text>
          </Pressable>
        </View>
        {(logsExpanded ? sourceLogs : sourceLogs.slice(0, 1)).map((log, index) => (
          <ThreadLogItem
            key={log.id}
            log={log}
            index={index}
            expanded={logsExpanded}
            saving={saving}
            onDetachLog={onDetachLog}
          />
        ))}
        {!logsExpanded && sourceLogs.length > 1 ? (
          <Pressable style={styles.threadMoreButton} onPress={() => setLogsExpanded(true)}>
            <Text style={styles.threadMoreText}>＋{sourceLogs.length - 1}</Text>
          </Pressable>
        ) : null}
        <View style={styles.threadEditRow}>
          <Pressable style={styles.iconActionButton} onPress={() => setIsEditing((value) => !value)} disabled={saving}>
            <Text style={styles.iconActionText}>{isEditing ? '×' : '✎'}</Text>
          </Pressable>
        </View>
        {isEditing ? (
          <View style={styles.editBox}>
            <TextInput
              style={styles.editInput}
              multiline
              scrollEnabled
              value={draftText}
              onChangeText={setDraftText}
              placeholder="생각 원문을 다듬어보세요"
              textAlignVertical="top"
            />
            <Pressable
              style={[styles.primaryButton, saving && styles.disabledButton]}
              onPress={saveEdit}
              disabled={saving || !draftText.trim()}
            >
              <Text style={styles.primaryButtonText}>{saving ? '저장 중...' : '저장하고 다시 정리'}</Text>
            </Pressable>
          </View>
        ) : null}
      </View>


      <View style={styles.originalSummaryCard}>
        <Text style={styles.originalSummaryLabel}>AI 요약</Text>
        <CopyableText style={styles.detailSummary} copyValue={note.ai_summary || makeDraftSummary(note.raw_text)}>{note.ai_summary || makeDraftSummary(note.raw_text)}</CopyableText>
      </View>

      {relatedThoughtFlow ? (
        <Pressable style={styles.rediscoveryBanner} onPress={() => onOpenRelatedThoughtFlow(relatedThoughtFlow)} accessibilityLabel="연결된 생각 열기">
          <Text style={styles.rediscoveryBannerKicker}>연결된 생각</Text>
          <Text style={styles.rediscoveryBannerTitle}>이어볼 만한 원본이 {relatedNotes.length}개 있어요</Text>
          <Text style={styles.rediscoveryBannerHint}>탭해서 자라난 생각으로 보기</Text>
        </Pressable>
      ) : null}

      <View style={styles.detailSection}>
        <Text style={styles.detailSectionTitle}>연결된 원본</Text>
        {relatedCandidates.length ? (
          relatedCandidates.map((candidate) => (
            <Pressable key={candidate.note.id} style={styles.relatedItem} onPress={() => onOpenRelated(candidate.note)}>
              <View style={styles.relatedMetaRow}>
                <Text style={styles.relatedMeta}>↔ {candidate.meaning.memoryType}</Text>
                <Text style={styles.relatedMeta}>{formatDate(candidate.note.created_at)}</Text>
              </View>
              <CopyableText
                style={styles.relatedTitle}
                numberOfLines={1}
                copyValue={candidate.note.ai_title || makeDraftTitle(candidate.note.raw_text)}
              >
                {candidate.note.ai_title || makeDraftTitle(candidate.note.raw_text)}
              </CopyableText>
              <CopyableText
                style={styles.relatedBody}
                numberOfLines={2}
                copyValue={candidate.reasons[0] ?? candidate.note.raw_text}
              >
                {candidate.reasons[0] ?? candidate.note.raw_text}
              </CopyableText>
            </Pressable>
          ))
        ) : (
          <Text style={styles.emptyInline}>아직 이어진 원본이 없어요.</Text>
        )}
      </View>
      </ScrollView>
    </Animated.View>
  );
}

function DebugRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.debugRow}>
      <Text style={styles.debugLabel}>{label}</Text>
      <Text style={styles.debugValue}>{value || '-'}</Text>
    </View>
  );
}

function CopyableText({
  children,
  copyValue,
  style,
  numberOfLines,
}: {
  children: ReactNode;
  copyValue: string;
  style?: any;
  numberOfLines?: number;
}) {
  const [feedback, setFeedback] = useState<string | null>(null);
  const feedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (feedbackTimerRef.current) clearTimeout(feedbackTimerRef.current);
    };
  }, []);

  async function copyText() {
    const copied = await copyTextWithFallback(copyValue);
    setFeedback(copied ? '복사했어요' : '공유 메뉴를 열었어요');
    if (feedbackTimerRef.current) clearTimeout(feedbackTimerRef.current);
    feedbackTimerRef.current = setTimeout(() => setFeedback(null), COPY_FEEDBACK_MS);
  }

  return (
    <Pressable style={styles.copyableTextWrap} onLongPress={copyText} delayLongPress={350}>
      <Text style={style} numberOfLines={numberOfLines}>{children}</Text>
      {feedback ? <Text style={styles.copyFeedbackText}>{feedback}</Text> : null}
    </Pressable>
  );
}

async function copyTextWithFallback(value: string) {
  const text = value.trim();
  if (!text) return false;

  if (Platform.OS !== 'web') {
    await Clipboard.setStringAsync(text);
    return true;
  }

  const webClipboard = (globalThis as { navigator?: { clipboard?: { writeText?: (text: string) => Promise<void> } } }).navigator?.clipboard;
  if (webClipboard?.writeText) {
    await webClipboard.writeText(text);
    return true;
  }

  await Share.share({ message: text });
  return false;
}


function formatRecordingTime(ms: number) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60).toString().padStart(2, '0');
  const seconds = (totalSeconds % 60).toString().padStart(2, '0');
  return `${minutes}:${seconds}`;
}

function formatAudioDuration(ms?: number | null) {
  if (!ms || ms <= 0) return '음성';
  const totalSeconds = Math.max(1, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes <= 0) return `${seconds}초`;
  if (seconds === 0) return `${minutes}분`;
  return `${minutes}분 ${seconds}초`;
}

function NoteAudioBlock({
  note,
  voiceJob,
  saving,
  playback,
  onPlayVoice,
  onPauseVoice,
  onStopVoice,
  onRetryVoice,
}: {
  note: Note;
  voiceJob?: VoiceJob;
  saving: boolean;
  playback: AudioPlaybackState | null;
  onPlayVoice: (note: Note) => Promise<void>;
  onPauseVoice: () => Promise<void>;
  onStopVoice: () => Promise<void>;
  onRetryVoice: (note: Note) => Promise<void>;
}) {
  const audioRef = note.local_audio_url ?? note.audio_url;
  const hasAudio = !!audioRef;
  const isPersistedFailed = isFailedVoiceNote(note);
  const isFailed = voiceJob?.status === 'failed' || isPersistedFailed;
  const shouldShow = hasAudio || (voiceJob && voiceJob.status !== 'done') || isPersistedFailed;
  if (!shouldShow) return null;

  const durationMs = playback?.durationMs || note.audio_duration_ms || 0;
  const positionMs = playback?.positionMs ?? 0;
  const progress = durationMs > 0 ? Math.min(1, positionMs / durationMs) : 0;
  const isPlaying = !!playback && !playback.paused && !playback.loading;
  const bars = [10, 22, 14, 28, 18, 34, 12, 26, 16, 30, 20, 24];

  return (
    <View style={styles.noteAudioBlock}>
      <View style={styles.noteAudioTopRow}>
        <View style={styles.noteAudioTextWrap}>
          <Text style={styles.noteAudioKicker}>음성 메모</Text>
          <Text style={styles.noteAudioTitle}>{voiceJob && voiceJob.status !== 'done' ? voiceJob.message : isPersistedFailed ? '전사에 실패했지만 원본 음성은 보관되어 있어요' : '원본 녹음이 보관되어 있어요'}</Text>
        </View>
        <Text style={styles.noteAudioBadge}>{isFailed ? '실패' : hasAudio ? '보관됨' : '처리 중'}</Text>
      </View>
      <View style={styles.noteWaveformRow}>
        {bars.map((height, index) => {
          const filled = index / bars.length <= progress;
          return <View key={`${height}-${index}`} style={[styles.noteWaveformBar, { height }, filled && styles.noteWaveformBarActive, isPlaying && { opacity: index % 2 ? 0.72 : 1 }]} />;
        })}
      </View>
      {hasAudio ? (
        <>
          <Text style={styles.noteAudioTime}>{formatRecordingTime(positionMs)} / {durationMs ? formatRecordingTime(durationMs) : formatAudioDuration(note.audio_duration_ms)}</Text>
          <View style={styles.noteAudioControlRow}>
            <Pressable style={styles.audioControlButton} onPress={() => onPlayVoice(note)} disabled={saving || playback?.loading}>
              <Text style={styles.audioControlButtonText}>{playback?.paused ? '다시 재생' : playback ? '재생 중' : '원본 음성 듣기'}</Text>
            </Pressable>
            <Pressable style={styles.audioControlButtonSecondary} onPress={onPauseVoice} disabled={!playback || playback.paused}>
              <Text style={styles.audioControlButtonSecondaryText}>일시정지</Text>
            </Pressable>
            <Pressable style={styles.audioControlButtonSecondary} onPress={onStopVoice} disabled={!playback}>
              <Text style={styles.audioControlButtonSecondaryText}>정지</Text>
            </Pressable>
          </View>
        </>
      ) : null}
      {voiceJob?.error ? <Text style={styles.voiceErrorText}>{voiceJob.error}</Text> : null}
      {isFailed ? (
        <Pressable style={styles.retryButton} onPress={() => onRetryVoice(note)} disabled={saving}>
          <Text style={styles.retryButtonText}>음성 다시 전사</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function ThreadLogItem({
  log,
  index,
  expanded,
  saving,
  onDetachLog,
}: {
  log: Note;
  index: number;
  expanded: boolean;
  saving: boolean;
  onDetachLog: (log: Note) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const showFull = expanded || open;

  return (
    <View style={styles.threadLogRow}>
      <View style={styles.threadRail}>
        <View style={styles.threadDot} />
        <View style={styles.threadLine} />
      </View>
      <Pressable style={styles.threadLogBody} onPress={() => setOpen((value) => !value)}>
        <View style={styles.threadLogMetaRow}>
          <Text style={styles.logMeta}>{index === 0 ? '원문' : '↳'} · {formatDate(log.created_at)}</Text>
          {!showFull && log.raw_text.length > 90 ? <Text style={styles.threadMoreText}>⌄</Text> : null}
        </View>
        <CopyableText style={styles.logBody} numberOfLines={showFull ? undefined : 3} copyValue={log.raw_text}>
          {log.raw_text}
        </CopyableText>
        {showFull && log.ai_thread_reason ? <Text style={styles.logReason}>↔ {log.ai_thread_reason}</Text> : null}
        {showFull && log.parent_note_id ? (
          <Pressable style={styles.detachButton} onPress={() => onDetachLog(log)} disabled={saving}>
            <Text style={styles.detachButtonText}>분리</Text>
          </Pressable>
        ) : null}
      </Pressable>
    </View>
  );
}

function buildCollectionSummaries(notes: Note[]): CollectionSummary[] {
  const definitions = [
    { id: 'app', title: '앱 기능', description: '화면, 기능, 사용성에 대한 생각', keywords: ['앱', 'ui', 'ux', '화면', '기능', '메모', '사용자'] },
    { id: 'marketing', title: '마케팅', description: '홍보, 쇼츠, 카피, 콘텐츠 아이디어', keywords: ['마케팅', '홍보', '쇼츠', '카피', '콘텐츠', '유튜브'] },
    { id: 'game', title: '게임 아이디어', description: '게임 개발과 플레이 경험 관련 생각', keywords: ['게임', '통나무', '스팀', '유닛', '전투'] },
    { id: 'later', title: '나중에 볼 것', description: '아직 분류하기 애매하지만 보존할 생각', keywords: ['나중', '참고', '자료', '링크', '확인'] },
  ];

  const used = new Set<string>();
  const collections = definitions.map((definition) => {
    const matched = notes.filter((note) => {
      const text = noteText(note);
      const ok = definition.keywords.some((keyword) => text.includes(keyword.toLowerCase()));
      if (ok) used.add(note.id);
      return ok;
    });
    return { id: definition.id, title: definition.title, description: definition.description, notes: matched };
  });

  const uncategorized = notes.filter((note) => !used.has(note.id));
  collections.push({ id: 'uncategorized', title: '기타 생각', description: 'AI 자동 정리 전 임시 보관함', notes: uncategorized });

  return collections.filter((collection) => collection.notes.length > 0 || collection.id !== 'uncategorized');
}


function buildThoughtFlowsFromDrafts(generatedDrafts: Record<string, MergedThoughtDraft>, notes: Note[]) {
  const byId = new Map(notes.map((note) => [note.id, note]));
  const flows: ThoughtFlow[] = [];

  for (const draft of Object.values(generatedDrafts)) {
    if (!draft.sourceNoteIds.length) continue;
    const sourceNotes = draft.sourceNoteIds.map((id) => byId.get(id)).filter((note): note is Note => !!note);
    if (sourceNotes.length === 0) continue;
    const now = draft.createdAt || new Date().toISOString();
    const context = buildConnectionCorpusContext(sourceNotes);
    const profiles = sourceNotes.map((note) => inferMeaning(note));
    const sharedProblem = mostCommon(profiles.map((profile) => profile.problem).filter(isMeaningfulThoughtFlowKey))
      || mostCommonConnectionTerms(sourceNotes, context)[0]
      || draft.title
      || '저장된 자라난 생각';
    const sharedIntent = mostCommon(profiles.map((profile) => profile.intent).filter(isMeaningfulThoughtFlowKey)) || sharedProblem;
    const sharedDecisionAxis = mostCommon(profiles.map((profile) => profile.decisionAxis).filter(isMeaningfulThoughtFlowKey)) || sharedProblem;
    const sortedNotes = [...sourceNotes].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

    flows.push({
      id: draft.flowId,
      status: draft.status === 'saved' ? 'saved' : 'temporary',
      title: draft.title || sharedProblem,
      noteIds: draft.sourceNoteIds,
      notes: sortedNotes,
      mergedDraft: draft,
      sharedProblem,
      sharedIntent,
      sharedDecisionAxis,
      synthesis: draft.body.split('\n').find((line) => line.trim().length > 20)?.trim() || sharedProblem,
      whyNow: '이미 정리해둔 생각이라 흐름 탭에서 다시 이어볼 수 있어요.',
      nextQuestion: makeLocalFallbackNextQuestion(draft.judgmentSummary, draft.title || sharedProblem),
      createdAt: sortedNotes[sortedNotes.length - 1]?.created_at ?? now,
      updatedAt: draft.createdAt || sortedNotes[0]?.updated_at || sortedNotes[0]?.created_at || now,
      confidenceScore: 0.88,
    });
  }

  return flows.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

function mergeThoughtFlows(primary: ThoughtFlow[], secondary: ThoughtFlow[]) {
  const byId = new Map<string, ThoughtFlow>();
  const orderedIds: string[] = [];

  function normalizeFlow(flow: ThoughtFlow): ThoughtFlow {
    const draft = (flow as Partial<ThoughtFlow>).mergedDraft;
    if (draft?.body !== undefined) return flow;
    const now = flow.updatedAt || flow.createdAt || new Date().toISOString();
    const sharedProblem = flow.sharedProblem || flow.title || '저장된 자라난 생각';
    const sharedDecisionAxis = flow.sharedDecisionAxis || sharedProblem;
    return {
      ...flow,
      sharedProblem,
      sharedDecisionAxis,
      mergedDraft: buildFallbackMergedThoughtDraft(flow.id, flow.title, flow.notes ?? [], sharedProblem, sharedDecisionAxis, now),
    };
  }

  function upsert(inputFlow: ThoughtFlow, preferExistingDraft: boolean) {
    const flow = normalizeFlow(inputFlow);
    const existingRaw = byId.get(flow.id);
    const existing = existingRaw ? normalizeFlow(existingRaw) : null;
    if (!existing) {
      byId.set(flow.id, flow);
      orderedIds.push(flow.id);
      return;
    }

    const existingHasDraft = existing.mergedDraft.body.trim().length > 0;
    const nextHasDraft = flow.mergedDraft.body.trim().length > 0;
    const mergedDraft = preferExistingDraft && existingHasDraft && !nextHasDraft ? existing.mergedDraft : flow.mergedDraft;
    byId.set(flow.id, {
      ...existing,
      ...flow,
      title: mergedDraft.title || flow.title || existing.title,
      mergedDraft,
      updatedAt: [existing.updatedAt, flow.updatedAt].sort().at(-1) ?? flow.updatedAt,
    });
  }

  primary.forEach((flow) => upsert(flow, true));
  secondary.forEach((flow) => upsert(flow, true));

  return orderedIds.map((id) => byId.get(id)).filter((flow): flow is ThoughtFlow => !!flow).slice(0, 8);
}

function computeThoughtFlowFingerprint(notes: Note[], feedback: RetrievalFeedbackMap) {
  const notePart = notes
    .map((note) => [note.id, note.updated_at ?? note.created_at, note.parent_note_id ?? '', note.deleted_at ?? ''].join(':'))
    .sort()
    .join('|');
  const feedbackPart = Object.entries(feedback)
    .map(([id, value]) => `${id}:${value.status}:${value.usedCount}:${value.updatedAt}`)
    .sort()
    .join('|');
  return stableHash(`${notePart}::${feedbackPart}`);
}

function stableHash(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function pickCohesiveFlowNotes(seed: Note, candidates: Note[], limit = 8, context = buildConnectionCorpusContext(candidates)) {
  return candidates
    .map((note) => {
      if (note.id === seed.id) return { note, score: 99 };
      const scored = scoreRelatedNote(seed, note, {}, context);
      const lowSignalPenalty = isLowSignalThoughtNote(note) ? -10 : 0;
      return { note, score: scored.score + lowSignalPenalty };
    })
    .filter((item) => item.note.id === seed.id || item.score >= 3.4)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((item) => item.note);
}

const GENERIC_THOUGHT_FLOW_KEYS = [
  '비슷한 생각을 다시 판단할 때',
  '나중에 다시 참고하려고 남긴 생각',
  '생각이 떠올라 임시로 붙잡는 중',
  '지금의 생각과 연결해 다음 판단의 재료로 쓸 수 있습니다.',
];

function isGenericThoughtFlowKey(value?: string | null) {
  const key = value?.trim();
  if (!key) return true;
  return GENERIC_THOUGHT_FLOW_KEYS.some((generic) => key === generic || key.includes(generic));
}

function isMeaningfulThoughtFlowKey(value?: string | null) {
  const key = value?.trim();
  if (!key || key.length < 8) return false;
  return !isGenericThoughtFlowKey(key);
}

function isLowSignalThoughtNote(note: Note) {
  const text = noteText(note).toLowerCase();
  if (text.length < 12) return true;
  return ['quota', '429', '테스트', 'test', '전사 실패', '업로드하는 중', '전사하는 중'].some((word) => text.includes(word.toLowerCase()));
}

function buildRetrievalSections(notes: Note[], feedback: RetrievalFeedbackMap) {
  const visible = notes
    .filter((note) => feedback[note.id]?.status !== 'hidden')
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  const latest = visible[0];
  const used = new Set<string>();

  const take = (candidates: RetrievalCandidate[], limit: number) => {
    const picked: RetrievalCandidate[] = [];
    for (const candidate of candidates) {
      if (used.has(candidate.note.id)) continue;
      picked.push(candidate);
      used.add(candidate.note.id);
      if (picked.length >= limit) break;
    }
    return picked;
  };

  const connectionContext = buildConnectionCorpusContext(visible);
  const thoughtFlows = buildThoughtFlows(visible, feedback, connectionContext);

  const relatedToLatest = latest
    ? retrieveCandidates(latest, visible, feedback, connectionContext)
        .filter((item) => item.note.id !== latest.id)
        .map((item) => {
          const latestTitle = latest.ai_title || makeDraftTitle(latest.raw_text);
          const reason = item.reasons[0] ?? '최근 생각과 이어지는 판단 재료입니다.';
          return {
            note: item.note,
            section: 'connected' as const,
            surfaceReason: `최근 “${latestTitle}”와 이어지는 맥락이라 다시 꺼냈어요.`,
            recentConnection: `“${latestTitle}”와 연결됩니다. ${reason}`,
            useSuggestion: inferMeaning(item.note).reusePurpose,
            connectedNote: latest,
            connectionReason: makeReadableConnectionReason(item.note, latest, item),
          };
        })
    : [];

  const topicRepeated = visible
    .map((note) => {
      const related = retrieveCandidates(note, visible, feedback, connectionContext).filter((item) => item.note.id !== note.id);
      return { note, relatedCount: related.length, topRelated: related[0]?.note };
    })
    .filter((item) => item.relatedCount > 0)
    .sort((a, b) => b.relatedCount - a.relatedCount)
    .map((item) => {
      const relatedTitle = item.topRelated ? item.topRelated.ai_title || makeDraftTitle(item.topRelated.raw_text) : null;
      const topScore = item.topRelated ? scoreRelatedNote(item.note, item.topRelated) : null;
      const meaning = inferMeaning(item.note);
      return {
        note: item.note,
        section: 'today' as const,
        surfaceReason: item.relatedCount >= 2
          ? `최근 메모에서 ‘${meaning.intent}’ 흐름이 반복되고 있어요.`
          : `이 메모는 ‘${meaning.intent}’이에요.`,
        recentConnection: relatedTitle && topScore ? `“${relatedTitle}”와 연결됩니다. ${topScore.reasons[0] ?? '같은 맥락을 공유해요.'}` : undefined,
        useSuggestion: meaning.reusePurpose,
        connectedNote: item.topRelated,
        connectionReason: item.topRelated && topScore ? makeReadableConnectionReason(item.note, item.topRelated, topScore) : undefined,
      };
    });

  const buried = visible
    .filter((note) => daysSince(note.created_at) >= 3)
    .sort((a, b) => daysSince(b.created_at) - daysSince(a.created_at))
    .map((note) => ({
      note,
      section: 'buried' as const,
      surfaceReason: `${daysSince(note.created_at)}일 동안 다시 보지 않은 생각이에요.`,
      recentConnection: latest && latest.id !== note.id ? `최근 생각과 직접 연결되지 않아도, 오래 묻혀 있던 판단 재료예요.` : undefined,
      useSuggestion: makeUseSuggestion(note),
    }));

  const recent = visible.slice(0, 5).map((note) => ({
    note,
    section: 'recent' as const,
    surfaceReason: '최근 남긴 생각이라 바로 이어서 다듬기 좋아요.',
    useSuggestion: makeUseSuggestion(note),
  }));

  return {
    thoughtFlows,
    today: take(topicRepeated, 3),
    connected: take(relatedToLatest, 3),
    buried: take(buried, 3),
    recent,
  };
}

function buildThoughtFlows(notes: Note[], feedback: RetrievalFeedbackMap, existingContext?: ConnectionCorpusContext): ThoughtFlow[] {
  const visible = notes.filter((note) => feedback[note.id]?.status !== 'hidden' && !isLowSignalThoughtNote(note));
  const context = existingContext ?? buildConnectionCorpusContext(visible);
  const clusters = buildMechanicalNoteClusters(visible, feedback, context);
  const flows: ThoughtFlow[] = [];

  for (const cluster of clusters) {
    if (cluster.notes.length < 2) continue;
    const seed = [...cluster.notes].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0];
    const cohesiveNotes = pickCohesiveFlowNotes(seed, cluster.notes, 5, context);
    if (cohesiveNotes.length < 2) continue;
    const ranked = cohesiveNotes
      .map((note) => ({ note, profile: inferMeaning(note) }))
      .sort((a, b) => new Date(b.note.created_at).getTime() - new Date(a.note.created_at).getTime())
      .slice(0, 5);
    const profiles = ranked.map((item) => item.profile);
    const sharedProblem = mostCommon(profiles.map((profile) => profile.problem).filter(isMeaningfulThoughtFlowKey)) || cluster.sharedTerms[0] || '서로 이어지는 생각';
    const sharedIntent = mostCommon(profiles.map((profile) => profile.intent).filter(isMeaningfulThoughtFlowKey)) || sharedProblem;
    const sharedDecisionAxis = mostCommon(profiles.map((profile) => profile.decisionAxis).filter(isMeaningfulThoughtFlowKey)) || sharedProblem;
    const flowTitle = makeFlowTitle(sharedProblem, sharedDecisionAxis);
    if (isGenericThoughtFlowKey(flowTitle)) continue;
    const confidenceScore = Math.min(0.95, 0.42 + ranked.length * 0.08 + cluster.averageScore * 0.04);
    const now = new Date().toISOString();
    const noteIds = ranked.map((item) => item.note.id);
    const sourceNotes = ranked.map((item) => item.note);
    const sharedTermsText = cluster.sharedTerms.length ? ` (${cluster.sharedTerms.slice(0, 4).join(', ')})` : '';
    flows.push({
      id: `flow-${slugifyFlowId(flowTitle)}-${noteIds.join('-')}`,
      status: 'temporary',
      title: flowTitle,
      noteIds,
      notes: sourceNotes,
      mergedDraft: buildFallbackMergedThoughtDraft(`flow-${slugifyFlowId(flowTitle)}-${noteIds.join('-')}`, flowTitle, sourceNotes, sharedProblem, sharedDecisionAxis, now),
      sharedProblem,
      sharedIntent,
      sharedDecisionAxis,
      synthesis: `이 흐름은 비슷한 표현과 문제의식을 가진 원본들이 함께 모인 정리예요${sharedTermsText}. 중심 문제는 ‘${sharedProblem}’로 읽을 수 있어요.`,
      whyNow: `최근 메모와 과거 메모를 함께 보면 반복되는 생각의 방향을 확인할 수 있어요.`,
      nextQuestion: `이 연결된 메모들을 하나의 판단이나 다음 행동으로 줄이면 무엇이 남을까?`,
      createdAt: ranked[ranked.length - 1]?.note.created_at ?? now,
      updatedAt: ranked[0]?.note.updated_at ?? ranked[0]?.note.created_at ?? now,
      confidenceScore,
    });
  }

  const relatedPairFlows = buildRelatedPairThoughtFlows(visible, feedback, context);
  const pinnedFlow = buildPinnedPlanningThoughtFlow(visible);
  const allFlows = pinnedFlow ? [pinnedFlow, ...flows, ...relatedPairFlows] : [...flows, ...relatedPairFlows];

  const sortedFlows = allFlows.sort(
    (a, b) => (b.confidenceScore ?? 0) - (a.confidenceScore ?? 0) || b.notes.length - a.notes.length,
  );
  const dedupedFlows: ThoughtFlow[] = [];

  for (const flow of sortedFlows) {
    const titleKey = normalizeFlowDedupeKey(flow.title);
    const isDuplicate = dedupedFlows.some((picked) => {
      const pickedTitleKey = normalizeFlowDedupeKey(picked.title);
      return pickedTitleKey === titleKey || overlapRatio(picked.noteIds, flow.noteIds) >= 0.5;
    });

    if (!isDuplicate) dedupedFlows.push(flow);
    if (dedupedFlows.length >= 5) break;
  }

  return dedupedFlows;
}

function buildRelatedPairThoughtFlows(notes: Note[], feedback: RetrievalFeedbackMap, context: ConnectionCorpusContext) {
  const flows: ThoughtFlow[] = [];
  const seenPairs = new Set<string>();

  for (const note of notes) {
    const related = retrieveCandidates(note, notes, feedback, context).filter((item) => item.note.id !== note.id)[0];
    if (!related) continue;
    const pairKey = [note.id, related.note.id].sort().join(':');
    if (seenPairs.has(pairKey)) continue;
    seenPairs.add(pairKey);
    flows.push(buildRelatedThoughtFlow(note, [related.note], context));
  }

  return flows;
}

function buildRelatedThoughtFlow(seed: Note, relatedNotes: Note[], existingContext?: ConnectionCorpusContext): ThoughtFlow {
  const now = new Date().toISOString();
  const sourceNotes = [seed, ...relatedNotes]
    .filter((note, index, array) => array.findIndex((item) => item.id === note.id) === index)
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .slice(0, 5);
  const context = existingContext ?? buildConnectionCorpusContext(sourceNotes);
  const profiles = sourceNotes.map((note) => inferMeaning(note));
  const sharedProblem = mostCommon(profiles.map((profile) => profile.problem).filter(isMeaningfulThoughtFlowKey))
    || mostCommonConnectionTerms(sourceNotes, context)[0]
    || inferMeaning(seed).problem
    || '서로 이어지는 생각';
  const sharedIntent = mostCommon(profiles.map((profile) => profile.intent).filter(isMeaningfulThoughtFlowKey)) || sharedProblem;
  const sharedDecisionAxis = mostCommon(profiles.map((profile) => profile.decisionAxis).filter(isMeaningfulThoughtFlowKey)) || sharedProblem;
  const fallbackTitle = seed.ai_title || makeDraftTitle(seed.raw_text);
  const flowTitle = isGenericThoughtFlowKey(makeFlowTitle(sharedProblem, sharedDecisionAxis)) ? fallbackTitle : makeFlowTitle(sharedProblem, sharedDecisionAxis);
  const noteIds = sourceNotes.map((note) => note.id);
  const flowId = `flow-related-${slugifyFlowId(flowTitle)}-${noteIds.join('-')}`;
  const topConnection = sourceNotes[1] ? scoreRelatedNote(seed, sourceNotes[1], {}, context) : null;

  return {
    id: flowId,
    status: 'temporary',
    title: flowTitle,
    noteIds,
    notes: sourceNotes,
    mergedDraft: buildFallbackMergedThoughtDraft(flowId, flowTitle, sourceNotes, sharedProblem, sharedDecisionAxis, now),
    sharedProblem,
    sharedIntent,
    sharedDecisionAxis,
    synthesis: topConnection?.reasons[0]
      ?? `이 흐름은 방금 본 원본과 이어볼 만한 원본을 함께 묶은 생각이에요.`,
    whyNow: `원본 상세에서 연결이 확인됐기 때문에, 흐름에서도 바로 이어 읽을 수 있게 올렸어요.`,
    nextQuestion: `이 연결된 메모들을 하나의 판단이나 다음 행동으로 줄이면 무엇이 남을까?`,
    createdAt: sourceNotes[sourceNotes.length - 1]?.created_at ?? now,
    updatedAt: sourceNotes[0]?.updated_at ?? sourceNotes[0]?.created_at ?? now,
    confidenceScore: Math.min(0.9, 0.58 + sourceNotes.length * 0.08 + (topConnection?.score ?? 0) * 0.03),
  };
}

function buildMechanicalNoteClusters(notes: Note[], feedback: RetrievalFeedbackMap, context: ConnectionCorpusContext) {
  const neighbors = new Map<string, RelatedCandidate[]>();
  const byId = new Map(notes.map((note) => [note.id, note]));

  for (let leftIndex = 0; leftIndex < notes.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < notes.length; rightIndex += 1) {
      const left = notes[leftIndex];
      const right = notes[rightIndex];
      const scoredRight = scoreRelatedNote(left, right, feedback, context);
      if (!isStrongRelatedCandidate(scoredRight)) continue;
      const scoredLeft = scoreRelatedNote(right, left, feedback, context);
      neighbors.set(left.id, [...(neighbors.get(left.id) ?? []), scoredRight]);
      neighbors.set(right.id, [...(neighbors.get(right.id) ?? []), scoredLeft]);
    }
  }

  const visited = new Set<string>();
  const clusters: Array<{ notes: Note[]; averageScore: number; sharedTerms: string[] }> = [];

  for (const note of notes) {
    if (visited.has(note.id)) continue;
    const queue = [note.id];
    const componentIds: string[] = [];
    const componentScores: number[] = [];
    visited.add(note.id);

    while (queue.length) {
      const id = queue.shift()!;
      componentIds.push(id);
      for (const edge of neighbors.get(id) ?? []) {
        componentScores.push(edge.score);
        if (!visited.has(edge.note.id)) {
          visited.add(edge.note.id);
          queue.push(edge.note.id);
        }
      }
    }

    if (componentIds.length < 2) continue;
    const componentNotes = componentIds.map((id) => byId.get(id)).filter((item): item is Note => !!item);
    const sharedTerms = mostCommonConnectionTerms(componentNotes, context);
    const averageScore = componentScores.length ? componentScores.reduce((sum, value) => sum + value, 0) / componentScores.length : 0;
    clusters.push({ notes: componentNotes, averageScore, sharedTerms });
  }

  return clusters.sort((a, b) => b.averageScore - a.averageScore || b.notes.length - a.notes.length);
}

function mostCommonConnectionTerms(notes: Note[], context: ConnectionCorpusContext) {
  const counts = new Map<string, number>();
  for (const note of notes) {
    for (const term of buildConnectionVector(note, context).keys()) counts.set(term, (counts.get(term) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([term]) => term)
    .slice(0, 8);
}

function buildPinnedPlanningThoughtFlow(notes: Note[]): ThoughtFlow {
  const titles = ['기획력이란 무엇인가', '엘시와 갈비스 대화 중계', '엘시 에더리 전략가 GPT'];
  const now = new Date().toISOString();
  const pinnedNotes = titles.map((title, index) => {
    const found = notes.find((note) => {
      const text = `${note.ai_title ?? ''} ${note.raw_text}`;
      return text.includes(title);
    });
    if (found) return found;
    return makeVirtualThoughtFlowNote(title, index, now);
  });

  return {
    id: 'thought-flow-planning-is-judgment-system',
    status: 'temporary',
    title: '기획은 판단 시스템이다',
    noteIds: pinnedNotes.map((note) => note.id),
    notes: pinnedNotes,
    mergedDraft: buildPinnedPlanningMergedDraft(pinnedNotes, now),
    synthesis:
      '원태님은 기획을 말이나 아이디어가 아니라, 기록된 생각을 다시 꺼내고 엘시GPT의 판단과 갈비스/OpenClaw/Codex의 실행 기록을 엮어 성공률을 높이는 시스템으로 보고 있어요.',
    sharedProblem: '기획을 감각이 아니라 반복 가능한 판단 구조로 만들 수 있을까?',
    whyNow:
      '생각회수기의 제품 방향도 이 흐름과 닮아 있어요. 흩어진 생각을 다시 꺼내고, 판단으로 연결해서 성공률을 높이려는 시도이기 때문이에요.',
    nextQuestion: '이 흐름을 생각회수기의 대표 사용 사례로 삼을 수 있을까?',
    createdAt: pinnedNotes[pinnedNotes.length - 1]?.created_at ?? now,
    updatedAt: pinnedNotes[0]?.updated_at ?? pinnedNotes[0]?.created_at ?? now,
    sharedIntent: '기획 성공률을 높이는 판단 시스템을 만들려는 생각',
    sharedDecisionAxis: '기획 성공률 판단',
    confidenceScore: 0.95,
  };
}

function buildPinnedPlanningMergedDraft(notes: Note[], now: string): MergedThoughtDraft {
  return {
    id: 'merged-draft-planning-is-judgment-system',
    flowId: 'thought-flow-planning-is-judgment-system',
    title: '메모앱의 본질은 “잊은 생각을 다시 만나게 하는 것”이다',
    body:
      '나는 계속 메모앱을 만들고 싶다고 말해왔다. 처음에는 그냥 아이디어를 저장하는 앱이라고 생각했다. 하지만 반복해서 나온 생각들을 보면, 내가 만들고 싶은 것은 단순한 메모장이 아니다.\n\n' +
      '내가 원하는 것은 내가 지나가며 말했던 생각, 잊어버린 생각, 아직 정리되지 않은 생각을 다시 회수해주는 앱이다. 메모는 적는 순간보다 나중에 다시 만나는 순간에 가치가 생긴다. 그런데 지금까지의 기록은 자주 흘러가버렸다. 말로 남긴 생각도, 대화 중에 나온 판단도, 기획으로 이어질 수 있었던 조각들도 시간이 지나면 어디에 있었는지 찾기 어려웠다.\n\n' +
      '예전에는 말은 많지만 문서로 남기지 않는 모습을 답답하게 봤다. 나는 문서로 보고 싶었다. 그런데 돌아보면 나도 크게 다르지 않았다. 나도 많은 생각을 말했고, 여러 번 같은 문제를 다시 꺼냈지만, 정작 그것이 하나의 기획 문서나 판단 구조로 잘 남지는 않았다. 결국 문제는 기록을 했느냐 안 했느냐만이 아니었다. 문제는 기록한 것들이 다시 나에게 돌아오지 않는다는 것이었다.\n\n' +
      '그래서 이 앱이 해야 할 일은 단순 저장이 아니다. 내가 음성이나 텍스트로 아무렇게나 남긴 말을 읽고, 그것이 일정인지, 알림인지, 기록으로 남겨야 할 생각인지, 특정 사람이나 고양이, 프로젝트에 붙어야 할 정보인지 구분해야 한다. 시간이 지나면 사라져도 되는 정보와 나중에 다시 회수해야 할 반복 생각도 달라야 한다.\n\n' +
      '사용자가 처음부터 카테고리를 정리하게 만들면 안 된다. 사람은 생각이 떠오르는 순간에 완벽한 분류 체계를 만들지 못한다. 먼저 흘려보내듯이 기록하고, 앱이 그 기록들을 보며 자동으로 묶어줘야 한다. 그렇게 되면 메모는 단순한 저장소가 아니라 나 자신에게 다시 보여주는 생각의 피드가 된다.\n\n' +
      '나는 기록을 통해 내 인공지능부를 만들고 싶다. 내가 반복해서 말한 생각들, 아직 문서가 되지 못한 기획들, 흘러가버린 아이디어들을 앱이 다시 모아주면, 나는 내가 어떤 문제를 계속 바라보고 있었는지 알 수 있다. 이 앱의 핵심 가치는 기록이 아니다. 핵심 가치는 망각된 생각의 회수다.\n\n' +
      '그리고 이 문제의 출발점에는 내 기획력에 대한 자각이 있다. 예전에는 기획이 입으로만 하는 것이라고 생각한 적도 있다. 하지만 이제는 안다. 기획은 말이 아니라 구조다. 생각을 기록하고, 분류하고, 다시 꺼내 보고, 행동으로 바꾸는 과정이다. 그래서 이 앱은 나에게도 필요하다. 내가 말로 흘려보낸 생각을 다시 붙잡고, 그것을 기획으로 바꾸기 위해서.',
    judgmentSummary: [
      '이 앱의 핵심 가치는 단순 기록이 아니라 망각된 생각의 회수다.',
      '메모는 처음부터 분류하는 것이 아니라, 흘려보낸 뒤 다시 묶이고 확장되어야 한다.',
      '기획은 말이 아니라 생각을 구조화하고 다시 행동으로 바꾸는 과정이다.',
    ],
    sourceNoteIds: notes.map((note) => note.id),
    createdAt: now,
    status: 'draft',
  };
}

function buildFallbackMergedThoughtDraft(
  flowId: string,
  title: string,
  notes: Note[],
  _sharedProblem: string,
  _sharedDecisionAxis: string,
  now: string,
): MergedThoughtDraft {
  return {
    id: `merged-draft-${slugifyFlowId(title)}-${notes.map((note) => note.id).join('-')}`,
    flowId,
    title,
    body: '',
    judgmentSummary: [],
    sourceNoteIds: notes.map((note) => note.id),
    createdAt: now,
    status: 'draft',
  };
}

function makeLocalFallbackNextQuestion(insights: string[], title: string) {
  const anchor = insights.find((item) => item.trim().length > 8) ?? title;
  return `${shortenLocalSentence(anchor)}을 실제 결정이나 다음 행동으로 바꾸려면 무엇을 먼저 정해야 할까?`;
}

function shortenLocalSentence(value: string) {
  const first = value.split(/[.!?。！？\n]/)[0]?.trim() || value.trim();
  return first.length > 54 ? `${first.slice(0, 54)}…` : first;
}

function makeVirtualThoughtFlowNote(title: string, index: number, now: string): Note {
  const summaries = [
    '기획력을 감각이 아니라 반복 가능한 판단 구조로 보려는 메모예요.',
    '엘시GPT의 판단과 갈비스의 실행을 이어서 보는 대화 흐름이에요.',
    '전략가 GPT를 통해 기획 판단의 품질을 높이려는 실험이에요.',
  ];
  return {
    id: `sample-thought-flow-note-${index + 1}`,
    raw_text: summaries[index] ?? title,
    ai_title: title,
    ai_summary: summaries[index] ?? title,
    ai_tags: ['기획', '판단', '생각흐름'],
    source_type: 'text',
    created_at: now,
    updated_at: now,
  };
}

function slugifyFlowId(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9가-힣]+/g, '-').replace(/^-|-$/g, '') || 'thought';
}

function makeFlowTitle(sharedProblem: string, decisionAxis: string) {
  if (sharedProblem.includes('기획')) return '기획력은 말이 아니라 판단 시스템이다';
  if (sharedProblem.includes('잊힌 생각') || sharedProblem.includes('회수')) return '생각회수기는 메모장이 아니라 회수 경험이다';
  if (decisionAxis.includes('MVP')) return 'v0.1은 무엇을 버릴지 정하는 싸움이다';
  return decisionAxis;
}

function mostCommon(values: string[]) {
  const counts = new Map<string, number>();
  for (const value of values.filter(Boolean)) counts.set(value, (counts.get(value) ?? 0) + 1);
  return Array.from(counts.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
}

function overlapRatio(a: string[], b: string[]) {
  const bSet = new Set(b);
  const shared = a.filter((id) => bSet.has(id)).length;
  return shared / Math.max(1, Math.min(a.length, b.length));
}

function normalizeFlowDedupeKey(title: string) {
  return title.replace(/\s+/g, '').trim();
}

function buildThoughtFlowExportMarkdown(flow: ThoughtFlow) {
  const draft = flow.mergedDraft;
  const sourceSections = flow.notes.map((note, index) => {
    const title = note.ai_title || makeDraftTitle(note.raw_text);
    const summary = note.ai_summary || makeDraftSummary(note.raw_text);
    return [
      `### ${index + 1}. ${title}`,
      '',
      `- 날짜: ${formatDate(note.created_at)}`,
      `- 요약: ${summary}`,
      '',
      '```text',
      note.raw_text.trim(),
      '```',
    ].join('\n');
  });

  return [
    `# ${draft.title}`,
    '',
    `내보낸 날짜: ${formatDate(new Date().toISOString())}`,
    `원본 메모: ${flow.notes.length}개`,
    '',
    '## 확장된 메모',
    '',
    draft.body.trim(),
    '',
    '## 요약',
    '',
    ...(draft.judgmentSummary.length ? draft.judgmentSummary.map((item) => `- ${item}`) : [`- ${flow.synthesis}`]),
    '',
    '## 원본 메모와 전사 요약',
    '',
    ...sourceSections,
    '',
    '## 분석 메모',
    '',
    `- 공통 고민: ${flow.sharedProblem}`,
    flow.sharedIntent ? `- 공통 의도: ${flow.sharedIntent}` : '',
    flow.sharedDecisionAxis ? `- 연결된 판단축: ${flow.sharedDecisionAxis}` : '',
    `- 다음 질문: ${flow.nextQuestion}`,
  ]
    .filter((line) => line !== '')
    .join('\n');
}

function buildNoteExportMarkdown(note: Note, sourceLogs: Note[], relatedNotes: Note[]) {
  const title = note.ai_title || makeDraftTitle(note.raw_text);
  const logs = sourceLogs.length ? sourceLogs : [note];
  const logSections = logs.map((log, index) => {
    const logTitle = log.ai_title || makeDraftTitle(log.raw_text);
    return [
      `### ${index === 0 ? '원본' : `이어진 원본 ${index}`} · ${logTitle}`,
      '',
      `- 날짜: ${formatDate(log.created_at)}`,
      log.ai_summary ? `- 요약: ${log.ai_summary}` : '',
      '',
      '```text',
      log.raw_text.trim(),
      '```',
    ].filter((line) => line !== '').join('\n');
  });
  const relatedSections = relatedNotes.slice(0, 5).map((related, index) => (
    `- ${index + 1}. ${related.ai_title || makeDraftTitle(related.raw_text)} · ${formatDate(related.created_at)}`
  ));

  return [
    `# ${title}`,
    '',
    `내보낸 날짜: ${formatDate(new Date().toISOString())}`,
    `메모 날짜: ${formatDate(note.created_at)}`,
    '',
    '## 요약',
    '',
    note.ai_summary || makeDraftSummary(note.raw_text),
    '',
    '## 전사 원문',
    '',
    '```text',
    note.raw_text.trim(),
    '```',
    '',
    logs.length > 1 ? '## 이어진 원본 로그' : '',
    logs.length > 1 ? '' : '',
    ...(logs.length > 1 ? logSections : []),
    relatedSections.length ? '## 다시 이어볼 생각' : '',
    relatedSections.length ? '' : '',
    ...relatedSections,
  ]
    .filter((line) => line !== '')
    .join('\n');
}

function makeSafeFileName(value: string) {
  const safe = value.trim().replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').slice(0, 48);
  return safe || 'thought-flow-export';
}

function makeReadableConnectionReason(source: Note, related: Note, candidate: RelatedCandidate) {
  const sourceMeaning = inferMeaning(source);
  const relatedMeaning = inferMeaning(related);
  const sourceTitle = source.ai_title || makeDraftTitle(source.raw_text);
  const relatedTitle = related.ai_title || makeDraftTitle(related.raw_text);
  if (sourceMeaning.reusePurpose === relatedMeaning.reusePurpose) {
    return `“${sourceTitle}”와 “${relatedTitle}”는 둘 다 ${sourceMeaning.reusePurpose} 다시 보면 좋은 메모라 함께 보면 좋아요.`;
  }
  if (sourceMeaning.intent === relatedMeaning.intent) {
    return `이 메모는 ‘${sourceMeaning.intent}’이에요. “${relatedTitle}”도 같은 의도라 이어서 보면 판단이 쉬워져요.`;
  }
  if (sourceMeaning.situation === relatedMeaning.situation) {
    return `둘 다 ‘${sourceMeaning.situation}’에서 나온 생각이라 같은 맥락으로 묶였어요.`;
  }
  return candidate.reasons[0] ?? `“${relatedTitle}”와 함께 보면 지금 생각의 배경을 더 잘 이해할 수 있어요.`;
}

function makeUseSuggestion(note: Note) {
  const text = noteText(note);
  if (text.includes('v01') || text.includes('v0.1') || text.includes('mvp') || text.includes('핵심') || text.includes('버릴')) {
    return 'v0.1에서 무엇을 남기고 무엇을 버릴지 정할 때 도움이 됩니다.';
  }
  if (text.includes('기획') || text.includes('문서') || text.includes('판단')) {
    return '지금 기획 판단을 더 선명하게 만들 때 다시 참고할 수 있습니다.';
  }
  if (text.includes('마케팅') || text.includes('랜딩') || text.includes('이메일') || text.includes('광고')) {
    return '나중에 수요 검증이나 랜딩페이지 문구를 만들 때 재료로 쓸 수 있습니다.';
  }
  if (text.includes('운동') || text.includes('무릎') || text.includes('러닝') || text.includes('건강')) {
    return '오늘 컨디션과 루틴을 조정할 때 과거 신호로 참고할 수 있습니다.';
  }
  if (text.includes('고양이') || text.includes('와이프') || text.includes('일상')) {
    return '일상에서 놓치기 쉬운 관심사를 다시 챙기는 데 쓸 수 있습니다.';
  }
  if (text.includes('앱') || text.includes('생각') || text.includes('회수')) {
    return '앱의 정체성과 회수 경험을 더 날카롭게 다듬을 때 도움이 됩니다.';
  }
  return '지금의 생각과 연결해 다음 판단의 재료로 쓸 수 있습니다.';
}

function retrieveCandidates(note: Note, notes: Note[], feedback: RetrievalFeedbackMap, existingContext?: ConnectionCorpusContext) {
  const context = existingContext ?? buildConnectionCorpusContext(notes);
  const candidates: RelatedCandidate[] = [];

  for (const candidate of notes) {
    if (candidate.id === note.id || feedback[candidate.id]?.status === 'hidden') continue;
    const scored = scoreRelatedNote(note, candidate, feedback, context);
    if (isStrongRelatedCandidate(scored)) candidates.push(scored);
  }

  return candidates
    .sort((a, b) => b.score - a.score)
    .slice(0, 20);
}

function rankRelatedNotes(note: Note, notes: Note[]) {
  return retrieveCandidates(note, notes, {});
}

function scoreRelatedNote(source: Note, candidate: Note, feedback: RetrievalFeedbackMap = {}, context?: ConnectionCorpusContext): RelatedCandidate {
  const corpus = context ?? buildConnectionCorpusContext([source, candidate]);
  const sourceMeaning = inferMeaning(source);
  const candidateMeaning = inferMeaning(candidate);
  const sourceVector = buildConnectionVector(source, corpus);
  const candidateVector = buildConnectionVector(candidate, corpus);
  const sharedTerms = sharedConnectionTerms(sourceVector, candidateVector).slice(0, 5);
  const reasons: string[] = [];
  const semanticSimilarity = cosineConnectionSimilarity(sourceVector, candidateVector);
  const semanticScore = Math.round(semanticSimilarity * 100) / 100;
  const sharedKeywords = candidateMeaning.keywords.filter((keyword) => sourceMeaning.keywords.includes(keyword));
  const keywordScore = sharedTerms.length >= 2 ? Math.min(2.5, sharedTerms.length * 0.55) : 0;
  const intentScore = semanticSimilarity >= 0.16 && sameMeaningfulConnectionValue(sourceMeaning.intent, candidateMeaning.intent) ? 2 : 0;
  const problemScore = semanticSimilarity >= 0.12 && sameMeaningfulConnectionValue(sourceMeaning.problem, candidateMeaning.problem) ? 3 : 0;
  const reusePurposeScore = semanticSimilarity >= 0.18 && sameMeaningfulConnectionValue(sourceMeaning.reusePurpose, candidateMeaning.reusePurpose) ? 1.5 : 0;
  const decisionAxisScore = semanticSimilarity >= 0.18 && sameMeaningfulConnectionValue(sourceMeaning.decisionAxis, candidateMeaning.decisionAxis) ? 1.5 : 0;
  const recencyContextScore = 0;
  const userFeedbackScore = feedback[candidate.id]?.status === 'useful' ? 2 + Math.min(3, feedback[candidate.id]?.usedCount ?? 0) : feedback[candidate.id]?.status === 'later' ? 1 : 0;
  const total = semanticSimilarity * 10 + keywordScore + intentScore + problemScore + reusePurposeScore + decisionAxisScore + recencyContextScore + userFeedbackScore;

  if (semanticSimilarity >= 0.28 && sharedTerms.length >= 2) reasons.push(`${sharedTerms.slice(0, 4).join(', ')} 표현이 함께 반복됩니다.`);
  else if (sharedTerms.length >= 2) reasons.push(`공통 단서: ${sharedTerms.slice(0, 4).join(', ')} 표현을 함께 포함합니다.`);
  if (sharedKeywords.length >= 2 && keywordScore > 0) reasons.push(`같은 주제: ${sharedKeywords.slice(0, 4).join(', ')} 키워드를 공유합니다.`);
  if (intentScore > 0) reasons.push(`같은 의도: 둘 다 ‘${sourceMeaning.intent}’ 메모입니다.`);
  if (problemScore > 0) reasons.push(`같은 문제: 둘 다 ‘${sourceMeaning.problem}’을 풀고 있습니다.`);
  if (reusePurposeScore > 0) reasons.push(`같은 재사용 목적: 나중에 ‘${sourceMeaning.reusePurpose}’ 때 같이 보면 좋습니다.`);
  if (decisionAxisScore > 0) reasons.push(`같은 판단 축: ‘${sourceMeaning.decisionAxis}’ 판단과 연결됩니다.`);
  if (userFeedbackScore > 0) reasons.push('이전에 도움 된 패턴과 비슷합니다.');

  return {
    note: candidate,
    score: Math.round(total * 10) / 10,
    scoreBreakdown: {
      semanticScore,
      keywordScore,
      intentScore,
      problemScore,
      reusePurposeScore,
      decisionAxisScore,
      recencyContextScore,
      userFeedbackScore,
      total: Math.round(total * 10) / 10,
    },
    reasons,
    meaning: candidateMeaning,
  };
}

function isStrongRelatedCandidate(candidate: RelatedCandidate) {
  const score = candidate.scoreBreakdown;
  const hasMechanicalSimilarity = score.semanticScore >= 0.28 && score.keywordScore > 0;
  const hasMeaningfulFieldMatch = score.semanticScore >= 0.16 && (score.problemScore > 0 || score.intentScore > 0 || score.decisionAxisScore > 0);
  const hasUserSignal = score.userFeedbackScore > 0 && score.semanticScore >= 0.12;
  return candidate.score >= 3.4 && candidate.reasons.length > 0 && (hasMechanicalSimilarity || hasMeaningfulFieldMatch || hasUserSignal);
}

function buildConnectionCorpusContext(notes: Note[]): ConnectionCorpusContext {
  const documentFrequency = new Map<string, number>();
  for (const note of notes) {
    const terms = new Set(extractConnectionTerms(note));
    for (const term of terms) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
  }
  return { documentCount: Math.max(1, notes.length), documentFrequency };
}

function buildConnectionVector(note: Note, context: ConnectionCorpusContext) {
  const vector = new Map<string, number>();
  const terms = extractConnectionTerms(note);
  for (const term of terms) {
    const documentFrequency = context.documentFrequency.get(term) ?? 1;
    const documentRatio = documentFrequency / context.documentCount;
    if (documentRatio > 0.42) continue;
    const idf = Math.log((context.documentCount + 1) / (documentFrequency + 1)) + 1;
    const lengthBoost = term.length >= 5 ? 1.15 : 1;
    vector.set(term, (vector.get(term) ?? 0) + idf * lengthBoost);
  }
  return vector;
}

function extractConnectionTerms(note: Note) {
  const rawText = [note.raw_text, note.ai_title, note.ai_summary].filter(Boolean).join(' ');
  const tagTerms = (note.ai_tags ?? []).map(normalizeConnectionTerm).filter(isMeaningfulConnectionKeyword);
  const textTerms = tokenizeConnectionText(rawText);
  return Array.from(new Set([...tagTerms, ...textTerms]));
}

function tokenizeConnectionText(text: string) {
  const normalized = text
    .toLowerCase()
    .replace(/[^0-9a-zA-Z가-힣]+/g, ' ')
    .split(/\s+/)
    .map(normalizeConnectionTerm)
    .filter(isMeaningfulConnectionKeyword);
  return normalized;
}

function normalizeConnectionTerm(value: string) {
  return value.trim().toLowerCase().replace(/^[은는이가을를의에에서으로로과와도만]+|[은는이가을를의에에서으로로과와도만]+$/g, '');
}

function cosineConnectionSimilarity(a: Map<string, number>, b: Map<string, number>) {
  if (a.size === 0 || b.size === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (const value of a.values()) normA += value * value;
  for (const value of b.values()) normB += value * value;
  for (const [term, value] of a) dot += value * (b.get(term) ?? 0);
  if (normA <= 0 || normB <= 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function sharedConnectionTerms(a: Map<string, number>, b: Map<string, number>) {
  return Array.from(a.keys())
    .filter((term) => b.has(term))
    .sort((left, right) => ((b.get(right) ?? 0) + (a.get(right) ?? 0)) - ((b.get(left) ?? 0) + (a.get(left) ?? 0)));
}

function inferMeaning(note: Note): NoteMeaning {
  const text = noteText(note);
  const keywords = Array.from(new Set([...(note.ai_tags ?? []), ...inferTags(note), ...importantWords(text).slice(0, 8)]))
    .filter(isMeaningfulConnectionKeyword);
  const intent = note.intent ?? inferIntent(text);
  const problem = note.problem ?? inferProblem(text, intent);
  const situation = note.situation ?? inferSituation(text);
  const reusePurpose = note.reusePurpose ?? inferReusePurpose(text);
  const decisionAxis = note.decisionAxis ?? inferDecisionAxis(text, intent, reusePurpose);
  return {
    id: note.id,
    rawText: note.raw_text,
    title: note.ai_title ?? makeDraftTitle(note.raw_text),
    summary: note.ai_summary ?? makeDraftSummary(note.raw_text),
    keywords,
    intent,
    problem,
    situation,
    reusePurpose,
    decisionAxis,
    emotion: note.emotion ?? inferEmotion(text),
    lifeArea: note.lifeArea ?? inferLifeArea(text),
    memoryType: note.memoryType ?? inferMemoryType(text),
    createdAt: note.created_at,
    lastViewedAt: null,
    lastSurfacedAt: null,
    surfacedCount: 0,
    usedCount: 0,
    hiddenCount: 0,
  };
}

function keywordOverlap(a: NoteMeaning, b: NoteMeaning) {
  return b.keywords.filter((keyword) => a.keywords.includes(keyword)).length;
}

const GENERIC_CONNECTION_KEYWORDS = new Set([
  '음성', '메모', '생각', '기록', '원문', '저장', '보관', '정리', '확인', '나중', '관련', '주제', '내용', '사용', '활용', '관심',
]);

function isMeaningfulConnectionKeyword(keyword: string) {
  const clean = keyword.trim().toLowerCase();
  if (clean.length < 2) return false;
  if (GENERIC_CONNECTION_KEYWORDS.has(clean)) return false;
  if (/^\d+$/.test(clean)) return false;
  return true;
}

function sameMeaningfulConnectionValue(a?: string | null, b?: string | null) {
  if (!a || !b || a !== b) return false;
  return isMeaningfulRelatedValue(a);
}

function isMeaningfulRelatedValue(value: string) {
  const clean = value.trim();
  if (!clean || clean.length < 8) return false;
  return ![
    '나중에 다시 참고하려고 남긴 생각',
    '나중에 필요한 것을 미리 준비하려는 생각',
    '비슷한 생각을 다시 판단할 때',
    '생각이 떠올라 임시로 붙잡는 중',
    '지금의 생각과 연결해 다음 판단의 재료로 쓸 수 있습니다.',
  ].some((generic) => clean === generic || clean.includes(generic));
}

function inferIntent(text: string) {
  if (text.includes('준비') || text.includes('미리') || text.includes('언제든')) return '나중에 필요한 것을 미리 준비하려는 생각';
  if (text.includes('기획') || text.includes('mvp') || text.includes('v0.1') || text.includes('핵심') || text.includes('버릴')) return '제품 방향과 범위를 정하려는 생각';
  if (text.includes('마케팅') || text.includes('랜딩') || text.includes('이메일') || text.includes('광고')) return '사용자 반응과 수요를 확인하려는 생각';
  if (text.includes('운동') || text.includes('무릎') || text.includes('러닝') || text.includes('건강')) return '몸 상태를 관리하고 루틴을 조정하려는 생각';
  if (text.includes('화') || text.includes('불안') || text.includes('피로') || text.includes('아쉽')) return '감정 상태를 이해하고 정리하려는 생각';
  if (text.includes('고양이') || text.includes('와이프')) return '가까운 관계와 일상을 챙기려는 생각';
  if (text.includes('만들') || text.includes('아이디어') || text.includes('앱')) return '아이디어를 제품이나 작업으로 발전시키려는 생각';
  return '나중에 다시 참고하려고 남긴 생각';
}

function inferProblem(text: string, intent: string) {
  if (text.includes('기획력') || text.includes('엘시') || text.includes('갈비스') || text.includes('패배')) return '어떻게 기획을 감각이 아니라 반복 가능한 판단 시스템으로 만들 것인가';
  if (text.includes('회수') || text.includes('잊') || text.includes('다시')) return '어떻게 잊힌 생각을 다시 만나게 할 것인가';
  if (text.includes('mvp') || text.includes('v0.1') || text.includes('핵심') || text.includes('버릴')) return '무엇을 v0.1에 남기고 무엇을 버릴 것인가';
  if (text.includes('랜딩') || text.includes('마케팅') || text.includes('이메일') || text.includes('광고')) return '어떻게 초기 수요를 검증하고 알릴 것인가';
  if (text.includes('운동') || text.includes('무릎') || text.includes('러닝')) return '어떻게 무리하지 않고 건강 루틴을 지속할 것인가';
  if (text.includes('고양이')) return '어떻게 일상에서 놓친 돌봄을 다시 챙길 것인가';
  return intent;
}

function inferDecisionAxis(text: string, intent: string, reusePurpose: string) {
  if (text.includes('버릴') || text.includes('핵심') || text.includes('v0.1') || text.includes('mvp')) return 'MVP 범위 판단';
  if (text.includes('기획') || text.includes('문서') || text.includes('기록') || text.includes('엘시') || text.includes('갈비스')) return '기획 성공률 판단';
  if (text.includes('웹') || text.includes('아이폰') || text.includes('출시')) return '접근성과 배포 판단';
  if (text.includes('마케팅') || text.includes('랜딩') || text.includes('광고')) return '수요 검증 판단';
  if (text.includes('운동') || text.includes('무릎')) return '건강 루틴 지속 판단';
  if (text.includes('이미지') || text.includes('캐릭터') || text.includes('분신')) return '제품 애착 판단';
  return reusePurpose || intent;
}

function inferEmotion(text: string) {
  if (text.includes('화') || text.includes('답답')) return '답답함';
  if (text.includes('불안') || text.includes('걱정')) return '불안';
  if (text.includes('아쉽')) return '아쉬움';
  if (text.includes('좋') || text.includes('잘 맞')) return '긍정';
  if (text.includes('힘들')) return '부담';
  return '중립';
}

function inferSituation(text: string) {
  if (text.includes('최근') || text.includes('요즘') || text.includes('현재')) return '최근 상태를 점검하는 중';
  if (text.includes('대화') || text.includes('gpt') || text.includes('갈비스') || text.includes('엘시')) return 'AI와 기획 대화를 하던 중';
  if (text.includes('출시') || text.includes('웹') || text.includes('랜딩')) return '배포와 접근 방법을 고민하는 중';
  if (text.includes('운동') || text.includes('뛰') || text.includes('무릎')) return '운동 루틴을 실행하며 몸 상태를 관찰하는 중';
  if (text.includes('고양이') || text.includes('와이프')) return '집과 일상에서 떠오른 생각';
  if (text.includes('문서') || text.includes('기록')) return '기록 방식과 문서화를 돌아보는 중';
  return '생각이 떠올라 임시로 붙잡는 중';
}

function inferLifeArea(text: string) {
  if (text.includes('운동') || text.includes('건강') || text.includes('무릎') || text.includes('러닝')) return '생활';
  if (text.includes('와이프') || text.includes('고양이') || text.includes('깐지')) return '관계';
  if (text.includes('화') || text.includes('불안') || text.includes('피로') || text.includes('아쉽')) return '감정';
  if (text.includes('앱') || text.includes('프로젝트') || text.includes('기획') || text.includes('출시')) return '프로젝트';
  if (text.includes('아이디어') || text.includes('이미지') || text.includes('캐릭터')) return '아이디어';
  if (text.includes('공부') || text.includes('배우')) return '공부';
  if (text.includes('구매') || text.includes('주문') || text.includes('사야')) return '구매';
  return '아이디어';
}

function inferMemoryType(text: string) {
  if (text.includes('?') || text.includes('무엇') || text.includes('어떨까') || text.includes('있을까')) return '질문';
  if (text.includes('고민') || text.includes('정할') || text.includes('판단') || text.includes('버릴')) return '결정 고민';
  if (text.includes('화') || text.includes('불안') || text.includes('아쉽') || text.includes('깨달았다')) return '회고';
  if (text.includes('운동') || text.includes('무릎') || text.includes('고양이')) return '감정 기록';
  if (text.includes('구매') || text.includes('주문') || text.includes('사냥감')) return '구매 메모';
  if (text.includes('아이디어') || text.includes('앱') || text.includes('기능')) return '아이디어';
  return '회고';
}

function inferReusePurpose(text: string) {
  if (text.includes('v0.1') || text.includes('mvp') || text.includes('핵심') || text.includes('버릴')) return 'MVP 범위를 정할 때';
  if (text.includes('기획') || text.includes('문서') || text.includes('기록')) return '기획 문서를 다듬을 때';
  if (text.includes('랜딩') || text.includes('이메일') || text.includes('마케팅') || text.includes('광고')) return '수요 검증과 홍보 방식을 정할 때';
  if (text.includes('웹') || text.includes('아이폰') || text.includes('출시')) return '실사용 배포 경로를 정할 때';
  if (text.includes('운동') || text.includes('무릎') || text.includes('러닝')) return '건강 루틴을 조정할 때';
  if (text.includes('고양이') || text.includes('와이프')) return '가족과 일상을 챙길 때';
  if (text.includes('이미지') || text.includes('캐릭터') || text.includes('분신')) return '제품 애착 경험을 설계할 때';
  return '비슷한 생각을 다시 판단할 때';
}

function daysSince(value: string) {
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return 0;
  return Math.max(0, Math.floor((Date.now() - time) / (24 * 60 * 60 * 1000)));
}

function filterNotes(notes: Note[], query: string) {
  const clean = query.trim().toLowerCase();
  if (!clean) return notes;
  return notes.filter((note) => noteText(note).includes(clean));
}

function noteText(note: Note) {
  return [note.raw_text, note.ai_title, note.ai_summary, ...(note.ai_tags ?? [])].filter(Boolean).join(' ').toLowerCase();
}

function findRelatedNotes(note: Note, notes: Note[]) {
  return rankRelatedNotes(note, notes)
    .filter((item) => item.score >= 3)
    .slice(0, 3)
    .map((item) => item.note);
}

function sharedWordScore(a: Note, b: Note) {
  const wordsA = importantWords(noteText(a));
  const wordsB = new Set(importantWords(noteText(b)));
  return wordsA.filter((word) => wordsB.has(word)).length;
}

function importantWords(text: string) {
  return text
    .split(/\s+/)
    .map((word) => word.replace(/[^0-9a-zA-Z가-힣]/g, ''))
    .filter((word) => word.length >= 3)
    .slice(0, 24);
}

function makeFollowUpQuestions(note: Note) {
  const tags = inferTags(note);
  if (tags.includes('앱')) {
    return ['이 생각이 사용자에게 가장 먼저 보이면 좋은 순간은 언제일까요?', '이 기능 없이도 MVP가 성립하는지 나눠볼까요?'];
  }
  if (tags.includes('마케팅')) {
    return ['이 메시지를 한 문장 카피로 줄이면 어떻게 될까요?', '어떤 장면이나 예시로 보여주면 바로 이해될까요?'];
  }
  if (tags.includes('게임')) {
    return ['이 아이디어가 플레이 감정에 어떤 변화를 만들까요?', '작게 테스트하려면 어떤 장면 하나면 충분할까요?'];
  }
  return ['이 생각의 핵심을 한 문장으로 줄이면 무엇일까요?', '나중에 이어보기 위해 어떤 맥락을 더 남기면 좋을까요?'];
}

function inferCategory(note: Note) {
  const tags = note.ai_tags?.length ? note.ai_tags : inferTags(note);
  const preferred = ['UX', '기획', '사업', '마케팅', '게임', '개발', '음성', '아이디어'];
  const text = noteText(note);
  if (text.includes('ux') || text.includes('ui') || text.includes('화면')) return 'UX';
  if (text.includes('사업') || text.includes('수익') || text.includes('비즈니스')) return '사업';
  if (text.includes('개발') || text.includes('코드') || text.includes('서버')) return '개발';
  const normalized = tags.map((tag) => (tag === '앱' ? '기획' : tag === '생각' ? '아이디어' : tag));
  return normalized.find((tag) => preferred.includes(tag)) ?? normalized[0] ?? '아이디어';
}

function inferTags(note: Note) {
  return inferTagsFromText(noteText(note), note.source_type);
}

function inferTagsFromText(rawText: string, sourceType: SourceType) {
  const text = rawText.toLowerCase();
  const tags: string[] = [];
  if (sourceType === 'voice') tags.push('음성');
  if (text.includes('앱') || text.includes('ui') || text.includes('ux')) tags.push('앱');
  if (text.includes('마케팅') || text.includes('쇼츠') || text.includes('홍보')) tags.push('마케팅');
  if (text.includes('게임') || text.includes('통나무')) tags.push('게임');
  if (tags.length === 0) tags.push('생각');
  return tags;
}

function makeDraftTitle(text: string) {
  const cleaned = text.trim().replace(/\s+/g, ' ');
  return cleaned.length > 28 ? `${cleaned.slice(0, 28)}...` : cleaned || '새 생각';
}

function makeDraftSummary(text: string) {
  const cleaned = text.trim().replace(/\s+/g, ' ');
  return cleaned.length > 120 ? `${cleaned.slice(0, 120)}...` : cleaned;
}

function groupNotesByDate(notes: Note[]): ArchiveDateGroup[] {
  const groups = new Map<string, ArchiveDateGroup>();

  for (const note of notes) {
    const date = new Date(note.created_at);
    const key = Number.isNaN(date.getTime()) ? note.created_at.slice(0, 10) : date.toISOString().slice(0, 10);
    const current = groups.get(key) ?? { key, title: formatArchiveDateHeader(note.created_at), notes: [] };
    current.notes.push(note);
    groups.set(key, current);
  }

  return Array.from(groups.values());
}


function isSameLocalDay(value: string, date: Date) {
  const target = new Date(value);
  return !Number.isNaN(target.getTime())
    && target.getFullYear() === date.getFullYear()
    && target.getMonth() === date.getMonth()
    && target.getDate() === date.getDate();
}

function isProcessingVoiceNote(note: Note, voiceJob?: VoiceJob) {
  if (voiceJob && ['saving', 'uploading', 'transcribing'].includes(voiceJob.status)) return true;
  return note.raw_text.includes('전사하는 중입니다') || note.raw_text.includes('업로드하는 중입니다');
}

function canUploadVoiceNote(note: Pick<Note, 'id'>) {
  return !note.id.startsWith('local-');
}

function isFailedVoiceNote(note: Note) {
  const title = note.ai_title?.toLowerCase() ?? '';
  const summary = note.ai_summary?.toLowerCase() ?? '';
  const tags = (note.ai_tags ?? []).join(' ').toLowerCase();
  return !!(note.local_audio_url ?? note.audio_url) && (title.includes('전사 실패') || summary.includes('다시 시도') || tags.includes('재시도'));
}

function formatArchiveDateHeader(value: string) {
  try {
    return new Intl.DateTimeFormat('ko-KR', {
      month: 'long',
      day: 'numeric',
      weekday: 'short',
    }).format(new Date(value));
  } catch {
    return value;
  }
}

function formatDate(value: string) {
  try {
    return new Intl.DateTimeFormat('ko-KR', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(value));
  } catch {
    return value;
  }
}

function isLocalAudioUri(value: string) {
  return value.startsWith('file://') || value.startsWith('content://') || value.startsWith('ph://');
}

function getAudioExtension(uri: string) {
  const clean = uri.split('?')[0];
  const extension = clean.split('.').pop()?.toLowerCase();
  return extension && extension.length <= 5 ? extension : 'm4a';
}

function contentTypeForExtension(extension: string) {
  switch (extension) {
    case 'wav':
      return 'audio/wav';
    case 'mp3':
      return 'audio/mpeg';
    case 'caf':
      return 'audio/x-caf';
    case 'm4a':
    default:
      return 'audio/mp4';
  }
}

async function describeFunctionError(error: unknown) {
  if (error && typeof error === 'object' && 'context' in error) {
    const context = (error as { context?: Response }).context;
    if (context) {
      try {
        const text = await context.text();
        if (text) return text;
      } catch {
        // Fall through to the generic error message.
      }
    }
  }

  return describeUnknownError(error);
}

function describeUnknownError(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>;
    const parts = [record.message, record.details, record.hint, record.code]
      .filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
    if (parts.length) return parts.join('\n');
    try {
      const json = JSON.stringify(error);
      if (json && json !== '{}') return json;
    } catch {
      // Fall through to String(error).
    }
  }
  return String(error);
}

function isNetworkRequestFailure(error: unknown) {
  return describeUnknownError(error).toLowerCase().includes('network request failed');
}

function userFacingErrorMessage(error: unknown) {
  const message = describeUnknownError(error);
  if (message.toLowerCase().includes('network request failed')) {
    return '네트워크 연결이 불안정해요. 원본은 기기에 보관하고, 연결이 안정되면 다시 시도할 수 있습니다.';
  }
  return message.split('\n').slice(0, 3).join('\n');
}

function showError(title: string, error: unknown) {
  Alert.alert(title, userFacingErrorMessage(error));
}

const UI_THEME = {
  color: {
    appBg: '#fffdf9',
    surface: '#ffffff',
    surfaceWarm: '#fffaf4',
    surfaceSoft: '#fbf6ef',
    border: '#efe6dc',
    borderStrong: '#ead9ca',
    text: '#171412',
    textSoft: '#5f554a',
    textMuted: '#8f8578',
    coral: '#ef6a5a',
    coralDeep: '#d94c3d',
    coralSoft: '#fff0ec',
    greenSoft: '#edf4e9',
    greenText: '#5f6f56',
    goldSoft: '#f2e7d7',
    goldText: '#7c5c2e',
  },
  radius: {
    sm: 14,
    md: 18,
    lg: 22,
    xl: 28,
    hero: 36,
    pill: 999,
  },
  shadow: {
    card: {
      shadowColor: '#1e1712',
      shadowOffset: { width: 0, height: 8 },
      shadowOpacity: 0.045,
      shadowRadius: 16,
      elevation: 1,
    },
    hero: {
      shadowColor: '#8c4b35',
      shadowOffset: { width: 0, height: 18 },
      shadowOpacity: 0.08,
      shadowRadius: 28,
      elevation: 3,
    },
  },
} as const;

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    width: '100%',
    maxWidth: '100%',
    overflow: 'hidden',
    backgroundColor: UI_THEME.color.appBg,
  },
  container: {
    flex: 1,
    width: Platform.OS === 'web' ? 398 : '100%',
    maxWidth: '100%',
    minWidth: 0,
    alignSelf: 'flex-start',
    paddingHorizontal: 18,
    paddingTop: 8,
    paddingBottom: 10,
    gap: 12,
    overflow: 'hidden',
    backgroundColor: UI_THEME.color.appBg,
  },
  header: {
    gap: 4,
  },
  kicker: {
    color: '#7c5c2e',
    fontSize: 13,
    fontWeight: '700',
  },
  title: {
    color: UI_THEME.color.text,
    fontSize: 25,
    fontWeight: '900',
  },
  status: {
    color: UI_THEME.color.textMuted,
    fontSize: 13,
  },
  tabContent: {
    flex: 1,
    gap: 10,
  },
  tabPagerViewport: {
    flex: 1,
    overflow: 'hidden',
  },
  feedTopBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    paddingHorizontal: 2,
    paddingBottom: 2,
    gap: 10,
  },
  feedTitleWrap: {
    flex: 1,
    minWidth: 0,
  },
  feedTitle: {
    color: '#171412',
    fontSize: 24,
    fontWeight: '900',
  },
  feedHint: {
    color: '#8f8578',
    fontSize: 12,
    marginTop: 2,
  },
  feedActionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    flexShrink: 0,
    gap: 10,
  },
  appTopBar: {
    minHeight: 42,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 2,
  },
  appTopTitle: {
    color: '#141312',
    fontSize: 20,
    fontWeight: '900',
    letterSpacing: -0.3,
  },
  topIconButton: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
  },
  topIconText: {
    color: '#787a7d',
    fontSize: 20,
    fontWeight: '800',
  },
  homeTopBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 34,
  },
  accountEntryButton: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#fff7f2',
    borderWidth: 1,
    borderColor: '#f0ded2',
    shadowColor: '#8c5f41',
    shadowOpacity: 0.08,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
  },
  accountEntryText: {
    color: '#bf4b4b',
    fontSize: 14,
    fontWeight: '900',
  },
  accountSheetShell: {
    flex: 1,
    zIndex: 3,
    elevation: 3,
    marginHorizontal: -16,
    marginTop: -10,
    marginBottom: -12,
    backgroundColor: '#f0eff5',
    borderTopLeftRadius: 32,
    borderTopRightRadius: 32,
    overflow: 'hidden',
  },
  accountCloseButton: {
    position: 'absolute',
    top: 18,
    right: 18,
    zIndex: 5,
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#ffffff',
    shadowColor: '#14110f',
    shadowOpacity: 0.08,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
  },
  accountCloseText: {
    color: '#171412',
    fontSize: 34,
    lineHeight: 38,
    fontWeight: '400',
  },
  accountSheetContent: {
    paddingTop: 86,
    paddingHorizontal: 20,
    paddingBottom: 34,
    gap: 26,
  },
  accountProfileBlock: {
    alignItems: 'center',
    gap: 10,
  },
  accountAvatarLarge: {
    width: 74,
    height: 74,
    borderRadius: 37,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#ff625f',
  },
  accountAvatarText: {
    color: '#fffaf6',
    fontSize: 28,
    fontWeight: '900',
  },
  accountDisplayName: {
    color: '#171412',
    fontSize: 21,
    fontWeight: '800',
    maxWidth: '82%',
  },
  settingsSectionBlock: {
    gap: 10,
  },
  settingsSectionTitle: {
    color: '#8e8a92',
    fontSize: 17,
    fontWeight: '800',
    paddingHorizontal: 22,
  },
  settingsSectionCard: {
    borderRadius: 24,
    backgroundColor: '#ffffff',
    overflow: 'hidden',
  },
  settingsRow: {
    minHeight: 58,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 22,
    gap: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e4e1df',
  },
  settingsIcon: {
    width: 22,
    color: '#171412',
    fontSize: 22,
    fontWeight: '800',
    textAlign: 'center',
  },
  settingsLabel: {
    flex: 1,
    color: '#171412',
    fontSize: 18,
    fontWeight: '700',
  },
  settingsValue: {
    maxWidth: '45%',
    color: '#7f7a80',
    fontSize: 16,
    fontWeight: '600',
  },
  settingsChevron: {
    color: '#c7c3c2',
    fontSize: 30,
    fontWeight: '300',
    marginLeft: -4,
  },
  accountLogoutRow: {
    minHeight: 58,
    borderRadius: 24,
    backgroundColor: '#ffffff',
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 22,
    gap: 14,
  },
  accountLogoutIcon: {
    width: 22,
    color: '#c0443e',
    fontSize: 22,
    fontWeight: '800',
    textAlign: 'center',
  },
  accountLogoutText: {
    color: '#a5413c',
    fontSize: 18,
    fontWeight: '800',
  },
  todayRetrievalCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#edf4ef',
    borderColor: '#cfe4d6',
    borderWidth: 1,
    borderRadius: 22,
    padding: 15,
    gap: 12,
  },
  todayRetrievalTextWrap: {
    flex: 1,
    gap: 4,
  },
  todayRetrievalKicker: {
    color: '#d94c3d',
    fontSize: 12,
    fontWeight: '900',
  },
  todayRetrievalTitle: {
    color: '#171412',
    fontSize: 16,
    fontWeight: '900',
    lineHeight: 21,
  },
  todayRetrievalBody: {
    color: '#5f554a',
    fontSize: 13,
    lineHeight: 18,
  },
  todayRetrievalArrow: {
    color: '#d94c3d',
    fontSize: 24,
    fontWeight: '900',
  },
  todayMainFlowCard: {
    backgroundColor: '#fffefd',
    borderColor: '#eee7df',
    borderWidth: 1,
    borderRadius: 16,
    padding: 20,
    gap: 10,
    minHeight: 156,
    justifyContent: 'center',
  },
  todayMainFlowTitle: {
    color: '#171412',
    fontSize: 23,
    fontWeight: '900',
    lineHeight: 32,
  },
  todayMainFlowMeta: {
    color: '#9a8f82',
    fontSize: 13,
    fontWeight: '800',
  },
  todayGrownEmptyCard: {
    backgroundColor: '#fffefd',
    borderColor: '#eee7df',
    borderWidth: 1,
    borderRadius: 16,
    padding: 18,
    gap: 8,
  },
  todayGrownEmptyTitle: {
    color: '#171412',
    fontSize: 18,
    fontWeight: '900',
    lineHeight: 24,
  },
  todayGrownEmptyBody: {
    color: '#7a746b',
    fontSize: 13,
    lineHeight: 19,
  },
  todayRecorderCard: {
    width: '100%',
    maxWidth: '100%',
    minHeight: 408,
    backgroundColor: UI_THEME.color.surfaceWarm,
    borderColor: UI_THEME.color.borderStrong,
    borderWidth: 1,
    borderRadius: UI_THEME.radius.hero,
    paddingHorizontal: 22,
    paddingTop: 36,
    paddingBottom: 30,
    gap: 24,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'visible',
    ...UI_THEME.shadow.hero,
  },
  todayRecorderCardActive: {
    backgroundColor: '#fff2ec',
    borderColor: '#f1b8ad',
  },
  todayHeroCopy: {
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 6,
  },
  todayPromptPill: {
    color: UI_THEME.color.coralDeep,
    backgroundColor: UI_THEME.color.coralSoft,
    borderRadius: UI_THEME.radius.pill,
    overflow: 'hidden',
    paddingHorizontal: 11,
    paddingVertical: 5,
    fontSize: 12,
    fontWeight: '900',
  },
  todayHeroTitle: {
    color: UI_THEME.color.text,
    fontSize: 29,
    lineHeight: 37,
    fontWeight: '900',
    textAlign: 'center',
    letterSpacing: -0.8,
  },
  todayHeroHint: {
    color: UI_THEME.color.textMuted,
    fontSize: 14,
    lineHeight: 21,
    fontWeight: '700',
    textAlign: 'center',
  },
  todayMicButton: {
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  todayMicButtonActive: {
    transform: [{ scale: 0.98 }],
  },
  todayMicHaloOuter: {
    width: 196,
    height: 196,
    borderRadius: 98,
    backgroundColor: UI_THEME.color.coralSoft,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: UI_THEME.color.coral,
    shadowOffset: { width: 0, height: 16 },
    shadowOpacity: 0.22,
    shadowRadius: 28,
    elevation: 3,
  },
  todayMicHaloOuterActive: {
    backgroundColor: '#ffe5df',
  },
  todayMicHaloInner: {
    width: 132,
    height: 132,
    borderRadius: 66,
    backgroundColor: UI_THEME.color.coral,
    alignItems: 'center',
    justifyContent: 'center',
  },
  todayMicHaloInnerActive: {
    backgroundColor: '#ef4f43',
  },
  todayMicIcon: {
    color: '#fffaf6',
    fontSize: 48,
    fontWeight: '900',
  },
  todayRecorderHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: 10,
  },
  todayRecorderTextWrap: {
    flex: 1,
    minWidth: 0,
  },
  todayRecorderKicker: {
    color: '#e7b76a',
    fontSize: 12,
    fontWeight: '900',
  },
  todayRecorderTitle: {
    color: '#171412',
    fontSize: 22,
    fontWeight: '900',
    lineHeight: 29,
    marginTop: 4,
  },
  todayRecorderTimer: {
    color: '#171412',
    backgroundColor: '#ffe7cf',
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 7,
    fontSize: 18,
    fontWeight: '900',
    overflow: 'hidden',
    flexShrink: 0,
  },
  todayWaveformRow: {
    width: '100%',
    height: 42,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    paddingHorizontal: 18,
  },
  todayWaveformBar: {
    flex: 1,
    borderRadius: 999,
    backgroundColor: '#ef6a5a',
    opacity: 0.42,
  },
  todayRecorderProgressTrack: {
    width: '82%',
    height: 5,
    borderRadius: 999,
    backgroundColor: '#f0e8df',
    overflow: 'hidden',
  },
  todayRecorderProgressFill: {
    height: '100%',
    borderRadius: 999,
    backgroundColor: '#f06458',
  },
  newThoughtReportCta: {
    minHeight: 74,
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingVertical: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: '#fff3ed',
    borderColor: '#ffd9cb',
    borderWidth: 1,
  },
  newThoughtReportIcon: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#ffffff',
  },
  newThoughtReportIconText: {
    fontSize: 20,
  },
  newThoughtReportTextWrap: {
    flex: 1,
    minWidth: 0,
    gap: 3,
  },
  newThoughtReportTitle: {
    color: '#171412',
    fontSize: 16,
    fontWeight: '900',
  },
  newThoughtReportHint: {
    color: '#8a7568',
    fontSize: 12,
    fontWeight: '700',
  },
  newThoughtReportArrow: {
    color: '#e56d4f',
    fontSize: 28,
    fontWeight: '800',
  },
  todayRecorderSubtitle: {
    color: UI_THEME.color.coralDeep,
    fontSize: 15,
    lineHeight: 21,
    fontWeight: '900',
  },
  mutedActionText: {
    color: '#9b9185',
    fontSize: 13,
    fontWeight: '700',
  },
  inlineComposerCard: {
    backgroundColor: '#fff',
    borderColor: '#e8e1d8',
    borderWidth: 1,
    borderRadius: 18,
    padding: 12,
    gap: 10,
  },
  composerActionRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: 8,
  },
  ghostTextButton: {
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  ghostTextButtonText: {
    color: '#8f8578',
    fontSize: 13,
    fontWeight: '800',
  },
  card: {
    backgroundColor: '#fffefd',
    borderColor: '#eee7df',
    borderWidth: 1,
    borderRadius: 16,
    padding: 16,
    gap: 10,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.08,
    shadowRadius: 16,
    elevation: 2,
  },
  captureCard: {
    backgroundColor: '#fffefd',
    borderColor: '#eee7df',
    borderWidth: 1,
    borderRadius: 24,
    padding: 16,
    gap: 14,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.08,
    shadowRadius: 16,
    elevation: 2,
  },
  captureHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 12,
  },
  cardTitle: {
    color: '#171412',
    fontSize: 17,
    fontWeight: '900',
  },
  helpText: {
    color: '#7a746b',
    fontSize: 13,
    lineHeight: 18,
  },
  input: {
    backgroundColor: '#fff',
    borderColor: '#e7d7bf',
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
  },
  buttonRow: {
    flexDirection: 'row',
    gap: 10,
  },
  primaryButton: {
    flex: 1,
    backgroundColor: UI_THEME.color.coral,
    borderRadius: UI_THEME.radius.sm,
    paddingVertical: 13,
    alignItems: 'center',
  },
  savedPrimaryButton: {
    backgroundColor: '#4f6f3f',
  },
  primaryButtonText: {
    color: '#fff',
    fontWeight: '800',
  },
  secondaryButton: {
    flex: 1,
    backgroundColor: UI_THEME.color.goldSoft,
    borderRadius: UI_THEME.radius.sm,
    paddingVertical: 13,
    alignItems: 'center',
  },
  secondaryButtonText: {
    color: '#33291d',
    fontWeight: '800',
  },
  ghostButton: {
    flex: 1,
    borderColor: '#e8e1d8',
    borderWidth: 1,
    borderRadius: 14,
    paddingVertical: 13,
    alignItems: 'center',
    backgroundColor: '#fff',
  },
  ghostButtonText: {
    color: '#8f8578',
    fontWeight: '800',
  },
  disabledButton: {
    opacity: 0.45,
  },
  smallGhostButton: {
    alignSelf: 'flex-start',
    backgroundColor: '#f1e5d5',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  smallGhostButtonText: {
    color: '#7c5c2e',
    fontSize: 12,
    fontWeight: '800',
  },
  voiceHeroButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    backgroundColor: '#eaf4ee',
    borderColor: '#c8dfd0',
    borderWidth: 1,
    borderRadius: 22,
    padding: 16,
  },
  voiceHeroButtonActive: {
    backgroundColor: '#ffe3df',
    borderColor: '#efb7ad',
  },
  voiceHeroIcon: {
    fontSize: 30,
  },
  voiceHeroTextWrap: {
    flex: 1,
  },
  voiceHeroTitle: {
    color: '#171412',
    fontSize: 17,
    fontWeight: '900',
  },
  voiceHeroSubtitle: {
    color: '#6d796f',
    fontSize: 13,
    marginTop: 3,
  },
  quickTextRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 10,
  },
  quickInput: {
    minHeight: 48,
    maxHeight: 128,
    backgroundColor: '#fff',
    borderColor: '#e7d7bf',
    borderWidth: 1,
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    textAlignVertical: 'top',
  },
  sendButton: {
    backgroundColor: '#ef6a5a',
    borderRadius: 16,
    paddingHorizontal: 17,
    paddingVertical: 14,
  },
  sendButtonText: {
    color: '#fff',
    fontWeight: '900',
  },
  listHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  sectionTitle: {
    color: '#171412',
    fontSize: 19,
    fontWeight: '900',
  },
  sectionHint: {
    color: '#8f8578',
    fontSize: 12,
    marginTop: 2,
  },
  linkButtonText: {
    color: '#7c5c2e',
    fontWeight: '800',
  },
  loader: {
    marginTop: 32,
  },
  noteList: {
    gap: 0,
    paddingBottom: 176,
  },
  empty: {
    color: '#7a746b',
    textAlign: 'center',
    marginTop: 30,
  },
  swipeArchiveShell: {
    position: 'relative',
    overflow: 'hidden',
    borderRadius: 18,
  },
  swipeTrashReveal: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'flex-end',
    justifyContent: 'center',
    paddingRight: 24,
    backgroundColor: '#fff0ec',
    opacity: 0.72,
  },
  swipeTrashRevealActive: {
    opacity: 1,
  },
  swipeTrashIcon: {
    fontSize: 24,
  },
  noteCard: {
    backgroundColor: '#ffffff',
    borderColor: '#f0eeeb',
    borderWidth: 1,
    borderRadius: 18,
    paddingVertical: 14,
    paddingHorizontal: 15,
    gap: 8,
    shadowColor: '#1e1712',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.045,
    shadowRadius: 16,
    elevation: 1,
  },
  processingCard: {
    borderColor: '#d6ddeb',
    backgroundColor: '#fbfcff',
  },
  failedCard: {
    borderColor: '#efc4bd',
    backgroundColor: '#fff8f6',
  },
  noteMetaRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  noteMetaLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
  },
  noteType: {
    color: '#7c5c2e',
    fontWeight: '800',
    fontSize: 14,
  },
  singleCategory: {
    color: '#7c5c2e',
    backgroundColor: '#efe4d4',
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 3,
    fontSize: 11,
    fontWeight: '900',
  },
  noteDate: {
    color: '#9b9185',
    fontSize: 12,
  },
  noteTitle: {
    color: '#171412',
    fontSize: 16,
    fontWeight: '900',
    lineHeight: 21,
  },
  copyableTextWrap: {
    alignSelf: 'stretch',
  },
  copyFeedbackText: {
    alignSelf: 'flex-start',
    marginTop: 4,
    color: '#6e4f22',
    backgroundColor: '#f2e7d7',
    borderRadius: 999,
    overflow: 'hidden',
    paddingHorizontal: 8,
    paddingVertical: 3,
    fontSize: 12,
    fontWeight: '800',
  },
  noteBody: {
    color: '#33291d',
    fontSize: 15,
    lineHeight: 21,
  },
  noteSummary: {
    color: '#5f554a',
    fontSize: 14,
    lineHeight: 20,
  },
  compactMetaRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 6,
  },
  compactPill: {
    color: '#7c5c2e',
    backgroundColor: '#efe4d4',
    borderRadius: 999,
    paddingHorizontal: 7,
    paddingVertical: 3,
    fontSize: 11,
    fontWeight: '800',
  },
  compactTag: {
    color: '#8f8578',
    fontSize: 12,
    fontWeight: '700',
  },
  iconMeta: {
    color: '#8f8578',
    fontSize: 13,
    fontWeight: '800',
  },

  rediscoveryPill: {
    alignSelf: 'flex-start',
    backgroundColor: '#edf4ef',
    borderColor: '#d4e6d9',
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 9,
    paddingVertical: 5,
  },
  rediscoveryPillText: {
    color: '#d94c3d',
    fontSize: 12,
    fontWeight: '900',
  },
  rediscoveryBanner: {
    backgroundColor: '#edf4ef',
    borderColor: '#d4e6d9',
    borderWidth: 1,
    borderRadius: 20,
    padding: 14,
    gap: 5,
  },
  rediscoveryBannerKicker: {
    color: '#d94c3d',
    fontSize: 12,
    fontWeight: '900',
  },
  rediscoveryBannerTitle: {
    color: '#171412',
    fontSize: 16,
    fontWeight: '900',
  },
  rediscoveryBannerHint: {
    color: '#6b8b73',
    fontSize: 12,
    fontWeight: '800',
  },
  rediscoveryBannerBody: {
    color: '#5f554a',
    fontSize: 13,
    lineHeight: 18,
  },
  voiceStatusBox: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    backgroundColor: '#fffefd',
    borderColor: '#eee7df',
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  voiceDetailStatus: {
    gap: 8,
    backgroundColor: '#fffefd',
    borderColor: '#eee7df',
    borderWidth: 1,
    borderRadius: 16,
    padding: 12,
  },
  noteAudioBlock: {
    backgroundColor: UI_THEME.color.coral,
    borderRadius: UI_THEME.radius.lg,
    padding: 16,
    gap: 13,
    shadowColor: UI_THEME.color.coralDeep,
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.12,
    shadowRadius: 18,
  },
  noteAudioTopRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: 10,
  },
  noteAudioTextWrap: {
    flex: 1,
    gap: 3,
  },
  noteAudioKicker: {
    color: '#e7b76a',
    fontSize: 12,
    fontWeight: '900',
  },
  noteAudioTitle: {
    color: '#171412',
    fontSize: 15,
    fontWeight: '900',
    lineHeight: 21,
  },
  noteAudioBadge: {
    color: '#171412',
    backgroundColor: '#e7b76a',
    borderRadius: 999,
    paddingHorizontal: 9,
    paddingVertical: 5,
    fontSize: 11,
    fontWeight: '900',
    overflow: 'hidden',
  },
  noteWaveformRow: {
    height: 38,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 5,
  },
  noteWaveformBar: {
    flex: 1,
    borderRadius: 999,
    backgroundColor: '#f28b7d',
    opacity: 0.9,
  },
  noteWaveformBarActive: {
    backgroundColor: '#e7b76a',
    opacity: 1,
  },
  noteAudioTime: {
    color: '#fff0d5',
    fontSize: 12,
    fontWeight: '800',
  },
  noteAudioControlRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  audioControlButton: {
    backgroundColor: '#e7b76a',
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  audioControlButtonText: {
    color: '#171412',
    fontSize: 12,
    fontWeight: '900',
  },
  audioControlButtonSecondary: {
    borderColor: '#e7b76a',
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  audioControlButtonSecondaryText: {
    color: '#fff0d5',
    fontSize: 12,
    fontWeight: '900',
  },
  voiceStatusText: {
    flex: 1,
    color: '#7c5c2e',
    fontSize: 12,
    fontWeight: '900',
  },
  voiceErrorText: {
    color: '#9b5047',
    fontSize: 12,
    lineHeight: 17,
  },
  retryButton: {
    alignSelf: 'flex-start',
    backgroundColor: '#ef6a5a',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  retryButtonText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '900',
  },
  noteHint: {
    color: '#b08a50',
    fontSize: 12,
    fontWeight: '800',
  },
  routingBadge: {
    alignSelf: 'flex-start',
    backgroundColor: '#f2e7d7',
    borderRadius: 999,
    paddingHorizontal: 9,
    paddingVertical: 5,
  },
  routingBadgeCompact: {
    marginTop: 2,
  },
  routingBadgeText: {
    color: '#7c5c2e',
    fontSize: 12,
    fontWeight: '900',
  },
  navigationStack: {
    flex: 1,
    position: 'relative',
    overflow: 'hidden',
    backgroundColor: '#fbfaf7',
  },
  previousScreenLayer: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 0,
    elevation: 0,
    backgroundColor: '#fbfaf7',
  },
  previousScreenContent: {
    flex: 1,
  },
  detailShell: {
    flex: 1,
    zIndex: 2,
    elevation: 2,
    backgroundColor: '#fbfaf7',
  },
  detailFixedTopBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: '#fffdfb',
    paddingBottom: 8,
    zIndex: 10,
    elevation: 5,
  },
  detailContent: {
    gap: 12,
    paddingTop: 2,
    paddingBottom: 220,
  },
  backButton: {
    alignSelf: 'flex-start',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 8,
    minWidth: 74,
    minHeight: 42,
    justifyContent: 'center',
    backgroundColor: '#fffdfb',
  },
  backButtonInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  backChevron: {
    color: '#171412',
    fontSize: 28,
    lineHeight: 28,
    fontWeight: '700',
  },
  backButtonText: {
    color: '#171412',
    fontSize: 16,
    fontWeight: '800',
  },
  detailTopBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  detailActionRow: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
  },
  iconActionButton: {
    minWidth: 38,
    minHeight: 38,
    borderRadius: 999,
    backgroundColor: '#f5f4f2',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 10,
  },
  iconActionText: {
    color: '#171412',
    fontSize: 18,
    fontWeight: '900',
  },
  detailHero: {
    backgroundColor: UI_THEME.color.appBg,
    paddingTop: 8,
    paddingBottom: 12,
    gap: 12,
  },
  detailTypeBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: '#fff',
    borderColor: '#e8e1d8',
    borderWidth: 1,
    borderRadius: 18,
    padding: 12,
  },
  mergedTypeBanner: {
    backgroundColor: '#fff7ea',
    borderColor: '#f0d7cf',
  },
  detailTypeIcon: {
    fontSize: 22,
  },
  detailTypeTextWrap: {
    flex: 1,
    gap: 2,
  },
  detailTypeLabel: {
    color: '#171412',
    fontSize: 15,
    fontWeight: '900',
  },
  detailTypeHint: {
    color: '#7a746b',
    fontSize: 12,
    lineHeight: 17,
  },
  noteRewriteButton: {
    alignSelf: 'flex-start',
    backgroundColor: '#eef2ff',
    borderColor: '#d9e1ff',
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 13,
    paddingVertical: 9,
  },
  noteHeroActionRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  noteRewriteButtonText: {
    color: '#344080',
    fontSize: 13,
    fontWeight: '900',
  },
  noteExportButton: {
    alignSelf: 'flex-start',
    backgroundColor: '#fffefd',
    borderColor: '#e6d5ba',
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 13,
    paddingVertical: 9,
  },
  noteExportButtonText: {
    color: '#6e4f22',
    fontSize: 13,
    fontWeight: '900',
  },
  detailTitle: {
    color: '#171412',
    fontSize: 24,
    fontWeight: '900',
    lineHeight: 30,
  },
  detailSummary: {
    color: '#5f554a',
    fontSize: 16,
    lineHeight: 23,
  },
  originalSummaryCard: {
    backgroundColor: UI_THEME.color.surface,
    borderColor: UI_THEME.color.border,
    borderWidth: 1,
    borderRadius: UI_THEME.radius.lg,
    padding: 16,
    gap: 8,
    ...UI_THEME.shadow.card,
  },
  originalSummaryLabel: {
    color: '#8f8578',
    fontSize: 12,
    fontWeight: '900',
  },
  detailBody: {
    color: '#3b342e',
    fontSize: 15,
    lineHeight: 23,
  },
  flowDetailStatus: {
    color: '#7c5c2e',
    fontSize: 12,
    fontWeight: '900',
    backgroundColor: '#efe4d4',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  flowDetailHero: {
    backgroundColor: '#fbfaf7',
    borderBottomColor: '#e8e1d8',
    borderBottomWidth: 1,
    paddingTop: 8,
    paddingBottom: 18,
    gap: 10,
  },
  flowInsightCard: {
    backgroundColor: '#fff7ea',
    borderColor: '#f0d7cf',
    borderWidth: 1,
    borderRadius: 22,
    padding: 17,
    gap: 10,
  },
  flowSynthesisText: {
    color: '#171412',
    fontSize: 17,
    fontWeight: '800',
    lineHeight: 26,
  },
  mergedDraftCard: {
    backgroundColor: '#fffefd',
    borderColor: '#f0d7cf',
    borderWidth: 1,
    borderRadius: 24,
    padding: 18,
    gap: 14,
  },
  flowMergedHero: {
    backgroundColor: UI_THEME.color.surface,
    borderColor: UI_THEME.color.border,
    borderWidth: 1,
    borderRadius: UI_THEME.radius.xl,
    padding: 22,
    gap: 17,
    ...UI_THEME.shadow.card,
  },
  flowMergedKicker: {
    color: '#9a6b2f',
    fontSize: 12,
    fontWeight: '900',
    letterSpacing: 0.4,
  },
  mergedDraftLabel: {
    color: '#9a6b2f',
    fontSize: 12,
    fontWeight: '900',
    letterSpacing: 0.4,
  },
  mergedDraftTitle: {
    color: '#171412',
    fontSize: 20,
    fontWeight: '900',
    lineHeight: 27,
  },
  mergedDraftBody: {
    color: '#2f2924',
    fontSize: 16,
    lineHeight: 26,
  },
  flowDocumentBody: {
    gap: 20,
  },
  flowDocumentSection: {
    gap: 9,
  },
  flowDocumentHeading: {
    color: UI_THEME.color.text,
    fontSize: 15,
    fontWeight: '900',
  },
  flowDocumentBullet: {
    color: '#3f3934',
    fontSize: 14,
    lineHeight: 21,
    fontWeight: '700',
  },
  judgmentBox: {
    backgroundColor: '#fbfaf7',
    borderRadius: 18,
    padding: 14,
    gap: 8,
  },
  draftLoadingBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: '#fbfaf7',
    borderRadius: 16,
    padding: 12,
  },
  analysisToggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  collapsedSourcePill: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#fbfaf7',
    borderColor: '#eee7df',
    borderWidth: 1,
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 12,
  },
  analysisBox: {
    gap: 8,
    paddingTop: 2,
  },
  compactActionRow: {
    flexDirection: 'row',
    gap: 10,
  },
  savedDraftHint: {
    color: '#5f7549',
    fontSize: 12,
    fontWeight: '700',
    marginTop: -4,
  },
  exportButton: {
    backgroundColor: '#fffefd',
    borderColor: '#e6d5ba',
    borderWidth: 1,
    borderRadius: 14,
    paddingVertical: 13,
    alignItems: 'center',
  },
  exportButtonText: {
    color: '#6e4f22',
    fontWeight: '900',
  },
  flowSectionHint: {
    color: '#8f8578',
    fontSize: 13,
    lineHeight: 19,
  },
  flowSourceNoteCard: {
    flexDirection: 'row',
    gap: 10,
    backgroundColor: '#fffefd',
    borderColor: '#eee7df',
    borderWidth: 1,
    borderRadius: 16,
    padding: 12,
  },
  flowSourceNoteIndex: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: '#ef6a5a',
    color: '#171412',
    fontSize: 12,
    fontWeight: '900',
    lineHeight: 24,
    textAlign: 'center',
  },
  flowSourceNoteBody: {
    flex: 1,
    gap: 4,
  },
  flowBottomActionWrap: {
    gap: 10,
    paddingTop: 4,
  },
  threadSection: {
    backgroundColor: UI_THEME.color.surface,
    borderColor: UI_THEME.color.border,
    borderWidth: 1,
    borderRadius: UI_THEME.radius.lg,
    padding: 16,
    gap: 8,
    ...UI_THEME.shadow.card,
  },
  threadHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 38,
  },
  threadHeaderIcon: {
    color: '#8f8578',
    fontSize: 17,
    fontWeight: '900',
  },
  threadLogRow: {
    flexDirection: 'row',
    gap: 10,
  },
  threadRail: {
    width: 18,
    alignItems: 'center',
  },
  threadDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#c9bca9',
    marginTop: 6,
  },
  threadLine: {
    flex: 1,
    width: 2,
    backgroundColor: '#ded4c6',
    marginTop: 5,
  },
  threadLogBody: {
    flex: 1,
    paddingBottom: 12,
  },
  threadLogMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 5,
  },
  threadMoreButton: {
    alignSelf: 'flex-start',
    marginLeft: 28,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 5,
    backgroundColor: '#efe4d4',
  },
  threadMoreText: {
    color: '#7c5c2e',
    fontSize: 12,
    fontWeight: '900',
  },
  threadEditRow: {
    alignItems: 'flex-end',
    marginTop: -2,
  },
  detailSection: {
    backgroundColor: UI_THEME.color.surface,
    borderColor: UI_THEME.color.border,
    borderWidth: 1,
    borderRadius: UI_THEME.radius.lg,
    padding: 16,
    gap: 10,
    ...UI_THEME.shadow.card,
  },
  detailSectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 10,
  },
  editToggleButton: {
    backgroundColor: '#eef2ff',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  editToggleText: {
    color: '#4f63c6',
    fontSize: 12,
    fontWeight: '900',
  },
  editBox: {
    gap: 10,
  },
  editInput: {
    minHeight: 140,
    maxHeight: 230,
    backgroundColor: '#fffefd',
    borderColor: '#eee7df',
    borderWidth: 1,
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: '#33291d',
    fontSize: 15,
    lineHeight: 22,
    textAlignVertical: 'top',
  },
  detailSectionTitle: {
    color: '#171412',
    fontSize: 16,
    fontWeight: '900',
  },
  originalText: {
    color: '#33291d',
    fontSize: 16,
    lineHeight: 24,
  },
  questionItem: {
    color: '#5f554a',
    fontSize: 14,
    lineHeight: 21,
  },
  relatedItem: {
    backgroundColor: '#fffefd',
    borderRadius: 14,
    padding: 12,
    gap: 4,
  },
  relatedMetaRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 8,
  },
  relatedMeta: {
    color: '#8f8578',
    fontSize: 11,
    fontWeight: '800',
  },
  relatedTitle: {
    color: '#171412',
    fontSize: 14,
    fontWeight: '900',
  },
  relatedBody: {
    color: '#7a746b',
    fontSize: 13,
    lineHeight: 18,
  },
  debugSection: {
    backgroundColor: '#ef6a5a',
    borderRadius: 18,
    padding: 14,
    gap: 10,
  },
  debugTitle: {
    color: '#171412',
    fontSize: 15,
    fontWeight: '900',
  },
  debugSubTitle: {
    color: '#9a8f82',
    fontSize: 13,
    fontWeight: '900',
    marginTop: 4,
  },
  debugRow: {
    gap: 3,
  },
  debugLabel: {
    color: '#b9a890',
    fontSize: 11,
    fontWeight: '900',
  },
  debugValue: {
    color: '#171412',
    fontSize: 12,
    lineHeight: 17,
  },
  debugCandidateBox: {
    backgroundColor: '#2a2520',
    borderRadius: 12,
    padding: 10,
    gap: 5,
  },
  debugCandidateTitle: {
    color: '#171412',
    fontSize: 12,
    fontWeight: '900',
  },
  debugCandidateReason: {
    color: '#9a8f82',
    fontSize: 11,
    lineHeight: 16,
  },
  logItem: {
    backgroundColor: '#fffefd',
    borderColor: '#eee7df',
    borderWidth: 1,
    borderRadius: 16,
    padding: 12,
    gap: 6,
  },
  logMeta: {
    color: '#b08a50',
    fontSize: 12,
    fontWeight: '900',
  },
  logBody: {
    color: '#33291d',
    fontSize: 14,
    lineHeight: 21,
  },
  logReason: {
    color: '#7a746b',
    fontSize: 12,
    lineHeight: 17,
  },
  detachButton: {
    alignSelf: 'flex-start',
    backgroundColor: '#fff0ed',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
    marginTop: 2,
  },
  detachButtonText: {
    color: '#b34332',
    fontSize: 12,
    fontWeight: '900',
  },
  emptyInline: {
    color: '#8f8578',
    fontSize: 13,
  },
  tagRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 2,
  },
  tagChip: {
    color: '#d94c3d',
    backgroundColor: '#eaf4ee',
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 4,
    fontSize: 12,
    fontWeight: '700',
  },
  audioPill: {
    color: '#7c5c2e',
    backgroundColor: '#f2e7d7',
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 4,
    fontSize: 12,
    fontWeight: '700',
  },
  floatingCaptureWrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 72,
    alignItems: 'center',
    zIndex: 30,
    elevation: 30,
  },
  floatingMicButton: {
    width: 76,
    height: 76,
    borderRadius: 38,
    backgroundColor: '#ef6a5a',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.18,
    shadowRadius: 18,
    elevation: 8,
  },
  floatingMicButtonActive: {
    backgroundColor: '#d94c3d',
  },
  floatingMicIcon: {
    color: '#fff',
    fontSize: 31,
    fontWeight: '900',
  },
  captureHint: {
    marginTop: 8,
    color: '#5f554a',
    backgroundColor: '#fff',
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
    fontSize: 12,
    fontWeight: '900',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 5 },
    shadowOpacity: 0.08,
    shadowRadius: 10,
    elevation: 3,
  },
  captureHintActive: {
    color: '#d94c3d',
  },
  bottomTabs: {
    flexDirection: 'row',
    gap: 8,
    backgroundColor: UI_THEME.color.surface,
    borderColor: UI_THEME.color.border,
    borderWidth: 1,
    borderRadius: UI_THEME.radius.md,
    padding: 8,
    shadowColor: '#1e1712',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.08,
    shadowRadius: 16,
    elevation: 4,
  },
  tabButton: {
    flex: 1,
    alignItems: 'center',
    borderRadius: 14,
    paddingVertical: 9,
  },
  tabButtonActive: {
    backgroundColor: UI_THEME.color.coralSoft,
  },
  tabIcon: {
    color: '#8f8578',
    fontSize: 16,
    fontWeight: '900',
  },
  tabLabel: {
    color: '#8f8578',
    fontSize: 12,
    fontWeight: '900',
    marginTop: 2,
  },
  tabTextActive: {
    color: UI_THEME.color.coralDeep,
  },
  scrollContent: {
    width: '100%',
    maxWidth: '100%',
    gap: 14,
    paddingBottom: 106,
  },
  todayScrollContent: {
    width: '100%',
    maxWidth: '100%',
    gap: 18,
    paddingBottom: 112,
  },
  todayThoughtSection: {
    gap: 10,
    marginTop: 2,
  },
  todayThoughtHeader: {
    paddingHorizontal: 2,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  todayMiniCard: {
    backgroundColor: UI_THEME.color.surface,
    borderColor: UI_THEME.color.border,
    borderWidth: 1,
    borderRadius: UI_THEME.radius.md,
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 7,
    ...UI_THEME.shadow.card,
  },
  todayMiniCardProcessing: {
    backgroundColor: '#fff8f4',
    borderColor: '#f5d4c9',
  },
  todayMiniTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  todayMiniStatus: {
    color: '#5f6f56',
    backgroundColor: '#edf4e9',
    borderRadius: 999,
    overflow: 'hidden',
    paddingHorizontal: 8,
    paddingVertical: 3,
    fontSize: 11,
    fontWeight: '900',
  },
  todayMiniStatusProcessing: {
    color: '#bd5c4f',
    backgroundColor: '#ffe9df',
  },
  todayMiniTime: {
    color: '#aaa197',
    fontSize: 12,
    fontWeight: '700',
  },
  todayMiniTitle: {
    color: '#171412',
    fontSize: 15,
    fontWeight: '900',
  },
  todayMiniPreview: {
    color: '#776e64',
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '600',
  },
  todayEmptyCard: {
    borderRadius: UI_THEME.radius.md,
    borderWidth: 1,
    borderColor: UI_THEME.color.border,
    backgroundColor: UI_THEME.color.surface,
    padding: 16,
    gap: 5,
  },
  todayEmptyTitle: {
    color: '#171412',
    fontSize: 15,
    fontWeight: '900',
  },
  todayEmptyBody: {
    color: '#8f8578',
    fontSize: 13,
    lineHeight: 18,
  },
  pageIntro: {
    gap: 3,
  },

  pageIntroRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: 12,
  },
  trashButton: {
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#eee7df',
    backgroundColor: '#fffefd',
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  trashButtonText: {
    color: '#8f5f4b',
    fontSize: 12,
    fontWeight: '800',
  },

  trashNoteCard: {
    backgroundColor: '#fffefd',
    borderColor: '#eee7df',
    borderWidth: 1,
    borderRadius: 18,
    padding: 14,
    gap: 10,
  },
  dangerButton: {
    backgroundColor: '#fff0ed',
    borderColor: '#f0b7ad',
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  dangerButtonText: {
    color: '#c0392b',
    fontWeight: '900',
  },
  collectionCard: {
    backgroundColor: '#fff',
    borderColor: '#eee7df',
    borderWidth: 1,
    borderRadius: 20,
    padding: 16,
    gap: 7,
  },
  collectionTopRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  collectionTitle: {
    color: '#171412',
    fontSize: 17,
    fontWeight: '900',
  },
  collectionCount: {
    color: '#d94c3d',
    fontSize: 13,
    fontWeight: '900',
  },
  collectionDescription: {
    color: '#7a746b',
    fontSize: 13,
  },
  collectionPreview: {
    color: '#8f8578',
    fontSize: 13,
    lineHeight: 19,
  },
  searchCard: {
    backgroundColor: '#fffefd',
    borderColor: '#eee7df',
    borderWidth: 1,
    borderRadius: 22,
    padding: 16,
    gap: 11,
  },
  searchInput: {
    backgroundColor: '#f5f4f2',
    borderColor: '#f5f4f2',
    borderWidth: 1,
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    color: '#22201e',
  },
  suggestionWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  suggestionChip: {
    backgroundColor: '#eef2ff',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  suggestionText: {
    color: '#4f63c6',
    fontSize: 12,
    fontWeight: '800',
  },
  retrievalScrollContent: {
    width: '100%',
    maxWidth: '100%',
    gap: 14,
    paddingBottom: 176,
  },
  flowMapIntro: {
    paddingHorizontal: 2,
    marginTop: -4,
  },
  flowMapIntroText: {
    color: UI_THEME.color.textMuted,
    fontSize: 12,
    fontWeight: '800',
  },
  searchCardCompact: {
    backgroundColor: UI_THEME.color.surface,
    borderColor: UI_THEME.color.border,
    borderWidth: 1,
    borderRadius: UI_THEME.radius.lg,
    paddingHorizontal: 4,
    paddingVertical: 4,
    ...UI_THEME.shadow.card,
  },
  archiveAccountEntry: {
    marginTop: 4,
    marginBottom: 10,
    backgroundColor: UI_THEME.color.surface,
    borderColor: UI_THEME.color.border,
    borderWidth: 1,
    borderRadius: UI_THEME.radius.md,
    paddingHorizontal: 16,
    paddingVertical: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  archiveAccountTitle: {
    color: UI_THEME.color.text,
    fontSize: 15,
    fontWeight: '900',
  },
  archiveAccountHint: {
    color: UI_THEME.color.textMuted,
    fontSize: 12,
    fontWeight: '700',
    marginTop: 3,
  },
  archiveAccountArrow: {
    color: UI_THEME.color.textMuted,
    fontSize: 24,
    fontWeight: '700',
  },
  retrievalHeroTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  retrievalHeroTextWrap: {
    flex: 1,
    gap: 4,
  },
  seedButton: {
    backgroundColor: '#ef6a5a',
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  seedButtonText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '900',
  },
  todayInlineStatus: {
    color: '#8f8578',
    fontSize: 13,
    fontWeight: '800',
    textAlign: 'center',
    marginTop: -2,
    marginBottom: 6,
  },
  retrievalSection: {
    gap: 9,
  },
  retrievalSectionHeader: {
    paddingHorizontal: 2,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: 12,
  },
  archiveDateGroup: {
    gap: 10,
  },
  archiveDateHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 2,
  },
  archiveDateTitle: {
    color: UI_THEME.color.text,
    fontSize: 17,
    fontWeight: '900',
  },
  archiveDateCount: {
    color: '#8f8578',
    fontSize: 12,
    fontWeight: '800',
  },
  archiveOriginalCard: {
    backgroundColor: UI_THEME.color.surface,
    borderColor: UI_THEME.color.border,
    borderWidth: 1,
    borderRadius: UI_THEME.radius.lg,
    paddingHorizontal: 15,
    paddingVertical: 13,
    gap: 8,
    ...UI_THEME.shadow.card,
  },
  archiveOriginalMetaRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 10,
  },
  archiveOriginalSource: {
    color: UI_THEME.color.goldText,
    backgroundColor: UI_THEME.color.goldSoft,
    borderRadius: UI_THEME.radius.pill,
    overflow: 'hidden',
    paddingHorizontal: 8,
    paddingVertical: 3,
    fontSize: 11,
    fontWeight: '900',
  },
  archiveOriginalDate: {
    color: '#aaa197',
    fontSize: 12,
    fontWeight: '700',
  },
  archiveOriginalTitle: {
    color: '#171412',
    fontSize: 15,
    fontWeight: '900',
  },
  archiveOriginalPreview: {
    color: '#776e64',
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '600',
  },
  thoughtReportCard: {
    backgroundColor: UI_THEME.color.surface,
    borderColor: UI_THEME.color.border,
    borderWidth: 1,
    borderRadius: UI_THEME.radius.xl,
    padding: 20,
    gap: 15,
    ...UI_THEME.shadow.card,
  },
  thoughtReportCardPending: {
    backgroundColor: UI_THEME.color.surfaceWarm,
    borderColor: UI_THEME.color.borderStrong,
  },
  thoughtReportHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  thoughtReportSeed: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#eff8f2',
    borderWidth: 1,
    borderColor: '#d5ebdc',
  },
  thoughtReportSeedText: {
    fontSize: 22,
  },
  thoughtReportHeaderText: {
    flex: 1,
    gap: 7,
    minWidth: 0,
  },
  thoughtReportKicker: {
    color: '#e06458',
    fontSize: 11,
    fontWeight: '900',
  },
  flowStatusRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  flowStatusPill: {
    alignSelf: 'flex-start',
    borderRadius: 999,
    overflow: 'hidden',
    paddingHorizontal: 10,
    paddingVertical: 5,
    fontSize: 11,
    fontWeight: '900',
  },
  flowStatusPillReady: {
    color: UI_THEME.color.greenText,
    backgroundColor: UI_THEME.color.greenSoft,
  },
  flowStatusPillPending: {
    color: UI_THEME.color.coralDeep,
    backgroundColor: UI_THEME.color.coralSoft,
  },
  thoughtReportTitle: {
    color: UI_THEME.color.text,
    fontSize: 19,
    fontWeight: '900',
    lineHeight: 25,
  },
  thoughtReportSummary: {
    color: '#332f2b',
    fontSize: 15,
    lineHeight: 24,
    fontWeight: '600',
  },
  thoughtReportTimeline: {
    gap: 8,
    borderRadius: 20,
    backgroundColor: '#fbfaf7',
    padding: 12,
  },
  reportStageRow: {
    flexDirection: 'row',
    gap: 10,
    alignItems: 'flex-start',
  },
  reportStageLabel: {
    width: 36,
    color: '#e06458',
    fontSize: 12,
    fontWeight: '900',
  },
  reportStageBody: {
    flex: 1,
    color: '#4f4a44',
    fontSize: 13,
    lineHeight: 19,
    fontWeight: '700',
  },
  sixWPanel: {
    borderRadius: 22,
    backgroundColor: '#fbfaf7',
    padding: 12,
    gap: 10,
  },
  sixWPanelCompact: {
    padding: 10,
    borderRadius: 20,
  },
  sixWTabRow: {
    gap: 7,
    paddingRight: 4,
  },
  sixWTab: {
    borderRadius: 999,
    backgroundColor: '#f0eeeb',
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  sixWTabActive: {
    backgroundColor: '#26231f',
  },
  sixWTabText: {
    color: '#827a72',
    fontSize: 12,
    fontWeight: '900',
  },
  sixWTabTextActive: {
    color: '#fffaf4',
  },
  sixWAnswerCard: {
    borderRadius: 18,
    backgroundColor: '#ffffff',
    borderWidth: 1,
    borderColor: '#eee9e3',
    paddingHorizontal: 14,
    paddingVertical: 13,
    gap: 5,
  },
  sixWAnswerCardCompact: {
    paddingHorizontal: 12,
    paddingVertical: 11,
  },
  sixWAnswerLabel: {
    color: '#e06458',
    fontSize: 11,
    fontWeight: '900',
  },
  sixWAnswerValue: {
    color: '#26231f',
    fontSize: 15,
    lineHeight: 22,
    fontWeight: '800',
  },
  sixWAnswerValueCompact: {
    fontSize: 13,
    lineHeight: 19,
  },
  nextQuestionCard: {
    borderRadius: UI_THEME.radius.md,
    backgroundColor: UI_THEME.color.coralSoft,
    borderColor: '#ffd8cf',
    borderWidth: 1,
    padding: 14,
    gap: 5,
  },
  nextQuestionLabel: {
    color: '#e06458',
    fontSize: 11,
    fontWeight: '900',
  },
  nextQuestionBody: {
    color: '#342b26',
    fontSize: 14,
    lineHeight: 20,
    fontWeight: '800',
  },
  flowPendingBox: {
    borderRadius: UI_THEME.radius.lg,
    backgroundColor: UI_THEME.color.surfaceSoft,
    borderColor: UI_THEME.color.border,
    borderWidth: 1,
    padding: 15,
    gap: 10,
  },
  flowPendingTitle: {
    color: '#171412',
    fontSize: 15,
    fontWeight: '900',
  },
  flowPrimaryButton: {
    width: '100%',
    backgroundColor: '#ef6a5a',
    borderRadius: 14,
    paddingVertical: 13,
    alignItems: 'center',
  },
  reportEvidenceRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  reportEvidenceText: {
    color: '#8a8580',
    fontSize: 12,
    fontWeight: '800',
  },
  reportOpenText: {
    color: '#e06458',
    fontSize: 13,
    fontWeight: '900',
  },
  readableReportBox: {
    gap: 12,
  },
  thoughtFlowCard: {
    backgroundColor: '#fffefd',
    borderColor: '#eee7df',
    borderWidth: 1,
    borderRadius: 16,
    padding: 16,
    gap: 10,
  },
  flowCardTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  flowNumberPill: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: '#fff0ec',
    alignItems: 'center',
    justifyContent: 'center',
  },
  flowNumberText: {
    color: '#d94c3d',
    fontSize: 12,
    fontWeight: '900',
  },
  flowBadgeRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 7,
  },
  flowBadge: {
    color: '#d94c3d',
    backgroundColor: '#fff0ec',
    borderRadius: 999,
    paddingHorizontal: 9,
    paddingVertical: 5,
    fontSize: 11,
    fontWeight: '900',
    overflow: 'hidden',
  },
  flowBadgeStrong: {
    color: '#171412',
    backgroundColor: '#b7e0c7',
    borderRadius: 999,
    paddingHorizontal: 9,
    paddingVertical: 5,
    fontSize: 11,
    fontWeight: '900',
    overflow: 'hidden',
  },
  thoughtFlowKicker: {
    color: '#d94c3d',
    fontSize: 12,
    fontWeight: '900',
  },
  thoughtFlowTitle: {
    color: '#171412',
    fontSize: 18,
    fontWeight: '900',
    lineHeight: 24,
  },
  thoughtFlowOneLine: {
    color: '#8f8578',
    fontSize: 13,
    lineHeight: 18,
  },
  flowDraftBox: {
    backgroundColor: '#fffefd',
    borderColor: '#eee7df',
    borderWidth: 1,
    borderRadius: 16,
    padding: 12,
    gap: 4,
  },
  flowDraftLabel: {
    color: '#7c5c2e',
    fontSize: 11,
    fontWeight: '900',
  },
  flowDraftText: {
    color: '#2e241c',
    fontSize: 14,
    fontWeight: '900',
    lineHeight: 20,
  },
  flowQuestionBox: {
    backgroundColor: '#edf4ef',
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  flowQuestionText: {
    color: '#d94c3d',
    fontSize: 12,
    fontWeight: '900',
    lineHeight: 18,
  },
  thoughtFlowLabel: {
    color: '#9a8f82',
    fontSize: 11,
    fontWeight: '900',
    marginTop: 4,
  },
  thoughtFlowBody: {
    color: '#171412',
    fontSize: 13,
    lineHeight: 19,
  },
  thoughtFlowQuestion: {
    color: '#d94c3d',
    fontSize: 13,
    fontWeight: '800',
    lineHeight: 19,
  },
  flowTimeline: {
    gap: 0,
    marginTop: 2,
  },
  flowTimelineItem: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 9,
    minHeight: 28,
  },
  flowTimelineRail: {
    width: 12,
    alignItems: 'center',
  },
  flowTimelineDot: {
    width: 7,
    height: 7,
    borderRadius: 999,
    backgroundColor: '#fffefd',
    marginTop: 5,
  },
  flowTimelineLine: {
    width: 1,
    flex: 1,
    backgroundColor: '#fff0ec',
    marginTop: 3,
  },
  flowTimelineText: {
    flex: 1,
    color: '#3b3028',
    fontSize: 13,
    lineHeight: 20,
    fontWeight: '800',
  },
  flowCardArrow: {
    position: 'absolute',
    right: 16,
    bottom: 14,
    color: '#d94c3d',
    fontSize: 24,
    fontWeight: '900',
  },
  flowExpandedBox: {
    borderTopColor: '#4a4035',
    borderTopWidth: 1,
    paddingTop: 10,
    gap: 6,
  },
  flowOpenButton: {
    alignSelf: 'flex-start',
    backgroundColor: '#eaf4ee',
    borderColor: '#c8dfd0',
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 13,
    paddingVertical: 8,
  },
  flowOpenButtonText: {
    color: '#d94c3d',
    fontSize: 13,
    fontWeight: '900',
  },
  flowNoteWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 7,
    marginTop: 3,
  },
  flowNoteChip: {
    backgroundColor: '#2a2520',
    borderColor: '#4a4035',
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 9,
    paddingVertical: 6,
    maxWidth: '100%',
  },
  flowNoteChipText: {
    color: '#171412',
    fontSize: 11,
    fontWeight: '800',
  },
  retrievalCard: {
    backgroundColor: '#fffefd',
    borderColor: '#eee7df',
    borderWidth: 1,
    borderRadius: 20,
    overflow: 'hidden',
  },
  retrievalCardPressArea: {
    padding: 14,
    gap: 8,
  },
  retrievalBadgeRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    flex: 1,
    gap: 6,
  },
  connectionBadge: {
    color: '#d94c3d',
    backgroundColor: '#edf4ef',
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 4,
    fontSize: 11,
    fontWeight: '900',
    overflow: 'hidden',
  },
  retrievalOneLine: {
    color: '#5f554a',
    fontSize: 14,
    lineHeight: 20,
    fontWeight: '700',
  },
  strengthRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  strengthText: {
    color: '#d94c3d',
    fontSize: 12,
    fontWeight: '900',
  },
  strengthDots: {
    color: '#d94c3d',
    fontSize: 12,
    letterSpacing: 1,
    fontWeight: '900',
  },
  retrievalReasonPill: {
    color: '#d94c3d',
    backgroundColor: '#edf4ef',
    borderRadius: 999,
    paddingHorizontal: 9,
    paddingVertical: 4,
    fontSize: 12,
    fontWeight: '900',
    overflow: 'hidden',
  },
  retrievalReasonBox: {
    backgroundColor: '#fbfaf7',
    borderColor: '#e8e1d8',
    borderWidth: 1,
    borderRadius: 14,
    padding: 11,
    gap: 4,
  },
  retrievalReasonLabel: {
    color: '#7c5c2e',
    fontSize: 11,
    fontWeight: '900',
    marginTop: 2,
  },
  retrievalReasonBody: {
    color: '#4f463d',
    fontSize: 12,
    lineHeight: 17,
  },
  connectionReason: {
    color: '#7c5c2e',
    backgroundColor: '#f5ead8',
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 12,
    fontWeight: '800',
    lineHeight: 17,
  },
  expandReasonButton: {
    alignSelf: 'flex-start',
    backgroundColor: '#2a2520',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  expandReasonText: {
    color: '#d94c3d',
    fontSize: 12,
    fontWeight: '900',
  },
  expandReasonButtonLight: {
    alignSelf: 'flex-start',
    marginHorizontal: 14,
    marginBottom: 10,
    backgroundColor: '#efe4d4',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  expandReasonTextLight: {
    color: '#7c5c2e',
    fontSize: 12,
    fontWeight: '900',
  },
  feedbackState: {
    color: '#4f63c6',
    fontSize: 12,
    fontWeight: '900',
  },
  feedbackButtonRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 7,
    borderTopColor: '#eadbc3',
    borderTopWidth: 1,
    padding: 10,
    backgroundColor: '#fff7ec',
  },
  feedbackButton: {
    backgroundColor: '#edf4ef',
    borderRadius: 999,
    paddingHorizontal: 9,
    paddingVertical: 7,
  },
  feedbackButtonText: {
    color: '#d94c3d',
    fontSize: 11,
    fontWeight: '900',
  },
  feedbackButtonMuted: {
    backgroundColor: '#efe4d4',
    borderRadius: 999,
    paddingHorizontal: 9,
    paddingVertical: 7,
  },
  feedbackButtonMutedText: {
    color: '#7a746b',
    fontSize: 11,
    fontWeight: '900',
  },
  retrievalEmptyInline: {
    color: '#8f8578',
    backgroundColor: '#fffefd',
    borderColor: '#eee7df',
    borderWidth: 1,
    borderRadius: 16,
    padding: 14,
    textAlign: 'center',
    fontSize: 13,
  },
});

