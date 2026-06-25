import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type AGSCAgentName = "codex" | "claude";

export type AGSCTrackedWorkflow = {
  issueId: number;
  issueNumber: number;
  issueTitle: string;
  issueUrl: string;
  agent: AGSCAgentName;
  worktreePath: string;
  branchName: string;
  pullNumber?: number;
  pullUrl?: string;
  pullState?: "open" | "closed";
  codexThreadId?: string;
  claudeSessionId?: string;
  agentHandoffStartedAt?: string;
  agentHandoffVersion?: number;
  lastPullUpdatedAt?: string;
  lastSyncedPrEventAt?: string;
};

export type AGSCState = {
  workflows: AGSCTrackedWorkflow[];
};

const STATE_FILE_PATH = ".agse/state.json";

export class AGSCStateStore {
  readonly projectRootPath: string;
  readonly statePath: string;

  constructor(projectRootPath: string) {
    this.projectRootPath = projectRootPath;
    this.statePath = join(projectRootPath, STATE_FILE_PATH);
  }

  async read(): Promise<AGSCState> {
    try {
      const raw = await readFile(this.statePath, "utf8");
      const state = JSON.parse(raw) as AGSCState;

      return {
        workflows: Array.isArray(state.workflows) ? state.workflows : [],
      };
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return { workflows: [] };
      }

      throw error;
    }
  }

  async update(
    updater: (state: AGSCState) => AGSCState | Promise<AGSCState>,
  ): Promise<AGSCState> {
    const nextState = await updater(await this.read());

    await mkdir(dirname(this.statePath), { recursive: true });
    await writeFile(
      this.statePath,
      `${JSON.stringify(nextState, null, 2)}\n`,
      "utf8",
    );

    return nextState;
  }

  async upsertWorkflow(
    workflow: AGSCTrackedWorkflow,
  ): Promise<AGSCTrackedWorkflow> {
    await this.update((state) => {
      const workflows = state.workflows.filter(
        (entry) => entry.issueId !== workflow.issueId,
      );

      return {
        workflows: [...workflows, workflow],
      };
    });

    return workflow;
  }

  async removeWorkflow(issueId: number): Promise<void> {
    await this.update((state) => ({
      workflows: state.workflows.filter((entry) => entry.issueId !== issueId),
    }));
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
