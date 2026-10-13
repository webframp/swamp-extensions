// AWS ACM Diagnostics Model Tests
// SPDX-License-Identifier: Apache-2.0

import {
  assertEquals,
  assertExists,
  assertMatch,
  assertRejects,
} from "jsr:@std/assert@1.0.19";
import { createModelTestContext } from "@swamp-club/swamp-testing";
import { ACMClient } from "npm:@aws-sdk/client-acm@3.1139.0";
import { model } from "./acm_diagnostics.ts";

// =============================================================================
// Mock Helpers
// =============================================================================

type Handler = (
  commandName: string,
  input: Record<string, unknown>,
) => unknown;

/**
 * Replace ACMClient.send with a handler that sees the command name and input.
 * A handler may throw to simulate an API error. Returns a restore function;
 * always call it in `finally`.
 */
function mockAcm(handler: Handler): () => void {
  const orig = ACMClient.prototype.send;
  // deno-lint-ignore no-explicit-any
  ACMClient.prototype.send = function (command: any) {
    try {
      return Promise.resolve(
        handler(command.constructor.name, command.input ?? {}),
      );
    } catch (err) {
      return Promise.reject(err);
    }
  } as typeof orig;
  return () => {
    ACMClient.prototype.send = orig;
  };
}

class AwsError extends Error {
  constructor(name: string, message: string) {
    super(message);
    this.name = name;
  }
}

function ctx() {
  return createModelTestContext({
    globalArgs: { region: "us-east-1" },
    definition: { id: "test-id", name: "acm-diag", version: 1, tags: {} },
  });
}

// Each method's execute() takes a different args type; the tests pass
// schema-valid literals, so cast the context once here.
// deno-lint-ignore no-explicit-any
const asCtx = (c: unknown) => c as any;

const P = "arn:aws:acm:us-east-1:123456789012:certificate";
const TIMED_OUT = `${P}/11111111-aaaa-bbbb-cccc-000000000001`;
const ISSUED = `${P}/22222222-aaaa-bbbb-cccc-000000000002`;
const GONE = `${P}/33333333-aaaa-bbbb-cccc-000000000003`;

const timedOutCert = {
  CertificateArn: TIMED_OUT,
  DomainName: "git.example.org",
  SubjectAlternativeNames: ["git.example.org", "registry.example.com"],
  Status: "VALIDATION_TIMED_OUT",
  Type: "AMAZON_ISSUED",
  FailureReason: "OTHER",
  KeyAlgorithm: "RSA-2048",
  CreatedAt: new Date("2026-10-09T18:06:00Z"),
  InUseBy: [],
  DomainValidationOptions: [
    {
      DomainName: "git.example.org",
      ValidationStatus: "SUCCESS",
      ValidationMethod: "DNS",
      ResourceRecord: {
        Name: "_a.git.example.org.",
        Type: "CNAME",
        Value: "_x.acm-validations.aws.",
      },
    },
    {
      DomainName: "registry.example.com",
      ValidationDomain: "registry.example.com",
      ValidationStatus: "FAILED",
      ValidationMethod: "DNS",
      ResourceRecord: {
        Name: "_b.registry.example.com.",
        Type: "CNAME",
        Value: "_y.acm-validations.aws.",
      },
    },
  ],
};

const issuedCert = {
  CertificateArn: ISSUED,
  DomainName: "git.example.org",
  SubjectAlternativeNames: ["git.example.org"],
  Status: "ISSUED",
  Type: "AMAZON_ISSUED",
  CreatedAt: new Date("2026-01-08T15:52:00Z"),
  IssuedAt: new Date("2026-01-08T20:55:12Z"),
  NotBefore: new Date("2026-01-08T00:00:00Z"),
  NotAfter: new Date("2027-02-06T23:59:59Z"),
  InUseBy: [
    "arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/net/x/1",
  ],
  DomainValidationOptions: [
    {
      DomainName: "git.example.org",
      ValidationStatus: "SUCCESS",
      ValidationMethod: "DNS",
    },
  ],
};

// =============================================================================
// Model Structure Tests
// =============================================================================

