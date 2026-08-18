#!/bin/bash
# Install formiga — from local checkout or from GitHub.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/PJarbas/formiga/main/scripts/install.sh | bash
#   ./scripts/install.sh                             # run from repo root
#   ./scripts/install.sh --local /path/to/formiga   # explicit local path
set -euo pipefail

echo "Installing Formiga..."

LOCAL_SOURCE=""
if [ "${1:-}" = "--local" ]; then
  LOCAL_SOURCE="${2:-$(pwd)}"
fi

REPO="PJarbas/formiga"
BRANCH="main"

if [ -n "$LOCAL_SOURCE" ]; then
  # --- Local install from source checkout ---
  if [ ! -f "$LOCAL_SOURCE/package.json" ]; then
    echo "Error: $LOCAL_SOURCE doesn't look like a formiga checkout (no package.json)"
    exit 1
  fi
  REPO_DIR="$LOCAL_SOURCE"
  echo "Using local source: $REPO_DIR"
else
  # --- Remote install (clone from GitHub) ---
  INSTALL_DIR="${HOME}/.formiga/repo"

  if [ -d "$INSTALL_DIR" ]; then
    echo "Updating existing installation..."
    cd "$INSTALL_DIR"
    git fetch origin
    git reset --hard "origin/$BRANCH"
  else
    echo "Cloning repository..."
    git clone --depth 1 --branch "$BRANCH" "https://github.com/${REPO}.git" "$INSTALL_DIR"
    cd "$INSTALL_DIR"
  fi
  REPO_DIR="$INSTALL_DIR"
fi

cd "$REPO_DIR"

# Check Node.js version
NODE_VERSION=$(node -v 2>/dev/null | sed 's/v//' | cut -d. -f1)
if [ -z "$NODE_VERSION" ] || [ "$NODE_VERSION" -lt 22 ]; then
  echo "Error: Node.js >= 22 required. Current: $(node -v 2>/dev/null || echo 'not found')"
  exit 1
fi

# Install and build
echo "Installing dependencies..."
npm install
echo "Building..."
npm run build

# Create symlink
mkdir -p "$HOME/.local/bin"
ln -sf "$REPO_DIR/bin/formiga" "$HOME/.local/bin/formiga"
chmod +x "$HOME/.local/bin/formiga"

# Install bundled workflows
set +e
"$HOME/.local/bin/formiga" workflow install --all 2>&1
WF_INSTALL_EXIT=$?
set -e

# Make ~/.local/bin available on PATH (idempotent, best-effort — never fails the install)
ensure_path() {
  case ":$PATH:" in
    *":$HOME/.local/bin:"*) return 0 ;;
  esac
  local rc
  case "${SHELL:-}" in
    *zsh) rc="$HOME/.zshrc" ;;
    *bash) rc="$HOME/.bashrc" ;;
    *) rc="$HOME/.profile" ;;
  esac
  if [ ! -e "$rc" ] || [ -w "$rc" ]; then
    printf '\n# added by the formiga installer\nexport PATH="$HOME/.local/bin:$PATH"\n' >> "$rc" 2>/dev/null && \
      echo "Added ~/.local/bin to your PATH in $rc (run: source $rc)"
  fi
  return 0
}
ensure_path

echo ""
echo "Formiga installed successfully!"
if [ $WF_INSTALL_EXIT -ne 0 ]; then
  echo "Warning: workflow installation failed (exit $WF_INSTALL_EXIT)"
fi
echo ""
echo "Make sure ~/.local/bin is in your PATH if not already."
echo ""
echo "Next steps:"
echo "  formiga dashboard start             # live dashboard at http://localhost:3334"
echo "  formiga autoresearch \"dataset_path=data.csv target_column=target\""
echo "  formiga workflow run <name> \"your task\""
