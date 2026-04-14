// AWS X-Ray Traces Model Tests
// SPDX-License-Identifier: Apache-2.0

import { assertEquals, assertExists, assertMatch } from "jsr:@std/assert@1";
import { createModelTestContext } from "@systeminit/swamp-testing";
import { XRayClient } from "npm:@aws-sdk/client-xray@3.1010.0";
import { model } from "./traces.ts";

// =============================================================================
// Mock Helper
// =============================================================================

function mockXRay(handler: (command: unknown) => unknown): () => void {
  const original = XRayClient.prototype.send;
  // deno-lint-ignore no-explicit-any
  XRayClient.prototype.send = function (_command: any) {
    return Promise.resolve(handler(_command));
  } as typeof original;
  return () => {
    XRayClient.prototype.send = original;
  };
}

// =============================================================================
// Mock Data
// =============================================================================

const service1 = {
  Name: "api-gateway",
  Type: "AWS::ApiGateway::Stage",
  ReferenceId: 1,
  AccountId: "123456789012",
  State: "active",
  StartTime: new Date("2026-01-01T00:00:00Z"),
  EndTime: new Date("2026-01-01T01:00:00Z"),
  Edges: [{
    ReferenceId: 2,
    SummaryStatistics: {
      OkCount: 95,
      ErrorStatistics: { ThrottleCount: 1, OtherCount: 2, TotalCount: 3 },
      FaultStatistics: { OtherCount: 2, TotalCount: 2 },
      TotalCount: 100,
      TotalResponseTime: 5.0,
    },
  }],
  SummaryStatistics: {
    OkCount: 95,
    ErrorStatistics: { ThrottleCount: 1, OtherCount: 2, TotalCount: 3 },
    FaultStatistics: { OtherCount: 2, TotalCount: 2 },
    TotalCount: 100,
    TotalResponseTime: 5.0,
  },
  ResponseTimeHistogram: [{ Value: 0.05, Count: 50 }, {
    Value: 0.1,
    Count: 30,
  }],
};

const service2 = {
  Name: "lambda-function",
  Type: "AWS::Lambda::Function",
  ReferenceId: 2,
  Edges: [],
  SummaryStatistics: {
    OkCount: 90,
    ErrorStatistics: { ThrottleCount: 0, OtherCount: 5, TotalCount: 5 },
    FaultStatistics: { OtherCount: 5, TotalCount: 5 },
    TotalCount: 100,
    TotalResponseTime: 10.0,
  },
  ResponseTimeHistogram: [],
};

const trace1 = {
  Id: "1-abc-123",
  Duration: 0.5,
  ResponseTime: 0.3,
  HasFault: false,
  HasError: false,
  HasThrottle: false,
  IsPartial: false,
  Http: {
    HttpURL: "https://api.example.com/users",
    HttpMethod: "GET",
    HttpStatus: 200,
  },
  Annotations: {},
  Users: [],
  ServiceIds: [{
    Name: "api-gateway",
    Type: "AWS::ApiGateway::Stage",
    AccountId: "123456789012",
  }],
};

const trace2 = {
  Id: "1-abc-456",
  Duration: 1.2,
  ResponseTime: 1.0,
  HasFault: false,
  HasError: false,
  HasThrottle: false,
  IsPartial: false,
  Http: {
    HttpURL: "https://api.example.com/orders",
    HttpMethod: "POST",
    HttpStatus: 201,
  },
  Annotations: {},
  Users: [],
  ServiceIds: [],
};

const trace3 = {
  Id: "1-abc-789",
  Duration: 0.8,
  ResponseTime: 0.6,
  HasFault: true,
  HasError: false,
  HasThrottle: false,
  IsPartial: false,
  Http: {
    HttpURL: "https://api.example.com/users",
    HttpMethod: "GET",
    HttpStatus: 500,
  },
  Annotations: {},
  Users: [],
  ServiceIds: [{
    Name: "lambda-function",
    Type: "AWS::Lambda::Function",
    AccountId: "123456789012",
  }],
};

