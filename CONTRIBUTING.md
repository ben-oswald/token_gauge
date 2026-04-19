# Contributing

Thanks for considering a contribution!

## License of contributions

This project is licensed under the **AGPL-3.0-or-later**. By submitting a pull
request you agree that your contribution is licensed under the same terms.

### What you may submit

Only submit contributions that are compatible with **AGPL-3.0-or-later**. You
must also have the right to submit them, including when code is copied,
adapted, AI-assisted, employer-owned, or otherwise not entirely your own work.

## Development setup

1. Clone the repo into your extensions directory (or symlink it):
   ```
   ln -s "$PWD" ~/.local/share/gnome-shell/extensions/token_gauge@oswald.dev
   ```
2. Compile the schema after any change to `schemas/*.gschema.xml`:
   ```
   glib-compile-schemas schemas/
   ```
3. Restart GNOME Shell (X11: `Alt+F2`, then `r`; Wayland: log out and back in).
4. Tail the logs:
   ```
   journalctl -f -o cat /usr/bin/gnome-shell
   ```

## Before opening a PR

- Run `./build.sh` and make sure it succeeds (this also runs `shexli`).
- Keep the AGPL copyright header on new source files.
- Update `CHANGELOG.md` under an `## [Unreleased]` section.
