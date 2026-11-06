// Shapes shared by the browser modules. They mirror the JSON the server sends.

import type {
  StreamFieldDefinition,
  StreamFilter,
  StreamSort
} from "../../providers/stream-middleware.js";

export interface PublicUser {
  id: string;
  installPath: string;
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
  nameFormat: string;
  descriptionFormat: string;
}

/** Everything the server knows about a signed-in user. */
export interface Workspace {
  sources: SavedSource[];
  /** Raw server settings; run through `toMiddlewareSettings` before use. */
  middleware: unknown;
  fields: StreamFieldDefinition[];
  profiles: SavedProfile[];
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
}

export interface FormatterPreviewResponse {
  name: string;
  description: string;
  parsed: Record<string, unknown>;
}

export interface ProfileBackup {
  format: "aioplugins-profile";
  version: 1;
  sources: SavedSource[];
  middleware?: unknown;
}

export type AppView = "configure" | "middleware" | "save" | "account" | "about" | "support";
export type MiddlewareTab = "filters" | "sorting" | "formatting";
export type StatusKind = "" | "success" | "error";
