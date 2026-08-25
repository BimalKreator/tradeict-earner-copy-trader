import { Prisma } from "@prisma/client";
import type { AssertionContext } from "../assert.js";
import type { ScenarioContext } from "../types.js";
import {
  buildFieldExpectations,
  columnMatchesType,
  expectedPgTypes,
  getFieldExpectation,
  type FieldExpectation,
} from "../schemaExpectations.js";

type DbColumn = {
  table_name: string;
  column_name: string;
  is_nullable: string;
  udt_name: string;
  data_type: string;
};

type DbEnumRow = {
  enum_name: string;
  enum_value: string;
};

const SELF_CHECK_COLUMNS: Array<{
  model: string;
  field: string;
  expectNullable: boolean;
}> = [
  { model: "User", field: "id", expectNullable: false },
  { model: "User", field: "email", expectNullable: false },
  { model: "PayoutRequest", field: "completedAt", expectNullable: true },
  { model: "CommissionLedger", field: "amount", expectNullable: false },
  { model: "SystemAlert", field: "resolved", expectNullable: false },
];

async function loadDbColumns(ctx: ScenarioContext): Promise<Map<string, DbColumn>> {
  const rows = await ctx.prisma.$queryRaw<DbColumn[]>`
    SELECT table_name, column_name, is_nullable, udt_name, data_type
    FROM information_schema.columns
    WHERE table_schema = 'public'
  `;
  const map = new Map<string, DbColumn>();
  for (const row of rows) {
    map.set(`${row.table_name}.${row.column_name}`, row);
  }
  return map;
}

async function loadDbEnums(ctx: ScenarioContext): Promise<Map<string, Set<string>>> {
  const rows = await ctx.prisma.$queryRaw<DbEnumRow[]>`
    SELECT t.typname AS enum_name, e.enumlabel AS enum_value
    FROM pg_type t
    JOIN pg_enum e ON t.oid = e.enumtypid
    JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public'
    ORDER BY t.typname, e.enumsortorder
  `;
  const map = new Map<string, Set<string>>();
  for (const row of rows) {
    const set = map.get(row.enum_name) ?? new Set<string>();
    set.add(row.enum_value);
    map.set(row.enum_name, set);
  }
  return map;
}

function runSelfCheck(
  assert: AssertionContext,
  expectations: FieldExpectation[],
  columns: Map<string, DbColumn>,
): void {
  for (const check of SELF_CHECK_COLUMNS) {
    const field = getFieldExpectation(expectations, check.model, check.field);
    if (!field) {
      throw new Error(
        `drift checker is broken: no schema expectation for ${check.model}.${check.field}`,
      );
    }

    const expectedRequired = !check.expectNullable;
    assert.equal(
      field.isRequired,
      expectedRequired,
      `self-check ${check.model}.${check.field} isRequired`,
    );

    const key = `${field.table}.${field.column}`;
    const col = columns.get(key);
    if (!col) {
      throw new Error(
        `drift checker is broken: live column missing for self-check ${key}`,
      );
    }

    const actualNullable = col.is_nullable === "YES";
    assert.equal(
      actualNullable,
      check.expectNullable,
      `self-check ${key} nullability`,
    );

    assert.assert(
      columnMatchesType(field, col),
      `drift checker is broken: type mismatch on self-check ${key}`,
    );
  }
}

function collectDrift(
  expectations: FieldExpectation[],
  columns: Map<string, DbColumn>,
  dbEnums: Map<string, Set<string>>,
): string[] {
  const differences: string[] = [];

  for (const field of expectations) {
    const key = `${field.table}.${field.column}`;
    const col = columns.get(key);

    if (!col) {
      differences.push(`MISSING  ${key}`);
      continue;
    }

    const expectedNullable = !field.isRequired;
    const actualNullable = col.is_nullable === "YES";
    if (expectedNullable !== actualNullable) {
      differences.push(
        `MISMATCH ${key} expected nullable=${expectedNullable} actual nullable=${actualNullable}`,
      );
    }

    if (!columnMatchesType(field, col)) {
      differences.push(
        `MISMATCH ${key} expected type≈${expectedPgTypes(field).join("|")} actual udt=${col.udt_name} data_type=${col.data_type}`,
      );
    }
  }

  for (const enumDef of Prisma.dmmf.datamodel.enums) {
    const dbValues = dbEnums.get(enumDef.name);
    if (!dbValues) {
      differences.push(`MISSING  enum ${enumDef.name}`);
      continue;
    }
    for (const value of enumDef.values) {
      if (!dbValues.has(value.name)) {
        differences.push(`MISSING  enum ${enumDef.name}.${value.name}`);
      }
    }
  }

  return differences;
}

export const schemaDriftScenario = {
  name: "schema-drift",
  async run(ctx: ScenarioContext) {
    const expectations = buildFieldExpectations();
    const columns = await loadDbColumns(ctx);
    const dbEnums = await loadDbEnums(ctx);

    runSelfCheck(ctx.assert, expectations, columns);

    const profitDate = getFieldExpectation(
      expectations,
      "CommissionLedger",
      "profitDate",
    );
    ctx.assert.assert(
      profitDate?.nativeType === "Date",
      "CommissionLedger.profitDate declares @db.Date in schema.prisma",
    );

    const differences = collectDrift(expectations, columns, dbEnums);

    ctx.assert.assert(
      differences.length === 0,
      differences.length > 0
        ? `Schema drift detected (${differences.length}):\n${differences.join("\n")}`
        : "schema matches Prisma schema expectations",
    );
  },
};
