#!/bin/bash
# Quick benchmark script — run this in any project to see graphify-ts in action
#
# Usage:
#   cd your-project
#   bash path/to/quick-benchmark.sh

set -e

echo "=== graphify-ts Quick Benchmark ==="
echo ""

if [ -z "${GRAPHIFY_RUNNER:-}" ]; then
  echo "Set GRAPHIFY_RUNNER to a prompt runner command template first, for example:"
  echo "  export GRAPHIFY_RUNNER='cat {prompt_file} | claude -p'"
  echo "  export GRAPHIFY_RUNNER='cat {prompt_file} | gemini -p \"\" --output-format json'"
  exit 1
fi

# Check if graphify-ts is installed
if ! command -v graphify-ts &> /dev/null; then
  echo "Installing graphify-ts..."
  npm install -g @mohammednagy/graphify-ts
fi

# Generate graph
echo "Step 1: Generating knowledge graph..."
graphify-ts generate .
echo ""

# Run benchmark
echo "Step 2: Running token reduction benchmark..."
graphify-ts benchmark graphify-out/graph.json --exec "$GRAPHIFY_RUNNER" --yes
echo ""

# Show key stats
echo "Step 3: Graph summary..."
echo ""
head -20 graphify-out/GRAPH_REPORT.md
echo ""

# Set up MCP for your agent
echo "Step 4: Setting up AI agent integration..."
echo ""
echo "Run one of these to connect your agent:"
echo "  graphify-ts claude install    # Claude Code (.mcp.json)"
echo "  graphify-ts cursor install    # Cursor (.cursor/mcp.json)"
echo "  graphify-ts copilot install   # Copilot (.vscode/mcp.json)"
echo ""
echo "Then ask your agent:"
echo '  "What is the blast radius of changing [YourMainEntity]?"'
echo '  "How does [feature X] work?"'
echo '  "Is this PR safe to merge?"'
echo ""
echo "=== Done ==="