Deno.test("model has correct type string", () => {
  assertEquals(model.type, "@webframp/aws/acm-diagnostics");
});

Deno.test("model version matches CalVer pattern", () => {
  assertMatch(model.version, /^\d{4}\.\d{2}\.\d{2}\.\d+$/);
});

Deno.test("model globalArguments default region and optional profile", () => {
  const parsed = model.globalArguments.parse({});
  assertEquals(parsed.region, "us-east-1");
  assertEquals(parsed.profile, undefined);
  assertEquals(model.globalArguments.parse({ profile: "p" }).profile, "p");
});

Deno.test("model has required resources and methods", () => {
  for (const r of ["certificate_list", "certificate", "describe_summary"]) {
    assertExists(model.resources[r as keyof typeof model.resources]);
  }
  assertExists(model.methods.list_certificates);
  assertExists(model.methods.describe_certificates);
});

Deno.test("describe_certificates validates certificateArns", () => {
  const schema = model.methods.describe_certificates.arguments;
  assertEquals(schema.safeParse({ certificateArns: [] }).success, false);
  assertEquals(
    schema.safeParse({ certificateArns: ["not-an-arn"] }).success,
    false,
  );
  assertEquals(
    schema.safeParse({ certificateArns: Array(101).fill(TIMED_OUT) }).success,
    false,
  );
  // The trailing id becomes a data name: empty, '..', non-uuid must fail validation.
  for (const bad of ["", "..", "latest", "abc"]) {
    assertEquals(
      schema.safeParse({ certificateArns: [`${P}/${bad}`] }).success,
      false,
      `accepted ${JSON.stringify(bad)}`,
    );
  }
  assertEquals(
    schema.parse({ certificateArns: [TIMED_OUT] }).summaryName,
    "describe-summary",
  );
});

Deno.test("user-chosen data names reject reserved and path-unsafe values", () => {
  const describe = model.methods.describe_certificates.arguments;
  const list = model.methods.list_certificates.arguments;
  for (
    const bad of ["latest", ".", "..", "a/b", "cert-123", "", "x".repeat(101)]
  ) {
    assertEquals(
      describe.safeParse({ certificateArns: [TIMED_OUT], summaryName: bad })
        .success,
      false,
      `summaryName accepted ${JSON.stringify(bad)}`,
    );
    assertEquals(
      list.safeParse({ instanceName: bad }).success,
      false,
      `instanceName accepted ${JSON.stringify(bad)}`,
    );
  }
  assertEquals(list.safeParse({ instanceName: "stuck-2026.10" }).success, true);
});

Deno.test("list_certificates rejects unknown status values", () => {
  const schema = model.methods.list_certificates.arguments;
  assertEquals(schema.safeParse({ statuses: ["BOGUS"] }).success, false);
  assertEquals(schema.safeParse({ statuses: [] }).success, false);
  assertEquals(
    schema.parse({ statuses: ["ISSUED"] }).instanceName,
    "list-matching",
  );
});

// =============================================================================
// list_certificates
// =============================================================================

Deno.test(
  "list_certificates: filters by domain substring and passes statuses through",
  { sanitizeResources: false }, // AWS SDK clients use connection pooling
  async () => {
    let seenStatuses: unknown;
    let seenIncludes: { keyTypes?: string[] } | undefined;
    const restore = mockAcm((_name, input) => {
      seenStatuses = input.CertificateStatuses;
      seenIncludes = input.Includes as { keyTypes?: string[] };
      return {
        CertificateSummaryList: [
          {
            CertificateArn: TIMED_OUT,
            DomainName: "Git.Example.org",
            Status: "VALIDATION_TIMED_OUT",
            InUse: false,
            CreatedAt: new Date("2026-10-09T18:06:00Z"),
          },
          {
            CertificateArn: ISSUED,
            DomainName: "other.net",
            Status: "ISSUED",
            InUse: true,
          },
        ],
      };
    });
    try {
      const { context, getWrittenResources } = ctx();
      await model.methods.list_certificates.execute(
        {
          statuses: ["VALIDATION_TIMED_OUT"],
          domainContains: "git.example",
          instanceName: "timed-out",
        },
        asCtx(context),
      );
      const [r] = getWrittenResources();
      assertEquals(r.name, "timed-out");
      const d = r.data as {
        count: number;
        truncated: boolean;
        certificates: {
          certificateArn: string;
          status: string;
          createdAt: string | null;
        }[];
      };
      assertEquals(seenStatuses, ["VALIDATION_TIMED_OUT"]);
      // Default filtering hides EC and RSA_3072/4096 certificates; every key
      // type must be requested so the list is not silently incomplete.
      assertEquals([...(seenIncludes?.keyTypes ?? [])].sort(), [
        "EC_prime256v1",
        "EC_secp384r1",
        "EC_secp521r1",
        "RSA_1024",
        "RSA_2048",
        "RSA_3072",
        "RSA_4096",
      ]);
      assertEquals(d.count, 1);
      assertEquals(d.certificates[0].certificateArn, TIMED_OUT);
      assertEquals(d.certificates[0].createdAt, "2026-10-09T18:06:00.000Z");
      assertEquals(d.truncated, false);
    } finally {
      restore();
    }
  },
);

