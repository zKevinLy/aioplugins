// Shapes shared by the browser modules. They mirror the JSON the server sends.

import type {
  DetailField,
  StreamFieldDefinition,
  StreamFilter,
  StreamProbeSettings,
  StreamRankingSettings,
  StreamSort
} from "../../providers/stream-middleware.js";

export interface PublicUser {
  id: string;
  installPath: string;
  /** May manage the curated plugin list. */
  isAdmin: boolean;
}

export interface CuratedStatus {
  /** The account follows the curated default. */
  following: boolean;
  /** An admin has published a selection; following does nothing before that. */
  available: boolean;
  updatedAt: number | null;
}

export interface ProviderSummary {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  types: string[];
}

export interface DiscoveredSource {
  repository: string;
  ref: string;
  commit: string;
  providers: ProviderSummary[];
}

/** A discovered source plus the provider IDs the user ticked. */
export interface LoadedSource extends DiscoveredSource {
  selected: Set<string>;
}

export interface SavedSource {
  repository: string;
  ref: string;
  providerIds: string[];
  commit?: string;
}

export interface SavedProfile {
  id: string;
  name: string;
  sources: SavedSource[];
}

/** Stream middleware settings as the editor works with them. */
export interface MiddlewareSettings {
  filters: StreamFilter[];
  sorts: StreamSort[];
  probe: StreamProbeSettings;
  ranking: StreamRankingSettings;
  nameFormat: string;
  descriptionFormat: string;
  detailField: DetailField;
}

/** Everything the server knows about a signed-in user. */
export interface Workspace {
  sources: SavedSource[];
  /** Raw server settings; run through `toMiddlewareSettings` before use. */
  middleware: unknown;
  fields: StreamFieldDefinition[];
  profiles: SavedProfile[];
  curated: CuratedStatus;
}

export interface AdminCuratedResponse {
  sources: SavedSource[];
  middleware: unknown;
  updatedAt: number | null;
  followers: { following: number; total: number };
}

export interface PublishCuratedResponse {
  plugins: number;
  deduped: number;
  followers: { following: number; total: number };
}

export interface SessionResponse {
  user: PublicUser | null;
  workspace?: Workspace;
}

export interface UserResponse {
  user: PublicUser;
  workspace: Workspace;
}

export interface ConfigResponse {
  sources: SavedSource[];
  middleware: unknown;
  fields: StreamFieldDefinition[];
}

export interface ProfilesResponse {
  profiles: SavedProfile[];
}

export interface ApplyResponse {
  plugins: number;
  /** Plugin IDs selected from several sources, reduced to the newest copy. */
  deduped: number;
}

export interface ProfileBackup {
  format: "aioplugins-profile";
  version: 1;
  sources: SavedSource[];
  middleware?: unknown;
}

export type AppView = "configure" | "middleware" | "save" | "account" | "admin" | "about" | "support";
export type MiddlewareTab = "filters" | "sorting" | "formatting";
/** The admin screen reuses the middleware tabs next to its own plugin list. */
export type AdminTab = "plugins" | MiddlewareTab | "publish";
export type StatusKind = "" | "success" | "error";
