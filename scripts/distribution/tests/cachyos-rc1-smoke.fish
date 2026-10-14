# Run in fish from the normal CachyOS graphical session.
# First cancel active QA and stop the existing Sentry normally.
# Place the exact selected RC archive in ~/Downloads, then source this file.

function prepare_sentry_rc1
    cd "$HOME/Downloads"; or return 1
    set -l archive sentry-1.0.0-rc.1-8a75e9924a41-cachyos-x64.tar.gz
    set -l expected 8d906885c10c6fe9be2892f0dff6797e7236c5f85cec18c219f043f7262e75a8
    printf '%s  %s\n' "$expected" "$archive" | sha256sum --check -; or return 1

    set -g sentry_rc1_root (mktemp -d "$HOME/sentry-rc1-smoke.XXXXXX"); or return 1
    tar -xzf "$archive" -C "$sentry_rc1_root"; or return 1
    mkdir -p "$sentry_rc1_root/home/.config" "$sentry_rc1_root/home/.local/share"; or return 1

    function sentry_rc1_env
        set -l pnpm_bin "$sentry_rc1_root/home/.local/share/sentry/pnpm/node_modules/.bin"
        set -l rc_path (string join : "$pnpm_bin" $PATH)
        env -u ELECTRON_RUN_AS_NODE \
            -u OPENROUTER_API_KEY -u OPENCODE_API_KEY -u DEEPSEEK_API_KEY \
            -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_BASE_URL \
            HOME="$sentry_rc1_root/home" \
            XDG_CONFIG_HOME="$sentry_rc1_root/home/.config" \
            XDG_DATA_HOME="$sentry_rc1_root/home/.local/share" \
            PATH="$rc_path" \
            SENTRY_DATA_ROOT="$sentry_rc1_root/home/data" \
            SENTRY_RUNTIME_ENTRY="$sentry_rc1_root/home/.local/share/sentry/runtime/current/apps/runtime/dist/host.js" \
            $argv
    end

    function sentry_rc1
        if test (count $argv) -gt 0; and test "$argv[1]" = open
            if not test -f "$sentry_rc1_root/home/.local/share/sentry/runtime/current/apps/runtime/dist/host.js"
                echo 'Runtime setup is incomplete. Run sentry_rc1 setup successfully before open.' >&2
                return 1
            end
        end
        sentry_rc1_env "$sentry_rc1_root/sentry-1.0.0-rc.1-8a75e9924a41-cachyos-x64/sentry" $argv
    end

    sentry_rc1 version; or return 1
    if not type -q npm
        echo 'Linux npm is required to provision pnpm 9.12.3 inside the test directory.' >&2
        return 1
    end
    sentry_rc1_env npm install --prefix "$sentry_rc1_root/home/.local/share/sentry/pnpm" --no-audit --no-fund pnpm@9.12.3; or return 1
    set -l actual_pin (sentry_rc1_env pnpm --version)
    if test "$actual_pin" != 9.12.3
        echo 'Pinned pnpm 9.12.3 verification failed; setup was not started.' >&2
        return 1
    end
    sentry_rc1 setup; or return 1
    sentry_rc1 open; or return 1
    printf '\nRC test directory: %s\n' "$sentry_rc1_root"
    echo 'In this terminal: sentry_rc1 status / doctor / stop / open'
    echo 'Expected version 1.0.0-rc.1; protocol 1; source 8a75e9924a41b98351e46255111fdbfed335f1f0.'
end

prepare_sentry_rc1