// 10 traces for analyze_errors: 3 fault, 2 error, 1 throttle, 4 clean
const analyzeTraces = [
  // 3 faulted traces with ServiceIds and Http URLs
  {
    Id: "1-fault-001",
    Duration: 0.5,
    ResponseTime: 0.3,
    HasFault: true,
    HasError: false,
    HasThrottle: false,
    IsPartial: false,
    Http: {
      HttpURL: "https://api.example.com/users",
      HttpMethod: "GET",
      HttpStatus: 500,
    },
    Annotations: {},
    Users: [],
    ServiceIds: [
      {
        Name: "api-gateway",
        Type: "AWS::ApiGateway::Stage",
        AccountId: "123456789012",
      },
    ],
  },
  {
    Id: "1-fault-002",
    Duration: 0.6,
    ResponseTime: 0.4,
    HasFault: true,
    HasError: false,
    HasThrottle: false,
    IsPartial: false,
    Http: {
      HttpURL: "https://api.example.com/orders",
      HttpMethod: "POST",
      HttpStatus: 502,
    },
    Annotations: {},
    Users: [],
    ServiceIds: [
      {
        Name: "api-gateway",
        Type: "AWS::ApiGateway::Stage",
        AccountId: "123456789012",
      },
      {
        Name: "lambda-function",
        Type: "AWS::Lambda::Function",
        AccountId: "123456789012",
      },
    ],
  },
  {
    Id: "1-fault-003",
    Duration: 0.7,
    ResponseTime: 0.5,
    HasFault: true,
    HasError: false,
    HasThrottle: false,
    IsPartial: false,
    Http: {
      HttpURL: "https://api.example.com/users",
      HttpMethod: "GET",
      HttpStatus: 500,
    },
    Annotations: {},
    Users: [],
    ServiceIds: [
      {
        Name: "lambda-function",
        Type: "AWS::Lambda::Function",
        AccountId: "123456789012",
      },
    ],
  },
  // 2 error traces
  {
    Id: "1-error-001",
    Duration: 0.3,
    ResponseTime: 0.2,
    HasFault: false,
    HasError: true,
    HasThrottle: false,
    IsPartial: false,
    Http: {
      HttpURL: "https://api.example.com/health",
      HttpMethod: "GET",
      HttpStatus: 400,
    },
    Annotations: {},
    Users: [],
    ServiceIds: [],
  },
  {
    Id: "1-error-002",
    Duration: 0.4,
    ResponseTime: 0.3,
    HasFault: false,
    HasError: true,
    HasThrottle: false,
    IsPartial: false,
    Http: {
      HttpURL: "https://api.example.com/login",
      HttpMethod: "POST",
      HttpStatus: 401,
    },
    Annotations: {},
    Users: [],
    ServiceIds: [],
  },
  // 1 throttle trace
  {
    Id: "1-throttle-001",
    Duration: 0.2,
    ResponseTime: 0.1,
    HasFault: false,
    HasError: false,
    HasThrottle: true,
    IsPartial: false,
    Http: {
      HttpURL: "https://api.example.com/data",
      HttpMethod: "GET",
      HttpStatus: 429,
    },
    Annotations: {},
    Users: [],
    ServiceIds: [],
  },
  // 4 clean traces
  {
    Id: "1-ok-001",
    Duration: 0.1,
    ResponseTime: 0.05,
    HasFault: false,
    HasError: false,
    HasThrottle: false,
    IsPartial: false,
    Http: {
      HttpURL: "https://api.example.com/users",
      HttpMethod: "GET",
      HttpStatus: 200,
    },
    Annotations: {},
    Users: [],
    ServiceIds: [],
  },
  {
    Id: "1-ok-002",
    Duration: 0.15,
    ResponseTime: 0.08,
    HasFault: false,
    HasError: false,
    HasThrottle: false,
    IsPartial: false,
    Http: {
      HttpURL: "https://api.example.com/orders",
      HttpMethod: "GET",
      HttpStatus: 200,
    },
    Annotations: {},
    Users: [],
    ServiceIds: [],
  },
  {
    Id: "1-ok-003",
    Duration: 0.12,
    ResponseTime: 0.06,
    HasFault: false,
    HasError: false,
    HasThrottle: false,
    IsPartial: false,
    Http: {
      HttpURL: "https://api.example.com/health",
      HttpMethod: "GET",
      HttpStatus: 200,
    },
    Annotations: {},
    Users: [],
    ServiceIds: [],
  },
  {
    Id: "1-ok-004",
    Duration: 0.11,
    ResponseTime: 0.05,
    HasFault: false,
    HasError: false,
    HasThrottle: false,
    IsPartial: false,
    Http: {
      HttpURL: "https://api.example.com/data",
      HttpMethod: "GET",
      HttpStatus: 200,
    },
    Annotations: {},
    Users: [],
    ServiceIds: [],
  },
];