Deno.test(
  "list_certificates: follows NextToken and reports truncated at the page cap",
  { sanitizeResources: false },
  async () => {
    let calls = 0;
    const restore = mockAcm(() => {
      calls++;
      return { CertificateSummaryList: [], NextToken: "more" };
    });
    try {
      const { context, getWrittenResources } = ctx();
      await model.methods.list_certificates.execute(
        { instanceName: "all" },
        asCtx(context),
      );
      assertEquals(
        (getWrittenResources()[0].data as { truncated: boolean }).truncated,
        true,
      );
      assertEquals(calls, 50); // bounded, never unbounded
    } finally {
      restore();
    }
  },
);

Deno.test(
  "list_certificates: wraps API errors with region context",
  { sanitizeResources: false },
  async () => {
    const restore = mockAcm(() => {
      throw new AwsError("AccessDeniedException", "denied");
    });
    try {
      const { context } = ctx();
      await assertRejects(
        () =>
          model.methods.list_certificates.execute(
            { instanceName: "all" },
            asCtx(context),
          ),
        Error,
        "region=us-east-1",
      );
    } finally {
      restore();
    }
  },
);

// =============================================================================
// describe_certificates
// =============================================================================

Deno.test(
  "describe_certificates: maps validation state, expected records and in-use",
  { sanitizeResources: false },
  async () => {
    const restore = mockAcm((_name, input) => ({
      Certificate: input.CertificateArn === TIMED_OUT
        ? timedOutCert
        : issuedCert,
    }));
    try {
      const { context, getWrittenResources } = ctx();
      await model.methods.describe_certificates.execute(
        { certificateArns: [TIMED_OUT, ISSUED], summaryName: "s" },
        asCtx(context),
      );
      const written = getWrittenResources();
      assertEquals(
        written.map((w) => w.name),
        [
          "cert-11111111-aaaa-bbbb-cccc-000000000001",
          "cert-22222222-aaaa-bbbb-cccc-000000000002",
          "s",
        ],
      );

      const c = written[0].data as {
        found: boolean;
        status: string;
        failureReason: string;
        pendingValidation: string[];
        domainValidations: {
          domainName: string;
          validationStatus: string;
          resourceRecord: { name: string; type: string; value: string } | null;
        }[];
        createdAt: string;
        issuedAt: string | null;
      };
      assertEquals(c.found, true);
      assertEquals(c.status, "VALIDATION_TIMED_OUT");
      assertEquals(c.failureReason, "OTHER");
      // Only the FAILED domain is pending; SUCCESS is not.
      assertEquals(c.pendingValidation, ["registry.example.com"]);
      assertEquals(c.domainValidations[1].resourceRecord, {
        name: "_b.registry.example.com.",
        type: "CNAME",
        value: "_y.acm-validations.aws.",
      });
      assertEquals(c.createdAt, "2026-10-09T18:06:00.000Z");
      assertEquals(c.issuedAt, null);

      const s = written[2].data as {
        requested: number;
        found: number;
        byStatus: Record<string, number>;
        pendingValidation: { certificateArn: string; domains: string[] }[];
        inUse: { certificateArn: string; inUseBy: string[] }[];
      };
      assertEquals(s.requested, 2);
      assertEquals(s.found, 2);
      assertEquals(s.byStatus, { VALIDATION_TIMED_OUT: 1, ISSUED: 1 });
      assertEquals(s.pendingValidation, [{
        certificateArn: TIMED_OUT,
        domains: ["registry.example.com"],
      }]);
      assertEquals(s.inUse.map((i) => i.certificateArn), [ISSUED]);
    } finally {
      restore();
    }
  },
);

