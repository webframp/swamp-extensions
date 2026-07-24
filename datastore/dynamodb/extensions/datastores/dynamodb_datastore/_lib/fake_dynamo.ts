// ABOUTME: Minimal in-memory DynamoDB simulator for tests — supports the
// ABOUTME: subset of Put/Update/Delete/Get/Query/BatchWrite/DescribeTable this
// ABOUTME: extension actually issues, including gsi1 and conditional expressions.

export class ConditionalCheckFailedError extends Error {
  override name = "ConditionalCheckFailedException";
}

export class ResourceNotFoundError extends Error {
  override name = "ResourceNotFoundException";
}

// deno-lint-ignore no-explicit-any
type Item = Record<string, any>;

function itemKey(pk: string, sk: string): string {
  return `${pk} ${sk}`;
}

/** Resolves ExpressionAttributeValues/Names against a template string for the
 * tiny subset of condition/update expressions this extension actually sends. */
function evalCondition(
  expr: string | undefined,
  item: Item | undefined,
  values: Record<string, unknown> = {},
): boolean {
  if (!expr) return true;
  if (expr === "attribute_not_exists(pk) OR expiresAtMs < :now") {
    return !item || (item.expiresAtMs as number) < (values[":now"] as number);
  }
  if (expr === "nonce = :nonce") {
    return !!item && item.nonce === values[":nonce"];
  }
  throw new Error(`fake_dynamo: unsupported ConditionExpression: ${expr}`);
}

export class FakeDynamoTable {
  items = new Map<string, Item>();
  tableStatus: "ACTIVE" | "MISSING" = "ACTIVE";
  /** Caps items-per-page in query() to exercise the real pagination loops
   * (queryAllFileMeta/fetchChunks) in sync.ts against ExclusiveStartKey/
   * LastEvaluatedKey — defaults high enough that most tests see one page. */
  queryPageSize = 1_000;

  private applyUpdate(existing: Item | undefined, params: Item): Item {
    // Only supports the one UpdateExpression shape this extension issues.
    const values = params.ExpressionAttributeValues ?? {};
    const next: Item = { ...(existing ?? params.Key) };
    next.acquiredAt = values[":at"];
    next.acquiredAtMs = values[":atMs"];
    next.expiresAtMs = values[":exp"];
    next.ttl = values[":ttlVal"];
    return next;
  }

  send(command: { constructor: { name: string }; input: Item }): unknown {
    const name = command.constructor.name;
    const params = command.input;

    if (this.tableStatus === "MISSING" && name !== "DescribeTableCommand") {
      throw new ResourceNotFoundError("Table not found");
    }

    switch (name) {
      case "PutCommand": {
        const { pk, sk } = params.Item;
        const key = itemKey(pk, sk);
        const existing = this.items.get(key);
        if (
          !evalCondition(
            params.ConditionExpression,
            existing,
            params.ExpressionAttributeValues,
          )
        ) {
          throw new ConditionalCheckFailedError("Conditional check failed");
        }
        this.items.set(key, { ...params.Item });
        return {};
      }
      case "UpdateCommand": {
        const { pk, sk } = params.Key;
        const key = itemKey(pk, sk);
        const existing = this.items.get(key);
        if (
          !evalCondition(
            params.ConditionExpression,
            existing,
            params.ExpressionAttributeValues,
          )
        ) {
          throw new ConditionalCheckFailedError("Conditional check failed");
        }
        // Handle ADD expression for StringSet (partition registry)
        const updateExpr = params.UpdateExpression as string | undefined;
        if (updateExpr?.startsWith("ADD ")) {
          const values = params.ExpressionAttributeValues ?? {};
          const next: Item = existing ? { ...existing } : { pk, sk };
          const match = updateExpr.match(/^ADD (\w+) :(\w+)$/);
          if (match) {
            const attr = match[1];
            const valKey = `:${match[2]}`;
            const toAdd = values[valKey] as Set<string>;
            const current = next[attr] instanceof Set
              ? next[attr] as Set<string>
              : new Set<string>(
                Array.isArray(next[attr]) ? next[attr] as string[] : [],
              );
            for (const v of toAdd) current.add(v);
            next[attr] = current;
          }
          this.items.set(key, next);
          return {};
        }
        this.items.set(key, this.applyUpdate(existing, params));
        return {};
      }
      case "DeleteCommand": {
        const { pk, sk } = params.Key;
        const key = itemKey(pk, sk);
        const existing = this.items.get(key);
        if (
          !evalCondition(
            params.ConditionExpression,
            existing,
            params.ExpressionAttributeValues,
          )
        ) {
          throw new ConditionalCheckFailedError("Conditional check failed");
        }
        this.items.delete(key);
        return {};
      }
      case "GetCommand": {
        const { pk, sk } = params.Key;
        const item = this.items.get(itemKey(pk, sk));
        return { Item: item ? { ...item } : undefined };
      }
      case "QueryCommand": {
        return this.query(params);
      }
      case "BatchWriteCommand": {
        for (const [, requests] of Object.entries(params.RequestItems)) {
          for (const req of requests as Item[]) {
            if (req.PutRequest) {
              const { pk, sk } = req.PutRequest.Item;
              this.items.set(itemKey(pk, sk), { ...req.PutRequest.Item });
            } else if (req.DeleteRequest) {
              const { pk, sk } = req.DeleteRequest.Key;
              this.items.delete(itemKey(pk, sk));
            }
          }
        }
        return {};
      }
      case "BatchGetCommand": {
        const responses: Record<string, Item[]> = {};
        for (const [table, request] of Object.entries(params.RequestItems)) {
          const items: Item[] = [];
          const keys = (request as Item).Keys as Item[];
          for (const key of keys) {
            const item = this.items.get(itemKey(key.pk, key.sk));
            if (item) items.push({ ...item });
          }
          responses[table] = items;
        }
        return { Responses: responses, UnprocessedKeys: {} };
      }
      default:
        throw new Error(`fake_dynamo: unsupported command ${name}`);
    }
  }

