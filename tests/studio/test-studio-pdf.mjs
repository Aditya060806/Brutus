/**
 * Renders the review PDF for every seeded sample record and asserts the bytes
 * are a real, non-trivial PDF.
 *
 * The PDF is the artefact a reviewer actually opens, and `pdf-lib`'s standard
 * fonts throw on any character outside WinAnsi — so the failure mode this guards
 * is an export that works on clean input and dies the moment a model emits an em
 * dash or an emoji. Each sample is therefore also rendered with hostile text
 * pushed through every field.
 */
import assert from 'node:assert'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const here = path.dirname(fileURLToPath(import.meta.url))
const bundle = path.join(here, 'pdf.test.cjs')

let passed = 0
let failed = 0
const ok = (name, fn) => {
  try {
    fn()
    console.log(`  \u2713 ${name}`)
    passed++
  } catch (err) {
    console.log(`  \u2717 ${name}`)
    console.log(`      ${err.message}`)
    failed++
  }
}

const { buildPacketPdf, sampleRecords } = require(bundle)
const { PDFDocument } = require('pdf-lib')
const SAMPLE_RECORDS = sampleRecords(Date.parse('2026-08-08T10:00:00Z'))

const run = async () => {
  console.log('\nstudio / review pdf\n')

  assert.ok(SAMPLE_RECORDS.length >= 1, 'expected at least one sample record')

  for (const record of SAMPLE_RECORDS) {
    const bytes = await buildPacketPdf(record, new Date('2026-08-08T10:00:00Z'))

    ok(`${record.id} renders bytes`, () => {
      assert.ok(bytes instanceof Uint8Array, 'expected a Uint8Array')
      assert.ok(bytes.length > 2000, `expected a real document, got ${bytes.length} bytes`)
    })

    ok(`${record.id} is a valid PDF header and trailer`, () => {
      const head = Buffer.from(bytes.slice(0, 5)).toString('latin1')
      assert.strictEqual(head, '%PDF-', `bad header: ${head}`)
      const tail = Buffer.from(bytes.slice(-1024)).toString('latin1')
      assert.ok(tail.includes('%%EOF'), 'missing %%EOF trailer')
    })

    /**
     * Read the document back rather than grepping the bytes: pdf-lib compresses
     * its metadata streams, so the brand is not greppable in the raw output.
     *
     * `updateMetadata: false` matters here too — `load` defaults to rewriting
     * Producer and Creator with pdf-lib's own, which meant an earlier version of
     * this assertion was corrupting the very thing it was checking.
     */
    const reloaded = await PDFDocument.load(bytes, { updateMetadata: false })

    ok(`${record.id} is branded in its metadata`, () => {
      assert.strictEqual(reloaded.getProducer(), 'BRUTUS Studio')
      assert.strictEqual(reloaded.getCreator(), 'BRUTUS Studio')
      assert.ok(
        (reloaded.getTitle() ?? '').startsWith('Brutus agent task review'),
        `unexpected title: ${reloaded.getTitle()}`
      )
    })

    ok(`${record.id} is A4 and paginated`, () => {
      const pages = reloaded.getPages()
      assert.ok(pages.length >= 1, 'expected at least one page')
      const { width, height } = pages[0].getSize()
      assert.ok(Math.abs(width - 595.28) < 1, `expected A4 width, got ${width}`)
      assert.ok(Math.abs(height - 841.89) < 1, `expected A4 height, got ${height}`)
    })
  }

  // Hostile input: the characters a model actually emits.
  const nasty = {
    ...SAMPLE_RECORDS[0],
    task: 'Ship \u2014 "the thing" \u2026 caf\u00e9 \u2705 \ud83d\ude80 \u2018quoted\u2019',
    summary: 'Em\u2014dash \u2013 en\u2013dash \u201ccurly\u201d \ud83c\udf89',
    notes: 'Tabs\there and a very long unbroken token: ' + 'a'.repeat(400),
    sections: SAMPLE_RECORDS[0].sections.map((s) => ({
      ...s,
      output: 'Unicode \u2192 arrow, emoji \ud83d\udd25, and ' + 'x'.repeat(600)
    }))
  }

  let hostileBytes
  try {
    hostileBytes = await buildPacketPdf(nasty, new Date())
    console.log('  \u2713 hostile unicode and long tokens render without throwing')
    passed++
  } catch (err) {
    console.log('  \u2717 hostile unicode and long tokens render without throwing')
    console.log(`      ${err.message}`)
    failed++
  }

  ok('the hostile render is still a valid PDF', () => {
    assert.ok(hostileBytes && hostileBytes.length > 2000, 'expected bytes')
    assert.strictEqual(Buffer.from(hostileBytes.slice(0, 5)).toString('latin1'), '%PDF-')
  })

  ok('a sample record is stamped as a sample', () => {
    const sample = SAMPLE_RECORDS.find((r) => r.sample)
    assert.ok(sample, 'expected at least one record flagged sample: true')
  })

  console.log(`\n${passed} passed, ${failed} failed\n`)
  if (failed) process.exit(1)
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