Deno.test(
  "describe_certificates: a missing certificate is recorded, not fatal, and does not hide the rest",
  { sanitizeResources: false },
  async () => {
    const restore = mockAcm((_name, input) => {
      if (input.CertificateArn === GONE) {
        throw new AwsError(
          "ResourceNotFoundException",
          "Could not find certificate",
        );
      }
      if (input.CertificateArn === TIMED_OUT) {
        throw new AwsError("AccessDeniedException", "not authorized");
      }
      return { Certificate: issuedCert };
    });
    try {
      const { context, getWrittenResources } = ctx();
      await model.methods.describe_certificates.execute(
        { certificateArns: [GONE, TIMED_OUT, ISSUED], summaryName: "s" },
        asCtx(context),
      );
      const written = getWrittenResources();
      const gone = written[0].data as {
        found: boolean;
        errorCode: string;
        status: string | null;
      };
      assertEquals(gone.found, false);
      assertEquals(gone.errorCode, "ResourceNotFoundException");
      assertEquals(gone.status, null);

      const s = written[written.length - 1].data as {
        requested: number;
        found: number;
        notFound: string[];
        errored: { certificateArn: string; errorCode: string }[];
      };
      assertEquals(s.requested, 3);
      assertEquals(s.found, 1);
      // Nonexistent and denied are different findings.
      assertEquals(s.notFound, [GONE]);
      assertEquals(s.errored.map((e) => [e.certificateArn, e.errorCode]), [
        [TIMED_OUT, "AccessDeniedException"],
      ]);
    } finally {
      restore();
    }
  },
);

Deno.test(
  "describe_certificates: duplicate ARNs are described once",
  { sanitizeResources: false },
  async () => {
    let calls = 0;
    const restore = mockAcm(() => {
      calls++;
      return { Certificate: issuedCert };
    });
    try {
      const { context, getWrittenResources } = ctx();
      await model.methods.describe_certificates.execute(
        { certificateArns: [ISSUED, ISSUED], summaryName: "s" },
        asCtx(context),
      );
      assertEquals(calls, 1);
      assertEquals(getWrittenResources().length, 2); // one cert + summary
    } finally {
      restore();
    }
  },
);

Deno.test(
  "describe_certificates: an empty response is recorded as errored, not a crash",
  { sanitizeResources: false },
  async () => {
    const restore = mockAcm((_name, input) =>
      input.CertificateArn === TIMED_OUT ? {} : { Certificate: issuedCert }
    );
    try {
      const { context, getWrittenResources } = ctx();
      await model.methods.describe_certificates.execute(
        { certificateArns: [TIMED_OUT, ISSUED], summaryName: "s" },
        asCtx(context),
      );
      const written = getWrittenResources();
      const s = written[written.length - 1].data as {
        errored: { certificateArn: string; errorCode: string }[];
      };
      assertEquals(s.errored.map((e) => [e.certificateArn, e.errorCode]), [
        [TIMED_OUT, "EmptyResponse"],
      ]);
    } finally {
      restore();
    }
  },
);

Deno.test(
  "list_certificates: domainContains also matches subject alternative names",
  { sanitizeResources: false },
  async () => {
    const restore = mockAcm(() => ({
      CertificateSummaryList: [
        {
          CertificateArn: TIMED_OUT,
          DomainName: "git.example.org",
          SubjectAlternativeNameSummaries: ["registry.example.com"],
        },
        { CertificateArn: ISSUED, DomainName: "other.net" },
      ],
    }));
    try {
      const { context, getWrittenResources } = ctx();
      await model.methods.list_certificates.execute(
        { domainContains: "registry.example", instanceName: "san" },
        asCtx(context),
      );
      const d = getWrittenResources()[0].data as {
        certificates: { certificateArn: string }[];
      };
      assertEquals(d.certificates.map((c) => c.certificateArn), [TIMED_OUT]);
    } finally {
      restore();
    }
  },
);

