import { extractPdfArrayText, extractPdfTextOperations } from '../../src/pipeline/extract/non-code/pdf.js'

describe('non-code pdf helpers', () => {
  it('extracts text from pdf operators and arrays', () => {
    expect(extractPdfArrayText('(Intro) 120 (Section)')).toBe('Intro Section')
    expect(extractPdfTextOperations('BT (Hello) Tj ET\n[(Intro) 120 (Section)] TJ')).toEqual(['Hello', 'Intro Section'])
  })
})
