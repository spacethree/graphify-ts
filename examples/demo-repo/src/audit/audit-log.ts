export interface AuditEntry {
  actorId: string
  action: string
  occurredAt: string
}

export class AuditLog {
  append(entry: AuditEntry) {
    return `${entry.occurredAt}:${entry.actorId}:${entry.action}`
  }

  listRecentEntries(limit: number) {
    return Array.from({ length: limit }, (_, index) => `entry-${index + 1}`)
  }
}
