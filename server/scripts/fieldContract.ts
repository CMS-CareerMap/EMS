import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from 'node:fs'
import { join, relative } from 'node:path'

/**
 * Records every field name the frontend reads, so the API cannot quietly stop
 * sending one.
 *
 *   npm run field-contract
 *
 * The problem this solves is specific. Every change to a serializer is an
 * opportunity to drop a field. The page will not crash — it will render
 * `undefined`, which looks like an empty cell, and nobody notices until the
 * client asks why the designation column is blank.
 *
 * So the field names the UI reads are pinned in one file, and a serializer can
 * be checked against it rather than against somebody's memory.
 *
 * It is a heuristic, not a parser: it looks for snake_case property reads,
 * which in this codebase means a column name coming back from the database.
 * camelCase is deliberately excluded — that is React state and local variables,
 * which are nobody's contract. Over-reporting here is harmless; the file is a
 * checklist, not a test.
 */

const WEB_SRC = join(__dirname, '../../web/src')
const OUT = join(__dirname, '../../docs/field-contract.json')

/** `something.some_field` — the dot rules out string literals and keys. */
const SNAKE_READ = /\.([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b/g

/** `const { full_name, department } = ...` */
const SNAKE_DESTRUCTURE = /\{([^{}]*_[^{}]*)\}\s*=/g

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      walk(full, out)
    } else if (/\.(jsx?|tsx?)$/.test(entry)) {
      out.push(full)
    }
  }
  return out
}

function fieldsIn(source: string): Set<string> {
  const found = new Set<string>()

  for (const match of source.matchAll(SNAKE_READ)) {
    found.add(match[1]!)
  }

  for (const match of source.matchAll(SNAKE_DESTRUCTURE)) {
    for (const part of match[1]!.split(',')) {
      const name = part.split(':')[0]!.trim()
      if (/^[a-z][a-z0-9]*(_[a-z0-9]+)+$/.test(name)) found.add(name)
    }
  }

  return found
}

/**
 * Names that are snake_case but are not data. Without this the contract fills
 * up with DOM and library noise and stops being readable.
 */
const NOT_DATA = new Set([
  'aria_label',
  'data_testid',
  'stroke_width',
  'class_name',
  'font_family',
  'node_modules',
])

function main(): void {
  const files = walk(WEB_SRC).sort()
  const byFile: Record<string, string[]> = {}
  const everywhere = new Set<string>()

  for (const file of files) {
    const fields = [...fieldsIn(readFileSync(file, 'utf8'))]
      .filter((f) => !NOT_DATA.has(f))
      .sort()

    if (fields.length === 0) continue

    const key = relative(join(__dirname, '../..'), file).replace(/\\/g, '/')
    byFile[key] = fields
    for (const f of fields) everywhere.add(f)
  }

  const contract = {
    generatedAt: new Date().toISOString().slice(0, 10),
    note:
      'Field names the frontend reads, pinned so the API cannot quietly stop ' +
      'sending one. A serializer that stops sending one of these will render an empty ' +
      'cell rather than an error, so check new serializers against this list. ' +
      'Regenerate with: cd server && npm run field-contract',
    fieldCount: everywhere.size,
    allFields: [...everywhere].sort(),
    byFile,
  }

  mkdirSync(join(__dirname, '../../docs'), { recursive: true })
  writeFileSync(OUT, JSON.stringify(contract, null, 2) + '\n')

  console.log(`Field contract written: ${everywhere.size} distinct fields across ${Object.keys(byFile).length} files`)
  console.log(OUT)
}

main()
