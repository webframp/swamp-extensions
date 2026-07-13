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
