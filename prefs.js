/* prefs.js
 *
 * Copyright (C) 2026 Benjamin Oswald <info@oswald.dev>
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Gdk from 'gi://Gdk';
import Gtk from 'gi://Gtk';
import Adw from 'gi://Adw';
import Secret from 'gi://Secret';
import Soup from 'gi://Soup';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {soupGetJson} from './lib/http.js';

const SECRET_SCHEMA = Secret.Schema.new(
    'dev.oswald.token_gauge',
    Secret.SchemaFlags.NONE,
    {
        'type': Secret.SchemaAttributeType.STRING,
    }
);

const PROVIDER_REGISTRY = {
    'zai': {
        name: 'Z.ai',
        description: 'AI coding assistant quotas',
        credentialSources: ['kilo', 'opencode', 'api_key'],
        credentialSourceLabels: {'kilo': 'Kilo CLI', 'opencode': 'OpenCode', 'api_key': 'API Key'},
        quotas: [
            {id: 'zai-5h', name: '5 Hours Quota'},
            {id: 'zai-weekly', name: 'Weekly Quota'},
            {id: 'zai-monthly', name: 'Monthly Web Search'},
        ],
    },
    'copilot': {
        name: 'Copilot',
        description: 'GitHub Copilot premium request quota',
        credentialSources: ['kilo'],
        credentialSourceLabels: {'kilo': 'Kilo CLI'},
        quotas: [
            {id: 'copilot-premium', name: 'Premium Requests'},
        ],
    },
};

// All known provider IDs — derived from the registry so adding a new
// provider requires only one edit.
const ALL_PROVIDER_IDS = Object.keys(PROVIDER_REGISTRY);

var TokenGaugePrefsWidget = GObject.registerClass(
class TokenGaugePrefsWidget extends Adw.PreferencesPage {
    _init(settings) {
        super._init();
        this._settings = settings;
        this._settingsSignals = [];

        this._providersGroup = new Adw.PreferencesGroup({
            title: _('Providers'),
            description: _('Enable and configure your AI service providers. Drag to reorder.'),
        });
        this.add(this._providersGroup);

        this._providerExpanders = {};
        this._providerCredSourceRows = {};

        for (const pid of this._getProviderOrder()) {
            const provider = PROVIDER_REGISTRY[pid];
            this._buildProviderExpander(this._providersGroup, pid, provider);
        }

        this._credSourcesGroup = new Adw.PreferencesGroup({
            title: _('Credential Sources'),
            description: _('Paths to auth.json files for credential auto-detection'),
        });
        this.add(this._credSourcesGroup);

        this._kiloPathRow = new Adw.EntryRow({
            title: _('Kilo CLI (default: ~/.local/share/kilo/auth.json)'),
            show_apply_button: true,
            text: this._settings.get_string('kilo-credentials-path'),
        });
        this._kiloPathRow.connect('apply', () => {
            this._settings.set_string('kilo-credentials-path', this._kiloPathRow.text);
        });
        this._credSourcesGroup.add(this._kiloPathRow);

        this._opencodePathRow = new Adw.EntryRow({
            title: _('OpenCode (default: ~/.local/share/opencode/auth.json)'),
            show_apply_button: true,
            text: this._settings.get_string('opencode-credentials-path'),
        });
        this._opencodePathRow.connect('apply', () => {
            this._settings.set_string('opencode-credentials-path', this._opencodePathRow.text);
        });
        this._credSourcesGroup.add(this._opencodePathRow);

        const displayGroup = new Adw.PreferencesGroup({
            title: _('Display'),
        });
        this.add(displayGroup);

        this._refreshIntervals = [
            {label: _('1 minute'), value: 1},
            {label: _('2 minutes'), value: 2},
            {label: _('5 minutes'), value: 5},
            {label: _('10 minutes'), value: 10},
            {label: _('60 minutes'), value: 60},
        ];

        const refreshRow = new Adw.ComboRow({
            title: _('Refresh Interval'),
            model: this._createStringModel(this._refreshIntervals.map(i => i.label)),
            selected: this._refreshIntervals.findIndex(
                i => i.value === this._settings.get_int('refresh-interval')
            ),
        });
        refreshRow.connect('notify::selected', () => {
            const selected = this._refreshIntervals[refreshRow.selected];
            if (selected) {
                this._settings.set_int('refresh-interval', selected.value);
            }
        });
        displayGroup.add(refreshRow);

        this._primaryQuotaRow = new Adw.ComboRow({
            title: _('Primary Quota'),
            subtitle: _('Which quota to show in the panel indicator'),
        });
        this._rebuildPrimaryQuotaModel();
        this._primaryQuotaRow.connect('notify::selected', () => {
            const options = this._getCurrentQuotaOptions();
            const selected = options[this._primaryQuotaRow.selected];
            if (selected) {
                this._settings.set_string('primary-quota-id', selected.id);
            }
        });
        displayGroup.add(this._primaryQuotaRow);

        const notificationsGroup = new Adw.PreferencesGroup({
            title: _('Notifications'),
            description: _('Desktop notifications for low token quotas'),
        });
        this.add(notificationsGroup);

        const notifyEnabledRow = new Adw.SwitchRow({
            title: _('Low Quota Notifications'),
            subtitle: _('Notify when a quota drops below 25%, 20%, 10%, or 5%'),
            active: this._settings.get_boolean('notifications-enabled'),
        });
        notifyEnabledRow.connect('notify::active', () => {
            this._settings.set_boolean('notifications-enabled', notifyEnabledRow.active);
        });
        notificationsGroup.add(notifyEnabledRow);

        this._statusLabel = new Gtk.Label({
            label: '',
            wrap: true,
            margin_top: 8,
            margin_bottom: 8,
        });

        this._updateCredSourcesGroupVisibility();
        this._connectSetting('changed::enabled-providers', () => {
            this._updateCredSourcesGroupVisibility();
            this._rebuildPrimaryQuotaModel();
        });
        this._connectSetting('changed::provider-order', () => {
            this._rebuildPrimaryQuotaModel();
        });
        this._connectSetting('changed::zai-credential-source', () => {
            this._updateCredSourcesGroupVisibility();
        });
        this._connectSetting('changed::copilot-credential-source', () => {
            this._updateCredSourcesGroupVisibility();
        });

        this._updateMoveActionSensitivity();
    }

    _connectSetting(signal, callback) {
        const id = this._settings.connect(signal, callback);
        this._settingsSignals.push(id);
    }

    /**
     * Read provider-order from GSettings, ensuring all known providers
     * are present and unknown ones are filtered out.
     */
    _getProviderOrder() {
        const stored = this._settings.get_strv('provider-order');
        const known = Object.keys(PROVIDER_REGISTRY);
        const order = stored.filter(pid => known.includes(pid));

        // Append any known providers missing from the stored order
        for (const pid of ALL_PROVIDER_IDS) {
            if (!order.includes(pid)) order.push(pid);
        }

        return order;
    }

    /**
     * Move sourcePid to the position currently occupied by targetPid
     * (insert before target).
     */
    _reorderProvider(sourcePid, targetPid) {
        const order = this._getProviderOrder();
        const sourceIdx = order.indexOf(sourcePid);
        const targetIdx = order.indexOf(targetPid);
        if (sourceIdx < 0 || targetIdx < 0 || sourceIdx === targetIdx) return;

        // Remove source from current position
        order.splice(sourceIdx, 1);
        // Find target's new index after removal
        const newTargetIdx = order.indexOf(targetPid);
        // Insert before target
        order.splice(newTargetIdx, 0, sourcePid);

        this._settings.set_strv('provider-order', order);
        this._rebuildProviderGroup();
        this._updateMoveActionSensitivity();
    }

    /**
     * Remove all provider ExpanderRows from the group and re-add them
     * in the current provider-order. Reuses existing widget instances,
     * preserving all state (expanded, switch, credentials, DnD controllers).
     */
    _rebuildProviderGroup() {
        const order = this._getProviderOrder();

        // Remove all provider expanders from the group
        for (const pid of Object.keys(this._providerExpanders)) {
            this._providersGroup.remove(this._providerExpanders[pid]);
        }

        // Re-add in the new order
        for (const pid of order) {
            const expander = this._providerExpanders[pid];
            if (expander) {
                this._providersGroup.add(expander);
            }
        }
    }

    /**
     * Move a provider up or down by one position via direct array swap.
     * Used by the menu button actions (Move Up / Move Down).
     * @param {string} pid - provider ID to move
     * @param {number} direction - -1 for up, +1 for down
     */
    _moveProvider(pid, direction) {
        const order = this._getProviderOrder();
        const idx = order.indexOf(pid);
        const targetIdx = idx + direction;
        if (idx < 0 || targetIdx < 0 || targetIdx >= order.length) return;

        [order[idx], order[targetIdx]] = [order[targetIdx], order[idx]];
        this._settings.set_strv('provider-order', order);
        this._rebuildProviderGroup();
        this._updateMoveActionSensitivity();
    }

    /**
     * Update Move Up / Move Down action sensitivity based on current
     * position: first row disables Move Up, last row disables Move Down.
     */
    _updateMoveActionSensitivity() {
        const order = this._getProviderOrder();
        const lastIdx = order.length - 1;

        for (let i = 0; i <= lastIdx; i++) {
            const expander = this._providerExpanders[order[i]];
            if (!expander) continue;

            if (expander._moveUpAction)
                expander._moveUpAction.enabled = i > 0;
            if (expander._moveDownAction)
                expander._moveDownAction.enabled = i < lastIdx;
        }
    }

    _buildProviderExpander(group, pid, provider) {
        const enabledProviders = this._settings.get_strv('enabled-providers');
        const isEnabled = enabledProviders.includes(pid);

        const expander = new Adw.ExpanderRow({
            title: provider.name,
            subtitle: provider.description,
            show_enable_switch: true,
            enable_expansion: isEnabled,
        });
        group.add(expander);
        this._providerExpanders[pid] = expander;

        const dragHandle = new Gtk.Image({
            icon_name: 'list-drag-handle-symbolic',
            css_classes: ['dim-label'],
        });
        expander.add_prefix(dragHandle);

        // ── Drag-and-drop for reordering ──────────────────────────────
        // DragSource on the handle only — prevents accidental drags from
        // the enable switch or expand chevron.
        const dragSource = new Gtk.DragSource({
            actions: Gdk.DragAction.MOVE,
        });
        // Capture the press coordinates (in dragHandle's local coordinate
        // space) so the drag hotspot can be positioned exactly under the
        // cursor on the full-row drag image.
        let pressX = 0;
        let pressY = 0;
        dragSource.connect('prepare', (_source, x, y) => {
            pressX = x;
            pressY = y;
            return Gdk.ContentProvider.new_for_value(pid);
        });
        dragSource.connect('drag-begin', (_source, drag) => {
            // Take a ONE-TIME static snapshot of the row. A live
            // Gtk.WidgetPaintable keeps re-measuring/re-rendering the widget
            // during the drag, which can make the drag image grow and drift
            // toward the upper-left of the cursor as it moves. A static
            // paintable has a fixed intrinsic size, so the hotspot stays
            // accurate for the duration of the drag.
            const snapshot = new Gtk.Snapshot();
            expander.vfunc_snapshot(snapshot);
            const paintable = snapshot.to_paintable(null);

            // Translate the press point from the drag handle's local
            // coordinates into the expander's (= paintable's) coordinate
            // space so the cursor sits exactly where the user clicked.
            let hotX = 0;
            let hotY = 0;
            const [ok, tx, ty] = dragHandle.translate_coordinates(
                expander, pressX, pressY);
            if (ok) {
                hotX = Math.round(tx);
                hotY = Math.round(ty);
            }

            if (paintable)
                Gtk.DragIcon.set_from_paintable(drag, paintable, hotX, hotY);

            // Dim the source row while it's in transit.
            expander.add_css_class('dimmed');
        });
        const clearDimmed = () => expander.remove_css_class('dimmed');
        dragSource.connect('drag-end', clearDimmed);
        dragSource.connect('drag-cancel', () => {
            clearDimmed();
            return false;
        });
        dragHandle.add_controller(dragSource);

        const dropTarget = Gtk.DropTarget.new(GObject.TYPE_STRING, Gdk.DragAction.MOVE);
        dropTarget.connect('drop', (_target, sourcePid) => {
            if (sourcePid === pid) return false;
            this._reorderProvider(sourcePid, pid);
            return true;
        });
        expander.add_controller(dropTarget);

        const moveUpAction = new Gio.SimpleAction({name: 'move-up'});
        moveUpAction.connect('activate', () => {
            this._moveProvider(pid, -1);
        });
        const moveDownAction = new Gio.SimpleAction({name: 'move-down'});
        moveDownAction.connect('activate', () => {
            this._moveProvider(pid, 1);
        });

        const actionGroup = new Gio.SimpleActionGroup();
        actionGroup.add_action(moveUpAction);
        actionGroup.add_action(moveDownAction);
        expander.insert_action_group('row', actionGroup);

        const menu = new Gio.Menu();
        menu.append(_('Move Up'), 'row.move-up');
        menu.append(_('Move Down'), 'row.move-down');

        const menuButton = new Gtk.MenuButton({
            icon_name: 'view-more-symbolic',
            menu_model: menu,
            css_classes: ['flat'],
            valign: Gtk.Align.CENTER,
        });
        expander.add_suffix(menuButton);

        expander._moveUpAction = moveUpAction;
        expander._moveDownAction = moveDownAction;

        expander.connect('notify::enable-expansion', () => {
            const current = this._settings.get_strv('enabled-providers');
            const enabled = expander.enable_expansion;

            if (enabled && !current.includes(pid)) {
                this._settings.set_strv('enabled-providers', [...current, pid]);
            } else if (!enabled && current.includes(pid)) {
                this._settings.set_strv('enabled-providers',
                    current.filter(p => p !== pid));
            }
        });

        const credKey = `${pid}-credential-source`;
        const sources = provider.credentialSources;
        const sourceLabels = sources.map(s => provider.credentialSourceLabels[s]);
        const currentSource = this._settings.get_string(credKey);
        const sourceIndex = sources.indexOf(currentSource);

        const credSourceRow = new Adw.ComboRow({
            title: _('Credential Source'),
            model: this._createStringModel(sourceLabels),
            selected: sourceIndex >= 0 ? sourceIndex : 0,
        });
        credSourceRow.connect('notify::selected', () => {
            const selectedSource = sources[credSourceRow.selected];
            if (selectedSource) {
                this._settings.set_string(credKey, selectedSource);
                this._updateProviderCredentialUI(pid, selectedSource);
            }
        });
        expander.add_row(credSourceRow);
        this._providerCredSourceRows[pid] = credSourceRow;

        this._buildCredentialUI(expander, pid, provider, currentSource);
    }

    /**
     * Build the credential UI rows for a provider based on its credential source.
     * These rows are dynamically shown/hidden when the credential source changes.
     */
    _buildCredentialUI(expander, pid, provider, currentSource) {
        const kiloInfoRow = new Adw.ActionRow({
            title: _('Info'),
            subtitle: _('Reading credentials from Kilo CLI auth.json'),
        });
        kiloInfoRow.add_prefix(new Gtk.Image({
            icon_name: 'dialog-information-symbolic',
            valign: Gtk.Align.CENTER,
        }));
        expander.add_row(kiloInfoRow);

        const opencodeInfoRow = new Adw.ActionRow({
            title: _('Info'),
            subtitle: _('Reading credentials from OpenCode auth.json'),
        });
        opencodeInfoRow.add_prefix(new Gtk.Image({
            icon_name: 'dialog-information-symbolic',
            valign: Gtk.Align.CENTER,
        }));
        expander.add_row(opencodeInfoRow);

        let apiKeyRow = null;
        let saveRow = null;
        let testRow = null;
        let removeRow = null;
        let statusLabel = null;

        if (provider.credentialSources.includes('api_key')) {
            apiKeyRow = new Adw.PasswordEntryRow({
                title: _('API Key'),
                show_apply_button: true,
            });
            apiKeyRow.connect('apply', () => {});
            expander.add_row(apiKeyRow);

            try {
                const existing = Secret.password_lookup_sync(
                    SECRET_SCHEMA, {type: 'api_key'}, null
                );
                if (existing) apiKeyRow.text = existing;
            } catch (e) {
                console.error('Failed to load API key:', e);
            }

            saveRow = new Adw.ActionRow({
                title: _('Save API Key'),
                subtitle: _('Save API key to GNOME Keyring'),
            });
            const saveButton = new Gtk.Button({
                label: _('Save'),
                valign: Gtk.Align.CENTER,
            });
            saveButton.add_css_class('pill');
            saveButton.add_css_class('suggested-action');
            saveButton.connect('clicked', () => {
                this._saveApiKey(apiKeyRow, statusLabel);
            });
            saveRow.add_suffix(saveButton);
            expander.add_row(saveRow);

            testRow = new Adw.ActionRow({
                title: _('Test Connection'),
                subtitle: _('Verify your API key works correctly'),
            });
            const testButton = new Gtk.Button({
                label: _('Test'),
                valign: Gtk.Align.CENTER,
            });
            testButton.add_css_class('pill');
            testButton.connect('clicked', () => {
                this._testConnection(apiKeyRow, statusLabel);
            });
            testRow.add_suffix(testButton);
            expander.add_row(testRow);

            removeRow = new Adw.ActionRow({
                title: _('Remove API Key'),
                subtitle: _('Delete API key from GNOME Keyring'),
            });
            const removeButton = new Gtk.Button({
                label: _('Remove'),
                valign: Gtk.Align.CENTER,
            });
            removeButton.add_css_class('pill');
            removeButton.add_css_class('destructive-action');
            removeButton.connect('clicked', () => {
                this._deleteApiKey(apiKeyRow, statusLabel);
            });
            removeRow.add_suffix(removeButton);
            expander.add_row(removeRow);

            const statusRow = new Adw.ActionRow({
                title: '',
            });
            statusLabel = new Gtk.Label({
                label: '',
                wrap: true,
            });
            statusRow.add_suffix(statusLabel);
            expander.add_row(statusRow);

            expander._apiKeyRows = [apiKeyRow, saveRow, testRow, removeRow, statusRow];
        } else {
            expander._apiKeyRows = [];
        }

        expander._kiloInfoRow = kiloInfoRow;
        expander._opencodeInfoRow = opencodeInfoRow;

        this._updateProviderCredentialUI(pid, currentSource);
    }

    /**
     * Show/hide credential UI rows based on the selected credential source.
     */
    _updateProviderCredentialUI(pid, source) {
        const expander = this._providerExpanders[pid];
        if (!expander) return;

        const isKilo = source === 'kilo';
        const isOpenCode = source === 'opencode';
        const isApiKey = source === 'api_key';

        if (expander._kiloInfoRow) {
            expander._kiloInfoRow.visible = isKilo;
        }

        if (expander._opencodeInfoRow) {
            expander._opencodeInfoRow.visible = isOpenCode;
        }

        if (expander._apiKeyRows) {
            expander._apiKeyRows.forEach(row => {
                row.visible = isApiKey;
            });
        }
    }

    _saveApiKey(apiKeyRow, statusLabel) {
        try {
            const apiKey = apiKeyRow.text;
            Secret.password_store_sync(
                SECRET_SCHEMA,
                {type: 'api_key'},
                Secret.COLLECTION_DEFAULT,
                'Token Gauge API Key',
                apiKey,
                null
            );
            this._settings.set_int('credentials-version',
                this._settings.get_int('credentials-version') + 1);
            this._showStatus(statusLabel, _('API key saved successfully!'), 'success');
        } catch (e) {
            console.error('Failed to save API key:', e);
            this._showStatus(statusLabel, _('Failed to save API key: ') + e.message, 'error');
        }
    }

    _deleteApiKey(apiKeyRow, statusLabel) {
        try {
            Secret.password_clear_sync(SECRET_SCHEMA, {type: 'api_key'}, null);
            apiKeyRow.text = '';
            this._settings.set_int('credentials-version',
                this._settings.get_int('credentials-version') + 1);
            this._showStatus(statusLabel, _('API key removed successfully.'), 'success');
        } catch (e) {
            console.error('Failed to remove API key:', e);
            this._showStatus(statusLabel, _('Failed to remove API key: ') + e.message, 'error');
        }
    }

    async _testConnection(apiKeyRow, statusLabel) {
        this._showStatus(statusLabel, _('Testing connection...'), 'info');

        const apiKey = apiKeyRow.text;
        if (!apiKey) {
            this._showStatus(statusLabel, _('Please enter your API key.'), 'error');
            return;
        }

        try {
            const session = new Soup.Session();
            const response = await soupGetJson(
                session,
                'https://api.z.ai/api/monitor/usage/quota/limit',
                {Authorization: 'Bearer ' + apiKey}
            );

            if (response.success) {
                this._showStatus(statusLabel, _('Connection successful! Your API key is valid.'), 'success');
            } else {
                this._showStatus(statusLabel, _('Authentication failed: ') + (response.msg || _('Unknown error')), 'error');
            }
        } catch (e) {
            console.error('Connection test failed:', e);
            this._showStatus(statusLabel, _('Connection failed: ') + e.message, 'error');
        }
    }

    _updateCredSourcesGroupVisibility() {
        const enabledProviders = this._settings.get_strv('enabled-providers');
        let anyUsesKilo = false;
        let anyUsesOpenCode = false;
        for (const pid of enabledProviders) {
            try {
                const src = this._settings.get_string(`${pid}-credential-source`);
                if (src === 'kilo') anyUsesKilo = true;
                if (src === 'opencode') anyUsesOpenCode = true;
            } catch {
                // ignore
            }
        }
        this._credSourcesGroup.visible = anyUsesKilo || anyUsesOpenCode;
        if (this._kiloPathRow) this._kiloPathRow.visible = anyUsesKilo;
        if (this._opencodePathRow) this._opencodePathRow.visible = anyUsesOpenCode;
    }

    _getCurrentQuotaOptions() {
        const enabledProviders = this._settings.get_strv('enabled-providers');
        const order = this._getProviderOrder();
        const orderedEnabled = order.filter(pid => enabledProviders.includes(pid));
        const options = [];

        for (const pid of orderedEnabled) {
            const provider = PROVIDER_REGISTRY[pid];
            if (!provider) continue;

            for (const quota of provider.quotas) {
                options.push({
                    id: quota.id,
                    label: `${provider.name} ${quota.name}`,
                });
            }
        }

        return options;
    }

    _rebuildPrimaryQuotaModel() {
        const options = this._getCurrentQuotaOptions();

        if (options.length === 0) {
            this._primaryQuotaRow.model = this._createStringModel(
                [_('No providers enabled')]
            );
            this._primaryQuotaRow.selected = 0;
            this._primaryQuotaRow.sensitive = false;
            return;
        }

        this._primaryQuotaRow.sensitive = true;
        this._primaryQuotaRow.model = this._createStringModel(
            options.map(o => o.label)
        );

        const currentId = this._settings.get_string('primary-quota-id');
        const idx = options.findIndex(o => o.id === currentId);
        this._primaryQuotaRow.selected = idx >= 0 ? idx : 0;

        // If current ID is no longer valid, clamp to first available
        if (idx < 0 && options.length > 0) {
            this._settings.set_string('primary-quota-id', options[0].id);
        }
    }

    _createStringModel(items) {
        const store = new Gtk.StringList();
        items.forEach(item => store.append(item));
        return store;
    }

    _showStatus(label, message, type) {
        if (!label) return;
        label.label = message;
        label.remove_css_class('success');
        label.remove_css_class('error');
        label.remove_css_class('info');
        label.add_css_class(type);
    }
});

export default class TokenGaugePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const page = new TokenGaugePrefsWidget(this.getSettings());
        window.add(page);
    }
}
