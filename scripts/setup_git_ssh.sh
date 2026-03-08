#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/setup_git_ssh.sh [options]

Options:
  --email EMAIL         Email/comment written into the SSH public key.
  --key-path PATH       Private key path. Default: auto-detect existing key, otherwise ~/.ssh/<host>_ed25519
  --host HOST           Git server hostname. Default: github.com
  --host-alias ALIAS    SSH host alias written into ~/.ssh/config. Default: same as --host
  --user USER           SSH username. Default: git
  --no-repo-config      Do not set git core.sshCommand in the current repository.
  -h, --help            Show this help message.

Examples:
  scripts/setup_git_ssh.sh --host github.com --email you@example.com
  scripts/setup_git_ssh.sh --host gitlab.com --key-path ~/.ssh/key
EOF
}

EMAIL=""
KEY_PATH=""
HOST_NAME="github.com"
HOST_ALIAS=""
SSH_USER="git"
CONFIGURE_REPO=1

sanitize_name() {
  printf '%s' "$1" | tr -c 'A-Za-z0-9._-' '_'
}

resolve_default_key_path() {
  local sanitized_host fallback candidate
  sanitized_host="$(sanitize_name "${HOST_ALIAS:-${HOST_NAME}}")"
  fallback="${HOME}/.ssh/${sanitized_host}_ed25519"
  local candidates=(
    "${HOME}/.ssh/key"
    "${HOME}/.ssh/id_ed25519"
    "${HOME}/.ssh/id_rsa"
    "${fallback}"
  )
  for candidate in "${candidates[@]}"; do
    if [[ -f "${candidate}" ]]; then
      printf '%s\n' "${candidate}"
      return 0
    fi
  done
  printf '%s\n' "${fallback}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --email)
      EMAIL="${2:-}"
      shift 2
      ;;
    --key-path)
      KEY_PATH="${2:-}"
      shift 2
      ;;
    --host)
      HOST_NAME="${2:-}"
      shift 2
      ;;
    --host-alias)
      HOST_ALIAS="${2:-}"
      shift 2
      ;;
    --user)
      SSH_USER="${2:-}"
      shift 2
      ;;
    --no-repo-config)
      CONFIGURE_REPO=0
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ -z "${HOST_ALIAS}" ]]; then
  HOST_ALIAS="${HOST_NAME}"
fi

mkdir -p "${HOME}/.ssh"
chmod 700 "${HOME}/.ssh"

if [[ -z "${KEY_PATH}" ]]; then
  KEY_PATH="$(resolve_default_key_path)"
fi

if [[ -z "${EMAIL}" ]]; then
  EMAIL="$(git config --get user.email 2>/dev/null || true)"
fi

if [[ -z "${EMAIL}" ]]; then
  EMAIL="git-ssh"
fi

if [[ ! -f "${KEY_PATH}" ]]; then
  ssh-keygen -t ed25519 -C "${EMAIL}" -f "${KEY_PATH}" -N ""
else
  echo "SSH key already exists: ${KEY_PATH}"
fi

chmod 600 "${KEY_PATH}"

if [[ ! -f "${KEY_PATH}.pub" ]]; then
  ssh-keygen -y -f "${KEY_PATH}" > "${KEY_PATH}.pub"
fi

chmod 644 "${KEY_PATH}.pub"

SSH_CONFIG="${HOME}/.ssh/config"
touch "${SSH_CONFIG}"
chmod 600 "${SSH_CONFIG}"

CONFIG_MARKER_BEGIN="# >>> git-ssh setup ${HOST_ALIAS} >>>"
CONFIG_MARKER_END="# <<< git-ssh setup ${HOST_ALIAS} <<<"
TMP_CONFIG="$(mktemp)"
awk -v begin="${CONFIG_MARKER_BEGIN}" -v end="${CONFIG_MARKER_END}" '
  $0 == begin { skip = 1; next }
  $0 == end { skip = 0; next }
  !skip { print }
' "${SSH_CONFIG}" > "${TMP_CONFIG}"
mv "${TMP_CONFIG}" "${SSH_CONFIG}"

{
  echo "${CONFIG_MARKER_BEGIN}"
  echo "Host ${HOST_ALIAS}"
  echo "  HostName ${HOST_NAME}"
  echo "  User ${SSH_USER}"
  echo "  IdentityFile ${KEY_PATH}"
  echo "  IdentitiesOnly yes"
  echo "${CONFIG_MARKER_END}"
} >> "${SSH_CONFIG}"

KNOWN_HOSTS="${HOME}/.ssh/known_hosts"
touch "${KNOWN_HOSTS}"
chmod 600 "${KNOWN_HOSTS}"

if ! ssh-keygen -F "${HOST_NAME}" -f "${KNOWN_HOSTS}" >/dev/null 2>&1; then
  ssh-keyscan -H "${HOST_NAME}" >> "${KNOWN_HOSTS}" 2>/dev/null
fi

if [[ "${CONFIGURE_REPO}" -eq 1 ]] && git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git config core.sshCommand "ssh -i ${KEY_PATH} -o IdentitiesOnly=yes"
fi

echo
echo "Public key:"
cat "${KEY_PATH}.pub"
echo
case "${HOST_NAME}" in
  github.com)
    echo "Add this key to GitHub:"
    echo "https://github.com/settings/keys"
    ;;
  gitlab.com)
    echo "Add this key to GitLab:"
    echo "https://gitlab.com/-/user_settings/ssh_keys"
    ;;
  *)
    echo "Add this key to your git provider's SSH keys page."
    ;;
esac
echo
echo "Test command:"
echo "ssh -T -i ${KEY_PATH} -o IdentitiesOnly=yes ${SSH_USER}@${HOST_NAME}"
