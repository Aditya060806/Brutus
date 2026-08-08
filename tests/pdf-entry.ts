/**
 * Bundle entry for the PDF review packet.
 *
 * The test renders a real document for every seeded sample, so it needs the
 * renderer and the samples in one bundle. Kept as an entry rather than two
 * bundles because asserting "every sample renders" is the point — a sample the
 * exporter cannot draw is a broken demo, and that is exactly the pairing this
 * couples together.
 */
export { buildPacketPdf } from '../src/main/services/studio/packet-pdf'
export { sampleRecords } from '../src/main/services/studio/record-seeds'
