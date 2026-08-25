import { Prisma } from "@prisma/client";
import type { HarnessScenario, ScenarioContext } from "../types.js";

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

function tableNameForModel(modelName: string, dbName?: string | null): string {
  return dbName ?? modelName;
}

function isScalarField(field: (typeof Prisma.dmmf.datamodel.models)[0]["fields"][0]): boolean {
  return field.kind === "scalar" || field.kind === "enum";
}

function expectedPgTypes(field: (typeof Prisma.dmmf.datamodel.models)[0]["fields"][0]): string[] {
  if (field.kind === "enum") {
    return [field.type];
  }

  const native = field.nativeType?.[0];
  if (native === "Date") {
    return ["date"];
  }

  switch (field.type) {
    case "String":
      return ["text", "varchar", "character varying", "uuid"];
    case "Int":
      return ["int4", "integer"];
    case "Float":
      return ["float8", "double precision", "real"];
    case "Boolean":
      return ["bool", "boolean"];
    case "DateTime":
      return ["timestamp", "timestamptz", "timestamp without time zone", "timestamp with time zone"];
    case "Decimal":
      return ["numeric"];
    case "Json":
      return ["json", "jsonb"];
    case "BigInt":
      return ["int8", "bigint"];
    default:
      return [field.type.toLowerCase()];
  }
}

function columnMatches(field: (typeof Prisma.dmmf.datamodel.models)[0]["fields"][0], col: DbColumn): boolean {
  if (field.kind === "enum") {
    return col.udt_name === field.type;
  }

  const allowed = expectedPgTypes(field);
  const actual = col.udt_name.toLowerCase();
  const dataType = col.data_type.toLowerCase();
  return allowed.some(
    (t) =>
      actual === t.toLowerCase() ||
      dataType === t.toLowerCase() ||
      actual.includes(t.toLowerCase()),
  );
}

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

export const schemaDriftScenario: HarnessScenario = {
  name: "schema-drift",
  async run(ctx) {
    const differences: string[] = [];
    const columns = await loadDbColumns(ctx);
    const dbEnums = await loadDbEnums(ctx);

    for (const model of Prisma.dmmf.datamodel.models) {
      const table = tableNameForModel(model.name, model.dbName);
      for (const field of model.fields) {
        if (!isScalarField(field)) continue;

        const columnName = field.dbName ?? field.name;
        const key = `${table}.${columnName}`;
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

        if (!columnMatches(field, col)) {
          differences.push(
            `MISMATCH ${key} expected type≈${expectedPgTypes(field).join("|")} actual udt=${col.udt_name} data_type=${col.data_type}`,
          );
        }
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

    ctx.assert.assert(
      differences.length === 0,
      differences.length > 0
        ? `Schema drift detected (${differences.length}):\n${differences.join("\n")}`
        : "schema matches Prisma DMMF",
    );
  },
};
