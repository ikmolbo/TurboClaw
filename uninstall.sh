#!/bin/bash
# TurboClaw Uninstall Script

set -e

echo "🗑️  Uninstalling TurboClaw..."

# Unlink from bun
echo "📦 Unlinking global command..."
bun unlink 2>/dev/null || echo "   (No global link found)"

echo ""
echo "✅ TurboClaw uninstalled successfully!"
echo ""
echo "Note: This does not delete:"
echo "  - ~/.turboclaw directory (your config and data)"
echo "  - The TurboClaw source code"
echo ""
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
echo "To completely remove TurboClaw:"
echo "  rm -rf ~/.turboclaw        # Delete all data"
echo "  rm -rf $SCRIPT_DIR         # Delete source code"
echo ""
