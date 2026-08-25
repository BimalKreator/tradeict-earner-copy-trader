import { readFileSync } from "fs";
import { join } from "path";
import { Prisma } from "@prisma/client";

/** Scalar field expectations merged from Prisma DMMF + schema.prisma attributes. */
export type FieldExpectation = {
  model: string;
  table: string;
  field: string;
  column: string;
  kind: "scalar" | "enum";
  type: string;
  isRequired: boolean;
  nativeType: string | null;
  nativeTypeArgs: string[];
};

type ParsedFieldAttrs = {
  optional: boolean;
  dbName: string | null;
  nativeType: string | null;
  nativeTypeArgs: string[];
};

function loadSchemaText(): string {
  return readFileSync(join(process.cwd(), "prisma", "schema.prisma"), "utf8");
}

function parseModelBlocks(schema: string): Map<string, string> {
  const models = new Map<string, string>();
  const re = /^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(schema)) !== null) {
    models.set(match[1]!, match[2]!);
  }
  return models;
}

function parseTableMap(schema: string): Map<string, string> {
  const map = new Map<string, string>();
  const re = /^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(schema)) !== null) {
    const modelName = match[1]!;
    const body = match[2]!;
    const mapMatch = body.match(/@@map\("([^"]+)"\)/);
    map.set(modelName, mapMatch?.[1] ?? modelName);
  }
  return map;
}

function findFieldLine(modelBody: string, fieldName: string): string | undefined {
  return modelBody
    .split("\n")
    .find((line) => {
      const trimmed = line.trim();
      return (
        trimmed.startsWith(`${fieldName} `) ||
        trimmed.startsWith(`${fieldName}\t`)
      );
    });
}

function parseScalarFieldAttributes(line: string): ParsedFieldAttrs {
  const trimmed = line.trim();
  const typeMatch = trimmed.match(/^(\w+)\s+(\S+)/);
  const typeToken = typeMatch?.[2] ?? "";
  const optional = typeToken.endsWith("?");
  const mapMatch = trimmed.match(/@map\("([^"]+)"\)/);
  const nativeMatch = trimmed.match(/@db\.(\w+)(?:\(([^)]*)\))?/);
  const nativeTypeArgs =
    nativeMatch?.[2]
      ?.split(",")
      .map((part) => part.trim())
      .filter(Boolean) ?? [];

  return {
    optional,
    dbName: mapMatch?.[1] ?? null,
    nativeType: nativeMatch?.[1] ?? null,
    nativeTypeArgs,
  };
}

/** Build expectations Prisma 7's runtime DMMF cannot supply (isRequired, nativeType). */
export function buildFieldExpectations(): FieldExpectation[] {
  const schema = loadSchemaText();
  const modelBlocks = parseModelBlocks(schema);
  const tableMap = parseTableMap(schema);
  const expectations: FieldExpectation[] = [];

  for (const model of Prisma.dmmf.datamodel.models) {
    const body = modelBlocks.get(model.name);
    if (!body) continue;

    const table = tableMap.get(model.name) ?? model.dbName ?? model.name;

    for (const field of model.fields) {
      if (field.kind !== "scalar" && field.kind !== "enum") continue;

      const line = findFieldLine(body, field.name);
      if (!line) continue;

      const attrs = parseScalarFieldAttributes(line);
      expectations.push({
        model: model.name,
        table,
        field: field.name,
        column: attrs.dbName ?? field.dbName ?? field.name,
        kind: field.kind,
        type: field.type,
        isRequired: !attrs.optional,
        nativeType: attrs.nativeType,
        nativeTypeArgs: attrs.nativeTypeArgs,
      });
    }
  }

  return expectations;
}

export function getFieldExpectation(
  expectations: FieldExpectation[],
  model: string,
  field: string,
): FieldExpectation | undefined {
  return expectations.find((row) => row.model === model && row.field === field);
}

export function expectedPgTypes(field: FieldExpectation): string[] {
  if (field.kind === "enum") {
    return [field.type];
  }

  switch (field.nativeType) {
    case "Date":
      return ["date"];
    case "Text":
      return ["text"];
    case "Decimal":
      return ["numeric"];
    case "Timestamp":
      return [
        "timestamp",
        "timestamptz",
        "timestamp without time zone",
        "timestamp with time zone",
      ];
    default:
      break;
  }

  switch (field.type) {
    case "String":
      return ["text", "varchar", "character varying", "uuid", "bpchar"];
    case "Int":
      return ["int4", "integer"];
    case "Float":
      return ["float8", "double precision", "real"];
    case "Boolean":
      return ["bool", "boolean"];
    case "DateTime":
      return [
        "timestamp",
        "timestamptz",
        "timestamp without time zone",
        "timestamp with time zone",
      ];
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

export function columnMatchesType(
  field: FieldExpectation,
  col: { udt_name: string; data_type: string },
): boolean {
  if (field.kind === "enum") {
    return col.udt_name === field.type;
  }

  const allowed = expectedPgTypes(field);
  const actual = col.udt_name.toLowerCase();
  const dataType = col.data_type.toLowerCase();

  return allowed.some((expected) => {
    const norm = expected.toLowerCase();
    return (
      actual === norm ||
      dataType === norm ||
      actual.includes(norm) ||
      dataType.includes(norm)
    );
  });
}
