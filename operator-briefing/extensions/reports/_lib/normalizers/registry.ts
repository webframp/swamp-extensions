/**
 * Normalizer registry, keyed by swamp `modelType`.
 *
 * Adding a source = one workflow step + one normalizer + one line here. The
 * render/tiering/freshness core never changes. An unknown modelType has no
 * entry and the core skips-and-counts it.
 *
 * SPDX-License-Identifier: Apache-2.0
 * @module
 */

import type { Normalizer } from "../shapes.ts";
import { gitlabNormalizer } from "./gitlab.ts";
import { analyticsNormalizer } from "./anthropic_analytics.ts";
import { complianceNormalizer } from "./anthropic_compliance.ts";
import { awsQuotasNormalizer } from "./aws_quotas.ts";

export const registry: Record<string, Normalizer> = {
  "@webframp/gitlab": gitlabNormalizer,
  "@webframp/anthropic/analytics": analyticsNormalizer,
  "@webframp/anthropic/compliance": complianceNormalizer,
  "@webframp/aws/service-quotas": awsQuotasNormalizer,
};

/**
 * Model types that legitimately run inside the daily-briefing workflow but are
 * NOT briefing sources — they consume or accumulate the briefing's own output
 * rather than contributing queue/ops items, so they have no normalizer by
 * design. The workflow report skips them SILENTLY: counting them as a
 * "skipped source" would (wrongly) mark the whole briefing `degraded`.
 *
 * Today this is the durable metrics accumulator (`metrics_append` appends the
 * day's numbers to the trend series). A missing normalizer for any OTHER
 * modelType is still a real gap and is skipped-and-counted as before.
 */
export const nonSourceModelTypes = new Set<string>([
  "@webframp/operator-briefing/metrics",
]);