Deno.test(
  "describe_certificates: a transient error does not overwrite a certificate record",
  { sanitizeResources: false },
  async () => {
    const restore = mockAcm((_name, input) => {
      if (input.CertificateArn === TIMED_OUT) {
        throw new AwsError("ThrottlingException", "Rate exceeded");
      }
      return { Certificate: issuedCert };
    });
    try {
      const { context, getWrittenResources } = ctx();
      await model.methods.describe_certificates.execute(
        { certificateArns: [TIMED_OUT, ISSUED], summaryName: "s" },
        asCtx(context),
      );
      const names = getWrittenResources().map((w) => w.name);
      // No record for the throttled certificate: the last good one is kept.
      assertEquals(names, [
        "cert-22222222-aaaa-bbbb-cccc-000000000002",
        "s",
      ]);
    } finally {
      restore();
    }
  },
);

Deno.test(
  "describe_certificates: fails when no certificate could be described, after writing the summary",
  { sanitizeResources: false },
  async () => {
    const restore = mockAcm(() => {
      throw new AwsError("ExpiredTokenException", "token expired");
    });
    try {
      const { context, getWrittenResources } = ctx();
      await assertRejects(
        () =>
          model.methods.describe_certificates.execute(
            { certificateArns: [TIMED_OUT, ISSUED], summaryName: "s" },
            asCtx(context),
          ),
        Error,
        "ExpiredTokenException",
      );
      const written = getWrittenResources();
      assertEquals(written.map((w) => w.name), ["s"]);
      const s = written[0].data as { found: number; errored: unknown[] };
      assertEquals(s.found, 0);
      assertEquals(s.errored.length, 2);
    } finally {
      restore();
    }
  },
);

Deno.test(
  "describe_certificates: all-not-found is a result, not a failure",
  { sanitizeResources: false },
  async () => {
    const restore = mockAcm(() => {
      throw new AwsError("ResourceNotFoundException", "gone");
    });
    try {
      const { context, getWrittenResources } = ctx();
      await model.methods.describe_certificates.execute(
        { certificateArns: [GONE], summaryName: "s" },
        asCtx(context),
      );
      assertEquals(getWrittenResources().map((w) => w.name), [
        "cert-33333333-aaaa-bbbb-cccc-000000000003",
        "s",
      ]);
    } finally {
      restore();
    }
  },
);

Deno.test(
  "describe_certificates: the same UUID in two accounts keeps both records, independent of input order",
  { sanitizeResources: false },
  async () => {
    const a = `${P}/44444444-aaaa-bbbb-cccc-000000000004`;
    const b =
      "arn:aws:acm:us-east-1:210987654321:certificate/44444444-aaaa-bbbb-cccc-000000000004";
    const restore = mockAcm((_name, input) => ({
      Certificate: { ...issuedCert, CertificateArn: input.CertificateArn },
    }));
    try {
      const run = async (arns: string[]) => {
        const { context, getWrittenResources } = ctx();
        await model.methods.describe_certificates.execute(
          { certificateArns: arns, summaryName: "s" },
          asCtx(context),
        );
        // arn -> data name
        return new Map(
          getWrittenResources()
            .filter((w) => w.name !== "s")
            .map((
              w,
            ) => [
              (w.data as { certificateArn: string }).certificateArn,
              w.name,
            ]),
        );
      };
      const ab = await run([a, b]);
      const ba = await run([b, a]);
      assertEquals(new Set(ab.values()).size, 2);
      // Same ARN gets the same name whichever order it was given in.
      assertEquals(ab.get(a), ba.get(a));
      assertEquals(ab.get(b), ba.get(b));
    } finally {
      restore();
    }
  },
);

