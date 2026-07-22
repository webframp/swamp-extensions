// ABOUTME: DynamoDBDocumentClient factory — wires region/endpoint config onto
// ABOUTME: the AWS SDK's default credential provider chain.

import { DynamoDBClient } from "npm:@aws-sdk/client-dynamodb@3.1091.0";
import { DynamoDBDocumentClient } from "npm:@aws-sdk/lib-dynamodb@3.1091.0";

export interface ClientConfig {
  region: string;
  endpoint?: string;
}

export interface Clients {
  /** Low-level client — used for control-plane calls (DescribeTable, CreateTable). */
  base: DynamoDBClient;
  /** Document client — used for item-level calls (Get/Put/Update/Delete/Query/BatchWrite). */
  doc: DynamoDBDocumentClient;
}

export function createClients(config: ClientConfig): Clients {
  const base = new DynamoDBClient({
    region: config.region,
    ...(config.endpoint ? { endpoint: config.endpoint } : {}),
  });
  return { base, doc: DynamoDBDocumentClient.from(base) };
}
