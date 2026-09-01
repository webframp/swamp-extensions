/**
 * AWS Kiro usage report extension for swamp.
 *
 * Method-scope report that runs after the `kiro-usage` model's `scan` method
 * and renders its `scan_results` resource into a per-user spend table, a
 * per-tier rollup, and an account-level reconciliation (gross, EDP discount,
 * net, credits, overage). Produces both markdown and JSON.
 *
 * The report never throws: a missing or unparseable resource degrades to a
 * still-valid report with a `degraded` flag set in the JSON payload.
 *
 * @module
 */
// SPDX-License-Identifier: Apache-2.0

/** Handle referencing a data artifact produced during method execution. */
interface DataHandle {
  name: string;
  kind: string;
}

/** Data repository access available to reports. */
interface DataRepository {
  getContent: (
    modelType: unknown,
    modelId: string,
    dataName: string,
    version?: number,
  ) => Promise<Uint8Array | null>;
}

/** Context provided by swamp when executing a method-scoped report. */
interface MethodReportContext {
  modelType: string;
  modelId: string;
  definition: { name: string };
  methodName: string;
  methodArgs: Record<string, unknown>;
  executionStatus: string;
  dataHandles: DataHandle[];
  dataRepository: DataRepository;
  logger: {
    info: (msg: string, props?: Record<string, unknown>) => void;
    warn: (msg: string, props?: Record<string, unknown>) => void;
  };
}

/** Per-user row shape read from the scan_results resource. */
interface UserRow {
  userId: string;
  displayName: string;
  email: string;
  username: string;
  resolved: boolean;
  plan: string;
  seatMonths: number;
  seatCostListUsd: number;
  seatCostNetUsd: number;
  credits: number;
  overageUsd: number;
}

/** Tier rollup row shape. */
interface TierRow {
  plan: string;
  users: number;
  seatCostListUsd: number;
  seatCostNetUsd: number;
  credits: number;
}

/** Parsed scan_results resource shape (only the fields the report reads). */
interface ScanResults {
  billingPeriod: string;
  currency: string;
  resolvedIdentities: boolean;
  users: UserRow[];
  tiers: TierRow[];
  discount: {
    grossCostUsd: number;
    edpDiscountUsd: number;
    netCostUsd: number;
  };
  totals: {
    userCount: number;
    grossCostUsd: number;
    edpDiscountUsd: number;
    netCostUsd: number;
    creditsConsumed: number;
    overageUsd: number;
  };
}

/** Format a number as a currency string in the given currency code. */
function money(amount: number, currency: string): string {
  const sign = amount < 0 ? "-" : "";
  const abs = Math.abs(amount).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  // USD renders with a leading $; other currencies append the ISO code so the
  // figure is never an ambiguous bare number.
  if (currency === "USD") return `${sign}$${abs}`;
  return `${sign}${abs} ${currency}`;
}

/** Format an integer with thousands separators. */
function count(n: number): string {
  return Math.round(n).toLocaleString();
}

/** Render a markdown table from headers and pre-stringified rows. */
function table(headers: string[], rows: string[][]): string {
  const sep = headers.map(() => "---");
  return [
    `| ${headers.join(" | ")} |`,
    `| ${sep.join(" | ")} |`,
    ...rows.map((r) => `| ${r.join(" | ")} |`),
  ].join("\n");
}

/** Display label for a user row: resolved name, else username, else id. */
function userLabel(u: UserRow): string {
  if (u.displayName) return u.displayName;
  if (u.username) return u.username;
  return u.userId;
}

/**
 * Locate the scan_results resource among the produced data handles and parse
 * it. Returns null if no matching handle exists or the content is unreadable.
 */
async function loadScanResults(
  context: MethodReportContext,
): Promise<ScanResults | null> {
  const handle = context.dataHandles.find(
    (h) => h.kind === "resource" && h.name.includes("scan_results"),
  ) ?? context.dataHandles.find((h) => h.kind === "resource");
  if (!handle) return null;

  try {
    const bytes = await context.dataRepository.getContent(
      context.modelType,
      context.modelId,
      handle.name,
    );
    if (!bytes) return null;
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Partial<
      ScanResults
    >;
    // Guard against parseable-but-incomplete content (e.g. a truncated or
    // tampered resource). The model's own `scan` always writes the full
    // shape, but the report must degrade rather than throw on anything else.
    if (
      !parsed || typeof parsed !== "object" ||
      !parsed.totals || !Array.isArray(parsed.users) ||
      !Array.isArray(parsed.tiers) || !parsed.discount
    ) {
      context.logger.warn("scan_results resource is missing required fields", {
        handle: handle.name,
      });
      return null;
    }
    return parsed as ScanResults;
  } catch (err) {
    context.logger.warn("Failed to read scan_results resource", {
      error: String(err),
    });
    return null;
  }
}

