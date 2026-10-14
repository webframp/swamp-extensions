/**
 * Render the Twitch + Jev moderation analysis as a readable report.
 *
 * The report intentionally describes observable moderation signals only. It
 * does not claim to infer personality, protected traits, or off-platform
 * identity.
 *
 * @module
 */
// SPDX-License-Identifier: Apache-2.0

interface DataHandle {
  name: string;
  dataId: string;
  version: number;
}

interface StepExecution {
  methodName: string;
  modelType: string;
  modelId: string;
  dataHandles: DataHandle[];
}

interface WorkflowReportContext {
  workflowName: string;
  workflowStatus: string;
  stepExecutions: StepExecution[];
  repoDir: string;
  logger: {
    info: (msg: string, props: Record<string, unknown>) => void;
  };
}

interface Evaluation {
  state?: Record<string, unknown>;
  answers?: Record<string, Record<string, unknown>>;
  evaluatedAt?: string;
}

interface ModerationContext {
  channel?: string;
  user?: {
    login?: string;
    displayName?: string;
    accountAgeDays?: number;
    broadcasterType?: string;
  };
  isCurrentChatter?: boolean | null;
  ban?: {
    reason?: string;
    expiresAt?: string | null;
  } | null;
  availability?: {
    banStatus?: boolean;
  };
}

/** Workflow-scope report for one Twitch user's Jev moderation analysis. */
export const report = {
  name: "@webframp/twitch-character-analysis-report",
  description:
    "Renders observable Twitch moderation facts and typed Jev rankings for one user",
  scope: "workflow" as const,
  labels: ["twitch", "moderation", "jev", "analysis"],

  execute: async (context: WorkflowReportContext) => {
    async function getData(
      modelType: string,
      modelId: string,
      dataName: string,
      version: number,
    ): Promise<Record<string, unknown> | null> {
      const parts = [modelType, modelId, dataName];
      if (
        parts.some((part) =>
          part.includes("..") || part.startsWith("/") || part.includes("\0")
        )
      ) {
        return null;
      }
      try {
        const path =
          `${context.repoDir}/.swamp/data/${modelType}/${modelId}/${dataName}/${version}/raw`;
        return JSON.parse(await Deno.readTextFile(path)) as Record<
          string,
          unknown
        >;
      } catch {
        return null;
      }
    }

    const jevStep = context.stepExecutions.find((step) =>
      step.methodName === "ask" &&
      step.dataHandles.some((handle) => handle.name.startsWith("evaluation-"))
    );
    const contextStep = context.stepExecutions.find((step) =>
      step.methodName === "get_user_context"
    );

    const evaluationLocation = jevStep?.dataHandles.find((handle) =>
      handle.name.startsWith("evaluation-")
    );
    const contextLocation = contextStep?.dataHandles.find((handle) =>
      handle.name.startsWith("user-moderation-context-")
    );

    const evaluation = evaluationLocation && jevStep
      ? await getData(
        jevStep.modelType,
        jevStep.modelId,
        evaluationLocation.name,
        evaluationLocation.version,
      ) as Evaluation | null
      : null;
    const moderationContext = contextLocation && contextStep
      ? await getData(
        contextStep.modelType,
        contextStep.modelId,
        contextLocation.name,
        contextLocation.version,
      ) as ModerationContext | null
      : null;

    const answers = evaluation?.answers ?? {};
    const answer = (name: string): Record<string, unknown> =>
      answers[name] ?? {};
    const score = (name: string): string => {
      const value = answer(name).score;
      return typeof value === "number" ? value.toFixed(2) : "unavailable";
    };
    const confidence = (name: string): string => {
      const value = answer(name).confidence;
      return typeof value === "number" ? value.toFixed(2) : "unavailable";
    };
    const choice = (name: string): string =>
      typeof answer(name).choice === "string"
        ? String(answer(name).choice)
        : "unavailable";

    const username = moderationContext?.user?.login ??
      String(evaluation?.state?.targetUsername ?? "unknown");
    const humanReviewNoul = answer("humanReview").noul;
    const banLabel = moderationContext?.availability?.banStatus === false
      ? "unavailable"
      : moderationContext?.ban
      ? `active (${moderationContext.ban.reason ?? "reason not recorded"})`
      : "none observed";

    const markdown = `# Twitch Moderation Analysis: @${username}

**Channel**: ${moderationContext?.channel ?? "unavailable"}<br>
**Workflow**: ${context.workflowName}<br>
**Status**: ${context.workflowStatus}<br>
**Generated**: ${new Date().toISOString()}

## Observable facts

- Account age: ${moderationContext?.user?.accountAgeDays ?? "unavailable"} days
- Current chatter: ${
      moderationContext?.isCurrentChatter === null ||
        moderationContext?.isCurrentChatter === undefined
        ? "unavailable"
        : moderationContext.isCurrentChatter
        ? "yes"
        : "no"
    }
- Current channel ban: ${banLabel}

## Jev rankings

| Dimension | Score | Confidence |
| --- | ---: | ---: |
| Moderation risk | ${score("moderationRisk")} / 4 | ${
      confidence("moderationRisk")
    } |
| Rule adherence | ${score("ruleAdherence")} / 4 | ${
      confidence("ruleAdherence")
    } |
| Disruption | ${score("disruption")} / 4 | ${confidence("disruption")} |

- Recommended posture: **${choice("recommendedAction")}**
- Human review before punitive action: **${
      typeof humanReviewNoul === "number"
        ? humanReviewNoul > 0.5 ? "yes" : "no"
        : "unavailable"
    }**

> These are evidence-based, channel-scoped moderation signals. They are not a
> personality judgment and must not be used to infer protected traits,
> off-platform identity, or intent without human review.
`;

    context.logger.info("Generated Twitch character analysis report", {
      workflowName: context.workflowName,
      username,
      hasEvaluation: evaluation !== null,
      hasModerationContext: moderationContext !== null,
    });

    return {
      markdown,
      json: {
        workflowName: context.workflowName,
        workflowStatus: context.workflowStatus,
        username,
        moderationContext,
        answers,
        evaluatedAt: evaluation?.evaluatedAt ?? null,
      },
    };
  },
};
