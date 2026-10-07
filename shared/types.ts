export type Role = 'staff' | 'client' | 'worker';
export type SupportType = 'general' | 'events' | 'both' | 'none';
export type ShiftStatus = 'requested' | 'confirmed' | 'declined' | 'cancelled';
export type DrivingPreference = 'required' | 'not_required' | 'no_preference';
export type GenderPreference = 'female' | 'male' | 'no_preference';
export type SyncStatus = 'not_configured' | 'pending' | 'synced' | 'failed';
export interface User {
  id: string;
  name: string;
  email: string;
  role: Role;
  participantIds: string[];
  workerId?: string;
}
export interface Participant {
  active?: boolean;
  id: string;
  name: string;
  initials: string;
  color: string;
  supportType: SupportType;
  notes: string;
  airtableId?: string;
}
export interface StaffMember {
  active?: boolean;
  airtableManaged?: boolean;
  id: string;
  name: string;
  initials: string;
  color: string;
  airtableId?: string;
}
export interface ShiftInput {
  eventId?: string | null;
  participantId: string;
  start: string;
  end: string;
  description: string;
  location: string;
  driving: DrivingPreference;
  gender: GenderPreference;
  notes: string;
  kind: 'general' | 'event';
}
export interface ShiftChange {
  type: 'edit' | 'cancel';
  values?: ShiftInput;
  reason?: string;
  requestedAt: string;
}
export interface Shift extends ShiftInput {
  id: string;
  status: ShiftStatus;
  staffId: string | null;
  staffDisplayName?: string;
  source: 'client' | 'staff' | 'event';
  eventId: string | null;
  pendingChange: ShiftChange | null;
  syncStatus: SyncStatus;
  createdAt: string;
  updatedAt: string;
}
export interface SupportEvent {
  id: string;
  title: string;
  start: string;
  end: string;
  location: string;
  description: string;
  rsvpCount: number;
  supportCount: number;
}
export interface Rsvp {
  id: string;
  eventId: string;
  participantId: string;
  status: 'attending' | 'cancelled';
  shiftId: string | null;
}
export interface IntegrationStatus {
  configured: boolean;
  pending: number;
  failed: number;
  synced: number;
  lastSync: string | null;
  message: string;
}
export interface DashboardData {
  connecteam?: ConnecteamSetupStatus;
  workerHistory?: {
    counts: Record<string, Record<string, number>>;
    checkedAt: string | null;
    error: string | null;
    automatic: boolean;
    omitted: number;
  };
  shiftUpdates?: ShiftUpdate[];
  workerSync?: { checkedAt: string | null; error: string | null; automatic: boolean };
  participantActivity?: { checkedAt: string | null; error: string | null };
  user: User;
  participants: Participant[];
  staff: StaffMember[];
  shifts: Shift[];
  events: SupportEvent[];
  rsvps: Rsvp[];
  integration: IntegrationStatus;
  timezone: string;
  demoMode: boolean;
}

export interface GoalProgress {
  goal: string;
  progress: 'practised' | 'progress' | 'maintained' | 'needs_support';
  evidence: string;
}

export interface ConnecteamSetupStatus {
  configured: boolean;
  publishingEnabled: false;
  error: string | null;
  report: {
    checkedAt: string;
    scheduler: { schedulerId: number; name: string; isArchived: boolean; timezone?: string };
    mappedWorkers: number;
    mappedParticipants: number;
    existingShiftLinks: number;
    issues: string[];
  } | null;
}
export interface SharedShiftUpdate {
  activities: string;
  howItWent: string;
  feedbackProvided: boolean;
  participantFeedback: string;
  goals: GoalProgress[];
  noGoalWork: boolean;
  noGoalReason: string;
  nextTime: string;
}
export interface InternalShiftUpdate {
  notes: string;
  followUpRequired: boolean;
  followUpNotes: string;
  incidentReference: string;
}
export interface ShiftUpdate extends SharedShiftUpdate {
  canEdit?: boolean;
  shiftId: string;
  version: number;
  authorName: string;
  editedByName: string;
  publishedAt: string;
  updatedAt: string;
  internal?: InternalShiftUpdate;
}
