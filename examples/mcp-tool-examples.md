# MCP Tool Examples

These examples show what your AI agent sees when it calls graphify-ts MCP tools. All output is real data from a production codebase.

## retrieve — Context Retrieval

**Agent calls:**
```json
{ "name": "retrieve", "arguments": { "question": "how does payment processing work?", "budget": 2000 } }
```

**Agent receives:**
```json
{
  "question": "how does payment processing work?",
  "token_count": 1847,
  "matched_nodes": [
    {
      "label": "StripeGatewayService",
      "source_file": "backend/src/modules/billing/services/stripe-gateway.service.ts",
      "line_number": 15,
      "snippet": "export class StripeGatewayService implements PaymentGateway {\n  constructor(private config: ConfigService) {}\n  async createCheckout(params: CheckoutParams) {...}",
      "match_score": 3,
      "community_label": "Backend Billing"
    },
    {
      "label": "TransactionService",
      "source_file": "backend/src/modules/billing/services/transaction.service.ts",
      "match_score": 2,
      "community_label": "Backend Transaction"
    }
  ],
  "relationships": [
    { "from": "StripeGatewayService", "to": "TransactionService", "relation": "calls" },
    { "from": "TransactionService", "to": "User", "relation": "uses" }
  ],
  "community_context": [
    { "id": 8, "label": "Backend Billing", "node_count": 23 },
    { "id": 12, "label": "Backend Transaction", "node_count": 12 }
  ],
  "graph_signals": {
    "god_nodes": ["User"],
    "bridge_nodes": ["StripeGatewayService"]
  }
}
```

**What the agent does with this:** Answers the question using code evidence, citing specific services and their relationships. No file reading needed.

---

## impact — Blast Radius Analysis

**Agent calls:**
```json
{ "name": "impact", "arguments": { "label": "User", "depth": 2 } }
```

**Agent receives:**
```json
{
  "target": "User",
  "target_file": "backend/src/entities/User.ts",
  "total_affected": 656,
  "direct_dependents": [
    { "label": "AuthGuard", "distance": 1, "relation": "imports_from", "community_label": "Backend Admin Guard" },
    { "label": "UsersService", "distance": 1, "relation": "imports_from", "community_label": "Backend Users Service" }
  ],
  "affected_files": ["admin.guard.ts", "auth.module.ts", "...318 files"],
  "affected_communities": [
    { "id": 0, "label": "Backend Invite", "node_count": 11 },
    { "id": 1, "label": "Backend Admin Guard", "node_count": 8 }
  ]
}
```

**What the agent does with this:** "Refactoring User touches 656 nodes across 318 files and 42 modules. The highest-impact areas are Invite (11 files), Admin Guard (8 files), and Users core (4 files). I recommend an incremental approach."

---

## call_chain — Execution Path Tracing

**Agent calls:**
```json
{ "name": "call_chain", "arguments": { "source": "IdeasController", "target": "PdfGeneratorService" } }
```

**Agent receives:**
```json
{
  "source": "IdeasController",
  "target": "PdfGeneratorService",
  "chains": [
    ["IdeasController", "IdeasService", "GenerationJobsService", "AssemblyService", "PdfGeneratorService"],
    ["IdeasController", "IdeasService", "LangchainOrchestratorService", "AssemblyService", "PdfGeneratorService"]
  ],
  "total": 2
}
```

**What the agent does with this:** "There are 2 execution paths from idea submission to PDF generation. The primary path goes through IdeasService → GenerationJobsService → AssemblyService → PdfGeneratorService. An alternative path uses the LangchainOrchestratorService."

---

## pr_impact — PR Risk Analysis

**Agent calls:**
```json
{ "name": "pr_impact", "arguments": {} }
```

**Agent receives:**
```json
{
  "base_branch": "main",
  "changed_files": ["src/entities/User.ts", "src/modules/auth/auth.service.ts"],
  "changed_ranges": [
    { "source_file": "src/entities/User.ts", "line_ranges": [{ "start": 42, "end": 48 }] },
    { "source_file": "src/modules/auth/auth.service.ts", "line_ranges": [{ "start": 10, "end": 18 }] }
  ],
  "seed_nodes": [
    { "node_id": "user_entity", "label": "User", "community_label": "Backend User", "match_kind": "line" },
    { "node_id": "auth_service", "label": "AuthService", "community_label": "Backend Auth", "match_kind": "line" }
  ],
  "review_context": {
    "supporting_paths": ["src/modules/users/user.repository.ts"],
    "test_paths": ["tests/auth/auth.service.test.ts"],
    "hotspots": [{ "label": "User", "type": "bridge", "why": "User connects multiple communities in the changed review area." }]
  },
  "review_bundle": {
    "budget": 2000,
    "token_count": 512,
    "shared_file_type": "code",
    "nodes": [
      { "node_id": "user_entity", "label": "User", "source_file": "src/entities/User.ts", "line_number": 42, "snippet": "export class User {}", "match_score": 9, "relevance_band": "direct", "community": 7 },
      { "label": "UserRepository", "source_file": "src/modules/users/user.repository.ts", "line_number": 15, "snippet": null, "relevance_band": "related", "community": 8 }
    ],
    "relationships": [
      { "from": "UserRepository", "to": "User", "relation": "uses" }
    ],
    "community_context": [
      { "id": 7, "label": "Backend User", "node_count": 24 }
    ]
  },
  "per_node_impact": [
    { "node": "User", "total_dependents": 656, "affected_communities": 42 },
    { "node": "AuthService", "total_dependents": 57, "affected_communities": 8 }
  ],
  "total_blast_radius": 634,
  "affected_communities": [
    { "id": 7, "label": "Backend User", "node_count": 24 },
    { "id": 8, "label": "Backend Auth", "node_count": 18 }
  ],
  "risk_summary": {
    "high_impact_nodes": ["User", "AuthService"],
    "cross_community_changes": 2,
    "top_risks": [
      { "label": "User", "severity": "high", "reason": "High blast radius across 42 communities." }
    ]
  }
}
```

**What the agent does with this:** "This PR changes 2 line-matched high-impact nodes. The compact review bundle already points at the key supporting file and likely auth test, and `User` is flagged as a bridge hotspot with the largest blast radius. I'd review the user repository path first, then run the auth service tests before merging."

---

## community_details — Module Intelligence

**Agent calls (micro zoom — 50 tokens):**
```json
{ "name": "community_overview", "arguments": {} }
```

**Agent receives:** All 2,244 communities with names, sizes, and top 3 nodes each.

**Agent calls (mid zoom — 200 tokens):**
```json
{ "name": "community_details", "arguments": { "community_id": 8, "zoom": "mid" } }
```

**Agent receives:** Entry points, exit points, bridge nodes, key functions, and dominant file for the Billing community.

**Agent calls (macro zoom — 500 tokens):**
```json
{ "name": "community_details", "arguments": { "community_id": 8, "zoom": "macro" } }
```

**Agent receives:** All nodes, all internal edges, all cross-community edges, and file distribution.

The agent picks the right zoom level based on how much context budget it has left.
