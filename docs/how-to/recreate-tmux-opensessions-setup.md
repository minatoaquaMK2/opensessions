# Recreate This tmux + opensessions Setup

This note captures the local setup used in this workspace so it can be copied to another machine.

## Goal

- opensessions sidebar on the left
- sidebar width set to 30 columns
- tmux window tabs shown in the top status bar
- `Ctrl-s` focuses/opens the opensessions sidebar
- `Ctrl-t` toggles the opensessions sidebar
- `Alt-1` through `Alt-9` switch to opensessions sidebar sessions by visible index

## Prerequisites

- `tmux` 3.4 or newer
- `bun` on `PATH`
- TPM installed at `~/.tmux/plugins/tpm` for third-party tmux plugin management:

  ```bash
  git clone https://github.com/tmux-plugins/tpm ~/.tmux/plugins/tpm
  ```

- Local opensessions checkout at `/home/mystic/eric/opensessions`

## opensessions source

Load opensessions from this repo checkout, not from TPM's remote plugin install path. This matters because this checkout contains local commits that are not in `Ataraxy-Labs/opensessions`.

On another machine, clone or copy this repo first, then replace `/home/mystic/eric/opensessions` everywhere below with that local checkout path.

Do not enable this line in `~/.tmux.conf` when reproducing this setup:

```tmux
set -g @plugin 'Ataraxy-Labs/opensessions'
```

Use this local loader instead:

```tmux
run-shell "/path/to/local/opensessions/opensessions.tmux"
```

## opensessions config

Create or update `~/.config/opensessions/config.json`:

```json
{
  "plugins": [],
  "mux": "tmux",
  "theme": "catppuccin-latte",
  "sidebarWidth": 30,
  "sidebarPosition": "left"
}
```

If your existing config already has other fields, keep them and only set:

```json
{
  "sidebarWidth": 30,
  "sidebarPosition": "left"
}
```

## tmux config

Add this to `~/.tmux.conf`. If your checkout lives somewhere else, replace `/home/mystic/eric/opensessions` with that path. The TPM plugin list below is only for third-party tmux plugins; opensessions itself is loaded from the local `run-shell` line.

```tmux
# List of plugins
set -g @plugin 'tmux-plugins/tpm'
# Use the local checkout instead of the TPM-installed GitHub copy.
# set -g @plugin 'Ataraxy-Labs/opensessions'
set -g @plugin 'tmux-plugins/tmux-sensible'
set -g @plugin 'tmux-plugins/tmux-yank'
set -g @plugin 'tmux-plugins/tmux-resurrect'
set -g @plugin 'tmux-plugins/tmux-continuum'
set -g @plugin 'tmux-plugins/tmux-copycat'
set -g @plugin 'tmux-plugins/tmux-open'

# tmux-yank: send mouse/yank selections to the system clipboard.
set -s set-clipboard on
set -g @override_copy_command '/home/mystic/.tmux/bin/tmux-set-clipboard'
set -g @yank_selection 'clipboard'
set -g @yank_selection_mouse 'clipboard'

# tmux-continuum: restore the last resurrect save on tmux startup.
set -g @continuum-restore 'on'

# Use Ctrl-a as the tmux prefix.
unbind C-b
set -g prefix C-a
bind C-a send-prefix

# General tmux ergonomics.
set -g mouse on
set -g history-limit 100000
setw -g mode-keys vi
set -s escape-time 0
bind r source-file ~/.tmux.conf \; display-message "tmux.conf reloaded"

# Top tab bar, tuned to pair with opensessions.
set -g status on
set -g status-position top
set -g status-justify left
set -g status-interval 2
set -g status-style "bg=#11111b,fg=#cdd6f4"
set -g status-left-length 0
set -g status-left ""
set -g status-right-length 90
set -g status-right "#[fg=#f5c2e7,bg=#313244,bold] #{pane_current_command} #[fg=#a6e3a1,bg=#45475a,bold] #S "

set -g message-style "bg=#313244,fg=#cdd6f4"
set -g mode-style "bg=#89b4fa,fg=#11111b,bold"
set -g pane-border-style "fg=#45475a"
set -g pane-active-border-style "fg=#fab387"

setw -g window-status-separator ""
setw -g window-status-format "#[fg=#11111b,bg=#89b4fa] #I #[fg=#cdd6f4,bg=#1e1e2e] #W "
setw -g window-status-current-format "#[fg=#11111b,bg=#fab387,bold] #I #[fg=#cdd6f4,bg=#313244,bold] #W "
setw -g window-status-activity-style "fg=#f9e2af,bg=#1e1e2e"
setw -g window-status-bell-style "fg=#11111b,bg=#f38ba8,bold"

# Local opensessions checkout.
run-shell "/home/mystic/eric/opensessions/opensessions.tmux"

# Initialize TMUX plugin manager. Keep this line at the very bottom.
run '~/.tmux/plugins/tpm/tpm'
```

