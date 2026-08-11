#!/usr/bin/env sh
set -eu

host_key=/var/run/secrets/t4-ssh-host-key/ssh_host_ed25519_key
authorized_keys=/var/run/secrets/t4-ssh-authorized-keys/authorized_keys
config=/run/sshd/sshd_config

validate_secret_file() {
  resolved_root=$(readlink -f -- "$1") || exit 78
  resolved_file=$(readlink -f -- "$2") || exit 78
  test -d "$resolved_root" || exit 78
  case "$resolved_file" in
    "$resolved_root"/*) ;;
    *) exit 78 ;;
  esac
  test -f "$resolved_file" || exit 78
}

validate_secret_file /var/run/secrets/t4-ssh-host-key "$host_key"
validate_secret_file /var/run/secrets/t4-ssh-authorized-keys "$authorized_keys"

test "$(stat -c '%u' "$host_key")" = 0
test "$(stat -c '%a' "$host_key")" = 400
test "$(stat -c '%u' "$authorized_keys")" = 0
case "$(stat -c '%a' "$authorized_keys")" in
  400|440|444) ;;
  *) exit 78 ;;
esac

test -s "$host_key"
test -s "$authorized_keys"
test "$(wc -c < "$host_key")" -le 16384
test "$(wc -c < "$authorized_keys")" -le 1048576

cp /etc/ssh/sshd_config_t4 "$config"
trusted_ca=/var/run/secrets/t4-ssh-trusted-ca/ca.pub
principals=/var/run/secrets/t4-ssh-principals/authorized_principals
if test -e "$trusted_ca" || test -e "$principals"; then
  validate_secret_file /var/run/secrets/t4-ssh-trusted-ca "$trusted_ca"
  validate_secret_file /var/run/secrets/t4-ssh-principals "$principals"
  test "$(stat -c '%u' "$trusted_ca")" = 0
  test "$(stat -c '%u' "$principals")" = 0
  case "$(stat -c '%a' "$trusted_ca")" in 400|440|444) ;; *) exit 78 ;; esac
  case "$(stat -c '%a' "$principals")" in 400|440|444) ;; *) exit 78 ;; esac
  printf '%s\n' \
    "TrustedUserCAKeys $trusted_ca" \
    "AuthorizedPrincipalsFile $principals" \
    >> "$config"
fi

/usr/sbin/sshd -t -f "$config"
exec /usr/sbin/sshd -D -e -f "$config"
