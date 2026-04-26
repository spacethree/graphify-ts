import { decodeXmlText, extractDocxParagraphText } from '../../src/pipeline/extract/non-code/document.js'

describe('non-code document helpers', () => {
  it('decodes xml entities and docx paragraph text', () => {
    expect(decodeXmlText('Hello &amp; goodbye')).toBe('Hello & goodbye')
    expect(extractDocxParagraphText('<w:p><w:r><w:t>Hello</w:t></w:r><w:r><w:t> world</w:t></w:r></w:p>')).toBe('Hello world')
  })
})
