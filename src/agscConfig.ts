export interface AGSCConfigOptions {
  require_tag?: boolean;
  overwrite_tags?: Record<"codex" | "claude" | "default", string>;
  assignee_tags?: Record<string, "codex" | "claude" | "default">;
  restrict_user_to_local_only?: boolean;
}