Deno.test(
  "describe_certificates: an ARN from another region is flagged, not sent to the API",
  { sanitizeResources: false },
  async () => {
    const west =
      "arn:aws:acm:eu-west-1:123456789012:certificate/55555555-aaaa-bbbb-cccc-000000000005";
    const asked: unknown[] = [];
    const restore = mockAcm((_name, input) => {
      asked.push(input.CertificateArn);
      return { Certificate: issuedCert };
    });
    try {
      const { context, getWrittenResources } = ctx();
      await model.methods.describe_certificates.execute(
        { certificateArns: [west, ISSUED], summaryName: "s" },
        asCtx(context),
      );
      assertEquals(asked, [ISSUED]);
      const written = getWrittenResources();
      // No false "deleted" record for the other region's certificate.
      assertEquals(written.map((w) => w.name), [
        "cert-22222222-aaaa-bbbb-cccc-000000000002",
        "s",
      ]);
      const s = written[1].data as { errored: { errorCode: string }[] };
      assertEquals(s.errored.map((e) => e.errorCode), ["RegionMismatch"]);
    } finally {
      restore();
    }
  },
);

Deno.test(
  "describe_certificates: a partial failure logs a warning",
  { sanitizeResources: false },
  async () => {
    const restore = mockAcm((_name, input) => {
      if (input.CertificateArn === TIMED_OUT) {
        throw new AwsError("ThrottlingException", "Rate exceeded");
      }
      return { Certificate: issuedCert };
    });
    try {
      const { context, getLogsByLevel } = ctx();
      await model.methods.describe_certificates.execute(
        { certificateArns: [TIMED_OUT, ISSUED], summaryName: "s" },
        asCtx(context),
      );
      assertEquals(getLogsByLevel("warning").length, 1);
    } finally {
      restore();
    }
  },
);

Deno.test(
  "list_certificates: requests every key pair origin, not just the default two",
  { sanitizeResources: false },
  async () => {
    let origins: string[] | undefined;
    const restore = mockAcm((_name, input) => {
      origins = input.CertificateKeyPairOrigins as string[];
      return { CertificateSummaryList: [] };
    });
    try {
      const { context } = ctx();
      await model.methods.list_certificates.execute(
        { instanceName: "o" },
        asCtx(context),
      );
      assertEquals([...(origins ?? [])].sort(), [
        "ACME",
        "AWS_MANAGED",
        "CUSTOMER_PROVIDED",
      ]);
    } finally {
      restore();
    }
  },
);

Deno.test("each method rejects the other method's default data name", () => {
  const list = model.methods.list_certificates.arguments;
  const describe = model.methods.describe_certificates.arguments;
  assertEquals(
    list.safeParse({ instanceName: "describe-summary" }).success,
    false,
  );
  assertEquals(
    describe.safeParse({
      certificateArns: [TIMED_OUT],
      summaryName: "list-matching",
    }).success,
    false,
  );
  assertEquals(list.parse({}).instanceName, "list-matching");
});

Deno.test(
  "describe_certificates: a record keeps its hashed name when its same-UUID twin errors",
  { sanitizeResources: false },
  async () => {
    const a = `${P}/66666666-aaaa-bbbb-cccc-000000000006`;
    const b =
      "arn:aws:acm:us-east-1:210987654321:certificate/66666666-aaaa-bbbb-cccc-000000000006";
    const nameFor = async (twinFails: boolean) => {
      const restore = mockAcm((_name, input) => {
        if (twinFails && input.CertificateArn === a) {
          throw new AwsError("ThrottlingException", "Rate exceeded");
        }
        return {
          Certificate: { ...issuedCert, CertificateArn: input.CertificateArn },
        };
      });
      try {
        const { context, getWrittenResources } = ctx();
        await model.methods.describe_certificates.execute(
          { certificateArns: [a, b], summaryName: "s" },
          asCtx(context),
        );
        return getWrittenResources().find((w) =>
          (w.data as { certificateArn?: string }).certificateArn === b
        )!.name;
      } finally {
        restore();
      }
    };
    // b's name must not change depending on whether a was written this run.
    assertEquals(await nameFor(true), await nameFor(false));
  },
);
