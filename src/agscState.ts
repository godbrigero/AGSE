import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
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
  codexPlanningTurnId?: string;
  codexImplementationTurnId?: string;
  codexActiveTurnId?: string;
  codexLastPlan?: string;
  codexImplementationStartedAt?: string;
  codexImplementationCompletedAt?: string;
  codexImplementationCommentedAt?: string;
  claudeSessionId?: string;
  agentHandoffStartedAt?: string;
  agentHandoffVersion?: number;
  agentHandoffPhase?: "planning" | "implementing" | "idle";
  lastPullUpdatedAt?: string;
  lastSyncedPrEventAt?: string;
  syncedPrEventIds?: string[];
  issueClosedByAGSCAt?: string;
};

export type AGSCClosedWorkflow = {
  issueId: number;
  issueNumber: number;
  issueTitle?: string;
  issueUrl?: string;
  pullNumber?: number;
  pullUrl?: string;
  branchName: string;
  worktreePath: string;
  reason: string;
  closedAt: string;
};

export type AGSCState = {
  workflows: AGSCTrackedWorkflow[];
  closedWorkflows: AGSCClosedWorkflow[];
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
        closedWorkflows: Array.isArray(state.closedWorkflows)
          ? state.closedWorkflows.filter(isClosedWorkflow)
          : [],
      };
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return { workflows: [], closedWorkflows: [] };
      }

      throw error;
    }
  }

  async update(
    updater: (state: AGSCState) => AGSCState | Promise<AGSCState>,
  ): Promise<AGSCState> {
    const nextState = await updater(await this.read());

    await mkdir(dirname(this.statePath), { recursive: true });
    const tempPath = `${this.statePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(
      tempPath,
      `${JSON.stringify(nextState, null, 2)}\n`,
      "utf8",
    );
    await rename(tempPath, this.statePath);

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
        closedWorkflows: state.closedWorkflows.filter(
          (entry) => entry.issueId !== workflow.issueId,
        ),
      };
    });

    return workflow;
  }

  async removeWorkflow(issueId: number): Promise<void> {
    await this.update((state) => ({
      workflows: state.workflows.filter((entry) => entry.issueId !== issueId),
      closedWorkflows: state.closedWorkflows,
    }));
  }

  async closeWorkflow(
    workflow: AGSCTrackedWorkflow,
    reason: string,
  ): Promise<void> {
    await this.update((state) => ({
      workflows: state.workflows.filter(
        (entry) => entry.issueId !== workflow.issueId,
      ),
      closedWorkflows: [
        ...state.closedWorkflows.filter(
          (entry) => entry.issueId !== workflow.issueId,
        ),
        {
          issueId: workflow.issueId,
          issueNumber: workflow.issueNumber,
          issueTitle: workflow.issueTitle,
          issueUrl: workflow.issueUrl,
          pullNumber: workflow.pullNumber,
          pullUrl: workflow.pullUrl,
          branchName: workflow.branchName,
          worktreePath: workflow.worktreePath,
          reason,
          closedAt: new Date().toISOString(),
        },
      ],
    }));
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function isClosedWorkflow(value: unknown): value is AGSCClosedWorkflow {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const entry = value as Partial<AGSCClosedWorkflow>;

  return (
    typeof entry.issueId === "number" &&
    typeof entry.issueNumber === "number" &&
    typeof entry.branchName === "string" &&
    typeof entry.worktreePath === "string" &&
    typeof entry.reason === "string" &&
    typeof entry.closedAt === "string"
  );
}
