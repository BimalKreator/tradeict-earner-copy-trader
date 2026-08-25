import type { PrismaClient } from "@prisma/client";
import type { AssertionContext } from "./assert.js";
import type { TestFixtureFactory } from "./fixtures.js";

export type HarnessScenario = {
  readonly name: string;
  run(ctx: ScenarioContext): Promise<void>;
};

export type ScenarioContext = {
  prisma: PrismaClient;
  assert: AssertionContext;
  fixtures: TestFixtureFactory;
};

export type ScenarioResult = {
  name: string;
  passed: boolean;
  assertionCount: number;
  durationMs: number;
  error: string | null;
};
