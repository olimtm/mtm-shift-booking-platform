export type Role = 'staff' | 'client';
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
}
export interface Participant {
  id: string;
  name: string;
  initials: string;
  color: string;
  supportType: SupportType;
  notes: string;
  airtableId?: string;
}
export interface StaffMember {
  id: string;
  name: string;
  initials: string;
  color: string;
  airtableId?: string;
}
export interface ShiftInput {
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
