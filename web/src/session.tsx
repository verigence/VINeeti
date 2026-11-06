import { createContext, useContext } from "react";
import type { AlertRow, Me, Outlet, Permission } from "./types";

export interface Session {
  me: Me;
  /** Whether the person may do this. Decides which actions a screen offers. */
  can: (p: Permission) => boolean;
  /**
   * Whether the person may open a screen that needs this. The same as `can`, except for a read-only
   * role (the Reader), who may open every screen bar emptying the dealership, and acts on none of them.
   */
  canSee: (p: Permission) => boolean;
  /** A role that sees everything and changes nothing but its own password. */
  readOnly: boolean;
  /** Re-reads the signed-in user, settings and outlets (after a password change, settings change, ...). */
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
  /** Name of any outlet of the dealership, by id. */
  outletName: (id: string | null | undefined) => string;
  /** Outlets the user can work in that are still active. */
  myOutlets: Outlet[];
  /** Whether the user may change records that belong to this outlet. */
  worksAt: (outletId: string) => boolean;
  roleLabel: (role: string) => string;
}

export const SessionContext = createContext<Session | null>(null);

export function useSession(): Session {
  const s = useContext(SessionContext);
  if (!s) throw new Error("Not signed in");
  return s;
}

export interface AlertsState {
  alerts: AlertRow[];
  unread: number;
  /** Unread alarms, for the people who receive them. */
  unreadAlarms: number;
  loading: boolean;
  error: string | null;
  /** Bookings and special requests waiting for a decision this user may take. */
  pendingApprovals: number;
  /** Re-reads the alerts and the approvals count; called after every action so the badges stay true. */
  reload: () => Promise<void>;
}
export const AlertsContext = createContext<AlertsState>({ alerts: [], unread: 0, unreadAlarms: 0, loading: false, error: null, pendingApprovals: 0, reload: async () => undefined });
export const useAlerts = () => useContext(AlertsContext);
