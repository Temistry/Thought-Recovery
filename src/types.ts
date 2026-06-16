export type SourceType = 'text' | 'voice';
export type RoutingStatus = 'pending_review' | 'routing' | 'routed' | 'route_failed';
export type SyncStatus = 'local_only' | 'cloud_only' | 'synced' | 'stale_local' | 'dirty' | 'conflict' | 'loading_detail';

export type ParagraphIntent = {
  text: string;
  lifeDomain: string;
  topic: string;
  intent: string;
  outputPurpose: string;
  userRole: string;
  evidenceType: string;
  confidence: number;
};

export type MergedThoughtDraft = {
  id: string;
  flowId: string;
  title: string;
  body: string;
  judgmentSummary: string[];
  sourceNoteIds: string[];
  createdAt: string;
  status: 'draft' | 'saved';
};

export type ThoughtFlowStatus = 'temporary' | 'saved' | 'expanded';

export type ThoughtFlow = {
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

export type Note = {
  id: string;
  user_id?: string;
  raw_text: string;
  ai_title?: string | null;
  ai_summary?: string | null;
  ai_tags?: string[] | null;
  intent?: string | null;
  problem?: string | null;
  situation?: string | null;
  reusePurpose?: string | null;
  decisionAxis?: string | null;
  emotion?: string | null;
  lifeArea?: string | null;
  memoryType?: string | null;
  lifeDomain?: string | null;
  topic?: string | null;
  outputPurpose?: string | null;
  userRole?: string | null;
  evidenceType?: string | null;
  paragraphIntents?: ParagraphIntent[] | null;
  source_type: SourceType;
  audio_url?: string | null;
  local_audio_url?: string | null;
  audio_duration_ms?: number | null;
  parent_note_id?: string | null;
  ai_thread_reason?: string | null;
  ai_thread_confidence?: number | null;
  routing_status?: RoutingStatus | null;
  is_pinned?: boolean | null;
  content_hash?: string | null;
  remote_updated_at?: string | null;
  sync_status?: SyncStatus | null;
  has_local_detail?: boolean | null;
  detail_cached_at?: string | null;
  dirty?: boolean | null;
  deleted_at?: string | null;
  created_at: string;
  updated_at?: string;
};

export type CloudNoteManifest = Pick<
  Note,
  'id' | 'user_id' | 'ai_title' | 'ai_summary' | 'source_type' | 'audio_url' | 'local_audio_url' | 'audio_duration_ms' | 'parent_note_id' | 'ai_thread_reason' | 'ai_thread_confidence' | 'routing_status' | 'is_pinned' | 'created_at' | 'updated_at'
>;

export type LocalSyncMetadata = {
  lastManifestSyncAt?: string | null;
  lastKnownRemoteCount?: number | null;
  tabSyncCheckedAt?: Partial<Record<'today' | 'organized' | 'archive', string>>;
};
