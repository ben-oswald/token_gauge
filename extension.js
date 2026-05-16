/* extension.js
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

import GObject from 'gi://GObject';
import St from 'gi://St';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Clutter from 'gi://Clutter';
import Secret from 'gi://Secret';
import Soup from 'gi://Soup';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

import {soupGetJson} from './lib/http.js';

const SECRET_SCHEMA = Secret.Schema.new(
    'dev.oswald.token_gauge',
    Secret.SchemaFlags.NONE,
    {
        'type': Secret.SchemaAttributeType.STRING
    }
);

// ── Provider Registry ──────────────────────────────────────────────────
//
// Each provider declares the data it needs to fetch, how to parse it,
// and per-quota `read(data)` closures that normalize the upstream shape
// into `{remainingPct, resetDate?, usageText?}`.
//
// `getAuthHeaders(auth, apiKey)` returns the headers for the HTTP call,
// or `null` to signal "no credentials available" (the generic fetcher
// then surfaces a user-friendly error).
const PROVIDER_REGISTRY = {
    'zai': {
        name: 'Z.ai',
        credentialSources: ['kilo', 'opencode', 'api_key'],
        endpoint: 'https://api.z.ai/api/monitor/usage/quota/limit',
        getAuthHeaders(auth, apiKey) {
            let key = apiKey;
            if (!key) {
                const zaiAuth = auth && (auth['zai-coding-plan'] || auth['zai']);
                key = zaiAuth && zaiAuth.key;
            }
            if (!key) return null;
            return {Authorization: 'Bearer ' + key};
        },
        parse(response) {
            if (response && response.success && response.data) return response.data;
            return null;
        },
        parseError(response) {
            return (response && response.msg) || null;
        },
        quotas: [
            {
                id: 'zai-5h', name: '5 Hours Quota', icon: 'clock-alt-symbolic',
                read: (data) => readZaiLimit(data, 'zai-5h'),
            },
            {
                id: 'zai-weekly', name: 'Weekly Quota', icon: 'calendar-week-symbolic',
                read: (data) => readZaiLimit(data, 'zai-weekly'),
            },
            {
                id: 'zai-monthly', name: 'Monthly Web Search', icon: 'edit-find-symbolic',
                showRemainingCount: true,
                read: (data) => readZaiLimit(data, 'zai-monthly', {includeRemainingCount: true}),
            },
        ],
    },
    'copilot': {
        name: 'Copilot',
        credentialSources: ['kilo'],
        endpoint: 'https://api.github.com/copilot_internal/user',
        getAuthHeaders(auth) {
            const copilotAuth = auth && auth['github-copilot'];
            const access = copilotAuth && copilotAuth.access;
            if (!access) return null;
            return {
                Authorization: 'Bearer ' + access,
                'User-Agent': 'token-gauge-gnome-extension',
            };
        },
        parse(response) {
            const premium = response && response.quota_snapshots
                && response.quota_snapshots.premium_interactions;
            if (!premium) return null;
            return {
                percent_remaining: premium.percent_remaining,
                remaining: premium.remaining,
                entitlement: premium.entitlement,
                reset_date: response.quota_reset_date_utc,
            };
        },
        quotas: [
            {
                id: 'copilot-premium', name: 'Premium Requests', icon: 'starred-symbolic',
                showRemainingCount: true,
                read: readCopilotPremium,
            },
        ],
    },
};

function readZaiLimit(data, quotaId, {includeRemainingCount = false} = {}) {
    if (!data || !data.limits) return null;

    const limits = data.limits;
    let limit = null;

    // Try type-based matching (works when the API returns a `type` field).
    const typeMap = {'zai-5h': 'TOKENS_LIMIT', 'zai-monthly': 'TIME_LIMIT'};
    if (typeMap[quotaId]) {
        limit = limits.find(l => l.type === typeMap[quotaId]) || null;
    } else if (quotaId === 'zai-weekly') {
        const known = Object.values(typeMap);
        limit = limits.find(l => l.type && !known.includes(l.type)) || null;
    }

    // Fallback: plan-based positional mapping.
    // Non-legacy (≥ 3 limits): [5h, weekly, monthly]
    // Legacy       (2 limits): [monthly, 5h]
    if (!limit) {
        if (limits.length >= 3) {
            const idx = {'zai-5h': 0, 'zai-weekly': 1, 'zai-monthly': 2}[quotaId];
            if (idx !== undefined) limit = limits[idx];
        } else if (limits.length === 2) {
            const idx = {'zai-5h': 1, 'zai-monthly': 0}[quotaId];
            if (idx !== undefined) limit = limits[idx];
        }
    }

    if (!limit) return null;

    const out = {
        remainingPct: 100 - (limit.percentage || 0),
        resetDate: limit.nextResetTime ? new Date(limit.nextResetTime) : null,
    };
    if (includeRemainingCount) {
        const remaining = limit.remaining || 0;
        out.usageText = {kind: 'remaining', value: remaining};
    }
    return out;
}

function readCopilotPremium(data) {
    if (!data) return null;
    const out = {
        remainingPct: data.percent_remaining ?? 100,
        resetDate: data.reset_date ? new Date(data.reset_date) : null,
    };
    if (data.remaining != null && data.entitlement != null) {
        out.usageText = {
            kind: 'remaining-of-entitlement',
            remaining: data.remaining,
            entitlement: data.entitlement,
        };
    }
    return out;
}

const TokenGaugeIndicator = GObject.registerClass(
class TokenGaugeIndicator extends PanelMenu.Button {
    _init(settings, gettext, uuid) {
        super._init(0.5, 'Token Gauge');

        this._ = gettext;
        this._uuid = uuid;
        this._settings = settings;
        this._session = new Soup.Session();

        this._providerData = {};
        this._providerErrors = {};
        this._kiloAuth = null;
        this._opencodeAuth = null;
        this._errorState = false;
        this._isRefreshing = false;

        this._refreshTimeout = null;

        this._quotaSections = {};

        this._previousRemaining = {};

        this._panelBox = new St.BoxLayout({
            style_class: 'tg-panel-box',
            reactive: true,
            can_focus: true,
            track_hover: true,
        });

        this._icon = new St.Icon({
            icon_name: 'dialog-information-symbolic',
            style_class: 'system-status-icon tg-icon',
        });
        this._panelBox.add_child(this._icon);

        this._progressContainer = new St.BoxLayout({
            style_class: 'tg-progress-container',
            vertical: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._progressBar = new St.DrawingArea({
            style_class: 'tg-progress-bar',
            x_expand: true,
        });
        this._progressBar.connect('repaint', (area) => this._paintBar(
            area,
            this._errorState ? 0 : this._getPrimaryQuotaRemaining(),
            0.6,
        ));
        this._progressContainer.add_child(this._progressBar);

        this._panelBox.add_child(this._progressContainer);

        this.add_child(this._panelBox);

        this._buildMenu();

        this._settingsSignals = [];
        this._notificationSources = new Map();
        const settingHooks = [
            ['changed::refresh-interval',         () => this._updateRefreshInterval()],
            ['changed::primary-quota-id',         () => this._progressBar.queue_repaint()],
            ['changed::credentials-version',      () => this._loadAllCredentials()],
            ['changed::enabled-providers',        () => this._onProvidersChanged()],
            ['changed::provider-order',           () => this._onOrderChanged()],
            ['changed::zai-credential-source',    () => this._onProvidersChanged()],
            ['changed::copilot-credential-source', () => this._onProvidersChanged()],
            ['changed::kilo-credentials-path',    () => this._onProvidersChanged()],
            ['changed::opencode-credentials-path', () => this._onProvidersChanged()],
        ];
        for (const [signal, cb] of settingHooks)
            this._settingsSignals.push(this._settings.connect(signal, cb));

        this._loadAllCredentials();
    }

    _getEnabledProviders() {
        const enabled = this._settings.get_strv('enabled-providers');
        const order = this._settings.get_strv('provider-order');
        const ordered = order.filter(pid => enabled.includes(pid));
        for (const pid of enabled) {
            if (!ordered.includes(pid)) ordered.push(pid);
        }
        return ordered;
    }

    _getCredentialSource(providerId) {
        const key = `${providerId}-credential-source`;
        try {
            return this._settings.get_string(key);
        } catch {
            return 'kilo';
        }
    }

    /**
     * Returns true if any enabled provider uses 'kilo' credential source.
     */
    _anyProviderUsesKilo() {
        return this._getEnabledProviders().some(
            pid => this._getCredentialSource(pid) === 'kilo'
        );
    }

    _anyProviderUsesOpenCode() {
        return this._getEnabledProviders().some(
            pid => this._getCredentialSource(pid) === 'opencode'
        );
    }

    _onProvidersChanged() {
        this._providerData = {};
        this._providerErrors = {};
        this._kiloAuth = null;
        this._opencodeAuth = null;
        this._previousRemaining = {};
        this._rebuildMenu();
        this._loadAllCredentials();
    }

    /**
     * Lightweight handler for provider-order changes.
     * Rebuilds the menu to reflect the new column order without
     * clearing cached provider data or re-fetching from APIs.
     */
    _onOrderChanged() {
        this._rebuildMenu();
        // Re-apply existing display data to the freshly built menu sections
        for (const pid of this._getEnabledProviders()) {
            if (this._providerErrors[pid]) {
                this._setProviderError(pid, this._providerErrors[pid]);
            } else if (this._providerData[pid]) {
                this._updateProviderDisplay(pid);
            }
        }
        this._progressBar.queue_repaint();
    }

    _rebuildMenu() {
        this.menu.removeAll();
        this._quotaSections = {};
        this._isRefreshing = false;
        this._refreshItem = null;
        this._refreshIcon = null;
        this._refreshLabel = null;
        this._refreshSpinner = null;
        this._buildMenu();
    }

    _buildMenu() {
        const enabledProviders = this._getEnabledProviders();

        if (enabledProviders.length === 0) {
            const emptyItem = new PopupMenu.PopupMenuItem(this._('No providers enabled'), {reactive: false});
            this.menu.addMenuItem(emptyItem);
            this._setErrorState(true, this._('No providers enabled'));
        } else {
            const providersRow = new St.BoxLayout({
                style_class: 'tg-providers-row',
                vertical: false,
                x_expand: true,
            });

            let isFirstProvider = true;

            for (const pid of enabledProviders) {
                const provider = PROVIDER_REGISTRY[pid];
                if (!provider) continue;

                if (!isFirstProvider) {
                    const colSep = new St.Widget({
                        style_class: 'tg-column-separator',
                        y_expand: true,
                    });
                    providersRow.add_child(colSep);
                }
                isFirstProvider = false;

                const column = new St.BoxLayout({
                    style_class: 'tg-provider-column',
                    vertical: true,
                    x_expand: true,
                });

                const headerLabel = new St.Label({
                    text: provider.name,
                    style_class: 'tg-provider-header',
                    x_align: Clutter.ActorAlign.CENTER,
                    x_expand: true,
                });
                column.add_child(headerLabel);

                for (let i = 0; i < provider.quotas.length; i++) {
                    const quota = provider.quotas[i];

                    if (i > 0) {
                        const quotaSep = new St.Widget({
                            style_class: 'tg-quota-separator',
                            x_expand: true,
                        });
                        column.add_child(quotaSep);
                    }

                    const section = this._createQuotaSection(quota);
                    column.add_child(section);
                    this._quotaSections[quota.id] = section;
                }

                providersRow.add_child(column);
            }

            const rowSection = new PopupMenu.PopupMenuSection();
            rowSection.actor.add_child(providersRow);
            this.menu.addMenuItem(rowSection);
        }

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Refresh button — uses PopupBaseMenuItem with manual click handling
        // to prevent the menu from auto-closing on activate.
        const refreshItem = new PopupMenu.PopupBaseMenuItem({reactive: true});
        const refreshIcon = new St.Icon({
            icon_name: 'view-refresh-symbolic',
            style_class: 'popup-menu-icon',
        });
        const refreshLabel = new St.Label({
            text: this._('Refresh Now'),
            y_align: Clutter.ActorAlign.CENTER,
        });
        const refreshSpinner = new St.Icon({
            icon_name: 'process-working-symbolic',
            style_class: 'popup-menu-icon tg-refresh-spinner',
            visible: false,
        });
        refreshItem.add_child(refreshIcon);
        refreshItem.add_child(refreshLabel);
        refreshItem.add_child(refreshSpinner);

        this._refreshItem = refreshItem;
        this._refreshIcon = refreshIcon;
        this._refreshLabel = refreshLabel;
        this._refreshSpinner = refreshSpinner;

        refreshItem.connect('button-press-event', () => {
            this._onRefreshClicked();
            return Clutter.EVENT_STOP;
        });
        refreshItem.connect('key-press-event', (_actor, event) => {
            if (event.get_key_symbol() === Clutter.KEY_Return ||
                event.get_key_symbol() === Clutter.KEY_space) {
                this._onRefreshClicked();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
        this.menu.addMenuItem(refreshItem);

        const settingsItem = new PopupMenu.PopupMenuItem(this._('Settings'));
        settingsItem.connect('activate', () => this._openSettings());
        this.menu.addMenuItem(settingsItem);
    }

    _createQuotaSection(quota) {
        const box = new St.BoxLayout({
            style_class: 'tg-quota-section',
            vertical: true,
            x_expand: true,
            reactive: true,
            can_focus: true,
            track_hover: true,
        });

        const headerBox = new St.BoxLayout({
            style_class: 'tg-quota-header',
            vertical: false,
        });

        const icon = new St.Icon({
            icon_name: quota.icon,
            style_class: 'popup-menu-icon',
        });
        headerBox.add_child(icon);

        const title = new St.Label({
            text: this._(quota.name),
            style_class: 'tg-quota-title',
        });
        headerBox.add_child(title);

        box.add_child(headerBox);

        const progressBar = new St.DrawingArea({
            style_class: 'tg-menu-progress-bar',
            x_expand: true,
        });
        progressBar._quotaId = quota.id;
        progressBar._percentage = 100;
        progressBar.connect('repaint', (area) => this._paintBar(
            area, area._percentage ?? 100, 0.7
        ));
        box.add_child(progressBar);

        const percentLabel = new St.Label({
            text: '100% remaining',
            style_class: 'tg-quota-percent',
        });
        box.add_child(percentLabel);

        const resetLabel = new St.Label({
            text: this._('Resets: --'),
            style_class: 'tg-quota-reset',
        });
        box.add_child(resetLabel);

        let usageLabel = null;
        if (quota.showRemainingCount) {
            usageLabel = new St.Label({
                text: this._('Usage: --/--'),
                style_class: 'tg-quota-usage',
            });
            box.add_child(usageLabel);
        }

        box._progressBar = progressBar;
        box._percentLabel = percentLabel;
        box._resetLabel = resetLabel;
        box._usageLabel = usageLabel;

        box.connect('button-press-event', () => {
            this._settings.set_string('primary-quota-id', quota.id);
            this._progressBar.queue_repaint();
            return Clutter.EVENT_STOP;
        });

        return box;
    }

    _onRefreshClicked() {
        if (this._isRefreshing) return;
        this._isRefreshing = true;

        this._refreshIcon.visible = false;
        this._refreshSpinner.visible = true;
        this._refreshLabel.set_text(this._('Refreshing...'));
        this._refreshItem.reactive = false;

        // Start spinner rotation via Clutter transition
        const spin = new Clutter.PropertyTransition({
            property_name: 'rotation-angle-z',
            duration: 1000,
            repeat_count: -1,
            progress_mode: Clutter.AnimationMode.LINEAR,
        });
        spin.set_from(0);
        spin.set_to(360);
        this._refreshSpinner.add_transition('spin', spin);

        this._loadAllCredentials()
            .catch(() => {})
            .then(() => this._clearRefreshingState());
    }

    _clearRefreshingState() {
        this._isRefreshing = false;

        // Guard against stale references (e.g. menu was rebuilt during refresh)
        if (!this._refreshItem) return;

        this._refreshSpinner.remove_transition('spin');
        this._refreshIcon.visible = true;
        this._refreshSpinner.visible = false;
        this._refreshLabel.set_text(this._('Refresh Now'));
        this._refreshItem.reactive = true;
    }

    _paintBar(area, percentage, heightRatio) {
        const [width, height] = area.get_surface_size();
        const cr = area.get_context();

        const barHeight = height * heightRatio;
        const barY = (height - barHeight) / 2;
        const radius = barHeight / 2;

        if (percentage < 10) {
            cr.setSourceRGB(0.5, 0.1, 0.1);
        } else {
            cr.setSourceRGB(0.2, 0.2, 0.2);
        }
        this._roundedRect(cr, 0, barY, width, barHeight, radius);
        cr.fill();

        if (percentage >= 4) {
            const fillWidth = Math.max(radius * 2, (width * percentage) / 100);
            const color = this._getProgressColor(percentage);
            cr.setSourceRGB(color.r, color.g, color.b);
            this._roundedRect(cr, 0, barY, fillWidth, barHeight, radius);
            cr.fill();
        }

        cr.$dispose();
    }

    _roundedRect(cr, x, y, width, height, radius) {
        const r = Math.min(radius, width / 2, height / 2);
        cr.newSubPath();
        cr.arc(x + r, y + r, r, Math.PI, 1.5 * Math.PI);
        cr.arc(x + width - r, y + r, r, 1.5 * Math.PI, 2 * Math.PI);
        cr.arc(x + width - r, y + height - r, r, 0, 0.5 * Math.PI);
        cr.arc(x + r, y + height - r, r, 0.5 * Math.PI, Math.PI);
        cr.closePath();
    }

    _getProgressColor(percentage) {
        if (percentage > 50) {
            return {r: 0.3, g: 0.8, b: 0.3};
        } else if (percentage > 20) {
            return {r: 0.9, g: 0.8, b: 0.2};
        } else {
            return {r: 0.9, g: 0.3, b: 0.3};
        }
    }

    /**
     * Get the remaining percentage for the primary quota (panel bar).
     * Falls back to first available quota if primary-quota-id is empty or invalid.
     */
    _getPrimaryQuotaRemaining() {
        let quotaId = this._settings.get_string('primary-quota-id');

        // Fallback: if empty or the section doesn't exist, pick the first available
        if (!quotaId || !this._quotaSections[quotaId]) {
            quotaId = this._getFirstAvailableQuotaId();
        }

        if (!quotaId) return 100;

        return this._getQuotaRemaining(quotaId);
    }

    /**
     * Get the first available quota ID from enabled providers.
     */
    _getFirstAvailableQuotaId() {
        const enabledProviders = this._getEnabledProviders();
        for (const pid of enabledProviders) {
            const provider = PROVIDER_REGISTRY[pid];
            if (provider && provider.quotas.length > 0) {
                return provider.quotas[0].id;
            }
        }
        return null;
    }

    /**
     * Look up a quota across the registry.
     */
    _findQuota(quotaId) {
        for (const [pid, provider] of Object.entries(PROVIDER_REGISTRY)) {
            const quota = provider.quotas.find(q => q.id === quotaId);
            if (quota) return {pid, provider, quota};
        }
        return null;
    }

    /**
     * Get remaining percentage for any quota ID.
     * Returns 100 when data is missing or quota ID is unknown — callers
     * rely on this fallback rather than handling `null`.
     */
    _getQuotaRemaining(quotaId) {
        const entry = this._findQuota(quotaId);
        if (!entry) return 100;
        const data = this._providerData[entry.pid];
        if (!data) return 100;
        const vals = entry.quota.read(data);
        if (!vals) return 100;
        return vals.remainingPct ?? 100;
    }

    /**
     * Unified credential+data loader.
     *
     * Returns a Promise that resolves once all provider fetches have
     * settled and the refresh timer has been (re)armed. Both the auto-
     * refresh timer callback and the manual refresh button await this.
     */
    async _loadAllCredentials() {
        const enabledProviders = this._getEnabledProviders();

        if (enabledProviders.length === 0) {
            this._setErrorState(true, this._('No providers enabled'));
            this._startRefreshTimer();
            return;
        }

        if (this._anyProviderUsesKilo()) {
            await this._loadKiloAuth();
        }
        if (this._anyProviderUsesOpenCode()) {
            await this._loadOpenCodeAuth();
        }
        await this._fetchAllProviders(enabledProviders);
        this._startRefreshTimer();
    }

    _resolveKiloAuthPath() {
        const customPath = this._settings.get_string('kilo-credentials-path');
        if (customPath && customPath.trim() !== '')
            return customPath.trim();
        return GLib.build_filenamev([
            GLib.get_home_dir(), '.local', 'share', 'kilo', 'auth.json',
        ]);
    }

    /**
     * Load Kilo auth.json.
     */
    _loadKiloAuth() {
        return new Promise((resolve) => {
            const authPath = this._resolveKiloAuthPath();
            const file = Gio.File.new_for_path(authPath);
            file.load_contents_async(null, (fileObj, result) => {
                try {
                    const [, contents] = fileObj.load_contents_finish(result);
                    const decoder = new TextDecoder('utf-8');
                    this._kiloAuth = JSON.parse(decoder.decode(contents));
                } catch (e) {
                    console.error('Failed to load Kilo auth.json:', e);
                    this._kiloAuth = null;
                }
                resolve();
            });
        });
    }

    _resolveOpenCodeAuthPath() {
        const customPath = this._settings.get_string('opencode-credentials-path');
        if (customPath && customPath.trim() !== '')
            return customPath.trim();
        return GLib.build_filenamev([
            GLib.get_home_dir(), '.local', 'share', 'opencode', 'auth.json',
        ]);
    }

    _loadOpenCodeAuth() {
        return new Promise((resolve) => {
            const authPath = this._resolveOpenCodeAuthPath();
            const file = Gio.File.new_for_path(authPath);
            file.load_contents_async(null, (fileObj, result) => {
                try {
                    const [, contents] = fileObj.load_contents_finish(result);
                    const decoder = new TextDecoder('utf-8');
                    this._opencodeAuth = JSON.parse(decoder.decode(contents));
                } catch (e) {
                    console.error('Failed to load OpenCode auth.json:', e);
                    this._opencodeAuth = null;
                }
                resolve();
            });
        });
    }

    /**
     * Fetch data for all enabled providers in parallel.
     */
    async _fetchAllProviders(enabledProviders) {
        const promises = enabledProviders.map(pid => this._fetchProvider(pid));
        await Promise.allSettled(promises);

        const anySuccess = enabledProviders.some(pid => !this._providerErrors[pid]);
        if (anySuccess) {
            this._setErrorState(false);
        }

        this._progressBar.queue_repaint();
        this._checkNotifications();
    }

    /**
     * Generic per-provider fetcher: resolves credentials, issues the
     * HTTP call, parses the response, and updates the display (or sets
     * an error).
     */
    async _fetchProvider(pid) {
        const provider = PROVIDER_REGISTRY[pid];
        if (!provider) return;

        const credSource = this._getCredentialSource(pid);
        if (!provider.credentialSources.includes(credSource)) {
            this._setProviderError(pid, this._('Unsupported credential source'));
            return;
        }

        let apiKey = null;
        if (credSource === 'api_key') {
            try {
                apiKey = Secret.password_lookup_sync(SECRET_SCHEMA, {type: 'api_key'}, null);
            } catch (e) {
                console.error(`Failed to load ${pid} API key from keyring:`, e);
            }
            if (!apiKey) {
                this._setProviderError(pid, this._('No API key configured'));
                return;
            }
        }
        // `credSource === 'kilo'` -> auth comes from this._kiloAuth via getAuthHeaders
        // `credSource === 'opencode'` -> auth comes from this._opencodeAuth via getAuthHeaders

        let auth = null;
        if (credSource === 'kilo')
            auth = this._kiloAuth;
        else if (credSource === 'opencode')
            auth = this._opencodeAuth;

        const headers = provider.getAuthHeaders(auth, apiKey);
        if (!headers) {
            if (credSource === 'kilo') {
                const msg = pid === 'zai'
                    ? this._('No Z.ai API key in auth.json')
                    : pid === 'copilot'
                        ? this._('No Copilot credentials in auth.json')
                        : this._('No credentials');
                this._setProviderError(pid, msg);
            } else if (credSource === 'opencode') {
                const msg = pid === 'zai'
                    ? this._('No Z.ai API key in OpenCode auth.json')
                    : this._('No credentials');
                this._setProviderError(pid, msg);
            } else {
                this._setProviderError(pid, this._('No credentials'));
            }
            return;
        }

        try {
            const response = await soupGetJson(this._session, provider.endpoint, headers);
            const parsed = provider.parse(response);
            if (!parsed) {
                const apiMsg = provider.parseError && provider.parseError(response);
                this._setProviderError(
                    pid,
                    apiMsg || (pid === 'copilot'
                        ? this._('No premium quota data in response')
                        : this._('API Error'))
                );
                return;
            }
            this._providerData[pid] = parsed;
            this._providerErrors[pid] = null;
            this._updateProviderDisplay(pid);
        } catch (e) {
            console.error(`Failed to fetch ${pid} data:`, e);
            this._setProviderError(pid, this._('Connection failed'));
        }
    }

    /**
     * Mark a provider as errored and update its quota sections.
     *
     * @param {string} providerId
     * @param {string} message - Short human-readable error message.
     * @param {object} [opts]
     * @param {string} [opts.percentLabel] - Override the percent label text.
     * @param {string} [opts.extraClass] - CSS class to add to the percent label.
     */
    _setProviderError(providerId, message, {percentLabel, extraClass} = {}) {
        this._providerErrors[providerId] = message;

        const provider = PROVIDER_REGISTRY[providerId];
        if (!provider) return;

        const pctText = percentLabel || this._('Error');
        const resetText = message || this._('Unknown error');

        for (const quota of provider.quotas) {
            const section = this._quotaSections[quota.id];
            if (!section) continue;
            section.remove_style_class_name('tg-quota-unavailable');
            section._percentLabel.set_text(pctText);
            if (extraClass)
                section._percentLabel.add_style_class_name(extraClass);
            section._resetLabel.set_text(resetText);
            section._progressBar._percentage = 0;
            section._progressBar.queue_repaint();
        }
    }

    _setErrorState(hasError, _message) {
        this._errorState = hasError;

        if (hasError) {
            this._progressContainer.visible = false;
            this._icon.add_style_class_name('tg-icon-error');
        } else {
            this._progressContainer.visible = true;
            this._icon.remove_style_class_name('tg-icon-error');
        }
    }

    _updateProviderDisplay(pid) {
        const provider = PROVIDER_REGISTRY[pid];
        const data = this._providerData[pid];
        if (!provider || !data) return;

        for (const quota of provider.quotas) {
            const section = this._quotaSections[quota.id];
            if (!section) continue;

            const vals = quota.read(data);
            if (!vals) {
                this._setQuotaUnavailable(section);
                continue;
            }

            section.remove_style_class_name('tg-quota-unavailable');
            section._progressBar.visible = true;
            this._applyQuotaSection(section, vals);
        }
    }

    _applyQuotaSection(section, vals) {
        const remaining = vals.remainingPct ?? 100;

        section._progressBar._percentage = remaining;
        section._progressBar.queue_repaint();
        section._percentLabel.set_text(
            this._('%d%% remaining').format(Math.round(remaining))
        );

        if (vals.resetDate) {
            section._resetLabel.set_text(
                this._('Resets: %s').format(this._formatResetTime(vals.resetDate))
            );
        }

        if (section._usageLabel && vals.usageText) {
            const u = vals.usageText;
            if (u.kind === 'remaining') {
                section._usageLabel.set_text(
                    this._('Remaining: %d').format(u.value)
                );
            } else if (u.kind === 'remaining-of-entitlement') {
                section._usageLabel.set_text(
                    this._('Remaining: %d / %d').format(u.remaining, u.entitlement)
                );
            }
        }
    }

    _setQuotaUnavailable(section) {
        section.add_style_class_name('tg-quota-unavailable');
        section._progressBar.visible = false;
        section._percentLabel.set_text(this._('N/A'));
        section._resetLabel.set_text(this._('Not available on your plan'));
        if (section._usageLabel)
            section._usageLabel.set_text('');
    }

    _checkNotifications() {
        if (!this._settings.get_boolean('notifications-enabled'))
            return;

        const thresholds = [25, 20, 10, 5]; // sorted descending
        const enabledProviders = this._getEnabledProviders();

        for (const pid of enabledProviders) {
            const provider = PROVIDER_REGISTRY[pid];
            if (!provider) continue;

            if (this._providerErrors[pid]) continue;

            for (const quota of provider.quotas) {
                const remaining = this._getQuotaRemaining(quota.id);
                const previous = this._previousRemaining[quota.id];

                this._previousRemaining[quota.id] = remaining;

                if (previous === undefined || previous === null)
                    continue;

                let lowestCrossed = null;
                for (const threshold of thresholds) {
                    if (previous >= threshold && remaining < threshold) {
                        lowestCrossed = threshold;
                    }
                }

                if (lowestCrossed !== null) {
                    const urgency = lowestCrossed <= 10
                        ? MessageTray.Urgency.CRITICAL
                        : lowestCrossed <= 20
                            ? MessageTray.Urgency.NORMAL
                            : MessageTray.Urgency.LOW;

                    this._sendNotification(
                        this._('Token Gauge — Low Quota'),
                        this._('%s (%s) is below %d%% — %d%% remaining').format(
                            quota.name, provider.name, lowestCrossed, Math.round(remaining)
                        ),
                        urgency
                    );
                }
            }
        }
    }

    _sendNotification(title, body, urgency) {
        const source = new MessageTray.Source({
            title: 'Token Gauge',
            iconName: 'dialog-information-symbolic',
        });
        const destroyId = source.connect('destroy', () => {
            this._notificationSources?.delete(source);
        });
        this._notificationSources.set(source, destroyId);
        Main.messageTray.add(source);

        const notification = new MessageTray.Notification({
            source,
            title,
            body,
        });
        notification.urgency = urgency;
        source.addNotification(notification);
    }

    _formatResetTime(date) {
        const now = new Date();
        const diff = date - now;

        if (diff < 0) {
            return this._('Soon');
        }

        const minutes = Math.floor(diff / 60000);
        const hours = Math.floor(minutes / 60);
        const days = Math.floor(hours / 24);

        if (days > 0) {
            return this._('%d days, %d hours').format(days, hours % 24);
        } else if (hours > 0) {
            return this._('%d hours, %d minutes').format(hours, minutes % 60);
        } else {
            return this._('%d minutes').format(minutes);
        }
    }

    _startRefreshTimer() {
        this._stopRefreshTimer();

        const interval = this._settings.get_int('refresh-interval');
        this._refreshTimeout = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            interval * 60,
            () => {
                this._loadAllCredentials();
                return GLib.SOURCE_CONTINUE;
            }
        );
    }

    _stopRefreshTimer() {
        if (this._refreshTimeout) {
            GLib.source_remove(this._refreshTimeout);
            this._refreshTimeout = null;
        }
    }

    _updateRefreshInterval() {
        this._startRefreshTimer();
    }

    _openSettings() {
        Main.extensionManager.openExtensionPrefs(this._uuid, '', {});
    }

    destroy() {
        this._stopRefreshTimer();

        if (this._settingsSignals) {
            this._settingsSignals.forEach(id => this._settings.disconnect(id));
            this._settingsSignals = [];
        }

        if (this._notificationSources) {
            for (const [source, destroyId] of this._notificationSources) {
                source.disconnect(destroyId);
                source.destroy();
            }
            this._notificationSources.clear();
            this._notificationSources = null;
        }

        if (this._session) {
            this._session.abort();
            this._session = null;
        }

        super.destroy();
    }
});

export default class TokenGaugeExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._indicator = new TokenGaugeIndicator(
            this._settings, this.gettext.bind(this), this.uuid
        );
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
        this._settings = null;
    }
}
