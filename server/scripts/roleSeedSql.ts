import { DEFAULT_ROLES } from '../src/platform/authz/defaultRoles'

/**
 * Prints the SQL of `ems_seed_default_roles` — the function the database
 * trigger runs to give every new company its built-in roles — from
 * defaultRoles.ts.
 *
 *   npx tsx scripts/roleSeedSql.ts > role-seed.sql
 *
 * Changing a default is: change defaultRoles.ts, run this, paste the output
 * into a new migration (with whatever UPDATE brings existing companies' rows
 * along). roles.test.ts fails if a new company's roles ever differ from the
 * file, so a default changed in one place only cannot go unnoticed.
 */

const quote = (value: string) => `'${value.replace(/'/g, "''")}'`
const idOf = (key: string) => `id_${key}`

const declarations = DEFAULT_ROLES.map((r) => `  ${idOf(r.key)} TEXT := gen_random_uuid()::text;`).join('\n')
const rows = DEFAULT_ROLES.map((r) => {
  const permissions = `ARRAY[${r.permissions.map(quote).join(', ')}]::text[]`
  const scopes = `${quote(JSON.stringify(r.scopes))}::jsonb`
  const parent = r.parentKey ? idOf(r.parentKey) : 'NULL'
  return `    (${idOf(r.key)}, org_id, ${quote(r.key)}, ${quote(r.name)}, ${quote(r.description)}, ${parent}, true, ${r.locked}, ${permissions}, ${scopes}, now())`
}).join(',\n')

process.stdout.write(`CREATE OR REPLACE FUNCTION ems_seed_default_roles(org_id TEXT) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
${declarations}
BEGIN
  INSERT INTO "Role" ("id", "organizationId", "key", "name", "description", "parentId", "builtIn", "locked", "permissions", "scopes", "updatedAt") VALUES
${rows};
END
$$;
`)