// =============================================================================
// Model Structure Tests
// =============================================================================

Deno.test("model has correct type string", () => {
  assertEquals(model.type, "@webframp/aws/traces");
});

Deno.test("model version matches CalVer pattern", () => {
  assertMatch(model.version, /^\d{4}\.\d{2}\.\d{2}\.\d+$/);
});

Deno.test("model globalArguments has region with default", () => {
  const parsed = model.globalArguments.parse({});
  assertEquals(parsed.region, "us-east-1");
});

Deno.test("model defines expected resources", () => {
  assertExists(model.resources.service_graph);
  assertExists(model.resources.trace_summaries);
  assertExists(model.resources.error_analysis);
});

Deno.test("model defines expected methods", () => {
  assertExists(model.methods.get_service_graph);
  assertExists(model.methods.get_traces);
  assertExists(model.methods.get_errors);
  assertExists(model.methods.analyze_errors);
});

// =============================================================================
// get_service_graph Tests
// =============================================================================

Deno.test(
  "get_service_graph: returns mapped service graph with edges and statistics",
  { sanitizeResources: false }, // AWS SDK client uses connection pooling
  async () => {
    const restore = mockXRay((command) => {
      const name = command?.constructor?.name;
      if (name === "GetServiceGraphCommand") {
        return {
          Services: [service1, service2],
          ContainsOldGroupVersions: false,
        };
      }
      return {};
    });

    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: { region: "us-east-1" },
        definition: {
          id: "test-id",
          name: "aws-traces",
          version: 1,
          tags: {},
        },
      });

      const result = await model.methods.get_service_graph.execute(
        { startTime: "1h" },
        context as unknown as Parameters<
          typeof model.methods.get_service_graph.execute
        >[1],
      );

      assertEquals(result.dataHandles.length, 1);

      const written = getWrittenResources();
      assertEquals(written.length, 1);
      assertEquals(written[0].specName, "service_graph");

      const data = written[0].data as {
        services: Array<{
          name: string;
          type: string | null;
          edges: Array<{
            referenceId: number;
            summaryStatistics: {
              okCount: number;
              errorStatistics: {
                throttleCount: number;
                otherCount: number;
                totalCount: number;
              };
              faultStatistics: { otherCount: number; totalCount: number };
              totalCount: number;
              totalResponseTime: number;
            } | null;
          }>;
          responseTimeHistogram: Array<{ value: number; count: number }>;
        }>;
      };

      assertEquals(data.services.length, 2);
      assertEquals(data.services[0].name, "api-gateway");
      assertEquals(data.services[0].type, "AWS::ApiGateway::Stage");
      assertEquals(data.services[1].name, "lambda-function");
      assertEquals(data.services[1].type, "AWS::Lambda::Function");

      // Edge statistics
      assertEquals(data.services[0].edges.length, 1);
      assertEquals(data.services[0].edges[0].referenceId, 2);
      assertEquals(data.services[0].edges[0].summaryStatistics?.okCount, 95);
      assertEquals(
        data.services[0].edges[0].summaryStatistics?.errorStatistics
          .totalCount,
        3,
      );
      assertEquals(
        data.services[0].edges[0].summaryStatistics?.faultStatistics
          .totalCount,
        2,
      );

      // ResponseTimeHistogram
      assertEquals(data.services[0].responseTimeHistogram.length, 2);
      assertEquals(data.services[0].responseTimeHistogram[0].value, 0.05);
      assertEquals(data.services[0].responseTimeHistogram[0].count, 50);
    } finally {
      restore();
    }
  },
);

