#!/bin/bash

# Math Tutor - LaTeX Environment Setup Script
# This script configures BasicTeX for Manim usage

echo "🔧 Setting up LaTeX environment for Manim..."

# 1. Check/Configure PATH
if [[ ":$PATH:" != *":/Library/TeX/texbin:"* ]]; then
    echo "Adding /Library/TeX/texbin to PATH for this session..."
    export PATH=$PATH:/Library/TeX/texbin
fi

# 2. Check tlmgr
if ! command -v tlmgr &> /dev/null; then
    echo "❌ Error: 'tlmgr' (TeX Live Manager) not found."
    echo "It seems BasicTeX is installed but not in your PATH."
    echo ""
    echo "Please add this line to your ~/.zshrc or ~/.bash_profile:"
    echo 'export PATH="$PATH:/Library/TeX/texbin"'
    echo ""
    echo "Then restart your terminal and run this script again."
    exit 1
fi

echo "✅ Found tlmgr at $(which tlmgr)"

# 3. Install Packages
echo "📦 Installing required packages (Sudo password may be required)..."
echo "   Packages: standalone, preview, dvisvgm, collection-fontsrecommended"

sudo tlmgr update --self
sudo tlmgr install standalone preview dvisvgm collection-fontsrecommended

# 4. Verification
echo "🔍 Verifying installation..."
if command -v dvisvgm &> /dev/null; then
    echo "✅ dvisvgm installed successfully!"
    echo "🎉 LaTeX environment is ready for Manim!"
    echo ""
    echo "Don't forget to set MANIM_USE_LATEX=true in your .env file."
    echo "And ensure '/Library/TeX/texbin' is in your PATH when running the backend."
else
    echo "❌ Error: dvisvgm installation failed."
    exit 1
fi
