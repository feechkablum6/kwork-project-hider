#!/bin/sh
# Устанавливает мост, который сохраняет переписки и заказы Kwork на диск.
# Запуск: двойной клик в Finder или ./install.command [папка переписок] [папка заказов]

# Finder запускает файл с системным PATH, поэтому Node из Homebrew добавляется вручную.
PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
cd "$(dirname "$0")" || exit 1

node scripts/install-bridge.mjs "$@"