// =============================================================================
// get_traces Tests
// =============================================================================

Deno.test(
  "get_traces: returns mapped trace summaries with HTTP info",
  { sanitizeResources: false }, // AWS SDK client uses connection pooling
  async () => {
    const restore = mockXRay(() => ({
      TraceSummaries: [trace1, trace2, trace3],
    }));

    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: { region: "us-east-1" },
        definition: {
          id: "test-id",
          name: "aws-traces",
          version: 1,
          tags: {},
        },
      });

      const result = await model.methods.get_traces.execute(
        { startTime: "1h", sampling: true, limit: 100 },
        context as unknown as Parameters<
          typeof model.methods.get_traces.execute
        >[1],
      );

      assertEquals(result.dataHandles.length, 1);

      const written = getWrittenResources();
      assertEquals(written.length, 1);
      assertEquals(written[0].specName, "trace_summaries");

      const data = written[0].data as {
        traces: Array<{
          traceId: string;
          hasFault: boolean;
          hasError: boolean;
          hasThrottle: boolean;
          http: {
            httpURL: string | null;
            httpMethod: string | null;
            httpStatus: number | null;
          } | null;
        }>;
        count: number;
      };

      assertEquals(data.count, 3);
      assertEquals(data.traces.length, 3);

      // Trace 1 fields
      assertEquals(data.traces[0].traceId, "1-abc-123");
      assertEquals(
        data.traces[0].http?.httpURL,
        "https://api.example.com/users",
      );
      assertEquals(data.traces[0].http?.httpMethod, "GET");
      assertEquals(data.traces[0].http?.httpStatus, 200);
      assertEquals(data.traces[0].hasFault, false);
      assertEquals(data.traces[0].hasError, false);
      assertEquals(data.traces[0].hasThrottle, false);

      // Trace 3 has fault
      assertEquals(data.traces[2].traceId, "1-abc-789");
      assertEquals(data.traces[2].hasFault, true);
      assertEquals(data.traces[2].http?.httpStatus, 500);
    } finally {
      restore();
    }
  },
);

// =============================================================================
// get_errors Tests
// =============================================================================

Deno.test(
  "get_errors: filters traces by error type and writes to trace_summaries",
  { sanitizeResources: false }, // AWS SDK client uses connection pooling
  async () => {
    // deno-lint-ignore no-explicit-any
    let capturedFilter: any;
    const restore = mockXRay((command) => {
      // deno-lint-ignore no-explicit-any
      const input = (command as any).input;
      capturedFilter = input?.FilterExpression;
      return {
        TraceSummaries: [trace3], // Only the faulted trace
      };
    });

    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: { region: "us-east-1" },
        definition: {
          id: "test-id",
          name: "aws-traces",
          version: 1,
          tags: {},
        },
      });

      const result = await model.methods.get_errors.execute(
        { startTime: "1h", errorType: "fault", limit: 50 },
        context as unknown as Parameters<
          typeof model.methods.get_errors.execute
        >[1],
      );

      assertEquals(result.dataHandles.length, 1);
      assertEquals(capturedFilter, "fault = true");

      const written = getWrittenResources();
      assertEquals(written.length, 1);
      assertEquals(written[0].specName, "trace_summaries");

      const data = written[0].data as {
        traces: Array<{ traceId: string; hasFault: boolean }>;
        count: number;
        filterExpression: string;
      };

      assertEquals(data.count, 1);
      assertEquals(data.traces[0].hasFault, true);
      assertEquals(data.filterExpression, "fault = true");
    } finally {
      restore();
    }
  },
);