/** AWS Kiro per-user usage and spend report. */
export const report = {
  name: "@webframp/aws/kiro-usage-report",
  description:
    "Per-user AWS Kiro spend and credit consumption with tier rollup and " +
    "account-level EDP reconciliation",
  scope: "method" as const,
  labels: ["ai", "aws", "kiro", "finops", "cost", "report"],

  execute: async (
    context: MethodReportContext,
  ): Promise<{ markdown: string; json: Record<string, unknown> }> => {
    const modelType = String(context.modelType || "");
    if (!modelType.includes("kiro-usage")) {
      return {
        markdown: `*Report skipped: not a kiro-usage model (${modelType})*`,
        json: { skipped: true, reason: "not-kiro-usage-model" },
      };
    }

    if (context.methodName !== "scan") {
      return {
        markdown:
          `*Report skipped: no output for method ${context.methodName}*`,
        json: { skipped: true, reason: "unsupported-method" },
      };
    }

    const data = await loadScanResults(context);
    if (!data) {
      return {
        markdown:
          "# AWS Kiro Usage Report\n\n*No scan_results resource was found for this run.*",
        json: { degraded: true, reason: "no-scan-results" },
      };
    }

    const cur = data.currency || "USD";
    const sections: string[] = [];

    sections.push("# AWS Kiro Usage Report");
    sections.push("");
    sections.push(`**Billing period**: ${data.billingPeriod}`);
    sections.push(`**Users with a seat**: ${data.totals.userCount}`);
    sections.push(
      `**Identity resolution**: ${
        data.resolvedIdentities ? "enabled" : "disabled (user ids only)"
      }`,
    );
    sections.push("");

    // --- Reconciliation ---
    sections.push("## Cost reconciliation");
    sections.push("");
    sections.push(
      table(
        ["Line", "Amount"],
        [
          ["Seat cost (list)", money(data.discount.grossCostUsd, cur)],
          [
            "EDP discount (account-level)",
            money(data.discount.edpDiscountUsd, cur),
          ],
          ["Seat cost (net, billed)", money(data.discount.netCostUsd, cur)],
          ["Credits consumed", count(data.totals.creditsConsumed)],
          ["Credit overage (billed)", money(data.totals.overageUsd, cur)],
        ],
      ),
    );
    sections.push("");
    sections.push(
      "> The EDP discount is booked at the account level and is not " +
        "attributable to individuals. Per-user net cost below is an " +
        "allocation of that discount, not a billed figure.",
    );
    sections.push("");

    // --- Tier rollup ---
    sections.push("## By tier");
    sections.push("");
    sections.push(
      table(
        ["Tier", "Users", "Seat (list)", "Seat (net)", "Credits"],
        data.tiers.map((t) => [
          t.plan,
          String(t.users),
          money(t.seatCostListUsd, cur),
          money(t.seatCostNetUsd, cur),
          count(t.credits),
        ]),
      ),
    );
    sections.push("");

    // --- Per-user detail ---
    sections.push("## Per user");
    sections.push("");
    sections.push(
      table(
        ["User", "Email", "Tier", "Seat (net)", "Credits"],
        data.users.map((u) => [
          userLabel(u),
          u.email || "\u2014",
          u.plan,
          money(u.seatCostNetUsd, cur),
          count(u.credits),
        ]),
      ),
    );
    sections.push("");

    // --- Highlights ---
    const topConsumers = [...data.users]
      .sort((a, b) => b.credits - a.credits)
      .slice(0, 3)
      .filter((u) => u.credits > 0);
    if (topConsumers.length > 0) {
      sections.push("## Highlights");
      sections.push("");
      for (const u of topConsumers) {
        sections.push(
          `- Top consumer: **${userLabel(u)}** (${u.plan}) \u2014 ${
            count(u.credits)
          } credits`,
        );
      }
      sections.push("");
    }

    return {
      markdown: sections.join("\n"),
      json: {
        billingPeriod: data.billingPeriod,
        currency: cur,
        resolvedIdentities: data.resolvedIdentities,
        totals: data.totals,
        discount: data.discount,
        tiers: data.tiers,
        users: data.users,
        degraded: false,
      },
    };
  },
};
