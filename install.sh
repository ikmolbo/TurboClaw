#!/bin/bash
# TurboClaw Installation Script
# This script installs turboclaw globally so you can run it from anywhere

set -e

echo "🚀 Installing TurboClaw..."

# Check if bun is installed, install if missing
if ! command -v bun &> /dev/null; then
    echo "📦 Bun not found, installing..."
    curl -fsSL https://bun.sh/install | bash
    # Source the shell config so bun is available in this session
    export BUN_INSTALL="$HOME/.bun"
    export PATH="$BUN_INSTALL/bin:$PATH"
    if ! command -v bun &> /dev/null; then
        echo "❌ Failed to install Bun. Please install manually: https://bun.sh"
        exit 1
    fi
    echo "✅ Bun installed"
fi

# Check if tmux is installed, install if missing
if ! command -v tmux &> /dev/null; then
    echo "📦 tmux not found, installing..."
    if command -v brew &> /dev/null; then
        brew install tmux
    elif command -v apt-get &> /dev/null; then
        sudo apt-get install -y tmux
    else
        echo "⚠️  Please install tmux manually"
    fi
fi

# Get the script directory
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

# Install dependencies
echo "📦 Installing dependencies..."
cd "$SCRIPT_DIR"
bun install

# Make bin executable
echo "🔧 Setting up executable..."
chmod +x "$SCRIPT_DIR/bin/turboclaw"

# Install globally using bun
echo "🌍 Installing globally..."
bun unlink 2>/dev/null || true
bun link

echo ""
echo "✅ TurboClaw installed successfully!"
echo ""

# Run setup wizard directly (turboclaw command won't be available until new shell)
echo "🎯 Starting setup wizard..."
echo ""
bun run "$SCRIPT_DIR/src/cli/index.ts" setup

echo ""
echo "Installation complete! 🎉"
echo ""
echo "You can now run 'turboclaw' from anywhere (in a new terminal)."
echo ""
