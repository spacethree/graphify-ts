export type SupportTier = 'standard' | 'priority'

export function assignEscalationTier(openInvoices: number): SupportTier {
  return openInvoices > 3 ? 'priority' : 'standard'
}
