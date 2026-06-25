import type { AGSCConfigOptions } from "./src/agscConfig.ts";

export interface AGSCWorkspaceConfig extends AGSCConfigOptions {}

const config: AGSCWorkspaceConfig = {
  require_tag: true,
  overwrite_tags: {
    codex: "agse-codex",
    claude: "agse-claude",
    default: "agse",
  },
  restrict_user_to_local_only: true,
};

export default config;