Deno.test(
  "get_errors: uses combined filter for 'any' error type",
  { sanitizeResources: false }, // AWS SDK client uses connection pooling
  async () => {
    // deno-lint-ignore no-explicit-any
    let capturedFilter: any;
    const restore = mockXRay((command) => {
      // deno-lint-ignore no-explicit-any
      const input = (command as any).input;
      capturedFilter = input?.FilterExpression;
      return { TraceSummaries: [] };
    });

    try {
      const { context } = createModelTestContext({
        globalArgs: { region: "us-east-1" },
        definition: {
          id: "test-id",
          name: "aws-traces",
          version: 1,
          tags: {},
        },
      });

      await model.methods.get_errors.execute(
        { startTime: "1h", errorType: "any", limit: 50 },
        context as unknown as Parameters<
          typeof model.methods.get_errors.execute
        >[1],
      );

      assertEquals(
        capturedFilter,
        "fault = true OR error = true OR throttle = true",
      );
    } finally {
      restore();
    }
  },
);

// =============================================================================
// analyze_errors Tests
// =============================================================================

Deno.test(
  "analyze_errors: computes fault, error, and throttle rates correctly",
  { sanitizeResources: false }, // AWS SDK client uses connection pooling
  async () => {
    const restore = mockXRay(() => ({
      TraceSummaries: analyzeTraces,
    }));

    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: { region: "us-east-1" },
        definition: {
          id: "test-id",
          name: "aws-traces",
          version: 1,
          tags: {},
        },
      });

      const result = await model.methods.analyze_errors.execute(
        { startTime: "1h" },
        context as unknown as Parameters<
          typeof model.methods.analyze_errors.execute
        >[1],
      );

      assertEquals(result.dataHandles.length, 1);

      const written = getWrittenResources();
      assertEquals(written.length, 1);
      assertEquals(written[0].specName, "error_analysis");

      const data = written[0].data as {
        totalTraces: number;
        faultCount: number;
        errorCount: number;
        throttleCount: number;
        faultRate: number;
        errorRate: number;
        throttleRate: number;
        topFaultyServices: Array<{
          serviceName: string;
          faultCount: number;
        }>;
        topFaultyUrls: Array<{ url: string; faultCount: number }>;
      };

      // Rate calculations: 3 faults, 2 errors, 1 throttle out of 10
      assertEquals(data.totalTraces, 10);
      assertEquals(data.faultCount, 3);
      assertEquals(data.errorCount, 2);
      assertEquals(data.throttleCount, 1);
      assertEquals(data.faultRate, 0.3);
      assertEquals(data.errorRate, 0.2);
      assertEquals(data.throttleRate, 0.1);

      // topFaultyServices: api-gateway appears in fault-001 and fault-002 (2),
      // lambda-function appears in fault-002 and fault-003 (2)
      assertEquals(data.topFaultyServices.length, 2);
      // Both have count 2, sorted by faultCount desc (stable order)
      const serviceNames = data.topFaultyServices.map((s) => s.serviceName);
      assertEquals(serviceNames.includes("api-gateway"), true);
      assertEquals(serviceNames.includes("lambda-function"), true);
      assertEquals(data.topFaultyServices[0].faultCount, 2);
      assertEquals(data.topFaultyServices[1].faultCount, 2);

      // topFaultyUrls: /users appears in fault-001 and fault-003 (2),
      // /orders appears in fault-002 (1)
      assertEquals(data.topFaultyUrls.length, 2);
      assertEquals(data.topFaultyUrls[0].url, "https://api.example.com/users");
      assertEquals(data.topFaultyUrls[0].faultCount, 2);
      assertEquals(
        data.topFaultyUrls[1].url,
        "https://api.example.com/orders",
      );
      assertEquals(data.topFaultyUrls[1].faultCount, 1);
    } finally {
      restore();
    }
  },
);