  private query(
    params: Item,
  ): { Items: Item[]; LastEvaluatedKey?: Item } {
    const values = params.ExpressionAttributeValues ?? {};
    let candidates = [...this.items.values()];

    if (params.IndexName) {
      candidates = candidates.filter((it) => it.gsi1pk === values[":fp"]);
      if (values[":prefix"] !== undefined) {
        candidates = candidates.filter((it) =>
          (it.gsi1sk as string).startsWith(values[":prefix"] as string)
        );
      } else if (values[":since"] !== undefined) {
        // Range condition: gsi1sk > :since
        candidates = candidates.filter((it) =>
          (it.gsi1sk as string) > (values[":since"] as string)
        );
      }
      candidates.sort((a, b) => (a.gsi1sk as string).localeCompare(b.gsi1sk));
    } else {
      candidates = candidates.filter((it) => it.pk === values[":pk"]);
      if (values[":prefix"] !== undefined) {
        candidates = candidates.filter((it) =>
          (it.sk as string).startsWith(values[":prefix"] as string)
        );
      } else if (values[":sk"] !== undefined) {
        candidates = candidates.filter((it) => it.sk === values[":sk"]);
      }
      candidates.sort((a, b) => (a.sk as string).localeCompare(b.sk));
    }

    const exclusiveStartKey = params.ExclusiveStartKey as Item | undefined;
    let startIndex = 0;
    if (exclusiveStartKey) {
      const idx = candidates.findIndex(
        (it) =>
          it.pk === exclusiveStartKey.pk && it.sk === exclusiveStartKey.sk,
      );
      // If the resume-point item was deleted since the last page, resume from
      // the first item that still sorts after it (real DynamoDB has the same
      // "item may no longer exist" caveat for ExclusiveStartKey).
      startIndex = idx === -1 ? candidates.length : idx + 1;
    }

    const page = candidates.slice(startIndex, startIndex + this.queryPageSize);
    const hasMore = startIndex + page.length < candidates.length;
    const last = page[page.length - 1];
    return {
      Items: page.map((it) => ({ ...it })),
      LastEvaluatedKey: hasMore && last
        ? { pk: last.pk, sk: last.sk, gsi1pk: last.gsi1pk, gsi1sk: last.gsi1sk }
        : undefined,
    };
  }

  describeTable(): Item {
    if (this.tableStatus === "MISSING") {
      throw new ResourceNotFoundError("Table not found");
    }
    return {
      Table: {
        TableName: "test-table",
        TableStatus: "ACTIVE",
        BillingModeSummary: { BillingMode: "PAY_PER_REQUEST" },
        ItemCount: this.items.size,
      },
    };
  }
}

/** Patches DynamoDBDocumentClient.prototype.send + DynamoDBClient.prototype.send
 * to dispatch to a FakeDynamoTable. Returns a restore function. */
export function installFakeDynamo(
  DocumentClientClass: { prototype: { send: unknown } },
  BaseClientClass: { prototype: { send: unknown } },
  table: FakeDynamoTable,
): () => void {
  const originalDocSend = DocumentClientClass.prototype.send;
  const originalBaseSend = BaseClientClass.prototype.send;

  // deno-lint-ignore no-explicit-any
  DocumentClientClass.prototype.send = function (command: any) {
    return Promise.resolve(table.send(command));
  };
  // deno-lint-ignore no-explicit-any
  BaseClientClass.prototype.send = function (command: any) {
    const name = command.constructor.name;
    if (name === "DescribeTableCommand") {
      return Promise.resolve(table.describeTable());
    }
    return Promise.resolve(table.send(command));
  };

  return () => {
    DocumentClientClass.prototype.send = originalDocSend;
    BaseClientClass.prototype.send = originalBaseSend;
  };
}
