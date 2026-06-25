import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  findRootFoldersWithFile,
  ROOT_MARKER_FILE_NAME,
  type FolderPathInput,
} from "./utils/findRootFoldersWithFile.ts";
import type { AGSCConfigOptions } from "./agscConfig.ts";
import { GitWorkflows, type GitWorkflowOptions } from "./gitWorkflows/index.ts";
import {
  CodexWorkflows,
  type CodexWorkflowOptions,
} from "./codexIntegration/index.ts";
import {
  ClaudeCodeWorkflows,
  type ClaudeCodeWorkflowOptions,
} from "./claudeCodeIntegration/index.ts";

export type AGSCProjectOptions = {
  git?: GitWorkflowOptions;
  codex?: CodexWorkflowOptions;
  claude?: ClaudeCodeWorkflowOptions;
};

type AGSCConfigModule = {
  default?: unknown;
  config?: unknown;
  agscConfig?: unknown;
};

export class AGSCProject {
  readonly rootPath: string;
  readonly config: Readonly<AGSCConfigOptions>;
  readonly git: GitWorkflows;
  readonly codex: CodexWorkflows;
  readonly claude: ClaudeCodeWorkflows;

  constructor(
    rootPath: string,
    config: Readonly<AGSCConfigOptions>,
    git: GitWorkflows,
    codex: CodexWorkflows,
    claude: ClaudeCodeWorkflows,
  ) {
    this.rootPath = resolve(rootPath);
    this.config = config;
    this.git = git;
    this.codex = codex;
    this.claude = claude;
  }

  static async fromRootPath(
    rootPath: string,
    options: AGSCProjectOptions = {},
  ): Promise<AGSCProject> {
    const resolvedRootPath = resolve(rootPath);
    const config = await loadAGSCConfigFromProjectRoot(resolvedRootPath);
    const git = new GitWorkflows(resolvedRootPath, options.git);
    const codex = new CodexWorkflows(resolvedRootPath, options.codex);
    const claude = new ClaudeCodeWorkflows(resolvedRootPath, options.claude);

    return new AGSCProject(resolvedRootPath, config, git, codex, claude);
  }

  get name(): string {
    return basename(this.rootPath);
  }
}

export type AGSCWorkspaceOptions = AGSCProjectOptions;

export class AGSCWorkspace {
  readonly projects: readonly AGSCProject[];

  constructor(projects: readonly AGSCProject[]) {
    this.projects = [...projects];
  }

  static async discover(
    folderPaths: FolderPathInput,
    options: AGSCWorkspaceOptions = {},
  ): Promise<AGSCWorkspace> {
    const projectRootPaths = await findRootFoldersWithFile(folderPaths);
    const projects = await Promise.all(
      projectRootPaths.map((projectRootPath) =>
        AGSCProject.fromRootPath(projectRootPath, options),
      ),
    );

    return new AGSCWorkspace(projects);
  }

  get size(): number {
    return this.projects.length;
  }

  get rootPaths(): readonly string[] {
    return this.projects.map((project) => project.rootPath);
  }

  get configs(): readonly Readonly<AGSCConfigOptions>[] {
    return this.projects.map((project) => project.config);
  }

  get gitWorkflows(): readonly GitWorkflows[] {
    return this.projects.map((project) => project.git);
  }

  get codexIntegrations(): readonly CodexWorkflows[] {
    return this.projects.map((project) => project.codex);
  }

  get claudeIntegrations(): readonly ClaudeCodeWorkflows[] {
    return this.projects.map((project) => project.claude);
  }

  findByRootPath(rootPath: string): AGSCProject | undefined {
    const resolvedRootPath = resolve(rootPath);

    return this.projects.find(
      (project) => project.rootPath === resolvedRootPath,
    );
  }
}

async function loadAGSCConfigFromProjectRoot(
  projectRootPath: string,
): Promise<Readonly<AGSCConfigOptions>> {
  const configPath = join(projectRootPath, ROOT_MARKER_FILE_NAME);
  const configUrl = pathToFileURL(configPath).href;
  const configModule = (await import(configUrl)) as AGSCConfigModule;
  const config = getExportedAGSCConfig(configModule);

  return normalizeAGSCConfig(config);
}

function getExportedAGSCConfig(configModule: AGSCConfigModule): unknown {
  if ("default" in configModule) {
    return configModule.default;
  }

  if ("config" in configModule) {
    return configModule.config;
  }

  if ("agscConfig" in configModule) {
    return configModule.agscConfig;
  }

  return {};
}

function normalizeAGSCConfig(config: unknown): Readonly<AGSCConfigOptions> {
  if (!isRecord(config)) {
    throw new Error("Expected AGSC config to export an object.");
  }

  return Object.freeze({
    require_tag: optionalBoolean(config.require_tag, "require_tag"),
    overwrite_tags: optionalOverwriteTags(config.overwrite_tags),
    restrict_user_to_local_only: optionalBoolean(
      config.restrict_user_to_local_only,
      "restrict_user_to_local_only",
    ),
  });
}

function optionalBoolean(
  value: unknown,
  fieldName: string,
): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "boolean") {
    throw new Error(`AGSC config field "${fieldName}" must be a boolean.`);
  }

  return value;
}

function optionalOverwriteTags(
  value: unknown,
): AGSCConfigOptions["overwrite_tags"] {
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    throw new Error('AGSC config field "overwrite_tags" must be an object.');
  }

  return {
    codex: requiredString(value.codex, "overwrite_tags.codex"),
    claude: requiredString(value.claude, "overwrite_tags.claude"),
    default: requiredString(value.default, "overwrite_tags.default"),
  };
}

function requiredString(value: unknown, fieldName: string): string {
  if (typeof value !== "string") {
    throw new Error(`AGSC config field "${fieldName}" must be a string.`);
  }

  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