Create the clipboard helper used by `tmux-yank`:

```bash
mkdir -p ~/.tmux/bin
cat > ~/.tmux/bin/tmux-set-clipboard <<'SH'
#!/usr/bin/env sh

payload=$(cat)
tmux set-buffer -w -- "$payload"
SH
chmod +x ~/.tmux/bin/tmux-set-clipboard
```

The important part is that `Ataraxy-Labs/opensessions` stays commented out and the local checkout is loaded with `run-shell`.

## Shortcut behavior

With the current opensessions plugin in this workspace, these are registered by `opensessions.tmux`:

```text
Ctrl-s       focus/open sidebar
Ctrl-t       toggle sidebar
Alt-1..9     switch to sidebar session index 1..9
```

The sidebar index is the visible opensessions list order, not the tmux window tab order.

## Older plugin fallback

If another machine uses an older opensessions checkout that does not yet bind `Alt-1` through `Alt-9`, add these fallback lines to `~/.tmux.conf`.

For a local checkout placed at `~/.tmux/plugins/opensessions`:

```tmux
bind-key -n C-s run-shell "sh ~/.tmux/plugins/opensessions/integrations/tmux-plugin/scripts/focus.sh"
bind-key -n C-t run-shell "sh ~/.tmux/plugins/opensessions/integrations/tmux-plugin/scripts/toggle.sh"

bind-key -n M-1 run-shell "sh ~/.tmux/plugins/opensessions/integrations/tmux-plugin/scripts/switch-index.sh 1"
bind-key -n M-2 run-shell "sh ~/.tmux/plugins/opensessions/integrations/tmux-plugin/scripts/switch-index.sh 2"
bind-key -n M-3 run-shell "sh ~/.tmux/plugins/opensessions/integrations/tmux-plugin/scripts/switch-index.sh 3"
bind-key -n M-4 run-shell "sh ~/.tmux/plugins/opensessions/integrations/tmux-plugin/scripts/switch-index.sh 4"
bind-key -n M-5 run-shell "sh ~/.tmux/plugins/opensessions/integrations/tmux-plugin/scripts/switch-index.sh 5"
bind-key -n M-6 run-shell "sh ~/.tmux/plugins/opensessions/integrations/tmux-plugin/scripts/switch-index.sh 6"
bind-key -n M-7 run-shell "sh ~/.tmux/plugins/opensessions/integrations/tmux-plugin/scripts/switch-index.sh 7"
bind-key -n M-8 run-shell "sh ~/.tmux/plugins/opensessions/integrations/tmux-plugin/scripts/switch-index.sh 8"
bind-key -n M-9 run-shell "sh ~/.tmux/plugins/opensessions/integrations/tmux-plugin/scripts/switch-index.sh 9"
```

If opensessions is installed somewhere else, replace `~/.tmux/plugins/opensessions` with that checkout path.

## Install or reload

After editing `~/.tmux.conf`, run:

```bash
tmux source-file ~/.tmux.conf
~/.tmux/plugins/tpm/bin/install_plugins
```

If the plugin is already installed, this is enough:

```bash
tmux source-file ~/.tmux.conf
```

After adding new TPM plugins, run the install command once:

```bash
~/.tmux/plugins/tpm/bin/install_plugins
tmux source-file ~/.tmux.conf
```

## Verify

Check the top bar:

```bash
tmux show-option -g status-position
tmux show-window-option -g window-status-current-format
```

Expected:

```text
status-position top
```

Check opensessions key bindings:

```bash
tmux list-keys -T root | rg "C-s|C-t|M-[1-9].*switch-index"
```

You should see `C-s`, `C-t`, and `M-1` through `M-9`. You should not see `C-1` through `C-9` for opensessions.

Check tmux plugin bindings and clipboard helper:

```bash
tmux list-keys -T prefix C-s
tmux list-keys -T prefix C-r
tmux list-keys -T copy-mode-vi y
printf 'clipboard test' | ~/.tmux/bin/tmux-set-clipboard
tmux show-buffer
```

Expected:

```text
prefix C-s saves the tmux environment
prefix C-r restores the tmux environment
copy-mode-vi y pipes through ~/.tmux/bin/tmux-set-clipboard
clipboard test
```

## Terminal caveats

If `Ctrl-s` appears to freeze terminal output, disable XON/XOFF flow control:

```bash
stty -ixon
```
